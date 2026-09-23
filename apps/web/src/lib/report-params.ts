import type { reporting } from "@opentradesos/core";

/**
 * A REPORT DEFINITION, IN A URL
 *
 * The builder keeps its whole state in the query string rather than in
 * component state. That is what makes a report somebody built shareable,
 * bookmarkable and reloadable, and it is what lets "edit a copy of this
 * built-in report" be a link rather than a feature.
 *
 * Nothing here validates. `resolveReport` in core does that against the
 * catalogue, and duplicating the check in the browser would give two answers
 * that can disagree. This only reads and writes the shape.
 */

export type Params = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

/** A repeatable parameter, whether it arrived repeated or comma separated. */
function many(value: string | string[] | undefined): string[] {
  const parts = (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
  // Ordered, deduplicated. Grouping by the same dimension twice is a
  // Postgres error rather than a report.
  return [...new Set(parts)];
}

const OPS = ["eq", "neq", "in"] as const;
type Op = (typeof OPS)[number];

/**
 * `filter=status:neq:paid`, or `filter=status:in:open,scheduled`.
 *
 * Written this way so a filtered built-in report survives being copied into
 * the builder. An unrecognised operator is dropped rather than guessed at:
 * the definition it produced would be refused anyway, and refusing it here
 * would mean two error paths saying different things.
 */
function filtersFrom(params: Params): reporting.ReportDefinition["filters"] {
  const value = params.filter;
  const raw = Array.isArray(value) ? [...value] : value ? [value] : [];

  /**
   * The builder's "add a filter" row arrives as three fields rather than one
   * packed string, because a select cannot write into another field without
   * JavaScript and this form works without it. Packed here so there is one
   * reader of a filter and not two that can drift.
   */
  const dimension = one(params.fd);
  const op = one(params.fo);
  const literal = one(params.fv);
  if (dimension && op && literal) raw.push(`${dimension}:${op}:${literal}`);

  const out: NonNullable<reporting.ReportDefinition["filters"]> = [];
  for (const entry of raw) {
    const [dimension, op, ...rest] = entry.split(":");
    const tail = rest.join(":");
    if (!dimension || !op || tail === "") continue;
    if (!OPS.includes(op as Op)) continue;
    out.push({
      dimension,
      op: op as Op,
      value: op === "in" ? tail.split(",").map((v) => v.trim()).filter(Boolean) : tail,
    });
  }
  return out;
}

/** Null when no dataset was named, which is the builder's empty state. */
export function definitionFrom(params: Params): reporting.ReportDefinition | null {
  const dataset = one(params.dataset);
  if (!dataset) return null;

  const from = one(params.from);
  const to = one(params.to);
  const orderBy = one(params.orderBy);
  const filters = filtersFrom(params);

  return {
    dataset,
    dimensions: many(params.dimensions),
    measures: many(params.measures),
    ...(filters && filters.length > 0 ? { filters } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(orderBy ? { orderBy } : {}),
  };
}

/** The same definition, back as a query string. */
export function queryFor(definition: reporting.ReportDefinition): string {
  const query = new URLSearchParams();
  query.set("dataset", definition.dataset);
  if (definition.dimensions.length > 0) query.set("dimensions", definition.dimensions.join(","));
  if (definition.measures.length > 0) query.set("measures", definition.measures.join(","));
  for (const filter of definition.filters ?? []) {
    const value = Array.isArray(filter.value) ? filter.value.join(",") : filter.value;
    query.append("filter", `${filter.dimension}:${filter.op}:${value}`);
  }
  if (definition.from) query.set("from", definition.from);
  if (definition.to) query.set("to", definition.to);
  if (definition.orderBy) query.set("orderBy", definition.orderBy);
  return query.toString();
}

/**
 * The definition a submitted builder form describes.
 *
 * Checkboxes arrive as repeated fields with the same name, which is the same
 * shape the query string uses, so both go through `definitionFrom` and there
 * is one reader rather than two.
 */
export function definitionFromForm(form: FormData): reporting.ReportDefinition | null {
  const params: Params = {};
  for (const key of new Set(form.keys())) {
    params[key] = form.getAll(key).map(String);
  }
  return definitionFrom(params);
}
