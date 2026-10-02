import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, automation, events, permissionsFor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { SHAPES } from "./workflow-dwell";
import { refusingDuplicate } from "./duplicates";
import { policyFor, reviewUrlFor } from "./reviews";

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
  dwell: { shape: string; afterDays: number } | null;
  /** The dwell in words, when there is one. */
  dwellText: string | null;
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
        dwell: row.workflow.dwell ?? null,
        dwellText: describeDwell(row.workflow.dwell),
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
      dwellText: describeDwell(row.workflow.dwell),
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
  triggerKind: "event" | "schedule" | "dwell";
  /** Event names, when the trigger is an event. */
  triggerEvents?: string[];
  /** A five field cron, when the trigger is a schedule. */
  schedule?: string;
  /** Which shape of record, and for how long, when the trigger is a dwell. */
  dwell?: { shape: string; afterDays: number };
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
function check(
  ctx: ServiceContext,
  input: WorkflowInput,
  /** Names this company's log already holds, which stay valid whatever this build emits. */
  seenEvents: ReadonlySet<string> = new Set(),
): string | null {
  if (input.name.trim() === "") return "An automation needs a name.";
  if (input.steps.length === 0) return "An automation needs at least one step.";

  /**
   * BRANCH ARMS, BRACKET MATCHED, AT THE SAVE.
   *
   * A branch counts the steps that follow it, so a list whose arms overlap or run
   * off the end describes something no reading of it predicts. Refused here
   * because this is the only moment anybody can fix it: the alternative is a
   * workflow that saves, enables, and then skips a step nobody expected, which
   * reads on the run screen as a step that simply did not happen.
   *
   * The first problem only. A list with three of them is a list somebody is still
   * writing, and four sentences at once is harder to act on than the first.
   */
  const armProblems = automation.checkBranches(input.steps);
  if (armProblems.length > 0) return automation.explainBranch(armProblems[0]!);

  /**
   * A re-check naming a question this build cannot ask would stop every run
   * at that step with a failure, so it is refused here where it can be fixed.
   */
  const badCheck = input.steps.find((step) =>
    step.kind === "stop_unless" && !automation.isCheck(step.config?.["check"]));
  if (badCheck) {
    return `This build cannot check ${String(badCheck.config?.["check"] ?? "nothing")}. `
      + `Choose one of: ${Object.values(automation.CHECKS).map((c) => c.label.toLowerCase()).join("; ")}.`;
  }

  if (input.triggerKind === "event") {
    if ((input.triggerEvents ?? []).length === 0) {
      return "An event automation needs at least one event to trigger on.";
    }
    /**
     * REFUSED AT THE SAVE, because there is no later moment.
     *
     * An automation subscribed to an event nothing emits saves, enables,
     * appears in the list and never runs. There is no error, no log line
     * and no screen that can tell it apart from a quiet month: a
     * subscription matching nothing looks exactly like nothing having
     * happened.
     *
     * A name the log has ALREADY SEEN is allowed even if this version does
     * not emit it. It is a real thing in that company's history, written by
     * an older build or a migration, and refusing it would break automations
     * that work.
     */
    const unknown = (input.triggerEvents ?? []).filter(
      (name) => !events.isEventName(name) && !seenEvents.has(name),
    );
    if (unknown.length > 0) {
      return `Nothing in this product emits ${unknown.join(" or ")}, so an automation on it would `
        + "never run. Pick an event from the list.";
    }
    const silent = (input.triggerEvents ?? []).filter(
      (name) => events.isEventName(name)
        && !(events.SUBSCRIBABLE as string[]).includes(name)
        && !seenEvents.has(name),
    );
    if (silent.length > 0) {
      const owed = silent.map((name) => events.eventSpec(name as events.EventName).owedBy).filter(Boolean);
      return `${silent.join(" and ")} is not emitted yet, so an automation on it would never run.`
        + (owed.length > 0 ? ` ${owed.join(" ")}` : "");
    }
  } else if (input.triggerKind === "schedule") {
    if (!input.schedule) return "A scheduled automation needs a schedule.";
    const parsed = automation.parseSchedule(input.schedule);
    if (!parsed.ok) return parsed.reason;
  } else {
    if (!input.dwell) return "A waiting automation needs something to wait on.";
    if (!SHAPES.some((shape) => shape.key === input.dwell!.shape)) {
      /**
       * Refused rather than saved. A workflow pointing at a shape this build
       * does not have is a workflow that silently never fires, and silently
       * never firing is the automation failure nobody notices until a
       * customer does.
       */
      return `This build has no such thing to wait on: ${input.dwell.shape}.`;
    }
    const days = Number(input.dwell.afterDays);
    if (!Number.isFinite(days) || days < 0) return "How many days is not a number.";
    if (days > 365) return "A wait of more than a year is somebody's units being wrong.";
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
 * Event names this company's log already holds.
 *
 * Read inside the transaction that is about to validate, so a workflow
 * subscribing to something an older build emitted stays valid. Refusing
 * those would break automations that work, which is a worse outcome than
 * allowing a name this version happens not to know.
 */
async function seenEventNames(tx: Database, organizationId: string): Promise<Set<string>> {
  const rows = await tx.selectDistinct({ name: schema.domainEvent.name })
    .from(schema.domainEvent)
    .where(eq(schema.domainEvent.organizationId, organizationId));
  return new Set(rows.map((row: { name: string }) => row.name));
}

/**
 * Create a workflow and publish its first version, switched off.
 *
 * Off, deliberately. A new automation that starts running the moment it is
 * saved sends its first message before anybody has read it back.
 */
export async function create(ctx: ServiceContext, input: WorkflowInput) {
  return guardedWrite(ctx, "workflow:write", (tx) => createWithin(tx, ctx, input));
}

/**
 * The body of `create`, inside a transaction the caller holds, so installing a
 * recommended automation is this exact path and not a second one: the same
 * check, the same permission rule, the same first version.
 */
async function createWithin(
  tx: Database,
  ctx: ServiceContext,
  input: WorkflowInput,
  options: { templateKey?: string; enabled?: boolean } = {},
) {
  const refusal = check(ctx, input, await seenEventNames(tx, ctx.actor.organizationId));
  if (refusal) throw new ConflictError(refusal);

  const required = automation.canPublish(permissionsFor(ctx.actor), input.steps);
  if (!required.ok) throw new ConflictError("This definition cannot be published.");

  const [workflow] = await refusingDuplicate(
    "workflow_template_idx",
    "That recommended automation is already installed. Open it from the list to change it, "
      + "or delete it first to start again from the recommended version.",
    () => tx.insert(schema.workflow).values({
      organizationId: ctx.actor.organizationId,
      name: input.name.trim(),
      description: input.description ?? null,
      enabled: options.enabled ?? false,
      triggerKind: input.triggerKind,
      triggerEvents: input.triggerKind === "event" ? (input.triggerEvents ?? []) : [],
      schedule: input.triggerKind === "schedule" ? (input.schedule ?? null) : null,
      dwell: input.triggerKind === "dwell" ? (input.dwell ?? null) : null,
      templateKey: options.templateKey ?? null,
      createdByUserId: ctx.actor.userId,
    }).returning(),
  );

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

    const refusal = check(ctx, input, await seenEventNames(tx, ctx.actor.organizationId));
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
      dwell: input.triggerKind === "dwell" ? (input.dwell ?? null) : null,
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
 * The events a workflow can trigger on.
 *
 * This was a hand written list of fourteen names that nothing kept in step
 * with the emitters. Exactly ONE of the fourteen was ever emitted. A company
 * building "when an invoice is paid, text the customer" got a workflow that
 * saved, enabled, appeared in the list and never fired, and nothing logs a
 * subscription matching nothing, because matching nothing is what a quiet
 * week looks like. It failed the other way too: five events the product did
 * emit were absent, so the one part of it with a working event stream could
 * not be automated.
 *
 * It now comes from the catalogue in core, which `emit` is typed against, so
 * the two lists cannot drift: a name in one and not the other is a compile
 * error.
 *
 * NAMES THE LOG HAS SEEN ARE STILL INCLUDED, and deliberately. An event
 * written by an older version of this product, or by a migration, is a real
 * thing in that company's history and a workflow should be able to reach it.
 * What is no longer possible is offering a name that has neither been
 * emitted nor declared.
 */
export async function triggerEvents(ctx: ServiceContext): Promise<string[]> {
  /**
   * CHECKED, although the catalogue half is a constant.
   *
   * The other half is this company's own event log, read through `inTenant`, which
   * sets the tenant and does NOT check a permission: that is what `guardedRead`
   * adds on top of it. So the distinct names a company has ever emitted, which is
   * a sketch of what that company does, were readable by anybody with a session.
   *
   * Caught by `permission-declarations.test.ts`, which probes every route with an
   * actor holding nothing and fails on one that answers. The route has always
   * declared `workflow:read`; now so does the service.
   */
  assertCan(ctx.actor, "workflow:read");
  const seen = await inTenant(ctx, async (tx) =>
    tx.selectDistinct({ name: schema.domainEvent.name }).from(schema.domainEvent));
  return [...new Set([
    ...events.SUBSCRIBABLE,
    ...seen.map((r: { name: string }) => r.name),
  ])].sort();
}

/**
 * The same list with what each one means, for a builder that can show it.
 *
 * A column of `agreement.visit_unskipped` next to a checkbox asks somebody
 * to guess. The summary is the sentence they are completing.
 *
 * A name this company's log holds and the catalogue does not gets a null
 * summary rather than being dropped. It is a real event in their history and
 * an automation on it works; what it does not have is a sentence, and
 * showing the bare name is better than hiding a trigger that fires.
 */
export async function triggerEventCatalogue(
  ctx: ServiceContext,
): Promise<{ name: string; summary: string | null }[]> {
  const names = await triggerEvents(ctx);
  return names.map((name) => ({
    name,
    summary: events.isEventName(name) ? events.eventSpec(name).summary : null,
  }));
}

/** The steps this build can actually perform, with what each one needs. */
export function availableSteps(ctx: ServiceContext) {
  /**
   * Seeing what the engine can do is reading an automation, so it takes the same
   * permission. The list is a constant and the `allowed` flag beside each step is
   * the caller's own, which is exactly the pair a role was meant to gate.
   */
  assertCan(ctx.actor, "workflow:read");
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
  {
    kind: "branch",
    label: "Only if",
    description:
      "Runs the steps under it when a condition holds, and the steps under Otherwise when it does not.",
  },
  {
    kind: "stop_unless",
    label: "Stop unless still true",
    description:
      "Looks again, after a wait, and ends the run quietly if the answer has changed. "
      + "The estimate being approved on day two is the follow up working.",
  },
  {
    kind: "send_estimate",
    label: "Send the estimate link",
    description:
      "Texts or emails the customer a fresh link to their estimate, while it is still waiting for an answer.",
  },
  {
    kind: "request_review",
    label: "Ask whether to ask for a review",
    description:
      "Puts the job to your review rules: who may be asked, how often, how soon and how late. Waits if they say later.",
  },
  {
    kind: "send_review_request",
    label: "Send the review request",
    description: "Sends the ask your review rules queued for the job, with the link to your review site.",
  },
];

/** The things an automation can wait on, as the screen has to name them. */
export function dwellShapes() {
  return SHAPES.map((shape) => ({
    key: shape.key, label: shape.label, question: shape.question,
  }));
}

/** A dwell in words, for a screen that has to show what is set. */
export function describeDwell(
  dwell: { shape: string; afterDays: number } | null | undefined,
): string | null {
  if (!dwell) return null;
  const shape = SHAPES.find((s) => s.key === dwell.shape);
  if (!shape) return `Waiting on something this build does not have: ${dwell.shape}`;
  const days = dwell.afterDays;
  return `${shape.label}, after ${days} ${days === 1 ? "day" : "days"}`;
}

/* ---------------------------------------------------- recommended automations */

export interface RecommendedAutomation {
  key: string;
  name: string;
  summary: string;
  needs: string;
  parameters: automation.TemplateParameter[];
  /** The workflow it installed, when it is installed. An ordinary one, edited on the canvas. */
  installed: { id: string; enabled: boolean; name: string } | null;
  /** Why it cannot be turned on yet, in words, or null when it can. */
  blockedBy: string | null;
  /** For a platform parameter: the review sites declared with a link. */
  platforms: { platform: string; displayName: string }[];
}

/**
 * The recommended list, and whether each is on.
 *
 * "On" means a live workflow installed from that template exists. Edited,
 * renamed or switched off, it is still that install, because the label on
 * the row is what the list reads and the steps are whatever the company made
 * them. Deleted, it is not, and the template can be turned on again.
 */
export async function recommended(ctx: ServiceContext): Promise<RecommendedAutomation[]> {
  return guardedRead(ctx, "workflow:read", async (tx) => {
    const installs = await tx.select({
      id: schema.workflow.id,
      name: schema.workflow.name,
      enabled: schema.workflow.enabled,
      templateKey: schema.workflow.templateKey,
    }).from(schema.workflow)
      .where(and(isNull(schema.workflow.deletedAt), sql`${schema.workflow.templateKey} is not null`));

    const platforms = (await tx.select({
      platform: schema.reviewPlatform.platform,
      displayName: schema.reviewPlatform.displayName,
      reviewUrl: schema.reviewPlatform.reviewUrl,
    }).from(schema.reviewPlatform)
      .where(and(eq(schema.reviewPlatform.active, true), isNull(schema.reviewPlatform.deletedAt))))
      .filter((p) => (p.reviewUrl ?? "").trim() !== "")
      .map((p) => ({ platform: p.platform, displayName: p.displayName }));

    const hasPolicy = await policyFor(tx, ctx.actor.organizationId).then(() => true, () => false);

    return automation.TEMPLATES.map((template) => {
      const install = installs.find((row) => row.templateKey === template.key);
      let blockedBy: string | null = null;
      if (template.key === "review_after_paid") {
        if (!hasPolicy) {
          blockedBy = "Set your review rules first, under Reviews: how soon after a job, how often at most, and how late in the day.";
        } else if (platforms.length === 0) {
          blockedBy = "Declare where your customers leave reviews, with its link, under Reviews first.";
        }
      }
      return {
        key: template.key,
        name: template.name,
        summary: template.summary,
        needs: template.needs,
        parameters: template.parameters,
        installed: install ? { id: install.id, enabled: install.enabled, name: install.name } : null,
        blockedBy,
        platforms: template.parameters.some((p) => p.kind === "platform") ? platforms : [],
      };
    });
  });
}

/**
 * Turn a recommended automation on: install it as an ordinary workflow and
 * switch it on, in one step.
 *
 * ON, unlike a workflow made on the canvas, which starts off. The canvas
 * starts off because nobody has read back what they drew; here the person has
 * just read what it does in a sentence and pressed "Turn on", and an install
 * that then sat switched off would be the automation they believe they have
 * and do not.
 *
 * THE SAME PATH AS ANY OTHER WORKFLOW. `createWithin` checks the definition,
 * refuses a step the installer may not publish and records the permissions the
 * run will hold, so a template is not a way to acquire authority. What is
 * checked here in addition is what the template needs from the company to do
 * anything at all, and a refusal says what to set up.
 */
export async function installTemplate(
  ctx: ServiceContext,
  input: { key: string; values?: Record<string, unknown> | undefined },
) {
  return guardedWrite(ctx, "workflow:write", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "workflow_template_install"),
        )).limit(1);
      if (seen?.entityId) {
        const [row] = await tx.select().from(schema.workflow)
          .where(eq(schema.workflow.id, seen.entityId)).limit(1);
        if (row) return { id: row.id, name: row.name, enabled: row.enabled, templateKey: row.templateKey };
      }
    }

    const built = automation.buildTemplate(input.key, input.values ?? {});
    if (!built.ok) throw new ConflictError(built.reason);

    if (input.key === "review_after_paid") {
      await policyFor(tx, ctx.actor.organizationId);
      const platform = String(input.values?.["platform"] ?? "");
      if (!(await reviewUrlFor(tx, platform))) {
        throw new ConflictError(
          `${platform} is not a review site you have declared with a link, so there would be nowhere to send them. `
          + "Declare it under Reviews first.",
        );
      }
    }

    const workflow = await createWithin(tx, ctx, {
      name: built.definition.name,
      description: built.definition.description,
      triggerKind: built.definition.triggerKind,
      triggerEvents: built.definition.triggerEvents,
      steps: automation.flattenPlan(built.definition.steps)
        .map((step) => ({ kind: step.kind, config: step.config ?? {} })),
    }, { templateKey: input.key, enabled: true });

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        idempotencyKey: ctx.idempotencyKey,
        entityType: "workflow_template_install",
        entityId: workflow.id,
        direction: "inbound",
        provider: "api",
        eventType: "workflow_template.installed",
        status: "succeeded",
      });
    }

    await audit(tx, ctx, "workflow.installed_from_template", "workflow", workflow.id, null,
      { templateKey: input.key, values: input.values ?? {} });
    return { id: workflow.id, name: workflow.name, enabled: workflow.enabled, templateKey: input.key };
  });
}

