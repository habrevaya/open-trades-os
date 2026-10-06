import { getDb } from "@/lib/db";
import { voice } from "@opentradesos/api/services";
// Registers the voice adapters.
import "@opentradesos/api/voice";

export const dynamic = "force-dynamic";

/**
 * WHERE THE CARRIER ASKS WHAT TO DO WITH A CALL
 *
 * A tracking number bought on the settings screen is pointed here as it is
 * bought: the call itself at `/api/webhooks/voice/{token}`, and each step of
 * it (the recording question's answer, the whisper, the dial's result, the
 * recording and the status) at a path beneath that.
 *
 * The token in the path is the Twilio connection's own webhook secret, the
 * same one its texts arrive with, and it is what says which company this is.
 * The number dialled never does: it is printed on the van. The signature is
 * checked over the public URL the carrier was given, path and all, so a step
 * somebody invented fails it like a body somebody invented.
 */
function publicUrl(token: string, step: string | undefined, search: string): string {
  const base = process.env["PUBLIC_URL"];
  if (!base) throw new Error("PUBLIC_URL is not set. The webhook signature is computed over it.");
  return `${base.replace(/\/$/, "")}/api/webhooks/voice/${token}${step ? `/${step}` : ""}${search}`;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string; step?: string[] }> },
): Promise<Response> {
  const { token, step: segments } = await context.params;
  const step = segments?.[0];
  const known = step === undefined ? "incoming" : (voice.STEPS as readonly string[]).includes(step) ? step : null;
  if (!known || (segments?.length ?? 0) > 1) return new Response("Not found", { status: 404 });

  /** The raw body, read once and never re-serialized, for the signature. */
  const body = await request.text();
  const connection = await voice.resolveWebhook(getDb(), token);
  /** One 404 for an unknown token and a connection that cannot take calls. */
  if (!connection) return new Response("Not found", { status: 404 });

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

  const reply = await voice.handle(getDb(), connection, known as voice.Step, {
    url: publicUrl(token, step, new URL(request.url).search),
    headers,
    body,
  });

  if (reply.status === 403) return new Response("Forbidden", { status: 403 });
  if (reply.twiml === null) return new Response("", { status: reply.status });
  return new Response(reply.twiml, { status: reply.status, headers: { "Content-Type": "text/xml" } });
}
