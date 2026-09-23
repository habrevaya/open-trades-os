import { and, asc, eq, inArray, isNull, lte, notInArray, or } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  guardedRead, guardedWrite, NotFoundError, ConflictError,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * DEADLINES, AND THE ONE THAT NOBODY COULD SEE
 *
 * `obligation` is described in the schema as one primitive for a thing that
 * would otherwise be a date column on six tables: "SLAs, acknowledge-by,
 * on-site-by, invoicing windows, warranty registration deadlines and claim
 * windows are all one thing", under a comment saying the reason for one table
 * is that "the thing everyone actually needs is what is about to breach,
 * across all of them".
 *
 * One place in the product inserted into it. `jobs.complete`, when a
 * technician finishes work on a visit that was cancelled, writes one with the
 * consequence "A technician completed work on a cancelled visit. Confirm
 * whether to bill it", under a comment that reads: "Not an error on the
 * write, an obligation on a dispatcher. It shows up in the same place every
 * other approaching deadline does."
 *
 * It showed up nowhere. No code selected from the table, so every one of
 * those rows was written and never read, and the work they describe, deciding
 * whether to bill somebody for work that was done after the job was called
 * off, simply did not get done. The money is real: it is a completed visit
 * that nobody invoiced.
 *
 * WHY A BREACH IS DERIVED AND NOT TRUSTED
 *
 * `state` is a stored column with `open` as its default, and the obvious read
 * is `where state = 'open' and due_at < now()`. That read is wrong in the one
 * case that matters. If the sweep that moves rows from `open` to `breached`
 * has not run, or was never deployed, or died three weeks ago, a query
 * filtering on `state = 'breached'` returns nothing and the screen says
 * everything is fine. A monitoring system whose failure mode is silence and
 * a clean bill of health is worse than none.
 *
 * So overdue is computed from `due_at` against the clock on every read, and
 * `state` is only ever used to exclude things somebody has FINISHED with:
 * satisfied, waived, cancelled. `breachedAt` is still stamped by the sweep,
 * because "when did we first notice" is a fact worth keeping and an
 * escalation needs somewhere to record that it fired, but nothing reads a
 * breach from it.
 */

/** The states that mean somebody has dealt with this. Everything else is live. */
const CLOSED = ["satisfied", "waived", "cancelled"] as const;

export type ObligationState = typeof schema.obligationState.enumValues[number];

export interface ObligationView {
  id: string;
  kind: string;
  entityType: string;
  entityId: string;
  state: ObligationState;
  dueAt: Date;
  consequence: string | null;
  /** Computed against the clock, never read from `state`. See above. */
  overdue: boolean;
  /** Negative once it is past. Minutes, because an SLA is rarely measured in days. */
  minutesRemaining: number;
  escalateAt: Date | null;
  escalatedAt: Date | null;
  breachedAt: Date | null;
}

const shape = (row: typeof schema.obligation.$inferSelect, now: Date): ObligationView => ({
  id: row.id,
  kind: row.kind,
  entityType: row.entityType,
  entityId: row.entityId,
  state: row.state,
  dueAt: row.dueAt,
  consequence: row.consequence,
  overdue: row.dueAt.getTime() <= now.getTime(),
  minutesRemaining: Math.round((row.dueAt.getTime() - now.getTime()) / 60_000),
  escalateAt: row.escalateAt,
  escalatedAt: row.escalatedAt,
  breachedAt: row.breachedAt,
});

/**
 * Raise one, for a caller already inside a tenant transaction.
 *
 * Takes the transaction rather than a context because every raiser is in the
 * middle of doing something else: completing a visit, receiving a job from a
 * portal, submitting an invoice. An obligation raised in its own transaction
 * can survive a rollback of the thing that caused it, which produces a
 * deadline attached to an event that did not happen.
 */
