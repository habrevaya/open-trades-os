import { addDays, addMonths, compareDates, parseDate } from "../recurrence/index.js";
import { workingMinutesBetween, type WorkingCalendar } from "../holidays/index.js";

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
 * works, Monday, Wednesday and Saturday for a crew that does. An every other
 * week or every so many weeks task may name SEVERAL days (every third Monday
 * and Thursday): then the weeks, Monday to Sunday, are counted from the week of
 * its first day, and it comes round on each named day of every on week. The last of the
 * month is the last Friday (or whichever day), which is the fourth in some
 * months and the fifth in others, and `nth_weekday_of_month` is the first,
 * second, third or fourth, which every month has, or the fifth, which only
 * some months have: a month without one is skipped, and is not moved to the
 * last one (that is `last_weekday_of_month`).
 */
export type TaskFrequency =
  | "daily" | "weekdays" | "weekly" | "every_other_week" | "monthly" | "last_weekday_of_month"
  | "nth_weekday_of_month" | "every_n_weeks" | "chosen_weekdays";

export const TASK_FREQUENCIES: readonly TaskFrequency[] = [
  "daily", "weekdays", "weekly", "every_other_week", "monthly", "last_weekday_of_month",
  "nth_weekday_of_month", "every_n_weeks", "chosen_weekdays",
];

/** The two that count weeks, and so may name several days of the week they come round on. */
export const EVERY_SO_MANY_WEEKS: readonly TaskFrequency[] = ["every_other_week", "every_n_weeks"];

/** The frequencies that come round on a named day of the week. */
export const NEEDS_WEEKDAY: readonly TaskFrequency[] = [
  "weekly", "every_other_week", "last_weekday_of_month", "nth_weekday_of_month", "every_n_weeks",
];

/**
 * The most weeks between two occurrences: five years. A gap longer than that
 * is a date in a calendar rather than something that comes round. A gap of
 * more than a year (every 104 weeks, every 156) is counted in days from the
 * first occurrence like any other, so it drifts a day against the calendar
 * across a leap year and is not "every two years on the same date".
 */
export const MAX_INTERVAL_WEEKS = 260;

export interface TaskSchedule {
  frequency: TaskFrequency;
  /** For the frequencies in `NEEDS_WEEKDAY`: 0 is Sunday, 6 is Saturday. */
  weekday?: number | null | undefined;
  /** For monthly: 1 to 31, held to the month's length. */
  monthDay?: number | null | undefined;
  /**
   * For the given weekday of the month: 1 is the first, 4 the fourth, 5 the fifth
   * (which only some months have, and a month without one is skipped). The last
   * has its own frequency.
   */
  monthWeek?: number | null | undefined;
  /** For every so many weeks: 2 to 260. */
  intervalWeeks?: number | null | undefined;
  /**
   * For chosen weekdays: the days, 0 for Sunday, at least one. For every other
   * week and every so many weeks: the days it comes round on when more than one
   * (a single day is `weekday`); when it holds two or more it is read in
   * place of `weekday`.
   */
  daysOfWeek?: readonly number[] | null | undefined;
  /** No occurrence before this day. */
  startsOn: string;
}

/**
 * The weeks of the month a "given weekday" task can be on. Every month has four
 * of each weekday; the fifth is in the months that run long enough, and the
 * others are skipped.
 */
export const MONTH_WEEKS = ["first", "second", "third", "fourth", "fifth"] as const;

