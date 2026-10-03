import { nextRun, type Schedule } from "../automation/schedule.js";
import { dateIn } from "../time/index.js";

/**
 * WHEN A REPORT ARRIVES, AS DATA
 *
 * "Every Monday at seven" is what an owner asks for, and a five field cron
 * expression is what the engine already knows how to plan against in the
 * company's timezone, through a daylight saving change, without firing twice
 * when the clocks go back. So a cadence is the three shapes a person picks on
 * a screen, and it is turned into the same `Schedule` the workflow clock uses
 * rather than into a second clock that would have to learn all of that again.
 *
 * Three shapes and not cron itself, because the screen this sits behind is for
 * a contractor rather than for somebody who knows what `0 7 * * 1` means, and
 * every shape here is one that reads back as a sentence.
 */

export type Frequency = "daily" | "weekly" | "monthly";

export interface Cadence {
  frequency: Frequency;
  /** ISO weekdays, Monday 1 to Sunday 7. Weekly only. */
  weekdays?: number[] | undefined;
  /**
   * A day of the month, 1 to 28. Monthly only.
   *
   * Twenty eight and not thirty one, because a report set for the thirty first
   * does not arrive in February, April, June, September or November, and the
   * person who set it finds out by not getting it. The first of the month is
   * what nearly everybody wants anyway.
   */
  dayOfMonth?: number | undefined;
  /** Wall clock time in the company's timezone, `HH:MM`, 24 hour. */
  time: string;
}

export type CadenceCheck = { ok: true; cadence: Cadence } | { ok: false; reason: string };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Whether a cadence is one that will actually fire, and the tidy version of it.
 *
 * Refused rather than repaired, each in words. A weekly report with no day
 * ticked would be saved, look scheduled, and never arrive, which is the
 * failure every scheduling feature in this product is written to make
 * impossible.
 */
