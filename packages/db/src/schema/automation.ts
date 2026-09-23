import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, primaryKey, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared";
import { organization, user } from "./tenancy";

/**
 * EVENTS AND WORKFLOWS
 *
 * Two things, and the first one is the reason the second is possible.
 *
 * `domain_event` is an append only log of things that happened in the
 * business: a job completed, an estimate was approved, an invoice went past
 * due. It already had two consumers waiting for it. `webhook_endpoint`
 * carries an `events` array and subscribes to names nothing was producing,
 * and the agent layer needs the same feed. Building the workflow engine on a
 * private queue would have made a third.
 *
 * The log is the seam. A workflow, a webhook and an agent all read the same
 * events, which means a customer can replace any one of them with their own
 * consumer and nothing else notices. That is the difference between an
 * automation feature and an automation platform, and it costs one table.
 *
 * WHAT MAKES A WORKFLOW SAFE
 *
 * A workflow acts. It sends messages, moves money and edits records, so it
 * runs with somebody's authority, and that makes authoring one a way to
 * acquire authority you do not have. It is the same shape as `role:write`:
 * a container that runs as an actor is a way to become that actor.
 *
 * So a workflow declares the permissions it needs, the author must hold every
 * one of them, and the run executes with exactly that set and nothing more.
 * Not "runs as the owner", which is the obvious implementation and hands
 * every author the owner's powers.
 */

/* ------------------------------------------------------------------ events */

/**
 * Something that happened, recorded once, in order.
 *
 * Append only and never updated. A consumer that has processed up to a
 * sequence knows exactly where it is, and a consumer added next year can
 * replay from the beginning, which is what makes a new integration a read
 * rather than a backfill script.
 */
export const domainEvent = pgTable("domain_event", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /**
   * Monotonic per organization, so a consumer's position is one number.
   * Per organization rather than global because a busy tenant must not
   * advance a quiet tenant's cursor past events it never saw.
   */
  sequence: integer("sequence").notNull(),
  /** Dotted and past tense: `job.completed`, `estimate.approved`. */
  name: text("name").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  /**
   * The state that matters, at the moment it happened. Denormalized on
   * purpose: a workflow that fires a week late must see what was true when
   * the event occurred, not what is true when it finally runs.
   */
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  /** Who or what caused it. Null for something the system did on a schedule. */
  actorUserId: uuid("actor_user_id").references(() => user.id, { onDelete: "set null" }),
  actorAgentId: text("actor_agent_id"),
  /**
   * The run that produced this event, when a workflow caused it.
   *
   * This is the loop guard. A workflow that edits a job produces an event
   * that could trigger the same workflow, and without a chain to follow the
   * only symptom is a tenant sending ten thousand texts overnight.
   */
  causedByRunId: uuid("caused_by_run_id"),
  /** How many automation hops deep this is. Cheap to check, hard to fake. */
  causationDepth: integer("causation_depth").notNull().default(0),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (t) => ({
  seqIdx: uniqueIndex("domain_event_seq_idx").on(t.organizationId, t.sequence),
  nameIdx: index("domain_event_name_idx").on(t.organizationId, t.name, t.occurredAt),
  entityIdx: index("domain_event_entity_idx").on(t.entityType, t.entityId),
}));

/* --------------------------------------------------------------- workflows */

export const triggerKind = pgEnum("trigger_kind", [
  /** Fires on a domain event. */
  "event",
  /** Fires on a clock: nightly, weekly. */
  "schedule",
  /** Fires when a record has been in a state for a period. */
  "dwell",
  /** Fires only when somebody presses a button. */
  "manual",
]);

