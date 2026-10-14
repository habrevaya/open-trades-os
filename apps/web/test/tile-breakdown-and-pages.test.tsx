import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardTile } from "../src/components/DashboardTile";
import { Pager } from "../src/components/Pager";
import { pageHref } from "../src/lib/drill";

/**
 * A TILE BROKEN DOWN, AND THE PAGES OF A LONG DRILL
 *
 * The chart's arithmetic is core's and tested there, and the service's
 * refusals are tested against a database. What is here is the screen: that a
 * tile broken down really is drawn cut by its second grouping, with the words
 * for each colour, and that each part opens the records of both groupings
 * together; and that the pages of a drill say which records these are and keep
 * everything else about the address as it was.
 */
const tile = {
  key: "visits", title: "Visits by technician", kind: "bars" as const, width: 6,
  measure: { key: "count", label: "Visits", type: "number" },
  dimension: { key: "technician", label: "Technician", type: "text" },
  definition: { dataset: "visits", dimensions: ["technician", "status"], measures: ["count"] },
  result: {
    columns: [], truncated: false,
    rows: [
      { technician: "Ann Able", status: "completed", count: 4 },
      { technician: "Ann Able", status: "scheduled", count: 2 },
      { technician: "Ben Baker", status: "completed", count: 3 },
    ],
  },
};

describe("a tile broken down by its report's second grouping", () => {
  it("is drawn stacked, with a word for every colour and a part that opens both groupings", () => {
    const html = renderToStaticMarkup(<DashboardTile back="/dashboards/saved/x" tile={{
      ...tile, additive: true,
      breakdown: { key: "status", label: "Status", type: "status", arrange: "stacked" },
    }} />);
    expect(html).toContain("Visits by technician and status, as stacked bars");
    expect(html).toContain('aria-label="Status, by colour"');
    expect(html).toContain("Ann Able, Scheduled: 2");
    // A part pins the technician and the status; Ann's bar adds up to six.
    expect(html).toMatch(/href="\/reports\/drill\?[^"]*pin=technician%3AAnn\+Able&amp;pin=status%3Ascheduled/);
    expect(html).toContain("<title>Ann Able: 6</title>");
  });

  it("is drawn side by side, which an average allows and a stack does not", () => {
    const grouped = renderToStaticMarkup(<DashboardTile back="/dashboards/saved/x" tile={{
      ...tile, additive: false,
      breakdown: { key: "status", label: "Status", type: "status", arrange: "grouped" },
    }} />);
    expect(grouped).toContain("as side by side bars");

    // A stacked tile the service would have refused at save says why rather than drawing a sum of averages.
    const stacked = renderToStaticMarkup(<DashboardTile back="/dashboards/saved/x" tile={{
      ...tile, additive: false,
      breakdown: { key: "status", label: "Status", type: "status", arrange: "stacked" },
    }} />);
    expect(stacked).toContain("cannot be stacked");
  });

  it("reads as a table with a column for each value and a total", () => {
    const html = renderToStaticMarkup(<DashboardTile back="/dashboards/saved/x" tile={{
      ...tile, additive: true,
      breakdown: { key: "status", label: "Status", type: "status", arrange: "stacked" },
    }} />);
    expect(html).toContain("View as a table");
    expect(html).toMatch(/<th scope="col"[^>]*>Total<\/th>/);
  });
});

describe("the pages of a long list of records", () => {
  const href = (page: number) => `/reports/drill?page=${page}`;

  it("says which records these are of how many, and that the totals are for all of them", () => {
    const html = renderToStaticMarkup(<Pager page={2} pages={3} perPage={1000} count={2005} noun="invoices" href={href} />);
    expect(html).toContain("1,001 to 2,000 of 2,005 invoices. The totals are for all 2,005.");
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain('href="/reports/drill?page=1"');
    expect(html).toContain('href="/reports/drill?page=3"');
  });

  it("offers no page before the first or after the last, and nothing at all for one page", () => {
    const last = renderToStaticMarkup(<Pager page={3} pages={3} perPage={1000} count={2005} noun="invoices" href={href} />);
    expect(last).toContain("2,001 to 2,005 of 2,005");
    expect(last).not.toContain("page=4");
    expect(renderToStaticMarkup(<Pager page={1} pages={1} perPage={1000} count={12} noun="jobs" href={href} />)).toBe("");
  });

  it("keeps the report, the pins and the way back, and changes only the page", () => {
    const params = { dataset: "tasks", pin: ["queue:Parts", "status"], back: "/reports", page: "2" };
    expect(pageHref("/reports/drill", params, 3))
      .toBe("/reports/drill?dataset=tasks&pin=queue%3AParts&pin=status&back=%2Freports&page=3");
    // The first page is the address a number opens: no page at all.
    expect(pageHref("/reports/drill", params, 1)).toBe("/reports/drill?dataset=tasks&pin=queue%3AParts&pin=status&back=%2Freports");
  });
});
