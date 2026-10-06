import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, taskRules, holidays as holidayRules, time, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { writeChecklist } from "./tasks";
import * as email from "./email";
import { publicBaseUrl } from "./setup-tokens";
import { remember, replayed } from "./once";
import { loadHolidays } from "./holidays";

/**
 * RECURRING TASKS AND ESCALATION
 *
 * Two things the queue could not do, and both are the queue working when
 * nobody is looking at it.
 *
 * A TASK THAT COMES ROUND AGAIN. Check the vans on Monday, reconcile the card
 * machine on the first. A template says what and when, in the company's own
 * calendar, and the worker raises one task per occurrence. "Never duplicated
 * on restart" is not a promise this code keeps by being careful: the task
 * carries the template and the day, a unique index on the pair decides, and
 * the insert is `on conflict do nothing`. A worker killed mid pass, restarted,
 * or running twice raises Monday's van check once.
 *
 * A LATE TASK THAT TELLS SOMEBODY. Overdue was derived and shown in red on a
 * screen, which helps exactly the people already looking at it. A rule says
 * how late is too late and who hears about it: the assignee's manager, a
 * role, or a named person, and optionally who takes the task over. The worker
 * applies each rule to each task once, and the record of having done so is
 * written FIRST, with the same unique index and `on conflict` discipline, so
 * only the pass whose insert landed tells anybody.
 *
 * TELLING SOMEBODY is a task in their own queue, linked to the late one, and
 * an email when they have an address and the company sends email. The task is
 * the one that always works; the email goes through the same outbox as
 * everything else, and when it cannot go the reason is kept rather than
 * thrown, because a missing mail provider must not stop the escalation.
 */

/* ------------------------------------------------------------ who's who */

interface Person {
  userId: string;
  name: string | null;
  email: string;
  role: string;
  active: boolean;
  reportsToUserId: string | null;
}

/**
 * The company's people with names and addresses.
 *
 * Through `app.organization_people()`, because the user table's own policy
 * shows a person only their own row, and a join to it would make every
 * colleague nameless.
 */
async function directory(tx: Database, organizationId: string): Promise<Map<string, Person>> {
  const named = await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sql`select user_id, name, email from app.organization_people()`,
  );
  const byUser = new Map([...named].map((row) => [row.user_id, row]));
  const rows = await tx.select({
    userId: schema.membership.userId,
    role: schema.membership.role,
    active: schema.membership.active,
    reportsToUserId: schema.membership.reportsToUserId,
  }).from(schema.membership)
    .where(eq(schema.membership.organizationId, organizationId))
    .orderBy(asc(schema.membership.createdAt));
  return new Map(rows.map((row) => [row.userId, {
    ...row,
    name: byUser.get(row.userId)?.name ?? null,
    email: byUser.get(row.userId)?.email ?? "",
  }]));
}

const nameOf = (people: Map<string, Person>, userId: string | null): string | null => {
  if (!userId) return null;
  const person = people.get(userId);
  return person ? (person.name ?? person.email) : null;
};

function mustBeActive(people: Map<string, Person>, userId: string | null | undefined, what: string): void {
  if (!userId) return;
  if (!people.get(userId)?.active) throw new ConflictError(`${what} has to be somebody who works here now.`);
}

/**
 * The people work can be given to, for the pickers on the task screens.
 *
 * `task:read`, not `user:read`: somebody who may hand a task to a colleague
 * has to be able to name the colleague, and the directory behind it carries
 * names and nothing else here.
 */
export async function assignable(ctx: ServiceContext): Promise<{ userId: string; name: string; role: string }[]> {
  return guardedRead(ctx, "task:read", async (tx) => {
    const people = await directory(tx, ctx.actor.organizationId);
    return [...people.values()].filter((p) => p.active)
      .map((p) => ({ userId: p.userId, name: p.name ?? p.email, role: p.role }));
  });
}

/* ------------------------------------------------------- reporting lines */

export interface ReportingLine {
  userId: string;
  name: string;
  role: string;
  reportsToUserId: string | null;
  reportsToName: string | null;
}

/** Who answers to whom, for the people who work here now. */
export async function reportingLines(ctx: ServiceContext): Promise<ReportingLine[]> {
  return guardedRead(ctx, "user:read", async (tx) => {
    const people = await directory(tx, ctx.actor.organizationId);
    return [...people.values()].filter((p) => p.active).map((p) => ({
      userId: p.userId,
      name: p.name ?? p.email,
      role: p.role,
      reportsToUserId: p.reportsToUserId,
      reportsToName: nameOf(people, p.reportsToUserId),
    }));
  });
}

