"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers } from "@opentradesos/api/services";
import { updateCustomer } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * A customer's sales tax: exempt or not, the certificate's number and the
 * last day it covers, and a rate of their own. `PATCH /v1/customers/{id}`.
 */
export async function saveCustomerTax(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "customerId") ?? "";
  const state = await attempt(form, async () => {
    const input = parsed(updateCustomer.input, {
      id,
      taxExempt: field(form, "taxExempt") === "yes",
      taxExemptCertificate: field(form, "taxExemptCertificate") ?? null,
      taxExemptExpiresOn: field(form, "taxExemptExpiresOn") ?? null,
      taxRateId: field(form, "taxRateId") ?? null,
    });
    await customers.update({ actor: (await requireSetupUser()).actor, db: getDb() }, input);
    return { message: "Saved. Invoices already raised keep what they charged." };
  });
  revalidatePath(`/customers/${id}`);
  return state;
}
