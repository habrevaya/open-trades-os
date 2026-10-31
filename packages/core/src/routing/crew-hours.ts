/**
 * A CREW'S HOURS ON A DATE
 *
 * A crew can keep hours of its own for each day of the week (six to two on
 * weekdays to beat the heat, seven to noon on Saturdays), one set of hours
 * for every day, or none. On a date the crew works its hours for that
 * weekday where it keeps some, its one set of hours otherwise, and the
 * company's day where it keeps neither. The rule is here, once, so the
 * rebalance, a route's fit and the board read it the same way.
 *
 * Times are "HH:MM" on the wall clock in the company's zone; a date is a
 * plain `YYYY-MM-DD` in the company's calendar.
 */

export interface CrewWorkday { startsAt: string; endsAt: string }

/** One weekday's own hours. 0 is Sunday, matching JS getUTCDay(). */
export interface CrewWeekdayHours extends CrewWorkday { dayOfWeek: number }

export interface CrewHoursSource {
  workday: CrewWorkday | null;
  weekdayHours?: readonly CrewWeekdayHours[] | null | undefined;
}

/** Where a crew's hours on a date came from. */
export type CrewHoursFrom = "weekday" | "own" | "company";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minuteOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const usable = (hours: CrewWorkday | null | undefined): hours is CrewWorkday =>
  Boolean(hours && HHMM.test(hours.startsAt) && HHMM.test(hours.endsAt) && minuteOf(hours.endsAt) > minuteOf(hours.startsAt));

const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/**
 * The crew's hours on a date: its own for that weekday, its one set of
 * hours, or null for the company's day, with where they came from.
 */
export function crewHoursOn(crew: CrewHoursSource, date: string): { hours: CrewWorkday | null; from: CrewHoursFrom } {
  const day = crew.weekdayHours?.find((h) => h.dayOfWeek === weekdayOf(date));
  if (usable(day)) return { hours: { startsAt: day.startsAt, endsAt: day.endsAt }, from: "weekday" };
  if (usable(crew.workday)) return { hours: { startsAt: crew.workday.startsAt, endsAt: crew.workday.endsAt }, from: "own" };
  return { hours: null, from: "company" };
}

export type CrewHoursCheck = { ok: true; hours: CrewWeekdayHours[] } | { ok: false; message: string };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
