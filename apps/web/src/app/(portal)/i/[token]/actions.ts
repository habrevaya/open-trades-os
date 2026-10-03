"use server";

import { getDb } from "@/lib/db";
import { invoiceDelivery } from "@opentradesos/api/services";
import { startPaymentFor, type StartPayment } from "../../start-payment";

/**
 * Starting a card payment, from the customer's link.
 *
 * Nothing about the amount comes from the browser: the service reads it from
 * the invoice the grant names. And nothing here marks the invoice paid. The
 * processor's signed webhook is the only thing that does, so a payment the
 * customer abandons halfway through leaves the balance exactly as it was.
 */
export async function startPayment(token: string, options?: { tip?: string }): Promise<StartPayment> {
  return startPaymentFor((meta) => invoiceDelivery.startPayment(getDb(), {
    token, ...(options?.tip ? { tip: options.tip } : {}),
  }, meta));
}
