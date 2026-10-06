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

/**
 * How a task comes round.
 *
 * `every_other_week` is a weekday every second week, counted from the first
 * such weekday on or after `startsOn`, so "Starting" on the form is what says
 * which of the two weeks is the on week. `every_n_weeks` is the same count
 * with any gap, so every third Monday is counted the same way and an every
 * other week task is simply the one with a gap of two. `weekdays` is Monday
 * to Friday and nothing else; `chosen_weekdays` is whichever days a company
 * works, Monday, Wednesday and Saturday for a crew that does. The last of the
 * month is the last Friday (or whichever day), which is the fourth in some
 * months and the fifth in others, and `nth_weekday_of_month` is the first,
 * second, third or fourth, which every month has.
 */
export type TaskFrequency =
  | "daily" | "weekdays" | "weekly" | "every_other_week" | "monthly" | "last_weekday_of_month"
  | "nth_weekday_of_month" | "every_n_weeks" | "chosen_weekdays";

export const TASK_FREQUENCIES: readonly TaskFrequency[] = [
  "daily", "weekdays", "weekly", "every_other_week", "monthly", "last_weekday_of_month",
  "nth_weekday_of_month", "every_n_weeks", "chosen_weekdays",
];

/** The frequencies that come round on a named day of the week. */
export const NEEDS_WEEKDAY: readonly TaskFrequency[] = [
  "weekly", "every_other_week", "last_weekday_of_month", "nth_weekday_of_month", "every_n_weeks",
];

/**
 * The most weeks between two occurrences: a year. A gap longer than that is
 * a date in a calendar rather than something that comes round.
 */
export const MAX_INTERVAL_WEEKS = 52;

export interface TaskSchedule {
  frequency: TaskFrequency;
  /** For the frequencies in `NEEDS_WEEKDAY`: 0 is Sunday, 6 is Saturday. */
  weekday?: number | null | undefined;
  /** For monthly: 1 to 31, held to the month's length. */
  monthDay?: number | null | undefined;
  /** For the given weekday of the month: 1 is the first, 4 the fourth. The last has its own frequency. */
  monthWeek?: number | null | undefined;
  /** For every so many weeks: 2 to 52. */
  intervalWeeks?: number | null | undefined;
  /** For chosen weekdays: the days, 0 for Sunday, at least one. */
  daysOfWeek?: readonly number[] | null | undefined;
  /** No occurrence before this day. */
  startsOn: string;
}

/** The weeks of the month a "given weekday" task can be on. Every month has four of each weekday. */
export const MONTH_WEEKS = ["first", "second", "third", "fourth"] as const;

/**
 * The days a chosen weekdays schedule holds, cleaned: each once, in order,
 * Sunday first. What the service stores, so two templates choosing the same
 * days in a different order read back the same.
 */
