import { sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, isSystem, redact, redactMany, effectiveScope, type Actor, type Permission, type ScopedResource } from "@opentradesos/core";

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
  /**
   * The SHA-256 of the phone app's device token, when that is what signed
   * this request in. Registering a device reads it to bind the token to the
   * device it came from, so revoking that device ends the sign in too.
   */
  deviceTokenHash?: string;
}

export interface RequestMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
  /**
   * The connected application that made this request, on a route that does
   * not require one. Attribution rather than authorization: a booking through
   * a partner has to be distinguishable from one off the widget, or an
   * operator deciding whether a channel is worth keeping has nothing to
   * decide with.
   */
  connectedAppId?: string | undefined;
  /**
   * The `idempotency-key` header, on a route that has no session.
   *
   * It exists because `idempotent: true` was being declared on grant and
   * public routes and silently ignored: the dispatcher read the header only
   * inside the session branch, so three routes advertised a guarantee that no
   * code path could provide. Two of them survived on domain state, which is
   * luck rather than design. The third inserts a row, so a homeowner double
   * tapping Book on a phone with one bar made two bookings and took two slots
   * out of a window.
   *
   * A caller with no session chooses this value themselves, which means it is
   * not trusted on its own. See how booking uses it: the key narrows a
   * fingerprint of the submission rather than acting as a lookup key, because
   * a guessable key that returns somebody else's booking would hand out their
   * address.
   */
  idempotencyKey?: string | undefined;
}

/**
 * A portal link that will not open.
 *
 * It lives here rather than in portal.ts, with the other domain errors,
 * because `errorResponse` in the HTTP layer maps these to status codes and
 * cannot import a service. While it was defined over there it was simply not
 * in that map, so every expired estimate link a customer clicked came back as
 * 500 "Internal error" AND logged as an unhandled exception, which both told
 * the customer nothing and buried the real unhandled errors in the noise.
 */
export class InvalidGrantError extends Error {
  constructor() {
    // Deliberately says nothing about why. Expired, revoked, spent and never
    // existed are all the same message, because distinguishing them tells an
    // attacker which tokens were once real.
    super("This link is no longer valid.");
    this.name = "InvalidGrantError";
  }
}

/**
 * A credential that is fine, for a company that is suspended.
 *
 * Kept apart from "not signed in" on purpose. A person whose company has been
 * suspended and who is told to sign in again will do exactly that, succeed,
 * and be told the same thing, and the next thing anybody hears about it is a
 * support ticket that says the login page is broken. Here with the other
 * domain errors so the HTTP layer can map it to a 403 without importing a
 * service.
 */
export class OrganizationSuspendedError extends Error {
  readonly code = "organization_suspended";
  constructor() {
    super("This account is suspended. Contact whoever provides your service.");
    this.name = "OrganizationSuspendedError";
  }
}

/**
 * A sign in that did not happen: the wrong password, a locked account, or an
 * account with nothing for the app it signed in from.
 *
 * Its own class so the HTTP layer answers 401 rather than 409. A phone that
 * reads 409 as "the office changed something" would show a sync conflict to
 * somebody who mistyped their password.
 */
export class SignInRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRefusedError";
  }
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
 * A request that was well formed and cannot be what it says.
 *
 * The schema check in the dispatcher answers "is this the right shape", and a
 * 422 from there names the field. Some refusals can only be made once the
 * service has done its arithmetic: an invoice whose stated total is not what
 * its lines add up to, a line whose stated tax is not what its rate gives, a
 * payment dated tomorrow. Those are the same kind of answer, so they come back
 * the same way, as a 422 with the field that is wrong, rather than as a 409
 * that reads like a clash with somebody else's write.
 */
export class UnprocessableError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = "UnprocessableError";
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

/**
 * Where a record came from, when it came from another system.
 *
 * Every table that can be imported carries `source_system` and `source_id`,
 * and for a long time nothing wrote them and nothing returned them, so the
 * answer to "which Jobber invoice did this become" lived only in whatever
 * local file the migration kept. They go out as one object because they mean
 * nothing apart, and the raw columns and the source payload do not go out at
 * all: the payload is whatever the other system sent, which is nobody's
 * contract.
 */
