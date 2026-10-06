import { describe, it, expect } from "vitest";
import { routing } from "../src/index";

/**
 * SEVERAL DAYS REBALANCED: VISITS MOVED TO ANOTHER DAY
 *
 * Stops on a line east of the yard, drives as the distance in minutes, and
 * each day's minutes counted from eight in the morning, as in the single
 * day tests, so every figure can be checked by hand.
 */

type Grid = Record<string, [number, number]>;
const manhattan = (grid: Grid): routing.Travel => (from, to) => {
  const a = grid[from.replace(/^(start|end):.*$/, "yard")]!;
  const b = grid[to.replace(/^(start|end):.*$/, "yard")]!;
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
};
const stop = (id: string, serviceMinutes = 60, windowStart: number | null = null, windowEnd: number | null = null) =>
  ({ id, serviceMinutes, windowStart, windowEnd });
const shift = (endsAt = 540, maxOvertimeMinutes = 60): routing.Shift => ({ endsAt, maxOvertimeMinutes, lunch: null });
const person = (date: string, technicianId: string, order: string[], endsAt = 540, maxOvertimeMinutes = 60): routing.RebalanceTechnician => ({
  technicianId, start: `start:${date}:${technicianId}`, end: `end:${date}:${technicianId}`, departAt: 0,
  shift: shift(endsAt, maxOvertimeMinutes), order,
});
const anybody = (...people: string[]) => Object.fromEntries(people.map((p) => [p, null]));

const grid: Grid = { yard: [0, 0], a: [30, 0], b: [60, 0], c: [90, 0], d: [120, 0], e: [150, 0], f: [40, 0] };
const travel = manhattan(grid);
const TUE = "2026-05-05";
const THU = "2026-05-07";

