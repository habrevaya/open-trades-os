"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commissions } from "@opentradesos/api/services";
import { settleCommissionSplit } from "@opentradesos/api/contracts";
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
