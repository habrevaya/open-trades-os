/**
 * RECURRENCE
 *
 * Four models, because research across the platforms people migrate FROM
 * found four genuinely different ones, and reconstructing the wrong one
 * silently drifts every future date. A maintenance visit that slides a week
 * each cycle is invisible for a year and then the customer says nobody came.
 *
 * Everything here works in plain calendar dates, never timestamps. A
 * maintenance visit due on the 15th is due on the 15th in the customer's
 * town, and running this through a timezone is how it becomes the 14th for
 * half the country twice a year.
 */

export type RecurrenceModel = "rule" | "materialized" | "anchored_to_completion" | "manual";

export interface RecurrenceException {
  /** ISO date of the occurrence being changed. */
  date: string;
  action: "skipped" | "moved" | "cancelled";
  movedTo?: string;
  reason?: string;
}

export interface RecurrenceSpec {
  model: RecurrenceModel;
  startsOn: string;
  endsOn?: string | undefined;
  /** For anchored_to_completion and for a simple interval rule. */
  intervalDays?: number | undefined;
  /**
   * Months, 1 to 12, that occurrences are pinned to. A heating tune up belongs
   * in autumn regardless of when the agreement was sold, and counting forward
   * from the sale date puts it in July for anyone who signed up in January.
   */
  anchorMonths?: number[] | undefined;
  /** Day of the month for anchored months. Clamped to the month's length. */
  anchorDay?: number | undefined;
  /**
   * The load bearing field for anchored_to_completion: when the last visit
   * ACTUALLY happened, not when it was supposed to.
   */
  lastOccurredOn?: string | undefined;
  exceptions?: RecurrenceException[] | undefined;
  /** Occurrences are never generated beyond this many months out. */
  horizonMonths?: number | undefined;
  /** For the materialized and manual models: the dates as they exist. */
  dates?: string[] | undefined;
}

// ---------------------------------------------------------------------------
// Date helpers. UTC throughout, dates only.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(iso: string): Date {
  if (!DATE_RE.test(iso)) throw new TypeError(`Not an ISO date: ${JSON.stringify(iso)}`);
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Not a real date: ${iso}`);
  return d;
}

export const formatDate = (d: Date): string => d.toISOString().slice(0, 10);

export const addDays = (iso: string, days: number): string => {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
};

/**
 * Month arithmetic that does not roll over. Adding a month to 31 January
 * gives 28 February, not 3 March, because a plan visit due at month end is
 * due at month end.
 */
export const addMonths = (iso: string, months: number): string => {
  const d = parseDate(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(Math.min(day, daysInMonth(d.getUTCFullYear(), d.getUTCMonth())));
  return formatDate(d);
};

const daysInMonth = (year: number, monthIndex: number) =>
  new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

export const compareDates = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface Occurrence {
  date: string;
  /** True when an exception moved this one off its natural date. */
  moved: boolean;
  sequence: number;
}

/**
 * Every occurrence between two dates, inclusive, with exceptions applied.
 *
 * Bounded by the horizon on purpose. Materialising an unbounded series fills
 * a dispatch board with rows nobody will look at for three years;
 * materialising none leaves it empty next week.
 */
export function occurrencesBetween(spec: RecurrenceSpec, from: string, to: string): Occurrence[] {
  const horizonEnd = spec.horizonMonths
    ? addMonths(todayOr(from), spec.horizonMonths)
    : to;
  const candidates: string[] = [to, horizonEnd];
  if (spec.endsOn) candidates.push(spec.endsOn);
  // The earliest of the three bounds wins: the caller's window, the horizon,
  // and the end of the series.
  const limit = candidates.sort(compareDates)[0]!;

  const natural = generate(spec, from, limit);
  return applyExceptions(natural, spec.exceptions ?? [], from, limit);
}

/** The next occurrence strictly after a date, or null when the series is done. */
export function nextOccurrence(spec: RecurrenceSpec, after: string): string | null {
  const window = addMonths(after, Math.max(spec.horizonMonths ?? 24, 24));
  const found = occurrencesBetween(spec, addDays(after, 1), window);
  return found[0]?.date ?? null;
}

const todayOr = (fallback: string) => fallback;

function generate(spec: RecurrenceSpec, from: string, to: string): string[] {
  switch (spec.model) {
    case "manual":
    case "materialized":
      // The dates ARE the schedule. Nothing is computed, and nothing should
      // be: a materialized series has been edited by hand and regenerating
      // it from a rule discards every one of those edits.
      return (spec.dates ?? []).filter((d) => d >= from && d <= to).sort(compareDates);

    case "anchored_to_completion": {
      /**
       * Counted from the last ACTUAL completion. This is the model that makes
       * a pool or pest route correct: weekly means seven days from when the
       * technician was really there, not every Tuesday forever, so a rain day
       * shifts the whole series rather than being silently skipped.
       *
       * Only ONE future occurrence is knowable. The one after it depends on
       * when this one actually completes, and inventing a date for it is the
       * lie that makes a route drift.
       */
      if (!spec.intervalDays || spec.intervalDays < 1) return [];
      const anchor = spec.lastOccurredOn ?? addDays(spec.startsOn, -spec.intervalDays);
      const next = addDays(anchor, spec.intervalDays);
      const due = next < spec.startsOn ? spec.startsOn : next;
      return due >= from && due <= to ? [due] : [];
    }

    case "rule": {
      if (spec.anchorMonths && spec.anchorMonths.length > 0) return seasonal(spec, from, to);
      if (!spec.intervalDays || spec.intervalDays < 1) return [];

      const out: string[] = [];
      let cursor = spec.startsOn;
      // Fast forward rather than stepping day by day from the start date,
      // which matters for a weekly schedule opened five years later.
      if (cursor < from) {
        const gap = Math.floor((parseDate(from).getTime() - parseDate(cursor).getTime()) / 86400000);
        cursor = addDays(cursor, Math.floor(gap / spec.intervalDays) * spec.intervalDays);
      }
      let guard = 0;
      while (cursor <= to && guard++ < 10000) {
        if (cursor >= from) out.push(cursor);
        cursor = addDays(cursor, spec.intervalDays);
      }
      return out;
    }
  }
}

/**
 * Seasonal occurrences, pinned to months rather than counted forward.
 *
 * A two visit plan with anchors in April and October gives a cooling tune up
 * in spring and a heating one in autumn, for every member, regardless of
 * whether they signed up in January or in August. Counting six months forward
 * from the sale date instead produces a heating tune up in July, which is the
 * single most common way a seasonal plan gets built wrong.
 */
function seasonal(spec: RecurrenceSpec, from: string, to: string): string[] {
  const months = [...new Set(spec.anchorMonths!)].sort((a, b) => a - b);
  const day = spec.anchorDay ?? 15;
  const out: string[] = [];

  const startYear = parseDate(from < spec.startsOn ? spec.startsOn : from).getUTCFullYear();
  const endYear = parseDate(to).getUTCFullYear();

  for (let year = startYear; year <= endYear; year++) {
    for (const month of months) {
      const clamped = Math.min(day, daysInMonth(year, month - 1));
      const date = `${year}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
      if (date >= spec.startsOn && date >= from && date <= to) out.push(date);
    }
  }
  return out.sort(compareDates);
}