export const workflow = pgTable("workflow", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(false),
  triggerKind: triggerKind("trigger_kind").notNull(),
  /** The event names this subscribes to, when the trigger is an event. */
  triggerEvents: jsonb("trigger_events").$type<string[]>().notNull().default([]),
  /** Cron, in the ORGANIZATION's timezone rather than the server's. */
  schedule: text("schedule"),
  /**
   * What "has been sitting there too long" means, when the trigger is a
   * dwell: which shape of record, and for how many days.
   *
   * The shapes are declared in the service rather than written here, for the
   * same reason a report names a dataset rather than a table: a workflow
   * must not be a way to write a query. What this holds is a key into that
   * list and a number of days.
   */
  dwell: jsonb("dwell").$type<{ shape: string; afterDays: number } | null>(),
  /**
   * The published version. Null while a workflow has only ever been drafted,
   * which is why it is nullable and why `enabled` alone does not mean it runs.
   */
  activeVersionId: uuid("active_version_id"),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("workflow_org_idx").on(t.organizationId, t.enabled),
}));

/**
 * A version of the definition, immutable once published.
 *
 * Same reasoning as the price book. A run records which version it executed,
 * so "why did this customer get that text in March" is answerable after the
 * workflow has been edited four times. Editing in place makes that question
 * unanswerable, and it is the question that gets asked.
 */
export const workflowVersion = pgTable("workflow_version", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  workflowId: uuid("workflow_id").notNull().references(() => workflow.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  /** Conditions the event must satisfy. Evaluated, never executed as code. */
  conditions: jsonb("conditions").$type<Record<string, unknown>>().notNull().default({}),
  steps: jsonb("steps").$type<Record<string, unknown>[]>().notNull().default([]),
  /**
   * Exactly what this version may do, and the whole security model.
   *
   * The author must hold every one of these at publish time, and a run gets
   * this set and nothing else. A workflow that only sends a message cannot
   * be edited later into one that issues a refund without a second check
   * against whoever published it.
   */
  requiredPermissions: jsonb("required_permissions").$type<string[]>().notNull().default([]),
  publishedByUserId: uuid("published_by_user_id").references(() => user.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  versionIdx: uniqueIndex("workflow_version_idx").on(t.workflowId, t.version),
}));

export const runStatus = pgEnum("workflow_run_status", [
  "pending", "running",
  /**
   * Parked on a clock, mid run.
   *
   * "Wait three days, then chase" is what most automations a contractor
   * actually wants look like, and a run that held the three days in memory
   * would lose them to a deploy. A waiting run is a row with a time on it,
   * so the wait survives every restart and is visible to whoever asks why
   * nothing has happened yet.
   */
  "waiting",
  "succeeded", "failed", "cancelled", "skipped",
]);

export const workflowRun = pgTable("workflow_run", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  workflowId: uuid("workflow_id").notNull().references(() => workflow.id, { onDelete: "cascade" }),
  versionId: uuid("version_id").notNull().references(() => workflowVersion.id, { onDelete: "restrict" }),
  eventId: uuid("event_id").references(() => domainEvent.id, { onDelete: "set null" }),
  status: runStatus("status").notNull().default("pending"),
  /**
   * Derived from the workflow version and the triggering event, so the same
   * event can never start the same version twice however many times the
   * worker crashes and retries.
   */
  idempotencyKey: text("idempotency_key").notNull(),
  /** Why it did nothing, when it did nothing. A skip is not a failure. */
  skipReason: text("skip_reason"),
  error: text("error"),
  causationDepth: integer("causation_depth").notNull().default(0),
  /** When a waiting run becomes runnable again. Null unless it is waiting. */
  resumeAt: timestamp("resume_at", { withTimezone: true }),
  /**
   * The step to start from when it does.
   *
   * Belt and braces with the step rows, which already record what happened:
   * a resume reads them and skips what succeeded, so a run that sent the
   * text and then waited does not send it again. This says where to look
   * without scanning, and disagreeing with the rows would be caught by the
   * unique index on (run, step).
   */
  resumeStepIndex: integer("resume_step_index"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  idemIdx: uniqueIndex("workflow_run_idem_idx").on(t.organizationId, t.idempotencyKey),
  /**
   * The only query the resume tick makes: what is due, across every tenant.
   *
   * Partial on `resume_at is not null` rather than on the status, and not
   * for style: a partial index whose predicate names a new enum value cannot
   * be created in the same transaction that adds the value, so the migration
   * that introduced `waiting` would have failed. The column is null unless a
   * run is waiting, so the two predicates select the same rows.
   */
  resumeIdx: index("workflow_run_resume_idx").on(t.resumeAt)
    .where(sql`${t.resumeAt} is not null`),
  workflowIdx: index("workflow_run_workflow_idx").on(t.workflowId, t.createdAt),
  pendingIdx: index("workflow_run_pending_idx").on(t.status, t.createdAt)
    .where(sql`${t.status} in ('pending', 'running')`),
}));

