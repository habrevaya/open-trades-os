import { getDb } from "@/lib/db";
import { metaLeads } from "@opentradesos/api/services";

export const dynamic = "force-dynamic";

/**
 * META'S INSTANT FORM LEADS
 *
 * One address for the whole deployment, because a Meta app has one callback
 * address for Pages however many subscribe. The Page id in the post decides
 * the company, and the post's `X-Hub-Signature-256` is checked with that
 * company's app secret before anything is read; the lead itself is read back
 * from Meta. See `services/meta-leads.ts`.
 */

/** Meta's subscription check: the challenge echoed back, only for the deployment's own verify token. */
export async function GET(request: Request): Promise<Response> {
  const challenge = metaLeads.challenge(Object.fromEntries(new URL(request.url).searchParams.entries()));
  return challenge
    ? new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } })
    : new Response("Forbidden", { status: 403 });
}

export async function POST(request: Request): Promise<Response> {
  /** Read once, raw: the signature is over these exact bytes. */
  const body = await request.text();
  const answer = await metaLeads.receive(getDb(), {
    headers: Object.fromEntries([...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value])),
    body,
  });
  return Response.json(answer.body, { status: answer.status });
}
