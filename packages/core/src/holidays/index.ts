import { addDays, dateIn, minutesInDay } from "../time/index.js";
import type { Holiday as PhoneHoliday } from "../telephony/index.js";

/**
 * THE COMPANY'S OWN DAYS OFF, AND ITS SHORT DAYS
 *
 * A list of dates on which the week's hours do not apply: closed all day, or
 * open with hours of their own (Christmas Eve until noon). A date can repeat
 * every year, which is what a fixed date holiday is, so the company does not
 * add Christmas again each December.
 *
 * NOT A CALENDAR OF PUBLIC HOLIDAYS. Which days a business closes is the
 * business's decision, and a shipped list of national holidays would close a
 * plumbing company on a day it takes its best emergency calls. The list
 * starts empty and holds only what the company put on it. Holidays that move
 * (the fourth Thursday of November) are added for the year they fall in.
 *
 * ON A DATE IN THE LIST, ITS HOURS REPLACE THE WEEK'S. One rule for every
 * reader, so online booking, the phones and the reviews clock never disagree
 * about whether Friday is open. A date entered for this year beats a yearly
 * one on the same day, because it is the more particular thing somebody said.
 *
 * Every date here is a plain `YYYY-MM-DD` in the COMPANY'S calendar. Minutes
 * are past local midnight, half open like every interval in this codebase.
 */

export interface CompanyHoliday {
  name: string;
  /** For a yearly one, any year's date: only the month and day are read. */
  date: string;
  repeatsYearly: boolean;
  /** Closed all day. False means open, with the hours below. */
  closed: boolean;
  openMinute: number | null;
  closeMinute: number | null;
}

/** One date the week's hours do not apply to, as a reader needs it. */
export interface HolidayDay {
  date: string;
  name: string;
  closed: boolean;
  /** The hours kept, when open. Null when closed. */
  hours: { openMinute: number; closeMinute: number } | null;
}

