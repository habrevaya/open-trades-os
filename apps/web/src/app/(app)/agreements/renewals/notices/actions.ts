"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreementNotices } from "@opentradesos/api/services";
import { updateAgreementRenewalNotices } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const CODES = [
  "agreement_renewal.renews.sms", "agreement_renewal.renews.email",
  "agreement_renewal.ends.sms", "agreement_renewal.ends.email",
] as const;

/**
 * `PUT /v1/agreement-renewal-notices`, from the notices screen: how they go,
 * and the words of all four in one save. A template's fields are named by
 * its code, so the form needs no hidden list of which is which.
 */
export async function saveRenewalNotices(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const result = await attempt(form, async () => {
    const input = parsed(updateAgreementRenewalNotices.input, {
      channel: field(form, "channel"),
      templates: CODES.map((code) => ({
        code,
        body: String(form.get(`${code}:body`) ?? ""),
        ...(code.endsWith(".email") ? { subject: String(form.get(`${code}:subject`) ?? "") } : {}),
      })),
    });
    await agreementNotices.update({ actor: user.actor, db: getDb() }, input);
  });
  revalidatePath("/agreements/renewals/notices");
  return result;
}
