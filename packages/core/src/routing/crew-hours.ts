/**
 * A CREW'S HOURS ON A DATE
 *
 * A crew can keep hours of its own for each day of the week (six to two on
 * weekdays to beat the heat, seven to noon on Saturdays), one set of hours
 * for every day, or none. It can also keep hours for one date only (a long
 * day to finish a job, a short one before a holiday), be off on one date,
 * and have weekdays it does not work at all (no Sundays).
 *
 * On a date, the first of these that says something wins:
 *   1. the date's own entry: its hours, or off that day;
 *   2. a weekday the crew does not work: off;
 *   3. its hours for that weekday;
 *   4. its one set of hours;
 *   5. the company's day.
 * So hours on one date put a crew to work on a weekday it usually has off.
 * The rule is here, once, so the crew check, the rebalance, a route's fit,
 * booking and the board read it the same way.
 *
 * Times are "HH:MM" on the wall clock in the company's zone; a date is a
 * plain `YYYY-MM-DD` in the company's calendar.
 */

export interface CrewWorkday { startsAt: string; endsAt: string }

/** One weekday's own hours. 0 is Sunday, matching JS getUTCDay(). */
export interface CrewWeekdayHours extends CrewWorkday { dayOfWeek: number }

/**
 * One date's own entry: hours for that date only, or the crew off that day.
 * Off has no times; hours have both.
 */
