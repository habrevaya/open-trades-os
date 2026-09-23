import type { Permission } from "../access/permissions";
import type { ScopedResource } from "../access/scopes";

/**
 * REPORTING, AS A SEMANTIC LAYER
 *
 * A report definition is DATA. It names a dataset, some dimensions, some
 * measures and some filters, all of them drawn from a catalogue declared
 * here, and the service turns that into SQL.
 *
 * The alternative, and the one most products reach for, is letting somebody
 * write the query. That is arbitrary read access against a multi-tenant
 * database in a product people self host: row level security would still
 * hold, but scope would not, field redaction would not, and a technician with
 * the report builder would have the cost column. It is the same argument as
 * workflow conditions, which are also data and also never evaluated.
 *
 * The cost of this choice is real. You cannot express every query, and a
 * contractor who wants a window function is out of luck. What they get
 * instead is direct SQL against a read-only analytics schema, which is a
 * separate credential with its own grants, rather than a builder that quietly
 * becomes one.
 *
 * WHAT A CATALOGUE ENTRY IS FOR
 *
 * Three things, and the second two are the reason this is not just a list of
 * column names:
 *
 *   the SQL fragment, so no user string ever reaches a query
 *   the permission, so cost and margin are not merely hidden in the UI
 *   the scope resource, so "jobs by status" means a technician's own jobs
 */

export type MeasureKind = "count" | "sum" | "avg" | "min" | "max";

export interface Dimension {
  key: string;
  label: string;
  /** The expression, written by us. Never assembled from input. */
  sql: string;
  /**
   * Presentation only.
   *
   * `status` is `text` that came out of an enum column, so a renderer knows
   * to make `in_progress` readable. It is not a separate SQL shape and it
   * deliberately does not change what is stored or filtered on: a saved
   * report's filter must keep matching when somebody improves a label.
   */
  type: "text" | "status" | "date" | "money" | "number";
  /** When present, only an actor holding it may group by this. */
  permission?: Permission;
  /**
   * The value carries a numeric prefix that exists only to sort.
   *
   * The aging buckets are the reason: "Over 90" sorts between "1 to 30" and
   * "31 to 60" alphabetically, which makes the receivables report look wrong
   * to the person who needs it most. Prefixing fixes the order and the
   * prefix has to come back off before anybody reads it, so the catalogue
   * says so rather than the UI guessing, which would mangle a customer
   * called "3 Brothers Plumbing".
   */
  sortPrefix?: boolean;
}

export interface Measure {
  key: string;
  label: string;
  kind: MeasureKind;
  /** The column being aggregated. Absent for `count`. */
  sql?: string;
  type: "money" | "number";
  /**
   * Cost and margin live here. A measure with a permission is refused rather
   * than blanked, because a report that silently drops a column somebody
   * asked for teaches them the number is zero.
   */
  permission?: Permission;
}

export interface Dataset {
  key: string;
  label: string;
  description: string;
  /**
   * The FROM clause, written by us.
   *
   * The table is its own alias, deliberately. The scope filters are written
   * against the drizzle schema and render as `"job"."column"`, so a short
   * alias here makes every one of them an invalid reference to a FROM clause
   * entry. A test caught that; a short alias reads nicer and would have
   * silently broken scope on every report.
   */
  from: string;
  permission: Permission;
  /**
   * Which scope filter applies. A report is a read like any other: a
   * technician running one sees their own work, and a report that ignored
   * scope would be the most convenient way around it in the product.
   */
  scope: ScopedResource;
  dimensions: Dimension[];
  measures: Measure[];
  /** The column a date range filters on. */
  dateColumn: string;
}

export interface ReportDefinition {
  dataset: string;
  /** Empty means a single total row, which is a legitimate report. */
  dimensions: string[];
  measures: string[];
  filters?: { dimension: string; op: "eq" | "neq" | "in"; value: string | string[] }[];
  /** Inclusive start, exclusive end. Both optional. */
  from?: string;
  to?: string;
  /**
   * What to order by: a measure, or a dimension.
   *
   * Left out, a report grouped by a single date orders by that date, and
   * anything else orders by its first measure, biggest first. Naming a date
   * dimension reads chronologically; naming anything else reads biggest
   * first, which is what a ranking is.
   */
  orderBy?: string;
  limit?: number;
}

export type ReportRefusal =
  | { ok: false; reason: "unknown_dataset"; detail: string }
  | { ok: false; reason: "unknown_field"; detail: string[] }
  | { ok: false; reason: "missing_permission"; permissions: Permission[] }
  | { ok: false; reason: "no_measures"; detail: string };

export type ReportDecision =
  | { ok: true; dataset: Dataset; dimensions: Dimension[]; measures: Measure[] }
  | ReportRefusal;

/**
 * Whether this definition can be run by this actor, at all.
 *
 * Returns the resolved catalogue entries on success, so the caller builds SQL
 * from objects it was handed rather than from strings it was given. That is
 * the whole safety property: by the time anything is concatenated, every
 * fragment came from this file.
 */
export function resolveReport(
  definition: ReportDefinition,
  catalogue: Dataset[],
  held: Set<Permission>,
): ReportDecision {
  const dataset = catalogue.find((d) => d.key === definition.dataset);
  if (!dataset) {
    return { ok: false, reason: "unknown_dataset", detail: definition.dataset };
  }

  /**
   * A measure is the point of a report. Without one this is a list of
   * distinct values, which the record screens already do better.
   */
  if (definition.measures.length === 0) {
    return { ok: false, reason: "no_measures", detail: "A report needs at least one measure" };
  }

  const unknown: string[] = [];
  const dimensions = definition.dimensions.map((key) => {
    const found = dataset.dimensions.find((d) => d.key === key);
    if (!found) unknown.push(`dimension: ${key}`);
    return found;
  });
  const measures = definition.measures.map((key) => {
    const found = dataset.measures.find((m) => m.key === key);
    if (!found) unknown.push(`measure: ${key}`);
    return found;
  });
  for (const filter of definition.filters ?? []) {
    if (!dataset.dimensions.some((d) => d.key === filter.dimension)) {
      unknown.push(`filter: ${filter.dimension}`);
    }
  }
  if (unknown.length > 0) {
    /**
     * Refused, not ignored. A field that is dropped silently produces a
     * report that looks like it answered the question and did not, and
     * somebody makes a decision on it.
     */
    return { ok: false, reason: "unknown_field", detail: unknown };
  }

  const needed = [
    dataset.permission,
    ...dimensions.flatMap((d) => (d!.permission ? [d!.permission] : [])),
    ...measures.flatMap((m) => (m!.permission ? [m!.permission] : [])),
  ];
  const missing = [...new Set(needed)].filter((p) => !held.has(p));
  if (missing.length > 0) {
    /**
     * Refused rather than blanked. A report that quietly omits the cost
     * column teaches whoever ran it that the cost is zero, and they will act
     * on it. Saying no is the kinder answer and the honest one.
     */
    return { ok: false, reason: "missing_permission", permissions: missing };
  }

  return {
    ok: true,
    dataset,
    dimensions: dimensions as Dimension[],
    measures: measures as Measure[],
  };
}

/** The refusal in words somebody can act on. */
export function explainRefusal(refusal: ReportRefusal): string {
  switch (refusal.reason) {
    case "unknown_dataset":
      return `There is no dataset called "${refusal.detail}".`;
    case "unknown_field":
      return `Not available on this dataset: ${refusal.detail.join(", ")}.`;
    case "missing_permission":
      return `This report needs: ${refusal.permissions.join(", ")}.`;
    case "no_measures":
      return refusal.detail;
  }
}
