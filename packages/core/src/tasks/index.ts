import { addDays, addMonths, compareDates, parseDate } from "../recurrence/index.js";

/**
 * THE OFFICE QUEUE'S RULES
 *
 * Three decisions the task queue makes on its own, kept here so the worker,
 * the API and the screens ask the same function:
 *
 *   Which day a recurring task is for, in the company's calendar.
 *   Whether a late task has been late long enough for a rule to act on it.
 *   Whether a task with a checklist may be closed.
 *
 * Every date here is a plain `YYYY-MM-DD` in the COMPANY'S calendar. The
 * service turns now into today in the company's timezone before asking, for
 * the reason recurrence gives: a day computed in UTC is the wrong day for
 * half the country for part of every evening.
 */

/* ------------------------------------------------------------- recurring */

export type TaskFrequency = "daily" | "weekly" | "monthly";

export interface TaskSchedule {
  frequency: TaskFrequency;
  /** For weekly: 0 is Sunday, 6 is Saturday. */
  weekday?: number | null | undefined;
  /** For monthly: 1 to 31, held to the month's length. */
  monthDay?: number | null | undefined;
  /** No occurrence before this day. */
  startsOn: string;
}

export const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

export type ScheduleVerdict = { ok: true } | { ok: false; message: string };

export function checkSchedule(schedule: TaskSchedule): ScheduleVerdict {
  try {
    parseDate(schedule.startsOn);
  } catch {
    return { ok: false, message: "The first day has to be a real date." };
  }
  if (schedule.frequency === "weekly") {
    const day = schedule.weekday;
    if (day === null || day === undefined || !Number.isInteger(day) || day < 0 || day > 6) {
      return { ok: false, message: "A weekly task needs the day of the week it comes round on." };
    }
  }
  if (schedule.frequency === "monthly") {
    const day = schedule.monthDay;
    if (day === null || day === undefined || !Number.isInteger(day) || day < 1 || day > 31) {
      return { ok: false, message: "A monthly task needs a day of the month, 1 to 31." };
    }
  }
  return { ok: true };
}

/** The day of the week a calendar date falls on, 0 for Sunday. */
export const weekdayOf = (date: string): number => parseDate(date).getUTCDay();

const daysInMonth = (year: number, monthIndex: number) =>
  new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/**
 * The monthly occurrence in the month a date falls in.
 *
 * The 31st in a thirty day month is the 30th, and in February the 28th or
 * 29th, because "the last working day's reconciliation" set for the 31st is
 * meant to happen every month rather than seven times a year.
 */
