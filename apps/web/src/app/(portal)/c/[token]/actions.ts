"use server";

import { getDb } from "@/lib/db";
import { portalAccount } from "@opentradesos/api/services";
import { startPaymentFor, type StartPayment } from "../../start-payment";

/**
 * Pay one invoice from the account link.
 *
 * The invoice id comes from the page, so the service checks it belongs to
 * the customer the link names before anything is charged; another
 * customer's invoice is the same not-found as one that does not exist.
 */
export async function startAccountPayment(
  token: string, invoiceId: string, options?: { tip?: string },
): Promise<StartPayment> {
  return startPaymentFor((meta) =>
    portalAccount.startInvoicePayment(getDb(), {
      token, invoiceId, ...(options?.tip ? { tip: options.tip } : {}),
    }, meta));
}
