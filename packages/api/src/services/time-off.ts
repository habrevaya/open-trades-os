import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  guardedRead, guardedWrite, audit, scopeOf, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { technicianScopeFilter } from "./scope";
import { replayed, remember } from "./once";

/**
 * WHOSE TIME OFF somebody may see or answer: the people their timesheet
 * scope reaches, because time off is decided by whoever approves the hours.
 * A branch manager's queue is their branch's people, and another branch's
 * request opened by its id is not found.
 */
const peopleInScope = (ctx: ServiceContext) => {
  const people = technicianScopeFilter(scopeOf(ctx, "timesheet"), ctx.actor);
  return people === undefined ? undefined : sql`exists (
    select 1 from public.technician where ${schema.technician.id} = ${schema.timeOff.technicianId} and ${people}
  )`;
};

/**
 * TIME OFF, WHICH TWO SERVICES ALREADY REFUSE WORK ON AND NOTHING COULD RECORD
 *
 * `time_off` shipped in the first migration. Three services read it:
 *
 *   `services/dispatch.ts` draws an empty column on the board for approved
 *   leave, which is the whole reason a dispatcher can see who is away.
 *
 *   `services/crews.ts` refuses a crew with `everybody_off` and `lead_off`,
 *   bounded in the company's own zone so a holiday does not land on the
 *   wrong side of midnight.
 *
 *   `services/booking.ts` excludes a technician from the slots a customer is
 *   offered.
 *
 * All three are built, all three are tested, and nothing in the product could
 * write a row for them to read. Every one of those refusals was unreachable,
 * so every technician in every company was available every day forever.
 *
 * The tests for those features insert the row with raw SQL, which is how this
 * stayed invisible: the feature works, and the only caller that ever existed
 * was a test fixture.
 *
 * ON PERMISSIONS, all from the existing catalogue and none invented:
 *
 *   `timeclock:own`      request your own, and cancel your own request.
 *   `timesheet:read`     see somebody else's.
 *   `timesheet:approve`  approve, decline, or revoke an approval.
 *
 * That is the same split the timeclock already uses, and it is the right one:
 * the authority that decides whether somebody's claimed hours count is the
 * authority that decides whether a day off is granted. A technician requests
 * and cannot grant, which is what makes `approved` mean anything at all.
 */

/** Requested, granted, or turned down. */
export type Standing = "requested" | "approved" | "declined";

export interface TimeOffInput {
  /**
   * Whose. Omitted means your own, resolved from the actor, which is why a
   * technician needs no permission over anybody else to ask for a day.
   */
  technicianId?: string | undefined;
  startsAt: string;
  endsAt: string;
  reason?: string | null | undefined;
}

export interface TimeOffView {
  id: string;
  technicianId: string;
  technicianName: string | null;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  approved: boolean;
  /**
   * WHY THIS IS NOT JUST `approved`.
   *
   * The column is a boolean, and a boolean cannot tell a request nobody has
   * looked at from one somebody turned down. Both are `false`, and the
   * difference is whether the technician should expect an answer. Rather
   * than migrate the column, a decline soft-deletes the row: it stops being
   * a request, it stops being read by the board, and it is still there to
   * answer "did I ask for that week off".
   *
   * So `declined` is `deleted_at is not null`, and this field is what the
   * screen shows instead of making every caller know that.
   */
  standing: Standing;
}

const viewOf = (
  row: typeof schema.timeOff.$inferSelect & { technicianName?: string | null },
): TimeOffView => ({
  id: row.id,
  technicianId: row.technicianId,
  technicianName: row.technicianName ?? null,
  startsAt: row.startsAt.toISOString(),
  endsAt: row.endsAt.toISOString(),
  reason: row.reason,
  approved: row.approved,
  standing: row.deletedAt !== null ? "declined" : row.approved ? "approved" : "requested",
});

