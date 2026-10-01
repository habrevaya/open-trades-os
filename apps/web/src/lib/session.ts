import "server-only";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Hand rolled rather than promisify, because promisify collapses to the
 * three argument overload and silently drops the options object. Dropping it
 * means scrypt runs at Node's defaults (N=16384) instead of the parameters
 * below, and nothing anywhere would have told us.
 */
const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });

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
 * Passwords use scrypt, which is memory hard. N=2^15 is the value OWASP
 * currently names for scrypt with r=8, p=1.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 } as const;

/**
 * THE MEMORY CEILING THOSE PARAMETERS NEED, STATED.
 *
 * scrypt uses 128 * N * r bytes, which at the parameters above is exactly
 * 32 MiB, and Node refuses any call over its default `maxmem` of 32 MiB with
 * "memory limit exceeded". OpenSSL counts a little more than the block, so
 * the OWASP parameters sat just over the line and every call failed: nobody
 * could sign up, and nobody could sign in, because the login path hashes
 * even for an unknown email. The render tests never hash a password and the
 * HTTP smoke check never submits a form, so the first thing to notice was a
 * browser pressing "Create company".
 *
 * Twice the requirement of the strongest parameters we issue, which leaves
 * room to raise N once without revisiting this, and is applied to verifying
 * too, since a stored hash carries its own N.
 */
export const SCRYPT_MAXMEM = 2 * 128 * SCRYPT.N * SCRYPT.r;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, { ...SCRYPT, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(keyB64!, "base64");
  const actual = await scrypt(password.normalize("NFKC"), salt, expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
  });
  // Constant time. A length mismatch is compared against itself first so the
  // comparison never throws and never short circuits on length.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
};
