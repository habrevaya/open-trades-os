import { describe, it, expect } from "vitest";
import { reporting as r } from "../src/index";

describe("a haul's invoiced revenue", () => {
  it("adds the lines naming each haul on invoices issued and not voided, and never a permit", () => {
    const revenue = r.haulRevenue([
      { rentalId: "h1", amount: 475, invoiceStatus: "open", permit: false },
      { rentalId: "h1", amount: 60, invoiceStatus: "paid", permit: false },
      { rentalId: "h1", amount: 35, invoiceStatus: "paid", permit: true },
      { rentalId: "h2", amount: 300, invoiceStatus: "draft", permit: false },
      { rentalId: "h2", amount: 300, invoiceStatus: "void", permit: false },
      { rentalId: "h3", amount: 0, invoiceStatus: "written_off", permit: false },
    ]);
    expect(Object.fromEntries(revenue)).toEqual({ h1: 535, h3: 0 });
  });
});

describe("a container's months in the fleet", () => {
  it("is each day in the fleet as a share of its own month, the yard included", () => {
    expect(r.containerMonths({ joined: "2025-01-01", left: null }, { from: "2026-06-01", to: "2026-06-30" })).toBeCloseTo(1, 10);
    expect(r.containerMonths({ joined: "2026-06-16", left: null }, { from: "2026-06-01", to: "2026-06-30" })).toBeCloseTo(0.5, 10);
    /** Retired on the 11th: in the fleet the 1st to the 10th. */
    expect(r.containerMonths({ joined: "2025-01-01", left: "2026-06-11" }, { from: "2026-06-01", to: "2026-06-30" })).toBeCloseTo(1 / 3, 10);
    /** Half of February and half of March are a month between them. */
    expect(r.containerMonths({ joined: "2025-01-01", left: null }, { from: "2026-02-15", to: "2026-03-16" })).toBeCloseTo(14 / 28 + 16 / 31, 10);
    expect(r.containerMonths({ joined: "2026-07-01", left: null }, { from: "2026-06-01", to: "2026-06-30" })).toBe(0);
  });
});

describe("a haul's disposal cost against its revenue", () => {
  it("counts a haul with a fee and invoiced revenue, and leaves out one missing either", () => {
    expect(r.disposalHaulOf({ fee: 180, revenue: 475 })).toEqual({ counted: true, cost: 180, revenue: 475 });
    expect(r.disposalHaulOf({ fee: null, revenue: 475 })).toEqual({ counted: false, why: "no_fee" });
    expect(r.disposalHaulOf({ fee: 180, revenue: undefined })).toEqual({ counted: false, why: "not_invoiced" });
  });
});
