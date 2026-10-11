import type { Permission } from "../access/permissions.js";
import { resolveReport, explainRefusal, type Dataset, type FixedFilter } from "../reporting/index.js";
import type { Checked } from "./workflow.js";

/**
 * A REPORT TYPE AN APPLICATION REGISTERED
 *
 * A cut of one of the report builder's own datasets: which of its columns
 * to offer for grouping, which of its numbers to offer, and filters it
 * always carries. "Install jobs by permit status" is the jobs dataset with
 * the job type fixed to Install and the permit field offered. It appears in
 * the report builder and on dashboards under its own name, and it is built
 * from the catalogue's own fragments, so there is no SQL in it anywhere.
 *
 * PERMISSIONS ARE THE BASE'S. A report type is a narrower view of records
 * somebody could already count, so whoever runs one needs exactly what the
 * dataset, columns and filters it is built from need, scope included, and
 * registering one is held to the same check against what the application
 * may read. A type is never a way to see further than its base.
 */

export interface ReportType {
  label: string;
  description: string | null;
  /** The key of the dataset it is cut from. */
  base: string;
  dimensions: string[];
  measures: string[];
  filters: Array<{ dimension: string; op: "eq" | "neq" | "in"; value: string | string[] }>;
}

/** The prefix a registered report type's dataset key carries, so it is never taken for the product's. */
export const DATASET_PREFIX = "app_";

/** The dataset key a report type is offered under. */
export const datasetKey = (key: string): string => `${DATASET_PREFIX}${key}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? value as string[] : null;

/**
 * Check a report type against the company's catalogue, every problem at
 * once. `catalogue` is what the report builder offers this company: the
 * product's datasets with its own fields and kinds of record. A type cut
 * from another application's type is refused, so one application's report
 * cannot quietly depend on another's still being installed.
 */
export function checkReportType(input: unknown, catalogue: readonly Dataset[]): Checked<ReportType> {
  if (!isRecord(input)) return { ok: false, problems: ["A report type is an object with a label and a base dataset."] };
  const problems: string[] = [];
  const label = typeof input["label"] === "string" ? input["label"].trim() : "";
  if (label.length === 0 || label.length > 80) problems.push("A report type needs a label of 1 to 80 characters.");
  const description = typeof input["description"] === "string" && input["description"].trim() !== ""
    ? input["description"].trim().slice(0, 500) : null;

  const baseKey = typeof input["base"] === "string" ? input["base"] : "";
  const base = catalogue.find((d) => d.key === baseKey && d.base === undefined && !d.key.startsWith(DATASET_PREFIX));
  if (!base) {
    problems.push(`"${baseKey}" is not one of the report builder's datasets.`);
    return { ok: false, problems };
  }

  const dimensions = strings(input["dimensions"] ?? []);
  const measures = strings(input["measures"]);
  if (!dimensions) problems.push("Dimensions are a list of the base dataset's column keys.");
  if (!measures || measures.length === 0) problems.push("A report type offers at least one measure.");
  for (const key of dimensions ?? []) {
    if (!base.dimensions.some((d) => d.key === key)) problems.push(`${base.label} has no column "${key}".`);
  }
  for (const key of measures ?? []) {
    if (!base.measures.some((mm) => mm.key === key)) problems.push(`${base.label} has no measure "${key}".`);
  }

  const filters: ReportType["filters"] = [];
  const rawFilters = input["filters"] === undefined ? [] : input["filters"];
  if (!Array.isArray(rawFilters) || rawFilters.length > 10) {
    problems.push("Filters are a list of at most ten.");
  } else {
    for (const raw of rawFilters as unknown[]) {
      if (!isRecord(raw)) { problems.push("A filter names a column, an operator and a value."); continue; }
      const dimension = typeof raw["dimension"] === "string" ? raw["dimension"] : "";
      const op = raw["op"];
      const value = raw["value"];
      if (!base.dimensions.some((d) => d.key === dimension)) {
        problems.push(`${base.label} has no column "${dimension}" to filter on.`);
        continue;
      }
      if (op === "in") {
        const list = strings(value);
        if (!list || list.length === 0 || list.length > 50) { problems.push(`The filter on "${dimension}" needs a list of 1 to 50 values.`); continue; }
        filters.push({ dimension, op, value: list });
      } else if (op === "eq" || op === "neq") {
        if (typeof value !== "string" || value.length > 200) { problems.push(`The filter on "${dimension}" needs one value.`); continue; }
        filters.push({ dimension, op, value });
      } else {
        problems.push(`The filter on "${dimension}" uses "${String(op)}". A filter is "eq", "neq" or "in".`);
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: { label, description, base: base.key, dimensions: [...new Set(dimensions!)], measures: [...new Set(measures!)], filters },
  };
}

/**
 * Whether somebody holding `held` could read everything the type is built
 * from, answered by the report builder's own check on the same columns,
 * so registering a type and running a report agree about what is allowed.
 * Null when they could; the refusal in words when not.
 */
export function readRefusal(type: ReportType, catalogue: readonly Dataset[], held: Set<Permission>): string | null {
  const decision = resolveReport(
    { dataset: type.base, dimensions: type.dimensions, measures: type.measures, filters: type.filters },
    [...catalogue], held,
  );
  return decision.ok ? null : explainRefusal(decision);
}

/**
 * The type as a dataset of the catalogue, or null when its base or any of
 * its columns has gone (a field retired since, a kind of record removed):
 * a report type that silently lost a column would answer a different
 * question under the same name.
 */
export function reportTypeDataset(key: string, type: ReportType, catalogue: readonly Dataset[]): Dataset | null {
  const base = catalogue.find((d) => d.key === type.base && d.base === undefined);
  if (!base) return null;
  const dimensions = type.dimensions.map((k) => base.dimensions.find((d) => d.key === k));
  const measures = type.measures.map((k) => base.measures.find((mm) => mm.key === k));
  const fixedFilters: FixedFilter[] = [];
  for (const filter of type.filters) {
    const dimension = base.dimensions.find((d) => d.key === filter.dimension);
    if (!dimension) return null;
    fixedFilters.push({
      dimension: filter.dimension, label: dimension.label, sql: dimension.sql,
      ...(dimension.permission ? { permission: dimension.permission } : {}),
      op: filter.op, value: filter.value,
    });
  }
  if (dimensions.some((d) => d === undefined) || measures.some((mm) => mm === undefined)) return null;
  return {
    ...base,
    key: datasetKey(key),
    label: type.label,
    description: type.description ?? `${type.label}, from ${base.label.toLowerCase()}.`,
    base: base.key,
    dimensions: dimensions as Dataset["dimensions"],
    measures: measures as Dataset["measures"],
    fixedFilters,
  };
}
