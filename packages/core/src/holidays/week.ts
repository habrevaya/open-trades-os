import type { HolidayDay, WeekHours, CompanyHoliday } from "./index.js";
import { holidayOn, minutesOf } from "./index.js";

/**
 * WHOSE WEEK: THE COMPANY'S, A BRANCH'S, OR A PHONE NUMBER'S
 *
 * `business_hours` keeps a week of seven rows for each owner: the company's
 * (no branch and no number), a branch's own, and a phone number's own. A
 * branch with no week of its own keeps the company's, which is what nearly
 * every branch does: the second shop that opens on Saturdays is the one that
 * says so. The rule is here, once, so booking, the rates, the crew check,
 * escalation, the rebalance and the phones all fall back the same way.
 *
 * THE WHOLE WEEK, NEVER DAY BY DAY. A branch's week is all seven days, as the
 * writer insists, so a branch that is closed on Saturday is closed on
 * Saturday even though the company opens; mixing its Monday with the
 * company's Saturday would be a week nobody chose.
 */

/** One row of a week, as `business_hours` keeps it. */
export interface WeekRow {
  businessUnitId: string | null;
  /** The phone number whose own week it is. Absent or null for the company's or a branch's. */
  phoneNumberId?: string | null | undefined;
  /** 0 is Sunday, matching JS getUTCDay(). */
  dayOfWeek: number;
  opensAt: string | null;
  closesAt: string | null;
  closed: boolean;
}

/** Whose week a reader was given: the one it asked for, or the company's in its place. */
export type WeekSource = "number" | "branch" | "company" | "none";

export interface ChosenWeek<R extends WeekRow = WeekRow> {
  /** The rows of the week chosen, so a reader that wants the raw rows (the phones) reads the same ones. */
  rows: R[];
  /** By weekday, 0 for Sunday; null on a day it keeps closed. Null altogether when nobody has declared a week. */
  week: WeekHours | null;
  source: WeekSource;
}

const companyRow = (row: WeekRow) => row.businessUnitId === null && (row.phoneNumberId ?? null) === null;

/**
 * The week a set of rows declares, or null when there are none. A weekday
 * with no row, a closed row, or one with no usable hours is closed that day:
 * a partial week is read as a week with gaps, as it always has been.
 */
export function weekOfRows(rows: readonly WeekRow[]): WeekHours | null {
  if (rows.length === 0) return null;
  return Array.from({ length: 7 }, (_, dow) => {
    const row = rows.find((r) => r.dayOfWeek === dow);
    const open = minutesOf(row?.opensAt);
    const close = minutesOf(row?.closesAt);
    return !row || row.closed || open === null || close === null || close <= open
      ? null : { openMinute: open, closeMinute: close };
  });
}

/**
 * The week a reader that knows a branch should read: the branch's own when it
 * keeps one, otherwise the company's. With no branch, the company's alone,
 * never another branch's.
 */
export function weekFor<R extends WeekRow>(rows: readonly R[], branchId: string | null | undefined): ChosenWeek<R> {
  if (branchId) {
    const own = rows.filter((r) => r.businessUnitId === branchId && (r.phoneNumberId ?? null) === null);
    if (own.length > 0) return { rows: own, week: weekOfRows(own), source: "branch" };
  }
  const company = rows.filter(companyRow);
  return company.length > 0
    ? { rows: company, week: weekOfRows(company), source: "company" }
    : { rows: [], week: null, source: "none" };
}

/** Where a phone number reads its hours from. */
export type NumberHoursFrom = "own" | "branch" | "company";

/**
 * The week a phone number is routed by. Its own when it is set to keep its
 * own; its branch's (or the company's, for a branch with none, or a number
 * in no branch) when it follows its branch; the company's when it follows
 * the company. A number set to keep its own with no week written yet is
 * read as having none, so it is not routed by hours at all, rather than
 * quietly borrowing the company's: whoever chose "its own" has not said
 * what its own is.
 */
export function weekForNumber<R extends WeekRow>(
  rows: readonly R[],
  number: { id: string; businessUnitId: string | null; hoursFrom: NumberHoursFrom },
): ChosenWeek<R> {
  if (number.hoursFrom === "own") {
    const own = rows.filter((r) => r.phoneNumberId === number.id);
    return { rows: own, week: weekOfRows(own), source: own.length > 0 ? "number" : "none" };
  }
  return weekFor(rows, number.hoursFrom === "branch" ? number.businessUnitId : null);
}

/** The weekdays a week opens on, or null when nobody has declared a week. */
export function openWeekdays(week: WeekHours | null): Set<number> | null {
  if (week === null) return null;
  return new Set(week.flatMap((hours, dow) => (hours ? [dow] : [])));
}

/** What one date is, for a reader that asks about a date rather than a weekday. */
export interface DateHours {
  /** The holiday on it, when the list says something about it. */
  holiday: HolidayDay | null;
  /** The hours kept that date, or null when closed. */
  hours: { openMinute: number; closeMinute: number } | null;
  /**
   * False when nothing says: no holiday on it and no week declared. Then
   * `hours` is null and means "not known", never "closed".
   */
  known: boolean;
}

/**
 * The hours kept on one date: a holiday's own (none on a closed one), and
 * otherwise the weekday's. The same answer `bookedAt` and `workingHoursOn`
 * give, except that a company with no week says it does not know rather than
 * counting the whole day: a figure built on it (a route's working day) must
 * not invent one.
 */
export function hoursOnDate(date: string, week: WeekHours | null, holidays: readonly CompanyHoliday[]): DateHours {
  const holiday = holidayOn(holidays, date);
  if (holiday) return { holiday, hours: holiday.hours, known: true };
  if (week === null) return { holiday: null, hours: null, known: false };
  return { holiday: null, hours: week[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? null, known: true };
}
