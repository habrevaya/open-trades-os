import { describe, it, expect } from "vitest";
import { costing as c, money as m } from "../src/index";

/**
 * Labour burden and overhead at the company's own dated rates. Each figure
 * below is worked by hand in the comment beside it.
 */
const usd = (v: string) => m.money(v, "USD");
const rates: c.CostingRate[] = [
  { component: "payroll_taxes", basis: "percent_of_wages", rate: "7.65", effectiveFrom: "2026-01-01" },
  { component: "workers_comp", basis: "percent_of_wages", rate: "4", effectiveFrom: "2026-01-01" },
  { component: "workers_comp", basis: "percent_of_wages", rate: "6", effectiveFrom: "2026-07-01" },
  { component: "benefits", basis: "per_hour", rate: "3.50", effectiveFrom: "2026-01-01" },
  { component: "overhead", basis: "per_hour", rate: "20", effectiveFrom: "2026-01-01" },
  { component: "overhead", basis: "percent_of_revenue", rate: "15", effectiveFrom: "2026-09-01" },
];

describe("labour burden", () => {
  it("charges each punch at the rates in effect on its own day", () => {
    // March, 2 hours at $30: wages 60, taxes 4.59, comp 2.40, benefits 7.00 = 13.99.
    const march = c.labourBurden([{ date: "2026-03-10", minutes: 120, baseRate: "30" }], rates);
    expect(m.toString(m.round(march))).toBe("13.9900");
    // August, same punch: comp is 6% now, 3.60, so 15.19.
    const august = c.labourBurden([{ date: "2026-08-10", minutes: 120, baseRate: "30" }], rates);
    expect(m.toString(m.round(august))).toBe("15.1900");
  });

  it("charges nothing before the first rate, and no percentage on an unpriced hour", () => {
    expect(m.isZero(c.labourBurden([{ date: "2025-12-31", minutes: 60, baseRate: "30" }], rates))).toBe(true);
    // No wage, so only the $3.50 an hour benefit applies.
    const unpriced = c.labourBurden([{ date: "2026-03-10", minutes: 60, baseRate: null }], rates);
    expect(m.toString(unpriced)).toBe("3.5000");
  });

  it("switches a component off with a zero rate from a date", () => {
    const off = [...rates, { component: "benefits", basis: "per_hour", rate: "0", effectiveFrom: "2026-05-01" } as c.CostingRate];
    const may = c.labourBurden([{ date: "2026-05-02", minutes: 60, baseRate: "0" }], off);
    expect(m.isZero(may)).toBe(true);
  });
});

describe("overhead", () => {
  it("follows the basis in effect on the job's day", () => {
    // By the hour until September: 3 hours at $20.
    expect(m.toString(c.overhead({ date: "2026-06-01", minutes: 180, revenue: usd("900") }, rates))).toBe("60.0000");
    // A share of revenue from September: 15% of 900.
    expect(m.toString(c.overhead({ date: "2026-09-02", minutes: 180, revenue: usd("900") }, rates))).toBe("135.0000");
    const perJob = [{ component: "overhead", basis: "per_job", rate: "85", effectiveFrom: "2026-01-01" } as c.CostingRate];
    expect(m.toString(c.overhead({ date: "2026-06-01", minutes: 0, revenue: usd("0") }, perJob))).toBe("85.0000");
  });

  it("charges a cancelled job nothing", () => {
    expect(m.isZero(c.overhead({ date: "2026-06-01", minutes: 180, revenue: usd("900"), cancelled: true }, rates))).toBe(true);
  });

  it("takes both off the direct margin for the fully loaded one", () => {
    expect(m.toString(c.fullyLoadedMargin(usd("400"), usd("13.99"), usd("60")))).toBe("326.0100");
  });

  it("prices an hour for the settings screen", () => {
    const hour = c.hourAt("30", "2026-03-10", rates);
    // 30 wage, 2.295 + 1.20 + 3.50 burden, 20 overhead.
    expect(m.toString(hour.burden)).toBe("6.9950");
    expect(m.toString(hour.total)).toBe("56.9950");
  });
});

describe("a rate somebody types", () => {
  it("is refused with the reason", () => {
    expect(c.checkRate({ component: "overhead", basis: "percent_of_wages", rate: "5", effectiveFrom: "2026-01-01" }).ok).toBe(false);
    expect(c.checkRate({ component: "workers_comp", basis: "per_job", rate: "5", effectiveFrom: "2026-01-01" }).ok).toBe(false);
    expect(c.checkRate({ component: "payroll_taxes", basis: "percent_of_wages", rate: "101", effectiveFrom: "2026-01-01" }).ok).toBe(false);
    expect(c.checkRate({ component: "payroll_taxes", basis: "percent_of_wages", rate: "-1", effectiveFrom: "2026-01-01" }).ok).toBe(false);
    expect(c.checkRate({ component: "payroll_taxes", basis: "percent_of_wages", rate: "7.65", effectiveFrom: "Jan 1" }).ok).toBe(false);
    expect(c.checkRate({ component: "payroll_taxes", basis: "percent_of_wages", rate: "7.65", effectiveFrom: "2026-01-01" }).ok).toBe(true);
  });
});

describe("what a journal line on a job does to the margin", () => {
  it("counts revenue, cost of goods sold and card fees, which costing already reads by job", () => {
    expect(c.journalCounts("4000")).toBe("revenue");
    expect(c.journalCounts("4100")).toBe("revenue");
    expect(c.journalCounts("4900")).toBe("revenue");
    expect(c.journalCounts("5000")).toBe("material");
    expect(c.journalCounts("6100")).toBe("fees");
  });

  it("leaves labour out, because the hours are counted from the clock, and commission, which is kept out of margin on purpose", () => {
    expect(c.journalCounts("5100")).toBeNull();
    expect(c.journalCounts("5200")).toBeNull();
    expect(c.journalCounts("5999")).toBeNull();
  });

  it("leaves out everything it does not read: expenses above the fees, assets and liabilities", () => {
    for (const code of ["1000", "2000", "6500", "6900", "7000"]) expect(c.journalCounts(code)).toBeNull();
  });

  it("reads the code as written, with the spaces a form leaves", () => {
    expect(c.journalCounts(" 5000 ")).toBe("material");
  });
});
