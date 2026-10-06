"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customerDuplicates, customerLifecycle } from "@opentradesos/api/services";
import { dismissCustomerDuplicate, mergeCustomers } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * Join a pair from the sweep, through the same merge the customer's own page
 * uses. The record kept is the one the button named.
 */
export async function mergePair(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const input = parsed(mergeCustomers.input, {
      keepId: field(form, "keepId"), mergeId: field(form, "mergeId"),
    });
    const done = await customerLifecycle.merge(await ctx(), { keepId: input.keepId, mergeId: input.mergeId });
    return { message: `Merged into ${done.name}.` };
  });
  revalidatePath("/customers/duplicates");
  return state;
}

/** Remember that these two are different people, so the pair stops coming back. */
export async function notDuplicate(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const reason = field(form, "reason");
    await customerDuplicates.dismiss(await ctx(), parsed(dismissCustomerDuplicate.input, {
      customerId: field(form, "customerId"), otherId: field(form, "otherId"),
      ...(reason ? { reason } : {}),
    }));
  });
  revalidatePath("/customers/duplicates");
  return state;
}