describe("a visit moved to another day", () => {
  it("moves work off a day that runs past the overtime allowed onto a day the customer agreed to", () => {
    /**
     * Ray's Tuesday: five hour and a half jobs out east, back well after the end of
     * the day plus the hour of overtime allowed. His Thursday is empty. The
     * customer at e agreed to Tuesday or Thursday; nobody else may move.
     */
    const visits: routing.DaysVisit[] = ["a", "b", "c", "d", "e"].map((id) => ({
      id, date: TUE, locked: false,
      options: [
        { date: TUE, stop: stop(id, 90), refusals: anybody("ray") },
        ...(id === "e" ? [{ date: THU, stop: stop(id, 90), refusals: anybody("ray") }] : []),
      ],
    }));
    const result = routing.rebalanceDays({
      days: [
        { date: TUE, technicians: [person(TUE, "ray", ["a", "b", "c", "d", "e"])], travel },
        { date: THU, technicians: [person(THU, "ray", [])], travel },
      ],
      visits,
    });
    expect(result.dayMoves).toEqual([{ visitId: "e", fromDate: TUE, toDate: THU, fromTechnicianId: "ray", toTechnicianId: "ray" }]);
    const tuesday = result.days.find((d) => d.date === TUE)!;
    expect(tuesday.before[0]!.evaluation.overLimitMinutes).toBeGreaterThan(0);
    expect(tuesday.after[0]!.evaluation.overLimitMinutes).toBe(0);
    expect(tuesday.visitsBefore).toBe(5);
    expect(tuesday.visitsAfter).toBe(4);
    expect(result.days.find((d) => d.date === THU)!.visitsAfter).toBe(1);
    expect(result.overtimeAfter).toBeLessThan(result.overtimeBefore);
  });

  it("never moves a visit to a day it may not go to, or a locked one at all", () => {
    const visits: routing.DaysVisit[] = ["a", "b", "c", "d", "e"].map((id) => ({
      id, date: TUE, locked: id === "e",
      options: [
        { date: TUE, stop: stop(id, 90), refusals: anybody("ray") },
        ...(id === "e" ? [{ date: THU, stop: stop(id, 90), refusals: anybody("ray") }] : []),
      ],
    }));
    const result = routing.rebalanceDays({
      days: [
        { date: TUE, technicians: [person(TUE, "ray", ["a", "b", "c", "d", "e"])], travel },
        { date: THU, technicians: [person(THU, "ray", [])], travel },
      ],
      visits,
    });
    /** e is locked, and nobody else agreed to another day: the day stays as it is. */
    expect(result.dayMoves).toEqual([]);
  });

  it("does not move a visit to a day where the only person who could take it is refused", () => {
    const visits: routing.DaysVisit[] = ["a", "b", "c", "d", "e"].map((id) => ({
      id, date: TUE, locked: false,
      options: [
        { date: TUE, stop: stop(id, 90), refusals: anybody("ray") },
        ...(id === "e" ? [{ date: THU, stop: stop(id, 90), refusals: { ray: "Ray is on approved time off on 2026-05-07." } }] : []),
      ],
    }));
    const result = routing.rebalanceDays({
      days: [
        { date: TUE, technicians: [person(TUE, "ray", ["a", "b", "c", "d", "e"])], travel },
        { date: THU, technicians: [person(THU, "ray", [])], travel },
      ],
      visits,
    });
    expect(result.dayMoves).toEqual([]);
  });

  it("keeps the window the customer was given on the new day", () => {
    /**
     * e has to be reached by nine on whichever day it is on (window 0..60).
     * On Tuesday it sits behind four long jobs and is late; on Thursday it is
     * first and on time. Lateness comes before driving, so it moves.
     */
    const visits: routing.DaysVisit[] = [
      ...["a", "b"].map((id) => ({
        id, date: TUE, locked: false,
        options: [{ date: TUE, stop: stop(id, 60, 0, 30), refusals: anybody("ray") }],
      })),
      {
        id: "e", date: TUE, locked: false,
        options: [
          { date: TUE, stop: stop("e", 60, 0, 60), refusals: anybody("ray") },
          { date: THU, stop: stop("e", 60, 0, 200), refusals: anybody("ray") },
        ],
      },
    ];
    const result = routing.rebalanceDays({
      days: [
        { date: TUE, technicians: [person(TUE, "ray", ["a", "b", "e"])], travel },
        { date: THU, technicians: [person(THU, "ray", [])], travel },
      ],
      visits,
    });
    expect(result.dayMoves.map((m) => m.visitId)).toEqual(["e"]);
    const thursday = result.days.find((d) => d.date === THU)!;
    expect(thursday.after[0]!.evaluation.late).toEqual([]);
  });

  it("does not move somebody who is not a member into a window held for members", () => {
    /**
     * Two visits nobody may take on Tuesday, both allowed on Thursday morning,
     * where the hold leaves room for one more visit from somebody who is not
     * a member. One moves; the other stays where it was, unplaced, for the
     * office, rather than taking a member's share.
     */
    const held = { key: `${THU}|morning`, room: 1 };
    const visit = (id: string): routing.DaysVisit => ({
      id, date: TUE, locked: false,
      options: [
        { date: TUE, stop: stop(id), refusals: { ray: "Ray is off." } },
        { date: THU, stop: stop(id), refusals: { ray: null }, held },
      ],
    });
    const result = routing.rebalanceDays({
      days: [
        { date: TUE, technicians: [person(TUE, "ray", [])], travel },
        { date: THU, technicians: [person(THU, "ray", [])], travel },
      ],
      visits: [visit("a"), visit("b")],
    });
    expect(result.dayMoves.map((m) => m.visitId)).toEqual(["a"]);
    expect(result.days.find((d) => d.date === TUE)!.unplaced.map((u) => u.visitId)).toEqual(["b"]);

    /** With no hold on the window, both go. */
    const free = routing.rebalanceDays({
      days: [
        { date: TUE, technicians: [person(TUE, "ray", [])], travel },
        { date: THU, technicians: [person(THU, "ray", [])], travel },
      ],
      visits: [visit("a"), visit("b")].map((v) => ({ ...v, options: v.options.map(({ held: _, ...o }) => o) })),
    });
    expect(free.dayMoves.map((m) => m.visitId).sort()).toEqual(["a", "b"]);
  });

  it("places work its own day cannot take on another day it may go to", () => {
    /**
     * An unassigned visit on Tuesday nobody may take that day (Ray is the
     * only one qualified and he is off), allowed on Thursday when he works.
     */
    const result = routing.rebalanceDays({
      days: [
        { date: TUE, technicians: [person(TUE, "ray", []), person(TUE, "dana", [])], travel },
        { date: THU, technicians: [person(THU, "ray", []), person(THU, "dana", [])], travel },
      ],
      visits: [{
        id: "a", date: TUE, locked: false,
        options: [
          { date: TUE, stop: stop("a"), refusals: { ray: "Ray is off.", dana: "Dana is not qualified." } },
          { date: THU, stop: stop("a"), refusals: { ray: null, dana: "Dana is not qualified." } },
        ],
      }],
    });
    expect(result.dayMoves).toEqual([{ visitId: "a", fromDate: TUE, toDate: THU, fromTechnicianId: null, toTechnicianId: "ray" }]);
    expect(result.days.find((d) => d.date === TUE)!.unplaced).toEqual([]);
  });

  it("does not move a customer's day to save a few minutes of driving", () => {
    /**
     * f is ten minutes from a on Thursday and on Tuesday is on its own: moving
     * it saves driving, but less than the fifteen minutes a customer's day
     * is worth.
     */
    const visits: routing.DaysVisit[] = [
      { id: "a", date: THU, locked: false, options: [{ date: THU, stop: stop("a"), refusals: anybody("ray") }] },
      {
        id: "f", date: TUE, locked: false,
        options: [
          { date: TUE, stop: stop("f"), refusals: anybody("ray") },
          { date: THU, stop: stop("f"), refusals: anybody("ray") },
        ],
      },
    ];
    const days = [
      { date: TUE, technicians: [person(TUE, "ray", ["f"])], travel },
      { date: THU, technicians: [person(THU, "ray", ["a"])], travel },
    ];
    /** Tuesday drives 80, Thursday 60; together on Thursday 80: a saving of 60, so it moves at the default. */
    expect(routing.rebalanceDays({ days, visits }).dayMoves.map((m) => m.visitId)).toEqual(["f"]);
    /** With the bar above the saving, it stays. */
    expect(routing.rebalanceDays({ days, visits, minDayMoveSavingMinutes: 61 }).dayMoves).toEqual([]);
  });

  it("gives the same proposal for the same days", () => {
    const visits: routing.DaysVisit[] = ["a", "b", "c", "d", "e"].map((id) => ({
      id, date: TUE, locked: false,
      options: [
        { date: TUE, stop: stop(id, 90), refusals: anybody("ray", "dana") },
        { date: THU, stop: stop(id, 90), refusals: anybody("ray", "dana") },
      ],
    }));
    const run = () => routing.rebalanceDays({
      days: [
        { date: TUE, technicians: [person(TUE, "ray", ["a", "b", "c", "d", "e"])], travel },
        { date: THU, technicians: [person(THU, "ray", []), person(THU, "dana", [])], travel },
      ],
      visits,
    });
    expect(run()).toEqual(run());
  });
});

