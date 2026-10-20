"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { creditNotes } from "@opentradesos/api/services";
import { applyCreditNote } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * Put a referral reward's credit on this invoice: the credit note application
 * (`POST /v1/credit-notes/{id}/apply`) a person makes from the credit note,
 * reached from the bill it goes on. Keyed by the form, so a double press or a
 * retry after a dropped answer takes the credit off once.
 */
export async function applyReferralCredit(_previous: FormState, form: FormData): Promise<FormState> {
  const invoiceId = field(form, "invoiceId") ?? "";
  const key = field(form, "formKey");
  const result = await attempt(form, async () => {
    const input = parsed(applyCreditNote.input, {
      id: field(form, "creditNoteId"),
      applications: [{ invoiceId, amount: field(form, "amount") }],
    });
    const ctx = { actor: (await requireSetupUser()).actor, db: getDb(), ...(key ? { idempotencyKey: `referral-credit:${key}` } : {}) };
    await creditNotes.apply(ctx, input);
    return { message: "Taken off this invoice." };
  });
  revalidatePath(`/invoices/${invoiceId}`);
  return result;
}
