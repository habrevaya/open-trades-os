import { handleMcp } from "@opentradesos/api/mcp";
import { authenticate } from "@opentradesos/api/http";
import { getDb } from "@/lib/db";
import { sessionFromCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * THE MCP ENDPOINT
 *
 * One URL, and every tool behind it comes from the same contract registry the
 * HTTP API is served from. The pitch for this product is that a company can
 * run its operations however it likes through APIs and MCP that are as easy
 * to reach as the screens, and a curated handful of endpoints would be a demo
 * of that claim rather than the claim itself.
 *
 * The server takes a Request and returns a Response with no Next.js in it,
 * for the same reason the dispatcher does. A self hosted deployment that
 * wants to serve MCP from something else mounts it in these four lines.
 *
 * `basePath` is NOT set here, and that is not an omission. A tool call is
 * translated into a Request against the contract's own path, which is what
 * the dispatcher expects when nothing is mounted in front of it. The HTTP
 * route sets it because Next.js puts route handlers under /api; nothing is
 * in front of the dispatcher on this path.
 */
async function handle(request: Request): Promise<Response> {
  const db = getDb();

  return handleMcp(request, {
    db,
    serverName: "opentradesos",
    /**
     * Resolved twice, deliberately, and they must agree.
     *
     * `resolveActor` decides what this caller is SHOWN. `resolveSession` is
     * what the dispatcher uses to decide what they may DO, and it is the same
     * function the HTTP API passes. Listing is allowed to be narrower than
     * enforcement and never wider: if these ever disagreed in the other
     * direction, the dispatcher would still refuse.
     */
    resolveActor: async (req) => {
      const authenticated = await authenticate(req, { db, session: sessionFromCookie });
      return authenticated?.ctx.actor ?? null;
    },
    resolveSession: async (req) => {
      const authenticated = await authenticate(req, { db, session: sessionFromCookie });
      return authenticated?.ctx ?? null;
    },
  });
}

export const POST = handle;

/**
 * A GET answers rather than 404s.
 *
 * MCP's HTTP transport uses GET for a server-initiated event stream, which
 * this server does not offer: it has no notifications to push. A 404 here
 * tells a client the endpoint is wrong and sends somebody checking their
 * URL; 405 with the allowed method tells them what this endpoint is.
 */
export function GET(): Response {
  return new Response(
    JSON.stringify({ error: "This MCP endpoint speaks JSON-RPC over POST." }),
    { status: 405, headers: { allow: "POST", "content-type": "application/json" } },
  );
}