/**
 * The technician row for the person acting, or a refusal that says what to do.
 *
 * `membership` is the join between a user and an organization, and
 * `technician` hangs off it. An office manager has a membership and no
 * technician row, which is correct: they do not appear on the board and they
 * do not have a day to take off in the sense this table means.
 */
async function ownTechnician(
  tx: Database, organizationId: string, userId: string,
): Promise<string> {
  const [row] = await tx.select({ id: schema.technician.id })
    .from(schema.technician)
    .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
    .where(and(
      eq(schema.technician.organizationId, organizationId),
      eq(schema.membership.userId, userId),
    ));
  if (!row) {
    throw new ConflictError(
      "You are not set up as a technician in this company, so there is no schedule to take "
      + "time off from. Somebody with permission to request on your behalf can record it.",
    );
  }
  return row.id;
}

/**
 * Ask for time off.
 *
 * REQUESTED, NOT APPROVED. `approved` defaults to false on the column and is
 * left alone here deliberately: a request that granted itself would make the
 * board refuse work on a day nobody has agreed to, and the column would mean
 * nothing.
 */
export async function request(ctx: ServiceContext, input: TimeOffInput): Promise<TimeOffView> {
  const forSomebodyElse = input.technicianId !== undefined;
  /**
   * The permission depends on whose day it is, which is why this is resolved
   * before the guard rather than inside it. Asking for your own needs
   * nothing more than the permission to use your own timeclock; recording
   * somebody else's is a decision about another person's week.
   */
  const permission = forSomebodyElse ? "timesheet:approve" : "timeclock:own";

  return guardedWrite(ctx, permission, async (tx) => {
    /**
     * A retry gets the first answer. Without this a request whose response
     * was lost on a phone with one bar came back refused as overlapping the
     * request it had just made, and the route claimed to be idempotent.
     */
    const seen = await replayed<TimeOffView>(tx, ctx, "time_off_request");
    if (seen) return seen;

    const technicianId = input.technicianId
      ?? await ownTechnician(tx, ctx.actor.organizationId, ctx.actor.userId);

    await assertTechnician(tx, ctx.actor.organizationId, technicianId);
    if (forSomebodyElse) await assertInScope(tx, ctx, technicianId);
    const { startsAt, endsAt } = window(input.startsAt, input.endsAt);
    await assertNoOverlap(tx, ctx.actor.organizationId, technicianId, startsAt, endsAt, null);

    const [row] = await tx.insert(schema.timeOff).values({
      organizationId: ctx.actor.organizationId,
      technicianId,
      startsAt,
      endsAt,
      reason: input.reason?.trim() || null,
    }).returning();

    await audit(tx, ctx, "time_off.requested", "time_off", row!.id, null, row!);
    const view = viewOf(row!);
    await remember(tx, ctx, "time_off_request", row!.id, view);
    return view;
  });
}

/**
 * Grant it, which is the write the board and the crew gate actually read.
 *
 * Separate from `request` rather than a flag on it, because the two are
 * different authorities and collapsing them is how a product ends up with a
 * technician able to clear their own week.
 */
export async function approve(
  ctx: ServiceContext, input: { id: string },
): Promise<TimeOffView> {
  return guardedWrite(ctx, "timesheet:approve", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id, peopleInScope(ctx));
    if (before.deletedAt !== null) {
      throw new ConflictError(
        "That request was declined. Approving it would make a day the board refuses work on "
        + "out of a decision somebody already took the other way. Ask for it again instead.",
      );
    }
    if (before.approved) return viewOf(before);

    /**
     * Re-checked here, not only at request time.
     *
     * A request is checked against what was approved when it was made, and
     * two people can request the same week before either is granted. Without
     * this the second approval creates the overlap the request-time check
     * exists to prevent, and the board then shows one technician off twice.
     */
    await assertNoOverlap(
      tx, ctx.actor.organizationId, before.technicianId,
      before.startsAt, before.endsAt, before.id,
      /**
       * APPROVED ROWS ONLY, which is the difference between the two callers
       * and a bug a test caught.
       *
       * The first version of this used the same rule as `request`, which also
       * refuses an overlap with another REQUEST. Approving the first of two
       * overlapping requests then failed, because the second one was sitting
       * there unanswered: the approver could not grant either, and the error
       * blamed the row they were trying to approve.
       *
       * Another pending request is not a claim on a day. The first approval
       * wins and the second is refused, which is what this check is for.
       */
      "approved_only",
    );

    const [row] = await tx.update(schema.timeOff)
      .set({ approved: true, updatedAt: new Date() })
      .where(and(
        eq(schema.timeOff.organizationId, ctx.actor.organizationId),
        eq(schema.timeOff.id, input.id),
      )).returning();

    await audit(tx, ctx, "time_off.approved", "time_off", input.id, before, row!);
    return viewOf(row!);
  });
}

