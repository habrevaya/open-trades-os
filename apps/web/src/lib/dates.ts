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
