import { describe, it, expect } from "vitest";
import { reporting as r } from "../src/index";

const done = new Date("2026-06-20T15:00:00Z");
const daysBefore = (days: number) => new Date(done.getTime() - days * 86_400_000);
const call = (over: Partial<r.DrainCall> = {}): r.DrainCall => ({
  completedAt: done, equipmentId: null, others: [], producedUpsell: false, ...over,
});

describe("a drain call", () => {
  it("converts when it produced a camera inspection, a lining or an excavation", () => {
    expect(r.drainCallOf(call({ producedUpsell: true }))).toBe("converted");
    expect(r.drainCallOf(call())).toBe("not_converted");
  });

  it("is a repeat, left out, when the same line had a drain job in the thirty days before", () => {
    expect(r.drainCallOf(call({ producedUpsell: true, others: [{ completedAt: daysBefore(12), equipmentId: null }] }))).toBe("repeat");
    expect(r.drainCallOf(call({ others: [{ completedAt: daysBefore(30), equipmentId: null }] }))).toBe("repeat");
    expect(r.drainCallOf(call({ others: [{ completedAt: daysBefore(31), equipmentId: null }] }))).toBe("not_converted");
  });

  it("is not the repeat of a later job, nor of one on another lateral", () => {
    const later = new Date(done.getTime() + 86_400_000);
    expect(r.drainCallOf(call({ others: [{ completedAt: later, equipmentId: null }] }))).toBe("not_converted");
    expect(r.drainCallOf(call({ equipmentId: "a", others: [{ completedAt: daysBefore(3), equipmentId: "b" }] }))).toBe("not_converted");
    expect(r.drainCallOf(call({ equipmentId: "a", others: [{ completedAt: daysBefore(3), equipmentId: "a" }] }))).toBe("repeat");
    expect(r.drainCallOf(call({ equipmentId: "a", others: [{ completedAt: daysBefore(3), equipmentId: null }] }))).toBe("repeat");
  });
});