export interface ExternalRef { source: string; id: string }

type Provenanced<T> = T extends { sourceSystem: unknown; sourceId: unknown }
  ? Omit<T, "sourceSystem" | "sourceId" | "sourcePayload"> & { externalRef: ExternalRef | null }
  : T;

export function withProvenance<T extends Record<string, unknown>>(row: T): Provenanced<T> {
  if (!("sourceSystem" in row) || !("sourceId" in row)) return row as Provenanced<T>;
  const { sourceSystem, sourceId, sourcePayload: _payload, ...rest } = row as Record<string, unknown>;
  return {
    ...rest,
    externalRef: typeof sourceSystem === "string" && typeof sourceId === "string"
      ? { source: sourceSystem, id: sourceId }
      : null,
  } as Provenanced<T>;
}

export const clean = <T extends Record<string, unknown>>(ctx: ServiceContext, entity: string, row: T) =>
  redact(ctx.actor, entity, withProvenance(row));

export const cleanAll = <T extends Record<string, unknown>>(ctx: ServiceContext, entity: string, rows: T[]) =>
  redactMany(ctx.actor, entity, rows.map(withProvenance));

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

/**
 * The company's timezone, which is the only one a calendar day means anything
 * in.
 *
 * A read rather than a value on the context, because the context is built
 * from a session and the services are also called by the worker, by a
 * connected app and by tests, none of which have one. Every caller getting
 * the timezone from the same row is what stops half the product bounding a
 * day in UTC and the other half in Central.
 */
export async function timezoneOf(tx: Database, organizationId: string): Promise<string> {
  const [row] = await tx.execute<{ timezone: string | null }>(
    sql`select timezone from public.organization where id = ${organizationId} limit 1`,
  );
  /**
   * The same fallback the session resolver uses. A company with no timezone
   * predates the column; guessing UTC for it would move every board by five
   * hours for the one tenant least able to explain what changed.
   */
  return row?.timezone ?? "America/Chicago";
}

/**
 * EVERY MUTATION WRITES HERE, and an AI agent is named as the actor when one
 * is acting. Being able to answer "what did the agent do, and when" is what
 * makes an agent layer something an owner will actually turn on.
 *
 * It lives beside `guardedWrite` rather than in `customers.ts`, where it was
 * defined and where half the services still import it from. That was fine
 * while nothing customers.ts imports ever needed to audit anything. It stopped
 * being fine the moment a service customers.ts calls also wrote an audit line:
 * the two files then import each other, which happens to work today because
 * neither calls the other at module scope, and stops working silently the
 * first time somebody adds a top level constant derived from an import.
 *
 * `customers.ts` re-exports it, so the twenty-odd call sites that name it
 * there are untouched and correct.
 */
export async function audit(
  tx: Database, ctx: ServiceContext, action: string,
  entityType: string, entityId: string,
  before: unknown, after: unknown,
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    organizationId: ctx.actor.organizationId,
    /**
     * A portal caller has no user, and NEITHER DOES THE SYSTEM.
     *
     * The worker, the scheduler, a workflow run and the webhook delivery pass
     * all act as the nil uuid, which is not a row in `user`. Writing it breaks
     * a foreign key five layers below anybody who could read the error, and
     * the whole surrounding transaction rolls back: the audit line does not
     * merely go missing, it takes the business action with it.
     *
     * `emit` in `events.ts` has handled this since a scheduled workflow's
     * first event hit it. This function did not, so every background caller
     * that wanted an audit row had to either write one by hand or discover
     * the constraint. It is the same rule and it belongs in both places.
     */
    actorUserId: ctx.portalGrantId || isSystem(ctx.actor) ? null : ctx.actor.userId,
    actorPortalGrantId: ctx.portalGrantId ?? null,
    actorAgentId: ctx.agentId ?? ctx.actor.agentId ?? null,
    action,
    entityType,
    entityId,
    before: (before ?? null) as Record<string, unknown> | null,
    after: (after ?? null) as Record<string, unknown> | null,
  });
}
