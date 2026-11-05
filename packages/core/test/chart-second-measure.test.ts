import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { pdf, reporting } from "../src/index";
import { checkShape, type Tile } from "../src/dashboard/index.js";
import type { Dataset } from "../src/reporting/index.js";
import type { Permission } from "../src/access/permissions.js";

/**
 * A CHART WITH TWO MEASURES
 *
 * A second measure is drawn over the same groups as the first, on the first's
 * scale when the units are the same and on a scale of its own when they are
 * not. It never rides on a chart cut by a second grouping, and a tile that
 * asks for one it cannot draw is refused in words.
 */
const inflate = (bytes: Uint8Array) => new Uint8Array(inflateSync(bytes));

const result = {
  columns: [
    { key: "month", label: "Month", type: "date", role: "dimension" as const },
    { key: "total", label: "Invoiced", type: "money", role: "measure" as const },
    { key: "count", label: "Invoices", type: "number", role: "measure" as const },
    { key: "average", label: "Average invoice", type: "money", role: "measure" as const },
  ],
  rows: [
    { month: "2026-07", total: "12000.00", count: 8, average: "1500.00" },
    { month: "2026-08", total: "18000.00", count: 10, average: "1800.00" },
    { month: "2026-09", total: "9000.00", count: 4, average: "2250.00" },
  ],
};
const additive = (key: string) => key === "total" || key === "count";

describe("a second measure on a chart", () => {
  it("gets a scale of its own when the unit differs, aligned to the same groups", () => {
    const decision = reporting.chartFor(result, { measure: "total", second: "count", additive });
    expect(decision.ok).toBe(true);
    const plan = decision.ok ? decision.plan : null;
    expect(plan!.secondary?.ownAxis).toBe(true);
    expect(plan!.secondary?.values.map((v) => v.exact)).toEqual(["8", "10", "4"]);
    // Its own scale, not the amount of money's.
    expect(plan!.secondary!.scale.max).toBeLessThan(plan!.scale.max);
    const layout = reporting.seriesLayout(plan!, 720, 260);
    expect(layout.second?.points).toHaveLength(3);
    expect(layout.second?.ticks.length).toBeGreaterThan(1);
    // Room is made on the right for the labels of that scale.
    expect(layout.plot.width).toBeLessThan(720 - 64 - 16);
    // The biggest count sits at the same height as nothing on the money scale, and below the top.
    const ys = layout.second!.points.map((p) => p.y);
    expect(ys[1]).toBeLessThan(ys[0]!);
    expect(ys[1]).toBeLessThan(ys[2]!);
  });

  it("shares one scale when the units are the same, so a taller mark is a bigger amount on both", () => {
    const decision = reporting.chartFor(result, { measure: "total", second: "average", additive });
    const plan = decision.ok ? decision.plan : null;
    expect(plan!.secondary?.ownAxis).toBe(false);
    expect(plan!.secondary!.scale).toEqual(plan!.scale);
    expect(reporting.seriesLayout(plan!, 720, 260).second?.ticks).toEqual([]);
  });

  it("lays a second bar under each bar for a category, with its own zero when the scale is its own", () => {
    const byType = {
      columns: [
        { key: "customer", label: "Customer", type: "text", role: "dimension" as const },
        { key: "total", label: "Invoiced", type: "money", role: "measure" as const },
        { key: "count", label: "Invoices", type: "number", role: "measure" as const },
      ],
      rows: [
        { customer: "Ada", total: "500.00", count: 2 },
        { customer: "Bo", total: "300.00", count: 6 },
      ],
    };
    const plain = reporting.chartFor(byType, { measure: "total", additive });
    const two = reporting.chartFor(byType, { measure: "total", second: "count", additive });
    const a = reporting.barLayout((plain as { plan: reporting.ChartPlan }).plan, 720);
    const b = reporting.barLayout((two as { plan: reporting.ChartPlan }).plan, 720);
    expect(a.seconds).toEqual([]);
    expect(b.seconds).toHaveLength(2);
    expect(b.height).toBeGreaterThan(a.height);
    // The second bar sits under the first, inside the same row.
    expect(b.seconds[0]!.y).toBeGreaterThan(b.bars[0]!.y + b.bars[0]!.height - 1);
    expect(b.seconds[0]!.y).toBeLessThan(b.bars[1]!.y);
    // Bo has fewer dollars and more invoices than Ada; each bar is on its own scale.
    expect(b.bars[1]!.width).toBeLessThan(b.bars[0]!.width);
    expect(b.seconds[1]!.width).toBeGreaterThan(b.seconds[0]!.width);
  });

  it("is left off a chart cut by a second grouping, and ignored when it names nothing", () => {
    const cut = reporting.chartFor(
      { columns: [...result.columns, { key: "kind", label: "Kind", type: "text", role: "dimension" as const }], rows: result.rows.map((r) => ({ ...r, kind: "a" })) },
      { measure: "total", second: "count", split: "kind", additive },
    );
    expect(cut.ok && cut.plan.secondary).toBeNull();
    const none = reporting.chartFor(result, { measure: "total", second: "nope", additive });
    expect(none.ok && none.plan.secondary).toBeNull();
  });

  it("is printed with both measures named and the scale of each said", () => {
    const decision = reporting.chartFor(result, { measure: "total", second: "count", additive, prefer: "columns" });
    const plan = decision.ok ? decision.plan : null;
    const read = pdf.inspectPdf(pdf.dashboardPdf({
      company: { name: "Lone Star Air", color: "#1F6FEB" },
      name: "Money",
      asOf: "October 18, 2026 at 7:00 AM",
      ranAs: "Olive Owner",
      tiles: [{ title: "Invoiced and invoices", chart: plan, table: result }],
      leftOut: [],
      dates: "Sep 1, 2026 to Sep 30, 2026",
      keepsOwnDates: ["Outstanding"],
      generatedAt: new Date("2026-10-18T12:00:00Z"),
    }), inflate);
    expect(read.problems).toEqual([]);
    for (const words of ["Invoiced, columns, left scale", "Invoices, amber line, right scale", "Sep 1, 2026 to Sep 30, 2026", "Outstanding"]) {
      expect(read.text).toContain(words);
    }
  });
});

