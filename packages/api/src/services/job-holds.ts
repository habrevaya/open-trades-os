import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, assertCan, can, notices, time, work, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, scopeOf, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { jobScopeFilter } from "./scope";
import { canTransition } from "./jobs";
import { emit } from "./events";
import * as plugins from "./plugins";
import { remember, replayed } from "./once";
import { tellAssignee } from "./tasks";
import { raiseWithin } from "./staff-notices";

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
  input: {
    id: string; reason: work.HoldReason; purchaseOrderId?: string | undefined; note?: string | undefined;
    /** The part a technician asked for from the field, which this hold answers. */
    partRequestId?: string | undefined;
  },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const again = await replayed<{ data: HoldView[] }>(tx, ctx, "job_hold");
    if (again) return again;

    const job = await loadJob(tx, ctx, input.id);
    const refusal = work.holdRefusal(input);
    if (refusal) throw new ConflictError(refusal);

    /**
     * A HOLD PLACED FROM A PART ASKED FOR IN THE FIELD. Only a part hold, on the
     * job the request is about, and once: a request already answered names its
     * hold, and a second hold for it would be the same part twice.
     */
    const request = input.partRequestId
      ? (await tx.select().from(schema.partRequest).where(eq(schema.partRequest.id, input.partRequestId)).limit(1))[0]
      : undefined;
    if (input.partRequestId) {
      if (!request || request.jobId !== job.id) throw new NotFoundError("Part request");
      if (input.reason !== "part") throw new ConflictError("A part asked for from the field is held for as a part, on the order it is on.");
      if (request.holdId) throw new ConflictError("The job has already been put on hold for that part.");
    }

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
    if (request) await answerRequest(tx, ctx, request, hold!);

    const answer = { data: await viewsOf(tx, input.id) };
    await remember(tx, ctx, "job_hold", hold!.id, answer);
    return answer;
  });
}

/**
 * The part request a hold was placed from: linked to the hold, and its task
 * finished saying which order, unless somebody already closed it. Inside the
 * hold's transaction, so the two cannot disagree.
 */
async function answerRequest(
  tx: Database, ctx: ServiceContext, request: typeof schema.partRequest.$inferSelect, hold: typeof schema.jobHold.$inferSelect,
): Promise<void> {
  const now = new Date();
  await tx.update(schema.partRequest).set({ holdId: hold.id, updatedAt: now }).where(eq(schema.partRequest.id, request.id));
  const [order] = hold.purchaseOrderId
    ? await tx.select({ number: schema.purchaseOrder.number }).from(schema.purchaseOrder)
      .where(eq(schema.purchaseOrder.id, hold.purchaseOrderId)).limit(1)
    : [];
  if (request.taskId) {
    await tx.update(schema.task).set({
      status: "done",
      outcome: order ? `The job is on hold for the part on purchase order ${order.number}.` : "The job is on hold for the part.",
      completedAt: now,
      completedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
      updatedAt: now,
    }).where(and(eq(schema.task.id, request.taskId), inArray(schema.task.status, ["open", "in_progress"])));
  }
  await audit(tx, ctx, "part_request.held", "part_request", request.id, { holdId: null }, { holdId: hold.id, purchaseOrderId: hold.purchaseOrderId });
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
 * not raised again for the same hold unless the company asked for repeats; the
 * next hold on the job is a new one.
 *
 * Three more settings sit beside it, each off by default so a company that
 * never asked gets exactly what it always got:
 *   dueDays     the task is due that many company days after it is raised, so
 *               the queue's late rules (M34, `/tasks/escalation`) act on it
 *   repeatDays  while the job is still on hold, raise it again that many days
 *               after the last one, but only once the last one has been
 *               closed: two open nudges for one hold are noise, and an open one
 *               already goes late and escalates on its own
 *   assignTo    nobody (the office queue), whoever put the job on hold (a job
 *               has no owner of its own), or a named colleague. Somebody who
 *               has left is not given work: it stays in the office queue
 */
export async function nudgeRulesWithin(tx: Database, organizationId: string): Promise<work.HoldNudgeRules> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  return work.holdNudgeRules(((row?.settings ?? {}) as Record<string, unknown>)["holdNudge"]);
}