export type HolidayCheck = { ok: true } | { ok: false; field: "name" | "date" | "hours"; message: string };

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(date: string): boolean {
  if (!CALENDAR_DATE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Whether a holiday can be kept.
 *
 * A yearly one on the twenty ninth of February is refused rather than moved:
 * three years in four it has no date, and quietly closing on the twenty
 * eighth or the first of March instead is a decision the owner did not make.
 * Hours that close before they open are refused rather than read as running
 * past midnight, because a short day that wraps into the next one is not what
 * anybody means by "open until noon".
 */
export function checkHoliday(holiday: CompanyHoliday): HolidayCheck {
  if (holiday.name.trim() === "") return { ok: false, field: "name", message: "Give the day a name, like Christmas Day." };
  if (holiday.name.trim().length > 80) return { ok: false, field: "name", message: "Keep the name to eighty characters." };
  if (!realDate(holiday.date)) return { ok: false, field: "date", message: "That is not a date." };
  if (holiday.repeatsYearly && holiday.date.slice(5) === "02-29") {
    return {
      ok: false, field: "date",
      message: "The 29th of February is not there three years in four, so it cannot repeat every year. Add it for the year you mean.",
    };
  }
  if (holiday.closed) return { ok: true };
  const open = holiday.openMinute;
  const close = holiday.closeMinute;
  if (open === null || close === null) {
    return { ok: false, field: "hours", message: "Say when you open and close that day, or mark it closed." };
  }
  for (const value of [open, close]) {
    if (!Number.isInteger(value) || value < 0 || value > 24 * 60) {
      return { ok: false, field: "hours", message: "Those hours are not times of day." };
    }
  }
  if (close <= open) {
    return { ok: false, field: "hours", message: `That day closes at ${clock(close)}, before it opens at ${clock(open)}.` };
  }
  return { ok: true };
}

const asDay = (holiday: CompanyHoliday, date: string): HolidayDay => ({
  date,
  name: holiday.name,
  closed: holiday.closed,
  hours: holiday.closed || holiday.openMinute === null || holiday.closeMinute === null
    ? null
    : { openMinute: holiday.openMinute, closeMinute: holiday.closeMinute },
});

/**
 * What the list says about one date, or null when the week's hours apply.
 *
 * A date entered for one year wins over a yearly one on the same day: "this
 * year we open Christmas morning" is said on top of "we close every
 * Christmas", not instead of it.
 */
export function holidayOn(list: readonly CompanyHoliday[], date: string): HolidayDay | null {
  const once = list.find((h) => !h.repeatsYearly && h.date === date);
  if (once) return asDay(once, date);
  const yearly = list.find((h) => h.repeatsYearly && h.date.slice(5) === date.slice(5));
  return yearly ? asDay(yearly, date) : null;
}

/** Every date in `[from, to]` the list says something about, in order. */
export function holidaysBetween(list: readonly CompanyHoliday[], from: string, to: string): HolidayDay[] {
  if (list.length === 0 || to < from) return [];
  const out: HolidayDay[] = [];
  /** Bounded, so a mistaken range cannot walk for ever: a little over two years. */
  for (let date = from, steps = 0; date <= to && steps < 800; date = addDays(date, 1), steps += 1) {
    const day = holidayOn(list, date);
    if (day) out.push(day);
  }
  return out;
}

/** The next date a holiday falls on, on or after `today`. */
export function nextDate(holiday: Pick<CompanyHoliday, "date" | "repeatsYearly">, today: string): string | null {
  if (!holiday.repeatsYearly) return holiday.date >= today ? holiday.date : null;
  const thisYear = `${today.slice(0, 4)}${holiday.date.slice(4)}`;
  return thisYear >= today ? thisYear : `${String(Number(today.slice(0, 4)) + 1)}${holiday.date.slice(4)}`;
}

/** Whether a date is a day the company is shut. A short day is not. */
export function closedOn(list: readonly CompanyHoliday[], date: string): boolean {
  return holidayOn(list, date)?.closed === true;
}

/**
 * The list in the shape the phones' hours take, for the dates around now.
 *
 * Telephony's own `Holiday` already knew a closed day from a short one; it was
 * simply never given any.
 */
export function forPhones(list: readonly CompanyHoliday[], from: string, to: string): PhoneHoliday[] {
  return holidaysBetween(list, from, to).map((day) => ({
    date: day.date,
    label: day.name,
    windows: day.hours ? [{ openMinute: day.hours.openMinute, closeMinute: day.hours.closeMinute }] : [],
  }));
}

/** The day in words, for a list or for the phone assistant: "Closed" or "Open 08:00 to 12:00". */
export function describeDay(day: Pick<HolidayDay, "closed" | "hours">): string {
  return day.closed || !day.hours
    ? "Closed"
    : `Open ${clock(day.hours.openMinute)} to ${clock(day.hours.closeMinute)}`;
}

/** "HH:MM" or "HH:MM:SS" as minutes past midnight, or null. */
export function minutesOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 24 * 60 ? minutes : null;
}

/* ---------------------------------------------- after hours and holidays */

/** The week's hours by weekday, 0 for Sunday. Null on a day the week keeps closed. */
export type WeekHours = readonly ({ openMinute: number; closeMinute: number } | null)[];

/** What a booked time was, for the rates: on a holiday, outside the hours kept that day, both or neither. */
export interface BookedTime {
  holiday: HolidayDay | null;
  outsideHours: boolean;
  /** The sentence the invoice screen shows: "2026-10-06 at 19:00, after the 17:00 close". */
  why: string;
}

/**
 * Whether a visit booked for a date and time was outside the company's hours
 * or on a holiday.
 *
 * The hours are the day's own: a date in the holiday list keeps its hours (a
 * closed one keeps none), and any other date keeps its weekday's. A company
 * that has declared no weekly hours at all is never outside them, because
 * nothing says when it closes; a holiday is still a holiday.
 */
export function bookedAt(input: {
  week: WeekHours | null;
  holidays: readonly CompanyHoliday[];
  date: string;
  minute: number;
}): BookedTime {
  const holiday = holidayOn(input.holidays, input.date);
  const at = `${input.date} at ${clock(input.minute)}`;
  const hours = holiday
    ? holiday.hours
    : input.week === null ? undefined : input.week[new Date(`${input.date}T00:00:00Z`).getUTCDay()] ?? null;
  if (hours === undefined) {
    return { holiday, outsideHours: false, why: holiday ? `${at}, on ${holiday.name}` : at };
  }
  const outsideHours = hours === null || input.minute < hours.openMinute || input.minute >= hours.closeMinute;
  const where = hours === null
    ? (holiday ? `on ${holiday.name}, when you are closed` : "on a day you are closed")
    : input.minute < hours.openMinute
      ? `before the ${clock(hours.openMinute)} opening${holiday ? ` on ${holiday.name}` : ""}`
      : input.minute >= hours.closeMinute
        ? `after the ${clock(hours.closeMinute)} close${holiday ? ` on ${holiday.name}` : ""}`
        : holiday ? `on ${holiday.name}` : "inside your hours";
  return { holiday, outsideHours, why: `${at}, ${where}` };
}

/* ------------------------------------------------------ working time */

/** Everything the working time maths needs to know about the company's week. */
export interface WorkingCalendar {
  /** The week's hours, or null when the company has declared none. */
  week: WeekHours | null;
  holidays: readonly CompanyHoliday[];
  timeZone: string;
}

/**
 * The hours the company works on one date, in minutes past midnight, or null
 * when it is shut.
 *
 * The same answer `bookedAt` gives, so "outside your hours" and "not a
 * working hour" never disagree: a date in the holiday list keeps its own
 * hours (a closed one keeps none), and any other date keeps its weekday's.
 * A company with no weekly hours declared has nothing to say about its week,
 * so every day that is not a closed holiday counts all day. That is the
 * conservative reading for a clock that tells somebody something is late: it
 * errs towards telling them.
 */
export function workingHoursOn(
  date: string, calendar: Pick<WorkingCalendar, "week" | "holidays">,
): { openMinute: number; closeMinute: number } | null {
  const holiday = holidayOn(calendar.holidays, date);
  if (holiday) return holiday.hours;
  if (calendar.week === null) return { openMinute: 0, closeMinute: 24 * 60 };
  return calendar.week[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? null;
}

/** The most days the working time walk will cross before it gives up: a little over eleven years. */
const WORKING_WALK_DAYS = 4000;

/**
 * How many working minutes lie between two instants.
 *
 * Only the minutes inside the company's hours on a day the company works, in
 * its own zone, count: the evening, the weekend, a closed day and a holiday
 * add nothing. Counted on the wall clock of each date rather than by adding
 * milliseconds, so the day the clocks change is neither an hour short nor an
 * hour long. Zero when `to` is not after `from`.
 *
 * `stopAt` lets a caller that only asks "has it reached N minutes" stop as
 * soon as it has, so a task a year late costs a few days of walking rather
 * than three hundred and sixty five. The walk is bounded either way, so a
 * calendar that is never open (every weekday closed) returns zero rather than
 * spinning.
 */
export function workingMinutesBetween(
  from: Date, to: Date, calendar: WorkingCalendar, stopAt: number = Number.POSITIVE_INFINITY,
): number {
  if (!(to.getTime() > from.getTime())) return 0;
  const first = dateIn(from, calendar.timeZone);
  const last = dateIn(to, calendar.timeZone);
  let total = 0;
  let date = first;
  for (let step = 0; date <= last && step < WORKING_WALK_DAYS; step += 1, date = addDays(date, 1)) {
    const hours = workingHoursOn(date, calendar);
    if (!hours) continue;
    const start = date === first ? Math.max(hours.openMinute, minutesInDay(from, calendar.timeZone)) : hours.openMinute;
    const end = date === last ? Math.min(hours.closeMinute, minutesInDay(to, calendar.timeZone)) : hours.closeMinute;
    if (end > start) total += end - start;
    if (total >= stopAt) return total;
  }
  return total;
}
