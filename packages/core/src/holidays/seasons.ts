import type { WeekHours } from "./index.js";
import { checkRule, describeRule, weekdayOfMonth, type WeekdayRule } from "./moving.js";

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
 * A YEARLY SEASON ON A DAY OF THE WEEK. Either end of a yearly season can be
 * a day of the week in a month instead of a date, as a moving holiday is:
 * from the last Monday of May to the first Monday of September, worked out
 * for each year (`startsRule`, `endsRule`). The two ends must fall in the
 * same order every year, and the season must be shorter than a year in every
 * year, or it is refused in words.
 *
 * A SEASON THAT CHANGES ONLY SOME DAYS. A season can say hours for some
 * weekdays and leave the rest to the week beneath it (`days`, the weekdays
 * it changes): Saturday mornings in summer, every other day as usual. On a
 * date a weekday takes the hours of the first season in force that changes
 * that weekday, and the normal week where none does. A season with every day
 * (`days` absent) replaces the whole week, as it always has.
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
  /** A yearly season that starts on a day of the week in a month; `startsOn` is then not read. */
  startsRule?: WeekdayRule | null | undefined;
  /** A yearly season that ends on a day of the week in a month; `endsOn` is then not read. */
  endsRule?: WeekdayRule | null | undefined;
}

/** A season with the week it keeps, as a reader that asks about a date needs it. */
export interface SeasonWeek extends SeasonSpan {
  name: string;
  /** By weekday, 0 for Sunday; null on a day the season keeps closed. */
  week: WeekHours | null;
  /** The weekdays it changes, 0 for Sunday; absent or null for all seven. */
  days?: readonly number[] | null | undefined;
}

const monthDay = (date: string) => date.slice(5);
const pad4 = (year: number) => String(year).padStart(4, "0");

/** Where a yearly season starts and ends in one year, from its rules or its month and day. */
function yearSpan(season: SeasonSpan, year: number): { from: string; until: string } {
  return {
    from: season.startsRule ? weekdayOfMonth(year, season.startsRule) : `${pad4(year)}-${monthDay(season.startsOn)}`,
    until: season.endsRule ? weekdayOfMonth(year, season.endsRule) : `${pad4(year)}-${monthDay(season.endsOn)}`,
  };
}

const ruled = (season: SeasonSpan) => Boolean(season.startsRule || season.endsRule);

/** Whether the season is in force on a date. */
export function seasonCovers(season: SeasonSpan, date: string): boolean {
  if (!season.repeatsYearly) return season.startsOn <= date && date <= season.endsOn;
  if (ruled(season)) {
    /** Worked out for the date's year; one that runs across the new year starts after it ends in the same year. */
    const { from, until } = yearSpan(season, Number(date.slice(0, 4)));
    return from <= until ? from <= date && date <= until : date >= from || date <= until;
  }
  const from = monthDay(season.startsOn);
  const until = monthDay(season.endsOn);
  const day = monthDay(date);
  return from <= until ? from <= day && day <= until : day >= from || day <= until;
}

/** The first season in the list in force on a date, or null when the normal week applies. */
export function seasonOn<S extends SeasonSpan>(seasons: readonly S[] | null | undefined, date: string): S | null {
  return seasons?.find((s) => seasonCovers(s, date)) ?? null;
}

/** Whether a season says hours for a weekday: every day, or one it lists. */
export const seasonChanges = (season: Pick<SeasonWeek, "days">, weekday: number): boolean =>
  season.days === null || season.days === undefined || season.days.includes(weekday);

/**
 * For each weekday, the season in force on a date that says its hours, or
 * null where the normal week does. The first season in the list that covers
 * the date and changes that weekday wins.
 */
export function seasonsByWeekday<S extends SeasonWeek>(seasons: readonly S[] | null | undefined, date: string): (S | null)[] {
  const covering = seasons?.filter((s) => seasonCovers(s, date)) ?? [];
  return Array.from({ length: 7 }, (_, dow) => covering.find((s) => seasonChanges(s, dow)) ?? null);
}

/**
 * The week in force on a date: the season's where one covers it, the normal
 * week otherwise. A season that changes only some weekdays gives those, and
 * the rest come from the next season that changes them or the normal week;
 * `season` is the one that says the date's own weekday, or null when the
 * normal week does. Holidays are not read here; `hoursOnDate`, `bookedAt` and
 * `workingHoursOn` put them over this.
 */
