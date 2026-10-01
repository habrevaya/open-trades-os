import { getDb } from "@/lib/db";
import * as calendar from "@opentradesos/api/services/calendar";
// Registers the calendar providers.
import "@opentradesos/api/calendar";

export const dynamic = "force-dynamic";

/**
 * WHERE A CALENDAR CLIENT COLLECTS A TECHNICIAN'S DAY
 *
 * One endpoint, subscribed to by Google Calendar, Apple Calendar, Outlook
 * and every phone. No OAuth, no app review and no vendor: the client simply
 * fetches this URL every so often and redraws.
 *
 * THE TOKEN IN THE PATH IS THE WHOLE CREDENTIAL, which is the same shape as
 * the lead webhook next door and a different risk. There the token routes a
 * request that still has to carry a valid signature; here possession IS the
 * access, because a calendar client has no way to sign anything and never
 * will. So the token is 256 bits from the system generator, only its hash is
 * stored, every collection is stamped on the row, and revoking is one call.
 *
 * It is a GET with no side effect a caller can observe, so it carries no CSRF
 * concern and needs no preflight. It is also, deliberately, not part of the
 * JSON API: a route in the contract registry means a session and an envelope,
 * and this returns `text/calendar` to a client that has neither.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;

  /**
   * The link back into the product, from configuration rather than from the
   * request. Rebuilding it from `Host` would put whatever an attacker sets
   * there into a link on a technician's phone.
   */
  const baseUrl = process.env["PUBLIC_URL"];

  const feed = await calendar.render(getDb(), token, {
    ...(baseUrl ? { baseUrl } : {}),
    ...(request.headers.get("user-agent")
      ? { userAgent: request.headers.get("user-agent")! }
      : {}),
  });

  /**
   * An unknown token, a revoked one and one whose technician has been
   * removed all answer the same 404 with the same body. Distinguishing them
   * would let somebody test tokens against the difference, and a calendar
   * client reads none of it either: it simply shows the subscription as
   * failing, which is what a revoked feed should look like.
   */
  if (!feed) return new Response("Not found", { status: 404 });

  return new Response(feed.body, {
    status: 200,
    headers: {
      "Content-Type": feed.contentType,
      /**
       * `inline`, with a filename for the clients that offer to save rather
       * than subscribe. The name is sanitised because it comes from an
       * operator typed label and a quote or a newline in a header value is
       * a header injection.
       */
      "Content-Disposition": `inline; filename="${feed.label.replace(/[^A-Za-z0-9 _-]/g, "")}.ics"`,
      /**
       * Never cached by anything in between. This body is a list of
       * customers' home addresses keyed by a URL that is itself the
       * credential, and a shared cache holding it would serve it to the next
       * person who guessed the path. `private` alone would still let the
       * client keep a stale copy past a revocation.
       */
      "Cache-Control": "no-store, private",
    },
  });
}
