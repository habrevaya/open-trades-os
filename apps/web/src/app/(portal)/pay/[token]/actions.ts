"use server";

import { getDb } from "@/lib/db";
import { portalAccount } from "@opentradesos/api/services";
import { startPaymentFor, type StartPayment } from "../../start-payment";

/** Pay the deposit this link names. The amount is what is outstanding on it, read on the server. */
export async function startDepositPayment(token: string): Promise<StartPayment> {
  return startPaymentFor((meta) => portalAccount.startDepositPayment(getDb(), { token }, meta));
}
