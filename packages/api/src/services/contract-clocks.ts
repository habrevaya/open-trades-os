import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, coverage, deadlines, type Actor } from "@opentradesos/core";
import { audit, inTenant, type ServiceContext } from "./context";
import * as rateCards from "./rate-cards";

/**
 * THE CLOCKS A CONTRACT STARTS, KEPT ON THE JOB
 *
 * `core/deadlines` says which clocks a job should carry under its contract
 * and whether each has been met. This file makes the `obligation` table
 * agree with that answer: it raises a clock once, satisfies it with the fact
 * that met it and the time that fact happened, moves it when the job's
 * priority or contract changes, and cancels it when the job is called off or
 * the contract no longer applies.
 *
 * RECONCILED, NOT TRIGGERED. The facts that meet a clock happen all over the
 * product: a visit booked on the board, a technician arriving on a phone, an
 * invoice issued from three different screens. Hooking every one of those to
 * this file would be a dozen places to forget. Instead the job is reconciled
 * from what is true: by the worker on every pass, by every write in the
 * commercial module, and by the deadlines sweep. Doing it twice changes
 * nothing, which is what makes doing it often safe.
 *
 * AND THE READ DOES NOT WAIT FOR IT. A clock met since the last pass is
 * excluded from the queue by `metSql`, read from the same facts, so an
 * arrival at ten to the hour is not shown as a breach at the hour because
 * the worker had not been round yet.
 *
 * ABOUT TO BREACH BECOMES A TASK. A clock past its escalation time raises a
 * task in the office queue, due when the clock is, and from there the
 * company's own escalation rules do what they do for any late task: tell the
 * manager, hand it over. A deadline that only exists on a screen helps the
 * people already looking at it.
 */

const CONTRACT_KINDS = deadlines.DEADLINE_KINDS as readonly string[];

/**
 * Whether a contract clock has been met, as SQL over the obligation row.
 *
 * Written out against the outer table by name rather than interpolated,
 * for the reason `test/sql-fragments.test.ts` gives.
 */
export const metSql = sql`(
  "obligation"."entity_type" = 'job' and (
    ("obligation"."kind" = 'sla.respond' and exists (
      select 1 from public.visit v where v.job_id = "obligation"."entity_id"
        and (v.dispatched_at is not null or v.window_start is not null)))
    or ("obligation"."kind" = 'sla.arrive' and exists (
      select 1 from public.visit v where v.job_id = "obligation"."entity_id" and v.arrived_at is not null))
    or ("obligation"."kind" = 'sla.complete' and exists (
      select 1 from public.job j where j.id = "obligation"."entity_id" and j.completed_at is not null))
    or ("obligation"."kind" = 'invoice.submit_by' and exists (
      select 1 from public.invoice i where i.job_id = "obligation"."entity_id"
        and i.status not in ('draft', 'void') and i.deleted_at is null))
    or ("obligation"."kind" = 'claim.file_by' and exists (
      select 1 from public.coverage_claim c where c.job_id = "obligation"."entity_id"))
  )
)`;

/** What the job's facts are, for the clocks. */
async function factsOf(tx: Database, job: typeof schema.job.$inferSelect, billsThirdParty: boolean) {
  const [visits] = await tx.select({
    /** A visit booked with a window, or dispatched: the earlier of when it was booked and sent. */
    responded: sql<Date | null>`min(case when ${schema.visit.windowStart} is not null or ${schema.visit.dispatchedAt} is not null
      then least(${schema.visit.createdAt}, coalesce(${schema.visit.dispatchedAt}, ${schema.visit.createdAt})) end)`,
    arrived: sql<Date | null>`min(${schema.visit.arrivedAt})`,
  }).from(schema.visit).where(eq(schema.visit.jobId, job.id));
  const [invoiced] = await tx.select({ at: sql<Date | null>`min(${schema.invoice.createdAt})` })
    .from(schema.invoice)
    .where(and(
      eq(schema.invoice.jobId, job.id),
      sql`${schema.invoice.status} not in ('draft', 'void')`,
      isNull(schema.invoice.deletedAt),
    ));
  const [claimed] = await tx.select({ at: sql<Date | null>`min(${schema.coverageClaim.submittedAt})` })
    .from(schema.coverageClaim).where(eq(schema.coverageClaim.jobId, job.id));

  const date = (value: unknown): Date | null => (value ? new Date(value as string) : null);
  return {
    receivedAt: job.createdAt,
    priority: job.priority,
    respondedAt: date(visits?.responded),
    arrivedAt: date(visits?.arrived),
    completedAt: job.completedAt,
    invoicedAt: date(invoiced?.at),
    claimFiledAt: date(claimed?.at),
    billsThirdParty,
  } satisfies deadlines.JobFacts;
}