function monthlyIn(date: string, monthDay: number): string {
  const d = parseDate(date);
  const day = Math.min(monthDay, daysInMonth(d.getUTCFullYear(), d.getUTCMonth()));
  return `${date.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

/**
 * The most recent occurrence on or before a day, or null when the schedule
 * has not started by then.
 *
 * The worker raises THIS one and only this one. A worker that was down for a
 * week does not come back and raise seven daily van checks, six of them for
 * days that are over: the one worth doing is today's, and the queue filling
 * with stale copies is how people learn to ignore it.
 */
export function occurrenceOnOrBefore(schedule: TaskSchedule, day: string): string | null {
  if (compareDates(day, schedule.startsOn) < 0) return null;
  let found: string;
  switch (schedule.frequency) {
    case "daily":
      found = day;
      break;
    case "weekly": {
      const back = (weekdayOf(day) - (schedule.weekday ?? 0) + 7) % 7;
      found = addDays(day, -back);
      break;
    }
    case "monthly": {
      const thisMonth = monthlyIn(day, schedule.monthDay ?? 1);
      found = compareDates(thisMonth, day) <= 0
        ? thisMonth
        : monthlyIn(addMonths(`${day.slice(0, 8)}01`, -1), schedule.monthDay ?? 1);
      break;
    }
  }
  return compareDates(found, schedule.startsOn) < 0 ? null : found;
}

/** The first occurrence strictly after a day. What a screen shows as "next". */
export function occurrenceAfter(schedule: TaskSchedule, day: string): string {
  const from = compareDates(day, schedule.startsOn) < 0 ? addDays(schedule.startsOn, -1) : day;
  switch (schedule.frequency) {
    case "daily":
      return addDays(from, 1);
    case "weekly": {
      const ahead = ((schedule.weekday ?? 0) - weekdayOf(from) + 7) % 7 || 7;
      return addDays(from, ahead);
    }
    case "monthly": {
      const thisMonth = monthlyIn(from, schedule.monthDay ?? 1);
      return compareDates(thisMonth, from) > 0
        ? thisMonth
        : monthlyIn(addMonths(`${from.slice(0, 8)}01`, 1), schedule.monthDay ?? 1);
    }
  }
}

/**
 * The day a task should be raised for now, or null when there is nothing new.
 *
 * Nothing new means the latest occurrence has already been raised, or the
 * schedule has not started. `lastRaisedOn` is bookkeeping for the screen and
 * for skipping work; the unique index on the task is the guarantee, so a
 * stale value here costs one refused insert and never a second task.
 */
export function occurrenceToRaise(
  schedule: TaskSchedule, today: string, lastRaisedOn: string | null,
): string | null {
  const due = occurrenceOnOrBefore(schedule, today);
  if (!due) return null;
  if (lastRaisedOn && compareDates(due, lastRaisedOn) <= 0) return null;
  return due;
}

const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

/** The schedule as an owner would say it. */
export function describeSchedule(schedule: TaskSchedule): string {
  switch (schedule.frequency) {
    case "daily":
      return "Every day";
    case "weekly":
      return `Every ${WEEKDAYS[schedule.weekday ?? 0]}`;
    case "monthly":
      return (schedule.monthDay ?? 1) >= 29
        ? `On the ${ordinal(schedule.monthDay ?? 1)} of every month, or the last day when a month is shorter`
        : `On the ${ordinal(schedule.monthDay ?? 1)} of every month`;
  }
}

/* ------------------------------------------------------------ escalation */

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export const PRIORITY_RANK: Record<TaskPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** The longest a rule may wait: four weeks. Beyond that it is a report, not an escalation. */
export const MAX_ESCALATION_HOURS = 24 * 28;

export interface EscalationCandidate {
  dueAt: Date | null;
  status: string;
  priority: TaskPriority;
}

export interface EscalationRuleShape {
  afterHours: number;
  minimumPriority: TaskPriority | null;
}

/**
 * Whether a rule applies to a task now.
 *
 * Past due by at least the rule's hours, still open, and at or above the
 * rule's priority. Hours rather than working hours, deliberately and said
 * out loud: a task due Friday at five escalates on Saturday morning under a
 * twelve hour rule, which for a company with an on call week is right and for
 * one without is a reason to set the rule at sixty hours.
 */
export function escalationDue(
  task: EscalationCandidate, rule: EscalationRuleShape, now: Date,
): boolean {
  if (task.dueAt === null) return false;
  if (task.status !== "open" && task.status !== "in_progress") return false;
  if (rule.minimumPriority && PRIORITY_RANK[task.priority] < PRIORITY_RANK[rule.minimumPriority]) return false;
  return now.getTime() - task.dueAt.getTime() >= rule.afterHours * 3_600_000;
}

export function checkEscalationHours(hours: number): ScheduleVerdict {
  if (!Number.isInteger(hours) || hours < 1) {
    return { ok: false, message: "Say how many whole hours late, at least one." };
  }
  if (hours > MAX_ESCALATION_HOURS) {
    return { ok: false, message: "Four weeks late is a report, not an escalation. Use fewer hours." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------- checklist */

export type CloseVerdict =
  | { ok: true; overrideReason: string | null }
  | { ok: false; open: number; message: string };

/**
 * Whether a task may be closed, given its checklist.
 *
 * DONE with items unticked needs a reason, and the reason is kept apart from
 * the outcome: a van check closed with "gauge missing, tyres not checked" is
 * a finding, and folding it into "done" is how it stops being one.
 *
 * DISMISSING never asks, because a dismissal already carries its own reason
 * and "we decided not to" is not a claim that the items were done.
 */
export function closeVerdict(input: {
  items: readonly { done: boolean }[];
  dismissed: boolean;
  overrideReason?: string | null | undefined;
}): CloseVerdict {
  const open = input.items.filter((item) => !item.done).length;
  const reason = input.overrideReason?.trim() || null;
  if (input.dismissed || open === 0) return { ok: true, overrideReason: null };
  if (!reason) {
    return {
      ok: false, open,
      message: `${open === 1 ? "One item is" : `${open} items are`} not ticked. Tick ${open === 1 ? "it" : "them"}, or say why it is done anyway.`,
    };
  }
  return { ok: true, overrideReason: reason };
}

/** The most items one task's checklist may hold. A list longer than this is a procedure document. */
export const MAX_CHECKLIST_ITEMS = 50;
