import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { reporting } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, ConflictError, NotFoundError, UnprocessableError,
  type ServiceContext,
} from "./context";
import { jobScopeFilter } from "./scope";
import { announce, sideOf } from "./visit-notices";
import { remember, replayed } from "./once";

/**
 * WHO CALLED A VISIT OFF, AND WHEN THEY ASKED
 *
 * Cleaning's cancellation rate is "stops cancelled or skipped inside the
 * notice window divided by stops scheduled" and EXCLUDES "visits the company
 * cancelled for weather or staffing, which are a separate and more serious
 * number". A cancelled visit said neither who nor when: a customer ringing the
 * office at seven in the morning and the owner calling off a rained out day
 * were the same row, and a visit kept no time it was cancelled at all.
 *
 * Every path that cancels a visit now goes through here and says both:
 *
 *   the office calling off one visit (`cancel`, below), saying who asked;
 *   the office cancelling a job with its visits still to come (the jobs
 *   service), saying who asked;
 *   the office approving a customer's own request from their link, which is
 *   the customer, asked when they sent it (`visit-changes.ts`);
 *   a visit brought in from history as cancelled, which says who when the
 *   old system did and is left as not known when it did not.
 *
 * `visit-cancellation-paths.test.ts` reads the source and fails when a new
 * path writes a cancelled visit without saying who, and the database refuses
 * a visit that names who without saying when and under what notice window.
 *
 * WHEN is when the customer told us, not when the row changed: a customer who
 * left a message at six for a nine o'clock clean cancelled at six, whenever
 * the office got to it. The office may say so, never later than now and never
 * before the visit was booked. The company's notice window is frozen onto the
 * visit at the same moment, so changing the policy later does not move last
 * season's figure.
 */

export type CancelledBy = "customer" | "company";

/** The words an owner reads for each. */
export const CANCELLED_BY_WORDS: Record<CancelledBy, string> = {
  customer: "The customer asked",
  company: "We called it off",
};

/** What the office may still call off: nobody has started it. On the way is included, because a customer who rings while the van is out is still cancelling. */
const CALLABLE_OFF = ["unassigned", "scheduled", "dispatched", "en_route"] as const;

/** A little give for a phone or a browser whose clock runs ahead. */
const CLOCK_GIVE_MS = 2 * 60_000;

/** The company's notice window, in hours. */
export async function noticeHoursOf(tx: Database, organizationId: string): Promise<number> {
  const [org] = await tx.select({ hours: schema.organization.cancelNoticeHours })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  return org?.hours ?? 24;
}

/**
 * The columns a cancelled visit carries: who, when they asked, and the notice
 * window in force. Spread into every write that makes a visit cancelled, which
 * is what the guard test looks for.
 */
export async function calledOffFields(
  tx: Database, organizationId: string, input: { by: CancelledBy; askedAt: Date } | null,
): Promise<{ cancelledBy: CancelledBy | null; cancelledAt: Date | null; cancelNoticeHours: number | null }> {
  /**
   * NOBODY SAID, written as nobody said. A caller of the API that cancels a
   * job's visits without saying who asked, or a history row that did not
   * say, is recorded as not known rather than given a default: the figure
   * counts those beside the number, and a default would put them in it.
   */
  if (input === null) return { cancelledBy: null, cancelledAt: null, cancelNoticeHours: null };
  return { cancelledBy: input.by, cancelledAt: input.askedAt, cancelNoticeHours: await noticeHoursOf(tx, organizationId) };
}

/**
 * Make a visit cancelled, saying who and when. The row only: telling the
 * people on it, and closing anything waiting on it, is the caller's, because
 * each caller already does it its own way (a customer's request is answered,
 * a job's visits are told together).
 */
export async function callOff(
  tx: Database, ctx: ServiceContext, visitId: string, input: { by: CancelledBy; askedAt: Date } | null,
): Promise<void> {
  await tx.update(schema.visit).set({
    status: "cancelled",
    routeOrder: null,
    ...(await calledOffFields(tx, ctx.actor.organizationId, input)),
    updatedAt: new Date(),
  }).where(eq(schema.visit.id, visitId));
}

/**
 * When the customer asked, as the office said it, checked: never in the
 * future, and never before the visit existed to be cancelled.
 */
export function askedAtOf(askedAt: string | undefined, bookedAt: Date, now = new Date()): Date {
  if (askedAt === undefined) return now;
  const at = new Date(askedAt);
  if (Number.isNaN(at.getTime())) {
    throw new UnprocessableError("That is not a time", [{ path: "askedAt", message: "Send when they asked as a date and time." }]);
  }
  if (at.getTime() > now.getTime() + CLOCK_GIVE_MS) {
    throw new ConflictError("That time has not happened yet. Say when they asked, or leave it for now.");
  }
  if (at.getTime() < bookedAt.getTime()) {
    throw new ConflictError("That is before the visit was booked, so nobody could have cancelled it then.");
  }
  return at;
}

/**
 * Close a customer's request still waiting on a visit the office has called
 * off, so nobody approves a move of a visit that is no longer happening.
 */
