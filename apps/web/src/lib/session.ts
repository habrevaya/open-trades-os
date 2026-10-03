import "server-only";
import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "ots_session";
export const SESSION_TTL_DAYS = 30;

/**
 * The raw token goes in the cookie. Only its SHA-256 is stored, so a dump of
 * the session table does not hand anyone a working login. The token has 256
 * bits of entropy, which is not guessable, so a plain hash is correct here:
 * password stretching exists to slow down guessing a low entropy secret, and
 * this is not one.
 */
export function issueToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Hashing and checking a password live in the API package now, because the
 * phone app signs in through the API and a second copy of the parameters
 * would be the one nobody updated. Re-exported so the sign in form and its
 * test keep reading them from here.
 */
export { hashPassword, verifyPassword, SCRYPT_MAXMEM } from "@opentradesos/api/services/passwords";

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
};
