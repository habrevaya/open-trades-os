import { randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";

/**
 * PASSWORDS, AND THE ONE WAY A PASSWORD IS CHECKED
 *
 * This lived in the web app, which was fine while the sign in form was the
 * only thing that checked a password. The phone app signs in too, through the
 * API, and a second copy of "five wrong passwords, then fifteen minutes"
 * would be the copy nobody updated the day the rule changed. So the hashing,
 * the lockout and the choice of company are here, and the web form calls
 * them.
 */

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

/**
 * Five wrong passwords, then fifteen minutes.
 *
 * Low enough to make an online guessing attack pointless, high enough that a
 * person working through their password manager does not lock themselves out.
 * The window restarts on every further attempt, so somebody hammering the
 * form keeps extending their own lock rather than waiting it out.
 */
export const MAX_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

/** What an unknown email is checked against, so both paths take as long. */
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";

export type CredentialCheck =
  | { ok: true; userId: string }
  | { ok: false; error: string };

/**
 * Whether this email and password belong together, with the lockout applied.
 *
 * The refusals are sentences a person reads on a sign in screen, and there
 * are deliberately only two of them.
 */
export async function checkCredentials(
  db: Database, email: string, password: string,
): Promise<CredentialCheck> {
  /**
   * The hash is fetched through app.credential_for_login, not selected. The
   * credential table denies the application role entirely, so a password hash
   * is only ever reachable through a path that can be logged and rate limited.
   */
  const rows = await db.execute<{ user_id: string; password_hash: string; locked_until: Date | null }>(
    sql`select * from app.credential_for_login(${email})`,
  );
  const found = rows[0];

  /**
   * One message for an unknown email and for a wrong password, and the hash
   * comparison runs either way. Distinguishing them turns the sign in form
   * into an endpoint for enumerating which of your customers use this product.
   */
  const ok = found
    ? await verifyPassword(password, found.password_hash)
    : await verifyPassword(password, DUMMY_HASH);

  if (!found || !ok) {
    /**
     * Counted for an unknown email too, harmlessly: the function matches on
     * the address and updates nothing when there is no such user, so it adds
     * no behavioural difference between a real address and a made up one.
     */
    await db.execute(sql`select app.record_failed_login(${email}, ${MAX_ATTEMPTS}, ${LOCK_MINUTES})`);
    return { ok: false, error: "That email and password do not match" };
  }

  /**
   * Checked AFTER the password, deliberately, and the order is the privacy
   * property rather than an oversight.
   *
   * Somebody guessing passwords gets the same generic message whether or not
   * the account is locked, so the form never becomes an oracle for which
   * addresses exist or which are under attack. Only a caller who has proved
   * they know the password is told why they are still refused, which is the
   * person who needs to know.
   */
  const lockedUntil = found.locked_until ? new Date(found.locked_until) : null;
  if (lockedUntil && lockedUntil > new Date()) {
    return { ok: false, error: "This account is temporarily locked. Try again shortly." };
  }

  // Correct password, not locked. A person who mistyped twice and then got it
  // right must not carry those attempts toward a lock next week.
  await db.execute(sql`select app.clear_failed_logins(${found.user_id}::uuid)`);
  return { ok: true, userId: found.user_id };
}

/**
 * The company a fresh sign in lands in: one that is not suspended first, when
 * there is one.
 *
 * Somebody who belongs to two companies, one of which has been suspended,
 * would otherwise be signed into whichever row the database returned first
 * and told their account is suspended when the other one is fine. When every
 * company they belong to is suspended they still get a session, and the app
 * shows them the suspension rather than a wrong password.
 */
export async function defaultOrganization(db: Database, userId: string): Promise<string | null> {
  const memberships = await db
    .select({ organizationId: schema.membership.organizationId })
    .from(schema.membership)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.membership.organizationId))
    .where(and(eq(schema.membership.userId, userId), eq(schema.membership.active, true)))
    .orderBy(sql`${schema.organization.suspendedAt} is not null`)
    .limit(1);
  return memberships[0]?.organizationId ?? null;
}