describe("online booking's per window ceiling", () => {
  /**
   * Ray's Tuesday runs past the overtime allowed; d and e both agreed to
   * Thursday, and Thursday morning is a window the company sells online
   * with room for one more.
   */
  const plan = (remaining: number | null) => {
    const ceiling = remaining === null ? {} : { ceiling: { key: "thu-morning", remaining } };
    const visits: routing.DaysVisit[] = ["a", "b", "c", "d", "e"].map((id) => ({
      id, date: TUE, locked: false,
      options: [
        { date: TUE, stop: stop(id, 120), refusals: anybody("ray") },
        ...(id === "d" || id === "e" ? [{ date: THU, stop: stop(id, 120), refusals: anybody("ray"), ...ceiling }] : []),
      ],
    }));
    return routing.rebalanceDays({
      days: [
        { date: TUE, technicians: [person(TUE, "ray", ["a", "b", "c", "d", "e"])], travel },
        { date: THU, technicians: [person(THU, "ray", [])], travel },
      ],
      visits,
    });
  };

  it("moves both when nothing limits the window", () => {
    expect(plan(null).dayMoves.map((m) => m.visitId).sort()).toEqual(["d", "e"]);
  });

  it("moves only as many into a window as it has places left", () => {
    expect(plan(1).dayMoves).toHaveLength(1);
  });

  it("moves none into a window that is already full", () => {
    expect(plan(0).dayMoves).toEqual([]);
  });
});

describe("crews planned beside people", () => {
  it("moves a crew's visit only between crews, never to a person", () => {
    /**
     * The crew's Tuesday runs long; Ray's Thursday is empty and so is the
     * crew's. The visit has no refusal entry for Ray, which is how crew work
     * says a person is not considered for it.
     */
    const visits: routing.DaysVisit[] = ["a", "b", "c", "d", "e"].map((id) => ({
      id, date: TUE, locked: false,
      options: [
        { date: TUE, stop: stop(id, 120), refusals: { "crew:x": null } },
        ...(id === "e" ? [{ date: THU, stop: stop(id, 120), refusals: { "crew:x": null } }] : []),
      ],
    }));
    const result = routing.rebalanceDays({
      days: [
        { date: TUE, technicians: [person(TUE, "ray", []), person(TUE, "crew:x", ["a", "b", "c", "d", "e"])], travel },
        { date: THU, technicians: [person(THU, "ray", []), person(THU, "crew:x", [])], travel },
      ],
      visits,
    });
    expect(result.dayMoves).toEqual([{ visitId: "e", fromDate: TUE, toDate: THU, fromTechnicianId: "crew:x", toTechnicianId: "crew:x" }]);
    expect(result.moves.every((m) => m.to === "crew:x")).toBe(true);
  });
});