export const handlers = {
  listWorkflows: async (ctx: ServiceContext) => ({
    workflows: (await list(ctx)).map((row) => ({
      ...row,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      recent: row.recent.map((r) => ({ status: r.status, at: r.at?.toISOString() ?? null })),
    })),
  }),

  /**
   * The runs only, not the workflow row beside them.
   *
   * `detail` hands back the drizzle rows for the workflow, its version and its
   * schedule state, which is right for a screen that already has the summary and
   * wrong to publish: declaring every column of three tables in a contract makes
   * the API's shape the schema's shape, and a column added for an internal reason
   * becomes a published promise. The summary list is the published shape of a
   * workflow; this route answers the question the summary cannot.
   */
  getWorkflowRuns: async (ctx: ServiceContext, input: { id: string; runs?: number | undefined }) => {
    const found = await detail(ctx, { id: input.id, ...(input.runs ? { runs: input.runs } : {}) });
    return {
      runs: found.runs.map((run) => ({
        ...run,
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        resumeAt: run.resumeAt?.toISOString() ?? null,
      })),
    };
  },

  setWorkflowEnabled: async (ctx: ServiceContext, input: { id: string; enabled: boolean }) => {
    const after = await setEnabled(ctx, input);
    return { id: after.id, enabled: after.enabled };
  },

  listWorkflowEvents: async (ctx: ServiceContext) => ({
    events: await triggerEventCatalogue(ctx),
  }),

  /**
   * Async although it reads nothing: the handler table takes one shape, and a
   * synchronous entry is a different type the registry cannot hold.
   */
  listWorkflowSteps: async (ctx: ServiceContext) => ({ steps: availableSteps(ctx) }),

  listWorkflowTemplates: async (ctx: ServiceContext) => ({ templates: await recommended(ctx) }),

  installWorkflowTemplate: (ctx: ServiceContext, input: {
    key: string; values?: Record<string, string | number> | undefined;
  }) => installTemplate(ctx, input),
} as const;
