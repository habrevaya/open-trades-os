import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { automation, permissionsFor } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * AUTOMATIONS, AS SOMETHING A PERSON CAN SEE AND TURN OFF
 *
 * The engine has been running for a while and the only way to make a workflow
 * was to insert rows by hand. Worse, the only way to STOP one was the same.
 * An automation sending the wrong thing to customers and no button to stop it
 * is the failure that ends a trial, and it is a worse one than the automation
 * not existing.
 *
 * So this is deliberately not a visual builder. It is: what exists, what it
 * did, and make it stop. The definitions it can write cover the shapes the
 * engine actually implements, and a definition naming a step this build does
 * not have is refused at publish rather than dropped at run time.
 */

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  triggerKind: string;
  triggerEvents: string[];
  schedule: string | null;
  /** The schedule in words, when there is one. */
  scheduleText: string | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  /** Why it is not firing, when it is not. */
  scheduleError: string | null;
  version: number | null;
  steps: { kind: string }[];
  /** How the last few runs went, newest first. */
  recent: { status: string; at: Date | null }[];
}

export async function list(ctx: ServiceContext): Promise<WorkflowSummary[]> {
  return guardedRead(ctx, "workflow:read", async (tx) => {
    const rows = await tx.select({
      workflow: schema.workflow,
      version: schema.workflowVersion,
      scheduleState: schema.workflowSchedule,
    })
      .from(schema.workflow)
      .leftJoin(schema.workflowVersion, eq(schema.workflowVersion.id, schema.workflow.activeVersionId))
      .leftJoin(schema.workflowSchedule, eq(schema.workflowSchedule.workflowId, schema.workflow.id))
      .where(isNull(schema.workflow.deletedAt))
      .orderBy(schema.workflow.name);

    const summaries: WorkflowSummary[] = [];
    for (const row of rows) {
      const recent = await tx.select({
        status: schema.workflowRun.status,
        at: schema.workflowRun.startedAt,
      })
        .from(schema.workflowRun)
        .where(eq(schema.workflowRun.workflowId, row.workflow.id))
        .orderBy(desc(schema.workflowRun.createdAt))
        .limit(5);

      summaries.push({
        id: row.workflow.id,
        name: row.workflow.name,
        description: row.workflow.description,
        enabled: row.workflow.enabled,
        triggerKind: row.workflow.triggerKind,
        triggerEvents: row.workflow.triggerEvents ?? [],
        schedule: row.workflow.schedule,
        scheduleText: row.workflow.schedule
          ? automation.describeSchedule(row.workflow.schedule)
          : null,
        nextRunAt: row.scheduleState?.nextRunAt ?? null,
        lastRunAt: row.scheduleState?.lastRunAt ?? null,
        scheduleError: row.scheduleState?.lastError ?? null,
        version: row.version?.version ?? null,
        steps: (row.version?.steps as { kind: string }[] | undefined) ?? [],
        recent,
      });
    }
    return summaries;
  });
}

export interface RunDetail {
  id: string;
  status: string;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  resumeAt: Date | null;
  eventName: string | null;
  steps: {
    index: number;
    kind: string;
    status: string;
    error: string | null;
    output: Record<string, unknown> | null;
  }[];
}

/**
 * One workflow and how its recent runs went, step by step.
 *
 * The step rows are the whole point of the screen. "Why did this customer get
 * that text in March" is the question this answers, and a run row on its own
 * says only that something happened.
 */