export async function nudgeDaysWithin(tx: Database, organizationId: string): Promise<number | null> {
  return (await nudgeRulesWithin(tx, organizationId)).days;
}

export interface HoldNudgeView extends work.HoldNudgeRules {
  /** The named person's name, when the task goes to a person. */
  assigneeName: string | null;
}

export function nudgeSetting(ctx: ServiceContext): Promise<HoldNudgeView> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rules = await nudgeRulesWithin(tx, ctx.actor.organizationId);
    return { ...rules, assigneeName: await personName(tx, rules.assigneeUserId) };
  });
}

async function personName(tx: Database, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [person] = await tx.execute<{ name: string | null; email: string }>(
    sql`select name, email from app.organization_people() where user_id = ${userId}::uuid`,
  );
  return person ? (person.name ?? person.email) : null;
}

/**
 * Turn the nudge on for so many days, or off with null, and say how it is
 * handled. A field left out keeps what the company had: the settings are a
 * patch, so a caller that only knows about `days` (as every caller did before
 * the rest existed) changes only that. Changing the number of days changes
 * what the worker raises from the next pass: holds already past the new number
 * are nudged then, tasks already raised stay where they are. A due date, a
 * person or a repeat applies to the tasks raised from then on.
 *
 * A named person has to be somebody who works here now. Choosing "a person"
 * without saying who is refused, and choosing anything else forgets the
 * person, so a rule never names somebody it no longer uses.
 */
export type HoldNudgeChange = {
  [K in Exclude<keyof work.HoldNudgeRules, "assigneeRole">]?: work.HoldNudgeRules[K] | undefined;
} & { assigneeRole?: work.HoldNudgeRole | null | undefined };

export function setNudge(ctx: ServiceContext, input: HoldNudgeChange): Promise<HoldNudgeView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const before = await nudgeRulesWithin(tx, ctx.actor.organizationId);
    if (input.assigneeRole && !work.isHoldNudgeRole(input.assigneeRole)) throw new ConflictError("Choose a role from the list.");
    const assignTo = input.assignTo ?? before.assignTo;
    const assigneeRole = assignTo === "role"
      ? (input.assigneeRole !== undefined ? input.assigneeRole : before.assigneeRole ?? null)
      : null;
    const next: work.HoldNudgeRules = {
      days: input.days !== undefined ? input.days : before.days,
      dueDays: input.dueDays !== undefined ? input.dueDays : before.dueDays,
      repeatDays: input.repeatDays !== undefined ? input.repeatDays : before.repeatDays,
      assignTo,
      assigneeUserId: assignTo === "person"
        ? (input.assigneeUserId !== undefined ? input.assigneeUserId : before.assigneeUserId)
        : null,
      ...(assigneeRole ? { assigneeRole } : {}),
    };
    const problem = work.holdNudgeRulesProblem(next);
    if (problem) throw new ConflictError(problem);
    if (next.assigneeUserId) {
      const [member] = await tx.select({ active: schema.membership.active }).from(schema.membership)
        .where(and(
          eq(schema.membership.organizationId, ctx.actor.organizationId),
          eq(schema.membership.userId, next.assigneeUserId),
        )).limit(1);
      if (!member?.active) throw new ConflictError("The person the task goes to has to be somebody who works here now.");
    }
    await tx.update(schema.organization).set({
      settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ holdNudge: next })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "organization.hold_nudge_set", "organization", ctx.actor.organizationId, before, next);
    return { ...next, assigneeName: await personName(tx, next.assigneeUserId) };
  });
}

/* ----------------------------------------- the nudge by reason and by branch */

export interface HoldNudgeRuleView {
  id: string;
  reason: work.HoldReason | null;
  reasonLabel: string | null;
  businessUnitId: string | null;
  businessUnitName: string | null;
  days?: number | null;
  dueDays?: number | null;
  repeatDays?: number | null;
  assignTo?: work.HoldNudgeAssign;
  assigneeUserId?: string | null;
  assigneeRole?: work.HoldNudgeRole | null;
  assigneeName: string | null;
  summary: string;
}

