import { describe, it, expect } from "vitest";
import { reporting as r } from "../src/index";

const window = new Date("2026-06-10T14:00:00Z");
const hoursBefore = (hours: number) => new Date(window.getTime() - hours * 3_600_000);
const stop = (over: Partial<r.CancelStop> = {}): r.CancelStop => ({
  status: "cancelled", windowStart: window, cancelledBy: "customer", cancelledAt: hoursBefore(2), noticeHours: 24, ...over,
});

describe("a stop the customer called off late", () => {
  it("is late with less notice than the window asks for, and in time with the notice asked for", () => {
    expect(r.cancellationOf(stop())).toBe("late");
    expect(r.cancellationOf(stop({ cancelledAt: hoursBefore(30) }))).toBe("in_time");
    /** A day's notice is met by a call exactly a day before. */
    expect(r.cancellationOf(stop({ cancelledAt: hoursBefore(24) }))).toBe("in_time");
    expect(r.cancellationOf(stop({ cancelledAt: hoursBefore(23.99) }))).toBe("late");
  });

  it("counts a stop skipped at the door, after its window began, as late", () => {
    expect(r.cancellationOf(stop({ cancelledAt: new Date(window.getTime() + 600_000) }))).toBe("late");
  });

  it("judges by the notice window frozen on the visit, not today's", () => {
    expect(r.cancellationOf(stop({ cancelledAt: hoursBefore(30), noticeHours: 48 }))).toBe("late");
    expect(r.cancellationOf(stop({ cancelledAt: hoursBefore(2), noticeHours: 1 }))).toBe("in_time");
  });

  it("leaves the company's own cancellations to be counted beside, whatever the notice", () => {
    expect(r.cancellationOf(stop({ cancelledBy: "company" }))).toBe("company");
  });

  it("never guesses who called off a visit nobody recorded", () => {
    expect(r.cancellationOf(stop({ cancelledBy: null, cancelledAt: null, noticeHours: null }))).toBe("unknown");
  });

  it("counts a stop done after the customer cancelled it as called off", () => {
    expect(r.cancellationOf(stop({ status: "completed_after_cancellation" }))).toBe("late");
  });

  it("is a kept stop when it was not called off, and no stop at all with no time", () => {
    for (const status of ["completed", "scheduled", "unassigned", "no_show"]) {
      expect(r.cancellationOf(stop({ status, cancelledBy: null, cancelledAt: null, noticeHours: null }))).toBe("kept");
    }
    expect(r.cancellationOf(stop({ windowStart: null }))).toBeNull();
  });
});