/**
 * The contract whose clocks a job runs on.
 *
 * The job's own when it names one. Otherwise the contract of whoever pays:
 * the third party for covered work, then the party billed, then the
 * customer. A home warranty network's response times apply to the work it
 * sends, and a facilities client's to theirs.
 */
export async function governingContract(tx: Database, organizationId: string, jobId: string) {
  const [job] = await tx.select().from(schema.job).where(eq(schema.job.id, jobId)).limit(1);
  if (!job) return null;
  const [terms] = await tx.select({ source: schema.entitlement.source }).from(schema.entitlement)
    .where(eq(schema.entitlement.jobId, jobId)).limit(1);
  const billsThirdParty = terms ? coverage.COVERAGE[terms.source].billsAThirdParty : false;

  if (job.contractId) {
    const [named] = await tx.select().from(schema.serviceContract)
      .where(and(eq(schema.serviceContract.id, job.contractId), isNull(schema.serviceContract.deletedAt))).limit(1);
    if (named) return { job, contract: named, billsThirdParty };
  }

  const parties = await tx.select({ role: schema.jobParty.role, customerId: schema.jobParty.customerId })
    .from(schema.jobParty).where(eq(schema.jobParty.jobId, jobId));
  const payer = parties.find((p) => p.role === "payer" && p.customerId && p.customerId !== job.customerId)?.customerId;
  const billTo = parties.find((p) => p.role === "bill_to" && p.customerId)?.customerId;
  const order = [billsThirdParty ? payer : undefined, billTo, job.customerId, payer]
    .filter((x): x is string => Boolean(x));
  for (const customerId of [...new Set(order)]) {
    const found = await rateCards.contractFor(tx, organizationId, { customerId, jobId });
    if (found) return { job, contract: found.contract, billsThirdParty };
  }
  return { job, contract: null, billsThirdParty };
}

const taskTitle = (kind: string, jobNumber: number) =>
  `${deadlines.deadlineLabel(kind)}: job ${jobNumber}`;

/**
 * Make the job's contract clocks agree with its contract and its facts.
 *
 * Inside the caller's transaction, so a clock raised by billing a job
 * exists only if the billing did.
 */
export async function reconcileJob(
  tx: Database, organizationId: string, jobId: string,
): Promise<{ raised: number; met: number; cancelled: number; moved: number }> {
  const result = { raised: 0, met: 0, cancelled: 0, moved: 0 };
  const governed = await governingContract(tx, organizationId, jobId);
  if (!governed) return result;
  const { job, contract, billsThirdParty } = governed;

  const existing = await tx.select().from(schema.obligation)
    .where(and(
      eq(schema.obligation.organizationId, organizationId),
      eq(schema.obligation.entityType, "job"),
      eq(schema.obligation.entityId, jobId),
      inArray(schema.obligation.kind, [...CONTRACT_KINDS]),
    ));

  const desired = contract && job.status !== "cancelled" && !job.deletedAt
    ? deadlines.clocksFor({
        sla: contract.slaTerms,
        invoiceWithinDays: contract.invoiceWithinDays,
        claimWithinDays: contract.claimWithinDays,
      }, await factsOf(tx, job, billsThirdParty))
    : [];

  const now = new Date();
  for (const clock of desired) {
    const row = existing.find((o) => o.kind === clock.kind);
    if (!row) {
      await tx.insert(schema.obligation).values({
        organizationId,
        kind: clock.kind,
        entityType: "job",
        entityId: jobId,
        dueAt: clock.dueAt,
        escalateAt: clock.escalateAt,
        consequence: clock.consequence,
        ...(clock.metAt ? {
          state: "satisfied" as const,
          satisfiedAt: clock.metAt,
          satisfiedByEvent: clock.metBy,
          /** Met, and late: the breach is kept, because the scorecard counts it. */
          ...(clock.metAt > clock.dueAt ? { breachedAt: clock.dueAt } : {}),
        } : {}),
      });
      result.raised += 1;
      if (clock.metAt) result.met += 1;
      continue;
    }
    const live = row.state === "open" || row.state === "breached";
    if (!live) continue;
    if (clock.metAt) {
      await tx.update(schema.obligation).set({
        state: "satisfied",
        satisfiedAt: clock.metAt,
        satisfiedByEvent: clock.metBy,
        ...(clock.metAt > row.dueAt && !row.breachedAt ? { breachedAt: row.dueAt } : {}),
        updatedAt: now,
      }).where(eq(schema.obligation.id, row.id));
      await closeTasksFor(tx, row.kind, job, `Met: ${clock.metBy ?? "done"}.`);
      result.met += 1;
    } else if (row.dueAt.getTime() !== clock.dueAt.getTime()) {
      /**
       * A different due time is a different promise: the job became an
       * emergency, or now runs under another contract. Moved rather than
       * raised again, and its escalation with it, so a task is raised for
       * the clock that is actually running.
       */
      await tx.update(schema.obligation).set({
        dueAt: clock.dueAt,
        escalateAt: clock.escalateAt,
        escalatedAt: null,
        consequence: clock.consequence,
        state: "open",
        breachedAt: null,
        updatedAt: now,
      }).where(eq(schema.obligation.id, row.id));
      result.moved += 1;
    }
  }

  /**
   * Clocks the job no longer owes, because it was called off or its
   * contract no longer applies. Cancelled rather than deleted: the
   * scorecard's denominator has to exclude them, not forget them.
   */
  for (const row of existing) {
    if (row.state !== "open" && row.state !== "breached") continue;
    if (desired.some((clock) => clock.kind === row.kind)) continue;
    await tx.update(schema.obligation).set({ state: "cancelled", updatedAt: now })
      .where(eq(schema.obligation.id, row.id));
    await closeTasksFor(tx, row.kind, job, "No longer owed: the job or its contract changed.");
    result.cancelled += 1;
  }
  return result;
}

