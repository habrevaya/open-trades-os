import { describe, it, expect } from "vitest";
import { routing } from "../src/index";

/**
 * A ROLL OFF DRIVER'S DAY, ORDERED BY WHAT IS ON THE TRUCK
 *
 * The yard at the origin, sites along a line, drives as the distance in
 * minutes, ten minutes at the yard to tip and load. Minutes from eight in
 * the morning.
 */

type Grid = Record<string, [number, number]>;
const grid: Grid = { yard: [0, 0], p1: [20, 0], d1: [25, 0], p2: [40, 0], d2: [45, 0], s1: [30, 0], x: [10, 0] };
const travel: routing.Travel = (from, to) => {
  const a = grid[from]!;
  const b = grid[to]!;
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
};
const stop = (id: string, work: routing.TruckWork, windowStart: number | null = null, windowEnd: number | null = null): routing.TruckStop =>
  ({ id, work, serviceMinutes: 15, windowStart, windowEnd });
const plan = (stops: routing.TruckStop[], capacity = 1, load: routing.TruckLoad | null = null): routing.TruckPlan => ({
  start: "yard", end: "yard", yard: "yard", departAt: 0, travel, stops, capacity, yardMinutes: 10, load,
});

describe("what the truck can serve", () => {
  it("drops and swaps need an empty on board; collections need room", () => {
    expect(routing.canServe("drop", { empties: 0, fulls: 0 }, 1)).toBe(false);
    expect(routing.canServe("drop", { empties: 1, fulls: 0 }, 1)).toBe(true);
    expect(routing.canServe("swap", { empties: 1, fulls: 0 }, 1)).toBe(true);
    expect(routing.canServe("pickup", { empties: 1, fulls: 0 }, 1)).toBe(false);
    expect(routing.canServe("pickup", { empties: 0, fulls: 0 }, 1)).toBe(true);
    expect(routing.canServe("pickup", { empties: 1, fulls: 0 }, 2)).toBe(true);
    expect(routing.canServe("dump_return", { empties: 0, fulls: 1 }, 1)).toBe(false);
    expect(routing.canServe("none", { empties: 0, fulls: 1 }, 1)).toBe(true);
  });

  it("leaves the yard with as many empties as get it furthest, and no more", () => {
    expect(routing.loadFor(["drop", "pickup"], 1)).toBe(1);
    expect(routing.loadFor(["pickup", "drop"], 1)).toBe(0);
    expect(routing.loadFor(["drop", "drop", "pickup"], 2)).toBe(2);
    expect(routing.loadFor(["pickup", "drop"], 2)).toBe(1);
    expect(routing.loadFor(["none"], 2)).toBe(0);
  });
});

