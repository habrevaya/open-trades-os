import { describe, it, expect } from "vitest";
import { chartFor, narrowScale, niceScale, seriesLayout, type ChartColumn } from "../src/reporting/chart.js";
import { narrowReadingKeys } from "../src/customer-portal/index.js";

/**
 * A SCALE THAT STARTS AT THE DATA, FOR A READING IN A NARROW BAND
 *
 * Asked for, never chosen for the reader, and only where it cannot mislead: a
 * line of a plain number. An amount, bars, columns and a stack keep their
 * zero, because their length is what they say.
 */
const day: ChartColumn = { key: "day", label: "Date", type: "date", role: "dimension" };
const status: ChartColumn = { key: "status", label: "Status", type: "status", role: "dimension" };
const ph: ChartColumn = { key: "ph", label: "pH", type: "number", role: "measure" };
const revenue: ChartColumn = { key: "revenue", label: "Revenue", type: "money", role: "measure" };

const readings = [
  { day: "2026-07-01", ph: "7.2" }, { day: "2026-07-08", ph: "7.6" }, { day: "2026-07-15", ph: "7.4" },
];

describe("a scale from the data", () => {
  it("starts near the lowest reading and not at zero, with round gridlines and the data inside", () => {
    const scale = narrowScale(7.2, 7.6);
    expect(scale.fromData).toBe(true);
    expect(scale.min).toBeGreaterThan(6.5);
    expect(scale.min).toBeLessThanOrEqual(7.2);
    expect(scale.max).toBeGreaterThanOrEqual(7.6);
    expect(scale.max).toBeLessThan(8.5);
    expect(scale.ticks[0]).toBe(scale.min);
    expect(scale.ticks.at(-1)).toBe(scale.max);
    expect(scale.ticks).not.toContain(0);
    for (const tick of scale.ticks) expect(String(tick).length).toBeLessThanOrEqual(5);
  });

  it("gives a reading that did not move a band to sit in", () => {
    const scale = narrowScale(7.4, 7.4);
    expect(scale.min).toBeLessThan(7.4);
    expect(scale.max).toBeGreaterThan(7.4);
  });

  it("spreads a pressure between 55 and 65 over the height, where from zero it is a flat line", () => {
    const rows = [{ day: "2026-07-01", ph: "55" }, { day: "2026-07-08", ph: "65" }];
    const from = (baseline: "zero" | "data") => {
      const decision = chartFor({ columns: [day, ph], rows }, { prefer: "line", baseline });
      if (!decision.ok) throw new Error("no chart");
      const layout = seriesLayout(decision.plan, 720, 260);
      return Math.abs(layout.points[1]!.y - layout.points[0]!.y) / layout.plot.height;
    };
    expect(from("zero")).toBeLessThan(0.2);
    expect(from("data")).toBeGreaterThan(0.4);
  });
});

describe("where it is taken and where it is not", () => {
  it("is taken by a line of a plain number, and marked on the plan", () => {
    const decision = chartFor({ columns: [day, ph], rows: readings }, { prefer: "line", baseline: "data" });
    expect(decision.ok && decision.plan.narrowable).toBe(true);
    expect(decision.ok && decision.plan.scale.fromData).toBe(true);
    expect(decision.ok && decision.plan.scale.min).toBeGreaterThan(0);
  });

  it("stays from zero by default, and says it could be offered", () => {
    const decision = chartFor({ columns: [day, ph], rows: readings }, { prefer: "line" });
    expect(decision.ok && decision.plan.scale.fromData).toBeFalsy();
    expect(decision.ok && decision.plan.scale.min).toBe(0);
    expect(decision.ok && decision.plan.narrowable).toBe(true);
  });

  it("never takes it for an amount of money", () => {
    const rows = [{ day: "2026-07-01", revenue: "9000.00" }, { day: "2026-07-08", revenue: "9500.00" }];
    const decision = chartFor({ columns: [day, revenue], rows }, { prefer: "line", baseline: "data" });
    expect(decision.ok && decision.plan.narrowable).toBe(false);
    expect(decision.ok && decision.plan.scale.fromData).toBeFalsy();
    expect(decision.ok && decision.plan.scale.min).toBe(0);
  });

  it("never takes it for columns or bars, which are read by their length", () => {
    const columns = chartFor({ columns: [day, ph], rows: readings }, { prefer: "columns", baseline: "data" });
    expect(columns.ok && columns.plan.narrowable).toBe(false);
    expect(columns.ok && columns.plan.scale.min).toBe(0);
    const bars = chartFor({
      columns: [status, ph], rows: [{ status: "open", ph: "7.2" }, { status: "closed", ph: "7.6" }],
    }, { baseline: "data" });
    expect(bars.ok && bars.plan.kind).toBe("bars");
    expect(bars.ok && bars.plan.narrowable).toBe(false);
    expect(bars.ok && bars.plan.scale.min).toBe(0);
  });

  it("never takes it for a line that crosses zero, or has one point, or is cut by a second grouping", () => {
    const across = chartFor({ columns: [day, ph], rows: [{ day: "2026-07-01", ph: "-2" }, { day: "2026-07-08", ph: "3" }] }, { baseline: "data" });
    expect(across.ok && across.plan.narrowable).toBe(false);
    const single = chartFor({ columns: [day, ph], rows: [{ day: "2026-07-01", ph: "7.2" }] }, { baseline: "data" });
    expect(single.ok && single.plan.narrowable).toBe(false);
    const unit: ChartColumn = { key: "unit", label: "Unit", type: "text", role: "dimension" };
    const cut = chartFor({
      columns: [day, unit, ph],
      rows: [
        { day: "2026-07-01", unit: "a", ph: "7.2" }, { day: "2026-07-08", unit: "a", ph: "7.6" },
        { day: "2026-07-01", unit: "b", ph: "7.0" }, { day: "2026-07-08", unit: "b", ph: "7.1" },
      ],
    }, { split: "unit", arrange: "grouped", baseline: "data", additive: () => true });
    expect(cut.ok && cut.plan.narrowable).toBe(false);
    expect(cut.ok && cut.plan.scale.fromData).toBeFalsy();
  });

  it("keeps the usual scale exactly as it was", () => {
    const decision = chartFor({ columns: [day, ph], rows: readings }, { prefer: "line" });
    expect(decision.ok && decision.plan.scale).toEqual(niceScale(0, 7.6));
  });
});

describe("which readings a trade pack draws from the data", () => {
  it("is the keys a block names under narrow, and none otherwise", () => {
    expect(narrowReadingKeys({ keys: ["a", "b"], narrow: ["b", " b ", "", 4, "c"] })).toEqual(["b", "c"]);
    expect(narrowReadingKeys({ keys: ["a"] })).toEqual([]);
    expect(narrowReadingKeys({ narrow: "a" })).toEqual([]);
  });
});