export interface HoldNudgeRuleInput {
  reason?: work.HoldReason | null | undefined;
  businessUnitId?: string | null | undefined;
  days?: number | null | undefined;
  dueDays?: number | null | undefined;
  repeatDays?: number | null | undefined;
  assignTo?: work.HoldNudgeAssign | undefined;
  assigneeUserId?: string | null | undefined;
  assigneeRole?: work.HoldNudgeRole | null | undefined;
}

type RuleRow = typeof schema.jobHoldNudgeRule.$inferSelect;

/** The rules as the worker and the screens read them: the saved overrides, cleaned. */
async function rulesWithin(tx: Database, organizationId: string): Promise<RuleRow[]> {
  return tx.select().from(schema.jobHoldNudgeRule)
    .where(eq(schema.jobHoldNudgeRule.organizationId, organizationId))
    .orderBy(asc(schema.jobHoldNudgeRule.createdAt));
}

const asRow = (row: RuleRow): work.HoldNudgeRuleRow => ({
  reason: row.reason, businessUnitId: row.businessUnitId, overrides: work.holdNudgeOverrides(row.overrides),
});

async function ruleViews(tx: Database, rows: RuleRow[]): Promise<HoldNudgeRuleView[]> {
  const branches = new Map((await tx.select({ id: schema.businessUnit.id, name: schema.businessUnit.name })
    .from(schema.businessUnit)).map((b) => [b.id, b.name]));
  const views: HoldNudgeRuleView[] = [];
  for (const row of rows) {
    const o = work.holdNudgeOverrides(row.overrides);
    const namedPerson = o.assign?.to === "person" ? await personName(tx, o.assign.userId) : null;
    const branchName = row.businessUnitId ? branches.get(row.businessUnitId) ?? "a branch that has gone" : null;
    views.push({
      id: row.id,
      reason: row.reason,
      reasonLabel: row.reason ? work.holdReasonLabel(row.reason) : null,
      businessUnitId: row.businessUnitId,
      businessUnitName: branchName,
      ...(o.days !== undefined ? { days: o.days } : {}),
      ...(o.dueDays !== undefined ? { dueDays: o.dueDays } : {}),
      ...(o.repeatDays !== undefined ? { repeatDays: o.repeatDays } : {}),
      ...(o.assign ? {
        assignTo: o.assign.to,
        assigneeUserId: o.assign.userId,
        ...(o.assign.role ? { assigneeRole: o.assign.role } : {}),
      } : {}),
      assigneeName: namedPerson,
      summary: work.holdNudgeRuleSummary({ reason: row.reason, businessUnitName: branchName, overrides: o }, { personName: namedPerson }),
    });
  }
  return views;
}

export function listRules(ctx: ServiceContext): Promise<{ data: HoldNudgeRuleView[] }> {
  return guardedRead(ctx, "settings:read", async (tx) => ({
    data: await ruleViews(tx, await rulesWithin(tx, ctx.actor.organizationId)),
  }));
}

/** What a request says about the numbers, as the overrides a rule keeps. */
function overridesFrom(input: HoldNudgeRuleInput, before: work.HoldNudgeOverrides = {}, clear: string[] = []): work.HoldNudgeOverrides {
  if (input.assigneeRole && !work.isHoldNudgeRole(input.assigneeRole)) throw new ConflictError("Choose a role from the list.");
  const out: work.HoldNudgeOverrides = { ...before };
  if (clear.includes("days")) delete out.days;
  if (clear.includes("dueDays")) delete out.dueDays;
  if (clear.includes("repeatDays")) delete out.repeatDays;
  if (clear.includes("assign")) delete out.assign;
  if (input.days !== undefined) out.days = input.days;
  if (input.dueDays !== undefined) out.dueDays = input.dueDays;
  if (input.repeatDays !== undefined) out.repeatDays = input.repeatDays;
  if (input.assignTo !== undefined) {
    out.assign = {
      to: input.assignTo,
      userId: input.assignTo === "person" ? input.assigneeUserId ?? null : null,
      ...(input.assignTo === "role" && input.assigneeRole ? { role: input.assigneeRole } : {}),
    };
  } else if (input.assigneeUserId !== undefined || input.assigneeRole !== undefined) {
    /** A person or a role named without saying what it is for: the choice stays, the name changes. */
    if (!out.assign) throw new ConflictError("Say who the task goes to (a person or a role) as well.");
    const role = input.assigneeRole !== undefined ? input.assigneeRole : out.assign.role ?? null;
    out.assign = {
      to: out.assign.to,
      userId: out.assign.to === "person" ? (input.assigneeUserId !== undefined ? input.assigneeUserId : out.assign.userId) : null,
      ...(out.assign.to === "role" && role ? { role } : {}),
    };
  }
  return out;
}

