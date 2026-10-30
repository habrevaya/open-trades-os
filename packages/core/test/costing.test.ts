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

describe("overhead as a mix", () => {
  const mix: c.CostingRate[] = [
    { component: "overhead", basis: "per_hour", rate: "20", effectiveFrom: "2026-01-01" },
    { component: "overhead", basis: "per_hour", rate: "12", effectiveFrom: "2026-07-01" },
    { component: "overhead", basis: "per_job", rate: "25", effectiveFrom: "2026-07-01" },
    { component: "overhead", basis: "percent_of_revenue", rate: "3", effectiveFrom: "2026-07-01" },
  ];

  it("charges every part set on the latest day, each reported on its own", () => {
    // August, 3 hours and $900: 36.00 by the hour, 25.00 for the job, 27.00 of revenue.
    const parts = c.overheadParts({ date: "2026-08-04", minutes: 180, revenue: usd("900") }, mix);
    expect(m.toString(parts.perHour)).toBe("36.0000");
    expect(m.toString(parts.perJob)).toBe("25.0000");
    expect(m.toString(parts.revenueShare)).toBe("27.0000");
    expect(m.toString(parts.total)).toBe("88.0000");
    expect(m.toString(c.overhead({ date: "2026-08-04", minutes: 180, revenue: usd("900") }, mix))).toBe("88.0000");
  });

  it("replaces the whole mix on a new day rather than adding to the parts before it", () => {
    // June is the January mix: only $20 an hour.
    const june = c.overheadParts({ date: "2026-06-30", minutes: 180, revenue: usd("900") }, mix);
    expect(m.toString(june.total)).toBe("60.0000");
    expect(m.isZero(june.perJob)).toBe(true);
    // A single later part ends the mix: from October only the share of revenue.
    const later = [...mix, { component: "overhead", basis: "percent_of_revenue", rate: "10", effectiveFrom: "2026-10-01" } as c.CostingRate];
    const october = c.overheadParts({ date: "2026-10-02", minutes: 180, revenue: usd("900") }, later);
    expect(m.toString(october.total)).toBe("90.0000");
    expect(c.overheadMixOn(later, "2026-10-02")).toHaveLength(1);
  });

  it("charges a cancelled job none of it", () => {
    expect(m.isZero(c.overheadParts({ date: "2026-08-04", minutes: 180, revenue: usd("900"), cancelled: true }, mix).total)).toBe(true);
  });

  it("prices an hour with only the per hour part", () => {
    expect(m.toString(c.hourAt("30", "2026-08-04", mix).overhead)).toBe("12.0000");
  });

  it("checks the settings form: at least one part, each a rate, a share no more than 100", () => {
    const ok = c.checkOverheadMix({ perHour: "12", perJob: "", percentOfRevenue: "3", effectiveFrom: "2026-07-01" });
    expect(ok).toEqual({ ok: true, parts: [{ basis: "per_hour", rate: "12" }, { basis: "percent_of_revenue", rate: "3" }] });
    const none = c.checkOverheadMix({ effectiveFrom: "2026-07-01" });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toContain("at least one");
    const share = c.checkOverheadMix({ percentOfRevenue: "120", effectiveFrom: "2026-07-01" });
    expect(share).toMatchObject({ ok: false, field: "percentOfRevenue" });
    expect(c.checkOverheadMix({ perJob: "abc", effectiveFrom: "2026-07-01" })).toMatchObject({ ok: false, field: "perJob" });
    expect(c.checkOverheadMix({ perJob: "0", effectiveFrom: "2026-07-01" }).ok).toBe(true);
  });
});

describe("a cost that may be counted twice", () => {
  const pair = (over: Partial<c.DoubleCountCandidate>): c.DoubleCountCandidate => ({
    lineCost: "480", journalAmount: "480.00", daysApart: 4, sameVendor: null, ...over,
  });

  it("is the same amount to the cent, with dates close or a vendor on both", () => {
    expect(c.possibleDoubleCount(pair({}))).toBe(true);
    expect(c.possibleDoubleCount(pair({ daysApart: -30 }))).toBe(true);
    expect(c.possibleDoubleCount(pair({ daysApart: 31 }))).toBe(false);
    expect(c.possibleDoubleCount(pair({ daysApart: 200, sameVendor: "Ferguson" }))).toBe(true);
    expect(c.possibleDoubleCount(pair({ journalAmount: "480.01" }))).toBe(false);
    expect(c.possibleDoubleCount(pair({ lineCost: "479.999" }))).toBe(true);
  });

  it("never flags nothing against nothing", () => {
    expect(c.possibleDoubleCount(pair({ lineCost: "0", journalAmount: "0" }))).toBe(false);
  });

  it("says why in a sentence", () => {
    expect(c.doubleCountReason({ daysApart: 0, sameVendor: null })).toBe("Same amount, on the same day.");
    expect(c.doubleCountReason({ daysApart: -1, sameVendor: null })).toBe("Same amount, 1 day apart.");
    expect(c.doubleCountReason({ daysApart: 12, sameVendor: "Ferguson" })).toBe("Same amount, and both name Ferguson (12 days apart).");
  });
});
