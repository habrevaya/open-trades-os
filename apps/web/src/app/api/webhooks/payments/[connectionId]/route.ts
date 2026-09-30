import { getDb } from "@/lib/db";
import { payments } from "@opentradesos/api/services";
import { createPaymentProvider } from "@opentradesos/api/payments";
// Registers the payment adapters.
import "@opentradesos/api/payments";

export const dynamic = "force-dynamic";

/**
 * WHERE A PAYMENT IS CONFIRMED
 *
 * The operator pastes this URL into their own Stripe dashboard, with the
 * connection id from the settings screen on the end of it. One endpoint per
 * connection, because the signing secret Stripe issues is per endpoint and
 * the company it belongs to has to be known before the signature can be
 * checked at all.
 *
 * THE CONNECTION ID IS NOT A SECRET AND DOES NOT NEED TO BE.
 *
 * The lead webhook next door routes on a token that IS secret, because a
 * forged lead puts a van on somebody's drive and the signature there is
 * defence in depth. Here the signature is the whole of the authentication and
 * there is no path around it: a request with the wrong signature is refused
 * whoever sent it and whatever id is in the path. A uuid is unguessable in
 * any case, so this is a routing key rather than a credential, and calling it
 * one would invite somebody to treat a leak as a breach when the real breach
 * is a leaked signing secret.
 *
 * WHAT A FORGED EVENT WOULD BE WORTH IS WHY NONE OF THIS IS OPTIONAL. Anybody
 * who could post an unverified `payment_intent.succeeded` here could mark any
 * invoice paid. There is no fraud screen, no rate limit and no reconciliation
 * step downstream that catches it, because every system after this one
 * believes the money arrived: the balance goes to zero, the job closes, the
 * customer is never chased, and the ledger balances perfectly against cash
 * that is not in the bank.
 */

const readSecret = (ref: string): string => {
  const value = process.env[ref];
  if (!value) throw new Error(`No secret in the environment for "${ref}"`);
  return value;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const { connectionId } = await context.params;
  const db = getDb();

  /**
   * The raw body, read once and never re-serialized. Parsing it to an object
   * and stringifying it back changes a byte of whitespace somewhere and every
   * signature stops matching, which presents as "the signing secret is wrong"
   * and costs an afternoon.
   */
  const body = await request.text();

  /**
   * Resolved OUTSIDE any tenant transaction, because at this point there is
   * no tenant: the id in the path is what establishes one. Read with the
   * service role, and nothing else about the request is trusted until the
   * signature has been checked.
   */
  const connection = await payments.connectionById(db, connectionId);

  /**
   * An unknown id and a disconnected connection answer the same 404, so
   * nobody can test ids against the difference.
   */
  if (!connection) return new Response("Not found", { status: 404 });

  if (!connection.webhookSecretRef) {
    /**
     * A connection with no signing secret cannot verify anything, so it
     * refuses rather than accepting unsigned events. The alternative is an
     * endpoint whose security depends on somebody having finished the setup,
     * on the one screen where not finishing the setup is most likely.
     */
    return new Response("Not configured", { status: 409 });
  }

  const provider = createPaymentProvider(
    connection.provider, connection.settings, readSecret(connection.credentialRef),
  );

  const webhookRequest = {
    headers: Object.fromEntries(
      [...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]),
    ),
    body,
  };

  if (!provider.verify(webhookRequest, readSecret(connection.webhookSecretRef))) {
    return new Response("Bad signature", { status: 401 });
  }

  const event = provider.parseEvent(webhookRequest);
  if (!event) {
    /**
     * 422 rather than 400 and deliberately not a 500. A body this cannot read
     * will fail identically on every retry, and Stripe disables an endpoint
     * that keeps failing. A 5xx would earn that disabling for a body that was
     * never going to work.
     */
    return Response.json(
      { error: "That body is not an event this can read." },
      { status: 422 },
    );
  }

  const outcome = await payments.receive(db, { connection, event });

  /**
   * 200 on a duplicate and on an event nothing here models, because both are
   * handled correctly: the processor should stop retrying. A non 2xx would
   * have Stripe redeliver an event we have already settled, for days.
   */
  return Response.json(outcome, { status: 200 });
}
