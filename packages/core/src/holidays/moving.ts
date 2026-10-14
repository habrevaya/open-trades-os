import { addDays } from "../time/index.js";

/**
 * HOLIDAYS THAT MOVE
 *
 * Two kinds of moving, both worked out here for any year so nobody enters
 * Thanksgiving again each November:
 *
 *   A DAY OF THE WEEK IN A MONTH. "The fourth Thursday of November", "the
 *   last Monday of May", "the first Monday of September". The week is the
 *   first to fourth such weekday of the month, or the last one, which is the
 *   fourth or the fifth depending on the year.
 *
 *   A FIXED DATE KEPT ON ANOTHER DAY. "Christmas, the Monday after when it
 *   falls on a Sunday", or the common rule that moves a Saturday holiday to
 *   the Friday before and a Sunday one to the Monday after. The day kept is
 *   the holiday; the date itself is then an ordinary day, which is what a
 *   company that closes on the Monday means.
 *
 * Dates are plain `YYYY-MM-DD` in the company's calendar, and the weekday of
 * one is read at noon UTC, so no zone can move it.
 */

export type WeekOfMonth = 1 | 2 | 3 | 4 | "last";

/** A day of the week in a month: month 1 to 12, weekday 0 for Sunday to 6 for Saturday. */
export interface WeekdayRule {
  month: number;
  weekday: number;
  week: WeekOfMonth;
}

/**
 * Where a repeating holiday is kept when it lands on a weekend: on the day
 * itself, on the Monday after when it is a Sunday, or on the nearest weekday
 * (the Friday before a Saturday, the Monday after a Sunday).
 */
export type Observed = "as_is" | "sunday_to_monday" | "weekend_to_weekday";

export const OBSERVED: readonly Observed[] = ["as_is", "sunday_to_monday", "weekend_to_weekday"];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKS: Record<string, string> = { 1: "First", 2: "Second", 3: "Third", 4: "Fourth", last: "Last" };

const pad = (n: number) => String(n).padStart(2, "0");

/** 0 for Sunday, read at noon UTC so it is the calendar's weekday wherever this runs. */
export const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Why a rule cannot be kept, in words, or null when it can. */
export function checkRule(rule: WeekdayRule): string | null {
  if (!Number.isInteger(rule.month) || rule.month < 1 || rule.month > 12) return "Choose the month it falls in.";
  if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) return "Choose the day of the week it falls on.";
  if (!([1, 2, 3, 4, "last"] as unknown[]).includes(rule.week)) return "Choose which one in the month: the first to the fourth, or the last.";
  return null;
}

/** The date a rule gives in a year: "the fourth Thursday of November 2026" is 2026-11-26. */
export function weekdayOfMonth(year: number, rule: WeekdayRule): string {
  const first = `${year}-${pad(rule.month)}-01`;
  const offset = (rule.weekday - weekdayOf(first) + 7) % 7;
  const firstMatch = addDays(first, offset);
  if (rule.week !== "last") return addDays(firstMatch, (rule.week - 1) * 7);
  /** The last: step forward by weeks while the date stays in the month. */
  let date = firstMatch;
  while (addDays(date, 7).slice(5, 7) === pad(rule.month)) date = addDays(date, 7);
  return date;
}

/** The day a holiday on `date` is kept, under the company's rule for weekends. */
export function observedDate(date: string, observed: Observed): string {
  const day = weekdayOf(date);
  if (observed === "sunday_to_monday") return day === 0 ? addDays(date, 1) : date;
  if (observed === "weekend_to_weekday") return day === 0 ? addDays(date, 1) : day === 6 ? addDays(date, -1) : date;
  return date;
}

/** "Fourth Thursday of November". */
export function describeRule(rule: WeekdayRule): string {
  return `${WEEKS[String(rule.week)]} ${WEEKDAYS[rule.weekday]} of ${MONTHS[rule.month - 1]}`;
}

/** The weekend rule in words, after a date or a rule; empty for one kept on its own day. */
export function describeObserved(observed: Observed): string {
  if (observed === "sunday_to_monday") return ", or the Monday after when it falls on a Sunday";
  if (observed === "weekend_to_weekday") return ", or the Friday before when it falls on a Saturday and the Monday after when it falls on a Sunday";
  return "";
}
