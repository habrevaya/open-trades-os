import { describe, it, expect } from "vitest";
import {
  resolveDrill, matchFor, drillTotals, sumDecimals, normalizeDecimal, compareDecimals, sameAt, roundDecimal,
  checkCadence, nextDelivery, describeCadence, periodFor, deliveryDay, statementMonth, defaultPeriod,
  toCsv, csvValue,
  type Dataset, type ReportDefinition,
} from "../src/reporting/index.js";
import type { Permission } from "../src/access/permissions.js";

/**
 * Drill through, the delivery cadence and the CSV, without a database.
 *
 * The integration test runs every built-in report and its drill against
 * Postgres and checks the drilled rows add up to the clicked number. What is
 * here is the arithmetic that check relies on, and the decisions a drill makes
 * before any SQL exists.
 */

const INVOICES: Dataset = {
  key: "invoices",
  label: "Invoices",
  description: "",
  from: "public.invoice",
  permission: "report.financial:read" as Permission,
  scope: "invoice",
  dateColumn: "invoice.issued_on",
  dimensions: [
    { key: "status", label: "Status", sql: "invoice.status::text", type: "status" },
    { key: "customer", label: "Customer", sql: "c.name", type: "text" },
    { key: "cost_bucket", label: "Cost", sql: "x", type: "text", permission: "job.cost:read" as Permission },
  ],
  measures: [
    { key: "count", label: "Invoices", kind: "count", type: "number" },
    { key: "total", label: "Invoiced", kind: "sum", sql: "invoice.total", type: "money" },
    { key: "average", label: "Average", kind: "avg", sql: "invoice.total", type: "money" },
  ],
  records: {
    noun: "invoice", plural: "invoices", id: "invoice.id", label: "invoice.number::text",
    href: "/invoices/{id}", columns: [], orderBy: "invoice.issued_on",
  },
};

const OWNER = new Set<Permission>(["report.financial:read", "job.cost:read"] as Permission[]);
const DISPATCHER = new Set<Permission>(["job:read"] as Permission[]);

const byCustomer: ReportDefinition = {
  dataset: "invoices", dimensions: ["status", "customer"], measures: ["total", "count"],
  filters: [{ dimension: "status", op: "neq", value: "paid" }],
  from: "2026-01-01", to: "2026-02-01",
};

describe("which records a row is about", () => {
  it("pins every grouped dimension to the value on the row", () => {
    const decision = resolveDrill(
      { definition: byCustomer, match: { status: "open", customer: "Rita" } },
      [INVOICES], OWNER,
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.pinned.map((p) => [p.dimension.key, p.value])).toEqual([
      ["status", "open"], ["customer", "Rita"],
    ]);
    expect(decision.record.href).toBe("/invoices/{id}");
  });

  it("keeps a null as a null, so a group called Not set opens the records with nothing in them", () => {
    const decision = resolveDrill(
      { definition: byCustomer, match: { status: "open", customer: null } },
      [INVOICES], OWNER,
    );
    expect(decision.ok && decision.pinned[1]!.value).toBeNull();
  });

  it("refuses to pin a dimension the report does not group by", () => {
    // That would describe records the report never counted, and the totals
    // at the bottom of the list would be a number nobody clicked.
    const decision = resolveDrill(
      { definition: { ...byCustomer, dimensions: ["status"] }, match: { customer: "Rita" } },
      [INVOICES], OWNER,
    );
    expect(decision).toMatchObject({ ok: false, reason: "unknown_field" });
  });

  it("is refused exactly where the report would be", () => {
    const decision = resolveDrill({ definition: byCustomer, match: {} }, [INVOICES], DISPATCHER);
    expect(decision).toMatchObject({ ok: false, reason: "missing_permission" });
  });

  it("reads the match off a row, including a prefix that only exists to sort", () => {
    expect(matchFor({ ...byCustomer, dimensions: ["status"] }, { status: "5 Over 90 days", total: "10" }))
      .toEqual({ status: "5 Over 90 days" });
    expect(matchFor(byCustomer, { status: "open", customer: null })).toEqual({ status: "open", customer: null });
  });
});

