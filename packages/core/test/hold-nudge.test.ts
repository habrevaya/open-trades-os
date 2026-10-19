import { describe, it, expect } from "vitest";
import { work } from "../src/index";

describe("how long a job may stay on hold", () => {
  it("accepts off, or a whole number of days from one to ninety", () => {
    expect(work.holdNudgeProblem(null)).toBeNull();
    expect(work.holdNudgeProblem(1)).toBeNull();
    expect(work.holdNudgeProblem(90)).toBeNull();
    for (const bad of [0, -1, 91, 2.5, "3", undefined, Number.NaN]) {
      expect(work.holdNudgeProblem(bad)).toMatch(/whole number from 1 to 90/);
    }
  });

  it("reads anything saved that is not a good number as off", () => {
    expect(work.holdNudgeDays(7)).toBe(7);
    expect(work.holdNudgeDays(0)).toBeNull();
    expect(work.holdNudgeDays("7")).toBeNull();
    expect(work.holdNudgeDays(undefined)).toBeNull();
  });
});

describe("how long a hold has lasted", () => {
  it("counts calendar days, across a month end and never below nothing", () => {
    expect(work.daysHeld("2026-10-10", "2026-10-13")).toBe(3);
    expect(work.daysHeld("2026-09-29", "2026-10-02")).toBe(3);
    expect(work.daysHeld("2026-10-13", "2026-10-13")).toBe(0);
    expect(work.daysHeld("2026-10-14", "2026-10-13")).toBe(0);
    expect(work.daysHeld("nonsense", "2026-10-13")).toBe(0);
  });

  it("is due at the number of days and not before, and never when off", () => {
    expect(work.holdNudgeDue(2, 3)).toBe(false);
    expect(work.holdNudgeDue(3, 3)).toBe(true);
    expect(work.holdNudgeDue(40, 3)).toBe(true);
    expect(work.holdNudgeDue(400, null)).toBe(false);
  });
});

describe("what the office is told", () => {
  it("puts the job, the days and the reason in the title", () => {
    expect(work.holdNudgeTitle({ jobLabel: "1042", reason: "part", held: 5 }))
      .toBe("Job 1042 has been on hold 5 days: waiting on a part");
    expect(work.holdNudgeTitle({ jobLabel: "N-7", reason: "other", held: 1 }))
      .toBe("Job N-7 has been on hold 1 day: something else");
  });

  it("says the reason with what was written about it, and names no purchase order", () => {
    expect(work.holdWords("part", "Condenser fan motor")).toBe("Waiting on a part: Condenser fan motor");
    expect(work.holdWords("customer", "  ")).toBe("Waiting on the customer");
    const body = work.holdNudgeBody({
      customerName: "Dana Whitfield", summary: "No cool", reason: "part", note: "Fan motor", held: 4,
      since: "October 9, 2026", placedBy: "Ana Ruiz", days: 3,
    });
    expect(body).toContain("Dana Whitfield: No cool. Waiting on a part: Fan motor.");
    expect(body).toContain("since October 9, 2026, put there by Ana Ruiz, which is 4 days");
    expect(body).toContain("after 3 days");
    expect(body).not.toMatch(/purchase order|[\u2014\u2013]/i);
  });

  it("says it plainly on the dispatch board", () => {
    expect(work.holdOnBoard({ reason: "weather", note: null, held: 0 })).toBe("On hold since today. Waiting on the weather");
    expect(work.holdOnBoard({ reason: "inspection", note: "Rough in", held: 1 })).toBe("On hold 1 day. Waiting on an inspection: Rough in");
  });
});
