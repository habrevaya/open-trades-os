import { sql } from "drizzle-orm";
import type { Database } from "@opentradesos/db";
import { assertCan, redact, redactMany, effectiveScope, type Actor, type Permission, type ScopedResource } from "@opentradesos/core";

/**
 * THE SERVICE LAYER
 *
 * Every service call follows the same four steps, in the same order, and the
 * order is the point:
 *
 *   1. Check the permission, and throw before touching the database.
 *   2. Open a transaction with the tenant context set, so row level security
 *      is doing the isolation rather than a WHERE clause somebody has to
 *      remember to write.
 *   3. Narrow by scope, which is a different question from permission: a
 *      technician may read jobs, and only their own.
 *   4. Redact fields on the way out, once, at this boundary. Not in the UI,
 *      because by then the data has already crossed the wire.
 *
 * Anything that skips a step is a bug, and the shape of this file is what
 * makes skipping one visible in review.
 */

export interface ServiceContext {
  actor: Actor;
  db: Database;
  /**
   * Present on every write. Taken from the request header, so a retry from a
   * truck on bad signal is a no-op rather than a second job or a second charge.
   */
  idempotencyKey?: string;
  /** Set when an AI agent is acting, recorded on every audit entry it causes. */
  agentId?: string;
  /**
   * Set when the caller is a customer holding a link rather than a user with
   * a session. There is no `actor.userId` to record in that case, so the audit
   * trail names the grant instead.
   */
  portalGrantId?: string;
}

export class NotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * The application role every request runs as. Overridable because a
 * self hoster may name it differently, but never optional.
 */
const APP_ROLE = process.env.DATABASE_APP_ROLE ?? "authenticated";

/**
 * Run inside the tenant boundary.
 *
 * Three statements, and the FIRST one is the one that matters.
 *
 * `set local role` exists because row level security does not apply to a
 * superuser or to any role holding BYPASSRLS. This layer deliberately writes
 * no organization_id filter of its own and leans entirely on RLS, which is
 * correct: a hand written WHERE clause is forgotten eventually, and once is
 * enough. But it means that if the application ever connects as a privileged
 * role, there is no isolation at all. Not weak isolation. None.
 *
 * And people do deploy with a superuser connection string. It is the default
 * in most managed Postgres onboarding, and it is what DATABASE_URL usually
 * contains the first time anyone runs this.
 *
 * Dropping to an unprivileged role inside the transaction makes the policies
 * apply regardless of who connected, and `local` scopes it to the transaction
 * so the pooled connection is handed back unchanged.
 *
 * This was not theoretical. The integration test below caught exactly this:
 * the service returned another tenant's customers, because the test connected
 * as a superuser and every policy was silently inert.
 *
 * `set_config(..., true)` is likewise transaction scoped. A session level SET
 * would leak one tenant's context onto the next request that borrows the
 * connection, which is a cross tenant read and a silent one.
 */
export async function inTenant<T>(ctx: ServiceContext, fn: (tx: Database) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${quoteIdent(APP_ROLE)}`));
    await tx.execute(sql`select set_config('app.organization_id', ${ctx.actor.organizationId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${ctx.actor.userId}, true)`);
    return fn(tx as unknown as Database);
  });
}

/** The role name is configuration rather than user input, but it is
 *  interpolated into SQL, so it is quoted rather than trusted. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`DATABASE_APP_ROLE is not a valid identifier: ${name}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Step 1 and 2 together, which is how almost every read is written. */
export async function guardedRead<T>(
  ctx: ServiceContext,
  permission: Permission,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  assertCan(ctx.actor, permission);
  return inTenant(ctx, fn);
}

/** Same, for writes, so the permission check is never accidentally omitted. */
export async function guardedWrite<T>(
  ctx: ServiceContext,
  permission: Permission,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  assertCan(ctx.actor, permission);
  return inTenant(ctx, fn);
}

export const scopeOf = (ctx: ServiceContext, resource: ScopedResource) =>
  effectiveScope(ctx.actor, resource);

export const clean = <T extends Record<string, unknown>>(ctx: ServiceContext, entity: string, row: T) =>
  redact(ctx.actor, entity, row);

export const cleanAll = <T extends Record<string, unknown>>(ctx: ServiceContext, entity: string, rows: T[]) =>
  redactMany(ctx.actor, entity, rows);

/**
 * Cursor pagination over a monotonic key.
 *
 * Opaque on purpose. A cursor that is obviously an id or an offset gets
 * hand-edited by a client, and then it is an API we cannot change.
 */
export const encodeCursor = (value: string) => Buffer.from(value, "utf8").toString("base64url");
export const decodeCursor = (cursor: string | undefined): string | undefined =>
  cursor ? Buffer.from(cursor, "base64url").toString("utf8") : undefined;

export function paginate<T>(rows: T[], limit: number, key: (row: T) => string) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(key(last)) : null,
  };
}
