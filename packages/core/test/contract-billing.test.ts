import { describe, it, expect } from "vitest";
import { contractBilling as cb, money as m } from "../src/index";

/**
 * A CONTRACT BILLED ON A SCHEDULE
 *
 * Which periods a fixed fee contract owes, on which day each is billed, and
 * what a part period at either end costs. The failures worth a test are the
 * ones that cost a client money or the company money: a period billed twice
 * because two periods overlap, a part month charged as a whole one when the
 * contract says prorate, and a prorated amount a cent out.
 */
const usd = (v: string) => m.money(v, "USD");

const monthly = (over: Partial<cb.Schedule> = {}): cb.Schedule => ({
  amount: usd("1200.00"), frequency: "monthly", billingDay: 1, startsOn: "2027-01-01",
  endsOn: null, prorate: false, ...over,
});

const plain = (periods: cb.Period[]) => periods.map((p) => [p.start, p.end, p.billOn, m.toString(p.amount), p.prorated]);

describe("the periods a schedule owes", () => {
  it("bills each month on its billing day, in advance, for the month that starts that day", () => {
    expect(plain(cb.periodsThrough(monthly(), "2027-03-01"))).toEqual([
      ["2027-01-01", "2027-01-31", "2027-01-01", "1200.0000", false],
      ["2027-02-01", "2027-02-28", "2027-02-01", "1200.0000", false],
      ["2027-03-01", "2027-03-31", "2027-03-01", "1200.0000", false],
    ]);
  });

  it("owes nothing before its first billing day has come", () => {
    expect(cb.periodsThrough(monthly(), "2026-12-31")).toEqual([]);
    expect(cb.nextPeriod(monthly(), "2026-12-31")?.billOn).toBe("2027-01-01");
    expect(cb.nextPeriod(monthly(), "2027-01-01")?.billOn).toBe("2027-02-01");
  });

  it("leaves no gap and no overlap between periods, whatever the billing day", () => {
    for (const billingDay of [1, 9, 15, 28]) {
      const periods = cb.periodsThrough(monthly({ billingDay, startsOn: "2027-01-20" }), "2028-02-01");
      for (let i = 1; i < periods.length; i += 1) {
        expect(periods[i]!.start).toBe(new Date(Date.parse(`${periods[i - 1]!.end}T00:00:00Z`) + 864e5).toISOString().slice(0, 10));
      }
      expect(periods[0]!.start).toBe("2027-01-20");
    }
  });

  it("bills a part month at the start whole, unless the contract says prorate", () => {
    const whole = cb.periodsThrough(monthly({ billingDay: 1, startsOn: "2027-01-15" }), "2027-02-01");
    expect(plain(whole)).toEqual([
      ["2027-01-15", "2027-01-31", "2027-01-15", "1200.0000", false],
      ["2027-02-01", "2027-02-28", "2027-02-01", "1200.0000", false],
    ]);
    expect(whole[0]).toMatchObject({ days: 17, fullDays: 31 });
    expect(cb.periodNote(whole[0]!, usd("1200.00"))).toMatch(/billed as a whole period/);

    const prorated = cb.periodsThrough(monthly({ billingDay: 1, startsOn: "2027-01-15", prorate: true }), "2027-02-01");
    /** 1,200 times 17 over 31 is 658.0645..., rounded once to 658.06. */
    expect(plain(prorated)[0]).toEqual(["2027-01-15", "2027-01-31", "2027-01-15", "658.0600", true]);
    expect(plain(prorated)[1]).toEqual(["2027-02-01", "2027-02-28", "2027-02-01", "1200.0000", false]);
    expect(cb.periodNote(prorated[0]!, usd("1200.00"))).toBe("17 of 31 days of 1200.00 a period, prorated by day.");
  });

  it("cuts the last period at the end, prorated only when the contract says so", () => {
    const ends = { startsOn: "2027-01-01", endsOn: "2027-03-10" };
    expect(plain(cb.periodsThrough(monthly(ends), "2027-12-31")).at(-1))
      .toEqual(["2027-03-01", "2027-03-10", "2027-03-01", "1200.0000", false]);
    /** 1,200 times 10 over 31 is 387.0967..., to 387.10. */
    expect(plain(cb.periodsThrough(monthly({ ...ends, prorate: true }), "2027-12-31")).at(-1))
      .toEqual(["2027-03-01", "2027-03-10", "2027-03-01", "387.1000", true]);
    expect(cb.periodsThrough(monthly(ends), "2027-12-31")).toHaveLength(3);
    expect(cb.nextPeriod(monthly(ends), "2027-03-01")).toBeNull();
  });

  it("keeps a quarterly schedule's months, counted from its first billing day", () => {
    const quarterly = monthly({ frequency: "quarterly", amount: usd("3000.00"), billingDay: 1, startsOn: "2027-01-15", prorate: true });
    const periods = cb.periodsThrough(quarterly, "2027-12-31");
    expect(periods.map((p) => [p.start, p.end])).toEqual([
      ["2027-01-15", "2027-01-31"],
      ["2027-02-01", "2027-04-30"],
      ["2027-05-01", "2027-07-31"],
      ["2027-08-01", "2027-10-31"],
      ["2027-11-01", "2028-01-31"],
    ]);
    /** The part is a share of the quarter it belongs to, November to January: 17 of 92 days. */
    expect(periods[0]).toMatchObject({ days: 17, fullDays: 92, prorated: true });
    expect(m.toString(periods[0]!.amount)).toBe("554.3500");
  });

  it("bills a yearly schedule once a year", () => {
    const yearly = monthly({ frequency: "yearly", amount: usd("9000.00"), billingDay: 1, startsOn: "2027-04-01" });
    expect(cb.periodsThrough(yearly, "2029-04-01").map((p) => [p.start, p.end])).toEqual([
      ["2027-04-01", "2028-03-31"], ["2028-04-01", "2029-03-31"], ["2029-04-01", "2030-03-31"],
    ]);
  });

  it("starts a period wherever it is asked to, which is how a changed schedule carries on", () => {
    /** After billing to 14 March on the old pattern, the next begins on the 15th and runs to the next billing day. */
    const changed = monthly({ startsOn: "2027-03-15", billingDay: 1 });
    expect(cb.periodFrom(changed, "2027-03-15")).toMatchObject({ start: "2027-03-15", end: "2027-03-31" });
    expect(cb.periodFrom(changed, "2027-03-14")).toBeNull();
  });

  it("catches up a page at a time", () => {
    expect(cb.periodsThrough(monthly({ startsOn: "2020-01-01" }), "2027-01-01", 12)).toHaveLength(12);
  });
});

