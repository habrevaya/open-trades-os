"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { tasks, taskChecklist, taskRules } from "@opentradesos/api/services";
import {
  createTask, closeTask, addTaskChecklistItem, createTaskTemplate, createTaskEscalationRule, setReportingLine,
} from "@opentradesos/api/contracts";
import { time } from "@opentradesos/core";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * THE QUEUE'S OWN RULES, AND A TASK'S CHECKLIST, FROM THE SCREENS
 *
 * Every write parses through the route's own contract and then calls the
 * service, so the screens are exactly as strict as the API. Times typed into
 * a box are read in the COMPANY'S timezone, the one every other time on these
 * screens is shown in, rather than the browser's or the server's.
 */
const session = async () => {
  const user = await requireSetupUser();
  return { ctx: { actor: user.actor, db: getDb() }, tz: user.organizationTimezone };
};

/** `2026-10-05T09:30` from a datetime box, as an instant in the company's zone. */
function localInstant(value: string | undefined, tz: string): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  return time.instantOfLocal(match[1]!, Number(match[2]) * 60 + Number(match[3]), tz).toISOString();
}

/** `17:00` from a time box, as minutes after midnight. */
function minutesOf(value: string | undefined): number | undefined {
  const match = value ? /^(\d{2}):(\d{2})$/.exec(value) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

const lines = (value: string | undefined): string[] =>
  (value ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");

const refresh = (...paths: string[]) => { for (const p of ["/tasks", ...paths]) revalidatePath(p); };

export async function addTask(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const { ctx, tz } = await session();
    const due = localInstant(field(form, "dueAt"), tz);
    const assignee = field(form, "assigneeUserId");
    const checklist = lines(field(form, "checklist"));
    const input = parsed(createTask.input, {
      title: field(form, "title"),
      body: field(form, "body"),
      ...(due ? { dueAt: due } : {}),
      ...(assignee ? { assigneeUserId: assignee } : {}),
      ...(checklist.length > 0 ? { checklist } : {}),
    });
    await tasks.handlers.createTask(ctx, input);
  });
  refresh();
  return state;
}

export async function tickItem(_previous: FormState, form: FormData): Promise<FormState> {
  const taskId = String(form.get("taskId") ?? "");
  const state = await attempt(form, async () => {
    const { ctx } = await session();
    await taskChecklist.tick(ctx, {
      taskId, itemId: String(form.get("itemId") ?? ""), done: form.get("done") === "1",
    });
  });
  refresh(`/tasks/${taskId}`);
  return state;
}

export async function addItem(_previous: FormState, form: FormData): Promise<FormState> {
  const taskId = String(form.get("taskId") ?? "");
  const state = await attempt(form, async () => {
    const { ctx } = await session();
    const input = parsed(addTaskChecklistItem.input, { id: taskId, label: field(form, "label") });
    await taskChecklist.add(ctx, { taskId: input.id, label: input.label });
  });
  refresh(`/tasks/${taskId}`);
  return state;
}

export async function removeItem(_previous: FormState, form: FormData): Promise<FormState> {
  const taskId = String(form.get("taskId") ?? "");
  const state = await attempt(form, async () => {
    const { ctx } = await session();
    await taskChecklist.remove(ctx, { taskId, itemId: String(form.get("itemId") ?? "") });
  });
  refresh(`/tasks/${taskId}`);
  return state;
}

/** Done, with the reason when items are unticked, or dismissed. */
export async function finishTask(_previous: FormState, form: FormData): Promise<FormState> {
  const taskId = String(form.get("id") ?? "");
  const state = await attempt(form, async () => {
    const { ctx } = await session();
    const input = parsed(closeTask.input, {
      id: taskId,
      outcome: field(form, "outcome"),
      overrideReason: field(form, "overrideReason"),
      dismissed: form.get("dismissed") === "1",
    });
    await tasks.handlers.closeTask(ctx, input);
  });
  refresh(`/tasks/${taskId}`);
  return state;
}

/** The schedules that come round on a named day of the week; the others ignore the day box. */
const WEEKDAY_FREQUENCIES = ["weekly", "every_other_week", "last_weekday_of_month"];

export async function addTemplate(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const { ctx } = await session();
    const frequency = field(form, "frequency");
    const weekday = field(form, "weekday");
    const monthDay = field(form, "monthDay");
    const assignee = field(form, "assigneeUserId");
    const due = minutesOf(field(form, "dueTime"));
    const checklist = lines(field(form, "checklist"));
    const input = parsed(createTaskTemplate.input, {
      title: field(form, "title"),
      body: field(form, "body"),
      priority: field(form, "priority"),
      frequency,
      ...(frequency && WEEKDAY_FREQUENCIES.includes(frequency) && weekday !== undefined ? { weekday: Number(weekday) } : {}),
      ...(frequency === "monthly" && monthDay !== undefined ? { monthDay: Number(monthDay) } : {}),
      ...(assignee ? { assigneeUserId: assignee } : {}),
      ...(due !== undefined ? { dueMinutes: due } : {}),
      ...(checklist.length > 0 ? { checklist } : {}),
      startsOn: field(form, "startsOn"),
      skipHolidays: form.get("skipHolidays") === "yes",
    });
    await taskRules.handlers.createTaskTemplate(ctx, input);
  });
  refresh("/tasks/recurring");
  return state;
}

export async function setTemplateActive(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const { ctx } = await session();
    await taskRules.updateTemplate(ctx, { id: String(form.get("id") ?? ""), active: form.get("active") === "1" });
  });
  refresh("/tasks/recurring");
  return state;
}

export async function addRule(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const { ctx } = await session();
    const target = field(form, "target");
    const reassign = field(form, "reassignToUserId");
    const minimum = field(form, "minimumPriority");
    const input = parsed(createTaskEscalationRule.input, {
      name: field(form, "name"),
      afterHours: Number(field(form, "afterHours") ?? "0"),
      target,
      ...(target === "role" ? { targetRole: field(form, "targetRole") } : {}),
      ...(target === "person" ? { targetUserId: field(form, "targetUserId") } : {}),
      ...(reassign ? { reassignToUserId: reassign } : {}),
      ...(minimum ? { minimumPriority: minimum } : {}),
    });
    await taskRules.handlers.createTaskEscalationRule(ctx, input);
  });
  refresh("/tasks/escalation");
  return state;
}

export async function setRuleActive(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const { ctx } = await session();
    await taskRules.updateRule(ctx, { id: String(form.get("id") ?? ""), active: form.get("active") === "1" });
  });
  refresh("/tasks/escalation");
  return state;
}

export async function setManager(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const { ctx } = await session();
    const input = parsed(setReportingLine.input, {
      userId: field(form, "userId"), reportsToUserId: field(form, "reportsToUserId") ?? null,
    });
    await taskRules.setReportsTo(ctx, input);
  });
  refresh("/tasks/escalation");
  return state;
}
