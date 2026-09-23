/**
 * CALENDAR DAYS, IN THE COMPANY'S ZONE
 *
 * A dispatch board shows one date. Turning that date into the two instants
 * that bound it is the whole of this file, and it is a place this codebase
 * already got wrong once in the other direction:
 *
 *   new Date(`${date}T00:00:00Z`)
 *
 * reads as "midnight on that day" and means "midnight in London". For a shop
 * in Austin that window runs from seven the previous evening to seven that
 * evening, so an emergency booked for nine at night falls off today's board
 * and reappears on tomorrow's, and the evening before is on the board all day
 * pretending to be today. The same one-liner in the other direction,
 * `toISOString().slice(0, 10)`, is called out in the web app's date helpers
 * for exactly the same reason.
 *
 * Nothing here takes the SERVER's zone into account, deliberately. The server
 * is a container that runs in UTC in production and in whatever a contributor
 * has locally, and neither of those is the company.
 */

/**
 * How far ahead of UTC a zone is at a given instant, in milliseconds.
 *
 * Read back out of `Intl` rather than from a table, so it is correct across
 * daylight saving, across the zones that are not whole hours off (India is
 * five and a half, Nepal five and three quarters) and across the political
 * decisions that move a country's offset without warning.
 */
export function offsetAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // `hour12: false` renders midnight as 24 in some runtimes, which is the
  // same instant and a different day if left alone.
  const asIfUtc = Date.UTC(
    field("year"), field("month") - 1, field("day"),
    field("hour") % 24, field("minute"), field("second"),
  );
  // Seconds resolution is all `formatToParts` gives, so compare at that.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant a calendar day starts in a zone.
 *
 * Solved by iteration rather than algebra: guess that the offset is whatever
 * it is at UTC midnight, correct, and check again. The second pass is what
 * handles a day that begins inside a daylight saving transition, where the
 * offset before the guess and the offset after it are different.
 */
export function startOfDayIn(date: string, timeZone: string): Date {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(utcMidnight)) throw new Error(`Not a calendar date: ${date}`);

  let instant = new Date(utcMidnight);
  for (let pass = 0; pass < 2; pass += 1) {
    instant = new Date(utcMidnight - offsetAt(instant, timeZone));
  }
  return instant;
}

/** The day after a `YYYY-MM-DD`, as a `YYYY-MM-DD`. */
export function nextDay(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new Error(`Not a calendar date: ${date}`);
  return new Date(parsed + 864e5).toISOString().slice(0, 10);
}

/**
 * The half-open interval a calendar day occupies, `[start, end)`.
 *
 * The end is the NEXT day's start rather than the start plus 24 hours, so the
 * 23 and 25 hour days either side of a daylight saving change are the right
 * length. Half-open because the alternative is deciding what happens to a
 * visit at exactly midnight, and every answer to that is wrong somewhere.
 */
export function dayBoundsIn(date: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: startOfDayIn(date, timeZone),
    end: startOfDayIn(nextDay(date), timeZone),
  };
}

/**
 * A span of whole calendar days, `[start, end)`, beginning on `date`.
 *
 * `start plus n times 864e5` is the tempting version and is wrong twice a
 * year: a week that contains a daylight saving change is 167 or 169 hours,
 * and a technician's sync window would end an hour early or late.
 */
export function daysFrom(date: string, days: number, timeZone: string): { start: Date; end: Date } {
  let last = date;
  for (let i = 0; i < Math.max(0, days); i += 1) last = nextDay(last);
  return { start: startOfDayIn(date, timeZone), end: startOfDayIn(last, timeZone) };
}

/**
 * The calendar date an instant falls on, in a zone.
 *
 * `en-CA` formats as `YYYY-MM-DD`, which is the shape every date column and
 * query parameter in this product expects.
 */
export function dateIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
}
