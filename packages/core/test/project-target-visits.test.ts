import { describe, it, expect } from "vitest";
import * as project from "../src/project/index.js";
import { instantOfLocal } from "../src/time/index.js";

/**
 * M12. THE VISITS ON THE PHASE A CHANGE ORDER'S DAYS LAND ON.
 *
 * Drywall runs 10 to 19 March 2027 and the change order lands on it. Its
 * visits from the day the change pushes out go by the days, as the moved
 * phases' visits do and with the same refusals; the ones before stay. Days
 * taken off come off from that day: a visit on one of them stays, named.
 */
const ZONE = "America/Chicago";
const at = (date: string, hour: number) => instantOfLocal(date, hour * 60, ZONE);
const now = at("2027-03-01", 9);
const ray = { id: "ray", name: "Ray Ortiz" };
const drywall = { name: "Drywall", startsOn: "2027-03-10", endsOn: "2027-03-19" };

const visit = (id: string, date: string, over: Partial<project.BookedVisit> = {}): project.BookedVisit => ({
  id, phaseId: "drywall", label: `Visit ${id}`, status: "dispatched",
  start: at(date, 8), end: at(date, 12), minutes: 240, people: [ray], ...over,
});

const plan = (visits: project.BookedVisit[], from: string, days: number, extra: Partial<Parameters<typeof project.planVisitMoves>[0]> = {}) =>
  project.planVisitMoves({
    visits, shiftDays: new Map(), timeZone: ZONE, now, away: [], busy: [],
    target: { phaseId: "drywall", from, days }, ...extra,
  });

describe("the day the days land from", () => {
  it("is the day after the phase when nobody chose one for days added, and its last days for days taken off", () => {
    expect(project.landingFrom(drywall, 3, undefined)).toEqual({ ok: true, from: "2027-03-20" });
    expect(project.landingFrom(drywall, -2, null)).toEqual({ ok: true, from: "2027-03-18" });
  });

  it("is refused in words outside the phase", () => {
    expect(project.landingFrom(drywall, 3, "2027-03-09")).toEqual({
      ok: false, reason: "Choose a day from 2027-03-10 to 2027-03-20, while Drywall runs, for where the extra days start.",
    });
    expect(project.landingFrom(drywall, -2, "2027-03-19")).toMatchObject({ ok: false });
    expect(project.landingFrom(drywall, 3, "2027-03-14")).toEqual({ ok: true, from: "2027-03-14" });
  });
});

describe("visits on the phase the days land on", () => {
  it("move from the day the change pushes out, by the days, and stay before it", () => {
    const { moves, left } = plan([visit("before", "2027-03-12"), visit("on", "2027-03-14"), visit("after", "2027-03-17")], "2027-03-14", 3);
    expect(left).toEqual([]);
    expect(moves.map((m) => [m.id, m.start])).toEqual([["on", at("2027-03-17", 8)], ["after", at("2027-03-20", 8)]]);
  });

  it("move nothing inside the phase with the default day", () => {
    const { moves, left } = plan([visit("a", "2027-03-12"), visit("b", "2027-03-19")], "2027-03-20", 3);
    expect(moves).toEqual([]);
    expect(left).toEqual([]);
  });

  it("are held to the same refusals as the moved phases' visits, and do not count each other as booked", () => {
    const { moves, left } = plan([visit("a", "2027-03-14"), visit("b", "2027-03-17")], "2027-03-14", 3, {
      busy: [
        { personId: "ray", visitId: "b", start: at("2027-03-17", 8), end: at("2027-03-17", 12) },
        { personId: "ray", visitId: "elsewhere", start: at("2027-03-20", 9), end: at("2027-03-20", 10) },
      ],
    });
    expect(moves.map((m) => m.id)).toEqual(["a"]);
    expect(left).toEqual([expect.objectContaining({ id: "b", reason: "Ray Ortiz is booked on another visit at the new time, so it stays where it is." })]);
  });

  it("stay, named, on the days taken off, and come in by the days after them", () => {
    const { moves, left } = plan(
      [visit("before", "2027-03-12"), visit("off", "2027-03-15"), visit("after", "2027-03-18")],
      "2027-03-14", -2,
    );
    expect(left.map((l) => [l.id, l.reason])).toEqual([
      ["off", "It is on a day the change order takes off, so it stays for the office to sort out."],
    ]);
    expect(moves.map((m) => [m.id, m.start])).toEqual([["after", at("2027-03-16", 8)]]);
  });
});
