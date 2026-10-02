"use server";

import { attempt, field, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commissions } from "@opentradesos/api/services";
import type { labor } from "@opentradesos/core";

export type CommissionState = FormState;

/**
 * Declaring and superseding a plan.
 *
 * There is no edit, deliberately and not as an omission: the service has none,
 * because editing a plan reprices commissions already earned and, on a plan
 * edited downward, already paid. Deactivating and declaring a new one is the
 * supported path and is what this screen offers.
 */
export async function act(_previous: CommissionState, form: FormData): Promise<CommissionState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "declare":
        await commissions.declarePlan(ctx, {
          label: String(form.get("label") ?? ""),
          basis: String(form.get("basis") ?? "") as labor.CommissionBasisKey,
          /**
           * Both sent as given. The service requires the one the basis needs and
           * refuses the other, with a sentence naming which, so filling in the
           * wrong box is answered rather than silently ignored.
           */
          rate: field(form, "rate") ?? null,
          flatAmount: field(form, "flatAmount") ?? null,
          note: String(form.get("note") ?? ""),
        });
        return;
      case "supersede":
        await commissions.deactivatePlan(ctx, { id: String(form.get("id") ?? "") });
        return;
      default:
        throw new Error(`Unknown commission operation: ${op}`);
    }
  });

  if (state?.done) revalidatePath("/payroll/commissions");
  return state;
}