/**
 * Turn it down, or take an approval back.
 *
 * One operation for both, because the effect on the board is the same and the
 * difference is only which state it was in. The reason is required when an
 * approval is being revoked: somebody has already arranged their week around
 * it, and "declined" with no sentence is a conversation nobody can have.
 */
export async function decline(
  ctx: ServiceContext, input: { id: string; reason?: string | null | undefined },
): Promise<TimeOffView> {
  return guardedWrite(ctx, "timesheet:approve", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id, peopleInScope(ctx));
    if (before.deletedAt !== null) return viewOf(before);

    const reason = input.reason?.trim() || null;
    if (before.approved && reason === null) {
      throw new ConflictError(
        "Taking back an approval needs a reason. Somebody has arranged their week around "
        + "this one.",
      );
    }

    const [row] = await tx.update(schema.timeOff).set({
      approved: false,
      /**
       * SOFT DELETED RATHER THAN REMOVED, and `reason` carries why.
       *
       * The row is the record that somebody asked, which outlives the answer:
       * "did I put in for that week" is a question people ask months later,
       * and a deleted row answers it with silence. Every reader of this table
       * filters on `deleted_at`, so a declined request stops affecting the
       * board the moment this commits.
       */
      deletedAt: new Date(),
      ...(reason === null ? {} : { reason }),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.timeOff.organizationId, ctx.actor.organizationId),
      eq(schema.timeOff.id, input.id),
    )).returning();

    await audit(tx, ctx, "time_off.declined", "time_off", input.id, before, row!);
    return viewOf(row!);
  });
}

/**
 * Withdraw your own request.
 *
 * Only your own, and only while it is still a request. Once it is approved
 * the board has been drawn around it and a dispatcher may have moved work, so
 * taking it back is `decline` and needs the authority that granted it.
 */
export async function withdraw(
  ctx: ServiceContext, input: { id: string },
): Promise<TimeOffView> {
  return guardedWrite(ctx, "timeclock:own", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    const own = await ownTechnician(tx, ctx.actor.organizationId, ctx.actor.userId);
    if (before.technicianId !== own) {
      throw new ConflictError("That is somebody else's time off request.");
    }
    if (before.deletedAt !== null) return viewOf(before);
    if (before.approved) {
      throw new ConflictError(
        "That one is already approved, and the board has been drawn around it. Ask whoever "
        + "approved it to take it back.",
      );
    }

    const [row] = await tx.update(schema.timeOff)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.timeOff.organizationId, ctx.actor.organizationId),
        eq(schema.timeOff.id, input.id),
      )).returning();

    await audit(tx, ctx, "time_off.withdrawn", "time_off", input.id, before, row!);
    return viewOf(row!);
  });
}

export interface TimeOffQuery {
  technicianId?: string | undefined;
  /** Anything overlapping this window. Both ends inclusive, as the board is. */
  from?: string | undefined;
  to?: string | undefined;
  /** Requests nobody has answered, which is the queue an approver works. */
  pendingOnly?: boolean | undefined;
  /** Declined and withdrawn rows too, which are off by default. */
  includeDeclined?: boolean | undefined;
}

