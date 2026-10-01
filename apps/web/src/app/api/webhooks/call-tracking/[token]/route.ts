import { getDb } from "@/lib/db";
import * as callTracking from "@opentradesos/api/services/call-tracking";
// Registers the call tracking adapters.
import "@opentradesos/api/call-tracking";

export const dynamic = "force-dynamic";

/**
 * WHERE A TRACKED CALL ARRIVES
 *
 * One endpoint for every call tracking vendor, because what differs between
 * them is the field names and the signing, and both of those belong to the
 * adapter.
 *
 * TWO THINGS GUARD IT AND THEY GUARD DIFFERENT THINGS.
 *
 * The token in the path says WHICH TENANT, and it is a secret for the same
 * reason the lead webhook's is: a company's tracking number is printed on
 * their van, so routing on anything public would let somebody aim a forged
 * call at a company they chose.
 *
 * The signature says the body really came from the vendor. CallRail signs
 * with a per-company key, HMAC-SHA1 over the raw body, base64, so a valid
 * signature proves the body came from a CallRail account holding that key
 * and not which of our tenants it is for. That is why the token is resolved
 * first and the signature is then checked against THAT connection's own
 * secret, rather than against any secret that happens to verify.
 *
 * A forged call here is not spam. It is a marketing touch, which is a number
 * on the report an owner moves a budget with.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;

  /**
   * The raw body, read once and never re-serialized. Parsing it to an object
   * and stringifying it back moves one byte of whitespace and every
   * signature stops matching, which presents as "the signing key is wrong"
   * and costs an afternoon.
   */
  const body = await request.text();

  const connection = await callTracking.resolveWebhook(getDb(), token);

  /**
   * The same 404 for an unknown token, a short one and a connection that is
   * no longer connected. Distinguishing them turns the endpoint into an
   * oracle for guessing tokens, and the vendor reads no difference either.
   */
  if (!connection) return new Response("Not found", { status: 404 });

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

  const outcome = await callTracking.receive(getDb(), connection, { headers, body });

  if (outcome.kind === "rejected") {
    /**
     * 403 for a bad signature, 200 for anything else we could not use.
     *
     * CallRail posts text messages and form submissions at the same endpoint
     * and treats any non-2xx as a failure. Their own documentation says
     * repeated failures can disable the integration, and that they do not
     * resend, so answering an error to a shape we simply do not want is how
     * a company loses its call tracking and finds out weeks later. A bad
     * signature is different: a genuine delivery will never see it, and it
     * is worth being loud about.
     */
    return outcome.reason === "bad_signature"
      ? new Response("Forbidden", { status: 403 })
      : new Response("", { status: 200 });
  }

  return Response.json(
    { received: true, callId: outcome.callId, duplicate: outcome.duplicate },
    { status: outcome.duplicate ? 200 : 201 },
  );
}
