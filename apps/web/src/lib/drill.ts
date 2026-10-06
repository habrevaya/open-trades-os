import { reporting } from "@opentradesos/core";
import { queryFor, type Params } from "./report-params";

/**
 * A DRILL, IN A URL
 *
 * The report's own definition, exactly as the builder writes it into a query
 * string, plus one `pin` per grouped dimension and where to go back to. So a
 * drill is a link like every report in this product: it survives being sent
 * to a bookkeeper, the back button works, and nothing about it lives in
 * component state.
 *
 * `pin=aging:5 Over 90 days` pins a value. `pin=month` with no colon pins
 * NULL, which is how the group a report shows as "Not set" is opened rather
 * than matched against the words "Not set". A value may itself hold a colon,
 * so only the first one splits.
 */

export interface DrillContext {
  /** The report's name, for the heading and the way back. */
  title: string;
  /** The page the number was on, with its dates. */
  back: string;
}

export function drillHref(
  definition: reporting.ReportDefinition,
  row: Record<string, string | number | null>,
  context: DrillContext,
): string {
  const query = new URLSearchParams(queryFor(definition));
  for (const [key, value] of Object.entries(reporting.matchFor(definition, row))) {
    query.append("pin", value === null ? key : `${key}:${value}`);
  }
  query.set("title", context.title);
  query.set("back", context.back);
  return `/reports/drill?${query.toString()}`;
}

/** The pins back off a URL. */
export function pinsFrom(params: Params): reporting.DrillMatch {
  const value = params.pin;
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const match: reporting.DrillMatch = {};
  for (const entry of raw) {
    const at = entry.indexOf(":");
    if (at < 0) match[entry] = null;
    else match[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return match;
}

/**
 * Where "back" may go: a page on this site and nowhere else.
 *
 * It arrives on a URL anybody can write, and a link reading "Back to
 * Receivables by age" that goes to somebody else's site is the shape of a
 * phishing link inside the product's own chrome.
 */
export function safeBack(value: string | string[] | undefined): string {
  const back = Array.isArray(value) ? value[0] : value;
  return back && back.startsWith("/") && !back.startsWith("//") && !back.startsWith("/\\") ? back : "/reports";
}