describe("walking a driver's day", () => {
  it("goes back to the yard between a collection and a drop, and counts the drive", () => {
    const p = plan([stop("p1", "pickup"), stop("d1", "drop")]);
    const day = routing.evaluateTruck(p, ["p1", "d1"]);
    /** Leaves empty for the collection, tips it and loads an empty, then drops. */
    expect(day.startLoad).toEqual({ empties: 0, fulls: 0 });
    expect(day.yardRuns).toEqual([{ afterId: "p1", beforeId: "d1", tipped: 1, loaded: 1, arriveAt: 55 }]);
    // yard 20 p1 (15 on site) 20 back, 10 at the yard, 25 to d1, 15, 25 home.
    expect(day.driveMinutes).toBe(20 + 20 + 25 + 25);
    expect(day.finishAt).toBe(20 + 15 + 20 + 10 + 25 + 15 + 25);
  });

  it("drops first when the truck leaves loaded, so a collection can follow with no yard run between", () => {
    const p = plan([stop("p1", "pickup"), stop("d1", "drop")]);
    const day = routing.evaluateTruck(p, ["d1", "p1"]);
    expect(day.startLoad).toEqual({ empties: 1, fulls: 0 });
    /** The only yard run is the one at the end of the day, to tip the can collected. */
    expect(day.yardRuns).toEqual([{ afterId: "p1", beforeId: null, tipped: 1, loaded: 0, arriveAt: 25 + 15 + 5 + 15 + 20 }]);
    expect(day.driveMinutes).toBe(25 + 5 + 20);
  });

  it("swaps with an empty on board and comes back with a full one", () => {
    const day = routing.evaluateTruck(plan([stop("s1", "swap"), stop("d1", "drop")]), ["s1", "d1"]);
    expect(day.startLoad).toEqual({ empties: 1, fulls: 0 });
    expect(day.yardRuns[0]).toMatchObject({ afterId: "s1", beforeId: "d1", tipped: 1, loaded: 1 });
  });

  it("carries two cans on a truck that holds two, and needs no yard run between", () => {
    const day = routing.evaluateTruck(plan([stop("d1", "drop"), stop("d2", "drop")], 2), ["d1", "d2"]);
    expect(day.startLoad).toEqual({ empties: 2, fulls: 0 });
    expect(day.yardRuns).toEqual([]);
  });

  it("starts from what is on the truck when the day is already under way", () => {
    const p = plan([stop("d1", "drop")], 1, { empties: 0, fulls: 1 });
    const day = routing.evaluateTruck(p, ["d1"]);
    expect(day.yardRuns[0]).toMatchObject({ afterId: null, beforeId: "d1", tipped: 1, loaded: 1 });
  });
});

describe("ordering a driver's day", () => {
  it("puts the drops before the collections when that saves the trips back to the yard", () => {
    /** As booked: collect, drop, collect, drop: three runs to the yard in the middle of the day. */
    const stops = [stop("p1", "pickup"), stop("d1", "drop"), stop("p2", "pickup"), stop("d2", "drop")];
    const proposal = routing.optimiseTruck(plan(stops), ["p1", "d1", "p2", "d2"]);
    expect(proposal.current.yardRuns.filter((r) => r.beforeId !== null)).toHaveLength(2);
    expect(proposal.improved).toBe(true);
    expect(proposal.proposed.driveMinutes).toBeLessThan(proposal.current.driveMinutes);
    /** Never a collection straight before a drop with nothing between them but the road. */
    const order = proposal.proposed.order;
    for (let i = 0; i + 1 < order.length; i++) {
      const here = stops.find((s) => s.id === order[i])!;
      const next = stops.find((s) => s.id === order[i + 1])!;
      if (here.work === "pickup" && next.work === "drop") {
        expect(proposal.proposed.yardRuns.some((r) => r.afterId === here.id && r.beforeId === next.id)).toBe(true);
      }
    }
  });

  it("keeps a customer's window ahead of the truck's convenience", () => {
    /** The collection at p2 must be reached by thirty minutes past eight. */
    const stops = [stop("d1", "drop"), stop("p2", "pickup", 0, 45)];
    const proposal = routing.optimiseTruck(plan(stops), ["d1", "p2"]);
    expect(proposal.proposed.order[0]).toBe("p2");
    expect(proposal.proposed.late).toEqual([]);
  });

  it("leaves other work where the truck does not matter", () => {
    const proposal = routing.optimiseTruck(plan([stop("x", "none"), stop("d1", "drop")]), ["x", "d1"]);
    expect(proposal.proposed.yardRuns).toEqual([]);
  });

  it("gives the same order for the same day", () => {
    const stops = [stop("p1", "pickup"), stop("d1", "drop"), stop("p2", "pickup"), stop("d2", "drop"), stop("s1", "swap")];
    const a = routing.optimiseTruck(plan(stops), ["p1", "d1", "p2", "d2", "s1"]);
    const b = routing.optimiseTruck(plan(stops), ["p1", "d1", "p2", "d2", "s1"]);
    expect(a.proposed.order).toEqual(b.proposed.order);
  });
});