export const cleanDays = (days: readonly number[] | null | undefined): number[] =>
  [...new Set((days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);

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
  if (NEEDS_WEEKDAY.includes(schedule.frequency)) {
    const day = schedule.weekday;
    if (day === null || day === undefined || !Number.isInteger(day) || day < 0 || day > 6) {
      return {
        ok: false,
        message: schedule.frequency === "weekly"
          ? "A weekly task needs the day of the week it comes round on."
          : schedule.frequency === "every_other_week" || schedule.frequency === "every_n_weeks"
            ? "A task every few weeks needs the day of the week it comes round on."
            : schedule.frequency === "nth_weekday_of_month"
              ? "Say which day of the week it is, the first Monday of the month for example."
              : "Say which day of the week the last one is, the last Friday of the month for example.",
      };
    }
  }
  if (schedule.frequency === "nth_weekday_of_month") {
    const week = schedule.monthWeek;
    if (week === null || week === undefined || !Number.isInteger(week) || week < 1 || week > 4) {
      return {
        ok: false,
        message: "Say which one in the month: the first, second, third or fourth. For the last one, choose the last of the month.",
      };
    }
  }
  if (schedule.frequency === "every_n_weeks") {
    const weeks = schedule.intervalWeeks;
    if (weeks === null || weeks === undefined || !Number.isInteger(weeks) || weeks < 2 || weeks > MAX_INTERVAL_WEEKS) {
      return {
        ok: false,
        message: `Say every how many weeks, from 2 to ${MAX_INTERVAL_WEEKS}. A task every week is a weekly one.`,
      };
    }
  }
  if (schedule.frequency === "chosen_weekdays") {
    const raw = schedule.daysOfWeek ?? [];
    if (raw.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return { ok: false, message: "A day of the week is 0 for Sunday to 6 for Saturday." };
    }
    if (cleanDays(raw).length === 0) {
      return { ok: false, message: "Tick at least one day of the week it comes round on." };
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

/** Whole days from one calendar date to a later one. */
const daysBetween = (from: string, to: string): number =>
  Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000);

/**
 * The last given weekday in the month a date falls in: the last Friday of
 * October, whichever date that is. Walks back from the month's last day, so a
 * month whose last day is a Friday gives that day and no later one is possible.
 */
function lastWeekdayIn(date: string, weekday: number): string {
  const d = parseDate(date);
  const last = daysInMonth(d.getUTCFullYear(), d.getUTCMonth());
  const lastDay = `${date.slice(0, 8)}${String(last).padStart(2, "0")}`;
  const back = (weekdayOf(lastDay) - weekday + 7) % 7;
  return addDays(lastDay, -back);
}

/**
 * The given weekday's nth occurrence in the month a date falls in: the first
 * Monday of October, the third Thursday. Never past the 28th, because the
 * fourth of any weekday is at most the 28th, which is why the fifth is not
 * offered: it is missing from most months, and "the last" is its own choice.
 */
function nthWeekdayIn(date: string, weekday: number, week: number): string {
  const first = `${date.slice(0, 8)}01`;
  const ahead = (weekday - weekdayOf(first) + 7) % 7;
  return addDays(first, ahead + 7 * (week - 1));
}

/** The gap in days between two occurrences of a task that comes round every so many weeks. */
const gapOf = (schedule: TaskSchedule): number =>
  7 * (schedule.frequency === "every_other_week" ? 2 : schedule.intervalWeeks ?? 2);

/**
 * The first occurrence of an every other week (or every so many weeks)
 * task: the first of its weekday on or after the day it starts. Every later
 * one is a whole number of gaps from it, so which week is the on week never
 * depends on today.
 */
function firstEveryOtherWeek(schedule: TaskSchedule): string {
  const ahead = ((schedule.weekday ?? 0) - weekdayOf(schedule.startsOn) + 7) % 7;
  return addDays(schedule.startsOn, ahead);
}

/** Whether a day is one of a chosen weekdays schedule's days. */
const isChosenDay = (schedule: TaskSchedule, date: string): boolean =>
  cleanDays(schedule.daysOfWeek).includes(weekdayOf(date));

/** Saturday and Sunday are not working days; a weekend day belongs to the Friday before it. */
const isWeekend = (date: string): boolean => {
  const day = weekdayOf(date);
  return day === 0 || day === 6;
};

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
    case "weekdays": {
      // Saturday and Sunday are the Friday's: the worker raises the latest
      // working day, never a weekend one.
      const back = weekdayOf(day) === 0 ? 2 : weekdayOf(day) === 6 ? 1 : 0;
      found = addDays(day, -back);
      break;
    }
    case "weekly": {
      const back = (weekdayOf(day) - (schedule.weekday ?? 0) + 7) % 7;
      found = addDays(day, -back);
      break;
    }
    case "every_other_week":
    case "every_n_weeks": {
      const first = firstEveryOtherWeek(schedule);
      if (compareDates(day, first) < 0) return null;
      const gap = gapOf(schedule);
      found = addDays(first, Math.floor(daysBetween(first, day) / gap) * gap);
      break;
    }
    case "chosen_weekdays": {
      // The latest chosen day in the week up to today. A schedule with no
      // days chosen is refused when it is saved, so this always finds one.
      let back = 0;
      while (back < 7 && !isChosenDay(schedule, addDays(day, -back))) back += 1;
      if (back === 7) return null;
      found = addDays(day, -back);
      break;
    }
    case "nth_weekday_of_month": {
      const week = schedule.monthWeek ?? 1;
      const thisMonth = nthWeekdayIn(day, schedule.weekday ?? 0, week);
      found = compareDates(thisMonth, day) <= 0
        ? thisMonth
        : nthWeekdayIn(addMonths(`${day.slice(0, 8)}01`, -1), schedule.weekday ?? 0, week);
      break;
    }
    case "monthly": {
      const thisMonth = monthlyIn(day, schedule.monthDay ?? 1);
      found = compareDates(thisMonth, day) <= 0
        ? thisMonth
        : monthlyIn(addMonths(`${day.slice(0, 8)}01`, -1), schedule.monthDay ?? 1);
      break;
    }
    case "last_weekday_of_month": {
      const thisMonth = lastWeekdayIn(day, schedule.weekday ?? 0);
      found = compareDates(thisMonth, day) <= 0
        ? thisMonth
        : lastWeekdayIn(addMonths(`${day.slice(0, 8)}01`, -1), schedule.weekday ?? 0);
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
    case "weekdays": {
      let next = addDays(from, 1);
      while (isWeekend(next)) next = addDays(next, 1);
      return next;
    }
    case "weekly": {
      const ahead = ((schedule.weekday ?? 0) - weekdayOf(from) + 7) % 7 || 7;
      return addDays(from, ahead);
    }
    case "every_other_week":
    case "every_n_weeks": {
      const first = firstEveryOtherWeek(schedule);
      if (compareDates(from, first) < 0) return first;
      const gap = gapOf(schedule);
      return addDays(first, (Math.floor(daysBetween(first, from) / gap) + 1) * gap);
    }
    case "chosen_weekdays": {
      let next = addDays(from, 1);
      for (let i = 0; i < 7 && !isChosenDay(schedule, next); i += 1) next = addDays(next, 1);
      return next;
    }
    case "nth_weekday_of_month": {
      const week = schedule.monthWeek ?? 1;
      const thisMonth = nthWeekdayIn(from, schedule.weekday ?? 0, week);
      return compareDates(thisMonth, from) > 0
        ? thisMonth
        : nthWeekdayIn(addMonths(`${from.slice(0, 8)}01`, 1), schedule.weekday ?? 0, week);
    }
    case "monthly": {
      const thisMonth = monthlyIn(from, schedule.monthDay ?? 1);
      return compareDates(thisMonth, from) > 0
        ? thisMonth
        : monthlyIn(addMonths(`${from.slice(0, 8)}01`, 1), schedule.monthDay ?? 1);
    }
    case "last_weekday_of_month": {
      const thisMonth = lastWeekdayIn(from, schedule.weekday ?? 0);
      return compareDates(thisMonth, from) > 0
        ? thisMonth
        : lastWeekdayIn(addMonths(`${from.slice(0, 8)}01`, 1), schedule.weekday ?? 0);
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

/**
 * Days as an owner would list them, Monday first, because a working week
 * starts on a Monday: "Monday, Wednesday and Saturday".
 */
function listDays(days: readonly number[]): string {
  const names = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WEEKDAYS[d] ?? "");
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The schedule as an owner would say it. */
export function describeSchedule(schedule: TaskSchedule): string {
  switch (schedule.frequency) {
    case "daily":
      return "Every day";
    case "weekdays":
      return "Every weekday, Monday to Friday";
    case "weekly":
      return `Every ${WEEKDAYS[schedule.weekday ?? 0]}`;
    case "every_other_week":
      return `Every other ${WEEKDAYS[schedule.weekday ?? 0]}`;
    case "last_weekday_of_month":
      return `On the last ${WEEKDAYS[schedule.weekday ?? 0]} of every month`;
    case "nth_weekday_of_month":
      return `On the ${MONTH_WEEKS[(schedule.monthWeek ?? 1) - 1] ?? "first"} ${WEEKDAYS[schedule.weekday ?? 0]} of every month`;
    case "every_n_weeks":
      return `Every ${schedule.intervalWeeks ?? 2} weeks on ${WEEKDAYS[schedule.weekday ?? 0]}`;
    case "chosen_weekdays":
      return `Every ${listDays(cleanDays(schedule.daysOfWeek))}`;
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
