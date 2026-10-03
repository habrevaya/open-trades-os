"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { referrals, inTenant, ConflictError } from "@opentradesos/api/services";
import { referrals as rf } from "@opentradesos/core";
import { schema } from "@opentradesos/db";
import { attempt, field, type FormState } from "@/lib/actions";

/**
 * Who referred this customer, by the referrer's code, as the office hears it
 * on the phone: "Mrs Alvarez sent me, her code is KQ7M2P".
 */
export async function setReferrer(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const code = rf.normaliseCode(field(form, "code"));
    if (!code) throw new ConflictError("That is not a referral code. Codes are six letters and digits, like KQ7M2P.");
    const [referrer] = await inTenant(ctx, (tx) => tx.select({ id: schema.customer.id, name: schema.customer.name })
      .from(schema.customer)
      .where(and(eq(schema.customer.referralCode, code), isNull(schema.customer.deletedAt))).limit(1));
    if (!referrer) throw new ConflictError(`No customer holds the code ${code}.`);
    await referrals.setReferredBy(ctx, { customerId: id, referrerId: referrer.id, replace: field(form, "replace") === "yes" });
    return { message: `Referred by ${referrer.name}.` };
  });
  revalidatePath(`/customers/${id}`);
  return result;
}
