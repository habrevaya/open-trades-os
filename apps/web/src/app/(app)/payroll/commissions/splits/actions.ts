"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commissions } from "@opentradesos/api/services";
import { settleCommissionSplit, setCommissionStandingShare, settleCommissionSplitsAsProposed } from "@opentradesos/api/contracts";
import { ConflictError } from "@opentradesos/api/services";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * Settle a shared commission as the screen worked it out. The shares come back
 * as the page sent them (`id:weight` pairs), so what is settled is what was
 * shown; the service refuses a changed split with no reason, in words.
 */
export async function settleShared(_previous: FormState, form: FormData): Promise<FormState> {
  const invoiceId = field(form, "invoiceId") ?? "";
  const result = await attempt(form, async () => {
    const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
    const input = parsed(settleCommissionSplit.input, {
      invoiceId,
      ...(field(form, "planId") ? { planId: field(form, "planId") } : {}),
      shares: commissions.parseShares(field(form, "shares") ?? ""),
      ...(field(form, "reason") ? { reason: field(form, "reason") } : {}),
    });
    const done = await commissions.settleSplit(ctx, input);
    return { message: `Settled: ${Number(done.total).toLocaleString("en-US", { style: "currency", currency: "USD" })} is now owed.` };
  });
  revalidatePath("/payroll/commissions/splits");
  revalidatePath(`/payroll/commissions/splits/${invoiceId}`);
  return result;
}

/**
 * Give somebody a standing share. The percent is typed as a whole number and
 * checked by the module, which says what is wrong in its own words.
 */
export async function setStanding(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
    const percent = (field(form, "percent") ?? "").replace(/%/g, "").trim();
    const input = parsed(setCommissionStandingShare.input, {
      technicianId: field(form, "technicianId") ?? "",
      percent: /^\d+$/.test(percent) ? Number(percent) : Number.NaN,
      applies: form.get("asLead") ? "as_lead" : "always",
      reason: field(form, "reason") ?? "",
    });
    const done = await commissions.setStandingShare(ctx, input);
    return { message: done.inWords };
  });
  revalidatePath("/payroll/commissions/splits");
  return result;
}

/** Stop a standing share. Proposals from now on leave it out; what was settled stays settled. */
export async function endStanding(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
    await commissions.endStandingShare(ctx, { id: field(form, "id") ?? "" });
    return { message: "Stopped." };
  });
  revalidatePath("/payroll/commissions/splits");
  return result;
}

/**
 * Settle the ticked invoices, each with the split proposed for it, as settling
 * each alone would. What did not settle is said with its reason, so the office
 * knows which to open.
 */
export async function settleAsProposed(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
    const invoiceIds = form.getAll("invoiceId").filter((v): v is string => typeof v === "string" && v !== "");
    if (invoiceIds.length === 0) throw new ConflictError("Tick the invoices to settle as proposed.");
    const input = parsed(settleCommissionSplitsAsProposed.input, {
      invoiceIds,
      ...(field(form, "planId") ? { planId: field(form, "planId") } : {}),
    });
    const done = await commissions.settleProposed(ctx, input);
    const settled = done.settled.length === 0
      ? "Nothing settled."
      : `Settled ${done.settled.length}: ${done.settled.map((s) => s.invoiceNumber).join(", ")}.`;
    const refused = done.refused.map((r) => `${r.invoiceNumber ?? "An invoice"} was not settled: ${r.refusal}`).join(" ");
    return { message: refused ? `${settled} ${refused}` : settled };
  });
  revalidatePath("/payroll/commissions/splits");
  return result;
}
