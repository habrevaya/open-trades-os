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
 *
 * FROM ZERO UNLESS THE TRADE SAYS OTHERWISE. A reading that moves in a narrow
 * band (a water pressure between 55 and 65 psi) is a flat line on a scale from
 * zero, so the trade pack can name it, and then the scale starts at the data.
 * The chart says so on its face, in the picture and in words under it, because
 * the heights are then not proportions of the value. A reading that sits on
 * both sides of zero stays on the usual scale whatever was asked.
 */
export function ReadingsChart({ label, unit, equipment = null, fromData = false, points }: {
  label: string;
  unit: string | null;
  /** The unit the readings were taken on, which names the chart beside the reading. */
  equipment?: string | null | undefined;
  /** Start the scale at the data instead of zero, for a reading that moves in a narrow band. */
  fromData?: boolean | undefined;
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
  }, { prefer: "line", baseline: fromData ? "data" : "zero" });
  if (!decision.ok) return null;
  return (
    <figure className="mt-2">
      <Series plan={decision.plan} drill={undefined} title={equipment ? `${label}, ${equipment}` : label}
              described={`${measure} by date`} />
    </figure>
  );
}
