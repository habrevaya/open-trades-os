import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { automation, type Actor, SYSTEM_USER_ID } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import { emit } from "./events";
import { fire } from "./workflow-runner";
import type { RunSummary } from "./workflow-runner";

/**
 * THE CLOCK
 *
 * `trigger_kind` has had `schedule` in it since the first migration and
 * nothing fired one. That is the defect this codebase keeps finding in
 * itself, and it is worse here than usual: a contractor could set a workflow
 * to run every night, see it saved and enabled, and never learn that it did
 * not run.
 *
 * THE SCHEDULE IS A CURSOR, NOT A TIMER. There is no in-memory timer and no
 * queue. Each workflow has a row saying when it next fires, a tick asks the
 * database what is due, and claiming one is a conditional update on that
 * value. A process that dies holding nothing loses nothing, and a second
 * worker is a capacity decision rather than a duplicate-message incident.
 *
 * CLAIM AND RUN IN ONE TRANSACTION. The alternative orderings are both
 * wrong: claiming first and then running loses the occurrence if the process
 * dies in between, and running first lets two workers do it. Inside one
 * transaction a crash rolls back the claim as well, so the next tick tries
 * again, and the unique index on the run keeps a retry from repeating a step
 * that already committed.
 */

export interface TickResult {
  workflowId: string;
  organizationId: string;
  /** What the tick did: planned the next run, fired it, or nothing. */
  action: "planned" | "fired" | "skipped";
  reason?: string;
  run?: RunSummary;
  nextRunAt?: Date | null;
}

interface DueRow extends Record<string, unknown> {
  organization_id: string;
  workflow_id: string;
  expression: string;
  timezone: string | null;
  next_run_at: string | null;
  stored_expression: string | null;
}

/** The actor a tick enters a tenant with. Holds nothing; the run has its own. */
function tickActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: [],
    agentId: "scheduler",
  };
}

/**
 * Write down when this workflow next fires.
 *
 * Also the repair path. A row whose expression no longer matches the
 * workflow's is recomputed rather than fired, so editing "every night at
 * eleven" into "every Monday" does not fire once more on the old clock.
 */
function plan(
  row: DueRow,
  from: Date,
): { nextRunAt: Date | null; error: string | null } {
  const parsed = automation.parseSchedule(row.expression);
  if (!parsed.ok) {
    /**
     * Recorded on the row rather than thrown. A schedule nobody can read is
     * one workflow's problem, and throwing would stop the tick for every
     * other tenant in the same pass.
     */
    return { nextRunAt: null, error: parsed.reason };
  }
  const zone = row.timezone ?? "America/Chicago";
  return { nextRunAt: automation.nextRun(parsed.schedule, from, zone), error: null };
}

async function upsert(
  tx: Database,
  row: DueRow,
  next: { nextRunAt: Date | null; error: string | null },
): Promise<void> {
  await tx.insert(schema.workflowSchedule).values({
    organizationId: row.organization_id,
    workflowId: row.workflow_id,
    expression: row.expression,
    nextRunAt: next.nextRunAt,
    lastError: next.error,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [schema.workflowSchedule.organizationId, schema.workflowSchedule.workflowId],
    set: {
      expression: row.expression,
      nextRunAt: next.nextRunAt,
      lastError: next.error,
      updatedAt: new Date(),
    },
  });
}

/**
 * One workflow's tick.
 *
 * Exported so a test can drive a single schedule without reaching across
 * tenants, and so the worker's pass is a loop over this rather than a second
 * copy of the decision.
 */
export async function tickOne(db: Database, row: DueRow, now: Date): Promise<TickResult> {
  const ctx: ServiceContext = { actor: tickActor(row.organization_id), db };
  const base = { workflowId: row.workflow_id, organizationId: row.organization_id };

  return inTenant(ctx, async (tx) => {
    /**
     * A schedule this row has not been planned against yet, or one whose
     * expression changed. Planned from now rather than fired, because a
     * workflow saved at noon with "every night at eleven" should run at
     * eleven and not at noon.
     */
    if (row.stored_expression !== row.expression) {
      const next = plan(row, now);
      await upsert(tx, row, next);
      return {
        ...base, action: "planned" as const, nextRunAt: next.nextRunAt,
        ...(next.error ? { reason: next.error } : {}),
      };
    }

    const due = row.next_run_at ? new Date(row.next_run_at) : null;
    if (!due) return { ...base, action: "skipped" as const, reason: "never_fires" };
    if (due > now) return { ...base, action: "skipped" as const, reason: "not_due" };

    /**
     * THE CLAIM. Conditional on the due time still being the one we read, so
     * of two workers that both saw this row due, exactly one proceeds.
     */
    /**
     * The next run is computed from NOW when the tick is late, not from the
     * occurrence it is firing.
     *
     * A worker down for three days comes back to a schedule three days
     * behind. Advancing one occurrence at a time would fire three nightly
     * summaries in as many seconds, which is worse than missing them: the
     * customer sees the outage. One run for the occurrence that was due, and
     * then back on the normal clock.
     */
    const next = plan(row, now > due ? now : due);
    const claimed = await tx.update(schema.workflowSchedule).set({
      nextRunAt: next.nextRunAt,
      lastRunAt: due,
      lastError: next.error,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.workflowSchedule.organizationId, row.organization_id),
      eq(schema.workflowSchedule.workflowId, row.workflow_id),
      eq(schema.workflowSchedule.nextRunAt, due),
    )).returning({ workflowId: schema.workflowSchedule.workflowId });

    if (claimed.length === 0) {
      return { ...base, action: "skipped" as const, reason: "claimed_elsewhere" };
    }

    /**
     * The firing goes in the event log like everything else, so "why did this
     * text go out at eleven on Tuesday" is answerable from the same place as
     * every other why. `scheduledFor` is the due time rather than now, so a
     * tick that ran late records the occurrence it was for.
     */
    const event = await emit(tx, ctx, {
      name: "workflow.scheduled",
      entityType: "workflow",
      entityId: row.workflow_id,
      payload: { workflowId: row.workflow_id, scheduledFor: due.toISOString() },
    });

    const run = await fire(tx, ctx, { workflowId: row.workflow_id, eventId: event.id });
    return { ...base, action: "fired" as const, run, nextRunAt: next.nextRunAt };
  });
}

/**
 * One pass over every schedule, across every tenant.
 *
 * The cross tenant read goes through `app.scheduled_workflows`, which returns
 * ids, the expression and the company's timezone and nothing else, and is not
 * callable by the role the request path uses.
 */
export async function tick(
  db: Database,
  options: { now?: Date; limit?: number } = {},
): Promise<TickResult[]> {
  const now = options.now ?? new Date();
  const rows = await db.execute<DueRow>(
    sql`select * from app.scheduled_workflows(${options.limit ?? 200})`,
  );

  const results: TickResult[] = [];
  for (const row of rows) {
    try {
      results.push(await tickOne(db, row, now));
    } catch (error) {
      /**
       * One tenant's broken workflow must not stop the clock for everybody.
       * The row keeps its due time, so the next pass tries again, which is
       * the right behaviour for a transient failure and visible for a
       * permanent one.
       */
      results.push({
        workflowId: row.workflow_id,
        organizationId: row.organization_id,
        action: "skipped",
        reason: (error as Error).message,
      });
    }
  }
  return results;
}
