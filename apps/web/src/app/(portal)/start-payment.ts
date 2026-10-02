import { headers } from "next/headers";
import { portal } from "@opentradesos/api/services";

export type StartPayment =
  | { ok: true; clientSecret: string; publishableKey: string; amount: string; currency: string }
  | { ok: false; message: string };

/**
 * Starting a card payment from any portal link, and saying what went wrong
 * in words a customer can act on.
 *
 * Shared by the invoice, account and deposit pages so that the three say the
 * same thing about the same failure. Nothing about the amount comes from the
 * browser: each service reads it from the record the grant names. And
 * nothing here marks anything paid; the processor's signed webhook is the
 * only thing that does.
 */
export async function startPaymentFor(
  run: (meta: { ip?: string | undefined }) => Promise<{
    clientSecret: string; publishableKey: string | null; amount: string; currency: string;
  }>,
): Promise<StartPayment> {
  const h = await headers();
  try {
    const started = await run({ ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() });
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
    if (error instanceof Error && (error.name === "ConflictError" || error.name === "DemoReadOnlyError")) {
      return { ok: false, message: error.message };
    }
    return {
      ok: false,
      message: "We could not start the payment. Please try again, or reply to the message that brought you here.",
    };
  }
}
