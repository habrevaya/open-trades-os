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

describe("each truck is its own kind", () => {
  const company = { containersPerTruck: 1, yardMinutes: 20 };

  it("runs a truck on its own kind's figures and a truck with none on the company's", () => {
    expect(routing.truckFigures(company, { containers: 2, yardMinutes: 35, sizes: [30, 10, 20, 20] }))
      .toEqual({ containers: 2, yardMinutes: 35, sizes: [10, 20, 30], source: "truck" });
    expect(routing.truckFigures(company, null))
      .toEqual({ containers: 1, yardMinutes: 20, sizes: [], source: "company" });
  });

  it("keeps a figure typed wrongly inside what the planner can reason about", () => {
    expect(routing.truckFigures(company, { containers: 9, yardMinutes: 500, sizes: [] }))
      .toMatchObject({ containers: 4, yardMinutes: 120 });
    expect(routing.truckFigures(company, { containers: 0, yardMinutes: -3, sizes: [] }))
      .toMatchObject({ containers: 1, yardMinutes: 0 });
    expect(routing.truckFigures({ containersPerTruck: 7, yardMinutes: 20 }, null).containers).toBe(4);
  });

  it("reads a size from the words written on a can, and says nothing when there is none", () => {
    expect(routing.sizeOf("20 yard")).toBe(20);
    expect(routing.sizeOf("30yd")).toBe(30);
    expect(routing.sizeOf("10 cubic yards")).toBe(10);
    expect(routing.sizeOf("Large")).toBeNull();
    expect(routing.sizeOf(null)).toBeNull();
    expect(routing.sizeOf("0 yard")).toBeNull();
  });

  it("refuses a size only when it knows both the size and what the truck lifts", () => {
    expect(routing.carries([10, 20], 20)).toBe(true);
    expect(routing.carries([10, 20], 40)).toBe(false);
    /** A truck that lists nothing lifts anything, and a can of unknown size is not refused. */
    expect(routing.carries([], 40)).toBe(true);
    expect(routing.carries(undefined, 40)).toBe(true);
    expect(routing.carries([10, 20], null)).toBe(true);
  });

  it("plans the same day differently for a truck that carries two", () => {
    const stops = [stop("d1", "drop"), stop("d2", "drop")];
    const one = routing.evaluateTruck(plan(stops, 1), ["d1", "d2"]);
    const two = routing.evaluateTruck(plan(stops, 2), ["d1", "d2"]);
    /** One can at a time goes back to the yard between the two drops; two cans at once do not. */
    expect(one.yardRuns.filter((r) => r.beforeId !== null)).toHaveLength(1);
    expect(two.yardRuns).toEqual([]);
    expect(two.driveMinutes).toBeLessThan(one.driveMinutes);
  });

  it("counts the yard's own time for each truck", () => {
    const stops = [stop("p1", "pickup"), stop("d1", "drop")];
    const quick = routing.evaluateTruck({ ...plan(stops), yardMinutes: 5 }, ["p1", "d1"]);
    const slow = routing.evaluateTruck({ ...plan(stops), yardMinutes: 45 }, ["p1", "d1"]);
    expect(slow.finishAt - quick.finishAt).toBe(40);
    expect(slow.driveMinutes).toBe(quick.driveMinutes);
  });

  it("leaves a can the truck cannot lift out of its arithmetic and names it", () => {
    /** A truck that lifts 10 and 20 yard cans, asked to drop a 40: no empty is loaded for it. */
    const stops: routing.TruckStop[] = [{ ...stop("d1", "drop"), size: 40 }, { ...stop("d2", "drop"), size: 20 }];
    const lifting: routing.TruckPlan = { ...plan(stops, 1), sizes: [10, 20] };
    const day = routing.evaluateTruck(lifting, ["d1", "d2"]);
    expect(day.startLoad).toEqual({ empties: 1, fulls: 0 });
    expect(day.yardRuns).toEqual([]);
    const proposal = routing.optimiseTruck(lifting, ["d1", "d2"]);
    expect(proposal.notCarried).toEqual(["d1"]);
    /** The same day on a truck with no limit on sizes needs the yard between the two. */
    const any = routing.optimiseTruck({ ...lifting, sizes: [] }, ["d1", "d2"]);
    expect(any.notCarried).toEqual([]);
    expect(any.proposed.yardRuns.filter((r) => r.beforeId !== null)).toHaveLength(1);
  });

  it("serves a stop with no known size on any truck", () => {
    const lifting: routing.TruckPlan = { ...plan([stop("d1", "drop")], 1), sizes: [10] };
    expect(routing.optimiseTruck(lifting, ["d1"]).notCarried).toEqual([]);
  });
});