/** The most a "given weekday of the month" can be counted to. */
export const MOST_MONTH_WEEK = 5;

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
  const counted = EVERY_SO_MANY_WEEKS.includes(schedule.frequency);
  if (counted && (schedule.daysOfWeek ?? []).some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return { ok: false, message: "A day of the week is 0 for Sunday to 6 for Saturday." };
  }
  /** A task counted in weeks is happy with ticked days in place of the one weekday. */
  const ticked = counted ? cleanDays(schedule.daysOfWeek) : [];
  const hasDays = ticked.length > 0;
  if (
    ticked.length === 1 && schedule.weekday !== null && schedule.weekday !== undefined && schedule.weekday !== ticked[0]
  ) {
    return {
      ok: false,
      message: "Give the day of the week in one place: the one day of the week, or the days you tick, not two different ones.",
    };
  }
  if (NEEDS_WEEKDAY.includes(schedule.frequency) && !hasDays) {
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
    if (week === null || week === undefined || !Number.isInteger(week) || week < 1 || week > MOST_MONTH_WEEK) {
      return {
        ok: false,
        message: "Say which one in the month: the first, second, third, fourth or fifth. For the last one, choose the last of the month.",
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
 * Monday of October, the third Thursday. The first to fourth are never past the
 * 28th, so every month has them. The fifth is past the end of a month that is
 * too short for it, and then there is none: null, and the month is skipped.
 */
function nthWeekdayIn(date: string, weekday: number, week: number): string | null {
  const first = `${date.slice(0, 8)}01`;
  const ahead = (weekday - weekdayOf(first) + 7) % 7;
  const found = addDays(first, ahead + 7 * (week - 1));
  return found.slice(0, 7) === first.slice(0, 7) ? found : null;
}

/** How many months to look back or forward for a month that has the one asked for: every weekday has a fifth within five. */
const MONTHS_TO_LOOK = 24;

/** The latest nth weekday of a month on or before a day, in this month or one before it. */
function nthOnOrBefore(day: string, weekday: number, week: number): string | null {
  let month = `${day.slice(0, 8)}01`;
  for (let i = 0; i < MONTHS_TO_LOOK; i += 1) {
    const found = nthWeekdayIn(month, weekday, week);
    if (found && compareDates(found, day) <= 0) return found;
    month = addMonths(month, -1);
  }
  return null;
}

/** The first nth weekday of a month strictly after a day, in this month or one after it. */
function nthAfter(day: string, weekday: number, week: number): string {
  let month = `${day.slice(0, 8)}01`;
  for (let i = 0; i < MONTHS_TO_LOOK; i += 1) {
    const found = nthWeekdayIn(month, weekday, week);
    if (found && compareDates(found, day) > 0) return found;
    month = addMonths(month, 1);
  }
  throw new Error("No month in the next two years has that day.");
}

/**
 * The days an every other week or every so many weeks task comes round on:
 * the ticked days when it has two or more, else its one weekday (or its one
 * ticked day, for a schedule saved without `weekday`).
 */
export function everySoManyWeeksDays(schedule: TaskSchedule): number[] {
  const ticked = cleanDays(schedule.daysOfWeek);
  if (ticked.length >= 2) return ticked;
  if (schedule.weekday !== null && schedule.weekday !== undefined) return [schedule.weekday];
  return ticked.length === 1 ? ticked : [0];
}

/** The Monday of the week a date is in. Weeks run Monday to Sunday, as a working week does. */
const mondayOf = (date: string): string => addDays(date, -((weekdayOf(date) + 6) % 7));

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
  const days = everySoManyWeeksDays(schedule);
  const ahead = Math.min(...days.map((d) => (d - weekdayOf(schedule.startsOn) + 7) % 7));
  return addDays(schedule.startsOn, ahead);
}

/**
 * Whether a day is an occurrence of an every so many weeks task that names
 * several days: one of the days, on or after the first, in an on week. The on
 * weeks (Monday to Sunday) are the week of the first occurrence and every gap
 * after it, so "Starting" says which week is the on week, as it does for one day.
 */
function isOccurrenceOnSeveralDays(schedule: TaskSchedule, date: string): boolean {
  const first = firstEveryOtherWeek(schedule);
  if (compareDates(date, first) < 0) return false;
  if (!everySoManyWeeksDays(schedule).includes(weekdayOf(date))) return false;
  const weeks = daysBetween(mondayOf(first), mondayOf(date)) / 7;
  return weeks % (gapOf(schedule) / 7) === 0;
}

/** Whether an every so many weeks task names more than one day. */
const namesSeveralDays = (schedule: TaskSchedule): boolean => everySoManyWeeksDays(schedule).length > 1;

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
      if (namesSeveralDays(schedule)) {
        /** The latest named day in an on week: at most a gap and a week back. */
        let back = 0;
        while (back <= gap + 7 && !isOccurrenceOnSeveralDays(schedule, addDays(day, -back))) back += 1;
        if (back > gap + 7) return null;
        found = addDays(day, -back);
        break;
      }
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
      const earlier = nthOnOrBefore(day, schedule.weekday ?? 0, schedule.monthWeek ?? 1);
      if (earlier === null) return null;
      found = earlier;
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
      if (namesSeveralDays(schedule)) {
        let next = addDays(from, 1);
        for (let i = 0; i <= gap + 7 && !isOccurrenceOnSeveralDays(schedule, next); i += 1) next = addDays(next, 1);
        return next;
      }
      return addDays(first, (Math.floor(daysBetween(first, from) / gap) + 1) * gap);
    }
    case "chosen_weekdays": {
      let next = addDays(from, 1);
      for (let i = 0; i < 7 && !isChosenDay(schedule, next); i += 1) next = addDays(next, 1);
      return next;
    }
    case "nth_weekday_of_month": {
      return nthAfter(from, schedule.weekday ?? 0, schedule.monthWeek ?? 1);
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
      return namesSeveralDays(schedule)
        ? `Every other week on ${listDays(everySoManyWeeksDays(schedule))}`
        : `Every other ${WEEKDAYS[everySoManyWeeksDays(schedule)[0] ?? 0]}`;
    case "last_weekday_of_month":
      return `On the last ${WEEKDAYS[schedule.weekday ?? 0]} of every month`;
    case "nth_weekday_of_month":
      return (schedule.monthWeek ?? 1) === 5
        ? `On the fifth ${WEEKDAYS[schedule.weekday ?? 0]} of the month, and a month without a fifth ${WEEKDAYS[schedule.weekday ?? 0]} is skipped`
        : `On the ${MONTH_WEEKS[(schedule.monthWeek ?? 1) - 1] ?? "first"} ${WEEKDAYS[schedule.weekday ?? 0]} of every month`;
    case "every_n_weeks":
      return `Every ${schedule.intervalWeeks ?? 2} weeks on ${listDays(everySoManyWeeksDays(schedule))}`;
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
  /**
   * Count only the company's working hours: inside its business hours, on a
   * day it is open, skipping its holidays. False counts the clock, as every
   * rule did before this existed.
   */
  workingHours?: boolean | undefined;
}

/**
 * How late a task is, in minutes, the way a rule counts it.
 *
 * A clock rule counts every minute. A working hours rule counts only the
 * minutes the company is open, and needs the company's calendar to know
 * which. Asked for working hours with no calendar to read, it counts the
 * clock: a rule that cannot tell when the company is open must not go quiet,
 * because the failure of a late task nobody was told about is worse than the
 * failure of one told about early.
 */
export function minutesLate(
  dueAt: Date, now: Date, workingHours: boolean | undefined, calendar: WorkingCalendar | null | undefined,
  stopAt: number = Number.POSITIVE_INFINITY,
): number {
  if (workingHours && calendar) return workingMinutesBetween(dueAt, now, calendar, stopAt);
  return Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / 60_000));
}

