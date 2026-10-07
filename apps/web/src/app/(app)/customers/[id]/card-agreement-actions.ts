"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { cardOnFile } from "@opentradesos/api/services";
import { recordCustomerCardAgreement } from "@opentradesos/api/contracts";
import { attempt, field, parsed, refused, type FormState } from "@/lib/actions";
import { fileAsBase64 } from "@/lib/local-time";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * Record that the customer agreed, on the phone or on a signed form, to be
 * charged on one of their saved cards. The words and the day are checked by
 * the service; a signed form is refused here without its scan so the person is
 * told before anything is uploaded.
 */
export async function recordCardAgreement(_previous: FormState, form: FormData): Promise<FormState> {
  const customerId = field(form, "customerId") ?? "";
  const way = field(form, "way");
  const scan = await fileAsBase64(form.get("form"));
  if (way === "signed_form" && !scan) {
    return refused(form, "Upload the scan of the signed form. An agreement on paper needs it.");
  }
  const result = await attempt(form, async () => {
    const { id, ...rest } = parsed(recordCustomerCardAgreement.input, {
      id: customerId,
      cardId: field(form, "cardId"),
      way,
      agreedOn: field(form, "agreedOn"),
      wording: field(form, "wording"),
      ...(way === "signed_form" && scan
        ? { form: { fileName: scan.fileName, contentType: scan.contentType, bytes: scan.bytes } }
        : {}),
    });
    await cardOnFile.recordAgreement(await ctx(), { customerId: id, ...rest });
    return { message: "Recorded. The customer sees it in their account and can stop it there." };
  });
  revalidatePath(`/customers/${customerId}`);
  return result;
}

/** The customer asked, by phone or in writing, to stop being charged on a card. */
export async function stopCardAgreement(_previous: FormState, form: FormData): Promise<FormState> {
  const customerId = field(form, "customerId") ?? "";
  const result = await attempt(form, async () => {
    await cardOnFile.withdrawForCustomer(await ctx(), { customerId, agreementId: field(form, "agreementId") ?? "" });
    return { message: "Stopped. Nothing more will be charged to that card." };
  });
  revalidatePath(`/customers/${customerId}`);
  return result;
}