export async function raise(
  tx: Database,
  organizationId: string,
  input: {
    kind: string;
    entityType: string;
    entityId: string;
    dueAt: Date;
    consequence?: string | undefined;
    escalateAt?: Date | undefined;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(schema.obligation).values({
    organizationId,
    kind: input.kind,
    entityType: input.entityType,
    entityId: input.entityId,
    dueAt: input.dueAt,
    consequence: input.consequence ?? null,
    escalateAt: input.escalateAt ?? null,
  }).returning({ id: schema.obligation.id });
  return { id: row!.id };
}

/**
 * What is live, soonest first.
 *
 * Past due rows come first because they sort by `dueAt` and theirs is in the
 * past. That is the correct order and it is worth saying: a queue that put
 * upcoming work above work that is already late would be a queue people stop
 * trusting within a week.
 */
export async function open(
  ctx: ServiceContext,
  options: { overdueOnly?: boolean; kind?: string; limit?: number } = {},
) {
  return guardedRead(ctx, "task:read", async (tx) => {
    const now = new Date();
    const rows = await tx.select().from(schema.obligation)
      .where(and(
        eq(schema.obligation.organizationId, ctx.actor.organizationId),
        /**
         * NOT IN the closed states, rather than `= 'open'`. A state added to
         * the enum later, or one this file does not know about, shows up as
         * live work rather than vanishing: the failure of a list of
         * deadlines must be noisy.
         *
         * And in SQL rather than after the fetch. Filtering in JavaScript
         * would apply the LIMIT first, so a company with five hundred
         * satisfied obligations would get a page of finished work and an
         * empty queue, which is the exact failure this file exists to
         * prevent.
         */
        notInArray(schema.obligation.state, [...CLOSED]),
        ...(options.overdueOnly ? [lte(schema.obligation.dueAt, now)] : []),
        ...(options.kind ? [eq(schema.obligation.kind, options.kind)] : []),
      ))
      .orderBy(asc(schema.obligation.dueAt))
      .limit(Math.min(options.limit ?? 100, 500));

    return rows.map((row) => shape(row, now));
  });
}

/** How many are live and how many of those are already past due. */
export async function counts(ctx: ServiceContext) {
  const live = await open(ctx, { limit: 500 });
  return {
    live: live.length,
    overdue: live.filter((o) => o.overdue).length,
  };
}

async function load(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.obligation)
    .where(and(
      eq(schema.obligation.id, id),
      eq(schema.obligation.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Obligation");
  return row;
}

/**
 * It was met.
 *
 * `satisfiedByEvent` is required rather than optional, and it is the reason
 * this function is worth having over an UPDATE. The schema's own comment on
 * that column says "What satisfied it, so a scorecard can be audited rather
 * than asserted", and a scorecard built from rows that say only "somebody
 * clicked" is a scorecard that cannot be defended to the customer holding the
 * contract it came from.
 */
export async function satisfy(
  ctx: ServiceContext,
  input: { id: string; satisfiedByEvent: string },
) {
  return guardedWrite(ctx, "task:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    if ((CLOSED as readonly string[]).includes(before.state)) {
      /**
       * Absorbing, like every other terminal state in this codebase. The one
       * that matters is `waived`: re-satisfying a waived obligation would let
       * somebody quietly turn a deliberate decision not to meet a deadline
       * into a record saying it was met.
       */
      throw new ConflictError(
        `This was already ${before.state}. It cannot be satisfied now: that would rewrite a decision somebody made.`,
      );
    }
    if (input.satisfiedByEvent.trim() === "") {
      throw new ConflictError(
        "Say what satisfied this. A scorecard built from rows that record only a click cannot be audited.",
      );
    }

    const [row] = await tx.update(schema.obligation).set({
      state: "satisfied",
      satisfiedAt: new Date(),
      satisfiedByEvent: input.satisfiedByEvent.trim(),
      updatedAt: new Date(),
    }).where(eq(schema.obligation.id, input.id)).returning();

    await audit(tx, ctx, "obligation.satisfied", "obligation", input.id, before, row!);
    return shape(row!, new Date());
  });
}

/**
 * It will not be met, and that is a decision rather than a failure.
 *
 * Separate from satisfying, and separate from cancelling, because the three
 * are genuinely different answers to the same question and a scorecard that
 * collapsed them would be useless: satisfied is "we did it", waived is "we
 * agreed not to", cancelled is "the thing it was attached to went away".
 */
export async function waive(ctx: ServiceContext, input: { id: string; reason: string }) {
  return guardedWrite(ctx, "task:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    if ((CLOSED as readonly string[]).includes(before.state)) {
      throw new ConflictError(`This was already ${before.state}.`);
    }
    if (input.reason.trim() === "") {
      throw new ConflictError("Say why. A waiver with no reason is indistinguishable from forgetting.");
    }

    const [row] = await tx.update(schema.obligation).set({
      state: "waived",
      satisfiedByEvent: `waived: ${input.reason.trim()}`,
      updatedAt: new Date(),
    }).where(eq(schema.obligation.id, input.id)).returning();

    await audit(tx, ctx, "obligation.waived", "obligation", input.id, before, row!);
    return shape(row!, new Date());
  });
}

