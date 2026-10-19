import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, assertCan, can, time, work, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, scopeOf, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { jobScopeFilter } from "./scope";
import { canTransition } from "./jobs";
import { emit } from "./events";
import * as plugins from "./plugins";
import { remember, replayed } from "./once";

/**
 * WHY A JOB IS ON HOLD, AS A RECORD
 *
 * `on_hold` was a status a job could be moved to with nothing saying why, so a
 * job waiting on a compressor and one waiting on the customer looked the same,
 * and the plumbing and electrical first time fix rates, which leave out "jobs
 * held for a part order" (and for an electrician "or an inspection"), had
 * nothing to read. A hold now has a reason from a fixed list, a part hold
 * names the purchase order the part is on, and taking the job off hold puts it
 * back where it was.
 *
 * Placed and lifted by whoever may change a job (`job:write`), which is the
 * office: a technician who needs a part says so, and the person who orders it
 * is the person who can say what it is on. Naming an order needs `po:read` as
 * well, because the hold shows its number.
 *
 * A job moved off hold by an ordinary status change (the jobs service's
 * update, or a connected application) closes its hold too, so a hold is never
 * left open on a job that is no longer waiting.
 */

export interface HoldView {
  id: string;
  jobId: string;
  reason: work.HoldReason;
  reasonLabel: string;
  purchaseOrderId: string | null;
  purchaseOrderNumber: number | null;
  /** The order's status today, so a screen can say "not sent yet" beside a part hold. */
  purchaseOrderStatus: string | null;
  note: string | null;
  statusBefore: string;
  placedAt: string;
  placedByName: string | null;
  releasedAt: string | null;
}

async function loadJob(tx: Database, ctx: ServiceContext, jobId: string) {
  const [job] = await tx.select().from(schema.job)
    .where(and(
      eq(schema.job.id, jobId),
      isNull(schema.job.deletedAt),
      jobScopeFilter(scopeOf(ctx, "job"), ctx.actor),
    )).limit(1);
  if (!job) throw new NotFoundError("Job");
  return job;
}

async function viewsOf(tx: Database, jobId: string): Promise<HoldView[]> {
  const rows = await tx.select({
    hold: schema.jobHold,
    orderNumber: schema.purchaseOrder.number,
    orderStatus: schema.purchaseOrder.status,
    placedByName: schema.user.name,
  }).from(schema.jobHold)
    .leftJoin(schema.purchaseOrder, eq(schema.purchaseOrder.id, schema.jobHold.purchaseOrderId))
    .leftJoin(schema.user, eq(schema.user.id, schema.jobHold.placedByUserId))
    .where(eq(schema.jobHold.jobId, jobId))
    .orderBy(asc(schema.jobHold.placedAt));
  return rows.map(({ hold, orderNumber, orderStatus, placedByName }) => ({
    id: hold.id,
    jobId: hold.jobId,
    reason: hold.reason,
    reasonLabel: work.holdReasonLabel(hold.reason),
    purchaseOrderId: hold.purchaseOrderId,
    purchaseOrderNumber: orderNumber ?? null,
    purchaseOrderStatus: orderStatus ?? null,
    note: hold.note,
    statusBefore: hold.statusBefore,
    placedAt: hold.placedAt.toISOString(),
    placedByName: placedByName ?? null,
    releasedAt: hold.releasedAt?.toISOString() ?? null,
  }));
}

/** Every hold the job has had, oldest first; the open one has no `releasedAt`. */
export function holdsOf(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "job:read", async (tx) => {
    await loadJob(tx, ctx, input.id);
    const holds = await viewsOf(tx, input.id);
    /** The order's number is purchasing's to show. Somebody who may not read orders sees that one was named. */
    const orders = can(ctx.actor, "po:read");
    return {
      data: holds.map((hold) => orders ? hold : { ...hold, purchaseOrderNumber: null, purchaseOrderStatus: null }),
    };
  });
}