export function checkCadence(input: {
  frequency: string;
  weekdays?: number[] | undefined;
  dayOfMonth?: number | undefined;
  time: string;
}): CadenceCheck {
  const time = input.time.trim();
  if (!TIME.test(time)) return { ok: false, reason: "Give a time of day like 07:00." };

  if (input.frequency === "daily") return { ok: true, cadence: { frequency: "daily", time } };

  if (input.frequency === "weekly") {
    const weekdays = [...new Set(input.weekdays ?? [])].sort((a, b) => a - b);
    if (weekdays.length === 0) return { ok: false, reason: "Pick at least one day of the week." };
    if (weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return { ok: false, reason: "A day of the week is Monday to Sunday." };
    }
    return { ok: true, cadence: { frequency: "weekly", weekdays, time } };
  }

  if (input.frequency === "monthly") {
    const day = input.dayOfMonth;
    if (day === undefined || !Number.isInteger(day) || day < 1 || day > 28) {
      return {
        ok: false,
        reason: "Pick a day of the month from 1 to 28. Later days do not exist in every month, "
          + "and a report set for the 31st would silently skip five months a year.",
      };
    }
    return { ok: true, cadence: { frequency: "monthly", dayOfMonth: day, time } };
  }

  return { ok: false, reason: `There is no such frequency as "${input.frequency}".` };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** The cadence as the engine's own schedule. Sunday is 7 here and 0 there. */
export function scheduleOf(cadence: Cadence): Schedule {
  const [hour, minute] = cadence.time.split(":").map(Number) as [number, number];
  return {
    minutes: [minute],
    hours: [hour],
    daysOfMonth: cadence.frequency === "monthly" ? [cadence.dayOfMonth ?? 1] : range(1, 31),
    months: range(1, 12),
    daysOfWeek: cadence.frequency === "weekly"
      ? (cadence.weekdays ?? []).map((d) => d % 7).sort((a, b) => a - b)
      : range(0, 6),
    bothDayFieldsRestricted: false,
  };
}

/** The next time it is due, strictly after `after`, in the company's timezone. */
export function nextDelivery(cadence: Cadence, after: Date, timeZone: string): Date | null {
  return nextRun(scheduleOf(cadence), after, timeZone);
}

const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function clock(time: string): string {
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

function list(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "Every Monday and Thursday at 7:00 AM", for the screen and the email. */
export function describeCadence(cadence: Cadence): string {
  if (cadence.frequency === "daily") return `Every day at ${clock(cadence.time)}`;
  if (cadence.frequency === "weekly") {
    const days = cadence.weekdays ?? [];
    if (days.length === 5 && days.every((d, i) => d === i + 1)) {
      return `Every weekday at ${clock(cadence.time)}`;
    }
    return `Every ${list(days.map((d) => WEEKDAYS[d] ?? String(d)))} at ${clock(cadence.time)}`;
  }
  return `On the ${ordinal(cadence.dayOfMonth ?? 1)} of every month at ${clock(cadence.time)}`;
}

/* ----------------------------------------------------------------- periods */

/**
 * WHICH DAYS A DELIVERED REPORT COVERS
 *
 * A report that arrives on Monday morning is about last week, and one that
 * arrives on the first is about last month. Without a period it would be about
 * everything since the company started, which is the right answer to almost
 * nothing anybody schedules.
 *
 * Every period ENDS BEFORE THE DAY IT IS DELIVERED. A report delivered at seven
 * in the morning about "today" would be a seventh of a day, and the person
 * reading it would take it for the day.
 */
export type Period = "all" | "yesterday" | "last_7_days" | "last_month" | "month_to_date";

export const PERIODS: { key: Period; label: string }[] = [
  { key: "yesterday", label: "The day before" },
  { key: "last_7_days", label: "The seven days before" },
  { key: "last_month", label: "The month before" },
  { key: "month_to_date", label: "This month so far" },
  { key: "all", label: "Everything, with no dates" },
];

export const isPeriod = (value: string): value is Period =>
  PERIODS.some((p) => p.key === value);

/** What each frequency usually wants, so the form starts on the sensible one. */
export function defaultPeriod(frequency: Frequency): Period {
  return frequency === "daily" ? "yesterday" : frequency === "weekly" ? "last_7_days" : "last_month";
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
}

function firstOfMonth(date: string, monthsBack = 0): string {
  const [year, month] = date.split("-").map(Number) as [number, number];
  const index = year * 12 + (month - 1) - monthsBack;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

export interface PeriodRange {
  /** Inclusive. Absent for `all`. */
  from?: string;
  /** EXCLUSIVE, the way every report range in this product is. */
  to?: string;
  /** "1 Sep 2026 to 30 Sep 2026", for the subject line. */
  label: string;
}

const DAY = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const show = (date: string) => DAY.format(new Date(`${date}T12:00:00Z`));

/**
 * The dates a delivery made at `at` covers, in the company's calendar.
 *
 * `to` is exclusive, because that is what a report definition's `to` means, and
 * the label says the last day that is IN the range rather than the first one
 * that is not, because that is what a person reading a subject line means.
 */
export function periodFor(period: Period, at: Date, timeZone: string): PeriodRange {
  const today = dateIn(at, timeZone);
  const span = (from: string, to: string): PeriodRange => ({
    from, to,
    label: from === shiftDays(to, -1) ? show(from) : `${show(from)} to ${show(shiftDays(to, -1))}`,
  });

  switch (period) {
    case "yesterday": return span(shiftDays(today, -1), today);
    case "last_7_days": return span(shiftDays(today, -7), today);
    case "last_month": return span(firstOfMonth(today, 1), firstOfMonth(today));
    case "month_to_date": {
      const first = firstOfMonth(today);
      // On the first itself there is no "so far" yet, so it is the whole of last month.
      return first === today ? span(firstOfMonth(today, 1), first) : span(first, today);
    }
    case "all": return { label: "Everything to date" };
  }
}

/**
 * The calendar day a delivery belongs to, which is what makes it once.
 *
 * A cadence fires at most once a day, so one delivery per schedule per day in
 * the company's timezone is the same thing as one per occurrence, and it stays
 * true when somebody moves the time from seven to eight after the seven
 * o'clock one already went: the eight o'clock one is the same day and is not
 * sent again.
 */
export function deliveryDay(at: Date, timeZone: string): string {
  return dateIn(at, timeZone);
}

/**
 * The month a statement run is FOR, and the dates it covers.
 *
 * Statements go out at the start of a month about the month before, which is
 * what every customer who gets one from a supplier is used to. `to` is
 * INCLUSIVE here, unlike a report's, because that is what the statement reader
 * takes: it is the last day printed on the document.
 */
export function statementMonth(at: Date, timeZone: string): { key: string; from: string; to: string } {
  const today = dateIn(at, timeZone);
  const from = firstOfMonth(today, 1);
  return { key: from.slice(0, 7), from, to: shiftDays(firstOfMonth(today), -1) };
}