describe("adding up the records, exactly", () => {
  it("adds at the precision that arrived rather than rounding each record first", () => {
    // Three thirds of 140 at twenty places. Rounded to four places each and
    // then added, these come to 140.0001, which is a report that disagrees
    // with its own drill by a hundredth of a cent and a test that cannot say
    // which is right.
    const third = "46.66666666666666666667";
    const third2 = "46.66666666666666666666";
    expect(sumDecimals([third, third, third2])).toBe("140");
  });

  it("treats two spellings of one number as one number", () => {
    expect(normalizeDecimal("550.0000")).toBe("550");
    expect(normalizeDecimal("-0.5000")).toBe("-0.5");
    expect(normalizeDecimal(3)).toBe("3");
    expect(compareDecimals("9.0000", "1000")).toBe(-1);
    expect(compareDecimals("-2", "-10.5")).toBe(1);
  });

  it("rounds half up when an average is compared", () => {
    expect(roundDecimal("2.345", 2)).toBe("2.35");
    expect(roundDecimal("-2.345", 2)).toBe("-2.35");
    expect(sameAt("333.333333333333", "333.3333", 2)).toBe(true);
  });

  it("totals each measure the way the database aggregates it", () => {
    const rows = [
      { count: 1, total: "100.0000", average: "100.0000" },
      { count: 1, total: "50.5000", average: "50.5000" },
      { count: 1, total: null, average: null },
    ];
    const totals = drillTotals(
      [{ key: "count", kind: "count" }, { key: "total", kind: "sum" }, { key: "average", kind: "avg" }],
      rows,
    );
    expect(totals).toEqual({ count: "3", total: "150.5", average: "75.25" });
  });

  it("says nothing to measure rather than zero for an average over no records", () => {
    const totals = drillTotals(
      [{ key: "total", kind: "sum" }, { key: "average", kind: "avg" }, { key: "lo", kind: "min" }],
      [],
    );
    expect(totals).toEqual({ total: "0", average: null, lo: null });
  });

  it("finds the smallest and largest exactly", () => {
    const totals = drillTotals(
      [{ key: "a", kind: "min" }, { key: "b", kind: "max" }],
      [{ a: "9.5", b: "9.5" }, { a: "1000", b: "1000" }, { a: "-3", b: "-3" }],
    );
    expect(totals).toEqual({ a: "-3", b: "1000" });
  });
});