export async function supersedeRequests(tx: Database, ctx: ServiceContext, visitId: string, outcome: string): Promise<void> {
  const now = new Date();
  const overtaken = await tx.update(schema.visitChangeRequest).set({
    status: "superseded", decidedAt: now, updatedAt: now, decidedByUserId: ctx.actor.userId,
  }).where(and(
    eq(schema.visitChangeRequest.visitId, visitId),
    inArray(schema.visitChangeRequest.status, ["pending", "proposed"]),
  )).returning({ taskId: schema.visitChangeRequest.taskId });
  for (const request of overtaken) {
    if (!request.taskId) continue;
    await tx.update(schema.task).set({
      status: "done", outcome, completedAt: now, completedByUserId: ctx.actor.userId, updatedAt: now,
    }).where(and(eq(schema.task.id, request.taskId), isNull(schema.task.completedAt)));
  }
}

export interface CancelledVisit {
  id: string;
  status: string;
  cancelledBy: CancelledBy;
  cancelledAt: string;
  cancelNoticeHours: number;
  /** Whether it counts as a late cancellation: the customer, with less notice than the window. Null with no window. */
  late: boolean | null;
}

const shape = (visit: typeof schema.visit.$inferSelect): CancelledVisit => {
  const verdict = reporting.cancellationOf({
    status: visit.status, windowStart: visit.windowStart, cancelledBy: visit.cancelledBy,
    cancelledAt: visit.cancelledAt, noticeHours: visit.cancelNoticeHours,
  });
  return {
    id: visit.id,
    status: visit.status,
    cancelledBy: visit.cancelledBy!,
    cancelledAt: visit.cancelledAt!.toISOString(),
    cancelNoticeHours: visit.cancelNoticeHours!,
    late: verdict === null ? null : verdict === "late",
  };
};

/**
 * THE OFFICE CALLS OFF ONE VISIT.
 *
 * Saying who asked is required, because that is the whole difference between
 * a customer's late cancellation and a rain day, and a default would decide it
 * for whoever is in a hurry. Needs what moving or cancelling a visit needs
 * anywhere else (`visit:reschedule`), on a job the person can see.
 *
 * Only a visit nobody has started: on the way is allowed (the customer rang
 * while the van was out, which is the latest cancellation there is), and the
 * person on it is told not to go. One being worked, or done, is the person on
 * it to talk to.
 */
export async function cancel(
  ctx: ServiceContext, input: { id: string; by: CancelledBy; askedAt?: string | undefined },
): Promise<CancelledVisit> {
  return guardedWrite(ctx, "visit:reschedule", async (tx) => {
    const again = await replayed<CancelledVisit>(tx, ctx, "visit_cancel");
    if (again) return again;

    const [found] = await tx.select({ visit: schema.visit }).from(schema.visit)
      .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
      .where(and(
        eq(schema.visit.id, input.id),
        isNull(schema.job.deletedAt),
        jobScopeFilter(scopeOf(ctx, "job"), ctx.actor),
      )).limit(1);
    if (!found) throw new NotFoundError("Visit");
    const { visit } = found;
    if (visit.status === "cancelled") throw new ConflictError("That visit is already cancelled.");
    if (!(CALLABLE_OFF as readonly string[]).includes(visit.status)) {
      throw new ConflictError(
        `This visit is ${visit.status.replace(/_/g, " ")}, so it cannot be called off from here. Talk to whoever is on it.`,
      );
    }

    const askedAt = askedAtOf(input.askedAt, visit.createdAt);
    const before = await sideOf(tx, visit.id);
    await callOff(tx, ctx, visit.id, { by: input.by, askedAt });
    if (before) await announce(tx, ctx, visit.id, before);
    await supersedeRequests(tx, ctx, visit.id, "Overtaken: the office cancelled the visit");

    const [after] = await tx.select().from(schema.visit).where(eq(schema.visit.id, visit.id)).limit(1);
    const answer = shape(after!);
    await audit(tx, ctx, "visit.called_off", "visit", visit.id,
      { status: visit.status },
      { status: "cancelled", cancelledBy: answer.cancelledBy, cancelledAt: answer.cancelledAt, cancelNoticeHours: answer.cancelNoticeHours });
    await remember(tx, ctx, "visit_cancel", visit.id, answer);
    return answer;
  });
}

/* ------------------------------------------------------- the notice window */

/** The longest notice window a company may set: a month. */
const MOST_NOTICE_HOURS = 720;

export function notice(ctx: ServiceContext): Promise<{ hours: number }> {
  return guardedRead(ctx, "settings:read", async (tx) => ({ hours: await noticeHoursOf(tx, ctx.actor.organizationId) }));
}

/**
 * How much notice the company asks a customer to give. Changing it changes
 * which cancellations from now on are late; every visit already called off
 * keeps the window it was called off under.
 */
export function setNotice(ctx: ServiceContext, input: { hours: number }): Promise<{ hours: number }> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    if (!Number.isInteger(input.hours) || input.hours < 0 || input.hours > MOST_NOTICE_HOURS) {
      throw new ConflictError("Give the notice in whole hours, from none to a month (720).");
    }
    const before = await noticeHoursOf(tx, ctx.actor.organizationId);
    await tx.update(schema.organization).set({ cancelNoticeHours: input.hours, updatedAt: new Date() })
      .where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "organization.cancel_notice_set", "organization", ctx.actor.organizationId,
      { hours: before }, { hours: input.hours });
    return { hours: input.hours };
  });
}

export const handlers = {
  cancelVisit: (ctx: ServiceContext, input: { id: string; by: CancelledBy; askedAt?: string | undefined }) =>
    cancel(ctx, input),
  getCancellationNotice: (ctx: ServiceContext) => notice(ctx),
  setCancellationNotice: (ctx: ServiceContext, input: { hours: number }) => setNotice(ctx, input),
} as const;