/**
 * Exceptions are applied last, and they are data rather than noise.
 *
 * A customer who declined a visit has told us something, and losing that means
 * re-offering work they already refused. A moved occurrence keeps its place in
 * the sequence so "visit two of four" stays true on the invoice.
 */
function applyExceptions(
  dates: string[], exceptions: RecurrenceException[], from: string, to: string,
): Occurrence[] {
  const byDate = new Map(exceptions.map((e) => [e.date, e]));
  const out: Occurrence[] = [];

  dates.forEach((date, i) => {
    const exception = byDate.get(date);
    if (!exception) {
      out.push({ date, moved: false, sequence: i + 1 });
      return;
    }
    if (exception.action === "skipped" || exception.action === "cancelled") return;
    if (exception.action === "moved" && exception.movedTo) {
      if (exception.movedTo >= from && exception.movedTo <= to) {
        out.push({ date: exception.movedTo, moved: true, sequence: i + 1 });
      }
    }
  });

  return out.sort((a, b) => compareDates(a.date, b.date));
}

/**
 * The visit schedule an agreement owes over one term.
 *
 * Generated when the term starts rather than lazily, so "which members have
 * not had their visit yet" is a query rather than an investigation. That query
 * is the difference between an agreement book that renews and one that quietly
 * does not get delivered until somebody notices at renewal.
 */
export function agreementVisitDates(opts: {
  startsOn: string;
  termMonths: number;
  includedVisits: number;
  anchorMonths?: number[] | undefined;
  anchorDay?: number | undefined;
}): string[] {
  const { startsOn, termMonths, includedVisits } = opts;
  if (includedVisits < 1) return [];
  const termEnd = addMonths(startsOn, termMonths);

  if (opts.anchorMonths && opts.anchorMonths.length > 0) {
    const dates = seasonal(
      {
        model: "rule", startsOn,
        anchorMonths: opts.anchorMonths,
        ...(opts.anchorDay != null ? { anchorDay: opts.anchorDay } : {}),
      },
      startsOn, termEnd,
    );
    return dates.slice(0, includedVisits);
  }

  /**
   * No anchors: spread across the term, first visit one interval in rather
   * than on the day of sale, since a tune up on the signing day is both
   * unlikely and a wasted included visit.
   *
   * EACH DATE IS COMPUTED FROM ITS OWN POSITION, not by stepping a rounded
   * interval, and the difference is a bug rather than a nicety. A rounded
   * step of `termMonths / includedVisits` compounds: four visits in six
   * months rounds to two, so the fourth lands at eight months, falls outside
   * the term, and is dropped by the filter below. The member paid for four
   * visits and the schedule owes them three, which is the one answer here
   * that is definitely wrong.
   *
   * Rounding each position separately keeps the last one exactly at the term
   * end, and gives the same dates as before whenever the count divides the
   * term evenly, which is most plans. Where it does not, a five visit year
   * now runs to December instead of finishing in October.
   */
  return Array.from({ length: includedVisits }, (_, i) =>
    addMonths(startsOn, Math.max(1, Math.round((termMonths * (i + 1)) / includedVisits))))
    .filter((d) => d <= termEnd);
}