/**
 * Put a job on hold, saying why.
 *
 * From where a job may go on hold (booked or under way), or onto a job already
 * moved to on hold by a plain status change that never said why, which is how
 * one from before reasons existed gets its reason. A job already held for a
 * reason is refused: take it off hold first, so the record says the reason
 * changed rather than being overwritten.
 */
export function place(
  ctx: ServiceContext,
  input: { id: string; reason: work.HoldReason; purchaseOrderId?: string | undefined; note?: string | undefined },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const again = await replayed<{ data: HoldView[] }>(tx, ctx, "job_hold");
    if (again) return again;

    const job = await loadJob(tx, ctx, input.id);
    const refusal = work.holdRefusal(input);
    if (refusal) throw new ConflictError(refusal);

    const [open] = await tx.select({ id: schema.jobHold.id, reason: schema.jobHold.reason })
      .from(schema.jobHold)
      .where(and(eq(schema.jobHold.jobId, input.id), isNull(schema.jobHold.releasedAt))).limit(1);
    if (open) {
      throw new ConflictError(
        `This job is already on hold: ${work.holdReasonLabel(open.reason).toLowerCase()}. Take it off hold first to give another reason.`,
      );
    }
    if (job.status !== "on_hold" && !canTransition(job.status, "on_hold")) {
      throw new ConflictError(`A job that is "${job.status}" cannot go on hold. Only a booked job, or one under way, can.`);
    }

    if (input.purchaseOrderId) {
      assertCan(ctx.actor, "po:read");
      const [order] = await tx.select({ status: schema.purchaseOrder.status }).from(schema.purchaseOrder)
        .where(and(eq(schema.purchaseOrder.id, input.purchaseOrderId), isNull(schema.purchaseOrder.deletedAt))).limit(1);
      if (!order) throw new NotFoundError("Purchase order");
      if (order.status === "cancelled") {
        throw new ConflictError("That purchase order was cancelled, so no part is coming on it. Name the order the part is on.");
      }
    }

    /**
     * A job held for a status move it was already in is not a move, so the
     * workflow's gates are only asked about a real one.
     */
    if (job.status !== "on_hold") {
      await plugins.assertMoveWithin(tx, ctx, job, "on_hold", job.customFields);
    }

    /**
     * The status it goes back to. A job moved to on hold before holds had
     * reasons left no record of where it was, so it goes back to booked,
     * which is the earliest status a hold can be placed from and the one that
     * leaves it on the board.
     */
    const statusBefore = job.status === "on_hold" ? "scheduled" : job.status;
    const [hold] = await tx.insert(schema.jobHold).values({
      organizationId: ctx.actor.organizationId,
      jobId: input.id,
      reason: input.reason,
      purchaseOrderId: input.purchaseOrderId ?? null,
      note: input.note?.trim() || null,
      statusBefore,
      placedByUserId: ctx.actor.userId,
    }).returning();

    if (job.status !== "on_hold") {
      const [after] = await tx.update(schema.job).set({ status: "on_hold", updatedAt: new Date() })
        .where(eq(schema.job.id, input.id)).returning();
      await audit(tx, ctx, "job.updated", "job", input.id, job, after!);
      await emit(tx, ctx, {
        name: "job.updated", entityType: "job", entityId: input.id, payload: { job: after! }, previous: { job },
      });
      await emit(tx, ctx, {
        name: "job.on_hold", entityType: "job", entityId: input.id, payload: { job: after! }, previous: { job },
      });
    }
    await audit(tx, ctx, "job.held", "job_hold", hold!.id, null, hold!);

    const answer = { data: await viewsOf(tx, input.id) };
    await remember(tx, ctx, "job_hold", hold!.id, answer);
    return answer;
  });
}

/**
 * The nudge a hold raised goes with the hold. Done, not dismissed: the wait it
 * was about is over, and nobody decided the work was not worth raising. A task
 * somebody already finished or dismissed is left as they left it.
 */