/**
 * Say who somebody answers to, or that nobody is recorded.
 *
 * `user:write`, because it is a fact about the people rather than about a
 * task: it decides whose late work lands in whose queue.
 */
export async function setReportsTo(
  ctx: ServiceContext, input: { userId: string; reportsToUserId: string | null },
): Promise<{ userId: string; reportsToUserId: string | null }> {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const people = await directory(tx, ctx.actor.organizationId);
    const person = people.get(input.userId);
    if (!person) throw new NotFoundError("Person");
    if (input.reportsToUserId === input.userId) {
      throw new ConflictError("Somebody cannot be their own manager; leave it empty instead.");
    }
    mustBeActive(people, input.reportsToUserId, "A manager");

    await tx.update(schema.membership)
      .set({ reportsToUserId: input.reportsToUserId, updatedAt: new Date() })
      .where(and(
        eq(schema.membership.organizationId, ctx.actor.organizationId),
        eq(schema.membership.userId, input.userId),
      ));
    await audit(tx, ctx, "membership.reports_to_set", "membership", input.userId,
      { reportsToUserId: person.reportsToUserId }, { reportsToUserId: input.reportsToUserId });
    return { userId: input.userId, reportsToUserId: input.reportsToUserId };
  });
}

/* ------------------------------------------------------------- templates */

export interface TemplateInput {
  title: string;
  body?: string | undefined;
  priority?: taskRules.TaskPriority | undefined;
  assigneeUserId?: string | null | undefined;
  queue?: string | undefined;
  frequency: taskRules.TaskFrequency;
  weekday?: number | null | undefined;
  monthDay?: number | null | undefined;
  /** For the given weekday of the month: 1 is the first, 4 the fourth. */
  monthWeek?: number | null | undefined;
  /** For every so many weeks: 2 to 52. */
  intervalWeeks?: number | null | undefined;
  /** For chosen weekdays: the days, 0 for Sunday. */
  daysOfWeek?: number[] | null | undefined;
  /** Minutes after the company's midnight. Five in the afternoon when not said. */
  dueMinutes?: number | undefined;
  checklist?: string[] | undefined;
  startsOn?: string | undefined;
  /** Raise nothing on a date the holiday list says the company is closed. */
  skipHolidays?: boolean | undefined;
}

export interface TemplateView {
  id: string;
  title: string;
  body: string | null;
  priority: taskRules.TaskPriority;
  assigneeUserId: string | null;
  assigneeName: string | null;
  queue: string | null;
  frequency: taskRules.TaskFrequency;
  weekday: number | null;
  monthDay: number | null;
  monthWeek: number | null;
  intervalWeeks: number | null;
  daysOfWeek: number[] | null;
  dueMinutes: number;
  checklist: string[];
  startsOn: string;
  skipHolidays: boolean;
  active: boolean;
  lastRaisedOn: string | null;
  /** "Every Monday", read back from the same function the worker uses. */
  schedule: string;
  /** The next day it will raise a task for, in the company's calendar. Null when paused. */
  nextOn: string | null;
}

function viewOf(
  row: typeof schema.taskTemplate.$inferSelect, people: Map<string, Person>, today: string,
): TemplateView {
  const schedule = scheduleOf(row);
  const raisedToday = row.lastRaisedOn !== null && row.lastRaisedOn >= today;
  const dueToday = taskRules.occurrenceOnOrBefore(schedule, today) === today;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    priority: row.priority,
    assigneeUserId: row.assigneeUserId,
    assigneeName: nameOf(people, row.assigneeUserId),
    queue: row.queue,
    frequency: row.frequency,
    weekday: row.weekday,
    monthDay: row.monthDay,
    monthWeek: row.monthWeek,
    intervalWeeks: row.intervalWeeks,
    daysOfWeek: row.daysOfWeek,
    dueMinutes: row.dueMinutes,
    checklist: row.checklist,
    startsOn: row.startsOn,
    skipHolidays: row.skipHolidays,
    active: row.active,
    lastRaisedOn: row.lastRaisedOn,
    schedule: `${taskRules.describeSchedule(schedule)}${row.skipHolidays ? ", not on a holiday" : ""}`,
    nextOn: !row.active ? null
      : dueToday && !raisedToday ? today
      : taskRules.occurrenceAfter(schedule, today),
  };
}

