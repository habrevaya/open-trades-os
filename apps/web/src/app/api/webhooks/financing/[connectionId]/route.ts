import { getDb } from "@/lib/db";
import { financing } from "@opentradesos/api/services";
// Registers the lender adapters.
import "@opentradesos/api/financing";

export const dynamic = "force-dynamic";

/**
 * WHERE A LENDER SAYS AN APPLICATION MOVED
 *
 * The operator pastes this URL, with the connection id on the end, into the
 * lender's dashboard, and the lender is also handed it on every application
 * it opens. Routed on the connection id for the reason the payments webhook
 * gives: the signing secret is the connection's, so the company has to be
 * known before the signature can be checked, and the id is a routing key
 * rather than a credential.
 *
 * Everything after reading the raw body is `financing.receiveWebhook`, which
 * verifies, deduplicates, reads the application back from the lender and only
 * then records anything. The route's only jobs are the raw bytes and the
 * status code.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const { connectionId } = await context.params;
  /** Read once and never re-serialised, or no signature matches. */
  const body = await request.text();
  const headers = Object.fromEntries(
    [...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]),
  );
  const answer = await financing.receiveWebhook(getDb(), { connectionId, request: { headers, body } });
  return Response.json(answer.body, { status: answer.status });
}
