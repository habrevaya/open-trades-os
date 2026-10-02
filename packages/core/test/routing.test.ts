import { describe, it, expect } from "vitest";
import { routing } from "../src/index";

/**
 * THE ROUTE OPTIMISER
 *
 * Stops are placed on a grid and a drive is the Manhattan distance between
 * two of them in minutes, so every expected figure below can be checked with
 * a pencil. Minutes count from eight in the morning: 0 is 8:00, 120 is 10:00.
 */

type Grid = Record<string, [number, number]>;

const manhattan = (grid: Grid): routing.Travel => (from, to) => {
  const a = grid[from]!;
  const b = grid[to]!;
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
};

const stop = (id: string, serviceMinutes = 30, windowStart: number | null = null, windowEnd: number | null = null) =>
  ({ id, serviceMinutes, windowStart, windowEnd });

function plan(grid: Grid, stops: routing.PlanStop[], departAt = 0): routing.DayPlan {
  return { start: "yard", end: "yard", departAt, stops, travel: manhattan(grid) };
}

describe("walking a day", () => {
  const grid: Grid = { yard: [0, 0], a: [10, 0], b: [20, 0] };

  it("adds the drives, the work and the drive home", () => {
    const day = routing.evaluate(plan(grid, [stop("a"), stop("b")]), ["a", "b"]);
    expect(day.driveMinutes).toBe(10 + 10 + 20);
    expect(day.finishAt).toBe(10 + 30 + 10 + 30 + 20);
    expect(day.late).toEqual([]);
  });

  it("waits outside for a window to open rather than calling it late", () => {
    const day = routing.evaluate(plan(grid, [stop("a", 30, 60, 120)]), ["a"]);
    expect(day.arrivals[0]).toMatchObject({ arriveAt: 10, startAt: 60, leaveAt: 90, lateBy: 0 });
    expect(day.waitMinutes).toBe(50);
  });

  it("counts arriving after the window closed as late, by how much", () => {
    const day = routing.evaluate(plan(grid, [stop("a", 30), stop("b", 30, 0, 20)]), ["a", "b"]);
    // a at 10, done 40, b at 50 against a window closing at 20.
    expect(day.late).toEqual([{ id: "b", lateBy: 30 }]);
    expect(day.lateMinutes).toBe(30);
  });

  it("costs nothing for an empty day, not a drive to nowhere and back", () => {
    const day = routing.evaluate(plan(grid, []), []);
    expect(day.driveMinutes).toBe(0);
    expect(day.finishAt).toBe(0);
  });

  it("refuses an order naming a stop that is not in the day", () => {
    expect(() => routing.evaluate(plan(grid, [stop("a")]), ["a", "zzz"])).toThrow(RangeError);
  });
});

