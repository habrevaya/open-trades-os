import { commsInbound } from "@opentradesos/api/services";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * WHERE THE CARRIER FETCHES A PICTURE THIS COMPANY IS SENDING
 *
 * A picture message is sent by handing the carrier a URL, which it fetches
 * at the moment it sends, with no login. So the address is the credential:
 * the connection's webhook token (which company) and the picture's own
 * random key (which picture), neither guessable. One 404 for everything
 * that is not a live outgoing picture, so the endpoint answers no questions
 * about which tokens or keys exist.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string; key: string }> },
): Promise<Response> {
  const { token, key } = await context.params;
  const found = await commsInbound.publicPicture(getDb(), token, key);
  if (!found) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(found.bytes), {
    status: 200,
    headers: {
      "Content-Type": found.contentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
