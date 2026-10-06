import { reporting } from "@opentradesos/core";
import { Series } from "./ReportChart";

/**
 * ONE UNIT'S READINGS OVER TIME, DRAWN
 *
 * The same line the reports draw, from the same arithmetic in core
 * (`reporting.chartFor` and its layout), so a customer's chart and an
 * owner's look and behave alike: server rendered SVG, no chart library,
 * readable with JavaScript off. The table under it on the account page has
 * every value exactly; this is for seeing which way they are going.
 *
 * One point per day, oldest on the left. Two readings of the same thing on
 * the same day (a second report that afternoon) are drawn as the later one,
 * and both are in the table. Nothing is drawn for fewer than two days,
 * because a line needs two ends.
 */
export function ReadingsChart({ label, unit, points }: {
  label: string;
  unit: string | null;
  points: { at: string; value: string }[];
}) {
  const byDay = new Map<string, string>();
  for (const point of points) {
    if (!/^-?\d+(\.\d+)?$/.test(point.value)) continue;
    byDay.set(point.at.slice(0, 10), point.value);
  }
  if (byDay.size < 2) return null;
  const measure = unit ? `${label} (${unit})` : label;
  const decision = reporting.chartFor({
    columns: [
      { key: "day", label: "Date", type: "date", role: "dimension" },
      { key: "value", label: measure, type: "number", role: "measure" },
    ],
    rows: [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, value]) => ({ day, value })),
  }, { prefer: "line" });
  if (!decision.ok) return null;
  return (
    <figure className="mt-2">
      <Series plan={decision.plan} drill={undefined} title={label} described={`${measure} by date`} />
    </figure>
  );
}
