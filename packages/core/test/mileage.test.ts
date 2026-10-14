import { describe, it, expect } from "vitest";
import { money as m, payExtras as px } from "../src/index";

/**
 * A MILEAGE RATE FOR REIMBURSEMENTS
 *
 * What one mile is paid, from a day; the rate in force on the day of the drive; the
 * miles to a tenth; and what they come to, to the cent. A rate that cannot be right is
 * refused in words, and one already used is never quietly changed.
 */

describe("a rate somebody typed", () => {
  it("is dollars for one mile, up to half cents, written to three places", () => {
    expect(px.checkMileageRate({ from: "2026-01-01", perMile: "0.70" })).toEqual({ ok: true, rate: { from: "2026-01-01", perMile: "0.700" } });
    expect(px.checkMileageRate({ from: "2026-01-01", perMile: "$0.725" })).toEqual({ ok: true, rate: { from: "2026-01-01", perMile: "0.725" } });
    expect(px.checkMileageRate({ from: "2026-01-01", perMile: "1" })).toEqual({ ok: true, rate: { from: "2026-01-01", perMile: "1.000" } });
  });

  it("is refused when it is not a number, nothing, a slip of the keys, or on no real day", () => {
    const refused = (perMile: string, from = "2026-01-01") => {
      const r = px.checkMileageRate({ from, perMile });
      return r.ok ? null : r.reason;
    };
    expect(refused("seventy cents")).toContain("dollars");
    expect(refused("0.7255")).toContain("dollars");
    expect(refused("-0.7")).toContain("dollars");
    expect(refused("0")).toContain("more than nothing");
    expect(refused("72")).toContain("slip of the keys");
    expect(refused("0.70", "2026-02-30")).toContain("first day");
    expect(refused("0.70", "Jan 1")).toContain("first day");
    expect(refused("0.70", "1999-12-31")).toContain("too long ago");
  });
});

describe("the company's rates over time", () => {
  const rates = [{ from: "2025-01-01", perMile: "0.700" }, { from: "2026-01-01", perMile: "0.725" }];

  it("takes the latest one that has begun, on the day it begins and not before", () => {
    expect(px.mileageRateOn(rates, "2024-12-31")).toBeNull();
    expect(px.mileageRateOn(rates, "2025-01-01")?.perMile).toBe("0.700");
    expect(px.mileageRateOn(rates, "2025-12-31")?.perMile).toBe("0.700");
    expect(px.mileageRateOn(rates, "2026-01-01")?.perMile).toBe("0.725");
    expect(px.mileageRateOn(rates, "2030-06-01")?.perMile).toBe("0.725");
    expect(px.mileageRateOn([], "2026-01-01")).toBeNull();
  });

  it("adds a rate in date order, and refuses a second for the same day", () => {
    const added = px.addMileageRate(rates, { from: "2025-07-01", perMile: "0.67" });
    expect(added.ok && added.rates.map((r) => r.from)).toEqual(["2025-01-01", "2025-07-01", "2026-01-01"]);
    const twice = px.addMileageRate(rates, { from: "2026-01-01", perMile: "0.80" });
    expect(twice).toEqual({ ok: false, reason: "There is already a rate from 2026-01-01. Take it off first if it is wrong." });
    expect(px.addMileageRate(rates, { from: "2026-03-01", perMile: "abc" }).ok).toBe(false);
  });

  it("takes one off by its day, and says when there is none", () => {
    const removed = px.removeMileageRate(rates, "2025-01-01");
    expect(removed.ok && removed.rates).toEqual([{ from: "2026-01-01", perMile: "0.725" }]);
    expect(px.removeMileageRate(rates, "2025-02-01")).toEqual({ ok: false, reason: "There is no rate from 2025-02-01." });
  });

  it("reads what is in the settings, and drops what is not a rate", () => {
    const read = px.readPaySettings({
      mileageRates: [
        { from: "2026-01-01", perMile: "0.725" }, { from: "2025-01-01", perMile: "0.70" },
        { from: "2026-01-01", perMile: "0.99" }, { from: "nonsense", perMile: "0.5" }, { from: "2026-02-01", perMile: 3 }, "x", null,
      ],
    });
    expect(read.mileageRates).toEqual([{ from: "2025-01-01", perMile: "0.700" }, { from: "2026-01-01", perMile: "0.725" }]);
    expect(px.readPaySettings({}).mileageRates).toEqual([]);
    expect(px.readPaySettings({ mileageRates: "0.70" }).mileageRates).toEqual([]);
  });
});

describe("the miles", () => {
  it("are to a tenth, written with the tenth", () => {
    expect(px.checkMiles("18")).toEqual({ ok: true, miles: "18.0" });
    expect(px.checkMiles(" 18.4 ")).toEqual({ ok: true, miles: "18.4" });
  });

  it("are refused when they are not a number, nothing, finer than a tenth, or too many for one claim", () => {
    for (const bad of ["", "about 20", "18.45", "-4", "1,200"]) expect(px.checkMiles(bad).ok, bad).toBe(false);
    const nothing = px.checkMiles("0");
    expect(nothing.ok === false && nothing.reason).toContain("more than nothing");
    const lots = px.checkMiles("2000.1");
    expect(lots.ok === false && lots.reason).toContain("2000.0");
    expect(px.checkMiles("2000").ok).toBe(true);
  });
});

describe("what the miles come to", () => {
  it("is miles times the rate, to the cent, the half cent rounded up", () => {
    expect(m.toString(px.mileageAmount("100.0", "0.700"))).toBe("70.0000");
    expect(m.toString(px.mileageAmount("12.5", "0.725"))).toBe("9.0600");
    expect(m.toString(px.mileageAmount("0.1", "0.725"))).toBe("0.0700");
    expect(m.toString(px.mileageAmount("0.1", "0.700"))).toBe("0.0700");
    expect(m.toString(px.mileageAmount("0.3", "0.725"))).toBe("0.2200");
  });
});