async function checkRuleTargets(tx: Database, organizationId: string, o: work.HoldNudgeOverrides, businessUnitId: string | null) {
  if (businessUnitId) {
    const [unit] = await tx.select({ active: schema.businessUnit.active }).from(schema.businessUnit)
      .where(and(eq(schema.businessUnit.id, businessUnitId), isNull(schema.businessUnit.deletedAt))).limit(1);
    if (!unit) throw new NotFoundError("Branch");
  }
  if (o.assign?.userId) {
    const [member] = await tx.select({ active: schema.membership.active }).from(schema.membership)
      .where(and(eq(schema.membership.organizationId, organizationId), eq(schema.membership.userId, o.assign.userId))).limit(1);
    if (!member?.active) throw new ConflictError("The person the task goes to has to be somebody who works here now.");
  }
}

export function createRule(ctx: ServiceContext, input: HoldNudgeRuleInput): Promise<HoldNudgeRuleView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const again = await replayed<HoldNudgeRuleView>(tx, ctx, "job_hold_nudge_rule");
    if (again) return again;
    const organizationId = ctx.actor.organizationId;
    const reason = input.reason ?? null;
    const businessUnitId = input.businessUnitId ?? null;
    const reach = work.holdNudgeRuleReachProblem(reason, businessUnitId);
    if (reach) throw new ConflictError(reach);
    const overrides = overridesFrom(input);
    const problem = work.holdNudgeOverridesProblem(overrides);
    if (problem) throw new ConflictError(problem);
    await checkRuleTargets(tx, organizationId, overrides, businessUnitId);
    const [twin] = await tx.select({ id: schema.jobHoldNudgeRule.id }).from(schema.jobHoldNudgeRule)
      .where(and(
        eq(schema.jobHoldNudgeRule.organizationId, organizationId),
        reason ? eq(schema.jobHoldNudgeRule.reason, reason) : isNull(schema.jobHoldNudgeRule.reason),
        businessUnitId ? eq(schema.jobHoldNudgeRule.businessUnitId, businessUnitId) : isNull(schema.jobHoldNudgeRule.businessUnitId),
      )).limit(1);
    if (twin) throw new ConflictError("There is already a rule for that reason and branch. Change it, or take it away first.");
    const [row] = await tx.insert(schema.jobHoldNudgeRule).values({
      organizationId, reason, businessUnitId, overrides: overrides as Record<string, unknown>, createdByUserId: ctx.actor.userId,
    }).returning();
    await audit(tx, ctx, "job_hold_nudge_rule.created", "job_hold_nudge_rule", row!.id, null, row!);
    const [view] = await ruleViews(tx, [row!]);
    await remember(tx, ctx, "job_hold_nudge_rule", row!.id, view!);
    return view!;
  });
}

