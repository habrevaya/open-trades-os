import { describe, it, expect } from "vitest";
import { reporting as r, work } from "../src/index";

const at = (iso: string) => new Date(iso);
const visit = (status: string, arrived: string | null, completed: string | null = arrived) =>
  ({ status, arrivedAt: arrived ? at(arrived) : null, completedAt: completed ? at(completed) : null });

const job = (over: Partial<r.FixJob> = {}): r.FixJob => ({
  completedAt: at("2026-06-12T20:00:00Z"),
  multiVisitPlannedAt: null,
  visits: [visit("completed", "2026-06-10T15:00:00Z")],
  holds: [],
  ...over,
});

describe("what a completed job counts as for first time fix", () => {
  it("is fixed in one visit and returned in two", () => {
    expect(r.firstTimeFixOf(job(), "hvac")).toBe("fixed");
    expect(r.firstTimeFixOf(job({
      visits: [visit("completed", "2026-06-10T15:00:00Z"), visit("completed", "2026-06-12T15:00:00Z")],
    }), "hvac")).toBe("returned");
  });

  it("counts a visit finished on a phone that missed the cancellation, and not one that never happened", () => {
    expect(r.firstTimeFixOf(job({
      visits: [visit("completed", "2026-06-10T15:00:00Z"), visit("completed_after_cancellation", "2026-06-11T15:00:00Z")],
    }), "hvac")).toBe("returned");
    expect(r.firstTimeFixOf(job({
      visits: [visit("cancelled", null), visit("completed", "2026-06-10T15:00:00Z")],
    }), "hvac")).toBe("fixed");
  });

  it("does not know how many visits a job took when none of its visits was done", () => {
    expect(r.firstTimeFixOf(job({ visits: [] }), "hvac")).toBe("unknown");
  });

  it("leaves out a job planned as several visits before the work started", () => {
    const twoDay = job({
      multiVisitPlannedAt: at("2026-06-01T12:00:00Z"),
      visits: [visit("completed", "2026-06-10T15:00:00Z"), visit("completed", "2026-06-11T15:00:00Z")],
    });
    expect(r.firstTimeFixOf(twoDay, "hvac")).toBe("excluded");
  });

  it("does not believe a plan written after somebody arrived", () => {
    const relabelled = job({
      multiVisitPlannedAt: at("2026-06-10T16:00:00Z"),
      visits: [visit("completed", "2026-06-10T15:00:00Z"), visit("completed", "2026-06-12T15:00:00Z")],
    });
    expect(r.firstTimeFixOf(relabelled, "hvac")).toBe("returned");
  });

  it("leaves out a part hold only for the trades whose definition says so, and only on an order that went out", () => {
    const held = (orderPlaced: boolean) => job({
      visits: [visit("completed", "2026-06-10T15:00:00Z"), visit("completed", "2026-06-12T15:00:00Z")],
      holds: [{ reason: "part", placedAt: at("2026-06-10T18:00:00Z"), orderPlaced }],
    });
    expect(r.firstTimeFixOf(held(true), "plumbing")).toBe("excluded");
    expect(r.firstTimeFixOf(held(true), "electrical")).toBe("excluded");
    /** HVAC's definition excludes only planned work. */
    expect(r.firstTimeFixOf(held(true), "hvac")).toBe("returned");
    /** A draft order, or a cancelled one, is not a part order. */
    expect(r.firstTimeFixOf(held(false), "plumbing")).toBe("returned");
  });

  it("leaves out an inspection hold for an electrician and nobody else", () => {
    const inspected = job({
      visits: [visit("completed", "2026-06-10T15:00:00Z"), visit("completed", "2026-06-12T15:00:00Z")],
      holds: [{ reason: "inspection", placedAt: at("2026-06-10T18:00:00Z"), orderPlaced: false }],
    });
    expect(r.firstTimeFixOf(inspected, "electrical")).toBe("excluded");
    expect(r.firstTimeFixOf(inspected, "plumbing")).toBe("returned");
  });

  it("does not count a hold placed after the job was finished, or one waiting on the customer", () => {
    const late = job({
      visits: [visit("completed", "2026-06-10T15:00:00Z"), visit("completed", "2026-06-12T15:00:00Z")],
      holds: [{ reason: "part", placedAt: at("2026-06-13T15:00:00Z"), orderPlaced: true }],
    });
    expect(r.firstTimeFixOf(late, "plumbing")).toBe("returned");
    const customer = job({
      visits: [visit("completed", "2026-06-10T15:00:00Z"), visit("completed", "2026-06-12T15:00:00Z")],
      holds: [{ reason: "customer", placedAt: at("2026-06-10T18:00:00Z"), orderPlaced: false }],
    });
    expect(r.firstTimeFixOf(customer, "electrical")).toBe("returned");
  });
});

describe("what a hold has to say", () => {
  it("names the order a part is on, and says which inspection", () => {
    expect(work.holdRefusal({ reason: "part" })).toMatch(/purchase order/);
    expect(work.holdRefusal({ reason: "part", purchaseOrderId: "po" })).toBeNull();
    expect(work.holdRefusal({ reason: "inspection", note: "  " })).toMatch(/which inspection/);
    expect(work.holdRefusal({ reason: "inspection", note: "City final on the panel" })).toBeNull();
    expect(work.holdRefusal({ reason: "other" })).toMatch(/what the job is waiting on/);
    expect(work.holdRefusal({ reason: "customer" })).toBeNull();
  });

  it("refuses an order on a hold that is not for a part, rather than keeping it unread", () => {
    expect(work.holdRefusal({ reason: "customer", purchaseOrderId: "po" })).toMatch(/Only a hold for a part/);
  });

  it("calls every reason something an owner would say", () => {
    expect(work.holdReasonLabel("part")).toBe("Waiting on a part");
    expect(work.HOLD_REASONS.map((r) => r.value)).toEqual(["part", "inspection", "customer", "weather", "other"]);
  });
});
