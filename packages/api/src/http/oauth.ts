import type { Database } from "@opentradesos/db";
import { TooManyRequestsError } from "../services/context";
import {
  OAuthError, registerClient, exchange, revoke, introspect, authorizationServerMetadata, protectedResourceMetadata,
} from "../services/oauth";

/**
 * THE OAUTH ENDPOINTS, AS REQUEST IN AND RESPONSE OUT
 *
 * Not contract routes, and deliberately. OAuth fixes its own wire format: the
 * token endpoint takes a form body, refusals are `{ error, error_description }`
 * with `error` from a short list clients branch on, and the discovery
 * documents live at `/.well-known/` paths. Squeezing them through the
 * dispatcher would mean either breaking OAuth clients or teaching the
 * dispatcher a second error format, so they are served here, framework free,
 * the way `handleMcp` is, and mounted by the web app in a few lines each.
 */

/**
 * The instance's own address: the configured public URL when there is one,
 * otherwise the origin the request arrived at. The issuer a client is told
 * and the resource it asks for must agree across requests, which is why a
 * configured address wins over whatever host header a proxy forwarded.
 */
export function publicOrigin(request: Request, env: Record<string, string | undefined> = process.env): string {
  const configured = env["PUBLIC_URL"] || env["AUTH_URL"];
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

/**
 * Readable from any origin. These endpoints read no cookie and act on no
 * session, so a page on another origin learns nothing from them it could not
 * learn by calling them itself, and a browser based MCP client has to be able
 * to reach them.
 */
const OPEN = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
  "access-control-max-age": "86400",
};

const jsonResponse = (value: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // A token response must never be cached, by RFC 6749 section 5.1.
      "cache-control": "no-store",
      pragma: "no-cache",
      ...OPEN,
      ...extra,
    },
  });

export const preflight = (): Response => new Response(null, { status: 204, headers: OPEN });

function refusal(error: unknown): Response {
  if (error instanceof OAuthError) {
    /**
     * A client that failed to prove who it is gets a 401 naming Basic, as
     * RFC 6749 section 5.2 asks, so a library that tried the form first
     * knows the header is accepted too.
     */
    const challenge = error.status === 401 ? { "www-authenticate": 'Basic realm="OpenTradesOS", charset="UTF-8"' } : {};
    return jsonResponse({ error: error.error, error_description: error.description }, error.status, challenge);
  }
  if (error instanceof TooManyRequestsError) {
    return jsonResponse(
      { error: "slow_down", error_description: error.message },
      429,
      { "retry-after": String(error.retryAfterSeconds) },
    );
  }
  console.error("[oauth]", error);
  return jsonResponse({ error: "server_error", error_description: "The server could not handle that request." }, 500);
}

const addressOf = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;

/** RFC 7591 registration. */
export async function handleRegister(request: Request, db: Database): Promise<Response> {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "POST") return jsonResponse({ error: "invalid_request", error_description: "POST only." }, 405);
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return jsonResponse({ error: "invalid_client_metadata", error_description: "The body must be JSON." }, 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "invalid_client_metadata", error_description: "The body must be a JSON object." }, 400);
  }
  try {
    return jsonResponse(await registerClient(db, body as Record<string, unknown>, addressOf(request)), 201);
  } catch (error) {
    return refusal(error);
  }
}

/**
 * A POST to the token, revocation or introspection endpoint, as fields.
 * Form encoded per RFC 6749, and JSON accepted too, because more than one MCP
 * client library sends JSON and refusing it would be strictness that helps
 * nobody. A Response when the request cannot be read at all.
 */
async function readForm(request: Request): Promise<Record<string, string | undefined> | Response> {
  if (request.method !== "POST") return jsonResponse({ error: "invalid_request", error_description: "POST only." }, 405);
  const text = await request.text();
  const form: Record<string, string | undefined> = {};
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed ?? {})) if (typeof value === "string") form[key] = value;
    } catch {
      return jsonResponse({ error: "invalid_request", error_description: "The body is not valid JSON." }, 400);
    }
  } else {
    for (const [key, value] of new URLSearchParams(text)) form[key] = value;
  }
  return form;
}

/** What a client sent to prove who it is, beside the form. */
const credentialsOf = (request: Request) => ({ authorization: request.headers.get("authorization") });

/** The token endpoint: a code with its verifier, or a refresh token, for a token pair. */
export async function handleToken(request: Request, db: Database): Promise<Response> {
  if (request.method === "OPTIONS") return preflight();
  const form = await readForm(request);
  if (form instanceof Response) return form;
  try {
    return jsonResponse(await exchange(db, form, addressOf(request), credentialsOf(request)));
  } catch (error) {
    return refusal(error);
  }
}

/**
 * RFC 7009 revocation. A 200 with an empty object whether or not the token
 * existed, which the RFC requires so the answer says nothing about it.
 */
export async function handleRevoke(request: Request, db: Database): Promise<Response> {
  if (request.method === "OPTIONS") return preflight();
  const form = await readForm(request);
  if (form instanceof Response) return form;
  try {
    await revoke(db, form, addressOf(request), credentialsOf(request));
    return jsonResponse({});
  } catch (error) {
    return refusal(error);
  }
}

/** RFC 7662 introspection: whether one of the caller's own tokens is live. */
export async function handleIntrospect(request: Request, db: Database): Promise<Response> {
  if (request.method === "OPTIONS") return preflight();
  const form = await readForm(request);
  if (form instanceof Response) return form;
  try {
    return jsonResponse(await introspect(db, form, publicOrigin(request), addressOf(request), credentialsOf(request)));
  } catch (error) {
    return refusal(error);
  }
}

export const handleAuthorizationServerMetadata = (request: Request): Response =>
  jsonResponse(authorizationServerMetadata(publicOrigin(request)));

export const handleProtectedResourceMetadata = (request: Request): Response =>
  jsonResponse(protectedResourceMetadata(publicOrigin(request)));

/**
 * What the MCP endpoint answers a request with no usable credential.
 *
 * A 401 with a `WWW-Authenticate` header naming the protected resource
 * document, which is the whole of how an MCP client discovers that it should
 * start OAuth and where. `invalid_token` when a bearer was presented and
 * refused, so a client holding an expired access token knows to refresh
 * rather than to send the person through consent again.
 */
export function mcpUnauthorized(request: Request, presentedToken: boolean): Response {
  const origin = publicOrigin(request);
  const challenge = [
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    ...(presentedToken ? ['error="invalid_token"', 'error_description="The token is not valid. Refresh it or connect again."'] : []),
  ].join(", ");
  return new Response(
    JSON.stringify({ error: "Not signed in. Connect with OAuth, or present an app token." }),
    {
      status: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": challenge,
        ...OPEN,
        "access-control-expose-headers": "www-authenticate",
      },
    },
  );
}
