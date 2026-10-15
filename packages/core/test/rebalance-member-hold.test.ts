import { describe, it, expect } from "vitest";
import { routing } from "../src/index";

/**
 * THE SHARE OF A PERSON'S WINDOW HELD FOR MEMBERS, KEPT BY THE REBALANCES
 *
 * The planners are told, per person a visit for somebody who is not a member
 * could newly go to, how many such visits that person's window still takes
 * outside the share kept for members. They count every visit they put on
 * somebody new against it, never fill it past that, and name the hold when a
 * visit cannot go anywhere else. Stops on a line, drives as the distance in
 * minutes, as in rebalance.test.ts.
 */

type Grid = Record<string, [number, number]>;
const manhattan = (grid: Grid): routing.Travel => (from, to) => {
  const a = grid[from.replace(/^(start|end):.*$/, "yard")] ?? grid[from]!;
  const b = grid[to.replace(/^(start|end):.*$/, "yard")] ?? grid[to]!;
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
};
const stop = (id: string, serviceMinutes = 30) => ({ id, serviceMinutes, windowStart: null, windowEnd: null });
const shift = (): routing.Shift => ({ endsAt: 540, maxOvertimeMinutes: 60, lunch: null });
const grid: Grid = { west: [0, 0], east: [100, 0], yard: [0, 0], w1: [10, 0], e1: [90, 0], e2: [95, 0], e3: [92, 0] };
const tech = (technicianId: string, start: string, order: string[]): routing.RebalanceTechnician => ({
  technicianId, start, end: start, departAt: 0, shift: shift(), order,
});
const danaMorning = (room: number): routing.HeldRoom => ({
  key: "dana|2026-05-05|morning", room,
  reason: "Dana's time in the Morning window on 2026-05-05 is kept for members, and Sid is not a member there that day.",
});

describe("the hold counted across routes", () => {
  it("finds the first room filled past what it takes, counting every holder that uses it", () => {
    const held: Record<string, Record<string, routing.HeldRoom[]>> = {
      a: { dana: [danaMorning(1)] },
      b: { crew: [danaMorning(1)] },
    };
    const heldOf = (id: string, holder: string) => held[id]?.[holder];
    expect(routing.holdBreach(new Map([["dana", ["a"]], ["crew", []]]), heldOf)).toBeNull();
    expect(routing.holdBreach(new Map([["dana", ["a"]], ["crew", ["b"]]]), heldOf)?.key).toBe("dana|2026-05-05|morning");
    /** A visit on a holder it uses no room on is not counted. */
    expect(routing.holdBreach(new Map([["ray", ["a", "b"]]]), heldOf)).toBeNull();
  });
});

describe("rebalancing one day", () => {
  it("does not hand a stranger's visit to somebody whose room outside the hold is gone", () => {
    /** Ray is west with a call on the east side, beside Dana; Dana's morning keeps its last place for members. */
    const result = routing.rebalance({
      technicians: [tech("ray", "west", ["w1", "e1"]), tech("dana", "east", ["e2"])],
      visits: [
        { stop: stop("w1"), locked: false, refusals: { ray: null, dana: null } },
        { stop: stop("e1"), locked: false, refusals: { ray: null, dana: null }, held: { dana: [danaMorning(0)] } },
        { stop: stop("e2"), locked: false, refusals: { ray: null, dana: null } },
      ],
      travel: manhattan(grid),
    });
    expect(result.moves).toEqual([]);
  });

  it("moves as many onto them as their room takes, and no more", () => {
    /** Ray has three long calls out east and runs past the overtime allowed; Dana is east with nothing. */
    const plan = (room: number | null) => routing.rebalance({
      technicians: [tech("ray", "west", ["e1", "e2", "e3"]), tech("dana", "east", [])],
      visits: ["e1", "e2", "e3"].map((id) => ({
        stop: stop(id, 200), locked: false, refusals: { ray: null, dana: null },
        ...(room === null ? {} : { held: { dana: [danaMorning(room)] } }),
      })),
      travel: manhattan(grid),
    });
    expect(plan(null).moves.filter((m) => m.to === "dana").length).toBeGreaterThan(1);
    expect(plan(1).moves).toHaveLength(1);
    expect(plan(1).moves[0]!.to).toBe("dana");
    expect(plan(0).moves).toEqual([]);
  });

  it("leaves a waiting visit nobody can take outside the hold where it is, with the hold in words", () => {
    const result = routing.rebalance({
      technicians: [tech("dana", "east", [])],
      visits: [{ stop: stop("e1"), locked: false, refusals: { dana: null }, held: { dana: [danaMorning(0)] } }],
      travel: manhattan(grid),
    });
    expect(result.moves).toEqual([]);
    expect(result.unplaced).toEqual([{
      visitId: "e1", why: "nobody_may", nearest: null,
      refusals: ["Dana's time in the Morning window on 2026-05-05 is kept for members, and Sid is not a member there that day."],
    }]);
  });

  it("places a waiting visit on somebody else who has room", () => {
    const result = routing.rebalance({
      technicians: [tech("ray", "west", []), tech("dana", "east", [])],
      visits: [{ stop: stop("e1"), locked: false, refusals: { ray: null, dana: null }, held: { dana: [danaMorning(0)] } }],
      travel: manhattan(grid),
    });
    expect(result.moves).toEqual([{ visitId: "e1", from: null, to: "ray" }]);
  });
});

describe("rebalancing several days", () => {
  const TUE = "2026-05-05";
  const THU = "2026-05-07";
  const person = (date: string, technicianId: string, order: string[], endsAt = 540): routing.RebalanceTechnician => ({
    technicianId, start: `start:${date}:${technicianId}`, end: `end:${date}:${technicianId}`, departAt: 0,
    shift: { endsAt, maxOvertimeMinutes: 60, lunch: null }, order,
  });

  it("does not move a stranger's visit onto a person's day whose room outside the hold is gone", () => {
    /** Ray's Tuesday runs past the overtime allowed; e may go to Thursday, where Ray's morning keeps its last place for members. */
    const rayThursday: routing.HeldRoom = { key: `ray|${THU}|morning`, room: 0, reason: "Kept for members." };
    const plan = (held: routing.HeldRoom[] | null) => routing.rebalanceDays({
      days: [
        { date: TUE, technicians: [person(TUE, "ray", ["a", "b", "c", "d", "e"])], travel: manhattan({ yard: [0, 0], a: [30, 0], b: [60, 0], c: [90, 0], d: [120, 0], e: [150, 0] }) },
        { date: THU, technicians: [person(THU, "ray", [])], travel: manhattan({ yard: [0, 0], a: [30, 0], b: [60, 0], c: [90, 0], d: [120, 0], e: [150, 0] }) },
      ],
      visits: ["a", "b", "c", "d", "e"].map((id) => ({
        id, date: TUE, locked: false,
        options: [
          { date: TUE, stop: stop(id, 90), refusals: { ray: null } },
          ...(id === "e" ? [{ date: THU, stop: stop(id, 90), refusals: { ray: null }, ...(held ? { heldOn: { ray: held } } : {}) }] : []),
        ],
      })),
    });
    expect(plan(null).dayMoves.map((m) => m.visitId)).toEqual(["e"]);
    expect(plan([rayThursday]).dayMoves).toEqual([]);
    expect(plan([{ ...rayThursday, room: 1 }]).dayMoves.map((m) => m.visitId)).toEqual(["e"]);
  });
});