describe("when a report arrives", () => {
  it("refuses a weekly cadence with no day, rather than saving one that never fires", () => {
    expect(checkCadence({ frequency: "weekly", weekdays: [], time: "07:00" }))
      .toMatchObject({ ok: false });
  });

  it("refuses a monthly day that does not exist in every month", () => {
    const check = checkCadence({ frequency: "monthly", dayOfMonth: 31, time: "07:00" });
    expect(check).toMatchObject({ ok: false });
    expect(!check.ok && check.reason).toMatch(/1 to 28/);
  });

  it("refuses a time nobody can read", () => {
    expect(checkCadence({ frequency: "daily", time: "7am" })).toMatchObject({ ok: false });
    expect(checkCadence({ frequency: "daily", time: "24:00" })).toMatchObject({ ok: false });
  });

  it("fires at the wall time in the company's timezone, not the server's", () => {
    const check = checkCadence({ frequency: "daily", time: "07:00" });
    if (!check.ok) throw new Error(check.reason);
    // Six in the morning in Chicago is eleven UTC in summer.
    const next = nextDelivery(check.cadence, new Date("2026-07-01T11:00:00Z"), "America/Chicago");
    expect(next?.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });

  it("fires on the days of the week it was given, Sunday included", () => {
    const check = checkCadence({ frequency: "weekly", weekdays: [7, 1], time: "07:00" });
    if (!check.ok) throw new Error(check.reason);
    // Wednesday 1 July 2026. The next is Sunday the 5th, then Monday the 6th.
    const first = nextDelivery(check.cadence, new Date("2026-07-01T15:00:00Z"), "America/Chicago")!;
    expect(deliveryDay(first, "America/Chicago")).toBe("2026-07-05");
    const second = nextDelivery(check.cadence, first, "America/Chicago")!;
    expect(deliveryDay(second, "America/Chicago")).toBe("2026-07-06");
  });

  it("fires on the day of the month it was given", () => {
    const check = checkCadence({ frequency: "monthly", dayOfMonth: 1, time: "06:30" });
    if (!check.ok) throw new Error(check.reason);
    const next = nextDelivery(check.cadence, new Date("2026-09-15T12:00:00Z"), "America/Chicago")!;
    expect(deliveryDay(next, "America/Chicago")).toBe("2026-10-01");
  });

  it("reads back as a sentence", () => {
    expect(describeCadence({ frequency: "daily", time: "07:00" })).toBe("Every day at 7:00 AM");
    expect(describeCadence({ frequency: "weekly", weekdays: [1, 4], time: "17:30" }))
      .toBe("Every Monday and Thursday at 5:30 PM");
    expect(describeCadence({ frequency: "weekly", weekdays: [1, 2, 3, 4, 5], time: "00:15" }))
      .toBe("Every weekday at 12:15 AM");
    expect(describeCadence({ frequency: "monthly", dayOfMonth: 2, time: "12:00" }))
      .toBe("On the 2nd of every month at 12:00 PM");
  });
});

describe("which days a delivered report covers", () => {
  const at = new Date("2026-10-01T12:00:00Z");

  it("ends before the day it is delivered", () => {
    expect(periodFor("yesterday", at, "America/Chicago")).toMatchObject({ from: "2026-09-30", to: "2026-10-01" });
    expect(periodFor("last_7_days", at, "America/Chicago")).toMatchObject({ from: "2026-09-24", to: "2026-10-01" });
  });

  it("takes last month as a calendar month, across a year end", () => {
    expect(periodFor("last_month", at, "America/Chicago"))
      .toMatchObject({ from: "2026-09-01", to: "2026-10-01", label: "Sep 1, 2026 to Sep 30, 2026" });
    expect(periodFor("last_month", new Date("2027-01-03T12:00:00Z"), "America/Chicago"))
      .toMatchObject({ from: "2026-12-01", to: "2027-01-01" });
  });

  it("uses the company's calendar day, not UTC's", () => {
    // Two in the morning UTC on the 1st is still the 30th in Chicago.
    const late = new Date("2026-10-01T02:00:00Z");
    expect(periodFor("yesterday", late, "America/Chicago")).toMatchObject({ from: "2026-09-29", to: "2026-09-30" });
  });

  it("starts each frequency on the period it usually wants", () => {
    expect(defaultPeriod("daily")).toBe("yesterday");
    expect(defaultPeriod("weekly")).toBe("last_7_days");
    expect(defaultPeriod("monthly")).toBe("last_month");
  });

  it("puts a statement run on the month before, with the last day included", () => {
    expect(statementMonth(at, "America/Chicago")).toEqual({ key: "2026-09", from: "2026-09-01", to: "2026-09-30" });
    expect(statementMonth(new Date("2027-01-15T12:00:00Z"), "America/Chicago"))
      .toEqual({ key: "2026-12", from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("the CSV an accountant opens", () => {
  const columns = [
    { key: "customer", label: "Customer", type: "text" },
    { key: "aging", label: "Age", type: "text", sortPrefix: true },
    { key: "balance", label: "Outstanding", type: "money" },
  ];

  it("keeps money a plain decimal and quotes what needs quoting", () => {
    const csv = toCsv(columns, [
      { customer: "Smith, Jones & Co", aging: "5 Over 90 days", balance: "1240.5000" },
      { customer: "Said \"hi\"", aging: "1 Current", balance: "-12.0000" },
    ]);
    expect(csv).toBe(
      "Customer,Age,Outstanding\r\n"
      + "\"Smith, Jones & Co\",Over 90 days,1240.5000\r\n"
      + "\"Said \"\"hi\"\"\",Current,-12.0000\r\n",
    );
  });

  it("never lets a customer's name become a formula", () => {
    expect(csvValue(columns[0]!, "=HYPERLINK(\"x\")")).toBe("'=HYPERLINK(\"x\")");
    expect(csvValue(columns[0]!, "@SUM(A1)")).toBe("'@SUM(A1)");
    // A negative number is a number, and stays one.
    expect(csvValue(columns[2]!, "-5.0000")).toBe("-5.0000");
    expect(csvValue(columns[0]!, null)).toBe("");
  });

  it("writes a status in the screen's words rather than the database's", () => {
    expect(csvValue({ key: "status", label: "Status", type: "status" }, "in_progress")).toBe("In Progress");
  });
});