describe("the disposal facility is a place", () => {
  /** The yard at the origin, a collection at 20, a drop at 25, the facility at 30, the same line as the rest. */
  const line: Grid = { yard: [0, 0], p1: [20, 0], d1: [25, 0], fac: [30, 0], x: [10, 0] };
  const drive: routing.Travel = (from, to) => Math.abs(line[from]![0] - line[to]![0]);
  const withFacility = (
    stops: routing.TruckStop[], facility: Partial<routing.TruckFacility> = {}, capacity = 1,
  ): routing.TruckPlan => ({
    start: "yard", end: "yard", yard: "yard", departAt: 0, travel: drive, stops, capacity, yardMinutes: 10, load: null,
    facility: { key: "fac", minutes: 15, hours: null, ...facility },
  });
  const pair = [stop("p1", "pickup"), stop("d1", "drop")];

  it("tips a full can at the facility, and the empty it leaves goes straight to the next drop", () => {
    const day = routing.evaluateTruck(withFacility(pair), ["p1", "d1"]);
    /** Yard to the collection 20, to the facility 10, to the drop 5, home 25: no run to the yard at all. */
    expect(day.driveMinutes).toBe(20 + 10 + 5 + 25);
    expect(day.yardRuns).toEqual([]);
    expect(day.facilityRuns).toEqual([{ afterId: "p1", beforeId: "d1", tipped: 1, arriveAt: 45, waitMinutes: 0, closedBy: 0 }]);
    /** The collection takes 15, the facility 15, the drop 15, and home is 25. */
    expect(day.finishAt).toBe(20 + 15 + 10 + 15 + 5 + 15 + 25);
    /** Without the facility the same day went by way of the yard and drove further. */
    const viaYard = routing.evaluateTruck({ ...withFacility(pair), facility: null }, ["p1", "d1"]);
    expect(viaYard.driveMinutes).toBe(20 + 20 + 25 + 25);
    expect(viaYard.facilityRuns).toEqual([]);
  });

  it("still goes to the yard for room, because tipping a can does not take it off the truck", () => {
    /** A full can on a truck of one, and another collection: tip it, then leave the empty at the yard. */
    const two = [stop("p1", "pickup"), stop("d1", "pickup")];
    const day = routing.evaluateTruck(withFacility(two), ["p1", "d1"]);
    expect(day.facilityRuns).toHaveLength(2);
    expect(day.facilityRuns[0]).toMatchObject({ afterId: "p1", beforeId: "d1", tipped: 1 });
    expect(day.yardRuns[0]).toMatchObject({ afterId: "p1", beforeId: "d1", tipped: 0 });
    /** The one at the end of the day tips what the last collection filled, and goes home. */
    expect(day.facilityRuns[1]).toMatchObject({ afterId: "d1", beforeId: null, tipped: 1 });
  });

  it("tips a can still on the hook at the end of the day at the facility rather than the yard", () => {
    const day = routing.evaluateTruck(withFacility([stop("p1", "pickup")]), ["p1"]);
    expect(day.facilityRuns).toEqual([{ afterId: "p1", beforeId: null, tipped: 1, arriveAt: 45, waitMinutes: 0, closedBy: 0 }]);
    expect(day.yardRuns).toEqual([]);
    expect(day.driveMinutes).toBe(20 + 10 + 30);
  });

  it("waits at the gate for a facility that has not opened", () => {
    const day = routing.evaluateTruck(withFacility(pair, { hours: { opensAt: 60, closesAt: 600 } }), ["p1", "d1"]);
    expect(day.facilityRuns[0]).toMatchObject({ arriveAt: 45, waitMinutes: 15, closedBy: 0 });
    expect(day.waitMinutes).toBe(15);
    expect(day.finishAt).toBe(20 + 15 + 10 + 15 + 15 + 5 + 15 + 25);
  });

  it("refuses a facility reached after it closed, by how long, and a facility shut all day", () => {
    const late = routing.evaluateTruck(withFacility(pair, { hours: { opensAt: 0, closesAt: 40 } }), ["p1", "d1"]);
    expect(late.facilityRuns[0]).toMatchObject({ arriveAt: 45, closedBy: 5 });
    const shut = routing.evaluateTruck(withFacility(pair, { hours: "closed" }), ["p1", "d1"]);
    expect(shut.facilityRuns[0]!.closedBy).toBe(1440);
    /** Hours nobody recorded are not a reason to refuse anything. */
    expect(routing.evaluateTruck(withFacility(pair), ["p1", "d1"]).facilityRuns[0]!.closedBy).toBe(0);
  });

  it("counts a closed gate as a broken promise, so the search drives further to avoid one", () => {
    const open = routing.evaluateTruck(withFacility(pair, { hours: { opensAt: 0, closesAt: 600 } }), ["p1", "d1"]);
    const shut = routing.evaluateTruck(withFacility(pair, { hours: "closed" }), ["p1", "d1"]);
    /** The same drive and the same finish, and only the closed one is worse. */
    expect(shut.driveMinutes).toBe(open.driveMinutes);
    expect(routing.betterTruck(open, shut)).toBe(true);
    expect(routing.betterTruck(shut, open)).toBe(false);
    expect(routing.betterTruck(open, open)).toBe(false);
  });

  it("names the runs a proposal still reaches after closing, and orders the rest around the facility", () => {
    const proposal = routing.optimiseTruck(withFacility(pair, { hours: { opensAt: 0, closesAt: 40 } }), ["p1", "d1"]);
    expect(proposal.facilityClosed).toEqual([expect.objectContaining({ tipped: 1, closedBy: expect.any(Number) })]);
    /** The collection first and the facility on the way to the drop is still the shortest day. */
    expect(proposal.proposed.order).toEqual(["p1", "d1"]);
    const fine = routing.optimiseTruck(withFacility(pair, { hours: { opensAt: 0, closesAt: 600 } }), ["d1", "p1"]);
    expect(fine.facilityClosed).toEqual([]);
    expect(fine.proposed.order).toEqual(["p1", "d1"]);
    expect(fine.improved).toBe(true);
    expect(fine.proposed.driveMinutes).toBeLessThan(fine.current.driveMinutes);
  });

  it("gives the same order for the same day with a facility in it", () => {
    const stops = [stop("p1", "pickup"), stop("d1", "drop"), stop("x", "none")];
    const a = routing.optimiseTruck(withFacility(stops), ["x", "p1", "d1"]);
    const b = routing.optimiseTruck(withFacility(stops), ["x", "p1", "d1"]);
    expect(a.proposed.order).toEqual(b.proposed.order);
    expect(a.proposed.facilityRuns).toEqual(b.proposed.facilityRuns);
  });
});
