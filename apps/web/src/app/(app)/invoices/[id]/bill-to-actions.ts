"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing } from "@opentradesos/api/services";
import { setInvoiceBillTo } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * WHO AT THE PAYER THE INVOICE IS ADDRESSED TO
 *
 * `PUT /v1/invoices/{id}/bill-to`. One of the payer's own contacts, or nobody
 * in particular; the service refuses anybody else, and a void or written off
 * invoice, in its own words.
 */
export async function addressInvoice(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "invoiceId") ?? "";
  const result = await attempt(form, async () => {
    const input = parsed(setInvoiceBillTo.input, { id, contactId: field(form, "contactId") ?? null });
    await billing.setBillTo({ actor: (await requireSetupUser()).actor, db: getDb() }, input);
    return { message: "Saved." };
  });
  revalidatePath(`/invoices/${id}`);
  return result;
}
