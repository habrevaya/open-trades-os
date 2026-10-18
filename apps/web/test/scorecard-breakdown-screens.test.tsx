import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BreakdownPicker, BreakdownTable } from "../src/app/(app)/reports/scorecard/Scorecard";

const kpi = {
  key: "cancel_rate_route", label: "Cancellation rate by route", definition: "Stops cancelled late over stops.",
  target: "5", state: "computed" as const, needs: null, endpoint: null, format: "percent" as const,
  value: "37.5", numerator: "3", denominator: "8",
  numeratorLabel: "stops the customer called off inside the notice window",
  denominatorLabel: "stops scheduled, other than those the company called off",
  numeratorMoney: false, denominatorMoney: false,
};

/** M21: A FIGURE BROKEN DOWN BY WHAT ITS RECORDS SAY */
describe("a scorecard figure broken down", () => {
  it("offers a selector only where the records carry a grouping, as a form that needs no JavaScript", () => {
    const html = renderToStaticMarkup(<BreakdownPicker
      kpi={{ ...kpi, groupings: [{ key: "route", label: "Route" }, { key: "weekday", label: "Weekday" }] }}
      from="2026-06-01" to="2026-06-30" chosen="weekday"
    />);
    expect(html).toContain('method="get"');
    expect(html).toContain("Break it down by");
    expect(html).toContain('<option value="route">Route</option>');
    expect(html).toContain('<option value="weekday" selected="">Weekday</option>');
    expect(html).toContain('name="kpi" value="cancel_rate_route"');
    expect(renderToStaticMarkup(<BreakdownPicker kpi={{ ...kpi, groupings: [] }} from="a" to="b" chosen={null} />)).toBe("");
  });

  it("shows each group's figure and two halves, each half opening that group's records", () => {
    const html = renderToStaticMarkup(<BreakdownTable
      result={{
        key: "cancel_rate_route", label: "Cancellation rate by route", format: "percent",
        by: { key: "route", label: "Route" }, from: "2026-06-01", to: "2026-06-30",
        numeratorLabel: kpi.numeratorLabel, denominatorLabel: kpi.denominatorLabel,
        numeratorMoney: false, denominatorMoney: false,
        besides: [{ key: "excluded", label: "stops the company called off itself, left out" }],
        groups: [
          { value: "none", label: "East", figure: null, numerator: "0", denominator: "0", besides: [{ key: "excluded", count: "1" }] },
          { value: "route:n", label: "North", figure: "40.0", numerator: "2", denominator: "5", besides: [{ key: "excluded", count: "0" }] },
        ],
        numerator: "2", denominator: "5",
      }}
      records={(half, group) => `/reports/scorecard/records?half=${half}&group=${group}`}
    />);
    expect(html).toContain("North");
    expect(html).toContain("40.0%");
    // An empty denominator is not nought, for one group as for the figure.
    expect(html).toContain("Not this window");
    expect(html).toContain('href="/reports/scorecard/records?half=denominator&amp;group=route:n"');
    expect(html).toContain('href="/reports/scorecard/records?half=excluded&amp;group=none"');
    expect(html).toContain("All of them");
  });
});
