import { describe, it, expect } from "vitest";
import { routing, rental } from "../src/index";

/**
 * SEVERAL DISPOSAL FACILITIES, CHOSEN AMONG HAUL BY HAUL, AND THE HOLIDAYS A
 * FACILITY KEEPS
 *
 * A line of places, the drive between two as the distance between them in
 * minutes, minutes counted from the start of the day: the yard at 0, a
 * collection at 20, a drop at 25, and facilities at the other positions.
 */

const line: Record<string, number> = { yard: 0, p1: 20, d1: 25, near: 30, mid: 45, far: 90, x: 10 };
const drive: routing.Travel = (from, to) => Math.abs(line[from]! - line[to]!);
const stop = (id: string, work: routing.TruckWork): routing.TruckStop =>
  ({ id, work, serviceMinutes: 15, windowStart: null, windowEnd: null });
const fac = (key: string, extra: Partial<routing.TruckFacility> = {}): routing.TruckFacility =>
  ({ key, name: key, minutes: 15, hours: null, ...extra });
const day = (facilities: routing.TruckFacility[], stops = [stop("p1", "pickup"), stop("d1", "drop")]): routing.TruckPlan => ({
  start: "yard", end: "yard", yard: "yard", departAt: 0, travel: drive, stops, capacity: 1, yardMinutes: 10, load: null,
  facilities,
});

