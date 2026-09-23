import { dateIn, instantOfLocal, wallTimeExists } from "../time/index.js";

/**
 * CRON, AS DATA
 *
 * A schedule is parsed into a set of allowed minutes, hours, days, months and
 * weekdays, and then asked "when next". It is never evaluated, never turned
 * into a function, and never handed to anything that could run it. That is
 * the same rule the conditions in this module follow, and for the same
 * reason: a workflow builder in a product people self host must not be a way
 * to execute a string.
 *
 * IN THE COMPANY'S TIMEZONE, NOT THE SERVER'S. "Every night at eleven" means
 * eleven where the company is, on the day they would call tonight. A
 * container running in UTC would otherwise send a shop in Austin their
 * nightly summary at six in the evening, in the middle of the working day.
 * The whole reason this is harder than adding 86,400,000 to a timestamp is
 * that the answer has to survive the clocks changing.
 */

export interface Schedule {
  minutes: number[];
  hours: number[];
  /** Days of the month, 1 to 31. */
  daysOfMonth: number[];
  /** Months, 1 to 12. */
  months: number[];
  /** Days of the week, 0 to 6, Sunday first. */
  daysOfWeek: number[];
  /**
   * Whether the day fields were both narrowed.
   *
   * Cron's oldest wart, and it is load bearing: when a day of the month AND a
   * day of the week are both given, a day matching EITHER fires. So
   * `0 9 1 * 1` is the first of the month and every Monday, not the first of
   * the month when it happens to be a Monday. Getting this wrong makes a
   * schedule fire far more often than its author expected, which in a product
   * that sends texts is a bill and an unsubscribe.
   */
  bothDayFieldsRestricted: boolean;
}

export type ScheduleRefusal = { ok: false; reason: string };
export type ScheduleParse = { ok: true; schedule: Schedule } | ScheduleRefusal;

const RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 7],
} as const;

/** `jan` and `mon` are what people write. Accepting them costs two maps. */
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function named(token: string, field: keyof typeof RANGES): string {
  const lower = token.toLowerCase();
  if (field === "month") {
    const index = MONTH_NAMES.indexOf(lower);
    return index >= 0 ? String(index + 1) : token;
  }
  if (field === "dayOfWeek") {
    const index = DAY_NAMES.indexOf(lower);
    return index >= 0 ? String(index) : token;
  }
  return token;
}

/** One field, as the sorted list of values it allows. */
function parseField(raw: string, field: keyof typeof RANGES): number[] | null {
  const [min, max] = RANGES[field];
  const allowed = new Set<number>();

  for (const part of raw.split(",")) {
    if (part === "") return null;

    const [spec, stepText] = part.split("/");
    if (stepText !== undefined && !/^\d+$/.test(stepText)) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return null;

    let from: number;
    let to: number;
    if (spec === "*") {
      from = min;
      to = max;
    } else {
      const bounds = (spec ?? "").split("-").map((t) => named(t, field));
      if (bounds.length > 2 || bounds.some((b) => !/^\d+$/.test(b))) return null;
      from = Number(bounds[0]);
      to = bounds.length === 2 ? Number(bounds[1]) : from;
      // A bare number with a step means "from here to the end", which is what
      // `*/15` is a special case of and what `30/15` has to mean to be
      // consistent with it.
      if (bounds.length === 1 && stepText !== undefined) to = max;
    }

    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) allowed.add(value);
  }

  // Cron's other wart: 7 is Sunday, as is 0. Normalised here so nothing
  // downstream has to remember.
  if (field === "dayOfWeek" && allowed.delete(7)) allowed.add(0);

  return [...allowed].sort((a, b) => a - b);
}

/**
 * Parse a five field cron expression.
 *
 * Refused rather than guessed at. A schedule this build cannot read must not
 * quietly become "never", because a workflow that silently stops running is
 * the automation failure nobody notices until a customer does.
 */
export function parseSchedule(expression: string): ScheduleParse {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      reason: `A schedule has five fields (minute hour day month weekday). Got ${fields.length}.`,
    };
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const minutes = parseField(minute, "minute");
  const hours = parseField(hour, "hour");
  const daysOfMonth = parseField(dayOfMonth, "dayOfMonth");
  const months = parseField(month, "month");
  const daysOfWeek = parseField(dayOfWeek, "dayOfWeek");

  const bad = [
    minutes === null ? "minute" : null,
    hours === null ? "hour" : null,
    daysOfMonth === null ? "day of the month" : null,
    months === null ? "month" : null,
    daysOfWeek === null ? "day of the week" : null,
  ].filter(Boolean);
  if (bad.length > 0) return { ok: false, reason: `Could not read the ${bad.join(", ")} field.` };

  return {
    ok: true,
    schedule: {
      minutes: minutes!, hours: hours!, daysOfMonth: daysOfMonth!,
      months: months!, daysOfWeek: daysOfWeek!,
      bothDayFieldsRestricted: dayOfMonth !== "*" && dayOfWeek !== "*",
    },
  };
}