/**
 * One step's result.
 *
 * A row per step rather than a blob on the run, because the question an
 * operator asks is "which step failed and what did it see", and because a
 * resumed run needs to know which steps already happened. A workflow that
 * sent the text and then failed to update the job must not send the text
 * again on retry.
 */
export const workflowStepRun = pgTable("workflow_step_run", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => workflowRun.id, { onDelete: "cascade" }),
  stepIndex: integer("step_index").notNull(),
  stepKind: text("step_kind").notNull(),
  status: runStatus("status").notNull().default("pending"),
  input: jsonb("input").$type<Record<string, unknown>>(),
  output: jsonb("output").$type<Record<string, unknown>>(),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  runIdx: uniqueIndex("workflow_step_run_idx").on(t.runId, t.stepIndex),
}));

/**
 * HOW FAR A CONSUMER HAS READ
 *
 * The event log is the seam three things are meant to share: workflows,
 * webhooks and the agent layer. A cursor per consumer rather than a flag on
 * the event is what makes that true. A `processed` column would let exactly
 * one reader exist, and the next one would need its own queue, which is the
 * design this log was chosen to avoid.
 *
 * Per organization, because sequences are per organization: one tenant's
 * quiet week must not hold up another's.
 *
 * The cursor is a position, not a lock. Running two workers means some events
 * are handled twice, and that is safe because a run is keyed on (version,
 * event) behind a unique index. Advancing with `greatest` rather than an
 * assignment is what stops a slower worker rewinding a faster one.
 */
export const eventCursor = pgTable("event_cursor", {
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** `workflow` today. `webhook` and `agent` are the reason this is a column. */
  consumer: text("consumer").notNull(),
  /** Matches `domain_event.sequence`. Same type on both sides so the
   *  comparison never needs a cast. */
  lastSequence: integer("last_sequence").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.organizationId, t.consumer] }),
}));

/**
 * WHERE A SCHEDULED WORKFLOW IS UP TO
 *
 * Separate from `workflow` because it is a cursor rather than a definition.
 * Editing a workflow must not move its schedule, and a schedule advancing
 * every night must not look like somebody edited the workflow every night.
 *
 * The claim is a conditional update on `next_run_at`: a worker reads the due
 * time, then updates the row only if it still holds that value. Two workers
 * both see one row as due and exactly one of them wins, which is the same
 * shape the outbox and the task queue already use, and the reason a second
 * worker is a capacity decision rather than a duplicate-message incident.
 */
export const workflowSchedule = pgTable("workflow_schedule", {
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  workflowId: uuid("workflow_id").notNull().references(() => workflow.id, { onDelete: "cascade" }),
  /**
   * When it next fires, computed in the organization's timezone.
   *
   * Null means the schedule never fires again, which is a real answer for
   * "the 30th of February" and better than a loop looking for it.
   */
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  /**
   * The expression this row was computed from.
   *
   * Kept so a changed schedule is detectable without reading the workflow on
   * every tick, and so a row left over from an old expression recomputes
   * rather than firing on the old clock.
   */
  expression: text("expression").notNull(),
  /** Why it is not firing, when it is not. Shown rather than swallowed. */
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.organizationId, t.workflowId] }),
  /**
   * The only query the tick makes: what is due, across every tenant. Ordered
   * by due time so the one that has waited longest goes first.
   */
  dueIdx: index("workflow_schedule_due_idx").on(t.nextRunAt).where(sql`${t.nextRunAt} is not null`),
}));