/**
 * Whether a rule applies to a task now.
 *
 * Past due by at least the rule's hours, still open, and at or above the
 * rule's priority. By default the hours are clock hours, said out loud: a
 * task due Friday at five escalates on Saturday morning under a twelve hour
 * rule, which for a company with an on call week is right. A rule set to
 * count working hours reads the company's business hours and holiday list
 * instead, so the same task escalates on Tuesday at eleven under a twelve hour
 * rule for a company that opens at eight and closes at five, after counting
 * Monday's nine hours and the first three of Tuesday's.
 */
export function escalationDue(
  task: EscalationCandidate, rule: EscalationRuleShape, now: Date, calendar?: WorkingCalendar | null,
): boolean {
  if (task.dueAt === null) return false;
  if (task.status !== "open" && task.status !== "in_progress") return false;
  if (rule.minimumPriority && PRIORITY_RANK[task.priority] < PRIORITY_RANK[rule.minimumPriority]) return false;
  const needed = rule.afterHours * 60;
  return minutesLate(task.dueAt, now, rule.workingHours, calendar, needed) >= needed;
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

/* ------------------------------------------------------- reporting lines */

/**
 * Whether setting a reporting line would make a loop, and who is in it.
 *
 * `lines` is each person's current manager (a user id to a user id, or null).
 * Setting `userId` to report to `managerId` makes a loop when walking up from
 * the manager comes back to `userId`: A to B and B to A, or A to B, B to C and
 * C to A. The people returned are in the order they report: the person, then
 * their new manager, then each step up until the last one, who reports to the
 * person. Null when there is no loop.
 *
 * The walk keeps what it has visited, so a loop that an older edit left in
 * the data (and that does not include `userId`) ends the walk instead of
 * going round for ever, and is not blamed on this change.
 */
export function reportingLoop(
  lines: ReadonlyMap<string, string | null>, userId: string, managerId: string,
): string[] | null {
  const path = [userId, managerId];
  const seen = new Set(path);
  let next = lines.get(managerId) ?? null;
  while (next) {
    if (next === userId) return path;
    if (seen.has(next)) return null;
    seen.add(next);
    path.push(next);
    next = lines.get(next) ?? null;
  }
  return null;
}

/**
 * The sentence that names a loop, in the order people report.
 *
 * "Ana would report to Ben, and Ben reports to Ana." or, for a longer one,
 * "Ana would report to Ben, Ben reports to Cy, and Cy reports to Ana." The
 * names come from the caller, so a person with no name is shown by their email.
 */
export function describeReportingLoop(names: readonly string[]): string {
  const [first, ...rest] = names;
  if (!first || rest.length === 0) return "That would make a loop.";
  const steps = rest.map((name, i) => `${i === 0 ? first : names[i]} ${i === 0 ? "would report" : "reports"} to ${name}`);
  steps.push(`${names[names.length - 1]} reports to ${first}`);
  const last = steps.pop();
  return `That would make a loop. ${steps.join(", ")}, and ${last}. Change one of those lines first.`;
}

/**
 * EVERY LOOP ALREADY IN THE DATA.
 *
 * `reportingLoop` refuses a NEW line that would close a loop. Lines saved before
 * that check existed, or by a path that did not run it, can already be loops:
 * Ana reports to Ben and Ben to Ana. This walks the whole company and returns
 * each loop once, as the people in it in reporting order (each reports to the
 * next, and the last to the first), starting from whoever comes first in the
 * order `lines` was given in, so a caller that sorts the people by name gets the
 * same loop named from the same person every time.
 *
 * Every person has at most one manager, so a person is in at most one loop and
 * a walk up the lines either ends at someone with no manager or closes exactly
 * one loop. People who only lead INTO a loop (they report to someone in it, and
 * nobody in the loop reports to them) are not in it and are not returned.
 * A person recorded as their own manager is a loop of one. It only reads: it
 * names loops and never changes a line.
 */
export function reportingLoopsInData(lines: ReadonlyMap<string, string | null>): string[][] {
  const state = new Map<string, "walking" | "done">();
  const order = new Map([...lines.keys()].map((id, i) => [id, i] as const));
  const loops: string[][] = [];
  for (const start of lines.keys()) {
    if (state.has(start)) continue;
    const walk: string[] = [];
    let at: string | null = start;
    while (at && lines.has(at) && !state.has(at)) {
      state.set(at, "walking");
      walk.push(at);
      at = lines.get(at) ?? null;
    }
    if (at && state.get(at) === "walking") {
      const loop = walk.slice(walk.indexOf(at));
      /** Start from whoever came first, keeping the order people report in. */
      let first = 0;
      loop.forEach((id, i) => { if ((order.get(id) ?? 0) < (order.get(loop[first]!) ?? 0)) first = i; });
      loops.push([...loop.slice(first), ...loop.slice(0, first)]);
    }
    for (const id of walk) state.set(id, "done");
  }
  return loops.sort((a, b) => (order.get(a[0]!) ?? 0) - (order.get(b[0]!) ?? 0));
}

/**
 * A loop already in the data, in words: "Ana reports to Ben, Ben reports to
 * Cy, and Cy reports to Ana." Names come from the caller in the loop's order.
 * Nothing in it says how to mend it, because which line is wrong is the
 * company's to say.
 */
export function describeExistingLoop(names: readonly string[]): string {
  const [first, ...rest] = names;
  if (first === undefined) return "";
  if (rest.length === 0) return `${first} is recorded as reporting to themselves.`;
  const steps = names.map((name, i) => `${name} reports to ${names[(i + 1) % names.length]}`);
  const last = steps.pop();
  return steps.length === 0 ? `${last}.` : `${steps.join(", ")}${steps.length > 1 ? "," : ""} and ${last}.`;
}

/**
 * THE TASK THE DAILY LOOP SCAN RAISES
 *
 * One task for the whole company, whatever the number of loops, naming each in
 * words. It says nothing was changed and where to change it, because which line
 * in a loop is the wrong one is the company's to say. It never says who is at
 * fault.
 */
export function reportingLoopTaskTitle(loops: number): string {
  return loops === 1 ? "There is a loop in who answers to whom" : `There are ${loops} loops in who answers to whom`;
}

export function reportingLoopTaskBody(sentences: readonly string[]): string {
  return `${sentences.join(" ")} `
    + "While a loop stands, a late task is told to somebody who answers to the person it would tell. "
    + "Nothing was changed. Open Tasks, then Escalation, and change one line in each loop. "
    + "This task closes itself when no loop is left.";
}

/**
 * A short mark of which loops there are, so a task somebody dismissed is not
 * raised again for the same loops. The people in each loop in order of their
 * ids, the loops in order of their first, so the mark does not change when the
 * scan starts from a different person.
 */
export function reportingLoopsMark(loops: readonly (readonly string[])[]): string {
  return loops
    .map((loop) => [...loop].sort().join("+"))
    .sort()
    .join("|");
}
