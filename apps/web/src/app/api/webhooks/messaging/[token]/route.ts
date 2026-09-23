import { commsInbound } from "@opentradesos/api/services";
import { getDb } from "@/lib/db";
// Registers the carrier adapters.
import "@opentradesos/api/comms";

export const dynamic = "force-dynamic";

/**
 * WHERE A CARRIER POSTS
 *
 * One endpoint for every provider, because what differs between them is
 * parsing and signing, and both of those are the adapter's job. A route per
 * carrier would be the same file four times with one import changed.
 *
 * The token in the path identifies the connection, and therefore the tenant.
 * It is a secret, which is why it is not the phone number: a company's number
 * is printed on their truck, and using it to route would let anyone aim a
 * forged message at a tenant they chose.
 */

/**
 * The URL the signature is computed over.
 *
 * Taken from configuration, not from the request. Behind a load balancer or a
 * tunnel the request arrives as http on an internal hostname, and rebuilding
 * the URL from `Host` and `X-Forwarded-Proto` means an attacker who can set
 * those chooses what gets signed, which turns the signature check into
 * decoration.
 */
function publicUrl(token: string): string {
  const base = process.env["PUBLIC_URL"];
  if (!base) {
    throw new Error("PUBLIC_URL is not set. The webhook signature is computed over it.");
  }
  return `${base.replace(/\/$/, "")}/api/webhooks/messaging/${token}`;
}

const readSecret = async (ref: string): Promise<string> => {
  const value = process.env[ref];
  if (!value) throw new Error(`No secret in the environment for "${ref}"`);
  return value;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;

  /**
   * The raw body, read once and never re-serialized. Parsing it and building
   * the form string again changes byte order and breaks every signature, and
   * the usual fix for that is to stop checking.
   */
  const body = await request.text();

  const connection = await commsInbound.resolveWebhook(getDb(), token, readSecret);
  /**
   * The same 404 for an unknown token and for one that resolves to nothing.
   * Distinguishing them turns the endpoint into an oracle for guessing
   * tokens, and a carrier does not read the difference either.
   */
  if (!connection) return new Response("Not found", { status: 404 });

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

  const outcome = await commsInbound.receive(
    getDb(),
    connection.provider,
    { url: publicUrl(token), headers, body },
    connection.organizationId,
  );

  if (outcome.kind === "rejected") {
    /**
     * 403 for a bad signature, 200 for anything else we could not use.
     *
     * A carrier retries a non-2xx, so returning an error for a message we
     * simply do not want means the same unusable request arrives every few
     * minutes for a day. A bad signature is different: it is worth being loud
     * about, and a genuine carrier will never see it.
     */
    return outcome.reason === "bad_signature"
      ? new Response("Forbidden", { status: 403 })
      : new Response("", { status: 200 });
  }

  /**
   * Empty TwiML rather than a body. Twilio treats a non-empty response as a
   * reply to send, so returning JSON here texts the customer a blob of it.
   */
  return new Response("<Response></Response>", {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
