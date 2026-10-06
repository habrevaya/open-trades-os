"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { cardOnFile } from "@opentradesos/api/services";
import { chargeInvoiceCardOnFile } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * CHARGING A CARD THE CUSTOMER AGREED MAY BE CHARGED
 *
 * `POST /v1/invoices/{id}/charge-card`. Keyed by the form, so a double press
 * or a retry after a dropped answer is the same charge rather than a second
 * one. Whether the card may be charged at all is the service's to say: no
 * agreement, a withdrawn one, a card that is not the payer's, or nothing
 * owed are its refusals, in its words.
 */
export async function chargeCardOnFile(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "invoiceId") ?? "";
  const key = field(form, "formKey");
  const result = await attempt(form, async () => {
    const input = parsed(chargeInvoiceCardOnFile.input, { id, cardId: field(form, "cardId") });
    const ctx = {
      actor: (await requireSetupUser()).actor, db: getDb(),
      ...(key ? { idempotencyKey: `charge-card:${key}` } : {}),
    };
    const charged = await cardOnFile.charge(ctx, { invoiceId: input.id, cardId: input.cardId });
    return { message: charged.message };
  });
  revalidatePath(`/invoices/${id}`);
  return result;
}
