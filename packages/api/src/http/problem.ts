import { PermissionError } from "@opentradesos/core";
import {
  NotFoundError, ConflictError, InvalidGrantError, OrganizationSuspendedError, UnprocessableError,
} from "../services/context";

/**
 * THE SHAPE OF A REFUSAL
 *
 * One shape for every error this API returns, whichever surface returned it:
 * the contract routes, the operator API and the worker tick. An integrator
 * writes one error handler, and the day two surfaces disagree about the shape
 * is the day somebody's handler throws on the error it was meant to report.
 *
 * Its own file so those surfaces can share it without importing each other.
 */
export const problem = (
  status: number,
  title: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify({ error: title, status, ...extra }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

export function json(value: unknown, status: number): Response {
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
  /**
   * 403 with a code a client can branch on. Not 401: the credential is good
   * and signing in again will not help, and not 404, which would tell a
   * company's own staff that their data has gone.
   */
  if (error instanceof OrganizationSuspendedError) {
    return problem(403, error.message, { code: error.code });
  }
  if (error instanceof NotFoundError) return problem(404, error.message);
  if (error instanceof ConflictError) return problem(409, error.message);
  /**
   * The same shape as the dispatcher's own 422, with the field that is wrong,
   * so a client handles "the schema refused it" and "the arithmetic refused
   * it" with one branch.
   */
  if (error instanceof UnprocessableError) {
    return problem(422, error.message, error.issues.length > 0 ? { issues: error.issues } : {});
  }

  /**
   * 410, and it used to be a 500.
   *
   * A customer clicking an estimate link that expired last week got
   * "Internal error", and the server logged it as an unhandled exception:
   * the one person who could have been told something useful was told
   * nothing, and the log line that should mean a bug meant a link doing
   * exactly what links do. Gone rather than 404 because the resource was
   * real and is not any more, which is the difference between "check your
   * URL" and "ask them to send a new one". The message is safe to echo: it
   * says nothing about whether the token expired, was revoked or never
   * existed.
   */
  if (error instanceof InvalidGrantError) return problem(410, error.message);

  console.error("Unhandled error serving a request:", error);
  return problem(500, "Internal error");
}
