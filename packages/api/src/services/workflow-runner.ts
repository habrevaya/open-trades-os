import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { automation, comms, type Actor, type Permission, SYSTEM_USER_ID } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import { emit } from "./events";
import { sendMessage, createTask, waitStep, type StepResult } from "./workflow-steps";

/**
 * THE RUNNER
 *
 * Takes one event and does whatever the enabled workflows say. Deliberately a
 * function rather than a loop with a timer, so the same code serves an
 * inline call, a background worker and a test, and so nothing about it
 * depends on a scheduler existing yet.
 *
 * Three properties hold regardless of how it is driven:
 *
 *   ONCE       A run is keyed on the version and the event, so a worker that
 *              crashes mid-run and retries resumes rather than repeating.
 *   BOUNDED    The loop guards in core refuse a workflow's own output and cap
 *              the causation chain.
 *   LIMITED    A run acts with the permissions its version declared and the
 *              publisher held. Not the owner's, and not the triggering user's.
 */

export interface RunSummary {
  workflowId: string;
  runId: string | null;
  status: "succeeded" | "failed" | "skipped" | "waiting";
  /** When a waiting run becomes runnable again. */
  resumeAt?: Date;
  reason?: string;
  steps: number;
}

/**
 * The actor a run acts as.
 *
 * Built from the version's declared permissions and nothing else. It has no
 * roles, so `permissionsFor` contributes nothing and the grants ARE the
 * permission set: a workflow cannot inherit anything from whoever happened
 * to trigger it.
 *
 * `technicianId` and the rest are deliberately absent, which means every
 * scope resolves to its narrowest form. A workflow that needs to read one
 * customer is handed that customer by the event payload rather than reading
 * the book.
 */
export function runnerActor(organizationId: string, permissions: readonly string[]): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: permissions as Permission[],
    agentId: "workflow",
  };
}

/** Workflows that subscribe to this event name and are switched on. */
async function candidates(tx: Database, organizationId: string, eventName: string) {
  return tx.select({
    workflow: schema.workflow,
    version: schema.workflowVersion,
  })
    .from(schema.workflow)
    .innerJoin(schema.workflowVersion, eq(schema.workflowVersion.id, schema.workflow.activeVersionId))
    .where(and(
      eq(schema.workflow.organizationId, organizationId),
      eq(schema.workflow.enabled, true),
      isNull(schema.workflow.deletedAt),
      // Containment on the jsonb array, so the filter is in the database
      // rather than a full scan of every workflow the tenant has ever made.
      sql`${schema.workflow.triggerEvents} @> ${JSON.stringify([eventName])}::jsonb`,
    ));
}

export async function handleEvent(
  ctx: ServiceContext,
  eventId: string,
): Promise<RunSummary[]> {
  return inTenant(ctx, async (tx) => {
    const [event] = await tx.select().from(schema.domainEvent)
      .where(eq(schema.domainEvent.id, eventId)).limit(1);
    if (!event) return [];

    const rows = await candidates(tx, event.organizationId, event.name);
    const summaries: RunSummary[] = [];

    for (const { workflow, version } of rows) {
      /**
       * Every run this workflow has ever produced would be the honest input
       * to the self-trigger check, and it is unbounded. The event carries the
       * run that caused it, so one lookup answers whether that run belongs to
       * this workflow, which is the same question in constant time.
       */
      const ownRunIds = event.causedByRunId
        ? (await tx.select({ id: schema.workflowRun.id })
            .from(schema.workflowRun)
            .where(and(
              eq(schema.workflowRun.workflowId, workflow.id),
              eq(schema.workflowRun.id, event.causedByRunId),
            )).limit(1)).map((r: { id: string }) => r.id)
        : [];

      const decision = automation.shouldTrigger(
        {
          id: workflow.id,
          versionId: version.id,
          enabled: workflow.enabled,
          triggerEvents: workflow.triggerEvents,
          conditions: version.conditions as automation.ConditionGroup,
        },
        {
          name: event.name,
          payload: event.payload,
          previous: (event.payload as { previous?: Record<string, unknown> }).previous,
          causationDepth: event.causationDepth,
          causedByRunId: event.causedByRunId ?? undefined,
        },
        ownRunIds,
      );

      if (!decision.run) {
        summaries.push({ workflowId: workflow.id, runId: null, status: "skipped", reason: decision.reason, steps: 0 });
        continue;
      }

      summaries.push(await execute(tx, ctx, { workflow, version, event }));
    }

    return summaries;
  });
}