export async function list(ctx: ServiceContext, input: TimeOffQuery): Promise<TimeOffView[]> {
  /**
   * Reading your own needs no permission over anybody else, and reading
   * somebody else's is `timesheet:read`. Resolved the same way `request`
   * resolves its write permission, for the same reason.
   */
  const own = input.technicianId === undefined;
  return guardedRead(ctx, own ? "timeclock:own" : "timesheet:read", async (tx) => {
    const technicianId = input.technicianId
      ?? await ownTechnician(tx, ctx.actor.organizationId, ctx.actor.userId);
    if (!own) await assertInScope(tx, ctx, technicianId);

    const rows = await tx.select({
      id: schema.timeOff.id,
      organizationId: schema.timeOff.organizationId,
      technicianId: schema.timeOff.technicianId,
      startsAt: schema.timeOff.startsAt,
      endsAt: schema.timeOff.endsAt,
      reason: schema.timeOff.reason,
      approved: schema.timeOff.approved,
      createdAt: schema.timeOff.createdAt,
      updatedAt: schema.timeOff.updatedAt,
      deletedAt: schema.timeOff.deletedAt,
      technicianName: schema.technician.displayName,
    }).from(schema.timeOff)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.timeOff.technicianId))
      .where(and(
        eq(schema.timeOff.organizationId, ctx.actor.organizationId),
        eq(schema.timeOff.technicianId, technicianId),
        input.includeDeclined ? undefined : isNull(schema.timeOff.deletedAt),
        input.pendingOnly ? eq(schema.timeOff.approved, false) : undefined,
        /**
         * OVERLAP, NOT CONTAINMENT. A fortnight's leave that starts before
         * the window and ends after it covers every day in it and is
         * contained by nothing, so a containment filter would leave the board
         * showing that technician as available all week.
         */
        input.to ? lte(schema.timeOff.startsAt, new Date(input.to)) : undefined,
        input.from ? gte(schema.timeOff.endsAt, new Date(input.from)) : undefined,
      ))
      .orderBy(asc(schema.timeOff.startsAt));

    return rows.map(viewOf);
  });
}

/**
 * The approver's queue: every unanswered request in the company.
 *
 * A separate function rather than `list` with no technician, because the two
 * are different questions with different permissions, and because this one
 * has to cross technicians while `list` is deliberately about one person.
 */
export async function pending(ctx: ServiceContext): Promise<TimeOffView[]> {
  return guardedRead(ctx, "timesheet:approve", async (tx) => {
    const rows = await tx.select({
      id: schema.timeOff.id,
      organizationId: schema.timeOff.organizationId,
      technicianId: schema.timeOff.technicianId,
      startsAt: schema.timeOff.startsAt,
      endsAt: schema.timeOff.endsAt,
      reason: schema.timeOff.reason,
      approved: schema.timeOff.approved,
      createdAt: schema.timeOff.createdAt,
      updatedAt: schema.timeOff.updatedAt,
      deletedAt: schema.timeOff.deletedAt,
      technicianName: schema.technician.displayName,
    }).from(schema.timeOff)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.timeOff.technicianId))
      .where(and(
        eq(schema.timeOff.organizationId, ctx.actor.organizationId),
        eq(schema.timeOff.approved, false),
        isNull(schema.timeOff.deletedAt),
        peopleInScope(ctx),
      ))
      .orderBy(asc(schema.timeOff.startsAt));
    return rows.map(viewOf);
  });
}

/**
 * Approved time off still to come or under way, for the people this person
 * may answer for: what the board will show as away, and what an approval can
 * still be taken back from.
 */
