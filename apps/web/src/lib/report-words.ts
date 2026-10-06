import type { reporting } from "@opentradesos/core";
import { formatDay } from "./dates";
import { enumText } from "./labels";

/**
 * A REPORT'S CONDITIONS, IN WORDS
 *
 * The records behind a number and a printed report both say what applied
 * ("Status is not Paid. From Sep 1, 2026 up to Oct 1, 2026. Houston only."),
 * because a list of invoices or a page of numbers with no dates on it reads
 * as "all of them", and the person comparing it to their own count will be
 * counting a different thing. One writer, so the two pages say it the same
 * way.
 */

/** A month bucket comes back as `2026-09`, which nobody reads as September. */
export function formatMonth(value: string): string {
  const date = new Date(`${value}-01T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

/** A pinned or filtered value, in the words the report showed it in. */
export function said(type: string, value: string | null, sortPrefix?: boolean): string {
  if (value === null || value === "") return "Not set";
  if (type === "status") return enumText(value);
  if (type === "date" && /^\d{4}-\d{2}$/.test(value)) return formatMonth(value);
  return sortPrefix ? value.replace(/^\d+\s+/, "") : value;
}

/** The report's filters, dates and branch, in words. */
export function describeDefinition(
  definition: reporting.ReportDefinition,
  dataset: reporting.Dataset | undefined,
  timezone: string,
  branchName?: string | null,
): string[] {
  const out: string[] = [];
  for (const filter of definition.filters ?? []) {
    const dimension = dataset?.dimensions.find((d) => d.key === filter.dimension);
    const name = dimension?.label ?? filter.dimension;
    const values = (Array.isArray(filter.value) ? filter.value : [filter.value])
      .map((v) => said(dimension?.type ?? "text", v, dimension?.sortPrefix));
    const verb = filter.op === "neq" ? "is not" : filter.op === "in" ? "is one of" : "is";
    out.push(`${name} ${verb} ${values.join(", ")}`);
  }
  if (definition.from && definition.to) {
    out.push(`From ${formatDay(definition.from, timezone)} up to ${formatDay(definition.to, timezone)}`);
  } else if (definition.from) {
    out.push(`From ${formatDay(definition.from, timezone)}`);
  } else if (definition.to) {
    out.push(`Before ${formatDay(definition.to, timezone)}`);
  }
  if (definition.branchId) out.push(`${branchName ?? "One branch"} only`);
  return out;
}
