import { getDb } from "@/lib/db";
import { marketplaceLeads } from "@opentradesos/api/services";

export const dynamic = "force-dynamic";

/**
 * WHERE A LEAD ARRIVES
 *
 * One endpoint for every marketplace, form builder and partner, because what
 * differs between them is the field names and the verification, and both of
 * those belong to the adapter. The generic webhook is signed with this
 * product's HMAC; Angi and Thumbtack post with the password the company
 * chose; Yelp posts only an id that is read back from Yelp. Which one a post
 * is, is decided by the connector its token names, never by the post.
 *
 * THE TOKEN IN THE PATH IDENTIFIES THE CONNECTOR, AND THEREFORE THE TENANT.
 * It is a secret, which is why it is not the company slug: a slug is on
 * their website, and using it to route would let anybody aim a forged lead
 * at a company they chose.
 *
 * A FORGED LEAD IS NOT A SPAM PROBLEM. It is a job on a dispatch board, a
 * slot a real customer could have had, and a van driving to an address that
 * never asked for one. That is why every kind's check has no setting that
 * disables it and no path around it. The decisions are all in
 * `marketplaceLeads.receiveWebhook`; this file reads the raw request and
 * answers with what it says.
 */

/**
 * The URL the signature is computed over.
 *
 * From configuration, not from the request. Behind a load balancer or a
 * tunnel the request arrives as http on an internal hostname, and rebuilding
 * the URL from `Host` and `X-Forwarded-Proto` means an attacker who can set
 * those chooses what gets signed, which turns the check into decoration.
 */
function publicUrl(token: string): string {
  const base = process.env["PUBLIC_URL"];
  if (!base) {
    throw new Error("PUBLIC_URL is not set. The webhook signature is computed over it.");
  }
  return `${base.replace(/\/$/, "")}/api/webhooks/leads/${token}`;
}

async function handle(request: Request, token: string): Promise<Response> {
  /**
   * The raw body, read once and never re-serialized. Parsing it to an object
   * and stringifying it back changes one byte of whitespace and every
   * signature stops matching, which presents as "the secret is wrong" and
   * costs an afternoon.
   */
  const body = request.method === "POST" ? await request.text() : "";
  const answer = await marketplaceLeads.receiveWebhook(getDb(), {
    token,
    url: publicUrl(token),
    method: request.method,
    headers: Object.fromEntries([...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value])),
    body,
    query: Object.fromEntries(new URL(request.url).searchParams.entries()),
  });
  return Response.json(answer.body, { status: answer.status });
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  return handle(request, (await context.params).token);
}

/** Yelp checks an address before it will post to it; nothing is written by a GET. */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  return handle(request, (await context.params).token);
}
