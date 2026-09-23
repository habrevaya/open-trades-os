import { z } from "zod";
import { PermissionError } from "@opentradesos/core";
import type { Database } from "@opentradesos/db";
import { handlers, type RequestMeta } from "../routes/index";
import { NotFoundError, ConflictError, type ServiceContext } from "../services/context";
import { matchRoute, queryToInput } from "./match";
import type { RouteDefinition } from "../lib/define";

/**
 * THE HTTP LAYER
 *
 * One function turns a Request into a Response for every route in the
 * contracts, because the contracts already say the method, the path, the
 * input schema and who is allowed to call it. Writing a handler file per
 * endpoint would be sixty files that each restate what the contract already
 * knows, and the first one to fall out of step would be a security hole
 * rather than a typo.
 *
 * It is deliberately framework free. It takes a Request and returns a
 * Response, so the Next.js app mounts it in four lines and so can anything
 * else. Self hosting is the whole point of this product, and an API that only
 * runs inside one framework is a smaller promise than it sounds.
 */

export interface DispatchDeps {
  db: Database;
  /**
   * Where this API is mounted, stripped from the path before matching.
   *
   * The contracts declare `/v1/customers` because that is the API's own
   * shape, and the Next.js app serves it under `/api/v1/customers` because
   * that is where Next.js route handlers live. Without this the two disagree
   * and every request is a 404 that looks like a missing route rather than a
   * mounting mistake, which is exactly how it was found.
   */
  basePath?: string;
  /**
   * Resolves the caller from the request, or nothing.
   *
   * Injected rather than imported, because session resolution reads cookies
   * through the host framework. Keeping it out here is what lets this file be
   * tested without a web server, and what stops the API package depending on
   * the app that mounts it.
   */
  resolveSession: (request: Request) => Promise<ServiceContext | null>;
  /**
   * The connected application behind this request, when there is one and the
   * route did not require it.
   *
   * Separate from `resolveSession` because on a public route a token is not
   * what admits the caller: booking is open to anybody with the company's
   * slug. It is what attributes the booking, and a partner whose token
   * expired should still be able to send work rather than silently stop.
   *
   * Optional, so a deployment that has no connected apps passes nothing and
   * the behaviour is unchanged.
   */
  resolveApp?: (request: Request) => Promise<string | undefined>;
}

