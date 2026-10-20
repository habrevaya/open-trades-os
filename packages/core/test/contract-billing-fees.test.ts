import { describe, it, expect } from "vitest";
import { contractBilling as cb, money as m } from "../src/index";

/**
 * A FIXED FEE THAT ROSE ON A DAY.
 *
 * 1,200.00 a month billed on the 15th, risen to 1,236.00 from 1 March: each
 * period is priced by the fee in force on its first day, so the period that
 * straddles the rise is billed at the old fee and never charged the rise for
 * days before it, and every period from the first that starts after it is
 * billed at the new one, by the day when it is a part period.
 */
const usd = (v: string) => m.money(v, "USD");
const schedule: cb.Schedule = {
  amount: usd("1200.00"), frequency: "monthly", billingDay: 15, startsOn: "2027-01-15", endsOn: "2027-05-31",
  prorate: true, fees: [{ from: "2027-03-01", amount: usd("1236.00") }],
};

describe("a fee that rose", () => {
  it("prices each period by the fee in force on its first day", () => {
    const periods = cb.periodsThrough(schedule, "2027-06-30");
    expect(periods.map((p) => [p.start, m.toString(p.amount)])).toEqual([
      ["2027-01-15", "1200.0000"],
      ["2027-02-15", "1200.0000"],
      ["2027-03-15", "1236.0000"],
      ["2027-04-15", "1236.0000"],
      /** A part period at the end, by the day of the risen fee: 17 of 31 days. */
      ["2027-05-15", m.toString(cb.prorate(usd("1236.00"), 17, 31))],
    ]);
  });

  it("is the schedule's own amount before the first rise, and the latest rise after several", () => {
    const twice: cb.Schedule = { ...schedule, fees: [{ from: "2028-03-01", amount: usd("1273.08") }, ...schedule.fees!] };
    expect(m.toString(cb.feeOn(twice, "2027-02-28"))).toBe("1200.0000");
    expect(m.toString(cb.feeOn(twice, "2027-03-01"))).toBe("1236.0000");
    expect(m.toString(cb.feeOn(twice, "2028-03-15"))).toBe("1273.0800");
  });
});

describe("a rise applied after periods at the new fee were billed", () => {
  it("reprices a billed period exactly as it was billed, by the fee in force on its first day", () => {
    /** Billed before the rise was applied: the whole of March at 1,200.00, and the part period at the end by the day. */
    const billedThen = cb.periodsThrough({ ...schedule, fees: [] }, "2027-06-30");
    const march = billedThen.find((p) => p.start === "2027-03-15")!;
    const may = billedThen.find((p) => p.start === "2027-05-15")!;
    expect(m.toString(cb.repriced(schedule, march))).toBe("1236.0000");
    expect(m.toString(cb.repriced(schedule, may))).toBe(m.toString(cb.prorate(usd("1236.00"), 17, 31)));
    /** The period that straddles the rise started before it, so nothing about it changes. */
    const feb = billedThen.find((p) => p.start === "2027-02-15")!;
    expect(m.toString(cb.repriced(schedule, feb))).toBe(m.toString(feb.amount));
  });
});
