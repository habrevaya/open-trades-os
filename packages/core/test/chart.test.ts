import { describe, it, expect } from "vitest";
import {
  chartFor, niceScale, position, barLayout, seriesLayout, labelEvery, MAX_BARS,
  type ChartColumn,
} from "../src/reporting/chart.js";

const month: ChartColumn = { key: "month", label: "Month", type: "date", role: "dimension" };
const status: ChartColumn = { key: "status", label: "Status", type: "status", role: "dimension" };
const tech: ChartColumn = { key: "technician", label: "Technician", type: "text", role: "dimension" };
const revenue: ChartColumn = { key: "revenue", label: "Revenue", type: "money", role: "measure" };
const count: ChartColumn = { key: "count", label: "Jobs", type: "number", role: "measure" };
const average: ChartColumn = { key: "avg", label: "Average ticket", type: "money", role: "measure" };

describe("which chart a report gets", () => {
  it("draws a report grouped by a date as a line, oldest first as the report returned it", () => {
    const decision = chartFor({
      columns: [month, revenue],
      rows: [{ month: "2026-07", revenue: "100.0000" }, { month: "2026-08", revenue: "250.5000" }],
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.kind).toBe("line");
    expect(decision.plan.points.map((p) => p.key)).toEqual(["2026-07", "2026-08"]);
    expect(decision.plan.points[1]!.exact).toBe("250.5000");
  });

  it("draws columns over time when asked, and never a line through categories", () => {
    const dated = chartFor({ columns: [month, count], rows: [{ month: "2026-07", count: 3 }] }, { prefer: "columns" });
    expect(dated.ok && dated.plan.kind).toBe("columns");
    const category = chartFor({ columns: [status, count], rows: [{ status: "open", count: 3 }] }, { prefer: "line" });
    expect(category.ok && category.plan.kind).toBe("bars");
  });

  it("refuses a single total, which has nothing to compare", () => {
    const decision = chartFor({ columns: [count], rows: [{ count: 4 }] });
    expect(decision.ok).toBe(false);
  });

  it("adds a count up over a second grouping, and says it did", () => {
    const decision = chartFor({
      columns: [tech, status, count],
      rows: [
        { technician: "Sam", status: "done", count: 2 },
        { technician: "Sam", status: "open", count: 1 },
        { technician: "Ana", status: "done", count: 4 },
      ],
    }, { additive: () => true });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.points.map((p) => [p.key, p.value])).toEqual([["Sam", 3], ["Ana", 4]]);
    expect(decision.plan.summedOver).toEqual(["Status"]);
  });

  it("adds money as money, to the cent", () => {
    const decision = chartFor({
      columns: [tech, status, revenue],
      rows: [
        { technician: "Sam", status: "a", revenue: "0.1000" },
        { technician: "Sam", status: "b", revenue: "0.2000" },
      ],
    }, { additive: () => true });
    expect(decision.ok && decision.plan.points[0]!.exact).toBe("0.3000");
  });

  it("refuses to add up an average across a grouping, because that changes what it means", () => {
    const decision = chartFor({
      columns: [tech, status, average],
      rows: [{ technician: "Sam", status: "a", avg: "10" }],
    }, { additive: (key) => key !== "avg" });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toMatch(/cannot be added up/);
  });

  it("keeps a group with no value as its own bar rather than merging it into another", () => {
    const decision = chartFor({
      columns: [tech, count],
      rows: [{ technician: null, count: 2 }, { technician: "Sam", count: 1 }],
    });
    expect(decision.ok && decision.plan.points.map((p) => p.key)).toEqual([null, "Sam"]);
  });

  it("draws the biggest bars when there are too many, and counts the rest", () => {
    const rows = Array.from({ length: MAX_BARS + 5 }, (_, i) => ({ technician: `T${i}`, count: 100 - i }));
    const decision = chartFor({ columns: [tech, count], rows });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.points).toHaveLength(MAX_BARS);
    expect(decision.plan.points[0]!.key).toBe("T0");
    expect(decision.plan.omitted).toBe(5);
  });

  it("draws the measure that was asked for", () => {
    const decision = chartFor({
      columns: [status, count, revenue],
      rows: [{ status: "open", count: 1, revenue: "5" }],
    }, { measure: "revenue" });
    expect(decision.ok && decision.plan.measure.key).toBe("revenue");
  });
});

describe("the scale", () => {
  it("lands gridlines on round numbers and always includes zero", () => {
    const scale = niceScale(0, 937);
    expect(scale.min).toBe(0);
    expect(scale.max).toBeGreaterThanOrEqual(937);
    expect(scale.ticks).toContain(0);
    for (const tick of scale.ticks) expect(tick % 100).toBe(0);
  });

  it("reaches below zero for a loss", () => {
    const scale = niceScale(-120, 400);
    expect(scale.min).toBeLessThanOrEqual(-120);
    expect(scale.ticks).toContain(0);
  });

  it("does not divide by zero when every value is zero", () => {
    expect(niceScale(0, 0)).toEqual({ min: 0, max: 1, ticks: [0, 1] });
  });

  it("labels small steps without floating point noise", () => {
    expect(niceScale(0, 0.7).ticks.every((t) => String(t).length <= 4)).toBe(true);
  });

  it("puts a value between the ends", () => {
    const scale = { min: 0, max: 200, ticks: [] };
    expect(position(50, scale)).toBe(0.25);
    expect(position(500, scale)).toBe(1);
  });
});

describe("where the shapes go", () => {
  it("grows bars from zero, so a loss is drawn to the left of the axis", () => {
    const decision = chartFor({
      columns: [tech, revenue],
      rows: [{ technician: "Up", revenue: "100" }, { technician: "Down", revenue: "-50" }],
    });
    if (!decision.ok) throw new Error(decision.reason);
    const layout = barLayout(decision.plan, 600);
    const [up, down] = layout.bars;
    expect(up!.x).toBeCloseTo(layout.zeroX);
    expect(down!.x + down!.width).toBeCloseTo(layout.zeroX);
    expect(up!.width).toBeGreaterThan(down!.width);
  });

  it("spreads points across the plot and puts the larger value higher", () => {
    const decision = chartFor({
      columns: [month, count],
      rows: [{ month: "2026-01", count: 1 }, { month: "2026-02", count: 9 }],
    });
    if (!decision.ok) throw new Error(decision.reason);
    const layout = seriesLayout(decision.plan, 600, 240);
    const [a, b] = layout.points;
    expect(b!.x).toBeGreaterThan(a!.x);
    expect(b!.y).toBeLessThan(a!.y);
    expect(layout.gridlines[0]!.value).toBe(0);
  });

  it("prints every date label up to a dozen and thins them after", () => {
    expect(labelEvery(12)).toBe(1);
    expect(labelEvery(365)).toBe(31);
  });
});
