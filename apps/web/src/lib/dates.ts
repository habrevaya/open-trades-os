/**
 * "Today", in the company's timezone.
 *
 * Not the server's and not the viewer's. A shop in Austin whose server runs in
 * UTC would otherwise find that at seven in the evening the dispatch board
 * jumped to tomorrow and emptied itself, which is a support call in the middle
 * of the busiest part of the day.
 *
 * `toISOString().slice(0, 10)` is the tempting one-liner and it is exactly the
 * bug: it always answers in UTC, whatever the server is set to.
 *
 * Not marked `server-only`. It is a pure function of an instant and a zone,
 * it reaches nothing, and marking it so made it unimportable from a test,
 * which is a high price for a boundary it does not need.
 */
export function todayIn(timezone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is the shape every date input and
  // every query parameter in this app expects.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/**
 * A timestamp as the COMPANY sees it, not the server or the browser.
 *
 * Both of the obvious alternatives are wrong in the same way. Formatting on
 * the server uses whatever zone the container happens to have, which is UTC,
 * so a five o'clock appointment in Austin renders as eleven. Formatting in
 * the browser uses the viewer's zone, so a dispatcher in Denver is shown a
 * different appointment from the one the customer was promised, and it also
 * differs from the server's render, which React reports as a hydration
 * mismatch and then silently accepts.
 */
export function formatIn(
  value: Date | string,
  timezone: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  },
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timezone }).format(date);
}

/**
 * A date-only value, as the company reads it.
 *
 * `2026-09-06` in a Due column is a string a person has to decode, and the
 * ISO ordering that makes it right to store is exactly what makes it hard to
 * scan. Parsed at UTC midnight and formatted in the company's zone, because
 * a date with no time in it is a calendar day rather than a moment, and
 * letting the runtime guess a local midnight shifts it by one in half the
 * world.
 */
export function formatDay(isoDate: string, timezone: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: timezone,
  }).format(date);
}
