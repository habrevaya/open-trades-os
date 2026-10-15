import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, can, work } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, ConflictError, NotFoundError, type ServiceContext,
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
  await audit(tx, ctx, "job.hold_released", "job_hold", open.id, open, closed!);
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
} as const;