/** The calendar date `n` days after a `YYYY-MM-DD`, and its weekday. */
function calendar(date: string, add = 0) {
  const at = new Date(Date.parse(`${date}T00:00:00Z`) + add * 864e5);
  return {
    date: at.toISOString().slice(0, 10),
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    dayOfMonth: at.getUTCDate(),
    dayOfWeek: at.getUTCDay(),
  };
}

function dayMatches(schedule: Schedule, day: ReturnType<typeof calendar>): boolean {
  if (!schedule.months.includes(day.month)) return false;

  const byDate = schedule.daysOfMonth.includes(day.dayOfMonth);
  const byWeekday = schedule.daysOfWeek.includes(day.dayOfWeek);
  // See `bothDayFieldsRestricted`. Either, not both, when both are narrowed.
  return schedule.bothDayFieldsRestricted ? byDate || byWeekday : byDate && byWeekday;
}

/**
 * How far ahead to look before giving up.
 *
 * Four years covers the one genuinely rare schedule, 29 February, and bounds
 * a loop that would otherwise run forever on `0 0 30 2 *`: a date that never
 * happens, and one somebody will eventually type.
 */
const HORIZON_DAYS = 366 * 4;

/**
 * The next instant this schedule fires, strictly after `after`.
 *
 * Null when it never does, which is a real answer for `0 0 30 2 *` and much
 * better than a loop.
 *
 * Both daylight saving edges are decided here rather than left to whatever
 * the arithmetic happens to do:
 *
 *   FORWARD  A wall time that does not exist is skipped for that day. A
 *            nightly job at half past two does not run on the morning the
 *            clocks jump from two to three, because that morning has no half
 *            past two. Shifting it an hour would be a guess, and for the
 *            schedules people actually write, running late is worse than not
 *            running.
 *   BACK     A wall time that happens twice fires once, on the first. A
 *            summary sent twice reads as a bug to the person receiving it.
 */
export function nextRun(
  schedule: Schedule, after: Date, timeZone: string,
): Date | null {
  // Strictly after, at minute resolution, so a run at 09:00 does not
  // immediately schedule itself for 09:00 again.
  const floor = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const startDate = dateIn(floor, timeZone);

  for (let offset = 0; offset < HORIZON_DAYS; offset += 1) {
    const day = calendar(startDate, offset);
    if (!dayMatches(schedule, day)) continue;

    for (const hour of schedule.hours) {
      for (const minute of schedule.minutes) {
        const minutes = hour * 60 + minute;
        if (!wallTimeExists(day.date, minutes, timeZone)) continue;
        const instant = instantOfLocal(day.date, minutes, timeZone);
        if (instant >= floor) return instant;
      }
    }
  }

  return null;
}

/** Parse and ask in one step, for a caller holding an expression. */
export function nextRunOf(
  expression: string, after: Date, timeZone: string,
): Date | null {
  const parsed = parseSchedule(expression);
  return parsed.ok ? nextRun(parsed.schedule, after, timeZone) : null;
}

/** The schedule in words, for a screen that has to show what is set. */
export function describeSchedule(expression: string): string {
  const parsed = parseSchedule(expression);
  if (!parsed.ok) return parsed.reason;
  const s = parsed.schedule;

  const everyMinute = s.minutes.length === 60;
  const everyHour = s.hours.length === 24;
  const everyDay = s.daysOfMonth.length === 31 && s.daysOfWeek.length === 7;

  const clock = !everyMinute && !everyHour && s.hours.length === 1 && s.minutes.length === 1
    ? `${String(s.hours[0]).padStart(2, "0")}:${String(s.minutes[0]).padStart(2, "0")}`
    : null;

  if (clock && everyDay) return `Every day at ${clock}`;
  if (clock && s.daysOfWeek.length < 7 && s.daysOfMonth.length === 31) {
    const days = s.daysOfWeek.map((d) => DAY_NAMES[d]!.replace(/^./, (c) => c.toUpperCase()));
    return `${days.join(", ")} at ${clock}`;
  }
  if (clock) return `At ${clock}, on the schedule ${expression}`;
  return `On the schedule ${expression}`;
}