describe("each haul goes to the nearest facility that is open", () => {
  it("takes the nearest of several, and says what else it considered", () => {
    const evaluation = routing.evaluateTruck(day([fac("far"), fac("near"), fac("mid")]), ["p1", "d1"]);
    expect(evaluation.facilityRuns).toHaveLength(1);
    const run = evaluation.facilityRuns[0]!;
    expect(run.facilityKey).toBe("near");
    expect(run.choice).toMatchObject({ basis: "nearest_open", driveMinutes: 10 });
    expect(run.choice!.others.map((o) => [o.key, o.driveMinutes, o.standing])).toEqual([
      ["mid", 25, "open"], ["far", 70, "open"],
    ]);
  });

  it("chooses from where the truck is, so two hauls of one day can go to different places", () => {
    // The collection at 20 is nearest the "near" station; the second one, at the far end, is nearest "far".
    const spread: Record<string, number> = { ...line, p2: 85, d2: 80 };
    const there: routing.Travel = (from, to) => Math.abs(spread[from]! - spread[to]!);
    const plan: routing.TruckPlan = {
      ...day([fac("near"), fac("far")], [stop("p1", "pickup"), stop("d1", "drop"), stop("p2", "pickup"), stop("d2", "drop")]),
      travel: there,
    };
    const run = routing.evaluateTruck(plan, ["p1", "d1", "p2", "d2"]);
    expect(run.facilityRuns.map((r) => [r.afterId, r.beforeId, r.facilityKey])).toEqual([
      ["p1", "d1", "near"], ["p2", "d2", "far"],
    ]);
  });

  it("skips one shut all day, even a nearer one, and says so", () => {
    const evaluation = routing.evaluateTruck(
      day([fac("near", { hours: "closed", closedWhy: "closed for Thanksgiving" }), fac("mid")]), ["p1", "d1"]);
    const run = evaluation.facilityRuns[0]!;
    expect(run.facilityKey).toBe("mid");
    expect(run.closedBy).toBe(0);
    expect(run.choice!.others).toEqual([expect.objectContaining({ key: "near", standing: "closed_all_day" })]);
  });

  it("skips one the truck would reach after it has closed", () => {
    // The truck is at the near station at minute 45; it closed at 40. Mid is open until the evening.
    const evaluation = routing.evaluateTruck(
      day([fac("near", { hours: { opensAt: 0, closesAt: 40 } }), fac("mid", { hours: { opensAt: 0, closesAt: 600 } })]), ["p1", "d1"]);
    expect(evaluation.facilityRuns[0]).toMatchObject({ facilityKey: "mid", closedBy: 0 });
    expect(evaluation.facilityRuns[0]!.choice!.others[0]).toMatchObject({ key: "near", standing: "closed_by_then", closesAt: 40 });
  });

  it("lets a gate about to open beat a farther one that is open now, but not one that opens hours later", () => {
    // Near opens at 50, so the truck waits 5 minutes and tips at 50: sooner than driving to mid (45 + 25 = tipped at 60... arrive 60).
    const soon = routing.evaluateTruck(
      day([fac("near", { hours: { opensAt: 50, closesAt: 600 } }), fac("mid", { hours: { opensAt: 0, closesAt: 600 } })]), ["p1", "d1"]);
    expect(soon.facilityRuns[0]).toMatchObject({ facilityKey: "near", waitMinutes: 5 });
    const late = routing.evaluateTruck(
      day([fac("near", { hours: { opensAt: 300, closesAt: 600 } }), fac("mid", { hours: { opensAt: 0, closesAt: 600 } })]), ["p1", "d1"]);
    expect(late.facilityRuns[0]!.facilityKey).toBe("mid");
    expect(late.facilityRuns[0]!.choice!.others[0]).toMatchObject({ key: "near", standing: "opens_later", opensAt: 300 });
  });

  it("when none is open yet, takes the one whose gate opens first and waits there", () => {
    const evaluation = routing.evaluateTruck(
      day([fac("near", { hours: { opensAt: 300, closesAt: 600 } }), fac("mid", { hours: { opensAt: 200, closesAt: 600 } })]), ["p1", "d1"]);
    expect(evaluation.facilityRuns[0]).toMatchObject({ facilityKey: "mid", closedBy: 0 });
    expect(evaluation.facilityRuns[0]!.choice!.basis).toBe("opens_soonest");
    expect(evaluation.facilityRuns[0]!.waitMinutes).toBeGreaterThan(0);
  });

  it("when every one is shut, takes the nearest and refuses the run as a single facility would", () => {
    const evaluation = routing.evaluateTruck(day([
      fac("near", { hours: "closed" }), fac("mid", { hours: "closed" }), fac("far", { hours: { opensAt: 0, closesAt: 10 } }),
    ]), ["p1", "d1"]);
    const run = evaluation.facilityRuns[0]!;
    // Reached after closing beats shut all day: that one is at least a day the gate was open.
    expect(run.facilityKey).toBe("far");
    expect(run.choice!.basis).toBe("none_open");
    expect(run.closedBy).toBeGreaterThan(0);
    const allShut = routing.evaluateTruck(day([fac("near", { hours: "closed" }), fac("mid", { hours: "closed" })]), ["p1", "d1"]);
    expect(allShut.facilityRuns[0]).toMatchObject({ facilityKey: "near", closedBy: 1440 });
    expect(routing.optimiseTruck(day([fac("near", { hours: "closed" })]), ["p1", "d1"]).facilityClosed).toHaveLength(1);
  });

  it("breaks a tie on drive time for the company's default, then by key, the same every time", () => {
    const both = [fac("b", { preferred: false }), fac("a", { preferred: false })];
    const tie: Record<string, number> = { ...line, a: 30, b: 10 };
    const t: routing.Travel = (from, to) => Math.abs(tie[from]! - tie[to]!);
    const plan = (facilities: routing.TruckFacility[]): routing.TruckPlan => ({ ...day(facilities), travel: t });
    expect(routing.evaluateTruck(plan(both), ["p1", "d1"]).facilityRuns[0]!.facilityKey).toBe("a");
    const preferred = [fac("b", { preferred: true }), fac("a")];
    expect(routing.evaluateTruck(plan(preferred), ["p1", "d1"]).facilityRuns[0]!.facilityKey).toBe("b");
    expect(routing.evaluateTruck(plan(both), ["p1", "d1"]).facilityRuns[0]).toEqual(routing.evaluateTruck(plan(both), ["p1", "d1"]).facilityRuns[0]);
  });

  it("is a single facility exactly as before when the plan names one", () => {
    const single: routing.TruckPlan = { ...day([]), facilities: undefined, facility: fac("near") };
    const run = routing.evaluateTruck(single, ["p1", "d1"]).facilityRuns[0]!;
    expect(run).toEqual({ afterId: "p1", beforeId: "d1", tipped: 1, arriveAt: 45, waitMinutes: 0, closedBy: 0 });
    // A list of one is the same day, with the choice written down.
    const listed = routing.evaluateTruck(day([fac("near")]), ["p1", "d1"]).facilityRuns[0]!;
    expect(listed).toMatchObject({ arriveAt: 45, facilityKey: "near", choice: { basis: "only_one" } });
  });

  it("orders the day around the facilities it can reach, and gives the same order every time", () => {
    const plan = day([fac("near", { hours: "closed" }), fac("mid")], [stop("x", "none"), stop("p1", "pickup"), stop("d1", "drop")]);
    const a = routing.optimiseTruck(plan, ["x", "p1", "d1"]);
    const b = routing.optimiseTruck(plan, ["x", "p1", "d1"]);
    expect(a.proposed.order).toEqual(b.proposed.order);
    expect(a.proposed.facilityRuns.every((r) => r.facilityKey === "mid")).toBe(true);
    expect(a.facilityClosed).toEqual([]);
  });
});