export interface CrewDateHours {
  date: string;
  off: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export interface CrewHoursSource {
  workday: CrewWorkday | null;
  weekdayHours?: readonly CrewWeekdayHours[] | null | undefined;
  /** Hours or a day off on particular dates, read before anything else. */
  dateHours?: readonly CrewDateHours[] | null | undefined;
  /** Weekdays the crew does not work, 0 for Sunday. */
  daysOff?: readonly number[] | null | undefined;
}

/** Where a crew's hours on a date came from. */
export type CrewHoursFrom = "date" | "weekday" | "own" | "company";

/** A crew's day on a date: its hours (null for the company's day, or when it is off), where they came from, and `off` when it does not work that day. */
export interface CrewDay { hours: CrewWorkday | null; from: CrewHoursFrom; off?: true }

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minuteOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const usable = (hours: CrewWorkday | null | undefined): hours is CrewWorkday =>
  Boolean(hours && HHMM.test(hours.startsAt) && HHMM.test(hours.endsAt) && minuteOf(hours.endsAt) > minuteOf(hours.startsAt));

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/**
 * The crew's day on a date: the date's own entry, off on a weekday it does
 * not work, its own hours for that weekday, its one set of hours, or null for
 * the company's day, with where they came from and whether it is off.
 */
export function crewHoursOn(crew: CrewHoursSource, date: string): CrewDay {
  const onDate = crew.dateHours?.find((h) => h.date === date);
  if (onDate?.off) return { hours: null, from: "date", off: true };
  if (onDate && usable({ startsAt: onDate.startsAt ?? "", endsAt: onDate.endsAt ?? "" })) {
    return { hours: { startsAt: onDate.startsAt!, endsAt: onDate.endsAt! }, from: "date" };
  }
  const weekday = weekdayOf(date);
  if (crew.daysOff?.includes(weekday)) return { hours: null, from: "weekday", off: true };
  const day = crew.weekdayHours?.find((h) => h.dayOfWeek === weekday);
  if (usable(day)) return { hours: { startsAt: day.startsAt, endsAt: day.endsAt }, from: "weekday" };
  if (usable(crew.workday)) return { hours: { startsAt: crew.workday.startsAt, endsAt: crew.workday.endsAt }, from: "own" };
  return { hours: null, from: "company" };
}

/**
 * Why a crew is off on a date, in a sentence: "Post crew does not work on
 * Sundays." or "Post crew is off on 2026-11-10.". Null when it is working.
 */
export function crewDayOffWords(name: string, date: string, day: CrewDay): string | null {
  if (day.off !== true) return null;
  return day.from === "weekday"
    ? `${name} does not work on ${DAYS[weekdayOf(date)]}s.`
    : `${name} is off on ${date}.`;
}

export type CrewHoursCheck = { ok: true; hours: CrewWeekdayHours[] } | { ok: false; message: string };


/**
 * A crew's hours by weekday, checked: one entry a weekday at most, two times
 * of day each, the end after the start. A weekday left out keeps the crew's
 * one set of hours. Sorted Sunday first.
 */
export function checkCrewWeekdayHours(hours: readonly CrewWeekdayHours[]): CrewHoursCheck {
  const seen = new Set<number>();
  for (const h of hours) {
    if (!Number.isInteger(h.dayOfWeek) || h.dayOfWeek < 0 || h.dayOfWeek > 6) {
      return { ok: false, message: "A day of the week is 0 for Sunday to 6 for Saturday." };
    }
    const day = DAYS[h.dayOfWeek]!;
    if (seen.has(h.dayOfWeek)) return { ok: false, message: `${day} is given twice. Give each day its hours once.` };
    seen.add(h.dayOfWeek);
    if (!HHMM.test(h.startsAt) || !HHMM.test(h.endsAt)) {
      return { ok: false, message: `${day}'s hours are two times of day, HH:MM.` };
    }
    if (minuteOf(h.endsAt) <= minuteOf(h.startsAt)) {
      return { ok: false, message: `${day}'s working day has to end after it starts.` };
    }
  }
  return {
    ok: true,
    hours: [...hours].sort((a, b) => a.dayOfWeek - b.dayOfWeek)
      .map((h) => ({ dayOfWeek: h.dayOfWeek, startsAt: h.startsAt, endsAt: h.endsAt })),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (date: string) => {
  const at = Date.parse(`${date}T12:00:00Z`);
  return DATE.test(date) && !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === date;
};

/** The most dates a crew keeps entries for. Old ones can be cleared. */
export const MAX_CREW_DATES = 400;

export type CrewDatesCheck = { ok: true; dates: CrewDateHours[] } | { ok: false; message: string };

/**
 * A crew's entries for particular dates, checked: a real date, given once,
 * and either off that day with no times or two times of day with the end
 * after the start. Sorted by date.
 */
export function checkCrewDateHours(
  entries: readonly { date: string; off?: boolean | null | undefined; startsAt?: string | null | undefined; endsAt?: string | null | undefined }[],
): CrewDatesCheck {
  if (entries.length > MAX_CREW_DATES) {
    return { ok: false, message: `A crew keeps at most ${MAX_CREW_DATES} dates. Clear some that have passed.` };
  }
  const seen = new Set<string>();
  const out: CrewDateHours[] = [];
  for (const e of entries) {
    if (!realDate(e.date)) return { ok: false, message: `${e.date} is not a date. Use YYYY-MM-DD.` };
    if (seen.has(e.date)) return { ok: false, message: `${e.date} is given twice. Give each date once.` };
    seen.add(e.date);
    const startsAt = e.startsAt ?? null;
    const endsAt = e.endsAt ?? null;
    if (e.off === true) {
      if (startsAt !== null || endsAt !== null) {
        return { ok: false, message: `${e.date} is marked off and has hours. Choose one.` };
      }
      out.push({ date: e.date, off: true, startsAt: null, endsAt: null });
      continue;
    }
    if (startsAt === null || endsAt === null) {
      return { ok: false, message: `Give ${e.date} a start and a finish, or mark the crew off that day.` };
    }
    if (!HHMM.test(startsAt) || !HHMM.test(endsAt)) {
      return { ok: false, message: `The hours on ${e.date} are two times of day, HH:MM.` };
    }
    if (minuteOf(endsAt) <= minuteOf(startsAt)) {
      return { ok: false, message: `The working day on ${e.date} has to end after it starts.` };
    }
    out.push({ date: e.date, off: false, startsAt, endsAt });
  }
  return { ok: true, dates: out.sort((a, b) => a.date.localeCompare(b.date)) };
}

export type CrewDaysOffCheck = { ok: true; daysOff: number[] } | { ok: false; message: string };

/**
 * The weekdays a crew does not work, checked: 0 for Sunday to 6, each once,
 * and not every day of the week (a crew that never works is retired, not
 * given seven days off). A day off cannot also have hours of its own, so
 * `weekdayHours` is checked against it. Sorted Sunday first.
 */
export function checkCrewDaysOff(days: readonly number[], weekdayHours: readonly CrewWeekdayHours[] = []): CrewDaysOffCheck {
  const seen = new Set<number>();
  for (const d of days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) return { ok: false, message: "A day of the week is 0 for Sunday to 6 for Saturday." };
    if (seen.has(d)) return { ok: false, message: `${DAYS[d]} is given twice.` };
    seen.add(d);
  }
  if (seen.size === 7) {
    return { ok: false, message: "A crew has to work at least one day of the week. Retire the crew instead." };
  }
  const clash = weekdayHours.find((h) => seen.has(h.dayOfWeek));
  if (clash) {
    return { ok: false, message: `${DAYS[clash.dayOfWeek]} is a day off and has hours of its own. Clear one of them.` };
  }
  return { ok: true, daysOff: [...seen].sort((a, b) => a - b) };
}