const problem = (
  status: number,
  title: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify({ error: title, status, ...extra }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/**
 * What kind of value each top level key of a schema wants, so the query
 * string can be coerced without the contract having to say `z.coerce`.
 *
 * Unwraps optionals, defaults and nullables, because `z.number().optional()`
 * still wants a number.
 */
function shapeOf(schema: z.ZodTypeAny): Record<string, "number" | "boolean" | "array" | "other"> {
  const out: Record<string, "number" | "boolean" | "array" | "other"> = {};
  const object = unwrap(schema);
  if (!(object instanceof z.ZodObject)) return out;

  for (const [key, value] of Object.entries(object.shape as Record<string, z.ZodTypeAny>)) {
    const inner = unwrap(value);
    out[key] =
      inner instanceof z.ZodNumber ? "number"
      : inner instanceof z.ZodBoolean ? "boolean"
      : inner instanceof z.ZodArray ? "array"
      : "other";
  }
  return out;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  // Bounded, because a self-referential schema would otherwise spin here.
  for (let i = 0; i < 10; i += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
    } else {
      return current;
    }
  }
  return current;
}

export async function dispatch(request: Request, deps: DispatchDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = strip(url.pathname, deps.basePath);
  const { match, pathMatched, allowed } = matchRoute(request.method, path);

  if (!match) {
    // 405 rather than 404 when the path exists for another method. Answering
    // 404 sends an integrator looking for a typo in a correct URL.
    return pathMatched
      ? problem(405, `${request.method} is not allowed on ${url.pathname}`,
          { allowed: allowed.map((m) => m.toUpperCase()) },
          { allow: allowed.map((m) => m.toUpperCase()).join(", ") })
      : problem(404, `No route for ${url.pathname}`);
  }

  const route = match.route as RouteDefinition;

  /**
   * Input comes from three places and they are merged in one order: query
   * string, then body, then path parameters LAST.
   *
   * Path parameters win because they are the only part of the input the
   * caller cannot contradict. A body carrying a different `id` from the URL
   * it was sent to is either a mistake or an attempt, and either way the URL
   * is the request.
   */
  let body: unknown = {};
  if (request.method !== "GET" && request.method !== "DELETE") {
    const text = await request.text();
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return problem(400, "Request body is not valid JSON");
      }
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return problem(400, "Request body must be a JSON object");
    }
  }

  const merged = {
    ...queryToInput(url.searchParams, shapeOf(route.input)),
    ...(body as Record<string, unknown>),
    ...match.params,
  };

  const parsed = route.input.safeParse(merged);
  if (!parsed.success) {
    // The field paths, not a prose message. An integrator fixes a request from
    // "limit: expected number, received string" and cannot from "bad input".
    return problem(422, "Request did not match the schema", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const handler = handlers[match.name as keyof typeof handlers] as
    | ((first: unknown, input: unknown, meta?: RequestMeta) => Promise<unknown>)
    | undefined;
  if (!handler) {
    // The contracts test makes this unreachable. It is here because "unreachable"
    // and "cannot happen" are different, and a 501 is a better answer than a
    // stack trace.
    return problem(501, `${match.name} is declared but not implemented`);
  }

  const meta: RequestMeta = {
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: request.headers.get("user-agent") ?? undefined,
    /**
     * Carried for EVERY route, not only the ones with a session.
     *
     * This used to be read inside the session branch alone, so a grant or
     * public route declaring `idempotent: true` got nothing: the flag was
     * decorative on the estimate approval, the decline and the public
     * booking. The first two happen to be safe because approving an already
     * approved estimate returns the existing one. The booking inserts, so a
     * double tap made two.
     *
     * The header is still never read from the body: a client that
     * regenerates its body on retry would regenerate a key inside it, which
     * is the one thing an idempotency key must not do.
     */
    idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
  };

  /**
   * Resolved for open routes only. A `session` route already ran the token
   * through `resolveSession`, and looking it up twice would double the work
   * on every authenticated request to save a branch here.
   */
  if ((route.authorization ?? "session") !== "session" && deps.resolveApp) {
    meta.connectedAppId = await deps.resolveApp(request);
  }

  try {
    const authorization = route.authorization ?? "session";

    if (authorization === "session") {
      const ctx = await deps.resolveSession(request);
      if (!ctx) return problem(401, "Not signed in");

      /**
       * The idempotency key is taken from the header and never from the body.
       * A retry has to send the same key as the original, and a client that
       * regenerates its body on retry would regenerate a key inside it.
       */
      if (route.idempotent && meta.idempotencyKey) ctx.idempotencyKey = meta.idempotencyKey;

      const result = await handler(ctx, parsed.data);
      return json(result, route.method === "post" ? 201 : 200);
    }

    // grant and public both reach the database directly: there is no session
    // to resolve, and the handler checks the token itself where there is one.
    const result = await handler(deps.db, parsed.data, meta);
    return json(result, route.method === "post" ? 201 : 200);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Removes the mount prefix, and only when the path actually starts with it.
 *
 * A prefix stripped unconditionally would turn `/v1/customers` served at the
 * root into `ustomers` the moment somebody set a base path by mistake.
 */
function strip(pathname: string, basePath: string | undefined): string {
  if (!basePath) return pathname;
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (pathname === base) return "/";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value ?? null), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Domain errors to status codes.
 *
 * Anything not recognised is a 500 with no detail. Echoing an unknown error's
 * message is how a database constraint name, a file path or a query fragment
 * ends up in somebody's browser.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof PermissionError) {
    // 403, not 401. The caller is known and is not allowed, and answering 401
    // tells a signed-in user to sign in again, which will not help.
    return problem(403, error.message);
  }
  if (error instanceof NotFoundError) return problem(404, error.message);
  if (error instanceof ConflictError) return problem(409, error.message);

  console.error("Unhandled error serving a request:", error);
  return problem(500, "Internal error");
}
