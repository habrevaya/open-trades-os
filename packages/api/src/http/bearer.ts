import { createHash, timingSafeEqual } from "node:crypto";

/**
 * A SHARED SECRET FROM THE ENVIRONMENT
 *
 * Two surfaces are guarded by a single token the deployment sets rather than
 * by anything in the database: the operator API and the worker tick. Both are
 * off unless the token is set, and both follow the rules in this file, which
 * are in one place so they cannot drift apart.
 *
 * SHORT IS OFF, NOT WEAK. A token under 32 characters disables the surface
 * and says so in the log, rather than guarding it with something guessable.
 * The same floor the carrier webhook tokens get, for the same reason: a
 * deployment that sets `OPERATOR_TOKEN=changeme` should get no operator API,
 * not one anybody can reach.
 */
export const MIN_TOKEN_LENGTH = 32;

const warned = new Set<string>();

/**
 * The token named by `name`, or null when the surface is off.
 *
 * Trimmed, because a value pasted into a hosting dashboard with a trailing
 * newline would otherwise never match and the symptom would be a 401 on a
 * token the operator can see is correct.
 */
export function configuredToken(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = env[name]?.trim();
  if (!value) return null;
  if (value.length < MIN_TOKEN_LENGTH) {
    // Once per process, not once per request: this runs on every call.
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(
        `[security] ${name} is set but shorter than ${MIN_TOKEN_LENGTH} characters, `
        + `so the surface it guards is disabled. Use \`openssl rand -base64 48\`.`,
      );
    }
    return null;
  }
  return value;
}

const BEARER = /^Bearer\s+(\S+)\s*$/;

/**
 * Whether the request presents exactly this token.
 *
 * Constant time, over DIGESTS rather than the strings. `timingSafeEqual`
 * throws on inputs of different lengths, and the obvious guard, comparing the
 * lengths first, answers faster for a wrong length and so tells a caller how
 * long the token is. Two SHA-256 digests are always 32 bytes, so the
 * comparison always runs and always takes the same time. The digest is
 * computed even when no header was sent, for the same reason.
 *
 * Only the Authorization header is read. Never a cookie, never a query
 * parameter: a cookie is attached by the browser whether or not anybody meant
 * to use it, and a query string ends up in access logs.
 */
export function presentsToken(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = BEARER.exec(header);
  const presented = createHash("sha256").update(match?.[1] ?? "").digest();
  const wanted = createHash("sha256").update(expected).digest();
  const equal = timingSafeEqual(presented, wanted);
  return equal && match !== null;
}
