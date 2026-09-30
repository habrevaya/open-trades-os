import { getDb } from "@/lib/db";
import { email } from "@opentradesos/api/services";
// Registers the email adapters.
import "@opentradesos/api/email";

export const dynamic = "force-dynamic";

/**
 * WHERE A SENDING PROVIDER REPORTS BACK
 *
 * The fourth webhook endpoint in this product and deliberately the same shape
 * as the other three: carriers, leads and payments each read the raw bytes
 * here and hand them to a service function. What differs between providers is
 * parsing and signing, and both of those belong to the adapter.
 *
 * The token in the path identifies the connection, and therefore the tenant.
 * It is resolved with a security definer function before any tenant exists,
 * because the token is what establishes one.
 *
 * WHY THIS IS NOT AN API ROUTE. The signature is an HMAC over the exact bytes
 * of the body, and the API dispatcher parses a body to an object before any
 * handler sees it. A JSON round trip changes key order and whitespace and
 * every signature stops matching, which presents as "the signing secret is
 * wrong" and costs an afternoon.
 *
 * WHAT A FORGED EVENT IS WORTH, so that none of this is optional: anybody who
 * could post an unverified bounce here could put any address on this
 * company's do not email list, silently, and the company would stop being
 * able to invoice that customer without ever learning why.
 */

/**
 * The URL the signature is computed over.
 *
 * From configuration, not from the request. Behind a load balancer the
 * request arrives as http on an internal hostname, and rebuilding the URL
 * from `Host` and `X-Forwarded-Proto` means whoever can set those chooses
 * what gets signed, which turns the check into decoration.
 */
function publicUrl(token: string): string {
  const base = process.env["PUBLIC_URL"];
  if (!base) {
    throw new Error("PUBLIC_URL is not set. The webhook signature is computed over it.");
  }
  return `${base.replace(/\/$/, "")}/api/webhooks/email/${token}`;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;

  /**
   * Read once and never re-serialized. See the note above: this is the one
   * thing this file exists to get right.
   */
  const rawBody = await request.text();

  const outcome = await email.receiveByToken(getDb(), {
    token,
    url: publicUrl(token),
    headers: Object.fromEntries(
      [...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]),
    ),
    rawBody,
  });

  /**
   * A 404 for an unknown token and a 401 for a bad signature, and nothing in
   * between that would let somebody test tokens against the difference.
   *
   * 422 for a body this cannot parse, because it will fail identically on
   * every retry.
   *
   * 200 for anything that was recorded, including an event nothing here
   * models, because the provider should stop retrying it: a non 2xx has
   * Resend redeliver for hours and eventually disable the endpoint, which
   * would cost the delivery reporting that is the only reason this endpoint
   * exists.
   */
  if (outcome.kind === "rejected") {
    const status = outcome.reason === "unknown_token" ? 404
      : outcome.reason === "bad_signature" ? 401
        : outcome.reason === "not_supported" ? 409
          : 422;
    return Response.json({ error: outcome.reason }, { status });
  }

  return Response.json(outcome.outcome, { status: 200 });
}
