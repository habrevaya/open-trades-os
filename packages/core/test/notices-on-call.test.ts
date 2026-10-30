import { describe, it, expect } from "vitest";
import { notices } from "../src/index";

/** Who is on call for the office's notices, and what a turn on the rota may be. */
describe("the office's on call rota", () => {
  const turns = [
    { userId: "a", startsOn: "2026-11-01", endsOn: "2026-11-03" },
    { userId: "b", startsOn: "2026-11-03", endsOn: "2026-11-03" },
    { userId: "a", startsOn: "2026-11-03", endsOn: "2026-11-05" },
  ];

  it("counts the first and last day, and two turns on one day are two people", () => {
    expect(notices.onCallOn(turns, "2026-10-31")).toEqual([]);
    expect(notices.onCallOn(turns, "2026-11-01")).toEqual(["a"]);
    expect(notices.onCallOn(turns, "2026-11-03")).toEqual(["a", "b"]);
    expect(notices.onCallOn(turns, "2026-11-05")).toEqual(["a"]);
    expect(notices.onCallOn(turns, "2026-11-06")).toEqual([]);
  });

  it("is off for every kind until the company sends one to it", () => {
    expect(notices.onCallKinds(undefined)).toEqual([]);
    expect(notices.onCallKinds({ kinds: ["autopay_failed", "task_assigned", 4] })).toEqual(["autopay_failed"]);
    expect(notices.onCallAudience({ kind: "task_deadline", routed: [], onCallToday: ["a"] })).toEqual({ to: "everyone" });
  });

  it("goes to the people on call only for a kind sent to the rota, and to everybody when nobody is on", () => {
    expect(notices.onCallAudience({ kind: "task_deadline", routed: ["task_deadline"], onCallToday: ["a"] }))
      .toEqual({ to: "on_call", userIds: ["a"] });
    expect(notices.onCallAudience({ kind: "task_deadline", routed: ["task_deadline"], onCallToday: [] })).toEqual({ to: "everyone" });
    expect(notices.onCallAudience({ kind: "task_assigned", routed: ["task_deadline"], onCallToday: ["a"] })).toEqual({ to: "everyone" });
  });

  it("refuses a turn back to front, over already, or longer than a year", () => {
    const today = "2026-10-30";
    expect(notices.onCallShiftProblem({ startsOn: "2026-10-30", endsOn: "2026-10-30", today })).toBeNull();
    expect(notices.onCallShiftProblem({ startsOn: "2026-10-01", endsOn: "2026-10-30", today })).toBeNull();
    expect(notices.onCallShiftProblem({ startsOn: "2026-11-02", endsOn: "2026-11-01", today })).toMatch(/before the first day/);
    expect(notices.onCallShiftProblem({ startsOn: "2026-10-01", endsOn: "2026-10-29", today })).toMatch(/over already/);
    expect(notices.onCallShiftProblem({ startsOn: "2026-11-01", endsOn: "2027-11-01", today })).toBeNull();
    expect(notices.onCallShiftProblem({ startsOn: "2026-11-01", endsOn: "2027-11-02", today })).toMatch(/at most 366 days/);
    expect(notices.onCallShiftProblem({ startsOn: "tomorrow", endsOn: "2026-11-01", today })).toMatch(/as dates/);
  });
});