describe("proposing an order", () => {
  it("undoes a day that zig zags, to the shortest drive there is", () => {
    /**
     * Five houses, booked in the order the phone rang. With no windows the
     * best order is whatever drives least, and five stops is few enough to
     * check every one of the hundred and twenty orders by brute force.
     */
    const grid: Grid = { yard: [0, 0], a: [10, 0], b: [20, 0], c: [20, 10], d: [5, 10], e: [30, 5] };
    const ids = ["a", "b", "c", "d", "e"];
    const day = plan(grid, ids.map((id) => stop(id)));
    const result = routing.optimise(day, ["c", "a", "e", "d", "b"]);

    const permutations = (rest: string[]): string[][] => rest.length <= 1
      ? [rest]
      : rest.flatMap((head, i) => permutations([...rest.slice(0, i), ...rest.slice(i + 1)]).map((tail) => [head, ...tail]));
    const shortest = Math.min(...permutations(ids).map((order) => routing.evaluate(day, order).driveMinutes));

    expect(result.proposed.driveMinutes).toBe(shortest);
    expect(result.proposed.driveMinutes).toBeLessThan(result.current.driveMinutes);
    expect([...result.proposed.order].sort()).toEqual(ids);
    expect(result.improved).toBe(true);
    expect(result.missed).toEqual([]);
  });

  it("hands a day back unchanged when nothing beats it", () => {
    const grid: Grid = { yard: [0, 0], a: [10, 0], b: [20, 0] };
    const result = routing.optimise(plan(grid, [stop("a"), stop("b")]), ["a", "b"]);
    expect(result.improved).toBe(false);
    expect(result.proposed).toBe(result.current);
  });

  it("drives further to keep a promise", () => {
    /**
     * The far house was promised before nine. The short drive visits the near
     * one first and gets there at 9:20; the proposal goes far first, drives
     * more, and keeps the window.
     */
    const grid: Grid = { yard: [0, 0], near: [10, 0], far: [0, 40] };
    const day = plan(grid, [stop("near", 60), stop("far", 30, 0, 60)]);
    const shortest = routing.evaluate(day, ["near", "far"]);
    expect(shortest.late.map((l) => l.id)).toEqual(["far"]);

    const result = routing.optimise(day, ["near", "far"]);
    expect(result.proposed.order).toEqual(["far", "near"]);
    expect(result.proposed.late).toEqual([]);
    expect(result.proposed.driveMinutes).toBeGreaterThanOrEqual(shortest.driveMinutes);
  });

  it("does not drag the van across town to wait for an afternoon window", () => {
    /**
     * Nearest by distance would go to the house next door whose window opens
     * at two and sit there for six hours. Nearest in time does the morning
     * work first.
     */
    const grid: Grid = { yard: [0, 0], afternoon: [1, 0], m1: [15, 0], m2: [20, 0] };
    const day = plan(grid, [stop("afternoon", 30, 360, 480), stop("m1"), stop("m2")]);
    const order = routing.construct(day);
    expect(order[order.length - 1]).toBe("afternoon");
  });

  it("treats a fixed appointment as a window that opens and closes at the same minute", () => {
    const grid: Grid = { yard: [0, 0], a: [10, 0], b: [20, 0], appt: [5, 5] };
    const day = plan(grid, [stop("a"), stop("b"), stop("appt", 30, 120, 120)]);
    const result = routing.optimise(day, ["appt", "a", "b"]);
    const at = result.proposed.arrivals.find((a) => a.id === "appt")!;
    expect(at.startAt).toBe(120);
    expect(at.lateBy).toBe(0);
    expect(result.missed).toEqual([]);
  });

  it("reports a window it cannot meet rather than quietly breaking it", () => {
    /**
     * Two customers both promised 8:00 to 8:30, forty minutes apart. One of
     * them is going to be late in every order, and the proposal says which
     * and by how much rather than presenting a plan as if it worked.
     */
    const grid: Grid = { yard: [0, 0], east: [20, 0], west: [-20, 0] };
    const day = plan(grid, [stop("east", 30, 0, 30), stop("west", 30, 0, 30)]);
    const result = routing.optimise(day, ["east", "west"]);
    expect(result.missed).toHaveLength(1);
    // East at 20, done 50, forty to the west is 90: sixty minutes after 8:30.
    expect(result.missed[0]).toEqual({ id: "west", lateBy: 60, unreachable: false });
  });

  it("says when no order at all could have kept a window", () => {
    /**
     * Promised by 8:10 at a house half an hour from the yard. That promise was
     * broken when it was made, and saying so sends the dispatcher to the phone
     * rather than to the board.
     */
    const grid: Grid = { yard: [0, 0], far: [30, 0] };
    const result = routing.optimise(plan(grid, [stop("far", 30, 0, 10)]), ["far"]);
    expect(result.missed).toEqual([{ id: "far", lateBy: 20, unreachable: true }]);
  });

  it("starts from the time and place the plan is given", () => {
    /**
     * The service hands in the last stop already under way as the start and
     * the time it will be finished as the departure, so the work already done
     * is not moved and the rest is planned from where the van actually is.
     */
    const grid: Grid = { yard: [100, 0], a: [110, 0], b: [90, 0] };
    const day = { ...plan(grid, [stop("a"), stop("b")], 240), start: "yard", end: "yard" };
    const result = routing.optimise(day, ["a", "b"]);
    expect(result.proposed.arrivals[0]!.arriveAt).toBe(250);
  });

  it("is deterministic: the same day in gives the same order out", () => {
    const grid: Grid = { yard: [0, 0] };
    const stops: routing.PlanStop[] = [];
    // A pseudo random scatter with a fixed seed, and some ties on purpose.
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647) % 60;
    for (let i = 0; i < 14; i++) {
      grid[`s${i}`] = [next(), next()];
      stops.push(stop(`s${i}`, 20 + (i % 3) * 10, i % 4 === 0 ? 60 : null, i % 4 === 0 ? 240 : null));
    }
    grid["s13"] = grid["s12"]!;
    const day = plan(grid, stops);
    const current = stops.map((s) => s.id);
    const first = routing.optimise(day, current);
    const second = routing.optimise(day, [...current]);
    expect(second.proposed.order).toEqual(first.proposed.order);
    expect(first.proposed.driveMinutes).toBeLessThanOrEqual(first.current.driveMinutes);
  });

  it("refuses a current order that does not match the day", () => {
    const grid: Grid = { yard: [0, 0], a: [10, 0], b: [20, 0] };
    expect(() => routing.optimise(plan(grid, [stop("a"), stop("b")]), ["a"])).toThrow(RangeError);
    expect(() => routing.optimise(plan(grid, [stop("a"), stop("b")]), ["a", "a"])).toThrow(RangeError);
  });

  it("orders a long day without taking forever", () => {
    const grid: Grid = { yard: [0, 0] };
    const stops: routing.PlanStop[] = [];
    for (let i = 0; i < 40; i++) {
      grid[`p${i}`] = [(i * 37) % 50, (i * 53) % 50];
      stops.push(stop(`p${i}`, 15));
    }
    const started = Date.now();
    const result = routing.optimise(plan(grid, stops), stops.map((s) => s.id));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.proposed.driveMinutes).toBeLessThan(result.current.driveMinutes);
  });
});

