import { describe, it, expect } from "vitest";
import {
  chartFor, niceScale, position, barLayout, seriesLayout, labelEvery, MAX_BARS, MAX_SERIES,
  splitBarLayout, splitSeriesLayout,
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

/* ================================================== a second grouping, drawn */

describe("a chart cut by a second grouping", () => {
  const rows = [
    { technician: "Sam", status: "done", count: 2 },
    { technician: "Sam", status: "open", count: 1 },
    { technician: "Ana", status: "done", count: 4 },
    { technician: "Ana", status: "open", count: 3 },
    { technician: "Ana", status: "lost", count: 1 },
  ];
  const columns = [tech, status, count];
  const all = () => true;

  it("stacks each group's parts, biggest value of the second grouping first, and totals them", () => {
    const decision = chartFor({ columns, rows }, { split: "status", additive: all });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const { plan } = decision;
    expect(plan.split?.arrangement).toBe("stacked");
    expect(plan.split?.series.map((s) => s.key)).toEqual(["done", "open", "lost"]);
    expect(plan.summedOver).toEqual([]);
    expect(plan.points.map((p) => [p.key, p.value])).toEqual([["Sam", 3], ["Ana", 8]]);
    expect(plan.points[1]!.parts!.map((p) => [p.series, p.value])).toEqual([[0, 4], [1, 3], [2, 1]]);
    // The scale is for the tallest stack, not the tallest part.
    expect(plan.scale.max).toBeGreaterThanOrEqual(8);
  });

  it("sets them side by side when asked, on a scale for the biggest part", () => {
    const decision = chartFor({ columns, rows }, { split: "status", arrange: "grouped", additive: all });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.split?.arrangement).toBe("grouped");
    expect(decision.plan.scale.max).toBeGreaterThanOrEqual(4);
    expect(decision.plan.scale.max).toBeLessThan(8);
  });

  it("refuses to stack an average, and offers it side by side, because the parts of an average are not the whole", () => {
    const averages = [tech, status, average];
    const data = [
      { technician: "Sam", status: "done", avg: "100.0000" }, { technician: "Sam", status: "open", avg: "300.0000" },
    ];
    const stacked = chartFor({ columns: averages, rows: data }, { split: "status", additive: () => false });
    expect(stacked.ok).toBe(false);
    if (!stacked.ok) expect(stacked.reason).toMatch(/cannot be stacked.*side by side/);
    const grouped = chartFor({ columns: averages, rows: data }, { split: "status", arrange: "grouped", additive: () => false });
    expect(grouped.ok).toBe(true);
    if (grouped.ok) expect(grouped.plan.points[0]!.parts!.map((p) => p.exact)).toEqual(["300.0000", "100.0000"]);
  });

  it("adds money as money inside a part, and a third grouping away, naming it", () => {
    const decision = chartFor({
      columns: [tech, status, { key: "site", label: "Site", type: "text", role: "dimension" }, revenue],
      rows: [
        { technician: "Sam", status: "a", site: "x", revenue: "0.1000" },
        { technician: "Sam", status: "a", site: "y", revenue: "0.2000" },
      ],
    }, { split: "status", additive: all });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.points[0]!.parts![0]!.exact).toBe("0.3000");
    expect(decision.plan.summedOver).toEqual(["Site"]);
  });

  it("keeps the biggest values of the second grouping and adds the rest into one that cannot be opened", () => {
    const many = Array.from({ length: MAX_SERIES + 3 }, (_, i) => ({ technician: "Sam", status: `s${i}`, count: 100 - i }));
    const decision = chartFor({ columns, rows: many }, { split: "status", additive: all });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const series = decision.plan.split!.series;
    expect(series).toHaveLength(MAX_SERIES);
    expect(series.at(-1)).toEqual({ key: null, other: true });
    expect(series.slice(0, -1).map((s) => s.key)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    const parts = decision.plan.points[0]!.parts!;
    expect(parts.at(-1)!.row).toBeNull();
    // 100 - 5 .. 100 - 8 added together; nothing is lost.
    expect(parts.at(-1)!.value).toBe(95 + 94 + 93 + 92);
    expect(decision.plan.points[0]!.value).toBe(many.reduce((sum, r) => sum + r.count, 0));
    expect(parts.slice(0, -1).every((p) => p.row !== null)).toBe(true);
  });

  it("pins both groupings on a part's row, so it opens the records of that part", () => {
    const decision = chartFor({ columns, rows }, { split: "status", additive: all });
    if (!decision.ok) throw new Error("not drawn");
    expect(decision.plan.points[1]!.parts![0]!.row).toMatchObject({ technician: "Ana", status: "done" });
  });

  it("ignores a split by the grouping already drawn or by one the report has not got", () => {
    expect(chartFor({ columns, rows }, { split: "technician", dimension: "technician", additive: all }))
      .toMatchObject({ ok: true, plan: { split: null, summedOver: ["Status"] } });
    expect(chartFor({ columns, rows }, { split: "nothing", additive: all }))
      .toMatchObject({ ok: true, plan: { split: null } });
  });

  it("draws a dated split as stacked columns, or as a line for each value side by side, or as columns when asked", () => {
    const dated = [
      { month: "2026-07", status: "done", count: 2 }, { month: "2026-07", status: "open", count: 1 },
      { month: "2026-08", status: "done", count: 5 },
    ];
    const cols = [month, status, count];
    const stacked = chartFor({ columns: cols, rows: dated }, { split: "status", prefer: "line", additive: all });
    expect(stacked.ok && stacked.plan.kind).toBe("columns");
    const lines = chartFor({ columns: cols, rows: dated }, { split: "status", arrange: "grouped", additive: all });
    expect(lines.ok && lines.plan.kind).toBe("line");
    const grouped = chartFor({ columns: cols, rows: dated }, { split: "status", arrange: "grouped", prefer: "columns", additive: all });
    expect(grouped.ok && grouped.plan.kind).toBe("columns");
  });

  it("stacks bars end to end from zero, positive to the right and negative to the left", () => {
    const decision = chartFor({
      columns: [tech, status, revenue],
      rows: [
        { technician: "Sam", status: "in", revenue: "300.0000" },
        { technician: "Sam", status: "back", revenue: "-100.0000" },
        { technician: "Sam", status: "extra", revenue: "100.0000" },
      ],
    }, { split: "status", additive: all });
    if (!decision.ok) throw new Error("not drawn");
    const layout = splitBarLayout(decision.plan, 720);
    const [group] = layout.groups;
    const [first, second, third] = group!.parts;
    expect(first!.x).toBeCloseTo(layout.zeroX, 5);
    expect(second!.x + second!.width).toBeCloseTo(layout.zeroX, 5);
    expect(third!.x).toBeCloseTo(first!.x + first!.width, 5);
    expect(first!.width).toBeGreaterThan(third!.width);
  });

  it("sets a cluster of bars from zero for each part, with room for the most any group has", () => {
    const decision = chartFor({ columns, rows }, { split: "status", arrange: "grouped", additive: all });
    if (!decision.ok) throw new Error("not drawn");
    const layout = splitBarLayout(decision.plan, 720);
    expect(layout.groups[0]!.parts).toHaveLength(2);
    expect(layout.groups[1]!.parts).toHaveLength(3);
    expect(layout.groups[0]!.height).toBe(layout.groups[1]!.height);
    const ys = layout.groups[1]!.parts.map((p) => p.y);
    expect(new Set(ys).size).toBe(3);
    expect(layout.groups[1]!.parts.every((p) => p.x === layout.zeroX)).toBe(true);
  });

  it("stacks columns up from the axis and sets them side by side across their slot", () => {
    const dated = [
      { month: "2026-07", status: "done", count: 2 }, { month: "2026-07", status: "open", count: 3 },
    ];
    const stacked = chartFor({ columns: [month, status, count], rows: dated }, { split: "status", additive: all });
    if (!stacked.ok) throw new Error("not drawn");
    const layout = splitSeriesLayout(stacked.plan, 720, 260);
    const [low, high] = layout.groups[0]!.parts;
    expect(low!.y + low!.height).toBeCloseTo(layout.zeroY, 5);
    expect(high!.y + high!.height).toBeCloseTo(low!.y, 5);

    const side = chartFor({ columns: [month, status, count], rows: dated }, { split: "status", arrange: "grouped", prefer: "columns", additive: all });
    if (!side.ok) throw new Error("not drawn");
    const beside = splitSeriesLayout(side.plan, 720, 260).groups[0]!.parts;
    expect(beside[0]!.x + beside[0]!.width).toBeLessThanOrEqual(beside[1]!.x + 1);
    expect(beside[0]!.y + beside[0]!.height).toBeCloseTo(beside[1]!.y + beside[1]!.height, 5);
  });

  it("draws a line for each value of the second grouping, with a point only where it has a value", () => {
    const dated = [
      { month: "2026-07", status: "done", count: 2 }, { month: "2026-07", status: "open", count: 1 },
      { month: "2026-08", status: "done", count: 5 },
    ];
    const decision = chartFor({ columns: [month, status, count], rows: dated }, { split: "status", arrange: "grouped", additive: all });
    if (!decision.ok) throw new Error("not drawn");
    const layout = splitSeriesLayout(decision.plan, 720, 260);
    expect(layout.lines.map((l) => l.points.length)).toEqual([2, 1]);
  });
});
