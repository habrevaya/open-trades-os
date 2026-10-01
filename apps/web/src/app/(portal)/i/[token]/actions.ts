"use server";

import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { invoiceDelivery, portal } from "@opentradesos/api/services";

export type StartPayment =
  | { ok: true; clientSecret: string; publishableKey: string; amount: string; currency: string }
  | { ok: false; message: string };

/**
 * Starting a card payment, from the customer's link.
 *
 * Nothing about the amount comes from the browser: the service reads it from
 * the invoice the grant names. And nothing here marks the invoice paid. The
 * processor's signed webhook is the only thing that does, so a payment the
 * customer abandons halfway through leaves the balance exactly as it was.
 */
export async function startPayment(token: string): Promise<StartPayment> {
  const h = await headers();
  try {
    const started = await invoiceDelivery.startPayment(
      getDb(),
      { token },
      { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() },
    );
    if (!started.publishableKey) {
      /**
       * The company connected a processor with its secret key and no
       * publishable one. The card form cannot load without it, and saying so
       * is better than a spinner that never resolves.
       */
      return {
        ok: false,
        message: "Online payment is not set up yet. Please contact us to pay another way.",
      };
    }
    return {
      ok: true,
      clientSecret: started.clientSecret,
      publishableKey: started.publishableKey,
      amount: started.amount,
      currency: started.currency,
    };
  } catch (error) {
    if (error instanceof portal.InvalidGrantError) {
      return { ok: false, message: "This link is no longer active. Please ask for a new one." };
    }
    if (error instanceof Error && error.name === "ConflictError") {
      return { ok: false, message: error.message };
    }
    return {
      ok: false,
      message: "We could not start the payment. Please try again, or reply to the message that brought you here.",
    };
  }
}
