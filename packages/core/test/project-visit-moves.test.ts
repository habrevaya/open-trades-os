import { describe, it, expect } from "vitest";
import * as project from "../src/project/index.js";
import { instantOfLocal } from "../src/time/index.js";

/**
 * M12. VISITS ALREADY BOOKED ON THE PHASES A CHANGE ORDER MOVES.
 *
 * Each goes by the phase's days at the same time of day in the company's
 * calendar, and stays where it is, named with the reason, when somebody on
 * it is off or booked then, when it has started, or when its time has gone.
 */
const ZONE = "America/Chicago";
const at = (date: string, hour: number) => instantOfLocal(date, hour * 60, ZONE);
const now = at("2027-03-01", 9);
const ray = { id: "ray", name: "Ray Ortiz" };
const nia = { id: "nia", name: "Nia Osei" };

const visit = (id: string, date: string, over: Partial<project.BookedVisit> = {}): project.BookedVisit => ({
  id, phaseId: "drywall", label: `Visit ${id}`, status: "dispatched",
  start: at(date, 8), end: at(date, 12), minutes: 240, people: [ray], ...over,
});

const plan = (visits: project.BookedVisit[], extra: Partial<Parameters<typeof project.planVisitMoves>[0]> = {}) =>
  project.planVisitMoves({
    visits, shiftDays: new Map([["drywall", 5]]), timeZone: ZONE, now, away: [], busy: [], ...extra,
  });

describe("visits on a phase a change order moves", () => {
  it("move by the phase's days at the same time of day, across a change of the clocks", () => {
    /** 8 March 2027 is before the clocks go forward on the 14th; the 15th is after. */
    const { moves, left } = plan([visit("a", "2027-03-10")]);
    expect(left).toEqual([]);
    expect(moves[0]).toMatchObject({ id: "a", start: at("2027-03-15", 8), end: at("2027-03-15", 12), people: ["Ray Ortiz"] });
    expect(project.shiftInstant(at("2027-03-10", 8), 5, ZONE).toISOString()).toBe("2027-03-15T13:00:00.000Z");
  });

  it("leave a phase that does not move, and the days' own phase, where they are", () => {
    const { moves, left } = plan([visit("a", "2027-03-10", { phaseId: "framing" })]);
    expect(moves).toEqual([]);
    expect(left).toEqual([]);
  });

  it("stay where they are, named, when somebody on them is off or booked at the new time", () => {
    const { moves, left } = plan([visit("a", "2027-03-10"), visit("b", "2027-03-11", { people: [nia] })], {
      away: [{ personId: "ray", start: at("2027-03-15", 0), end: at("2027-03-16", 0) }],
      busy: [{ personId: "nia", visitId: "elsewhere", start: at("2027-03-16", 10), end: at("2027-03-16", 11) }],
    });
    expect(moves).toEqual([]);
    expect(left.map((l) => [l.id, l.reason])).toEqual([
      ["a", "Ray Ortiz is off at the new time, so it stays where it is."],
      ["b", "Nia Osei is booked on another visit at the new time, so it stays where it is."],
    ]);
  });

  it("do not count each other as booked, since they move together", () => {
    const { moves } = plan([visit("a", "2027-03-10"), visit("b", "2027-03-15")], {
      busy: [{ personId: "ray", visitId: "b", start: at("2027-03-15", 8), end: at("2027-03-15", 12) }],
    });
    expect(moves.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("stay when started or gone by, and are not mentioned when finished or called off", () => {
    const { moves, left } = plan([
      visit("started", "2027-03-02", { status: "working" }),
      visit("past", "2027-02-27"),
      visit("done", "2027-03-03", { status: "completed" }),
      visit("off", "2027-03-03", { status: "cancelled" }),
    ]);
    expect(moves).toEqual([]);
    expect(left.map((l) => l.id).sort()).toEqual(["past", "started"]);
    /** Days taken off: a visit would move to before now and stays. */
    const back = plan([visit("soon", "2027-03-03")], { shiftDays: new Map([["drywall", -5]]) });
    expect(back.left[0]?.reason).toMatch(/already gone by/);
  });
});