const INVOICES: Dataset = {
  key: "invoices", label: "Invoices", description: "", from: "public.invoice", permission: "report.financial:read" as Permission,
  scope: "invoice", dateColumn: "invoice.issued_on",
  records: { noun: "invoice", plural: "invoices", id: "invoice.id", label: "invoice.number::text", href: "/invoices/{id}", columns: [], orderBy: "invoice.issued_on" },
  dimensions: [{ key: "month", label: "Month", sql: "x", type: "date" }],
  measures: [
    { key: "total", label: "Invoiced", kind: "sum", sql: "1", type: "money" },
    { key: "count", label: "Invoices", kind: "count", type: "number" },
  ],
};
const trend = (over: Partial<Tile>): Tile => ({
  key: "t", title: "Invoiced by month", kind: "trend", width: 12,
  definition: { dataset: "invoices", dimensions: ["month"], measures: ["total", "count"] },
  ...over,
});

describe("which tiles may draw a second measure", () => {
  it("takes one of the report's other measures", () => {
    expect(checkShape(trend({ secondMeasure: "count" }), INVOICES)).toEqual({ ok: true });
  });

  it("refuses one the report does not select, the same one twice, a number tile and a tile broken down", () => {
    const detail = (tile: Tile) => {
      const d = checkShape(tile, INVOICES);
      return d.ok ? "" : d.detail;
    };
    expect(detail(trend({ secondMeasure: "average" }))).toMatch(/draws "average" beside the first, which its report does not select/);
    expect(detail(trend({ secondMeasure: "total" }))).toMatch(/already draws "total"/);
    expect(detail(trend({ kind: "number", definition: { dataset: "invoices", dimensions: [], measures: ["total", "count"] }, secondMeasure: "count" })))
      .toMatch(/number tile shows one value, so it has no second measure/);
    expect(detail(trend({
      breakdown: "grouped", definition: { dataset: "invoices", dimensions: ["month", "month"], measures: ["total", "count"] }, secondMeasure: "count",
    }))).toMatch(/broken down, and a tile broken down cannot also draw a second measure/);
  });
});