/**
 * Run one workflow against one event, without asking whether it subscribes.
 *
 * The scheduler's entry point. An event-triggered workflow is chosen by
 * `handleEvent` matching the event name; a scheduled one is chosen by the
 * clock, and there is nothing for that match to test. Everything after the
 * choosing is the same code, which is the point: a scheduled run is recorded,
 * permitted and bounded exactly as an event-triggered one is.
 */
export async function fire(
  tx: Database,
  ctx: ServiceContext,
  input: {
    workflowId: string;
    eventId: string;
    /**
     * Overrides the key a run is deduplicated on.
     *
     * A dwell sweep runs every pass and the same estimate is still
     * unanswered on the next one, so keying on the EVENT would chase the
     * same customer every few minutes: each sweep emits a new event with a
     * new id. Keying on the record is what makes it once, ever.
     */
    idempotencyKey?: string;
  },
): Promise<RunSummary> {
  const [row] = await tx.select({
    workflow: schema.workflow,
    version: schema.workflowVersion,
  })
    .from(schema.workflow)
    .innerJoin(schema.workflowVersion, eq(schema.workflowVersion.id, schema.workflow.activeVersionId))
    .where(and(
      eq(schema.workflow.id, input.workflowId),
      eq(schema.workflow.enabled, true),
      isNull(schema.workflow.deletedAt),
    ))
    .limit(1);
  if (!row) {
    return { workflowId: input.workflowId, runId: null, status: "skipped", reason: "not_runnable", steps: 0 };
  }

  const [event] = await tx.select().from(schema.domainEvent)
    .where(eq(schema.domainEvent.id, input.eventId)).limit(1);
  if (!event) {
    return { workflowId: input.workflowId, runId: null, status: "skipped", reason: "no_event", steps: 0 };
  }

  /**
   * Conditions still apply. "Every morning at nine, IF there is anything to
   * chase" is the normal shape of a scheduled workflow, and a schedule that
   * ignored its own conditions would send an empty summary every day.
   */
  const conditions = row.version.conditions as automation.ConditionGroup;
  const passes = automation.evaluateGroup(conditions, {
    payload: event.payload,
    previous: (event.payload as { previous?: Record<string, unknown> }).previous,
  });
  if (!passes) {
    return { workflowId: row.workflow.id, runId: null, status: "skipped", reason: "conditions", steps: 0 };
  }

  return execute(tx, ctx, {
    workflow: row.workflow, version: row.version, event,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}

async function execute(
  tx: Database,
  ctx: ServiceContext,
  input: {
    workflow: typeof schema.workflow.$inferSelect;
    version: typeof schema.workflowVersion.$inferSelect;
    event: typeof schema.domainEvent.$inferSelect;
    idempotencyKey?: string;
  },
): Promise<RunSummary> {
  const { workflow, version, event } = input;
  const key = input.idempotencyKey ?? automation.runKey(version.id, event.id);

  /**
   * The unique index on (organization, key) is what makes this once. Inserting
   * and letting the conflict decide is race free in a way that checking first
   * is not: two workers reading "no run yet" would both proceed.
   */
  const inserted = await tx.insert(schema.workflowRun).values({
    organizationId: event.organizationId,
    workflowId: workflow.id,
    versionId: version.id,
    eventId: event.id,
    idempotencyKey: key,
    status: "running",
    causationDepth: event.causationDepth + 1,
    startedAt: new Date(),
  }).onConflictDoNothing().returning({ id: schema.workflowRun.id });

  const runId = inserted[0]?.id;
  if (!runId) {
    // Somebody else has it. Not an error, and not a second attempt.
    return { workflowId: workflow.id, runId: null, status: "skipped", reason: "already_run", steps: 0 };
  }

  return advance(tx, ctx, { workflow, version, event, runId, from: 0 });
}

/**
 * Run the steps from `from` onwards, parking the run if one of them waits.
 *
 * Shared by a first attempt and a resume, so there is one loop and not two
 * that can disagree about what "the next step" means. A resume skips the
 * steps that already succeeded rather than replaying them: a run that sent
 * the text and then waited three days must not send it again on the way
 * back, and the unique index on (run, step) is what makes that checkable
 * rather than hopeful.
 */
async function advance(
  tx: Database,
  ctx: ServiceContext,
  input: {
    workflow: typeof schema.workflow.$inferSelect;
    version: typeof schema.workflowVersion.$inferSelect;
    event: typeof schema.domainEvent.$inferSelect;
    runId: string;
    from: number;
  },
): Promise<RunSummary> {
  const { workflow, version, event, runId } = input;
  const actor = runnerActor(event.organizationId, version.requiredPermissions);
  const steps = version.steps as { kind: string; config?: Record<string, unknown> }[];

  const done = new Set(
    (await tx.select({ index: schema.workflowStepRun.stepIndex })
      .from(schema.workflowStepRun)
      .where(and(
        eq(schema.workflowStepRun.runId, runId),
        eq(schema.workflowStepRun.status, "succeeded"),
      ))).map((r: { index: number }) => r.index),
  );
  let completed = done.size;

  for (const [index, step] of steps.entries()) {
    if (index < input.from || done.has(index)) continue;

    const [stepRow] = await tx.insert(schema.workflowStepRun).values({
      organizationId: event.organizationId,
      runId,
      stepIndex: index,
      stepKind: step.kind,
      status: "running",
      input: step.config ?? {},
      startedAt: new Date(),
    }).returning({ id: schema.workflowStepRun.id });

    let result: StepResult;
    try {
      result = await perform(tx, { ...ctx, actor }, step, event, runId);
    } catch (error) {
      result = { ok: false, reason: (error as Error).message };
    }

    const waitUntil = result.ok && "waitUntil" in result ? result.waitUntil : null;

    await tx.update(schema.workflowStepRun).set({
      status: result.ok ? "succeeded" : "failed",
      output: result.ok
        ? { ...(result.output ?? {}), ...(waitUntil ? { waitUntil: waitUntil.toISOString() } : {}) }
        : {},
      error: result.ok ? null : result.reason,
      finishedAt: new Date(),
      attempts: 1,
    }).where(eq(schema.workflowStepRun.id, stepRow!.id));

    if (waitUntil) {
      /**
       * Parked, not finished. The step itself succeeded, so a resume starts
       * at the one after it, and the time lives on the row rather than in a
       * timer this process is holding.
       */
      await tx.update(schema.workflowRun).set({
        status: "waiting", resumeAt: waitUntil, resumeStepIndex: index + 1,
      }).where(eq(schema.workflowRun.id, runId));
      return {
        workflowId: workflow.id, runId, status: "waiting",
        resumeAt: waitUntil, steps: completed + 1,
      };
    }

    if (!result.ok) {
      /**
       * Stop at the first failure rather than carrying on. A workflow is a
       * sequence, and a later step that assumes an earlier one happened will
       * do something wrong rather than nothing. The run stays failed with the
       * step recorded, so a retry resumes from a known place.
       */
      await tx.update(schema.workflowRun).set({
        status: "failed", error: `step ${index} (${step.kind}): ${result.reason}`,
        finishedAt: new Date(), resumeAt: null, resumeStepIndex: null,
      }).where(eq(schema.workflowRun.id, runId));
      return { workflowId: workflow.id, runId, status: "failed", reason: result.reason, steps: completed };
    }
    completed += 1;
  }

  await tx.update(schema.workflowRun).set({
    status: "succeeded", finishedAt: new Date(), resumeAt: null, resumeStepIndex: null,
  }).where(eq(schema.workflowRun.id, runId));

  return { workflowId: workflow.id, runId, status: "succeeded", steps: completed };
}

async function perform(
  tx: Database,
  ctx: ServiceContext,
  step: { kind: string; config?: Record<string, unknown> },
  event: typeof schema.domainEvent.$inferSelect,
  runId: string,
): Promise<StepResult> {
  /**
   * The permission is checked here, against the actor the run was given,
   * rather than trusted from publish time. A version published when its
   * author held `message:send` must not keep sending after that permission
   * was reconsidered, and the stored list is a record of what was approved
   * rather than a standing grant.
   */
  const needed = automation.STEP_PERMISSIONS[step.kind];
  if (!needed) return { ok: false, reason: `unknown step kind: ${step.kind}` };

  const held = new Set(ctx.actor.grants ?? []);
  const missing = needed.filter((p) => !held.has(p));
  if (missing.length > 0) {
    return { ok: false, reason: `run lacks ${missing.join(", ")}` };
  }

  switch (step.kind) {
    case "send_message":
      return sendMessage(tx, ctx, step.config ?? {}, event, runId);
    case "create_task":
      return createTask(tx, ctx, step.config ?? {}, event, runId);
    case "wait":
      return waitStep(step.config ?? {});
    default:
      return { ok: false, reason: `step kind not implemented: ${step.kind}` };
  }
}

export { emit, comms };

/**
 * Pick a parked run back up.
 *
 * The claim is a conditional update: status must still be `waiting` and the
 * resume time must still be the one we read. Two workers that both see a run
 * due means exactly one continues it, which matters more here than almost
 * anywhere else, because the steps after a wait are the ones that message
 * the customer.
 */
export async function resume(
  tx: Database,
  ctx: ServiceContext,
  input: { runId: string; now: Date },
): Promise<RunSummary> {
  /**
   * THE CLAIM IS THE ONLY DECISION.
   *
   * An earlier version read the run first, decided whether it was waiting and
   * due, and then repeated both conditions in the update. Two copies of one
   * decision, and the read was the one the tests were exercising: taking the
   * status off the update changed nothing that any test could see, because
   * the read had already turned the loser away in the cases they covered.
   *
   * Now the update decides. Two concurrent updates both matching
   * `status = 'waiting'` serialise on the row, the second re-evaluates after
   * the first commits, sees `running` and matches nothing. Same mechanism as
   * claiming a task.
   *
   * Matching on the resume time exactly looked like belt and braces and was a
   * bug: Postgres stores microseconds and a JavaScript Date holds
   * milliseconds, so a time written by the database and read back through the
   * driver no longer equals itself, and every resume decided somebody else
   * had it.
   */
  const [claimed] = await tx.update(schema.workflowRun)
    .set({ status: "running", resumeAt: null })
    .where(and(
      eq(schema.workflowRun.id, input.runId),
      eq(schema.workflowRun.status, "waiting"),
      lte(schema.workflowRun.resumeAt, input.now),
    ))
    .returning({
      id: schema.workflowRun.id,
      workflowId: schema.workflowRun.workflowId,
      versionId: schema.workflowRun.versionId,
      eventId: schema.workflowRun.eventId,
      resumeStepIndex: schema.workflowRun.resumeStepIndex,
    });

  if (!claimed) {
    // One read, only to say which of the three it was. Nothing branches on it.
    const [row] = await tx.select({
      workflowId: schema.workflowRun.workflowId,
      status: schema.workflowRun.status,
      resumeAt: schema.workflowRun.resumeAt,
    }).from(schema.workflowRun).where(eq(schema.workflowRun.id, input.runId)).limit(1);

    if (!row) return { workflowId: "", runId: null, status: "skipped", reason: "no_run", steps: 0 };
    const reason = row.status !== "waiting"
      ? "claimed_elsewhere"
      : row.resumeAt && row.resumeAt > input.now ? "not_due" : "not_waiting";
    return { workflowId: row.workflowId, runId: input.runId, status: "skipped", reason, steps: 0 };
  }

  const base = { workflowId: claimed.workflowId, runId: claimed.id };

  const [row] = await tx.select({ workflow: schema.workflow, version: schema.workflowVersion })
    .from(schema.workflow)
    .innerJoin(schema.workflowVersion, eq(schema.workflowVersion.id, claimed.versionId))
    .where(eq(schema.workflow.id, claimed.workflowId))
    .limit(1);

  /**
   * THE VERSION THE RUN STARTED ON, not the workflow's current one. A
   * workflow edited during a three day wait must finish the run it began:
   * resuming into new steps would mean a customer receiving something from a
   * definition that did not exist when the run started, and the permissions
   * it acts with were approved against the old one.
   */
  if (!row) {
    await tx.update(schema.workflowRun).set({
      status: "failed", error: "the version this run started on is gone",
      finishedAt: new Date(), resumeStepIndex: null,
    }).where(eq(schema.workflowRun.id, claimed.id));
    return { ...base, status: "failed", reason: "version_gone", steps: 0 };
  }

  const [event] = await tx.select().from(schema.domainEvent)
    .where(eq(schema.domainEvent.id, claimed.eventId ?? "")).limit(1);
  if (!event) {
    await tx.update(schema.workflowRun).set({
      status: "failed", error: "the event this run started from is gone",
      finishedAt: new Date(), resumeStepIndex: null,
    }).where(eq(schema.workflowRun.id, claimed.id));
    return { ...base, status: "failed", reason: "event_gone", steps: 0 };
  }

  return advance(tx, ctx, {
    workflow: row.workflow, version: row.version, event,
    runId: claimed.id, from: claimed.resumeStepIndex ?? 0,
  });
}
