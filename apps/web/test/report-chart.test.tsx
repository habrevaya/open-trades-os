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

/* ============================================ a chart cut by a second grouping */

const byTechnicianAndStatus = {
  columns: [
    { key: "technician", label: "Technician", type: "text", role: "dimension" as const },
    { key: "status", label: "Status", type: "status", role: "dimension" as const },
    { key: "count", label: "Jobs", type: "number", role: "measure" as const },
  ],
  rows: [
    { technician: "Sam", status: "completed", count: 2 },
    { technician: "Sam", status: "in_progress", count: 1 },
    { technician: "Ana", status: "completed", count: 4 },
  ],
  truncated: false,
};

describe("a chart cut by a second grouping", () => {
  const pinned: string[][] = [];
  const draw = (extra: Partial<React.ComponentProps<typeof ReportChart>> = {}) => renderToStaticMarkup(
    <ReportChart
      result={byTechnicianAndStatus} additive={always} title="Jobs" split="status"
      drill={(row, pin) => { pinned.push(pin); return `/d?t=${String(row.technician)}&s=${String(row.status)}&pin=${pin.join(",")}`; }}
      {...extra}
    />,
  );

  it("stacks a bar for each group out of its parts, each part named and opening its own records", () => {
    const html = draw();
    expect(html).toContain("as stacked bars");
    expect(html).toContain("Jobs by technician and status");
    expect(html).toContain("<title>Sam, Completed: 2</title>");
    expect(html).toContain("<title>Ana, Completed: 4</title>");
    // The part pins both groupings, so it opens the records of that technician in that status.
    expect(html).toContain('href="/d?t=Ana&amp;s=completed&amp;pin=technician,status"');
    // The group's own label pins only the group, which is every status.
    expect(html).toContain('href="/d?t=Sam&amp;s=completed&amp;pin=technician"');
    expect(html).toMatch(/class="fill-ink-700 stroke-canvas"/);
    expect(html).toMatch(/class="fill-blue-600 stroke-canvas"/);
  });

  it("names every colour in words in a legend, so a colour is never the only thing that says which is which", () => {
    const html = draw();
    expect(html).toContain('aria-label="Status, by colour"');
    expect(html).toContain("Completed");
    expect(html).toContain("In Progress");
  });

  it("sets them side by side when asked, and says so", () => {
    const html = draw({ arrange: "grouped" });
    expect(html).toContain("as side by side bars");
  });

  it("offers each other grouping to break down by, and a way back to adding it up", () => {
    const html = draw({ splitHref: (d) => `/r?split=${d ?? ""}`, arrangeHref: (a) => `/r?arrange=${a}` });
    expect(html).toContain("Break down by");
    expect(html).toContain('href="/r?split="');
    expect(html).toContain("Not broken down");
    expect(html).toContain('href="/r?arrange=grouped"');
    // It is already stacked, so stacked is not a link.
    expect(html).not.toContain('href="/r?arrange=stacked"');
  });

  it("offers a report that is not cut the groupings it could be cut by", () => {
    const html = renderToStaticMarkup(
      <ReportChart result={byTechnicianAndStatus} additive={always} title="Jobs" splitHref={(d) => `/r?split=${d ?? ""}`} />,
    );
    expect(html).toContain("Added up over status");
    expect(html).toContain('href="/r?split=status"');
    expect(html).not.toContain('href="/r?split="');
  });

  it("will not stack an average, says why, and offers side by side", () => {
    const html = renderToStaticMarkup(
      <ReportChart
        result={{
          ...byTechnicianAndStatus,
          columns: [...byTechnicianAndStatus.columns.slice(0, 2), { key: "avg", label: "Average ticket", type: "money", role: "measure" as const }],
          rows: [{ technician: "Sam", status: "completed", avg: "100.0000" }],
        }}
        additive={() => false} title="Tickets" split="status" splitHref={(d) => `/r?split=${d ?? ""}`}
        arrangeHref={(a) => `/r?arrange=${a}`}
      />,
    );
    expect(html).toContain("No chart for this one");
    expect(html).toContain("cannot be stacked");
    expect(html).toContain('href="/r?arrange=grouped"');
  });

  it("can be read as a table, a column for each value and a total", () => {
    const html = draw({ withTable: true });
    expect(html).toContain("View as a table");
    expect(html).toContain("Jobs by technician and status, as a table");
    expect(html).toMatch(/<th[^>]*>Completed<\/th>/);
    expect(html).toMatch(/<th[^>]*>Total<\/th>/);
    expect(html).toMatch(/<th[^>]*>Ana<\/th><td[^>]*>4<\/td><td[^>]*><\/td><td[^>]*>4<\/td>/);
  });

  it("draws a dated report cut by a second grouping as stacked columns, and a line for each value side by side", () => {
    const dated = {
      columns: [
        { key: "month", label: "Month", type: "date", role: "dimension" as const },
        { key: "status", label: "Status", type: "status", role: "dimension" as const },
        { key: "count", label: "Jobs", type: "number", role: "measure" as const },
      ],
      rows: [
        { month: "2026-07", status: "completed", count: 2 }, { month: "2026-07", status: "open", count: 1 },
        { month: "2026-08", status: "completed", count: 5 },
      ],
      truncated: false,
    };
    const stacked = renderToStaticMarkup(<ReportChart result={dated} additive={always} title="Jobs" split="status" />);
    expect(stacked).toContain("as stacked columns");
    expect(stacked).not.toContain("<path");
    const lines = renderToStaticMarkup(<ReportChart result={dated} additive={always} title="Jobs" split="status" arrange="grouped" />);
    expect(lines).toContain("as a line for each value");
    expect(lines.match(/<path/g)).toHaveLength(2);
    expect(lines).toMatch(/class="stroke-blue-600"|stroke-blue-600/);
  });

  it("says when values of the second grouping were added together, and opens nothing for the rolled up one", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ technician: "Sam", status: `s${i}`, count: 100 - i }));
    const html = renderToStaticMarkup(
      <ReportChart result={{ ...byTechnicianAndStatus, rows }} additive={always} title="Jobs" split="status" drill={() => "/d"} />,
    );
    expect(html).toContain("Everything else");
    expect(html).toContain("Only the 5 biggest status values are told apart");
    expect(html).toContain("fill-steel-400");
  });
});
