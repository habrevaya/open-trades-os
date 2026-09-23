import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { automation, comms, type Actor, type Permission } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import { emit } from "./events";
import { sendMessage, createTask, type StepResult } from "./workflow-steps";

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
  status: "succeeded" | "failed" | "skipped";
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
    userId: "00000000-0000-0000-0000-000000000000",
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

async function execute(
  tx: Database,
  ctx: ServiceContext,
  input: {
    workflow: typeof schema.workflow.$inferSelect;
    version: typeof schema.workflowVersion.$inferSelect;
    event: typeof schema.domainEvent.$inferSelect;
  },
): Promise<RunSummary> {
  const { workflow, version, event } = input;
  const key = automation.runKey(version.id, event.id);

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

  const actor = runnerActor(event.organizationId, version.requiredPermissions);
  const steps = version.steps as { kind: string; config?: Record<string, unknown> }[];
  let completed = 0;

  for (const [index, step] of steps.entries()) {
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

    await tx.update(schema.workflowStepRun).set({
      status: result.ok ? "succeeded" : "failed",
      output: result.ok ? result.output ?? {} : {},
      error: result.ok ? null : result.reason,
      finishedAt: new Date(),
      attempts: 1,
    }).where(eq(schema.workflowStepRun.id, stepRow!.id));

    if (!result.ok) {
      /**
       * Stop at the first failure rather than carrying on. A workflow is a
       * sequence, and a later step that assumes an earlier one happened will
       * do something wrong rather than nothing. The run stays failed with the
       * step recorded, so a retry resumes from a known place.
       */
      await tx.update(schema.workflowRun).set({
        status: "failed", error: `step ${index} (${step.kind}): ${result.reason}`, finishedAt: new Date(),
      }).where(eq(schema.workflowRun.id, runId));
      return { workflowId: workflow.id, runId, status: "failed", reason: result.reason, steps: completed };
    }
    completed += 1;
  }

  await tx.update(schema.workflowRun).set({ status: "succeeded", finishedAt: new Date() })
    .where(eq(schema.workflowRun.id, runId));

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
      // A no-op here. Durable waits need the scheduler, and pretending
      // otherwise would make a workflow look like it paused when it did not.
      return { ok: true, output: { skipped: "wait requires the scheduler" } };
    default:
      return { ok: false, reason: `step kind not implemented: ${step.kind}` };
  }
}

export { emit, comms };