describe("the holidays a facility keeps", () => {
  it("keeps real dates, each closure once, and names which one is wrong", () => {
    expect(rental.checkHolidays([
      { date: "2026-12-25", name: " Christmas ", yearly: true }, { date: "2026-11-26", name: "Thanksgiving", yearly: false },
    ])).toEqual({
      ok: true,
      holidays: [{ date: "2026-11-26", name: "Thanksgiving", yearly: false }, { date: "2026-12-25", name: "Christmas", yearly: true }],
    });
    expect(rental.checkHolidays([{ date: "2026-02-30", name: null, yearly: false }])).toMatchObject({ ok: false, message: expect.stringContaining("2026-02-30 is not a date") });
    expect(rental.checkHolidays([{ date: "11/26/2026", name: null, yearly: false }])).toMatchObject({ ok: false });
    expect(rental.checkHolidays([
      { date: "2026-12-25", name: null, yearly: false }, { date: "2026-12-25", name: null, yearly: false },
    ])).toMatchObject({ ok: false, message: "2026-12-25 is listed twice." });
    // A yearly closure already covers the same day of another year.
    expect(rental.checkHolidays([
      { date: "2026-12-25", name: null, yearly: true }, { date: "2027-12-25", name: null, yearly: false },
    ])).toMatchObject({ ok: false, message: "2027-12-25 is listed twice." });
    expect(rental.checkHolidays([{ date: "2026-12-25", name: "x".repeat(81), yearly: false }])).toMatchObject({ ok: false });
    expect(rental.checkHolidays(Array.from({ length: 61 }, (_, i) => ({
      date: `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + Math.floor(i / 12)).padStart(2, "0")}`, name: null, yearly: false,
    })))).toMatchObject({ ok: false, message: expect.stringContaining("up to 60") });
  });

  it("finds a holiday by its date, or by its month and day when it repeats", () => {
    const list: rental.FacilityHoliday[] = [
      { date: "2026-11-26", name: "Thanksgiving", yearly: false }, { date: "2026-12-25", name: "Christmas", yearly: true },
    ];
    expect(rental.holidayOn(list, "2026-11-26")?.name).toBe("Thanksgiving");
    expect(rental.holidayOn(list, "2027-11-26")).toBeNull();
    expect(rental.holidayOn(list, "2031-12-25")?.name).toBe("Christmas");
  });

  it("closes a facility on a holiday whatever its week says, even with no hours recorded", () => {
    const hours: rental.DayHours[] = [{ day: 4, opens: "07:00", closes: "16:30" }];
    const list: rental.FacilityHoliday[] = [{ date: "2026-11-26", name: "Thanksgiving", yearly: false }];
    // 2026-11-26 is a Thursday, a day its week says it is open.
    expect(rental.closedWords("Austin Transfer", hours, 4, 9 * 60)).toBeNull();
    expect(rental.closedOnWords("Austin Transfer", hours, list, "2026-11-26", 9 * 60))
      .toBe("Austin Transfer is closed on Thursday 2026-11-26 for Thanksgiving. If that is wrong, take the day off the facility's holidays.");
    expect(rental.closedOnWords("Unrecorded Yard", [], list, "2026-11-26", 9 * 60)).toContain("is closed on Thursday");
    // Another Thursday falls back to the week.
    expect(rental.closedOnWords("Austin Transfer", hours, list, "2026-12-03", 9 * 60)).toBeNull();
    expect(rental.closedOnWords("Austin Transfer", hours, list, "2026-12-03", 17 * 60)).toContain("is closed at 5:00 PM on Thursday");
    expect(rental.shutAllDayWhy(hours, list, "2026-11-26")).toBe("closed for Thanksgiving");
    expect(rental.shutAllDayWhy(hours, list, "2026-11-27")).toBe("closed on Fridays");
    expect(rental.shutAllDayWhy(hours, list, "2026-12-03")).toBeNull();
    expect(rental.shutAllDayWhy([], [], "2026-12-03")).toBeNull();
  });
});

