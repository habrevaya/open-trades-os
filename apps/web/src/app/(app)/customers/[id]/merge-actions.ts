"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customerLifecycle } from "@opentradesos/api/services";
import { undoCustomerMerge } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * TAKING A MERGE BACK, from the kept customer's page.
 *
 * Runs what `POST /v1/customer-merges/{id}/undo` runs, parsed by its schema.
 * Whether it can be done is the service's to say, checked again here at the
 * click rather than trusted from the page load: money written since the page
 * was opened refuses it in the same words the page would have shown.
 */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function undoMerge(_previous: FormState, form: FormData): Promise<FormState> {
  const customerId = String(form.get("customerId") ?? "");
  const state = await attempt(form, async () => {
    const reason = field(form, "reason");
    const undone = await customerLifecycle.undoMerge(await ctx(), parsed(undoCustomerMerge.input, {
      id: String(form.get("id") ?? ""), ...(reason ? { reason } : {}),
    }));
    return { message: `${undone.restoredName} is a customer of their own again.` };
  });
  revalidatePath(`/customers/${customerId}`);
  return state;
}
