import { describe, it, expect } from "vitest";
import { reporting as r } from "../src/index";

const supply = (over: Partial<r.SupplyLine> = {}): r.SupplyLine =>
  ({ kind: "part", quantity: 1, unitCost: 10, billedBack: false, billedRevenue: null, ...over });

describe("a job's supplies against its revenue", () => {
  it("is what its supplies cost over what it billed", () => {
    expect(r.supplyCostOf({ revenue: 200, lines: [supply({ quantity: 2, unitCost: 5 })] }))
      .toEqual({ counted: true, supplyCost: 10, revenue: 200, passedThrough: 0 });
  });

  it("takes a supply billed back at cost out of both halves once it is on an issued invoice", () => {
    expect(r.supplyCostOf({
      revenue: 1000,
      lines: [supply({ unitCost: 150, billedBack: true, billedRevenue: 150 }), supply({ quantity: 3, unitCost: 10 })],
    })).toEqual({ counted: true, supplyCost: 30, revenue: 850, passedThrough: 1 });
  });

  it("counts a supply marked billed back and not billed as a cost, because nothing came back for it yet", () => {
    expect(r.supplyCostOf({ revenue: 300, lines: [supply({ unitCost: 40, billedBack: true })] }))
      .toMatchObject({ supplyCost: 40, revenue: 300, passedThrough: 0 });
  });

  it("does not count equipment fitted or labour as supplies", () => {
    expect(r.supplyCostOf({
      revenue: 100, lines: [supply({ kind: "equipment", unitCost: 24 }), supply({ kind: "labor", unitCost: 30 })],
    })).toMatchObject({ supplyCost: 0, revenue: 100 });
  });

  it("leaves out a job with a supply nobody costed, rather than reading it as free", () => {
    expect(r.supplyCostOf({ revenue: 500, lines: [supply({ unitCost: null })] }))
      .toEqual({ counted: false, why: "uncosted" });
    /** One billed back and passed through needs no cost: it is out either way. */
    expect(r.supplyCostOf({ revenue: 500, lines: [supply({ unitCost: null, billedBack: true, billedRevenue: 60 })] }))
      .toMatchObject({ counted: true, supplyCost: 0, revenue: 440 });
  });
});
