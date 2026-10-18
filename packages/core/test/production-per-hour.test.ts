import { describe, it, expect } from "vitest";
import { reporting } from "../src/index";

/**
 * Lawn and landscape's production per crew hour: a completed job's units of
 * work over its crew's hours on site, leaving out drive time and getting the
 * job ready, and never adding square feet to cubic yards.
 */
const punch = (kind: string, minutes: number | null) => ({ kind, minutes });

describe("one job's production", () => {
  it("is its units over every person's hours on site, a paid break there included", () => {
    expect(reporting.productionOf({
      unit: "Square feet", quantity: 1200,
      punches: [punch("on_site", 300), punch("on_site", 300), punch("paid_break", 60)],
    })).toEqual({ counted: true, unitKey: "square feet", units: 1200, hours: 11, readyHours: 0 });
  });

  it("leaves out the drive and getting the job ready, and says how long the getting ready was", () => {
    expect(reporting.productionOf({
      unit: "square feet", quantity: 600,
      punches: [punch("travel", 45), punch("mobilisation", 90), punch("on_site", 240), punch("shop", 30), punch("unpaid_break", 30)],
    })).toEqual({ counted: true, unitKey: "square feet", units: 600, hours: 4, readyHours: 1.5 });
  });

  it("is not known with no amount recorded, no hours on site, or a punch still running", () => {
    expect(reporting.productionOf({ unit: "sq ft", quantity: null, punches: [punch("on_site", 60)] })).toEqual({ counted: false, reason: "no_amount" });
    expect(reporting.productionOf({ unit: "sq ft", quantity: 100, punches: [punch("mobilisation", 60)] })).toEqual({ counted: false, reason: "no_hours" });
    expect(reporting.productionOf({ unit: "sq ft", quantity: 100, punches: [punch("on_site", 60), punch("on_site", null)] }))
      .toEqual({ counted: false, reason: "running" });
  });
});

describe("the company's production per crew hour", () => {
  it("adds only the unit most of the hours went to, and counts the rest beside", () => {
    const result = reporting.productionPerCrewHour([
      { unit: "square feet", quantity: 1200, punches: [punch("on_site", 600)] },
      { unit: "Square feet ", quantity: 300, punches: [punch("on_site", 120)] },
      { unit: "cubic yards", quantity: 12, punches: [punch("on_site", 360)] },
      { unit: "square feet", quantity: null, punches: [punch("on_site", 60)] },
    ]);
    expect(result).toEqual({ unitKey: "square feet", units: 1500, hours: 12, otherUnit: 1, notKnown: 1 });
  });

  it("has nothing to measure when no job is measured", () => {
    expect(reporting.productionPerCrewHour([])).toEqual({ unitKey: null, units: 0, hours: 0, otherUnit: 0, notKnown: 0 });
  });
});
