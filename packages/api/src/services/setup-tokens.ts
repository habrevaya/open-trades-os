import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@opentradesos/db";
import { trimTrailingSlashes } from "@opentradesos/core";

/**
 * A LINK TO SET A FIRST PASSWORD
 *
 * The owner of a company somebody else created exists before they have a
 * password, and the thing to hand them is a link that lets them choose one.
 * Not a password chosen for them, which would then live in an email, a chat
 * message and a support ticket for as long as anybody keeps those.
 *
 * Same construction as a session: 256 random bits in the link, only the
 * SHA-256 stored, so a dump of the table opens nothing. Single use and
 * expiring, and the three SQL functions behind this file each refuse a user
 * who already has a password. That refusal is the property that matters: a
 * link that could be issued for an existing account would be a way to take
 * that account over by knowing its email address.
 */

/** Long enough to survive a weekend and a forwarded email, short enough to matter. */
export const SETUP_TOKEN_TTL_DAYS = 7;

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Where links point. `PUBLIC_URL` is what the webhooks already sign over, so
 * it is the address the outside world uses for this deployment; `AUTH_URL` is
 * the older name for the same thing and is honoured rather than ignored.
 */
export function publicBaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env["PUBLIC_URL"] || env["AUTH_URL"];
  return value ? trimTrailingSlashes(value) : undefined;
}

/**
 * Issue a link, replacing any this person had that were not used.
 *
 * Returns null when they already have a password, in which case there is
 * nothing to set and the right place to send them is the sign in page. Must
 * be called inside a transaction running as `platform_operator`: the function
 * behind it is not executable by the request path's role.
 */
export async function issue(
  tx: Database,
  userId: string,
  baseUrl: string,
  now = new Date(),
): Promise<string | null> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SETUP_TOKEN_TTL_DAYS * 864e5);
  const [row] = await tx.execute<{ issued: boolean }>(
    sql`select app.issue_setup_token(${userId}::uuid, ${hash(token)}, ${expiresAt.toISOString()}::timestamptz) as issued`,
  );
  if (!row?.issued) return null;
  // A query parameter rather than a path segment, and the page that reads it
  // sends no referrer, so the token does not travel on to anything it links to.
  return `${baseUrl}/welcome?token=${encodeURIComponent(token)}`;
}

export interface SetupTarget {
  userId: string;
  email: string;
  name: string | null;
}

/** Who a link is for, without spending it. Null for any link that will not work. */
export async function peek(db: Database, token: string): Promise<SetupTarget | null> {
  if (!token) return null;
  const [row] = await db.execute<{ user_id: string; email: string; name: string | null }>(
    sql`select * from app.peek_setup_token(${hash(token)})`,
  );
  return row ? { userId: row.user_id, email: row.email, name: row.name } : null;
}

/**
 * Spend a link and store the password, atomically. Returns the user id, or
 * null for a link that is used, replaced, expired, never existed, or belongs
 * to somebody who has a password already. Those are one answer on purpose:
 * telling them apart tells somebody holding a guessed link which guesses were
 * once real.
 */
export async function consume(db: Database, token: string, passwordHash: string): Promise<string | null> {
  if (!token) return null;
  const [row] = await db.execute<{ user_id: string | null }>(
    sql`select app.consume_setup_token(${hash(token)}, ${passwordHash}) as user_id`,
  );
  return row?.user_id ?? null;
}