/** A stored template as the schedule core counts. */
const scheduleOf = (row: Pick<typeof schema.taskTemplate.$inferSelect,
  "frequency" | "weekday" | "monthDay" | "monthWeek" | "intervalWeeks" | "daysOfWeek" | "startsOn">): taskRules.TaskSchedule => ({
  frequency: row.frequency, weekday: row.weekday, monthDay: row.monthDay, monthWeek: row.monthWeek,
  intervalWeeks: row.intervalWeeks, daysOfWeek: row.daysOfWeek, startsOn: row.startsOn,
});

/**
 * The schedule columns as they are stored: each one only for the frequency
 * that reads it, so a template changed from monthly to weekly does not keep
 * a day of the month nothing reads and a screen might one day show.
 */
const scheduleColumns = (input: TemplateInput) => ({
  frequency: input.frequency,
  weekday: taskRules.NEEDS_WEEKDAY.includes(input.frequency) ? input.weekday ?? null : null,
  monthDay: input.frequency === "monthly" ? input.monthDay ?? null : null,
  monthWeek: input.frequency === "nth_weekday_of_month" ? input.monthWeek ?? null : null,
  intervalWeeks: input.frequency === "every_n_weeks" ? input.intervalWeeks ?? null : null,
  daysOfWeek: input.frequency === "chosen_weekdays" ? taskRules.cleanDays(input.daysOfWeek) : null,
});

function checkTemplate(input: TemplateInput & { startsOn: string }): void {
  if (input.title.trim() === "") throw new ConflictError("A recurring task needs a title.");
  const verdict = taskRules.checkSchedule({
    frequency: input.frequency, weekday: input.weekday ?? null, monthDay: input.monthDay ?? null,
    monthWeek: input.monthWeek ?? null, intervalWeeks: input.intervalWeeks ?? null, daysOfWeek: input.daysOfWeek ?? null,
    startsOn: input.startsOn,
  });
  if (!verdict.ok) throw new ConflictError(verdict.message);
  const due = input.dueMinutes ?? 17 * 60;
  if (!Number.isInteger(due) || due < 0 || due >= 24 * 60) {
    throw new ConflictError("The time it is due has to be a time of day.");
  }
  if ((input.checklist ?? []).length > taskRules.MAX_CHECKLIST_ITEMS) {
    throw new ConflictError(`A checklist holds ${taskRules.MAX_CHECKLIST_ITEMS} items at most.`);
  }
}

export async function listTemplates(ctx: ServiceContext): Promise<TemplateView[]> {
  return guardedRead(ctx, "task:read", async (tx) => {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = time.dateIn(new Date(), zone);
    const people = await directory(tx, ctx.actor.organizationId);
    const rows = await tx.select().from(schema.taskTemplate)
      .orderBy(sql`${schema.taskTemplate.active} desc`, asc(schema.taskTemplate.title));
    return rows.map((row) => viewOf(row, people, today));
  });
}

export async function createTemplate(ctx: ServiceContext, input: TemplateInput): Promise<TemplateView> {
  return guardedWrite(ctx, "task:write", async (tx) => {
    const seen = await replayed<TemplateView>(tx, ctx, "task_template");
    if (seen) return seen;

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = time.dateIn(new Date(), zone);
    const startsOn = input.startsOn ?? today;
    checkTemplate({ ...input, startsOn });
    const people = await directory(tx, ctx.actor.organizationId);
    mustBeActive(people, input.assigneeUserId, "The person it goes to");

    const [row] = await tx.insert(schema.taskTemplate).values({
      organizationId: ctx.actor.organizationId,
      title: input.title.trim(),
      body: input.body?.trim() || null,
      priority: input.priority ?? "normal",
      assigneeUserId: input.assigneeUserId ?? null,
      queue: input.queue?.trim() || null,
      ...scheduleColumns(input),
      dueMinutes: input.dueMinutes ?? 17 * 60,
      checklist: (input.checklist ?? []).map((l) => l.trim()).filter((l) => l !== ""),
      startsOn,
      skipHolidays: input.skipHolidays ?? false,
      createdByUserId: ctx.actor.userId,
    }).returning();

    await audit(tx, ctx, "task_template.created", "task_template", row!.id, null, row);
    const view = viewOf(row!, people, today);
    await remember(tx, ctx, "task_template", row!.id, view);
    return view;
  });
}

/**
 * Change a template, or pause and resume it.
 *
 * A change applies to the tasks it raises from now on. The ones already in
 * the queue are tasks in their own right, with their own checklist, and a
 * template edit that rewrote them would change work somebody may be halfway
 * through.
 */