export async function detail(ctx: ServiceContext, input: { id: string; runs?: number }) {
  return guardedRead(ctx, "workflow:read", async (tx) => {
    const [row] = await tx.select({
      workflow: schema.workflow,
      version: schema.workflowVersion,
      scheduleState: schema.workflowSchedule,
    })
      .from(schema.workflow)
      .leftJoin(schema.workflowVersion, eq(schema.workflowVersion.id, schema.workflow.activeVersionId))
      .leftJoin(schema.workflowSchedule, eq(schema.workflowSchedule.workflowId, schema.workflow.id))
      .where(and(eq(schema.workflow.id, input.id), isNull(schema.workflow.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundError("Workflow");

    const runRows = await tx.select({
      run: schema.workflowRun,
      eventName: schema.domainEvent.name,
    })
      .from(schema.workflowRun)
      .leftJoin(schema.domainEvent, eq(schema.domainEvent.id, schema.workflowRun.eventId))
      .where(eq(schema.workflowRun.workflowId, input.id))
      .orderBy(desc(schema.workflowRun.createdAt))
      .limit(input.runs ?? 20);

    const runs: RunDetail[] = [];
    for (const r of runRows) {
      const steps = await tx.select().from(schema.workflowStepRun)
        .where(eq(schema.workflowStepRun.runId, r.run.id))
        .orderBy(schema.workflowStepRun.stepIndex);

      runs.push({
        id: r.run.id,
        status: r.run.status,
        error: r.run.error,
        startedAt: r.run.startedAt,
        finishedAt: r.run.finishedAt,
        resumeAt: r.run.resumeAt,
        eventName: r.eventName,
        steps: steps.map((s) => ({
          index: s.stepIndex,
          kind: s.stepKind,
          status: s.status,
          error: s.error,
          output: s.output,
        })),
      });
    }

    return {
      workflow: row.workflow,
      version: row.version,
      scheduleState: row.scheduleState,
      scheduleText: row.workflow.schedule
        ? automation.describeSchedule(row.workflow.schedule)
        : null,
      runs,
    };
  });
}

/**
 * On or off.
 *
 * The most important control on the screen, and the reason the screen
 * exists. An automation misbehaving is a thing somebody needs to stop in
 * seconds, without a deploy and without a database client.
 *
 * Switching one off does not touch runs already in flight. A run that is
 * waiting on a clock finishes what it started, because stopping halfway
 * through leaves the customer with half a conversation.
 */
export async function setEnabled(ctx: ServiceContext, input: { id: string; enabled: boolean }) {
  return guardedWrite(ctx, "workflow:write", async (tx) => {
    const [before] = await tx.select().from(schema.workflow)
      .where(and(eq(schema.workflow.id, input.id), isNull(schema.workflow.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Workflow");

    if (input.enabled && !before.activeVersionId) {
      // Enabled with nothing published does nothing, and looks like it does
      // something, which is the worst combination.
      throw new ConflictError("This workflow has no published version to run.");
    }

    const [after] = await tx.update(schema.workflow)
      .set({ enabled: input.enabled, updatedAt: new Date() })
      .where(eq(schema.workflow.id, input.id))
      .returning();

    /**
     * The schedule row goes with it. A workflow switched off keeps its due
     * time and would fire the moment it came back on, possibly for an
     * occurrence weeks in the past; clearing it means the clock is planned
     * fresh from the next tick.
     */
    if (!input.enabled) {
      await tx.update(schema.workflowSchedule)
        .set({ nextRunAt: null, expression: "", updatedAt: new Date() })
        .where(eq(schema.workflowSchedule.workflowId, input.id));
    }

    await audit(tx, ctx, input.enabled ? "workflow.enabled" : "workflow.disabled",
      "workflow", input.id, before, after);
    return after!;
  });
}

export interface WorkflowInput {
  name: string;
  description?: string;
  triggerKind: "event" | "schedule";
  /** Event names, when the trigger is an event. */
  triggerEvents?: string[];
  /** A five field cron, when the trigger is a schedule. */
  schedule?: string;
  conditions?: automation.ConditionGroup;
  steps: { kind: string; config?: Record<string, unknown> }[];
}

/**
 * Validate a definition the way the engine will read it.
 *
 * Shared by create and publish so the two cannot disagree about what is
 * acceptable, and refusing here rather than at run time is the difference
 * between a message somebody can act on and a workflow that quietly fails
 * every night.
 */
function check(ctx: ServiceContext, input: WorkflowInput): string | null {
  if (input.name.trim() === "") return "An automation needs a name.";
  if (input.steps.length === 0) return "An automation needs at least one step.";

  if (input.triggerKind === "event") {
    if ((input.triggerEvents ?? []).length === 0) {
      return "An event automation needs at least one event to trigger on.";
    }
  } else {
    if (!input.schedule) return "A scheduled automation needs a schedule.";
    const parsed = automation.parseSchedule(input.schedule);
    if (!parsed.ok) return parsed.reason;
  }

  /**
   * YOU CANNOT GRANT WHAT YOU DO NOT HOLD.
   *
   * `canPublish` has been in core since the engine was written, tested, and
   * called by nothing: the only way to publish was an insert. A workflow is
   * a container for permissions, so somebody who can write workflows and
   * cannot send messages must not be able to publish one that sends them.
   */
  const decision = automation.canPublish(permissionsFor(ctx.actor), input.steps);
  if (!decision.ok) {
    return decision.reason === "unknown_step"
      ? `This build has no step called: ${decision.kinds.join(", ")}.`
      : `You do not hold: ${decision.permissions.join(", ")}.`;
  }
  return null;
}

/**
 * Create a workflow and publish its first version, switched off.
 *
 * Off, deliberately. A new automation that starts running the moment it is
 * saved sends its first message before anybody has read it back.
 */
export async function create(ctx: ServiceContext, input: WorkflowInput) {
  return guardedWrite(ctx, "workflow:write", async (tx) => {
    const refusal = check(ctx, input);
    if (refusal) throw new ConflictError(refusal);

    const required = automation.canPublish(permissionsFor(ctx.actor), input.steps);
    if (!required.ok) throw new ConflictError("This definition cannot be published.");

    const [workflow] = await tx.insert(schema.workflow).values({
      organizationId: ctx.actor.organizationId,
      name: input.name.trim(),
      description: input.description ?? null,
      enabled: false,
      triggerKind: input.triggerKind,
      triggerEvents: input.triggerKind === "event" ? (input.triggerEvents ?? []) : [],
      schedule: input.triggerKind === "schedule" ? (input.schedule ?? null) : null,
      createdByUserId: ctx.actor.userId,
    }).returning();

    const [version] = await tx.insert(schema.workflowVersion).values({
      organizationId: ctx.actor.organizationId,
      workflowId: workflow!.id,
      version: 1,
      conditions: (input.conditions ?? {}) as Record<string, unknown>,
      steps: input.steps as Record<string, unknown>[],
      /**
       * What was approved, recorded at publish time. The run checks against
       * it again, so this is a record of what somebody signed off rather
       * than a standing grant.
       */
      requiredPermissions: required.required,
      publishedByUserId: ctx.actor.userId,
      publishedAt: new Date(),
    }).returning();

    await tx.update(schema.workflow)
      .set({ activeVersionId: version!.id })
      .where(eq(schema.workflow.id, workflow!.id));

    await audit(tx, ctx, "workflow.created", "workflow", workflow!.id, null, workflow);
    return { ...workflow!, activeVersionId: version!.id };
  });
}

/**
 * Publish a new version of an existing workflow.
 *
 * A new row rather than an edit, always. A run records which version it
 * executed, so "why did this customer get that text in March" stays
 * answerable after the workflow has been edited four times, and editing in
 * place is what makes that question unanswerable.
 */
export async function publish(ctx: ServiceContext, input: { id: string } & WorkflowInput) {
  return guardedWrite(ctx, "workflow:write", async (tx) => {
    const [before] = await tx.select().from(schema.workflow)
      .where(and(eq(schema.workflow.id, input.id), isNull(schema.workflow.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Workflow");

    const refusal = check(ctx, input);
    if (refusal) throw new ConflictError(refusal);
    const required = automation.canPublish(permissionsFor(ctx.actor), input.steps);
    if (!required.ok) throw new ConflictError("This definition cannot be published.");

    const [row] = await tx.execute<{ next: number }>(sql`
      select coalesce(max(version), 0) + 1 as next
      from public.workflow_version where workflow_id = ${input.id}`);
    const next = Number(row!.next);

    const [version] = await tx.insert(schema.workflowVersion).values({
      organizationId: ctx.actor.organizationId,
      workflowId: input.id,
      version: next,
      conditions: (input.conditions ?? {}) as Record<string, unknown>,
      steps: input.steps as Record<string, unknown>[],
      requiredPermissions: required.required,
      publishedByUserId: ctx.actor.userId,
      publishedAt: new Date(),
    }).returning();

    const [after] = await tx.update(schema.workflow).set({
      name: input.name.trim(),
      description: input.description ?? null,
      triggerKind: input.triggerKind,
      triggerEvents: input.triggerKind === "event" ? (input.triggerEvents ?? []) : [],
      schedule: input.triggerKind === "schedule" ? (input.schedule ?? null) : null,
      activeVersionId: version!.id,
      updatedAt: new Date(),
    }).where(eq(schema.workflow.id, input.id)).returning();

    await audit(tx, ctx, "workflow.published", "workflow", input.id, before, after);
    return after!;
  });
}

export async function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "workflow:write", async (tx) => {
    const [before] = await tx.select().from(schema.workflow)
      .where(and(eq(schema.workflow.id, input.id), isNull(schema.workflow.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Workflow");

    await tx.update(schema.workflow)
      .set({ deletedAt: new Date(), enabled: false })
      .where(eq(schema.workflow.id, input.id));
    await audit(tx, ctx, "workflow.deleted", "workflow", input.id, before, null);
  });
}

/**
 * The events a workflow can trigger on, as the product actually emits them.
 *
 * A free text field here is a workflow that silently never fires, because an
 * event name with a typo in it matches nothing and says nothing. Drawn from
 * what the log has actually seen, plus the ones we ship, so a company that
 * has never completed a job can still automate one.
 */
const KNOWN_EVENTS = [
  "job.created", "job.updated", "job.completed",
  "visit.scheduled", "visit.completed",
  "estimate.sent", "estimate.approved", "estimate.declined",
  "invoice.sent", "invoice.paid", "invoice.overdue",
  "payment.failed",
  "message.received",
  "booking.requested",
];

export async function triggerEvents(ctx: ServiceContext): Promise<string[]> {
  const seen = await inTenant(ctx, async (tx) =>
    tx.selectDistinct({ name: schema.domainEvent.name }).from(schema.domainEvent));
  return [...new Set([...KNOWN_EVENTS, ...seen.map((r: { name: string }) => r.name)])].sort();
}

/** The steps this build can actually perform, with what each one needs. */
export function availableSteps(ctx: ServiceContext) {
  const held = permissionsFor(ctx.actor);
  return IMPLEMENTED.map((step) => ({
    ...step,
    permissions: automation.STEP_PERMISSIONS[step.kind] ?? [],
    /**
     * Shown either way, with the reason. A step missing from the list with
     * no explanation reads as a product that cannot do the thing, rather
     * than as an account that may not.
     */
    allowed: (automation.STEP_PERMISSIONS[step.kind] ?? []).every((p) => held.has(p)),
  }));
}

/**
 * The steps with an executor behind them.
 *
 * `STEP_PERMISSIONS` lists more than this, deliberately: it is the set a
 * definition may name, including the ones a newer build might have. Offering
 * those on the screen would be offering a step that does nothing.
 */
const IMPLEMENTED = [
  {
    kind: "send_message",
    label: "Send a message",
    description: "Texts the customer, subject to the consent recorded for them.",
  },
  {
    kind: "create_task",
    label: "Raise a task",
    description: "Puts something in the office queue, attached to the record it is about.",
  },
  {
    kind: "wait",
    label: "Wait",
    description: "Pauses the run. The wait is stored, so it survives a restart.",
  },
];