describe("saying why a haul goes where it goes", () => {
  const names: Record<string, { name: string; shutWhy: string | null }> = {
    near: { name: "Austin Transfer", shutWhy: "closed for Thanksgiving" },
    mid: { name: "Round Rock Landfill", shutWhy: null },
    far: { name: "Bastrop Landfill", shutWhy: null },
  };
  const describe_ = (key: string) => names[key]!;
  it("names the facility, its distance, and each one passed over with its reason", () => {
    const words = rental.chosenWords("Round Rock Landfill", {
      basis: "nearest_open", driveMinutes: 25,
      others: [
        { key: "near", driveMinutes: 10, standing: "closed_all_day", opensAt: null, closesAt: null },
        { key: "far", driveMinutes: 70, standing: "open", opensAt: 0, closesAt: 600 },
      ],
    }, describe_);
    expect(words).toBe("Round Rock Landfill is the nearest one open when the truck gets there, 25 min by road. "
      + "Austin Transfer is closed for Thanksgiving. The others are farther.");
  });
  it("says a gate not yet open, one closed by then, a wait, and a refusal", () => {
    expect(rental.chosenWords("Round Rock Landfill", {
      basis: "nearest_open", driveMinutes: 25,
      others: [
        { key: "near", driveMinutes: 10, standing: "opens_later", opensAt: 14 * 60, closesAt: 17 * 60 },
        { key: "far", driveMinutes: 70, standing: "closed_by_then", opensAt: 0, closesAt: 15 * 60 + 30 },
      ],
    }, describe_)).toBe("Round Rock Landfill is the nearest one open when the truck gets there, 25 min by road. "
      + "Austin Transfer does not open until 2:00 PM. Bastrop Landfill would be closed by then (it closes at 3:30 PM).");
    expect(rental.chosenWords("Round Rock Landfill", { basis: "opens_soonest", driveMinutes: 25, others: [] }, describe_))
      .toBe("None is open yet when the truck gets there. Round Rock Landfill opens first, 25 min by road, so the truck waits at its gate.");
    expect(rental.chosenWords("Austin Transfer", { basis: "none_open", driveMinutes: 10, others: [] }, describe_))
      .toBe("Every facility is shut when the truck would get there. Austin Transfer is the nearest, 10 min by road, so the run is refused.");
    expect(rental.chosenWords("Austin Transfer", { basis: "only_one", driveMinutes: 10, others: [] }, describe_))
      .toBe("Austin Transfer is the only facility on the map, 10 min by road.");
  });
});
