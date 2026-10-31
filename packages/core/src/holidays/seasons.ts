import type { WeekHours } from "./index.js";

/**
 * SEASONS: A DATED WEEK OVER THE NORMAL ONE
 *
 * A branch (or the company) that keeps different hours part of the year:
 * summer hours from June 1 to August 31, opening at six to beat the heat and
 * shutting at two. A season is a full week of seven days that replaces the
 * owner's normal week on every date it covers; a holiday on one of those
 * dates still wins, because it is the more particular thing somebody said.
 *
 * A season either runs once between two dates, or comes back every year on
 * the same month and day, as a fixed date holiday does. A yearly one may run
 * across the new year (December 1 to February 28). A yearly season may not
 * start or end on February 29, which most years do not have.
 *
 * ONE SEASON A DAY. An owner's seasons may not overlap, so on any date there
 * is at most one of its own in force; overlapping ones are refused in words
 * when they are saved (`seasonClash`).
 *
 * WHOSE SEASON. A branch reads its own season first. Where it has none on a
 * date it reads its own normal week if it keeps one; only a branch that keeps
 * the company's week reads the company's season, because a branch with a week
 * of its own has said what its week is. Core's `weekFor` builds the list in
 * that order, so the first season that covers a date is the one in force.
 *
 * Every date is a plain `YYYY-MM-DD` in the company's calendar.
 */

/** When a season runs, as it is kept. */
export interface SeasonSpan {
  startsOn: string;
  endsOn: string;
  /** Every year on the same month and day; only the month and day of the dates above are read. */
  repeatsYearly: boolean;
}

/** A season with the week it keeps, as a reader that asks about a date needs it. */
export interface SeasonWeek extends SeasonSpan {
  name: string;
  /** By weekday, 0 for Sunday; null on a day the season keeps closed. */
  week: WeekHours | null;
}

const monthDay = (date: string) => date.slice(5);

/** Whether the season is in force on a date. */
export function seasonCovers(season: SeasonSpan, date: string): boolean {
  if (!season.repeatsYearly) return season.startsOn <= date && date <= season.endsOn;
  const from = monthDay(season.startsOn);
  const until = monthDay(season.endsOn);
  const day = monthDay(date);
  return from <= until ? from <= day && day <= until : day >= from || day <= until;
}

/** The first season in the list in force on a date, or null when the normal week applies. */
export function seasonOn<S extends SeasonSpan>(seasons: readonly S[] | null | undefined, date: string): S | null {
  return seasons?.find((s) => seasonCovers(s, date)) ?? null;
}

/**
 * The week in force on a date: the season's where one covers it, the normal
 * week otherwise. Holidays are not read here; `hoursOnDate`, `bookedAt` and
 * `workingHoursOn` put them over this.
 */
export function weekInForce<S extends SeasonWeek>(
  date: string, week: WeekHours | null, seasons: readonly S[] | null | undefined,
): { week: WeekHours | null; season: S | null } {
  const season = seasonOn(seasons, date);
  return season ? { week: season.week, season } : { week, season: null };
}

/** The hours of a date's weekday in the week in force, null on a closed day, undefined when no week is declared. */
export function weekdayHoursOn(
  date: string, week: WeekHours | null, seasons: readonly SeasonWeek[] | null | undefined,
): { openMinute: number; closeMinute: number } | null | undefined {
  const inForce = weekInForce(date, week, seasons);
  if (inForce.week === null) return undefined;
  return inForce.week[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? null;
}

/* ------------------------------------------------------------- checking */

export type SeasonCheck = { ok: true } | { ok: false; message: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const real = (date: string) => ISO.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const daysBetween = (from: string, until: string) =>
  Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);

/** Whether a season's dates make sense, in words when they do not. */
export function checkSeason(season: SeasonSpan & { name: string }): SeasonCheck {
  if (season.name.trim() === "") return { ok: false, message: "Give the season a name, like Summer hours." };
  if (!real(season.startsOn) || !real(season.endsOn)) return { ok: false, message: "Give the first and last day as dates." };
  if (!season.repeatsYearly) {
    if (season.endsOn < season.startsOn) {
      return { ok: false, message: `The season ends on ${season.endsOn}, before it starts on ${season.startsOn}.` };
    }
    return { ok: true };
  }
  if (monthDay(season.startsOn) === "02-29" || monthDay(season.endsOn) === "02-29") {
    return { ok: false, message: "A season that comes back every year cannot start or end on February 29. Use the 28th or March 1." };
  }
  if (season.endsOn <= season.startsOn) {
    return { ok: false, message: `The season ends on ${season.endsOn}, before it starts on ${season.startsOn}.` };
  }
  if (daysBetween(season.startsOn, season.endsOn) >= 365) {
    return { ok: false, message: "A season that comes back every year has to be shorter than a year. Change the normal week instead." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------- overlaps */

/** A stretch of month days inside one calendar year, both ends kept. */
type MonthDays = readonly [string, string];

const WHOLE_YEAR: MonthDays[] = [["01-01", "12-31"]];

/** The month days a season covers, split at the new year when it runs across it. */
function monthDaysOf(season: SeasonSpan): MonthDays[] {
  const from = monthDay(season.startsOn);
  const until = monthDay(season.endsOn);
  if (!season.repeatsYearly) {
    /** A dated season of a year or more covers every month day there is. */
    if (daysBetween(season.startsOn, season.endsOn) >= 365) return WHOLE_YEAR;
    if (season.startsOn.slice(0, 4) !== season.endsOn.slice(0, 4)) return [[from, "12-31"], ["01-01", until]];
    return [[from, until]];
  }
  return from <= until ? [[from, until]] : [[from, "12-31"], ["01-01", until]];
}

/**
 * Whether two seasons are ever in force on the same date. Two dated ones
 * meet when their dates do. A yearly one meets another season when their
 * months and days do, because it comes back every year: a dated season next
 * August overlaps summer hours kept every year.
 */
export function seasonsOverlap(a: SeasonSpan, b: SeasonSpan): boolean {
  if (!a.repeatsYearly && !b.repeatsYearly) return a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;
  return monthDaysOf(a).some(([af, au]) => monthDaysOf(b).some(([bf, bu]) => af <= bu && bf <= au));
}

/** The first of `others` that overlaps `season`, or null. */
export function seasonClash<S extends SeasonSpan>(season: SeasonSpan, others: readonly S[]): S | null {
  return others.find((other) => seasonsOverlap(season, other)) ?? null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "June 1 to August 31, every year" or "June 1, 2027 to August 31, 2027". */
export function describeSeason(season: SeasonSpan): string {
  const day = (date: string, year: boolean) =>
    `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}${year ? `, ${date.slice(0, 4)}` : ""}`;
  return season.repeatsYearly
    ? `${day(season.startsOn, false)} to ${day(season.endsOn, false)}, every year`
    : `${day(season.startsOn, true)} to ${day(season.endsOn, true)}`;
}