async function closeNudge(tx: Database, ctx: ServiceContext, taskId: string | null): Promise<void> {
  if (!taskId) return;
  const now = new Date();
  await tx.update(schema.task).set({
    status: "done",
    outcome: "The job came off hold.",
    completedAt: now,
    completedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    updatedAt: now,
  }).where(and(eq(schema.task.id, taskId), inArray(schema.task.status, ["open", "in_progress"])));
}

/**
 * Take a job off hold: the hold is closed and the job goes back to the status
 * it was held from. A job somebody already moved on (cancelled, or back on the
 * board by a status change) only has its hold closed.
 */
export function release(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const again = await replayed<{ data: HoldView[] }>(tx, ctx, "job_hold_release");
    if (again) return again;

    const [hold] = await tx.select().from(schema.jobHold).where(eq(schema.jobHold.id, input.id)).limit(1);
    if (!hold) throw new NotFoundError("Hold");
    const job = await loadJob(tx, ctx, hold.jobId);
    if (hold.releasedAt) throw new ConflictError("This job has already been taken off that hold.");

    if (job.status === "on_hold") {
      if (!canTransition("on_hold", hold.statusBefore)) {
        throw new ConflictError(`A job on hold cannot go back to "${hold.statusBefore}".`);
      }
      await plugins.assertMoveWithin(tx, ctx, job, hold.statusBefore, job.customFields);
      const [after] = await tx.update(schema.job).set({ status: hold.statusBefore, updatedAt: new Date() })
        .where(eq(schema.job.id, job.id)).returning();
      await audit(tx, ctx, "job.updated", "job", job.id, job, after!);
      await emit(tx, ctx, {
        name: "job.updated", entityType: "job", entityId: job.id, payload: { job: after! }, previous: { job },
      });
      await emit(tx, ctx, {
        name: `job.${hold.statusBefore}` as const, entityType: "job", entityId: job.id,
        payload: { job: after! }, previous: { job },
      });
    }

    const [closed] = await tx.update(schema.jobHold).set({
      releasedAt: new Date(), releasedByUserId: ctx.actor.userId, updatedAt: new Date(),
    }).where(eq(schema.jobHold.id, hold.id)).returning();
    await closeNudge(tx, ctx, hold.nudgeTaskId);
    await audit(tx, ctx, "job.hold_released", "job_hold", hold.id, hold, closed!);

    const answer = { data: await viewsOf(tx, job.id) };
    await remember(tx, ctx, "job_hold_release", hold.id, answer);
    return answer;
  });
}

/**
 * Close a job's open hold because it was moved off hold some other way: an
 * ordinary status change. Inside that change's transaction, so the two cannot
 * disagree.
 */
export async function closeOpenHold(tx: Database, ctx: ServiceContext, jobId: string): Promise<void> {
  const [open] = await tx.select().from(schema.jobHold)
    .where(and(eq(schema.jobHold.jobId, jobId), isNull(schema.jobHold.releasedAt))).limit(1);
  if (!open) return;
  const [closed] = await tx.update(schema.jobHold).set({
    releasedAt: new Date(), releasedByUserId: ctx.actor.userId, updatedAt: new Date(),
  }).where(eq(schema.jobHold.id, open.id)).returning();
  await closeNudge(tx, ctx, open.nudgeTaskId);
  await audit(tx, ctx, "job.hold_released", "job_hold", open.id, open, closed!);
}

/* ------------------------------------------------- a job left on hold too long */

/**
 * HOW LONG A JOB MAY WAIT BEFORE THE OFFICE IS NUDGED
 *
 * Kept in `organization.settings.holdNudge.days`, beside the company's other
 * rules, and OFF until a company turns it on: a number of days that suits a
 * roofer waiting on weather is wrong for a plumber waiting on a part, and
 * guessing one would fill the queue of every company that never asked.
 *
 * When a hold has lasted that many of the company's calendar days the worker
 * raises ONE task in the office queue (`/tasks`, queue "office", about the
 * job) saying which job, why it is held and how long. One per hold, decided
 * by the hold's own `nudged_at`, claimed in the transaction that writes the
 * task: a pass cut short and run again, or two workers at once, raise it once.
 * Ending the hold closes the task, by taking the job off hold, or by any
 * ordinary status change that moves it on. A task somebody closed by hand is
 * not raised again for the same hold; the next hold on the job is a new one.
 */