export function updateRule(
  ctx: ServiceContext, input: HoldNudgeRuleInput & { id: string; clear?: string[] | undefined },
): Promise<HoldNudgeRuleView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const again = await replayed<HoldNudgeRuleView>(tx, ctx, "job_hold_nudge_rule");
    if (again) return again;
    const [before] = await tx.select().from(schema.jobHoldNudgeRule).where(and(
      eq(schema.jobHoldNudgeRule.id, input.id), eq(schema.jobHoldNudgeRule.organizationId, ctx.actor.organizationId),
    )).limit(1);
    if (!before) throw new NotFoundError("Nudge rule");
    const overrides = overridesFrom(input, work.holdNudgeOverrides(before.overrides), input.clear ?? []);
    const problem = work.holdNudgeOverridesProblem(overrides);
    if (problem) throw new ConflictError(problem.startsWith("Say what is different")
      ? "A rule that changes nothing does nothing. Take it away instead." : problem);
    await checkRuleTargets(tx, ctx.actor.organizationId, overrides, null);
    const [row] = await tx.update(schema.jobHoldNudgeRule)
      .set({ overrides: overrides as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(schema.jobHoldNudgeRule.id, before.id)).returning();
    await audit(tx, ctx, "job_hold_nudge_rule.updated", "job_hold_nudge_rule", before.id, before, row!);
    const [view] = await ruleViews(tx, [row!]);
    await remember(tx, ctx, "job_hold_nudge_rule", before.id, view!);
    return view!;
  });
}

export function deleteRule(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; removed: true }> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const again = await replayed<{ id: string; removed: true }>(tx, ctx, "job_hold_nudge_rule_removed");
    if (again) return again;
    const [before] = await tx.select().from(schema.jobHoldNudgeRule).where(and(
      eq(schema.jobHoldNudgeRule.id, input.id), eq(schema.jobHoldNudgeRule.organizationId, ctx.actor.organizationId),
    )).limit(1);
    if (!before) throw new NotFoundError("Nudge rule");
    await tx.delete(schema.jobHoldNudgeRule).where(eq(schema.jobHoldNudgeRule.id, before.id));
    await audit(tx, ctx, "job_hold_nudge_rule.deleted", "job_hold_nudge_rule", before.id, before, null);
    const answer = { id: before.id, removed: true as const };
    await remember(tx, ctx, "job_hold_nudge_rule_removed", before.id, answer);
    return answer;
  });
}

/* ------------------------------------------------------------ the pass */

/** The most one pass raises for one company; the rest wait for the next pass. */
const NUDGES_PER_PASS = 200;

/** Whom a task is given to, and what to say when the company asked for somebody who is not there. */
interface Delivery {
  /** The one person it is assigned to, or null for the office queue. */
  assigneeUserId: string | null;
  /** Everybody told as well, when it was given to a role or a branch's manager. */
  told: string[];
  /** Said at the top of the task. */
  sentTo: string | undefined;
}

/**
 * Raise the nudges that are due for the company this transaction belongs to.
 * Returns the jobs it raised one for.
 *
 * What applies to each hold is the company's numbers with the rules for its
 * reason and its branch laid over them (`work.holdNudgeFor`), so one pass can
 * nudge a part hold after 3 days and a weather hold after 10, and leave the
 * customer holds of one branch alone.
 */