describe("who should take the unassigned work", () => {
  const grid: Grid = {
    north: [0, 50], south: [0, -50],
    n1: [5, 50], s1: [5, -50],
    open: [10, 48],
  };
  const day = (technicianId: string, start: string, stops: routing.PlanStop[] = []): routing.TechnicianDay =>
    ({ technicianId, start, end: start, departAt: 0, stops });

  it("puts a visit on whoever it adds the least driving to", () => {
    const [suggestion] = routing.suggestAssignments({
      technicians: [day("t-north", "north", [stop("n1")]), day("t-south", "south", [stop("s1")])],
      visits: [{ stop: stop("open"), refusals: { "t-north": null, "t-south": null } }],
      travel: manhattan(grid),
    });
    expect(suggestion!.technicianId).toBe("t-north");
    expect(suggestion!.addedDriveMinutes).toBe(
      // yard to n1 to open and back, less yard to n1 and back.
      (5 + 7 + 12) - (5 + 5),
    );
    expect(suggestion!.considered.map((c) => c.technicianId)).toEqual(["t-north", "t-south"]);
  });

  it("skips somebody who may not take it, and says why", () => {
    const [suggestion] = routing.suggestAssignments({
      technicians: [day("t-north", "north"), day("t-south", "south")],
      visits: [{
        stop: stop("open"),
        refusals: { "t-north": "Ray cannot be sent: this work needs gas-fitting.", "t-south": null },
      }],
      travel: manhattan(grid),
    });
    expect(suggestion!.technicianId).toBe("t-south");
    expect(suggestion!.considered.find((c) => c.technicianId === "t-north")!.refused).toMatch(/gas-fitting/);
  });

  it("suggests nobody when nobody may take it", () => {
    const [suggestion] = routing.suggestAssignments({
      technicians: [day("t-north", "north")],
      visits: [{ stop: stop("open"), refusals: { "t-north": "No." } }],
      travel: manhattan(grid),
    });
    expect(suggestion!.technicianId).toBeNull();
  });

  it("prefers the technician who keeps the window over the one who drives less", () => {
    /**
     * North is closer and has a two hour job promised first thing; south is
     * further and free. The visit is promised by ten to ten, and whichever
     * order north does them in, one of the two promises breaks. South gets it.
     */
    const [suggestion] = routing.suggestAssignments({
      technicians: [
        day("t-north", "north", [stop("n1", 120, 0, 30)]),
        day("t-south", "south"),
      ],
      visits: [{ stop: stop("open", 30, 0, 110), refusals: { "t-north": null, "t-south": null } }],
      travel: manhattan(grid),
    });
    expect(suggestion!.technicianId).toBe("t-south");
    expect(suggestion!.makesLate).toEqual([]);
    expect(suggestion!.considered.find((c) => c.technicianId === "t-north")!.makesLate).toBe(true);
  });

  it("still suggests the least late when everybody would be late, and says so", () => {
    const [suggestion] = routing.suggestAssignments({
      technicians: [day("t-north", "north")],
      visits: [{ stop: stop("open", 30, 0, 5), refusals: { "t-north": null } }],
      travel: manhattan(grid),
    });
    expect(suggestion!.technicianId).toBe("t-north");
    expect(suggestion!.makesLate).toEqual([{ id: "open", lateBy: 7 }]);
  });

  it("places the second visit against the day as the first suggestion left it", () => {
    /**
     * Two open visits beside each other and one technician with room. The
     * second is placed next to the first rather than both being costed against
     * an empty day, which would count the same gap twice.
     */
    const g: Grid = { yard: [0, 0], x: [10, 0], y: [11, 0] };
    const suggestions = routing.suggestAssignments({
      technicians: [day("t", "yard")],
      visits: [
        { stop: stop("x"), refusals: { t: null } },
        { stop: stop("y"), refusals: { t: null } },
      ],
      travel: manhattan(g),
    });
    expect(suggestions.map((s) => s.technicianId)).toEqual(["t", "t"]);
    expect(suggestions[0]!.addedDriveMinutes).toBe(20);
    expect(suggestions[1]!.addedDriveMinutes).toBe(2);
  });

  it("does the visit whose window closes first, first", () => {
    const g: Grid = { yard: [0, 0], late: [10, 0], early: [12, 0] };
    const suggestions = routing.suggestAssignments({
      technicians: [day("t", "yard")],
      visits: [
        { stop: stop("late", 30, 300, 400), refusals: { t: null } },
        { stop: stop("early", 30, 0, 60), refusals: { t: null } },
      ],
      travel: manhattan(g),
    });
    expect(suggestions.map((s) => s.visitId)).toEqual(["early", "late"]);
  });

  it("does not consider a technician it was not told about", () => {
    const [suggestion] = routing.suggestAssignments({
      technicians: [day("t-north", "north"), day("t-south", "south")],
      visits: [{ stop: stop("open"), refusals: { "t-south": null } }],
      travel: manhattan(grid),
    });
    expect(suggestion!.considered.map((c) => c.technicianId)).toEqual(["t-south"]);
  });
});
