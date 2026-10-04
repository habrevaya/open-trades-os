import { describe, it, expect } from "vitest";
import { routing } from "../src/index";

/**
 * THE DAY REBALANCED ACROSS EVERYBODY
 *
 * Stops on a grid, drives as Manhattan distance in minutes, minutes counted
 * from eight in the morning, as in routing.test.ts, so every figure can be
 * checked by hand.
 */

type Grid = Record<string, [number, number]>;
const manhattan = (grid: Grid): routing.Travel => (from, to) => {
  const a = grid[from]!;
  const b = grid[to]!;
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
};
const stop = (id: string, serviceMinutes = 30, windowStart: number | null = null, windowEnd: number | null = null) =>
  ({ id, serviceMinutes, windowStart, windowEnd });
const shift = (endsAt = 540, maxOvertimeMinutes = 60, lunch: routing.Lunch | null = null): routing.Shift =>
  ({ endsAt, maxOvertimeMinutes, lunch });

describe("a day with a shift around it", () => {
  const grid: Grid = { yard: [0, 0], a: [60, 0], b: [120, 0] };
  const plan = (stops: routing.PlanStop[]): routing.DayPlan =>
    ({ start: "yard", end: "yard", departAt: 0, stops, travel: manhattan(grid) });

  it("walks a day with no lunch and no end exactly as evaluate does", () => {
    const p = plan([stop("a"), stop("b")]);
    const plain = routing.evaluate(p, ["a", "b"]);
    const shifted = routing.evaluateShift(p, ["a", "b"], shift(10_000, 0));
    expect(shifted.finishAt).toBe(plain.finishAt);
    expect(shifted.driveMinutes).toBe(plain.driveMinutes);
    expect(shifted.lunch).toBeNull();
  });

  it("takes lunch at the first gap once its window has opened", () => {
    // a 60..90, lunch window opens at 90: taken at 90 for 30, b reached at 180.
    const day = routing.evaluateShift(plan([stop("a"), stop("b")]), ["a", "b"], shift(540, 60, { minutes: 30, earliest: 90, latest: 240 }));
    expect(day.lunch).toEqual({ startAt: 90, lateBy: 0 });
    expect(day.arrivals[1]!.arriveAt).toBe(180);
  });

  it("waits for the break rather than run a long job past its latest start", () => {
    const long = stop("a", 300);
    // Leaving at 0, the job would run 60 to 360, past a latest start of 180, so lunch at 120.
    const day = routing.evaluateShift(plan([long]), ["a"], shift(900, 60, { minutes: 30, earliest: 0, latest: 180 }));
    expect(day.lunch).toEqual({ startAt: 0, lateBy: 0 });
  });

  it("eats in a wait outside a customer's window when the break fits there", () => {
    // Arrive at a at 60, window opens at 150: lunch from 90 inside the wait.
    const day = routing.evaluateShift(plan([stop("a", 30, 150, 200)]), ["a"], shift(540, 60, { minutes: 30, earliest: 90, latest: 240 }));
    expect(day.lunch).toEqual({ startAt: 90, lateBy: 0 });
    expect(day.arrivals[0]!.startAt).toBe(150);
    expect(day.waitMinutes).toBe(60);
  });

  it("counts overtime past the end of the shift, and what runs past the allowance", () => {
    const day = routing.evaluateShift(plan([stop("b", 400)]), ["b"], shift(500, 60));
    // 120 out, 400 on site, 120 back: 640.
    expect(day.finishAt).toBe(640);
    expect(day.overtimeMinutes).toBe(140);
    expect(day.overLimitMinutes).toBe(80);
  });

  it("charges no overtime for an empty day", () => {
    const day = routing.evaluateShift({ ...plan([]), departAt: 900 }, [], shift(500, 0));
    expect(day.overtimeMinutes).toBe(0);
  });
});

