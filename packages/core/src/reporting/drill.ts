import type { Permission } from "../access/permissions";
import {
  resolveReport,
  type Dataset, type Dimension, type Measure, type ReportDefinition, type ReportRefusal,
} from "./index.js";

/**
 * DRILL THROUGH, DECLARED ONCE PER DATASET
 *
 * An aggregate row is a claim: "$4,210 outstanding, over 90 days". An owner who
 * does not believe it wants the invoices behind it, and a report that cannot
 * show them teaches the owner to open the invoice list and add it up by hand,
 * which is the job the report was meant to do.
 *
 * Every row a report returns is already a precise description of a set of
 * records. It is the report's own definition (dataset, filters, date range)
 * with each grouped dimension pinned to the value on that row. So a drill is
 * not a second query somebody writes per report or per screen: it is the same
 * WHERE clause the aggregate used, plus one equality per dimension, with the
 * GROUP BY taken off. That is why the numbers agree. There is one definition of
 * which records a row is about, and both the aggregate and the list are read
 * through it.
 *
 * What a dataset has to add is only what a ROW of it looks like: its id, what
 * to call it, which screen opens it, and a few columns somebody needs to
 * recognise it. That is `RecordShape`, and it is required on every dataset, so
 * a dataset added tomorrow cannot be aggregated without saying what its
 * aggregates are made of.
 *
 * Each measure is also selected PER RECORD, from the same SQL fragment the
 * aggregate sums. So the drilled list shows, beside each invoice, the amount it
 * contributed to the number that was clicked, and the totals at the bottom are
 * those contributions added up. If they ever disagreed with the aggregate, the
 * definitions of the two would have drifted, and the test that runs every
 * built-in report both ways would say which one.
 */

export interface RecordColumn {
  key: string;
  label: string;
  /** Written by us, correlated against the dataset's own table. */
  sql: string;
  type: "text" | "status" | "date" | "money" | "number";
  /**
   * When the value names another record (the customer on an invoice), the id of
   * that record and the screen it opens. A drilled list of invoices where the
   * customer is plain text sends somebody back to search for the customer.
   */
  link?: { id: string; href: string };
}

export interface RecordShape {
  /** What one row is, in the words on a screen: "invoice", "invoices". */
  noun: string;
  plural: string;
  /** The record's own id. */
  id: string;
  /** What the record is called on the list. "Invoice 1042", "#88 Main line". */
  label: string;
  /** The screen one record opens on, with `{id}` where the id goes. */
  href: string;
  /**
   * The id that goes in `href`, when it is not the record's own: for a record
   * with no screen of its own that opens on the one it belongs to. No dataset
   * needs it today; a visit used to, before it had a page.
   */
  linkId?: string;
  /** A few columns that let somebody recognise the record without opening it. */
  columns: RecordColumn[];
  /**
   * What the list is sorted by, biggest first: newest, for every dataset so
   * far. An expression rather than a clause, so the drill can carry it out of
   * the query that computes the totals and sort on it afterwards.
   */
  orderBy: string;
}

/**
 * The value a row showed for each dimension, keyed by dimension.
 *
 * Null is a value: a job with no customer name grouped under "Not set" is a
 * row like any other, and the drill has to match it with `is null` rather than
 * with an equality that matches nothing.
 */
export type DrillMatch = Record<string, string | null>;

export interface DrillRequest {
  definition: ReportDefinition;
  match: DrillMatch;
}

export type DrillDecision =
  | {
      ok: true;
      dataset: Dataset;
      /** The dimensions being pinned, resolved, in the order of the definition. */
      pinned: { dimension: Dimension; value: string | null }[];
      measures: Measure[];
      record: RecordShape;
    }
  | ReportRefusal;

/**
 * Whether this drill can run for this reader, and what it pins.
 *
 * It goes through `resolveReport` first, deliberately. A drill is a read of the
 * records behind a report, so anything that would refuse the report (a dataset
 * the reader may not open, a cost measure they may not see) refuses the drill
 * too, in the same words. A drill that was laxer than the report would be the
 * report builder's scope hole again, one click further down.
 *
 * A dimension may only be pinned if the definition groups by it. Pinning
 * anything else would describe records the report never counted, and the
 * totals at the bottom of the list would be a number nobody clicked.
 */
export function resolveDrill(
  request: DrillRequest,
  catalogue: Dataset[],
  held: Set<Permission>,
): DrillDecision {
  const decision = resolveReport(request.definition, catalogue, held);
  if (!decision.ok) return decision;

  const unknown = Object.keys(request.match)
    .filter((key) => !request.definition.dimensions.includes(key))
    .map((key) => `match: ${key}`);
  if (unknown.length > 0) return { ok: false, reason: "unknown_field", detail: unknown };

  const pinned = decision.dimensions
    .filter((dimension) => Object.hasOwn(request.match, dimension.key))
    .map((dimension) => ({ dimension, value: request.match[dimension.key] ?? null }));

  return {
    ok: true,
    dataset: decision.dataset,
    pinned,
    measures: decision.measures,
    record: decision.dataset.records,
  };
}

/**
 * The match a row of a report pins, read off the row.
 *
 * Every grouped dimension, with the value as it came back, including the sort
 * prefix on an aging bucket: the drill compares against the expression, and
 * the expression produces the prefix.
 */
