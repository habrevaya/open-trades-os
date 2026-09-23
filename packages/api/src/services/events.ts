import { sql, eq, and, gt, asc } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { isSystem } from "@opentradesos/core";
import type { ServiceContext } from "./context";

/**
 * EMITTING A DOMAIN EVENT
 *
 * Written inside the same transaction as the change it describes, always.
 *
 * The alternative is to emit after commit, and it is wrong in a way that only
 * shows up under load: the transaction commits, the process dies, and the
 * event never happens. A customer's job is completed and the workflow that
 * was supposed to text them never runs, with no trace that anything was
 * missed. Inside the transaction, either both happen or neither does.
 */

export interface EmitInput {
  name: string;
  entityType: string;
  entityId?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  /** The values before the change, for `changed` and `changed_to` conditions. */
  previous?: Record<string, unknown> | undefined;
  /** Set when a workflow run caused this, so the loop guards have a chain. */
  causedByRunId?: string | undefined;
  causationDepth?: number | undefined;
}

/**
 * The next sequence for an organization.
 *
 * Serialized with a transaction scoped advisory lock rather than left to
 * `max() + 1`, which is what the rest of this codebase does for document
 * numbers and is racy: two concurrent writers read the same maximum and both
 * insert it. For a job number that is a duplicate somebody notices. For an
 * event sequence it is worse, because a consumer tracking its position by
 * sequence would skip one of the two.
 *
 * The lock is keyed on the organization, so tenants never wait on each other,
 * and it releases at commit without any cleanup path to get wrong.
 */
async function nextSequence(tx: Database, organizationId: string): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`domain_event:${organizationId}`}))`);
  const rows = await tx.execute<{ next: number }>(sql`
    select coalesce(max(sequence), 0) + 1 as next
    from public.domain_event
    where organization_id = ${organizationId}
  `);
  return Number(rows[0]?.next ?? 1);
}

export async function emit(
  tx: Database,
  ctx: ServiceContext,
  input: EmitInput,
): Promise<{ id: string; sequence: number }> {
  const organizationId = ctx.actor.organizationId;
  const sequence = await nextSequence(tx, organizationId);

  const [row] = await tx.insert(schema.domainEvent).values({
    organizationId,
    sequence,
    name: input.name,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    /**
     * `previous` travels inside the payload rather than in its own column,
     * because a consumer reading an event a week later needs both halves and
     * splitting them means two reads to answer one question.
     */
    payload: {
      ...(input.payload ?? {}),
      ...(input.previous ? { previous: input.previous } : {}),
    },
    /**
     * A portal caller has no user, same as the audit log, and neither does
     * the system. The worker, the scheduler and a workflow run all act as
     * the nil uuid, which is not a row in the user table, so writing it
     * breaks a foreign key five layers below where anybody could read the
     * error. A scheduled workflow's first event hit exactly that.
     */
    actorUserId: ctx.portalGrantId || isSystem(ctx.actor) ? null : ctx.actor.userId,
    actorAgentId: ctx.agentId ?? ctx.actor.agentId ?? null,
    causedByRunId: input.causedByRunId ?? null,
    causationDepth: input.causationDepth ?? 0,
  }).returning({ id: schema.domainEvent.id, sequence: schema.domainEvent.sequence });

  return { id: row!.id, sequence: row!.sequence };
}

/**
 * Events after a position, oldest first.
 *
 * A cursor rather than a timestamp. Two events can share a timestamp and a
 * consumer resuming from one would either repeat or skip, which for a
 * workflow that sends a message is a duplicate text or a missed one.
 */
export async function since(
  tx: Database,
  organizationId: string,
  afterSequence: number,
  limit = 100,
) {
  return tx.select().from(schema.domainEvent)
    .where(and(
      eq(schema.domainEvent.organizationId, organizationId),
      gt(schema.domainEvent.sequence, afterSequence),
    ))
    .orderBy(asc(schema.domainEvent.sequence))
    .limit(limit);
}