/** A clock that has been met takes its task out of the queue with it. */
async function closeTasksFor(
  tx: Database, kind: string, job: typeof schema.job.$inferSelect, outcome: string,
): Promise<void> {
  await tx.update(schema.task).set({
    status: "done", completedAt: new Date(), outcome, updatedAt: new Date(),
  }).where(and(
    eq(schema.task.entityType, "job"),
    eq(schema.task.entityId, job.id),
    eq(schema.task.title, taskTitle(kind, job.number)),
    inArray(schema.task.status, ["open", "in_progress"]),
  ));
}

/** The jobs in a company whose contract clocks need looking at. */
async function jobsToReconcile(tx: Database, organizationId: string, limit: number): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select j.id from public.job j
    where j.organization_id = ${organizationId}
      and (
        (j.deleted_at is null and j.status not in ('paid', 'cancelled') and (
          j.contract_id is not null
          or exists (
            select 1 from public.service_contract c
            where c.active and c.deleted_at is null
              and (c.customer_id = j.customer_id or c.customer_id in (
                select p.customer_id from public.job_party p where p.job_id = j.id and p.customer_id is not null))
          )
        ))
        or exists (
          select 1 from public.obligation o
          where o.entity_type = 'job' and o.entity_id = j.id and o.state in ('open', 'breached')
            and o.kind in (${sql.join(CONTRACT_KINDS.map((k) => sql`${k}`), sql`, `)})
        )
      )
    order by j.updated_at desc
    limit ${limit}
  `);
  return rows.map((row) => row.id);
}

/**
 * Raise a task for every clock past its escalation time, once.
 *
 * Once because the stamp and the task are written together, in this
 * transaction, against rows that had no stamp: a pass cut short and run
 * again finds them stamped and raises nothing.
 */
async function escalate(tx: Database, ctx: ServiceContext, now: Date): Promise<number> {
  const due = await tx.update(schema.obligation).set({ escalatedAt: now, updatedAt: now })
    .where(and(
      eq(schema.obligation.organizationId, ctx.actor.organizationId),
      inArray(schema.obligation.state, ["open", "breached"]),
      isNull(schema.obligation.escalatedAt),
      lte(schema.obligation.escalateAt, now),
      sql`not ${metSql}`,
    ))
    .returning();
  if (due.length === 0) return 0;

  const jobIds = due.filter((o) => o.entityType === "job").map((o) => o.entityId);
  const numbers = new Map(jobIds.length === 0 ? [] : (await tx.select({ id: schema.job.id, number: schema.job.number })
    .from(schema.job).where(inArray(schema.job.id, jobIds))).map((j) => [j.id, j.number] as const));

  for (const obligation of due) {
    const number = numbers.get(obligation.entityId);
    const [task] = await tx.insert(schema.task).values({
      organizationId: ctx.actor.organizationId,
      title: number !== undefined
        ? taskTitle(obligation.kind, number)
        : `${deadlines.deadlineLabel(obligation.kind)}: ${obligation.entityType}`,
      body: obligation.consequence,
      priority: "high",
      entityType: obligation.entityType,
      entityId: obligation.entityId,
      dueAt: obligation.dueAt,
    }).returning({ id: schema.task.id });
    await audit(tx, ctx, "obligation.escalated", "obligation", obligation.id, null, { taskId: task!.id });
  }
  return due.length;
}

/**
 * Everything a pass does for one company, inside its transaction:
 * reconcile the jobs, stamp what has gone past, and raise tasks for what is
 * about to. The deadlines sweep and the worker both run exactly this.
 */
export async function passIn(
  tx: Database, ctx: ServiceContext, now = new Date(), options: { limit?: number } = {},
): Promise<{ reconciled: number; breached: number; escalated: number }> {
  const jobs = await jobsToReconcile(tx, ctx.actor.organizationId, options.limit ?? 500);
  for (const jobId of jobs) await reconcileJob(tx, ctx.actor.organizationId, jobId);

  const breached = await tx.update(schema.obligation).set({ state: "breached", breachedAt: now, updatedAt: now })
    .where(and(
      eq(schema.obligation.organizationId, ctx.actor.organizationId),
      eq(schema.obligation.state, "open"),
      lte(schema.obligation.dueAt, now),
      sql`not ${metSql}`,
    ))
    .returning({ id: schema.obligation.id });

  const escalated = await escalate(tx, ctx, now);
  return { reconciled: jobs.length, breached: breached.length, escalated };
}

/* ------------------------------------------------------------ the worker */

/** What the worker acts as. Reconciles clocks and raises tasks; nothing else. */
function workerActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["task:read", "task:write"],
    agentId: "contract-clocks",
  };
}

/**
 * The worker's pass over every company with a contract or a live clock.
 *
 * One company's failure is logged and the pass goes on, for the reason the
 * task pass gives: a broken contract at one company must not stop another
 * company's deadlines being raised.
 */
export async function clockPass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean } = {},
): Promise<Array<{ organizationId: string; escalated: number; failed: string | null }>> {
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.contract_clock_organizations(${options.limit ?? 200})`,
  );
  const results: Array<{ organizationId: string; escalated: number; failed: string | null }> = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    const ctx: ServiceContext = { actor: workerActor(row.organization_id), db };
    try {
      const done = await inTenant(ctx, (tx) => passIn(tx, ctx, options.now ?? new Date()));
      results.push({ organizationId: row.organization_id, escalated: done.escalated, failed: null });
    } catch (error) {
      results.push({ organizationId: row.organization_id, escalated: 0, failed: (error as Error).message });
    }
  }
  return results;
}

