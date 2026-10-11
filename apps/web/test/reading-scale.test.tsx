import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportChart, additivityFor } from "../src/components/ReportChart";
import { ReadingsChart } from "../src/components/ReadingsChart";

/**
 * A SCALE FROM THE DATA IS SAID ON THE CHART
 *
 * The arithmetic is core's. What is here is that a chart that does not start
 * at zero wears the fact: in the picture, in its description, and in words
 * under it, that the choice is offered only where it cannot mislead, and that
 * the usual chart says nothing.
 */
const points = [
  { at: "2026-07-01T15:00:00Z", value: "58.0000" },
  { at: "2026-07-15T15:00:00Z", value: "62.0000" },
  { at: "2026-08-01T15:00:00Z", value: "60.0000" },
];

describe("the readings chart", () => {
  it("starts at zero and says nothing about it, unless the trade named the reading", () => {
    const html = renderToStaticMarkup(<ReadingsChart label="Static pressure" unit="psi" points={points} />);
    expect(html).toContain("<svg");
    expect(html).not.toContain("not zero");
    expect(html).not.toContain("not at zero");
  });

  it("starts at the data when named, and says so in the picture, its description and the words under it", () => {
    const html = renderToStaticMarkup(<ReadingsChart label="Static pressure" unit="psi" points={points} fromData />);
    expect(html).toMatch(/Scale starts at \d+, not zero/);
    expect(html).toMatch(/The scale starts at \d+, not at zero/);
    expect(html).toMatch(/This chart starts at \d+, not at zero, so small changes look bigger than they are/);
    // The gridlines are near the readings, not down at zero.
    expect(html).not.toMatch(/>0<\/text>/);
  });
});

describe("a report chart", () => {
  const byDay = {
    columns: [
      { key: "day", label: "Day", type: "date", role: "dimension" as const },
      { key: "ph", label: "Average pH", type: "number", role: "measure" as const },
    ],
    rows: [{ day: "2026-07-01", ph: "7.2" }, { day: "2026-07-08", ph: "7.6" }, { day: "2026-07-15", ph: "7.4" }],
    truncated: false,
  };
  const href = (b: "zero" | "data") => `/reports/x?scale=${b}`;

  it("offers the scale only to a line of a plain number, and marks it once chosen", () => {
    const offered = renderToStaticMarkup(
      <ReportChart result={byDay} additive={additivityFor(undefined)} title="pH" baselineHref={href} />,
    );
    expect(offered).toContain("Around the data");
    expect(offered).toContain('href="/reports/x?scale=data"');
    expect(offered).not.toContain("not zero");

    const chosen = renderToStaticMarkup(
      <ReportChart result={byDay} additive={additivityFor(undefined)} title="pH" baseline="data" baselineHref={href} />,
    );
    expect(chosen).toContain("not at zero");
    expect(chosen).toContain('href="/reports/x?scale=zero"');
    expect(chosen).toContain("From zero");
  });

  it("never offers it for an amount of money, and ignores it when asked for", () => {
    const money = {
      columns: [
        { key: "day", label: "Day", type: "date", role: "dimension" as const },
        { key: "revenue", label: "Revenue", type: "money", role: "measure" as const },
      ],
      rows: [{ day: "2026-07-01", revenue: "9000.00" }, { day: "2026-07-08", revenue: "9500.00" }],
      truncated: false,
    };
    const html = renderToStaticMarkup(
      <ReportChart result={money} additive={additivityFor(undefined)} title="Revenue" baseline="data" baselineHref={href} />,
    );
    expect(html).not.toContain("Around the data");
    expect(html).not.toContain("not at zero");
  });
});
