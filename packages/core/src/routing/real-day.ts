/**
 * A ROUTE'S FIT ON THE REAL DAY
 *
 * The weekday's template says what a route is meant to be. A date is what the
 * servicer actually has: the visits already made from the route that day (one
 * moved off it, added to it or called off on the board counts as it now is),
 * the stops not yet made, and the person's own day. That day is their own
 * working hours when they keep some, otherwise the hours the company keeps
 * that date, less any approved leave inside it. A day the person is off for
 * all of it is refused; a day longer than the hours left is refused by how
 * much; and a day nobody declared hours for cannot be said either way.
 *
 * The overtime verdict beside it is a different question (when does the
 * company start paying more) and is left as it is: a person can be inside the
 * overtime threshold and still not have the hours, because they took the
 * afternoon off.
 */

/** Minutes after local midnight. */
export interface Span {
  start: number;
  end: number;
}

export interface RealDayFit {
  /** Minutes of leave inside the working window, or inside the whole day when the window is not known. */
  leaveMinutes: number;
  /** Off for all of it: leave covers the whole working window (or the whole day). */
  offAllDay: boolean;
  /** The window less the leave inside it. Null when no window is known. */
  availableMinutes: number | null;
  /** False when refused; true when the whole day is counted and fits; null when it cannot be said. */
  fits: boolean | null;
  /** By how many minutes the day runs past the hours left, when it does. */
  overBy: number | null;
}

/** The minutes a set of spans covers inside a window, overlaps counted once. */
export function coveredMinutes(spans: readonly Span[], within: Span): number {
  const clipped = spans
    .map((s) => ({ start: Math.max(s.start, within.start), end: Math.min(s.end, within.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let reach = within.start;
  for (const s of clipped) {
    const from = Math.max(s.start, reach);
    if (s.end > from) total += s.end - from;
    reach = Math.max(reach, s.end);
  }
  return total;
}

/**
 * Whether the day's work fits the hours the servicer has that date. `total`
 * is a floor when `travelComplete` is false: a floor already past the hours
 * left is a real refusal, and a floor inside them cannot be called a fit.
 */
export function realDayFit(input: {
  window: Span | null;
  leave: readonly Span[];
  totalMinutes: number;
  travelComplete: boolean;
}): RealDayFit {
  const within = input.window ?? { start: 0, end: 1440 };
  const leaveMinutes = coveredMinutes(input.leave, within);
  const offAllDay = within.end > within.start && leaveMinutes >= within.end - within.start;
  const availableMinutes = input.window ? Math.max(0, input.window.end - input.window.start - leaveMinutes) : null;
  if (offAllDay) return { leaveMinutes, offAllDay, availableMinutes, fits: false, overBy: null };
  if (availableMinutes === null) return { leaveMinutes, offAllDay, availableMinutes, fits: null, overBy: null };
  if (input.totalMinutes > availableMinutes) {
    return { leaveMinutes, offAllDay, availableMinutes, fits: false, overBy: input.totalMinutes - availableMinutes };
  }
  return { leaveMinutes, offAllDay, availableMinutes, fits: input.travelComplete ? true : null, overBy: null };
}