/**
 * Mark what has gone past, and note what needs escalating.
 *
 * Deliberately NOT what makes a breach visible. The reads above compute
 * overdue from the clock, so this running late, or not at all, delays a
 * stamp and an escalation and never hides a deadline. That separation is the
 * whole point: a sweep that owned visibility would make its own outage look
 * like a quiet week.
 *
 * Idempotent on both halves, by different means, and the difference is worth
 * naming because the obvious guard is unreachable on one of them.
 *
 * The breach half is idempotent because it selects `state = 'open'` and then
 * sets the state to `breached`, so a row it has touched no longer matches.
 * An extra `breached_at is null` there would never change an outcome: there
 * is no path in this file that moves a row back to open. It is not written.
 *
 * The escalation half genuinely needs `escalated_at is null`, because it
 * does NOT change the state: a row stays open or breached after escalating,
 * so without that check every sweep would escalate it again.
 */
export async function sweep(ctx: ServiceContext, now = new Date()) {
  return guardedWrite(ctx, "task:write", async (tx) => {
    const breached = await tx.update(schema.obligation).set({
      state: "breached",
      breachedAt: now,
      updatedAt: now,
    }).where(and(
      eq(schema.obligation.organizationId, ctx.actor.organizationId),
      eq(schema.obligation.state, "open"),
      lte(schema.obligation.dueAt, now),
    )).returning({ id: schema.obligation.id });

    const escalated = await tx.update(schema.obligation).set({
      escalatedAt: now,
      updatedAt: now,
    }).where(and(
      eq(schema.obligation.organizationId, ctx.actor.organizationId),
      inArray(schema.obligation.state, ["open", "breached"]),
      isNull(schema.obligation.escalatedAt),
      lte(schema.obligation.escalateAt, now),
    )).returning({ id: schema.obligation.id });

    return { breached: breached.length, escalated: escalated.length };
  });
}

/**
 * Close the ones attached to something that no longer exists.
 *
 * Cancelled rather than satisfied or deleted. The obligation happened, and a
 * scorecard asking "how many did we meet" needs the denominator to exclude
 * the ones that stopped being owed, not to count them as met.
 */
export async function cancelFor(
  tx: Database,
  organizationId: string,
  entityType: string,
  entityId: string,
): Promise<number> {
  const rows = await tx.update(schema.obligation).set({
    state: "cancelled",
    updatedAt: new Date(),
  }).where(and(
    eq(schema.obligation.organizationId, organizationId),
    eq(schema.obligation.entityType, entityType),
    eq(schema.obligation.entityId, entityId),
    or(
      eq(schema.obligation.state, "open"),
      eq(schema.obligation.state, "breached"),
    ),
  )).returning({ id: schema.obligation.id });
  return rows.length;
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listObligations: async (ctx: ServiceContext, input: {
    overdueOnly?: boolean | undefined; kind?: string | undefined; limit: number;
  }): Promise<{ obligations: ObligationView[] }> => ({
    obligations: await open(ctx, {
      ...(input.overdueOnly === undefined ? {} : { overdueOnly: input.overdueOnly }),
      ...(input.kind ? { kind: input.kind } : {}),
      limit: input.limit,
    }),
  }),

  satisfyObligation: (ctx: ServiceContext, input: { id: string; satisfiedByEvent: string }) =>
    satisfy(ctx, input),

  waiveObligation: (ctx: ServiceContext, input: { id: string; reason: string }) =>
    waive(ctx, input),

  sweepObligations: (ctx: ServiceContext) => sweep(ctx),
} as const;