/* ------------------------------------------------------- the job's clocks */

export interface JobClock {
  id: string;
  kind: string;
  label: string;
  state: string;
  dueAt: Date;
  satisfiedAt: Date | null;
  satisfiedByEvent: string | null;
  breachedAt: Date | null;
  consequence: string | null;
  /** Met, live and early, live and late. Worked out against the clock on read. */
  standing: "met" | "met_late" | "waived" | "cancelled" | "due" | "overdue";
  minutesRemaining: number;
}

/** The contract clocks on one job, in the order they fall due. */
export async function clocksOf(tx: Database, organizationId: string, jobId: string): Promise<JobClock[]> {
  const rows = await tx.select().from(schema.obligation)
    .where(and(
      eq(schema.obligation.organizationId, organizationId),
      eq(schema.obligation.entityType, "job"),
      eq(schema.obligation.entityId, jobId),
    ))
    .orderBy(asc(schema.obligation.dueAt));
  const now = Date.now();
  return rows.map((row) => {
    const late = row.dueAt.getTime() <= now;
    const standing: JobClock["standing"] = row.state === "satisfied"
      ? (row.satisfiedAt && row.satisfiedAt > row.dueAt ? "met_late" : "met")
      : row.state === "waived" ? "waived"
      : row.state === "cancelled" ? "cancelled"
      : late ? "overdue" : "due";
    return {
      id: row.id,
      kind: row.kind,
      label: deadlines.deadlineLabel(row.kind),
      state: row.state,
      dueAt: row.dueAt,
      satisfiedAt: row.satisfiedAt,
      satisfiedByEvent: row.satisfiedByEvent,
      breachedAt: row.breachedAt,
      consequence: row.consequence,
      standing,
      minutesRemaining: Math.round((row.dueAt.getTime() - now) / 60_000),
    };
  });
}