export function matchFor(
  definition: ReportDefinition,
  row: Record<string, string | number | null>,
): DrillMatch {
  const match: DrillMatch = {};
  for (const key of definition.dimensions) {
    const value = row[key];
    match[key] = value === null || value === undefined ? null : String(value);
  }
  return match;
}

/* ----------------------------------------------------------------- totals */

/**
 * EXACT DECIMALS, OF ANY LENGTH
 *
 * `money` holds four places and refuses more, which is right for money that is
 * stored. A per-record contribution is not stored: labour is minutes over
 * sixty times a rate, which Postgres carries to twenty places, and the
 * aggregate it is compared with was summed at that precision. Rounding each
 * record to four places before adding them up would make the totals disagree
 * with the report by a cent in the fifth job, which is exactly the
 * disagreement this feature exists to rule out.
 *
 * So these add at whatever precision arrived, with a BigInt and a scale, and
 * never through a float.
 */
interface Decimal { units: bigint; scale: number }

function parseDecimal(value: string | number): Decimal | null {
  const text = typeof value === "number" ? numberText(value) : value.trim();
  const found = /^(-)?(\d*)(?:\.(\d+))?$/.exec(text);
  if (!found || (found[2] === "" && !found[3])) return null;
  const whole = found[2] || "0";
  const frac = found[3] ?? "";
  const units = BigInt(whole + frac);
  return { units: found[1] ? -units : units, scale: frac.length };
}

/** A float that came back from `::float8`, written without an exponent. */
function numberText(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = String(value);
  if (!/e/i.test(text)) return text;
  return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

function rescale(d: Decimal, scale: number): bigint {
  return d.units * 10n ** BigInt(scale - d.scale);
}

function decimalText(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const frac = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  return `${negative && (whole !== "0" || frac !== "") ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** A decimal string with no trailing zeros, so two spellings of one number compare equal. */
export function normalizeDecimal(value: string | number): string {
  const parsed = parseDecimal(value);
  return parsed ? decimalText(parsed.units, parsed.scale) : String(value);
}

/** The exact sum of some decimals, at the precision of the most precise one. */
export function sumDecimals(values: (string | number)[]): string {
  const parsed = values.map(parseDecimal).filter((d): d is Decimal => d !== null);
  const scale = Math.max(0, ...parsed.map((d) => d.scale));
  const units = parsed.reduce((total, d) => total + rescale(d, scale), 0n);
  return decimalText(units, scale);
}

/** -1, 0 or 1, exactly. */
export function compareDecimals(a: string | number, b: string | number): number {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (!x || !y) return 0;
  const scale = Math.max(x.scale, y.scale);
  const left = rescale(x, scale);
  const right = rescale(y, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Two decimals rounded half up to `places` and compared.
 *
 * Only an average needs it. A sum is compared exactly, and an average is a
 * division whose last digit depends on how many places the divider carried.
 */
export function sameAt(a: string | number, b: string | number, places: number): boolean {
  return roundDecimal(a, places) === roundDecimal(b, places);
}

export function roundDecimal(value: string | number, places: number): string {
  const parsed = parseDecimal(value);
  if (!parsed) return String(value);
  if (parsed.scale <= places) return decimalText(parsed.units, parsed.scale);
  const drop = 10n ** BigInt(parsed.scale - places);
  const negative = parsed.units < 0n;
  const magnitude = negative ? -parsed.units : parsed.units;
  const rounded = (magnitude + drop / 2n) / drop;
  return decimalText(negative ? -rounded : rounded, places);
}

/**
 * What the drilled records add up to, measure by measure.
 *
 * A count is how many records there are. A sum is their contributions added
 * exactly. An average is the average of the records that HAVE a value, because
 * that is what `avg` does in the database: a null is left out of both halves
 * rather than counted as a zero. Min and max are what they say.
 *
 * Null, never zero, for an average or a min over no records, which is the same
 * choice the scorecard makes: nothing to measure is a different answer from a
 * measurement of nought. A sum or a count over nothing IS zero, and the report
 * says zero for it too.
 */
export function drillTotals(
  measures: Pick<Measure, "key" | "kind">[],
  rows: Record<string, string | number | null>[],
): Record<string, string | null> {
  const totals: Record<string, string | null> = {};
  for (const measure of measures) {
    if (measure.kind === "count") {
      totals[measure.key] = String(rows.length);
      continue;
    }
    const values = rows
      .map((row) => row[measure.key])
      .filter((value): value is string | number => value !== null && value !== undefined && value !== "");

    if (measure.kind === "sum") {
      totals[measure.key] = sumDecimals(values);
    } else if (measure.kind === "avg") {
      totals[measure.key] = values.length === 0 ? null : divideDecimal(sumDecimals(values), values.length);
    } else {
      if (values.length === 0) {
        totals[measure.key] = null;
        continue;
      }
      const wanted = measure.kind === "min" ? -1 : 1;
      totals[measure.key] = normalizeDecimal(values.reduce((best, value) =>
        compareDecimals(value, best) === wanted ? value : best));
    }
  }
  return totals;
}

/** A decimal over a count, to twelve places, which is more than any screen shows. */
function divideDecimal(value: string, by: number): string {
  const parsed = parseDecimal(value)!;
  const places = 12;
  const scaled = rescale(parsed, parsed.scale + places);
  const quotient = scaled / BigInt(by);
  return roundDecimal(decimalText(quotient, parsed.scale + places), places);
}
