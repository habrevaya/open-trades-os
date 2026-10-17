"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commissions } from "@opentradesos/api/services";
import { settleCommissionSplit, setCommissionStandingShare } from "@opentradesos/api/contracts";
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