describe("rebalancing between people", () => {
  /**
   * Ray starts in the west yard and Dana in the east one. Ray has been given
   * a job on the east side: it belongs on Dana's day.
   */
  const grid: Grid = {
    west: [0, 0], east: [100, 0],
    w1: [10, 0], w2: [20, 0], e1: [90, 0], e2: [95, 0], open: [92, 0],
  };
  const tech = (technicianId: string, start: string, order: string[]): routing.RebalanceTechnician => ({
    technicianId, start, end: start, departAt: 0, shift: shift(), order,
  });
  const visit = (id: string, extra: Partial<routing.RebalanceVisit> = {}): routing.RebalanceVisit => ({
    stop: stop(id), locked: false, refusals: { ray: null, dana: null }, ...extra,
  });

  it("moves a visit to the person it is near, and says how much driving it saves", () => {
    const result = routing.rebalance({
      technicians: [tech("ray", "west", ["w1", "e1"]), tech("dana", "east", ["e2"])],
      visits: [visit("w1"), visit("e1"), visit("e2")],
      travel: manhattan(grid),
    });
    expect(result.moves).toEqual([{ visitId: "e1", from: "ray", to: "dana" }]);
    expect(result.driveAfter).toBeLessThan(result.driveBefore);
    expect(result.changed).toBe(true);
  });

  it("moves two far calls together when neither is worth moving alone", () => {
    // Ray is east for two calls; each on its own is cheap while the other keeps him there.
    const result = routing.rebalance({
      technicians: [tech("ray", "west", ["w1", "e1", "e2"]), tech("dana", "east", [])],
      visits: [visit("w1"), visit("e1"), visit("e2")],
      travel: manhattan(grid),
    });
    expect(result.moves.map((m) => m.visitId).sort()).toEqual(["e1", "e2"]);
    expect(result.moves.every((m) => m.to === "dana")).toBe(true);
  });

  it("never moves a locked visit, however far out of the way it is", () => {
    const result = routing.rebalance({
      technicians: [tech("ray", "west", ["w1", "e1"]), tech("dana", "east", ["e2"])],
      visits: [visit("w1"), visit("e1", { locked: true }), visit("e2")],
      travel: manhattan(grid),
    });
    expect(result.moves).toEqual([]);
    expect(result.after.find((d) => d.technicianId === "ray")!.evaluation.order).toContain("e1");
  });

  it("never gives work to somebody refused it, and moves it off them when it can", () => {
    const refused = { ray: null, dana: "Dana is not recorded as doing gas work." };
    const result = routing.rebalance({
      technicians: [tech("ray", "west", ["w1"]), tech("dana", "east", ["e1"])],
      visits: [visit("w1"), visit("e1", { refusals: refused })],
      travel: manhattan(grid),
    });
    expect(result.before.find((d) => d.technicianId === "dana")!.refused).toEqual(["e1"]);
    expect(result.moves).toEqual([{ visitId: "e1", from: "dana", to: "ray" }]);
  });

  it("does not move work for a saving smaller than the notices cost", () => {
    // e1 is one minute nearer Dana's day than Ray's end, not worth two notices.
    const near: Grid = { a: [0, 0], b: [10, 0], x: [5, 0] };
    const result = routing.rebalance({
      technicians: [
        { technicianId: "ray", start: "a", end: "a", departAt: 0, shift: shift(), order: ["x"] },
        { technicianId: "dana", start: "b", end: "b", departAt: 0, shift: shift(), order: [] },
      ],
      visits: [visit("x")],
      travel: manhattan(near),
    });
    expect(result.moves).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("places the unassigned pile where it fits, and keeps a window doing it", () => {
    const result = routing.rebalance({
      technicians: [tech("ray", "west", ["w1"]), tech("dana", "east", ["e1"])],
      visits: [visit("w1"), visit("e1"), visit("open", { stop: stop("open", 30, 0, 30) })],
      travel: manhattan(grid),
    });
    expect(result.moves).toEqual([{ visitId: "open", from: null, to: "dana" }]);
    expect(result.after.find((d) => d.technicianId === "dana")!.evaluation.order[0]).toBe("open");
    expect(result.unplaced).toEqual([]);
  });

  it("leaves a visit nobody can reach in time unplaced, and says where it came nearest", () => {
    const result = routing.rebalance({
      technicians: [tech("ray", "west", []), tech("dana", "east", [])],
      visits: [visit("e1", { stop: stop("e1", 30, 0, 5) })],
      travel: manhattan(grid),
    });
    expect(result.unplaced).toHaveLength(1);
    expect(result.unplaced[0]).toMatchObject({ visitId: "e1", why: "would_break" });
    expect(result.unplaced[0]!.nearest?.technicianId).toBe("dana");
  });

  it("will not plan past the overtime limit to empty the pile", () => {
    const result = routing.rebalance({
      technicians: [{ technicianId: "ray", start: "west", end: "west", departAt: 0, shift: shift(100, 0), order: [] }],
      visits: [{ stop: stop("e1", 30), locked: false, refusals: { ray: null } }],
      travel: manhattan(grid),
    });
    expect(result.unplaced[0]).toMatchObject({ visitId: "e1", why: "would_break" });
    expect(result.unplaced[0]!.nearest!.overLimitMinutes).toBeGreaterThan(0);
  });

  it("says nobody may take it when everybody is refused", () => {
    const result = routing.rebalance({
      technicians: [tech("ray", "west", [])],
      visits: [visit("w1", { refusals: { ray: "Ray is off today." } })],
      travel: manhattan(grid),
    });
    expect(result.unplaced).toEqual([{ visitId: "w1", why: "nobody_may", refusals: ["Ray is off today."], nearest: null }]);
  });

  it("gives the same proposal every time for the same day", () => {
    const input = {
      technicians: [tech("ray", "west", ["e2", "w1", "e1"]), tech("dana", "east", ["w2"])],
      visits: [visit("w1"), visit("w2"), visit("e1"), visit("e2")],
      travel: manhattan(grid),
    };
    expect(routing.rebalance(input)).toEqual(routing.rebalance(input));
  });
});

describe("a locked stop in one technician's order", () => {
  it("keeps its place while the rest are reordered around it", () => {
    const grid: Grid = { yard: [0, 0], a: [30, 0], b: [10, 0], c: [20, 0] };
    const plan: routing.DayPlan = {
      start: "yard", end: "yard", departAt: 0, travel: manhattan(grid),
      stops: [stop("a"), stop("b"), stop("c")],
    };
    const free = routing.optimise(plan, ["a", "b", "c"]);
    expect(free.proposed.order[0]).not.toBe("a");
    const pinned = routing.optimise(plan, ["a", "b", "c"], { pinned: new Set(["a"]) });
    expect(pinned.proposed.order[0]).toBe("a");
  });
});
