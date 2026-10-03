import { and, desc, eq, gte, lte, lt } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { guardedRead, type ServiceContext } from "./context";

/**
 * READING THE AUDIT LOG, WHICH NOTHING COULD DO
 *
 * `audit_log` is written on every mutation in this product. Thirty six
 * services call `audit`, the row carries the actor, the action, the entity
 * and the complete before and after state, and the module page says so:
 *
 *   "Audit as source of truth, not as an afterthought. Every mutation writes
 *   to the audit log with the actor and a complete before-and-after record.
 *   A customer can replay their entire history from the log."
 *
 * They could not. `audit:read` was granted to roles and checked by nothing,
 * because no screen and no route read the table back. The claim was true
 * about the writing and false about the only part anybody would ever use.
 *
 * WHY THIS IS A SEPARATE FILE rather than a function on `roles.ts` or
 * `context.ts`: `context.ts` is imported by every service, and putting a
 * guarded read in it would mean every service imports a reader of a table it
 * only writes. The write stays where every caller already finds it.
 *
 * WHAT THIS DELIBERATELY DOES NOT OFFER.
 *
 * No delete, no edit and no retention trim. An audit log that can be
 * corrected is not one, and the absence is the feature. If a row is wrong,
 * the thing that is wrong is the action it recorded.
 *
 * No full text search across `before` and `after`. Those columns hold
 * arbitrary jsonb of whatever the row looked like, including columns a
 * reader's own permissions would normally withhold: a technician cannot see
 * cost on a job, and the audit row for that job holds it. Offering a search
 * over the payload would be a way around every field level rule in the
 * product, which is why this reads by entity, actor and action and returns
 * the payload only to somebody holding `audit:read`.
 */

export interface AuditRow {
  id: string;
  /** The person, or null for the system, the worker, a workflow or the portal. */
  actorUserId: string | null;
  /** An agent, when a model acted. A different fact from a user acting. */
  actorAgentId: string | null;
  /** A customer acting through a portal grant rather than a session. */
  actorPortalGrantId: string | null;
  /** The contact on the customer who held that grant, when it was not the customer themselves. */
  actorContactId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  at: string;
}

export interface AuditQuery {
  entityType?: string | undefined;
  entityId?: string | undefined;
  actorUserId?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** Keyset cursor: the `at` of the last row seen. */
  before?: string | undefined;
  limit?: number | undefined;
}

export interface AuditPage {
  rows: AuditRow[];
  /** Pass back as `before` to continue. Null when there is no more. */
  nextBefore: string | null;
}

/**
 * The log, newest first.
 *
 * KEYSET PAGED ON `created_at`, NOT OFFSET, for the reason
 * `contracts/common.ts` gives about every other list in this product: offset
 * paging silently skips or repeats rows when the underlying set changes
 * between pages, and this is the one table that grows while somebody reads
 * it. An auditor who pages through a busy morning with an offset cursor sees
 * rows twice and misses others, which is the exact failure an audit log
 * exists to rule out.
 *
 * The cursor is the timestamp rather than an id, because `created_at` is what
 * the index is on and what the order is by. Two rows in the same millisecond
 * are possible and the consequence is bounded: `lt` rather than `lte` means a
 * tie at the page boundary drops the rest of that millisecond, and `lte`
 * would repeat it. Repeating is the safer of the two for an audit read, so
 * the page boundary is inclusive and the caller may see one row twice rather
 * than never see it at all.
 */
export async function read(ctx: ServiceContext, input: AuditQuery): Promise<AuditPage> {
  return guardedRead(ctx, "audit:read", async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

    const rows = await tx.select().from(schema.auditLog)
      .where(and(
        eq(schema.auditLog.organizationId, ctx.actor.organizationId),
        input.entityType ? eq(schema.auditLog.entityType, input.entityType) : undefined,
        input.entityId ? eq(schema.auditLog.entityId, input.entityId) : undefined,
        input.actorUserId ? eq(schema.auditLog.actorUserId, input.actorUserId) : undefined,
        input.action ? eq(schema.auditLog.action, input.action) : undefined,
        input.from ? gte(schema.auditLog.createdAt, new Date(input.from)) : undefined,
        input.to ? lte(schema.auditLog.createdAt, new Date(input.to)) : undefined,
        input.before ? lt(schema.auditLog.createdAt, new Date(input.before)) : undefined,
      ))
      .orderBy(desc(schema.auditLog.createdAt))
      /**
       * One more than asked for, so "is there another page" is answered by
       * what came back rather than by a second count query against the
       * largest table in the schema.
       */
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const more = rows.length > limit;

    return {
      rows: page.map((row) => ({
        id: row.id,
        actorUserId: row.actorUserId,
        actorAgentId: row.actorAgentId,
        actorPortalGrantId: row.actorPortalGrantId,
        actorContactId: row.actorContactId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        before: row.before,
        after: row.after,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        at: row.createdAt.toISOString(),
      })),
      nextBefore: more ? page[page.length - 1]!.createdAt.toISOString() : null,
    };
  });
}

/**
 * One record's whole history, oldest first, which is the question a dispute
 * actually asks.
 *
 * A separate function rather than `read` with a filter and a reversed sort,
 * because the order is the point: "what happened to this invoice" is read
 * forwards, and a caller who has to remember to flip the sort will read a
 * history backwards and describe it that way to a customer.
 */
export async function historyOf(
  ctx: ServiceContext, input: { entityType: string; entityId: string; limit?: number | undefined },
): Promise<{ rows: AuditRow[] }> {
  const page = await read(ctx, {
    entityType: input.entityType,
    entityId: input.entityId,
    limit: input.limit ?? 200,
  });
  return { rows: [...page.rows].reverse() };
}

export const handlers = {
  readAuditLog: (ctx: ServiceContext, input: AuditQuery): Promise<AuditPage> => read(ctx, input),
  getRecordHistory: (
    ctx: ServiceContext, input: { entityType: string; entityId: string; limit?: number | undefined },
  ): Promise<{ rows: AuditRow[] }> => historyOf(ctx, input),
} as const;