export async function upcoming(ctx: ServiceContext): Promise<TimeOffView[]> {
  return guardedRead(ctx, "timesheet:read", async (tx) => {
    const rows = await tx.select({
      id: schema.timeOff.id,
      organizationId: schema.timeOff.organizationId,
      technicianId: schema.timeOff.technicianId,
      startsAt: schema.timeOff.startsAt,
      endsAt: schema.timeOff.endsAt,
      reason: schema.timeOff.reason,
      approved: schema.timeOff.approved,
      createdAt: schema.timeOff.createdAt,
      updatedAt: schema.timeOff.updatedAt,
      deletedAt: schema.timeOff.deletedAt,
      technicianName: schema.technician.displayName,
    }).from(schema.timeOff)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.timeOff.technicianId))
      .where(and(
        eq(schema.timeOff.organizationId, ctx.actor.organizationId),
        eq(schema.timeOff.approved, true),
        isNull(schema.timeOff.deletedAt),
        gte(schema.timeOff.endsAt, new Date()),
        peopleInScope(ctx),
      ))
      .orderBy(asc(schema.timeOff.startsAt));
    return rows.map(viewOf);
  });
}

/* ---------------------------------------------------------------- guards */

async function load(tx: Database, organizationId: string, id: string, scope?: ReturnType<typeof peopleInScope>) {
  const [row] = await tx.select().from(schema.timeOff)
    .where(and(
      eq(schema.timeOff.organizationId, organizationId),
      eq(schema.timeOff.id, id),
      scope,
    ));
  if (!row) throw new NotFoundError("Time off request");
  return row;
}

/** Somebody else's time off, only for a person this one may answer for. */
async function assertInScope(tx: Database, ctx: ServiceContext, technicianId: string): Promise<void> {
  const people = technicianScopeFilter(scopeOf(ctx, "timesheet"), ctx.actor);
  if (people === undefined) return;
  const [row] = await tx.select({ id: schema.technician.id }).from(schema.technician)
    .where(and(eq(schema.technician.id, technicianId), people)).limit(1);
  if (!row) throw new NotFoundError("Technician");
}

async function assertTechnician(
  tx: Database, organizationId: string, technicianId: string,
): Promise<void> {
  const [row] = await tx.select({ id: schema.technician.id }).from(schema.technician)
    .where(and(
      eq(schema.technician.organizationId, organizationId),
      eq(schema.technician.id, technicianId),
    ));
  if (!row) throw new NotFoundError("Technician");
}

/**
 * The window, validated, as instants.
 *
 * STORED AS INSTANTS AND NOT AS DATES, which is the column's decision rather
 * than this function's, and it is the right one: leave is half a Friday
 * afternoon as often as it is a fortnight, and a date column cannot say so.
 * What it costs is that the caller has to mean a real instant, so an inverted
 * window is refused here rather than producing a row the board reads as
 * covering nothing.
 */
function window(startsAt: string, endsAt: string): { startsAt: Date; endsAt: Date } {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new ConflictError("Time off needs a start and an end this platform can read as times.");
  }
  if (end.getTime() <= start.getTime()) {
    throw new ConflictError(
      "Time off has to end after it starts. A window that does not is a row the board reads "
      + "as covering no days at all.",
    );
  }
  return { startsAt: start, endsAt: end };
}

/**
 * ONE TECHNICIAN IS NOT OFF TWICE OVER THE SAME HOUR.
 *
 * Two overlapping rows are not merely untidy. `services/crews.ts` counts who
 * is away by collecting technician ids from overlapping rows into a Set, so a
 * duplicate is absorbed there and the headcount is right. `services/dispatch.ts`
 * draws a column per row, so the same technician appears off twice on the same
 * morning, and a dispatcher reading that cannot tell whether it is one absence
 * or two people.
 *
 * TWO CALLERS, TWO RULES, and collapsing them was a bug.
 *
 * `request` checks against approvals AND other requests, so one person
 * cannot queue two overlapping asks for the same week.
 *
 * `approve` checks against approvals ONLY. Another pending request is not a
 * claim on a day: with the stricter rule, two overlapping requests left the
 * approver unable to grant either, and the error named the row they were
 * trying to approve rather than the one in the way.
 *
 * Declined and withdrawn rows are excluded from both, because those are
 * history rather than claims.
 */