export async function nudgeDaysWithin(tx: Database, organizationId: string): Promise<number | null> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const saved = ((row?.settings ?? {}) as Record<string, unknown>)["holdNudge"] as { days?: unknown } | undefined;
  return work.holdNudgeDays(saved?.days);
}

export function nudgeSetting(ctx: ServiceContext): Promise<{ days: number | null }> {
  return guardedRead(ctx, "settings:read", async (tx) => ({ days: await nudgeDaysWithin(tx, ctx.actor.organizationId) }));
}

/**
 * Turn the nudge on for so many days, or off with null. Changing it changes
 * what the worker raises from the next pass: holds already past the new number
 * are nudged then, tasks already raised stay where they are.
 */
export function setNudge(ctx: ServiceContext, input: { days: number | null }): Promise<{ days: number | null }> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const problem = work.holdNudgeProblem(input.days);
    if (problem) throw new ConflictError(problem);
    const before = await nudgeDaysWithin(tx, ctx.actor.organizationId);
    await tx.update(schema.organization).set({
      settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ holdNudge: { days: input.days } })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "organization.hold_nudge_set", "organization", ctx.actor.organizationId,
      { days: before }, { days: input.days });
    return { days: input.days };
  });
}

/** The most one pass raises for one company; the rest wait for the next pass. */
const NUDGES_PER_PASS = 200;

/**
 * Raise the nudges that are due for the company this transaction belongs to.
 * Returns the jobs it raised one for.
 */
export async function nudgesIn(tx: Database, ctx: ServiceContext, now = new Date()): Promise<string[]> {
  const organizationId = ctx.actor.organizationId;
  const days = await nudgeDaysWithin(tx, organizationId);
  if (days === null) return [];
  const zone = await timezoneOf(tx, organizationId);
  const today = time.dateIn(now, zone);
  /** Held on or before this day has lasted the days: the first instant after it is the bound. */
  const placedBefore = time.startOfDayIn(time.addDays(today, 1 - days), zone);

  const due = await tx.select({
    hold: schema.jobHold,
    job: schema.job,
    customerName: schema.customer.name,
  }).from(schema.jobHold)
    .innerJoin(schema.job, eq(schema.job.id, schema.jobHold.jobId))
    .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
    .where(and(
      eq(schema.jobHold.organizationId, organizationId),
      isNull(schema.jobHold.releasedAt),
      isNull(schema.jobHold.nudgedAt),
      lt(schema.jobHold.placedAt, placedBefore),
      eq(schema.job.status, "on_hold"),
      isNull(schema.job.deletedAt),
    ))
    .orderBy(asc(schema.jobHold.placedAt))
    .limit(NUDGES_PER_PASS);
  if (due.length === 0) return [];

  const people = await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sql`select user_id, name, email from app.organization_people()`,
  );
  const nameOf = (id: string | null) => {
    const person = id ? people.find((p) => p.user_id === id) : undefined;
    return person ? (person.name ?? person.email) : null;
  };

  const raised: string[] = [];
  for (const { hold, job, customerName } of due) {
    const placedOn = time.dateIn(hold.placedAt, zone);
    const held = work.daysHeld(placedOn, today);
    if (!work.holdNudgeDue(held, days)) continue;
    /** The claim. Only the pass whose update lands writes the task. */
    const [claimed] = await tx.update(schema.jobHold).set({ nudgedAt: now, updatedAt: now })
      .where(and(eq(schema.jobHold.id, hold.id), isNull(schema.jobHold.nudgedAt), isNull(schema.jobHold.releasedAt)))
      .returning({ id: schema.jobHold.id });
    if (!claimed) continue;

    const label = work.documentNumber(job.numberPrefix, job.number);
    const [task] = await tx.insert(schema.task).values({
      organizationId,
      title: work.holdNudgeTitle({ jobLabel: label, reason: hold.reason, held }),
      body: work.holdNudgeBody({
        customerName, summary: job.summary, reason: hold.reason, note: hold.note, held,
        since: new Date(`${placedOn}T12:00:00Z`).toLocaleDateString("en-US", {
          month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
        }),
        placedBy: nameOf(hold.placedByUserId), days,
      }),
      priority: "normal",
      entityType: "job",
      entityId: job.id,
      queue: "office",
    }).returning({ id: schema.task.id });
    await tx.update(schema.jobHold).set({ nudgeTaskId: task!.id }).where(eq(schema.jobHold.id, hold.id));
    await audit(tx, ctx, "job.hold_nudged", "job_hold", hold.id, null, { jobId: job.id, taskId: task!.id, days: held });
    raised.push(job.id);
  }
  return raised;
}

