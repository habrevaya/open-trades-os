import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportChart, additivityFor, pointLabel } from "../src/components/ReportChart";
import { BranchFilter, chosenBranch } from "../src/components/BranchFilter";
import { describeDefinition } from "../src/lib/report-words";
import { definitionFrom, queryFor, rangeQuery } from "../src/lib/report-params";

/**
 * A REPORT, DRAWN
 *
 * The arithmetic is core's and tested there. What is here is that the
 * picture is really drawn from the rows, every shape opens its records, the
 * words beside it read as an owner would say them, and a report that cannot
 * be drawn says why rather than drawing something wrong.
 */
const byMonth = {
  columns: [
    { key: "month", label: "Month", type: "date", role: "dimension" as const },
    { key: "revenue", label: "Revenue", type: "money", role: "measure" as const },
  ],
  rows: [{ month: "2026-07", revenue: "1200.0000" }, { month: "2026-08", revenue: "950.5000" }],
  truncated: false,
};

const byStatus = {
  columns: [
    { key: "status", label: "Status", type: "status", role: "dimension" as const },
    { key: "count", label: "Jobs", type: "number", role: "measure" as const },
  ],
  rows: [{ status: "in_progress", count: 4 }, { status: "completed", count: 9 }],
  truncated: false,
};

const always = () => true;

describe("the chart over a report", () => {
  it("draws a dated report as a line with a linked point per month", () => {
    const html = renderToStaticMarkup(
      <ReportChart result={byMonth} additive={always} title="Revenue by month" drill={(row) => `/reports/drill?m=${String(row.month)}`} />,
    );
    expect(html).toContain("<svg");
    expect(html).toContain('aria-label="Revenue by month: Revenue by month, as a line"');
    expect(html).toContain("<path");
    expect(html).toContain('href="/reports/drill?m=2026-07"');
    expect(html).toContain("Aug 2026: $950.50");
  });

  it("draws columns over time when asked, and offers to switch back", () => {
    const html = renderToStaticMarkup(
      <ReportChart result={byMonth} additive={always} title="R" prefer="columns" toggle={(k) => `/r?chart=${k}`} />,
    );
    expect(html).toContain("as columns");
    expect(html).toContain('href="/r?chart=line"');
    expect(html).not.toContain("<path");
  });

  it("draws a category report as bars, in words an owner reads", () => {
    const html = renderToStaticMarkup(<ReportChart result={byStatus} additive={always} title="Jobs by status" />);
    expect(html).toContain("as bars");
    expect(html).toContain("In Progress");
    expect(html).toMatch(/class="fill-ink-700"/);
  });

  it("says why when there is nothing to compare", () => {
    const html = renderToStaticMarkup(<ReportChart
      result={{ columns: [byStatus.columns[1]!], rows: [{ count: 3 }], truncated: false }}
      additive={always} title="Total"
    />);
    expect(html).not.toContain("<svg");
    expect(html).toContain("No chart for this one");
  });

  it("adds up only what can be added up", () => {
    const additive = additivityFor({ measures: [{ key: "count", kind: "count" }, { key: "avg", kind: "avg" }] });
    expect(additive("count")).toBe(true);
    expect(additive("avg")).toBe(false);
    expect(additive("unknown")).toBe(false);
  });

  it("labels days, months, statuses and nothing", () => {
    const day = { key: "day", label: "Day", type: "date", role: "dimension" as const };
    expect(pointLabel(day, "2026-09-03")).toBe("Sep 3");
    expect(pointLabel(day, null)).toBe("Not set");
  });
});

describe("a branch on a report and a list", () => {
  it("rides in the address, and comes back out", () => {
    const definition = { dataset: "jobs", dimensions: ["status"], measures: ["count"], branchId: "b-1" };
    expect(definitionFrom(Object.fromEntries(new URLSearchParams(queryFor(definition))))).toEqual(definition);
    expect(rangeQuery({ from: "2026-01-01", branchId: "b-1" })).toBe("?from=2026-01-01&branch=b-1");
  });

  it("is said in words with the report's other conditions", () => {
    const words = describeDefinition({ dataset: "jobs", dimensions: [], measures: ["count"], branchId: "b-1" }, undefined, "UTC", "Houston");
    expect(words).toEqual(["Houston only"]);
  });

  const options = { branches: [{ id: "b-1", name: "Houston", code: null }], yours: null, narrowed: false };

  it("is offered to somebody who sees everything, and not to a branch manager", () => {
    expect(renderToStaticMarkup(<BranchFilter options={options} action="/jobs" current={undefined} />)).toContain("Houston");
    expect(renderToStaticMarkup(<BranchFilter options={{ ...options, narrowed: true }} action="/jobs" current={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<BranchFilter options={{ ...options, branches: [] }} action="/jobs" current={undefined} />)).toBe("");
  });

  it("only takes a branch from the address that it offers", () => {
    expect(chosenBranch(options, "b-1")).toBe("b-1");
    expect(chosenBranch(options, "someone-elses")).toBeUndefined();
    expect(chosenBranch(options, "none")).toBeUndefined();
    expect(chosenBranch(options, "none", true)).toBe("none");
    expect(chosenBranch({ ...options, narrowed: true }, "b-1")).toBeUndefined();
  });
});