export async function nudgesIn(tx: Database, ctx: ServiceContext, now = new Date()): Promise<string[]> {
  const organizationId = ctx.actor.organizationId;
  const company = await nudgeRulesWithin(tx, organizationId);
  const rules = (await rulesWithin(tx, organizationId)).map(asRow);
  /** The soonest any hold could be due, so the query only reads holds that could be. */
  const everyDays = [company.days, ...rules.map((r) => r.overrides.days)].filter((d): d is number => typeof d === "number");
  if (everyDays.length === 0) return [];
  const everyRepeat = [company.repeatDays, ...rules.map((r) => r.overrides.repeatDays)].filter((d): d is number => typeof d === "number");
  const zone = await timezoneOf(tx, organizationId);
  const today = time.dateIn(now, zone);
  const placedBefore = time.startOfDayIn(time.addDays(today, 1 - Math.min(...everyDays)), zone);
  const repeatBefore = everyRepeat.length === 0 ? null : time.startOfDayIn(time.addDays(today, 1 - Math.min(...everyRepeat)), zone);

  const due = await tx.select({
    hold: schema.jobHold,
    job: schema.job,
    customerName: schema.customer.name,
    lastTaskStatus: schema.task.status,
  }).from(schema.jobHold)
    .innerJoin(schema.job, eq(schema.job.id, schema.jobHold.jobId))
    .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
    .leftJoin(schema.task, eq(schema.task.id, schema.jobHold.nudgeTaskId))
    .where(and(
      eq(schema.jobHold.organizationId, organizationId),
      isNull(schema.jobHold.releasedAt),
      repeatBefore === null
        ? and(isNull(schema.jobHold.nudgedAt), lt(schema.jobHold.placedAt, placedBefore))
        : or(
          and(isNull(schema.jobHold.nudgedAt), lt(schema.jobHold.placedAt, placedBefore)),
          lt(schema.jobHold.nudgedAt, repeatBefore),
        ),
      eq(schema.job.status, "on_hold"),
      isNull(schema.job.deletedAt),
    ))
    .orderBy(asc(schema.jobHold.placedAt));
  if (due.length === 0) return [];

  const people = await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sql`select user_id, name, email from app.organization_people()`,
  );
  const nameOf = (id: string | null) => {
    const person = id ? people.find((p) => p.user_id === id) : undefined;
    return person ? (person.name ?? person.email) : null;
  };
  const members = await tx.select({
    userId: schema.membership.userId, role: schema.membership.role, businessUnitId: schema.membership.businessUnitId,
  }).from(schema.membership)
    .where(and(eq(schema.membership.organizationId, organizationId), eq(schema.membership.active, true)));
  const working = new Set(members.map((m) => m.userId));

  /** Who gets the task, for a hold under the rules that apply to it. */
  const deliveryFor = (hold: typeof schema.jobHold.$inferSelect, job: typeof schema.job.$inferSelect, rule: work.HoldNudgeRules): Delivery => {
    const queue = (why: string | undefined): Delivery => ({ assigneeUserId: null, told: [], sentTo: why });
    switch (rule.assignTo) {
      case "nobody": return queue(undefined);
      case "placed_by": {
        const who = hold.placedByUserId;
        return who && working.has(who) ? { assigneeUserId: who, told: [], sentTo: undefined } : queue(undefined);
      }
      case "person": {
        const who = rule.assigneeUserId;
        return who && working.has(who) ? { assigneeUserId: who, told: [], sentTo: undefined } : queue(undefined);
      }
      case "role": {
        const role = rule.assigneeRole;
        if (!role) return queue(undefined);
        const holders = members.filter((m) => m.role === role).map((m) => m.userId);
        const words = work.HOLD_NUDGE_ROLE_WORDS[role];
        return holders.length === 0
          ? queue(`This was to go to ${words}, but nobody holds that role now, so it stays in the office queue.`)
          : { assigneeUserId: null, told: holders, sentTo: `Sent to ${words}.` };
      }
      case "branch_manager": {
        if (!job.businessUnitId) {
          return queue("This was to go to the manager of the job's branch, but the job is in no branch, so it stays in the office queue.");
        }
        const managers = members.filter((m) => m.role === "branch_manager" && m.businessUnitId === job.businessUnitId).map((m) => m.userId);
        return managers.length === 0
          ? queue("This was to go to the manager of the job's branch, but the branch has none now, so it stays in the office queue.")
          : { assigneeUserId: null, told: managers, sentTo: "Sent to the manager of the job's branch." };
      }
    }
  };

  const raised: string[] = [];
  for (const { hold, job, customerName, lastTaskStatus } of due) {
    if (raised.length >= NUDGES_PER_PASS) break;
    const rule = work.holdNudgeFor(company, rules, { reason: hold.reason, businessUnitId: job.businessUnitId });
    if (rule.days === null) continue;
    const placedOn = time.dateIn(hold.placedAt, zone);
    const held = work.daysHeld(placedOn, today);
    /** Raised before; a hold nudged before repeats existed counts as once. */
    const timesBefore = hold.nudgedAt ? Math.max(hold.nudgeCount, 1) : 0;
    if (timesBefore === 0) {
      if (!work.holdNudgeDue(held, rule.days)) continue;
    } else {
      if (!work.holdNudgeRepeatDue(time.dateIn(hold.nudgedAt!, zone), today, rule.repeatDays)) continue;
      /** Never two open nudges for one hold: the one still open is the nudge, and the late rules chase it. */
      if (lastTaskStatus === "open" || lastTaskStatus === "in_progress") continue;
    }
    /** The claim. Only the pass whose update lands writes the task. */
    const [claimed] = await tx.update(schema.jobHold)
      .set({ nudgedAt: now, nudgeCount: timesBefore + 1, updatedAt: now })
      .where(and(
        eq(schema.jobHold.id, hold.id),
        eq(schema.jobHold.nudgeCount, hold.nudgeCount),
        hold.nudgedAt ? isNotNull(schema.jobHold.nudgedAt) : isNull(schema.jobHold.nudgedAt),
        isNull(schema.jobHold.releasedAt),
      ))
      .returning({ id: schema.jobHold.id });
    if (!claimed) continue;

    /** The end of the company day the office has, so the task is late the morning after. */
    const dueAt = rule.dueDays === null ? null : time.startOfDayIn(time.addDays(today, rule.dueDays + 1), zone);
    const label = work.documentNumber(job.numberPrefix, job.number);
    const delivery = deliveryFor(hold, job, rule);
    const title = work.holdNudgeTitle({ jobLabel: label, reason: hold.reason, held, again: timesBefore > 0 });
    const [task] = await tx.insert(schema.task).values({
      organizationId,
      title,
      body: work.holdNudgeBody({
        customerName, summary: job.summary, reason: hold.reason, note: hold.note, held,
        since: new Date(`${placedOn}T12:00:00Z`).toLocaleDateString("en-US", {
          month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
        }),
        placedBy: nameOf(hold.placedByUserId), days: rule.days,
        ...(timesBefore > 0 ? { reminder: timesBefore + 1 } : {}),
        ...(delivery.sentTo ? { sentTo: delivery.sentTo } : {}),
      }),
      priority: "normal",
      entityType: "job",
      entityId: job.id,
      /** Kept in the office queue as well as given to a person, so the office can still find it there. */
      queue: "office",
      assigneeUserId: delivery.assigneeUserId,
      dueAt,
    }).returning({ id: schema.task.id });
    await tx.update(schema.jobHold).set({ nudgeTaskId: task!.id }).where(eq(schema.jobHold.id, hold.id));
    if (delivery.assigneeUserId) {
      await tellAssignee(tx, {
        id: task!.id, organizationId, title, assigneeUserId: delivery.assigneeUserId, dueAt,
      }, `task_assigned:${task!.id}:${delivery.assigneeUserId}`);
    }
    /**
     * A task for a role or a branch's managers stays in the office queue, one task for whoever acts on it,
     * and each of them is told. A person who cannot open the task is not told (the notice refuses).
     */
    const zoneDue = dueAt ? notices.localWhen(dueAt, zone) : null;
    for (const userId of delivery.told) {
      await raiseWithin(tx, {
        organizationId, userId, kind: "task_assigned", key: `task_assigned:${task!.id}:${userId}`,
        title: `A task for your team: ${title}`,
        body: zoneDue ? `Due ${zoneDue}.` : null,
        about: { type: "task", id: task!.id },
      });
    }
    await audit(tx, ctx, "job.hold_nudged", "job_hold", hold.id, null, {
      jobId: job.id, taskId: task!.id, days: held, times: timesBefore + 1,
      assigneeUserId: delivery.assigneeUserId, dueAt: dueAt?.toISOString() ?? null,
      assignTo: rule.assignTo, toldUserIds: delivery.told,
      ...(rule.assigneeRole ? { assigneeRole: rule.assigneeRole } : {}),
    });
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
  setJobHoldNudge: (ctx: ServiceContext, input: Parameters<typeof setNudge>[1]) => setNudge(ctx, input),
  listJobHoldNudgeRules: (ctx: ServiceContext) => listRules(ctx),
  createJobHoldNudgeRule: (ctx: ServiceContext, input: HoldNudgeRuleInput) => createRule(ctx, input),
  updateJobHoldNudgeRule: (ctx: ServiceContext, input: Parameters<typeof updateRule>[1]) => updateRule(ctx, input),
  deleteJobHoldNudgeRule: (ctx: ServiceContext, input: { id: string }) => deleteRule(ctx, input),
} as const;