async function assertNoOverlap(
  tx: Database, organizationId: string, technicianId: string,
  startsAt: Date, endsAt: Date, exceptId: string | null,
  against: "approved_only" | "approved_or_requested" = "approved_or_requested",
): Promise<void> {
  const clash = await tx.select({
    id: schema.timeOff.id,
    startsAt: schema.timeOff.startsAt,
    endsAt: schema.timeOff.endsAt,
    approved: schema.timeOff.approved,
  }).from(schema.timeOff)
    .where(and(
      eq(schema.timeOff.organizationId, organizationId),
      eq(schema.timeOff.technicianId, technicianId),
      isNull(schema.timeOff.deletedAt),
      against === "approved_only" ? eq(schema.timeOff.approved, true) : undefined,
      exceptId === null ? undefined : ne(schema.timeOff.id, exceptId),
      lte(schema.timeOff.startsAt, endsAt),
      gte(schema.timeOff.endsAt, startsAt),
    ));

  const first = clash[0];
  if (first) {
    throw new ConflictError(
      `This overlaps time off already ${first.approved ? "approved" : "requested"} from `
      + `${first.startsAt.toISOString()} to ${first.endsAt.toISOString()}. Two overlapping `
      + "rows put the same technician on the board as away twice, and nobody reading it can "
      + "tell whether that is one absence or two people.",
    );
  }
}

/**
 * Who is away, for a caller already inside a transaction.
 *
 * Exported for the board and the crew gate, which both do this query
 * themselves today. Neither is changed by this module: they are correct, and
 * rewriting a working read to route through a new function would be a change
 * with no property behind it. This exists so the next caller does not write
 * a fourth copy, and the three can be collapsed deliberately rather than by
 * accident.
 */
export async function awayBetween(
  tx: Database, organizationId: string, from: Date, to: Date,
  technicianIds?: string[],
): Promise<Set<string>> {
  if (technicianIds?.length === 0) return new Set();
  const rows = await tx.select({ technicianId: schema.timeOff.technicianId })
    .from(schema.timeOff)
    .where(and(
      eq(schema.timeOff.organizationId, organizationId),
      eq(schema.timeOff.approved, true),
      isNull(schema.timeOff.deletedAt),
      technicianIds ? inArray(schema.timeOff.technicianId, technicianIds) : undefined,
      lte(schema.timeOff.startsAt, to),
      gte(schema.timeOff.endsAt, from),
    ));
  return new Set(rows.map((row) => row.technicianId));
}

/* -------------------------------------------------------------- handlers */

export const handlers = {
  requestTimeOff: (ctx: ServiceContext, input: TimeOffInput): Promise<TimeOffView> =>
    request(ctx, input),
  approveTimeOff: (ctx: ServiceContext, input: { id: string }): Promise<TimeOffView> =>
    approve(ctx, input),
  declineTimeOff: (
    ctx: ServiceContext, input: { id: string; reason?: string | null | undefined },
  ): Promise<TimeOffView> => decline(ctx, input),
  withdrawTimeOff: (ctx: ServiceContext, input: { id: string }): Promise<TimeOffView> =>
    withdraw(ctx, input),
  listTimeOff: async (ctx: ServiceContext, input: TimeOffQuery): Promise<{ timeOff: TimeOffView[] }> =>
    ({ timeOff: await list(ctx, input) }),
  pendingTimeOff: async (ctx: ServiceContext): Promise<{ timeOff: TimeOffView[] }> =>
    ({ timeOff: await pending(ctx) }),
  upcomingTimeOff: async (ctx: ServiceContext): Promise<{ timeOff: TimeOffView[] }> =>
    ({ timeOff: await upcoming(ctx) }),
} as const;