/** What the worker acts as. Writes tasks and nothing else. */
function workerActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: ["task:read", "task:write"], agentId: "job-hold-nudges" };
}

export interface NudgePassResult { organizationId: string; raised: number; failed: string | null }

let lastNudgePass: number | null = null;

/**
 * Every company with a hold that could be due, once a minute at most per
 * process: a hold is counted in days, and nothing gains from asking more
 * often. One company's failure is kept to that company.
 */
export async function nudgePass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean; force?: boolean } = {},
): Promise<NudgePassResult[]> {
  const at = (options.now ?? new Date()).getTime();
  if (!options.force && lastNudgePass !== null && at - lastNudgePass < 60_000 && at >= lastNudgePass) return [];
  lastNudgePass = at;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.job_hold_nudge_organizations(${options.limit ?? 200})`,
  );
  const results: NudgePassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    const ctx: ServiceContext = { actor: workerActor(row.organization_id), db };
    try {
      const raised = await inTenant(ctx, (tx) => nudgesIn(tx, ctx, options.now ?? new Date()));
      results.push({ organizationId: row.organization_id, raised: raised.length, failed: null });
    } catch (error) {
      results.push({ organizationId: row.organization_id, raised: 0, failed: (error as Error).message });
    }
  }
  return results;
}

/** Jobs waiting on a part on this order, for the order's own page. */
export function waitingOn(ctx: ServiceContext, input: { purchaseOrderId: string }) {
  return guardedRead(ctx, "po:read", async (tx) => {
    if (!can(ctx.actor, "job:read")) return [];
    const rows = await tx.select({
      holdId: schema.jobHold.id,
      jobId: schema.job.id,
      number: schema.job.number,
      numberPrefix: schema.job.numberPrefix,
      summary: schema.job.summary,
      placedAt: schema.jobHold.placedAt,
      releasedAt: schema.jobHold.releasedAt,
    }).from(schema.jobHold)
      .innerJoin(schema.job, eq(schema.job.id, schema.jobHold.jobId))
      .where(and(
        eq(schema.jobHold.purchaseOrderId, input.purchaseOrderId),
        isNull(schema.job.deletedAt),
        jobScopeFilter(scopeOf(ctx, "job"), ctx.actor),
      ))
      .orderBy(asc(schema.jobHold.placedAt));
    return rows.map((row) => ({
      ...row, placedAt: row.placedAt.toISOString(), releasedAt: row.releasedAt?.toISOString() ?? null,
    }));
  });
}

export const handlers = {
  listJobHolds: (ctx: ServiceContext, input: { id: string }) => holdsOf(ctx, input),
  placeJobHold: (ctx: ServiceContext, input: Parameters<typeof place>[1]) => place(ctx, input),
  releaseJobHold: (ctx: ServiceContext, input: { id: string }) => release(ctx, input),
  getJobHoldNudge: (ctx: ServiceContext) => nudgeSetting(ctx),
  setJobHoldNudge: (ctx: ServiceContext, input: { days: number | null }) => setNudge(ctx, input),
} as const;
