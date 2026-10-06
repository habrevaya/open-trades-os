import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { reporting } from "@opentradesos/core";
import { drillHref, pinsFrom, safeBack } from "../src/lib/drill";
import { definitionFrom } from "../src/lib/report-params";
import { scheduleFromForm } from "../src/lib/schedule-form";
import { ReportTable } from "../src/components/ReportTable";
import { DashboardTile } from "../src/components/DashboardTile";
import { ScheduleForm } from "../src/app/(app)/reports/schedules/ScheduleForm";

/**
 * EVERY NUMBER ON A REPORT OPENS ITS RECORDS
 *
 * The integration test proves the drilled records add up to the number. What
 * is here is the half that lives in the browser: the link carries the whole
 * definition and the row's values there and back without losing a filter, a
 * date, a null or a colon, and every report and tile draws one.
 */
const aging: reporting.ReportDefinition = {
  dataset: "invoices", dimensions: ["aging"], measures: ["balance", "count"],
  filters: [{ dimension: "status", op: "neq", value: "paid" }],
  from: "2026-01-01", to: "2026-10-01",
};

const params = (href: string) => {
  const query = new URLSearchParams(href.split("?")[1]);
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(query.keys())) {
    const all = query.getAll(key);
    out[key] = all.length > 1 ? all : all[0]!;
  }
  return out;
};

describe("the link to a row's records", () => {
  it("carries the report's filters, dates and the row's value there and back", () => {
    const href = drillHref(aging, { aging: "5 Over 90 days", balance: "410.0000", count: 2 },
      { title: "Receivables by age", back: "/reports/built-in/ar-aging?from=2026-01-01" });
    expect(href.startsWith("/reports/drill?")).toBe(true);
    const back = params(href);
    expect(definitionFrom(back)).toEqual({
      dataset: "invoices", dimensions: ["aging"], measures: ["balance", "count"],
      filters: [{ dimension: "status", op: "neq", value: "paid" }],
      from: "2026-01-01", to: "2026-10-01",
    });
    expect(pinsFrom(back)).toEqual({ aging: "5 Over 90 days" });
    expect(back["title"]).toBe("Receivables by age");
    expect(back["back"]).toBe("/reports/built-in/ar-aging?from=2026-01-01");
  });

  it("keeps a value with a colon in it whole, and a null as a null", () => {
    const definition = { ...aging, dimensions: ["customer", "month"] };
    const href = drillHref(definition, { customer: "Unit 4: Rear", month: null, balance: "1" },
      { title: "x", back: "/reports" });
    expect(pinsFrom(params(href))).toEqual({ customer: "Unit 4: Rear", month: null });
  });

  it("goes back only to a page on this site", () => {
    expect(safeBack("/reports/built-in/ar-aging")).toBe("/reports/built-in/ar-aging");
    expect(safeBack("https://evil.example/login")).toBe("/reports");
    expect(safeBack("//evil.example")).toBe("/reports");
    expect(safeBack("/\\evil.example")).toBe("/reports");
    expect(safeBack(undefined)).toBe("/reports");
  });
});

describe("a report draws a link on every number", () => {
  const result = {
    columns: [
      { key: "aging", label: "Age", type: "text", role: "dimension" as const, sortPrefix: true },
      { key: "balance", label: "Outstanding", type: "money", role: "measure" as const },
    ],
    rows: [{ aging: "1 Current", balance: "120.0000" }, { aging: "5 Over 90 days", balance: "410.0000" }],
    truncated: false,
  };

  it("describes each link by its row, so two links with the same number can be told apart", () => {
    const html = renderToStaticMarkup(
      <ReportTable result={result} timezone="America/Chicago" drill={(row) => `/reports/drill?pin=aging:${String(row["aging"])}`} />,
    );
    expect(html).toContain('href="/reports/drill?pin=aging:1 Current"');
    expect(html).toContain('title="Open the records behind Outstanding, Over 90 days"');
  });
});

describe("a dashboard tile opens the same way", () => {
  const base = {
    key: "aging", title: "Receivables by age", width: 6,
    measure: { key: "balance", label: "Outstanding", type: "money" },
    definition: { dataset: "invoices", dimensions: ["aging"], measures: ["balance"] },
  };

  it("links every bar", () => {
    const html = renderToStaticMarkup(<DashboardTile back="/dashboards/money" tile={{
      ...base, kind: "bars",
      dimension: { key: "aging", label: "Age", type: "text", sortPrefix: true },
      result: { ...{ columns: [], truncated: false }, rows: [{ aging: "2 1 to 30 days", balance: "50.0000" }] },
    }} />);
    expect(html).toMatch(/href="\/reports\/drill\?[^"]*pin=aging%3A2\+1\+to\+30\+days/);
    expect(html).toContain("back=%2Fdashboards%2Fmoney");
    /** Drawn by the report chart: the bar is named in its own title, and the sort prefix is off the words. */
    expect(html).toContain("<title>1 to 30 days: $50.00</title>");
  });

  it("links the one number on a number tile", () => {
    const html = renderToStaticMarkup(<DashboardTile back="/dashboards/money" tile={{
      ...base, kind: "number",
      definition: { dataset: "invoices", dimensions: [], measures: ["balance"] },
      result: { columns: [], truncated: false, rows: [{ balance: "460.0000" }] },
    }} />);
    expect(html).toContain('title="Open the records behind Receivables by age"');
    expect(html).toContain("$460.00");
  });

  it("draws no link for a tile with nothing to drill with", () => {
    const html = renderToStaticMarkup(<DashboardTile back="/dashboards/money" tile={{
      key: "x", title: "Broken", kind: "bars", width: 6, problem: "Not available on this dataset: x.",
    }} />);
    expect(html).not.toContain("/reports/drill");
  });
});

describe("the schedule form", () => {
  it("reads what was posted into a schedule, with addresses pasted as a list", () => {
    const form = new FormData();
    form.set("report", "builtIn:ar-aging");
    form.set("frequency", "weekly");
    form.append("weekdays", "1");
    form.append("weekdays", "4");
    form.set("dayOfMonth", "1");
    form.set("time", "07:00");
    form.set("period", "last_7_days");
    form.append("userIds", "11111111-1111-4111-8111-111111111111");
    form.set("addresses", "books@acct.test, Ann@Acct.test\nthird@acct.test");
    expect(scheduleFromForm(form)).toEqual({
      builtIn: "ar-aging", frequency: "weekly", weekdays: [1, 4], dayOfMonth: 1, time: "07:00",
      period: "last_7_days", userIds: ["11111111-1111-4111-8111-111111111111"],
      addresses: ["books@acct.test", "Ann@Acct.test", "third@acct.test"],
    });
    form.set("report", "saved:22222222-2222-4222-8222-222222222222");
    expect(scheduleFromForm(form).reportId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("offers every report, every person, and the time in the company's timezone", () => {
    const html = renderToStaticMarkup(
      <ScheduleForm
        action={async () => null} submit="Schedule it"
        reports={[{ value: "builtIn:ar-aging", label: "Receivables by age" }]}
        people={[{ userId: "u1", name: "Rosa Owner" }]}
        timezone="America/Chicago"
        defaults={{ report: "builtIn:ar-aging", userIds: ["u1"] }}
      />,
    );
    for (const text of ["Receivables by age", "Rosa Owner", "Time (America/Chicago)", "Day of the month, 1 to 28",
      "The seven days before", "Anybody outside the company"]) {
      expect(html).toContain(text);
    }
  });
});