export async function updateTemplate(
  ctx: ServiceContext, input: { id: string } & Partial<TemplateInput> & { active?: boolean | undefined },
): Promise<TemplateView> {
  return guardedWrite(ctx, "task:write", async (tx) => {
    const [before] = await tx.select().from(schema.taskTemplate)
      .where(eq(schema.taskTemplate.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Recurring task");

    const merged: TemplateInput & { startsOn: string } = {
      title: input.title ?? before.title,
      frequency: input.frequency ?? before.frequency,
      weekday: input.weekday !== undefined ? input.weekday : before.weekday,
      monthDay: input.monthDay !== undefined ? input.monthDay : before.monthDay,
      monthWeek: input.monthWeek !== undefined ? input.monthWeek : before.monthWeek,
      intervalWeeks: input.intervalWeeks !== undefined ? input.intervalWeeks : before.intervalWeeks,
      daysOfWeek: input.daysOfWeek !== undefined ? input.daysOfWeek : before.daysOfWeek,
      dueMinutes: input.dueMinutes ?? before.dueMinutes,
      checklist: input.checklist ?? before.checklist,
      startsOn: input.startsOn ?? before.startsOn,
    };
    checkTemplate(merged);
    const people = await directory(tx, ctx.actor.organizationId);
    if (input.assigneeUserId !== undefined) mustBeActive(people, input.assigneeUserId, "The person it goes to");

    const [after] = await tx.update(schema.taskTemplate).set({
      title: merged.title.trim(),
      ...(input.body !== undefined ? { body: input.body.trim() || null } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
      ...(input.queue !== undefined ? { queue: input.queue.trim() || null } : {}),
      ...scheduleColumns(merged),
      dueMinutes: merged.dueMinutes ?? before.dueMinutes,
      checklist: (merged.checklist ?? []).map((l) => l.trim()).filter((l) => l !== ""),
      startsOn: merged.startsOn,
      ...(input.skipHolidays !== undefined ? { skipHolidays: input.skipHolidays } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.taskTemplate.id, input.id)).returning();

    await audit(tx, ctx, input.active === false ? "task_template.paused"
      : input.active === true ? "task_template.resumed" : "task_template.updated",
    "task_template", input.id, before, after);
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    return viewOf(after!, people, time.dateIn(new Date(), zone));
  });
}

/* ------------------------------------------------------ escalation rules */

export interface RuleInput {
  name: string;
  afterHours: number;
  minimumPriority?: taskRules.TaskPriority | null | undefined;
  target: "manager" | "role" | "person";
  targetRole?: string | null | undefined;
  targetUserId?: string | null | undefined;
  reassignToUserId?: string | null | undefined;
}

export interface RuleView {
  id: string;
  name: string;
  afterHours: number;
  minimumPriority: taskRules.TaskPriority | null;
  target: "manager" | "role" | "person";
  targetRole: string | null;
  targetUserId: string | null;
  targetName: string | null;
  reassignToUserId: string | null;
  reassignToName: string | null;
  active: boolean;
  /** What it does, as a sentence. */
  summary: string;
  /** How many times it has acted. */
  fired: number;
}

const ROLE_WORDS: Record<string, string> = {
  owner: "the owners", admin: "the administrators", office_manager: "the office managers",
  branch_manager: "the branch managers",
  dispatcher: "the dispatchers", csr: "the customer service team", technician: "the technicians",
  crew_lead: "the crew leads", accountant: "the accountants", readonly: "the read only users",
};

function ruleView(row: typeof schema.taskEscalationRule.$inferSelect, people: Map<string, Person>, fired: number): RuleView {
  const who = row.target === "manager" ? "the assignee's manager"
    : row.target === "role" ? ROLE_WORDS[row.targetRole ?? ""] ?? "a role"
    : nameOf(people, row.targetUserId) ?? "a person who has left";
  const priority = row.minimumPriority && row.minimumPriority !== "low" ? `${row.minimumPriority} priority or above ` : "";
  const hours = row.afterHours === 1 ? "an hour" : `${row.afterHours} hours`;
  const handover = row.reassignToUserId ? `, and hand it to ${nameOf(people, row.reassignToUserId) ?? "a person who has left"}` : "";
  return {
    id: row.id,
    name: row.name,
    afterHours: row.afterHours,
    minimumPriority: row.minimumPriority,
    target: row.target,
    targetRole: row.targetRole,
    targetUserId: row.targetUserId,
    targetName: nameOf(people, row.targetUserId),
    reassignToUserId: row.reassignToUserId,
    reassignToName: nameOf(people, row.reassignToUserId),
    active: row.active,
    summary: `When a ${priority}task is ${hours} late, tell ${who}${handover}.`,
    fired,
  };
}

function checkRuleInput(input: RuleInput, people: Map<string, Person>): void {
  if (input.name.trim() === "") throw new ConflictError("Give the rule a name somebody will recognise.");
  const hours = taskRules.checkEscalationHours(input.afterHours);
  if (!hours.ok) throw new ConflictError(hours.message);
  if (input.target === "role" && !input.targetRole) throw new ConflictError("Choose which role hears about it.");
  if (input.target === "person") {
    if (!input.targetUserId) throw new ConflictError("Choose who hears about it.");
    mustBeActive(people, input.targetUserId, "The person told");
  }
  mustBeActive(people, input.reassignToUserId, "The person it is handed to");
}

export async function listRules(ctx: ServiceContext): Promise<RuleView[]> {
  return guardedRead(ctx, "task:read", async (tx) => {
    const people = await directory(tx, ctx.actor.organizationId);
    const rows = await tx.select().from(schema.taskEscalationRule)
      .orderBy(sql`${schema.taskEscalationRule.active} desc`, asc(schema.taskEscalationRule.afterHours));
    const counts = await tx.select({ ruleId: schema.taskEscalation.ruleId, n: sql<number>`count(*)::int` })
      .from(schema.taskEscalation).groupBy(schema.taskEscalation.ruleId);
    const fired = new Map(counts.map((c) => [c.ruleId, Number(c.n)]));
    return rows.map((row) => ruleView(row, people, fired.get(row.id) ?? 0));
  });
}

export async function createRule(ctx: ServiceContext, input: RuleInput): Promise<RuleView> {
  return guardedWrite(ctx, "task:write", async (tx) => {
    const seen = await replayed<RuleView>(tx, ctx, "task_escalation_rule");
    if (seen) return seen;
    const people = await directory(tx, ctx.actor.organizationId);
    checkRuleInput(input, people);

    const [row] = await tx.insert(schema.taskEscalationRule).values({
      organizationId: ctx.actor.organizationId,
      name: input.name.trim(),
      afterHours: input.afterHours,
      minimumPriority: input.minimumPriority ?? null,
      target: input.target,
      targetRole: input.target === "role" ? ((input.targetRole ?? null) as typeof schema.taskEscalationRule.$inferSelect["targetRole"]) : null,
      targetUserId: input.target === "person" ? input.targetUserId ?? null : null,
      reassignToUserId: input.reassignToUserId ?? null,
      createdByUserId: ctx.actor.userId,
    }).returning();

    await audit(tx, ctx, "task_escalation_rule.created", "task_escalation_rule", row!.id, null, row);
    const view = ruleView(row!, people, 0);
    await remember(tx, ctx, "task_escalation_rule", row!.id, view);
    return view;
  });
}

/**
 * Change a rule, or turn it off and on.
 *
 * Tasks it already acted on are not acted on again under the changed rule:
 * the record is per rule and task, and a rule edited from twelve hours to
 * four does not tell somebody a second time about a task it told them about
 * yesterday.
 */
export async function updateRule(
  ctx: ServiceContext, input: { id: string } & Partial<RuleInput> & { active?: boolean | undefined },
): Promise<RuleView> {
  return guardedWrite(ctx, "task:write", async (tx) => {
    const [before] = await tx.select().from(schema.taskEscalationRule)
      .where(eq(schema.taskEscalationRule.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Escalation rule");
    const people = await directory(tx, ctx.actor.organizationId);
    const merged: RuleInput = {
      name: input.name ?? before.name,
      afterHours: input.afterHours ?? before.afterHours,
      minimumPriority: input.minimumPriority !== undefined ? input.minimumPriority : before.minimumPriority,
      target: input.target ?? before.target,
      targetRole: input.targetRole !== undefined ? input.targetRole : before.targetRole,
      targetUserId: input.targetUserId !== undefined ? input.targetUserId : before.targetUserId,
      reassignToUserId: input.reassignToUserId !== undefined ? input.reassignToUserId : before.reassignToUserId,
    };
    // Turning a rule off must work even when the person it names has left.
    if (!(Object.keys(input).length === 2 && input.active !== undefined)) checkRuleInput(merged, people);

    const [after] = await tx.update(schema.taskEscalationRule).set({
      name: merged.name.trim(),
      afterHours: merged.afterHours,
      minimumPriority: merged.minimumPriority ?? null,
      target: merged.target,
      targetRole: merged.target === "role" ? ((merged.targetRole ?? null) as typeof schema.taskEscalationRule.$inferSelect["targetRole"]) : null,
      targetUserId: merged.target === "person" ? merged.targetUserId ?? null : null,
      reassignToUserId: merged.reassignToUserId ?? null,
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.taskEscalationRule.id, input.id)).returning();

    await audit(tx, ctx, "task_escalation_rule.updated", "task_escalation_rule", input.id, before, after);
    return ruleView(after!, people, 0);
  });
}

/** What escalation has done to one task, oldest first. */
export async function escalationsOf(ctx: ServiceContext, input: { taskId: string }) {
  return guardedRead(ctx, "task:read", async (tx) => {
    const people = await directory(tx, ctx.actor.organizationId);
    const rows = await tx.select({ escalation: schema.taskEscalation, rule: schema.taskEscalationRule.name })
      .from(schema.taskEscalation)
      .innerJoin(schema.taskEscalationRule, eq(schema.taskEscalationRule.id, schema.taskEscalation.ruleId))
      .where(eq(schema.taskEscalation.taskId, input.taskId))
      .orderBy(asc(schema.taskEscalation.createdAt));
    return rows.map(({ escalation, rule }) => ({
      id: escalation.id,
      rule,
      at: escalation.createdAt.toISOString(),
      notified: escalation.notified.map((id) => nameOf(people, id) ?? "somebody who has left"),
      note: escalation.note,
      reassignedTo: nameOf(people, escalation.reassignedToUserId),
    }));
  });
}

/* ------------------------------------------------------------ the worker */

/** What the worker acts as. Writes tasks and queues email; nothing else. */
function workerActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["task:read", "task:write", "message:send", "message:read"],
    agentId: "task-rules",
  };
}

export interface TaskPassResult {
  organizationId: string;
  raised: string[];
  escalated: { taskId: string; ruleId: string }[];
  failed: string[];
}

/**
 * Raise the tasks this company's templates owe today, each exactly once.
 *
 * Today is the company's day. The unique index on (template, day) is the
 * guarantee; `lastRaisedOn` only spares the next pass an insert it would
 * refuse.
 */
export async function raiseRecurringFor(db: Database, organizationId: string, now: Date = new Date()): Promise<string[]> {
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  return inTenant(ctx, async (tx) => {
    const zone = await timezoneOf(tx, organizationId);
    const today = time.dateIn(now, zone);
    const templates = await tx.select().from(schema.taskTemplate)
      .where(eq(schema.taskTemplate.active, true));
    const raised: string[] = [];
    const holidayList = templates.some((t) => t.skipHolidays) ? await loadHolidays(tx, organizationId) : [];

    for (const template of templates) {
      const day = taskRules.occurrenceToRaise(
        scheduleOf(template),
        today, template.lastRaisedOn,
      );
      if (!day) continue;

      /**
       * A template told to skip holidays raises nothing on a closed date,
       * and the day is written down as dealt with, so the next pass does not
       * look at it again and the occurrence is not raised the day after
       * instead. Skipped, not moved, the same way a missed occurrence is not
       * backfilled. A short day is a working day and is not skipped.
       */
      const holiday = template.skipHolidays ? holidayRules.holidayOn(holidayList, day) : null;
      if (holiday?.closed) {
        await tx.update(schema.taskTemplate)
          .set({ lastRaisedOn: day, updatedAt: new Date() })
          .where(eq(schema.taskTemplate.id, template.id));
        await audit(tx, ctx, "task_template.skipped_holiday", "task_template", template.id, null,
          { occurrenceOn: day, holiday: holiday.name });
        continue;
      }

      const [made] = await tx.insert(schema.task).values({
        organizationId,
        title: template.title,
        body: template.body,
        priority: template.priority,
        assigneeUserId: template.assigneeUserId,
        queue: template.queue,
        dueAt: time.instantOfLocal(day, template.dueMinutes, zone),
        templateId: template.id,
        occurrenceOn: day,
      }).onConflictDoNothing().returning();

      if (made) {
        await writeChecklist(tx, organizationId, made.id, template.checklist);
        await audit(tx, ctx, "task.raised_recurring", "task", made.id, null,
          { templateId: template.id, occurrenceOn: day });
        raised.push(made.id);
      }
      await tx.update(schema.taskTemplate)
        .set({ lastRaisedOn: day, updatedAt: new Date() })
        .where(eq(schema.taskTemplate.id, template.id));
    }
    return raised;
  });
}

/** Who a rule tells about one task, and why those people. */
function recipientsFor(
  rule: typeof schema.taskEscalationRule.$inferSelect,
  assigneeUserId: string | null,
  people: Map<string, Person>,
): { userIds: string[]; note: string | null } {
  const active = [...people.values()].filter((p) => p.active);
  const owners = active.filter((p) => p.role === "owner").map((p) => p.userId);
  const assignee = assigneeUserId ? people.get(assigneeUserId) : undefined;

  if (rule.target === "manager") {
    if (!assignee) return { userIds: owners, note: "Nobody had taken it, so there was no manager to tell. The owners were told." };
    const manager = assignee.reportsToUserId ? people.get(assignee.reportsToUserId) : undefined;
    if (!manager?.active) {
      return {
        userIds: owners,
        note: `No manager is recorded for ${assignee.name ?? assignee.email}, so the owners were told.`,
      };
    }
    return { userIds: [manager.userId], note: null };
  }
  if (rule.target === "role") {
    const holders = active.filter((p) => p.role === rule.targetRole).map((p) => p.userId);
    if (holders.length === 0) {
      return { userIds: owners, note: `Nobody holds the ${rule.targetRole ?? ""} role, so the owners were told.` };
    }
    return { userIds: holders, note: null };
  }
  const person = rule.targetUserId ? people.get(rule.targetUserId) : undefined;
  if (!person?.active) return { userIds: owners, note: "The person this rule names has left, so the owners were told." };
  return { userIds: [person.userId], note: null };
}

/**
 * Apply this company's escalation rules to its late tasks.
 *
 * Each (task, rule) acts once. The escalation row goes in first, and the
 * notifying and the handing over happen only for the pass whose insert
 * landed, all inside one transaction, so a crash between them leaves neither.
 */
export async function escalateFor(
  db: Database, organizationId: string, now: Date = new Date(),
): Promise<{ taskId: string; ruleId: string }[]> {
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  return inTenant(ctx, async (tx) => {
    const rules = await tx.select().from(schema.taskEscalationRule)
      .where(eq(schema.taskEscalationRule.active, true));
    if (rules.length === 0) return [];

    const soonest = Math.min(...rules.map((r) => r.afterHours));
    const late = await tx.select().from(schema.task)
      .where(and(
        inArray(schema.task.status, ["open", "in_progress"]),
        lte(schema.task.dueAt, new Date(now.getTime() - soonest * 3_600_000)),
        isNull(schema.task.completedAt),
      ))
      .limit(500);
    if (late.length === 0) return [];

    const people = await directory(tx, organizationId);
    const base = publicBaseUrl();
    const done: { taskId: string; ruleId: string }[] = [];

    for (const rule of rules) {
      for (const task of late) {
        if (!taskRules.escalationDue(
          { dueAt: task.dueAt, status: task.status, priority: task.priority },
          { afterHours: rule.afterHours, minimumPriority: rule.minimumPriority },
          now,
        )) continue;

        const [claimed] = await tx.insert(schema.taskEscalation).values({
          organizationId, taskId: task.id, ruleId: rule.id,
        }).onConflictDoNothing().returning({ id: schema.taskEscalation.id });
        if (!claimed) continue;

        const { userIds, note } = recipientsFor(rule, task.assigneeUserId, people);
        const hoursLate = Math.floor((now.getTime() - task.dueAt!.getTime()) / 3_600_000);
        const owner = nameOf(people, task.assigneeUserId) ?? "nobody";
        const notes: string[] = note ? [note] : [];

        for (const userId of userIds) {
          await tx.insert(schema.task).values({
            organizationId,
            title: `Late: ${task.title}`.slice(0, 300),
            body: `${hoursLate} hours past due, with ${owner}. Raised by the rule "${rule.name}".`,
            priority: "high",
            entityType: "task",
            entityId: task.id,
            assigneeUserId: userId,
          });

          const person = people.get(userId);
          if (person?.email) {
            const link = base ? `${base}/tasks/${task.id}` : null;
            const outcome = await email.queue({ actor: ctx.actor, db: tx }, {
              to: person.email,
              subject: `Late: ${task.title}`.slice(0, 200),
              text: [
                `"${task.title}" is ${hoursLate} hours past due, with ${owner}.`,
                `The rule "${rule.name}" says you should know.`,
                ...(link ? [`Open it: ${link}`] : []),
              ].join("\n\n"),
              purpose: "transactional",
            }).catch((error: unknown) => ({ queued: false as const, explanation: (error as Error).message }));
            if (!outcome.queued) notes.push(`No email to ${person.name ?? person.email}: ${outcome.explanation}`);
          }
        }

        let reassignedTo: string | null = null;
        const previousAssignee = task.assigneeUserId;
        if (rule.reassignToUserId && rule.reassignToUserId !== task.assigneeUserId) {
          if (people.get(rule.reassignToUserId)?.active) {
            reassignedTo = rule.reassignToUserId;
            await tx.update(schema.task)
              .set({ assigneeUserId: reassignedTo, updatedAt: new Date() })
              .where(eq(schema.task.id, task.id));
            task.assigneeUserId = reassignedTo;
          } else {
            notes.push("The person this rule hands work to has left, so it stayed where it was.");
          }
        }

        await tx.update(schema.task)
          .set({ escalatedAt: sql`coalesce(${schema.task.escalatedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: new Date() })
          .where(eq(schema.task.id, task.id));
        await tx.update(schema.taskEscalation).set({
          notified: userIds,
          note: notes.length > 0 ? notes.join(" ") : null,
          reassignedFromUserId: reassignedTo ? previousAssignee : null,
          reassignedToUserId: reassignedTo,
        }).where(eq(schema.taskEscalation.id, claimed.id));
        await audit(tx, ctx, "task.escalated", "task", task.id, null,
          { ruleId: rule.id, notified: userIds, reassignedTo });
        done.push({ taskId: task.id, ruleId: rule.id });
      }
    }
    return done;
  });
}

/**
 * The worker's pass over every company with a template or a rule.
 *
 * One company's failure is recorded and the pass goes on, because a broken
 * template at one company must not stop another company's late work being
 * escalated.
 */
export async function taskPass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean } = {},
): Promise<TaskPassResult[]> {
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.task_rule_organizations(${options.limit ?? 200})`,
  );
  const results: TaskPassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    const result: TaskPassResult = { organizationId: row.organization_id, raised: [], escalated: [], failed: [] };
    try {
      result.raised = await raiseRecurringFor(db, row.organization_id, options.now);
    } catch (error) {
      result.failed.push(`recurring: ${(error as Error).message}`);
    }
    try {
      result.escalated = await escalateFor(db, row.organization_id, options.now);
    } catch (error) {
      result.failed.push(`escalation: ${(error as Error).message}`);
    }
    results.push(result);
  }
  return results;
}

/* --------------------------------------------------------------- the API */

/** Optional fields that also accept `undefined`, which is what a parsed contract input carries. */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };

/** The keys that were sent, without the ones that came through as undefined. */
function defined<T extends object>(input: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  };
}

export const handlers = {
  listTaskTemplates: async (ctx: ServiceContext) => ({ templates: await listTemplates(ctx) }),
  createTaskTemplate: (ctx: ServiceContext, input: Loose<TemplateInput> & Pick<TemplateInput, "title" | "frequency">) =>
    createTemplate(ctx, defined(input) as TemplateInput),
  updateTaskTemplate: (ctx: ServiceContext, input: { id: string; active?: boolean | undefined } & Loose<TemplateInput>) =>
    updateTemplate(ctx, { ...defined(input), id: input.id }),
  listTaskEscalationRules: async (ctx: ServiceContext) => ({ rules: await listRules(ctx) }),
  createTaskEscalationRule: (ctx: ServiceContext, input: Loose<RuleInput> & Pick<RuleInput, "name" | "afterHours" | "target">) =>
    createRule(ctx, defined(input) as RuleInput),
  updateTaskEscalationRule: (ctx: ServiceContext, input: { id: string; active?: boolean | undefined } & Loose<RuleInput>) =>
    updateRule(ctx, { ...defined(input), id: input.id }),
  listTaskEscalations: async (ctx: ServiceContext, input: { id: string }) =>
    ({ escalations: await escalationsOf(ctx, { taskId: input.id }) }),
  listReportingLines: async (ctx: ServiceContext) => ({ people: await reportingLines(ctx) }),
  setReportingLine: (ctx: ServiceContext, input: { userId: string; reportsToUserId: string | null }) =>
    setReportsTo(ctx, input),
} as const;