// ---------------------------------------------------------------------------
// Tasks: the office work queue
// ---------------------------------------------------------------------------

export const taskStatus = pgEnum("task_status", [
  "open",
  "in_progress",
  "done",
  /** Decided against rather than forgotten, which is a different fact. */
  "dismissed",
]);

export const taskPriority = pgEnum("task_priority", ["low", "normal", "high", "urgent"]);

/**
 * THE WORK THAT IS NOT A JOB
 *
 * Call this customer back. Chase this approval. This invoice needs a purchase
 * order before it can be sent. Somebody promised a quote on Friday.
 *
 * Every contractor runs this on sticky notes, a shared inbox and one person's
 * memory, and it is where the money quietly leaks: an unapproved estimate
 * nobody followed up is a sale that did not happen and leaves no record that
 * it existed.
 *
 * A task hangs off the RECORD IT IS ABOUT rather than describing it. A to-do
 * list of sentences makes somebody reconstruct the context before they can
 * act, and the reconstruction is most of the work. Following up an estimate
 * should open the estimate.
 */
export const task = pgTable("task", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body"),
  status: taskStatus("status").notNull().default("open"),
  priority: taskPriority("priority").notNull().default("normal"),

  /**
   * What it is about. Deliberately a loose reference rather than a column per
   * entity: a task can be about anything the product has, including things
   * added later, and eight nullable foreign keys would need a ninth every
   * time. The tradeoff is no referential integrity, which is acceptable
   * because a task pointing at a deleted record is still a record of what
   * somebody was asked to do.
   */
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),

  /**
   * A person or a queue, and not both. Unassigned is a real and common state:
   * somebody raised it and nobody has picked it up, which is exactly what a
   * team queue is for.
   */
  assigneeUserId: uuid("assignee_user_id").references(() => user.id, { onDelete: "set null" }),
  queue: text("queue"),

  dueAt: timestamp("due_at", { withTimezone: true }),
  /** Set when the due date passes and nothing has happened. */
  escalatedAt: timestamp("escalated_at", { withTimezone: true }),

  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /**
   * The run that raised it, when an automation did.
   *
   * Kept so "why is this in my queue" has an answer, and so a workflow that
   * raises a hundred tasks a day is attributable rather than mysterious.
   */
  raisedByRunId: uuid("raised_by_run_id").references(() => workflowRun.id, { onDelete: "set null" }),

  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByUserId: uuid("completed_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Why it was dismissed. A queue full of silently dropped work is noise. */
  outcome: text("outcome"),
  ...timestamps,
}, (t) => ({
  /** The three views: mine, the queue's, and what is late. */
  mineIdx: index("task_assignee_idx").on(t.organizationId, t.assigneeUserId, t.status),
  queueIdx: index("task_queue_idx").on(t.organizationId, t.queue, t.status),
  dueIdx: index("task_due_idx").on(t.organizationId, t.status, t.dueAt),
  entityIdx: index("task_entity_idx").on(t.entityType, t.entityId),
  /**
   * One open task per workflow run per entity.
   *
   * A workflow that fires on every event would otherwise raise the same
   * "chase this estimate" task every hour until somebody turns the automation
   * off, which is how an inbox becomes something people stop opening.
   */
  automationIdx: uniqueIndex("task_automation_idx")
    .on(t.organizationId, t.raisedByRunId, t.entityType, t.entityId)
    .where(sql`${t.raisedByRunId} is not null`),
}));