export function weekInForce<S extends SeasonWeek>(
  date: string, week: WeekHours | null, seasons: readonly S[] | null | undefined,
): { week: WeekHours | null; season: S | null } {
  const first = seasonOn(seasons, date);
  if (!first) return { week, season: null };
  /** A season with every day replaces the whole week, as it always has. */
  if (first.days === null || first.days === undefined) return { week: first.week, season: first };
  const byDay = seasonsByWeekday(seasons, date);
  const season = byDay[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? null;
  /** With no normal week declared, the days no season changes are not known: only a season's own days are read. */
  if (week === null && season === null) return { week: null, season: null };
  return {
    week: byDay.map((s, dow) => (s ? s.week?.[dow] ?? null : week?.[dow] ?? null)),
    season,
  };
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

/** Every arrangement of weekdays a year can have comes round within twenty eight years. */
const CYCLE_YEARS = Array.from({ length: 28 }, (_, i) => 2000 + i);

/** A yearly season with a day of the week at either end: the rules, and the same order and less than a year every year. */
function checkRuled(season: SeasonSpan): SeasonCheck {
  if (!season.repeatsYearly) {
    return { ok: false, message: "A season on a day of the week in a month comes back every year. Tick Every year." };
  }
  for (const rule of [season.startsRule, season.endsRule]) {
    const wrong = rule ? checkRule(rule) : null;
    if (wrong) return { ok: false, message: wrong };
  }
  for (const end of [season.startsRule ? null : season.startsOn, season.endsRule ? null : season.endsOn]) {
    if (end === null) continue;
    if (!real(end)) return { ok: false, message: "Give the first and last day as dates." };
    if (monthDay(end) === "02-29") {
      return { ok: false, message: "A season that comes back every year cannot start or end on February 29. Use the 28th or March 1." };
    }
  }
  const spans = CYCLE_YEARS.map((year) => yearSpan(season, year));
  const wraps = spans.map((s) => s.from > s.until);
  if (spans.some((s) => s.from === s.until)) {
    return { ok: false, message: "In some years the season would start and end on the same day. Choose ends further apart." };
  }
  if (wraps.some((w) => w !== wraps[0])) {
    return { ok: false, message: "In some years the season would end before it starts. Choose ends that fall in the same order every year." };
  }
  return { ok: true };
}

/** Whether a season's dates make sense, in words when they do not. */
export function checkSeason(season: SeasonSpan & { name: string }): SeasonCheck {
  if (season.name.trim() === "") return { ok: false, message: "Give the season a name, like Summer hours." };
  if (ruled(season)) return checkRuled(season);
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

const MONTH_LENGTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const md = (month: number, day: number) => `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
/**
 * The earliest month day a rule can fall on: the first Monday is the 1st at
 * the earliest, and the last one six days before the month ends (the 22nd in
 * a February of 28 days).
 */
const earliest = (rule: WeekdayRule) =>
  md(rule.month, rule.week === "last" ? (rule.month === 2 ? 22 : MONTH_LENGTH[rule.month - 1]! - 6) : (rule.week - 1) * 7 + 1);
/** The latest month day a rule can fall on: the first Monday is the 7th at the latest, the last the month's end. */
const latest = (rule: WeekdayRule) => md(rule.month, rule.week === "last" ? MONTH_LENGTH[rule.month - 1]! : rule.week * 7);

/**
 * The month days a season covers, split at the new year when it runs across
 * it. A day of the week in a month is read at its widest, the earliest it can
 * start and the latest it can end, so two seasons that could share a day in
 * any year are said to overlap.
 */
function monthDaysOf(season: SeasonSpan): MonthDays[] {
  if (season.repeatsYearly && ruled(season)) {
    const from = season.startsRule ? earliest(season.startsRule) : monthDay(season.startsOn);
    const until = season.endsRule ? latest(season.endsRule) : monthDay(season.endsOn);
    const wraps = yearSpan(season, 2001).from > yearSpan(season, 2001).until;
    if (!wraps && from <= until) return [[from, until]];
    /** Read at its widest, a season might reach round to meet itself: then it covers every month day. */
    if (!wraps) return WHOLE_YEAR;
    return from <= until ? WHOLE_YEAR : [[from, "12-31"], ["01-01", until]];
  }
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

/**
 * "June 1 to August 31, every year", "June 1, 2027 to August 31, 2027", or
 * "Last Monday of May to the first Monday of September, every year".
 */
export function describeSeason(season: SeasonSpan): string {
  const day = (date: string, year: boolean) =>
    `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}${year ? `, ${date.slice(0, 4)}` : ""}`;
  if (season.repeatsYearly && ruled(season)) {
    const from = season.startsRule ? describeRule(season.startsRule) : day(season.startsOn, false);
    const until = season.endsRule
      ? `the ${describeRule(season.endsRule).replace(/^\w/, (c) => c.toLowerCase())}` : day(season.endsOn, false);
    return `${from} to ${until}, every year`;
  }
  return season.repeatsYearly
    ? `${day(season.startsOn, false)} to ${day(season.endsOn, false)}, every year`
    : `${day(season.startsOn, true)} to ${day(season.endsOn, true)}`;
}
