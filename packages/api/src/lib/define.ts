import { z } from "zod";
import type { modules } from "@opentradesos/core";

/**
 * ROUTE DEFINITION
 *
 * One definition produces three things that would otherwise drift apart:
 * runtime validation, the TypeScript types, and the OpenAPI document.
 *
 * The documentation cannot go stale because it is not written separately. That
 * matters more here than in most products: the whole pitch is that you own
 * your data, and an API whose docs lie about its shape is not ownership.
 */

export type Method = "get" | "post" | "patch" | "put" | "delete";

/**
 * What stands between a caller and this route.
 *
 * `session`   A signed-in user in an organization. Their permissions are
 *             checked against the route's list. This is almost everything.
 *
 * `grant`     A capability token: single purpose, scoped to one record,
 *             expiring. The grant IS the permission, so the route declares
 *             none. The customer approving an estimate has no account and
 *             never will, and a platform that insists on one loses the
 *             approval.
 *
 * `public`    Nobody at all. The booking widget's service list and
 *             availability, read by a stranger on a website. Rate limited by
 *             address and by IP, and it returns nothing about anyone.
 *
 * This is declared rather than inferred because the mistake it prevents is
 * silent: a write route that simply forgot its permissions and a write route
 * that is deliberately reachable without one look identical in the code, and
 * only one of them is a security hole.
 */
export type Authorization = "session" | "grant" | "public";

export interface RouteDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
  TAuth extends Authorization = Authorization,
> {
  method: Method;
  path: string;
  summary: string;
  description?: string;
  /**
   * Module code, so docs and the permission matrix group the same way.
   *
   * The UNION rather than a string, because this was a string and a whole
   * surface shipped tagged M12 (Projects) when it was M31 (Commercial
   * Contracts). The type cannot catch a code that is real and wrong for the
   * route, but it catches every code that is not a module at all, and the
   * registry it names is checked against the module docs by a test.
   */
  module: modules.ModuleCode;
  /** Every permission the caller must hold. Checked before the handler runs. */
  permissions: readonly string[];
  /**
   * Defaults to `session`. See the type for why this is declared rather than
   * inferred.
   *
   * Carried in the route's TYPE, not only its value, so the handler registry
   * in src/routes can demand a different function shape for a route a stranger
   * can reach. Widening it to the plain union here would make every route look
   * identical to the compiler, and wiring an open handler onto an
   * authenticated route would be a runtime problem instead of a build error.
   */
  authorization?: TAuth;
  input: TInput;
  output: TOutput;
  /**
   * Writes take an idempotency key. Not optional on money paths: a retried
   * request must be a no-op, never a second charge.
   */
  idempotent?: boolean;
  /** Excluded from the public OpenAPI document. */
  internal?: boolean;
}

export function defineRoute<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
  TAuth extends Authorization = "session",
>(
  def: RouteDefinition<TInput, TOutput, TAuth>,
): RouteDefinition<TInput, TOutput, TAuth> {
  const auth = def.authorization ?? "session";

  if (def.method !== "get" && def.permissions.length === 0 && auth === "session" && !def.internal) {
    throw new Error(
      `Write route ${def.method} ${def.path} declares no permissions. ` +
      `If it is reachable without a session, say so with authorization: "grant" or "public".`,
    );
  }

  // The inverse mistake, and the more dangerous one. A route that lists
  // permissions AND claims to be reachable without a session is contradictory,
  // and whichever way it is resolved at runtime, one of the two statements is
  // a lie about who can call it.
  if (auth !== "session" && def.permissions.length > 0) {
    throw new Error(
      `Route ${def.method} ${def.path} is authorized by ${auth} but also declares permissions. ` +
      `A caller with no session cannot hold one.`,
    );
  }

  return def;
}

export type InputOf<R> = R extends RouteDefinition<infer I, z.ZodTypeAny, Authorization> ? z.infer<I> : never;
export type OutputOf<R> = R extends RouteDefinition<z.ZodTypeAny, infer O, Authorization> ? z.infer<O> : never;

/** How a route is reached, with `session` filled in where it was left out. */
export type AuthOf<R> = R extends RouteDefinition<z.ZodTypeAny, z.ZodTypeAny, infer A> ? A : "session";