describe("proration", () => {
  it("rounds once, half up, to the cent", () => {
    expect(m.toString(cb.prorate(usd("100.00"), 1, 3))).toBe("33.3300");
    expect(m.toString(cb.prorate(usd("100.00"), 2, 3))).toBe("66.6700");
    expect(m.toString(cb.prorate(usd("0.05"), 1, 2))).toBe("0.0300");
    expect(m.toString(cb.prorate(usd("1200.00"), 31, 31))).toBe("1200.0000");
  });
});

describe("what a schedule may say", () => {
  const ok = { amount: "1200.00", frequency: "monthly", billingDay: 1, startsOn: "2027-01-01" };
  it("refuses a billing day some month does not have", () => {
    expect(cb.scheduleProblem({ ...ok, billingDay: 31 })).toMatch(/1 to 28/);
    expect(cb.scheduleProblem({ ...ok, billingDay: 0 })).toMatch(/1 to 28/);
  });
  it("refuses a fee of nothing, a fee that is not an amount, and a frequency it does not know", () => {
    expect(cb.scheduleProblem({ ...ok, amount: "0" })).toMatch(/bills nothing/);
    expect(cb.scheduleProblem({ ...ok, amount: "12,00" })).toMatch(/not an amount/);
    expect(cb.scheduleProblem({ ...ok, frequency: "weekly" })).toMatch(/not how often/);
  });
  it("refuses a schedule that starts after the contract ends", () => {
    expect(cb.scheduleProblem({ ...ok, endsOn: "2026-12-31" })).toMatch(/before the schedule's first day/);
    expect(cb.scheduleProblem(ok)).toBeNull();
  });
  it("says a period in words an invoice line carries", () => {
    expect(cb.periodWords("2027-03-01", "2027-03-31")).toBe("1 Mar 2027 to 31 Mar 2027");
  });
});
