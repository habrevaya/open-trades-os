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
 * The instant at which a wall clock reads this, in a zone.
 *
 * Solved by iteration rather than algebra: guess that the offset is whatever
 * it is at the same numbers read as UTC, correct, and check again. The second
 * pass is what handles a time that sits inside a daylight saving transition,
 * where the offset before the guess and the offset after it differ.
 *
 * Two wall times are not instants at all and this cannot say so on its own:
 * the hour that does not exist when the clocks go forward, and the hour that
 * happens twice when they go back. `wallTimeExists` answers the first, and
 * the second resolves to the earlier of the two, which is the reading a
 * person who wrote "1:30am" would recognise.
 */
export function instantOfLocal(
  date: string, minutesPastMidnight: number, timeZone: string,
): Date {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(midnight)) throw new Error(`Not a calendar date: ${date}`);
  const asIfUtc = midnight + minutesPastMidnight * 60_000;

  /**
   * TWO CANDIDATES, AND THE EARLIER ONE WINS.
   *
   * The previous version iterated `instant = asIfUtc - offsetAt(instant)`
   * twice from a single seed and returned wherever it settled. On an
   * ambiguous wall time that has two fixed points, and WHICH ONE it settles
   * on depends on where the seed landed relative to the transition, which
   * depends on the sign of the zone's offset. So it returned the earlier
   * occurrence in America and the LATER one everywhere at or east of
   * Greenwich, while the comment above promised the earlier everywhere.
   *
   * What that cost: `wallEntry` in the labour module builds a timesheet
   * correction from this. A technician in London who worked 01:30 to 09:30
   * on the clocks-back Sunday stood there for nine hours, and the entry paid
   * eight. The `ambiguous` flag that exists to catch exactly that was false
   * too, because `isRepeatedHour` asks whether one real hour later reads the
   * same wall clock, which is only true when you are sitting on the FIRST of
   * the pair. The bug disarmed its own safety net.
   *
   * Both candidate offsets are tried explicitly now, and each is kept only if
   * it actually round trips to the wall time asked for. An ambiguous time
   * yields two valid answers and takes the smaller; an ordinary time yields
   * one; a time in the spring gap yields none, and the fallback keeps the old
   * behaviour of returning something rather than throwing, because
   * `wallTimeExists` is the function that answers that question.
   */
  const seed = new Date(asIfUtc);
  const candidates: number[] = [];
  for (const reference of [
    // Before the transition and after it. An hour either side of the naive
    // reading covers every real world transition, which are all one hour
    // except Lord Howe Island, which is thirty minutes.
    new Date(asIfUtc - 86_400_000),
    seed,
    new Date(asIfUtc + 86_400_000),
  ]) {
    const instant = asIfUtc - offsetAt(reference, timeZone);
    // Kept only if reading it back in the zone gives the wall time asked for.
    if (asIfUtc - offsetAt(new Date(instant), timeZone) === instant) {
      if (!candidates.includes(instant)) candidates.push(instant);
    }
  }

  if (candidates.length === 0) {
    // A wall time that never happened. `wallTimeExists` says so; this returns
    // the naive reading rather than throwing, which is what it always did.
    let instant = seed;
    for (let pass = 0; pass < 2; pass += 1) {
      instant = new Date(asIfUtc - offsetAt(instant, timeZone));
    }
    return instant;
  }

  return new Date(Math.min(...candidates));
}

/**
 * Whether that wall time happened at all.
 *
 * Between two and three on the morning the clocks go forward, nothing does.
 * A daily job set for half past two must be skipped that day rather than
 * silently moved an hour, which is what every "just add the offset" version
 * of this does.
 */
export function wallTimeExists(
  date: string, minutesPastMidnight: number, timeZone: string,
): boolean {
  const instant = instantOfLocal(date, minutesPastMidnight, timeZone);
  return dateIn(instant, timeZone) === date
    && minutesInDay(instant, timeZone) === minutesPastMidnight;
}

/** Minutes past local midnight, for an instant. */
export function minutesInDay(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(instant);
  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (field("hour") % 24) * 60 + field("minute");
}

/** The instant a calendar day starts in a zone. */
export function startOfDayIn(date: string, timeZone: string): Date {
  return instantOfLocal(date, 0, timeZone);
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
