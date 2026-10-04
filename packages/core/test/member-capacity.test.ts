import { describe, it, expect } from "vitest";
import { customerPortal as cp, routing } from "../src/index";

/**
 * WHAT A PLAN'S PRIORITY DISPATCH RESERVES
 *
 * A share of each window kept back from anybody who is not a member until a
 * set time before it opens, and members suggested first for the unassigned
 * work.
 */

const window = { start: new Date("2026-05-05T13:00:00Z"), end: new Date("2026-05-05T17:00:00Z") };
const person = (id: string) => ({ id, busy: [], away: false, qualified: true });

describe("the whole of a window", () => {
  it("is what it holds with nothing booked, across the people who could go", () => {
    const capacity = cp.windowCapacity({
      window, durationMinutes: 60, waitingMinutes: 0,
      technicians: [
        person("ray"),
        { id: "dana", busy: [{ start: window.start, minutes: 120 }], away: false, qualified: true },
        { ...person("sam"), away: true },
      ],
    });
    expect(capacity.whole).toBe(8);
    expect(capacity.jobs).toBe(6);
  });
});

describe("the share held for members", () => {
  const hold = { share: 0.25, releaseHours: 24 };
  const opensAt = window.start;
  const early = new Date(opensAt.getTime() - 3 * 864e5);

  it("keeps a share of the whole window, rounded to whole jobs", () => {
    expect(cp.heldForMembers({ hold, whole: 8, memberJobs: 0, opensAt, now: early })).toBe(2);
    expect(cp.heldForMembers({ hold, whole: 4, memberJobs: 0, opensAt, now: early })).toBe(1);
    /** A quarter of two jobs is half a job, which rounds down to holding none. */
    expect(cp.heldForMembers({ hold, whole: 2, memberJobs: 0, opensAt, now: early })).toBe(0);
    expect(cp.heldForMembers({ hold, whole: 3, memberJobs: 0, opensAt, now: early })).toBe(1);
  });

  it("is used up by members' own work first", () => {
    expect(cp.heldForMembers({ hold, whole: 8, memberJobs: 1, opensAt, now: early })).toBe(1);
    expect(cp.heldForMembers({ hold, whole: 8, memberJobs: 5, opensAt, now: early })).toBe(0);
  });

  it("is let go to anybody once the window is closer than the release time", () => {
    const late = new Date(opensAt.getTime() - 23 * 3_600_000);
    expect(cp.heldForMembers({ hold, whole: 8, memberJobs: 0, opensAt, now: late })).toBe(0);
    const exactly = new Date(opensAt.getTime() - 24 * 3_600_000);
    expect(cp.heldForMembers({ hold, whole: 8, memberJobs: 0, opensAt, now: exactly })).toBe(0);
  });

  it("lets a member of a plan holding less into its own share and no further", () => {
    const big = { share: 0.5, releaseHours: 24 };
    /** Half of eight is four held; a quarter plan's member may use two of them. */
    expect(cp.heldForMembers({ hold: big, whole: 8, memberJobs: 0, opensAt, now: early, ownShare: 0.25 })).toBe(2);
    expect(cp.heldForMembers({ hold: big, whole: 8, memberJobs: 0, opensAt, now: early, ownShare: 0.5 })).toBe(0);
    expect(cp.heldForMembers({ hold: big, whole: 8, memberJobs: 0, opensAt, now: early })).toBe(4);
    /** Members' work uses the hold up for everybody, the smaller plan's members included. */
    expect(cp.heldForMembers({ hold: big, whole: 8, memberJobs: 3, opensAt, now: early, ownShare: 0.25 })).toBe(0);
  });

  it("holds nothing when the share is none", () => {
    expect(cp.heldForMembers({ hold: { share: 0, releaseHours: 24 }, whole: 8, memberJobs: 0, opensAt, now: early })).toBe(0);
  });
});

describe("Suggest who puts members first", () => {
  it("gives the only gap to the member, even when the other visit's window closes sooner", () => {
    const travel: routing.Travel = (a, b) => (a === b ? 0 : 30);
    const day: routing.TechnicianDay = { technicianId: "ray", start: "yard", end: "yard", departAt: 0, stops: [] };
    const visit = (id: string, windowEnd: number, priority: boolean): routing.OpenVisit => ({
      stop: { id, serviceMinutes: 240, windowStart: 0, windowEnd }, refusals: { ray: null }, priority,
    });
    const result = routing.suggestAssignments({
      technicians: [day],
      visits: [visit("stranger", 60, false), visit("member", 120, true)],
      travel,
    });
    expect(result[0]!.visitId).toBe("member");
    expect(result[0]!.makesLate).toEqual([]);
    /** The stranger comes second, and wherever it goes beside four hours of the member's work something is late, which it says. */
    expect(result[1]!.visitId).toBe("stranger");
    expect(result[1]!.makesLate.length).toBeGreaterThan(0);
  });
});
