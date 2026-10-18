import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { pdf, reporting, dashboard } from "../src/index";
import type { Dataset } from "../src/reporting/index.js";
import type { Permission } from "../src/access/permissions.js";

/**
 * A WHOLE DASHBOARD AS ONE PDF
 *
 * Read back through `inspectPdf`, so "the tile is on the page" means its words
 * were drawn, and "the tile is left out" means its title is named and nothing
 * of it was drawn.
 */

const AT = new Date("2026-10-18T12:00:00Z");
const inflate = (bytes: Uint8Array) => new Uint8Array(inflateSync(bytes));

const byStatus = {
  columns: [
    { key: "job_type", label: "Job type", type: "text", role: "dimension" as const },
    { key: "status", label: "Status", type: "status", role: "dimension" as const },
    { key: "count", label: "Jobs", type: "number", role: "measure" as const },
  ],
  rows: [
    { job_type: "Install", status: "scheduled", count: 4 },
    { job_type: "Install", status: "on_hold", count: 1 },
    { job_type: "Repair", status: "scheduled", count: 2 },
  ],
};

describe("a dashboard printed as one file", () => {
  it("draws every tile in order, a number as its number and a breakdown with a legend in words", () => {
    const cut = reporting.chartFor(byStatus, { split: "status", arrange: "stacked", additive: () => true });
    expect(cut.ok).toBe(true);
    const plan = cut.ok ? cut.plan : null;
    const read = pdf.inspectPdf(pdf.dashboardPdf({
      company: { name: "Lone Star Air", color: "#1F6FEB" },
      name: "Operations",
      description: "What the shop is doing right now.",
      asOf: "October 18, 2026 at 7:00 AM",
      ranAs: "Olive Owner",
      tiles: [
        { title: "Open jobs", caption: "Everything not finished.", figure: "7" },
        { title: "Open tasks", figure: "3" },
        { title: "Open jobs by type", chart: plan, table: byStatus },
        { title: "A broken tile", note: "A trend needs a date to run along." },
      ],
      leftOut: [],
      generatedAt: AT,
    }), inflate);

    expect(read.problems).toEqual([]);
    expect(read.title).toContain("Operations");
    for (const words of [
      "Open jobs", "Everything not finished.", "Open tasks", "Open jobs by type", "Olive Owner",
      "A trend needs a date to run along.",
      // The legend names each colour: the statuses, as words.
      "Scheduled", "On Hold",
      // The table under the chart has the exact values.
      "Install", "Repair",
    ]) {
      expect(read.text).toContain(words);
    }
    // In the dashboard's own order.
    expect(read.text.indexOf("Open jobs by type")).toBeLessThan(read.text.indexOf("A broken tile"));
    expect(read.text).not.toContain("Not on this copy");
  });

  it("names the tiles left out, and draws nothing of them", () => {
    const read = pdf.inspectPdf(pdf.dashboardPdf({
      company: { name: "Lone Star Air", color: null },
      name: "Money", asOf: "October 18, 2026", ranAs: "Dee Dispatch",
      tiles: [],
      leftOut: ["Outstanding", "Who owes us"],
      generatedAt: AT,
    }), inflate);
    expect(read.problems).toEqual([]);
    expect(read.text).toContain("There is nothing on this dashboard you may see.");
    expect(read.text).toContain("Not on this copy");
    expect(read.text).toContain("Outstanding, Who owes us");
    expect(read.text).toContain("Dee Dispatch may not see them");
  });
});

describe("which tiles a reader may not see", () => {
  const jobs: Dataset = {
    key: "jobs", label: "Jobs", description: "", from: "public.job", permission: "job:read" as Permission,
    scope: "job", dateColumn: "job.created_at",
    records: { noun: "job", plural: "jobs", id: "job.id", label: "job.number::text", href: "/jobs/{id}", columns: [], orderBy: "job.created_at" },
    dimensions: [], measures: [{ key: "count", label: "Jobs", kind: "count", type: "number" }],
  };
  const invoices: Dataset = { ...jobs, key: "invoices", label: "Invoices", permission: "report.financial:read" as Permission };

  it("lists the tiles dropped for want of a permission, in order, and none that is merely broken", () => {
    const decision = dashboard.resolveDashboard({
      key: "d", title: "D", description: "",
      tiles: [
        { key: "a", title: "Money one", kind: "number", width: 3, definition: { dataset: "invoices", dimensions: [], measures: ["count"] } },
        { key: "b", title: "Jobs", kind: "number", width: 3, definition: { dataset: "jobs", dimensions: [], measures: ["count"] } },
        { key: "c", title: "Gone", kind: "number", width: 3, definition: { dataset: "nothing", dimensions: [], measures: ["count"] } },
        { key: "d", title: "Money two", kind: "number", width: 3, definition: { dataset: "invoices", dimensions: [], measures: ["count"] } },
      ],
    }, [jobs, invoices], new Set<Permission>(["job:read"] as Permission[]));
    expect(decision.hidden.map((t) => t.title)).toEqual(["Money one", "Money two"]);
    expect(decision.tiles.map((t) => t.tile.title)).toEqual(["Jobs", "Gone"]);
  });
});
