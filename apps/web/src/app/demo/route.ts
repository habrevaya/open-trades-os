import { NextResponse } from "next/server";
import { headers } from "next/headers";
import * as demo from "@opentradesos/api/services/demo";
import { getDb } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { SESSION_COOKIE, issueToken, sessionCookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * THE PUBLIC DEMO'S FRONT DOOR
 *
 * `GET /demo` signs the visitor in as the demo company's read only user for
 * two hours and takes them to the dispatch board. No form and no account:
 * a link on a website is the whole journey. docs/self-hosting/demo.md.
 *
 * Off unless DEMO_ORGANIZATION_ID is set, and off means the same 404 as any
 * path that does not exist. Set, it still answers 404 unless that company
 * has been made the demo (`demo:setup`), so a deployment that pastes a real
 * company's id here by mistake has published nothing.
 *
 * Every decision that matters (is this company the demo, is this address
 * over its limit, which user) is made in `app.create_demo_session`, in SQL,
 * in one round trip. What the session can do is decided where every session
 * is resolved: the demo user's sessions are read only, whatever anybody does
 * to its membership.
 */
export async function GET(): Promise<Response> {
  const organizationId = process.env["DEMO_ORGANIZATION_ID"]?.trim();
  if (!demo.isUuid(organizationId)) return notFound();

  /**
   * Somebody already looking at the demo who clicks the link again keeps
   * their session rather than spending another of their address's quota.
   */
  const current = await getCurrentUser();
  if (current?.demo && current.organizationId === organizationId) return toTheBoard();

  const h = await headers();
  const ip = h.get("x-nf-client-connection-ip")
    ?? h.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? h.get("x-real-ip")
    ?? undefined;

  const { token, tokenHash } = issueToken();
  const outcome = await demo.createDemoSession(getDb(), { organizationId, tokenHash, ip });
  if (outcome === "not_demo") return notFound();
  if (outcome === "limited") {
    return new Response(
      "Too many demo sessions from this address in the last hour. Try again later.",
      { status: 429, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "3600" } },
    );
  }

  const response = toTheBoard();
  response.cookies.set(SESSION_COOKIE, token, {
    ...sessionCookieOptions,
    maxAge: demo.DEMO_SESSION_HOURS * 3600,
  });
  return response;
}

/**
 * Relative, so it is right behind whatever proxy or CDN the site sits behind;
 * the URL this handler sees is not always the one the visitor typed.
 */
function toTheBoard(): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: "/schedule", "cache-control": "no-store" } });
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}
