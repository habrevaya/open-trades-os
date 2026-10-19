import { describe, it, expect } from "vitest";
import { routing } from "../src/index";

/**
 * A ROUTE'S FIT ON THE REAL DAY: the servicer's own hours, less their leave,
 * against the day's work.
 */
const eightToFour = { start: 8 * 60, end: 16 * 60 };

describe("a route's fit on the real day", () => {
  it("fits a day inside the hours left, and refuses one past them by how much", () => {
    expect(routing.realDayFit({ window: eightToFour, leave: [], totalMinutes: 290, travelComplete: true }))
      .toEqual({ leaveMinutes: 0, offAllDay: false, availableMinutes: 480, fits: true, overBy: null });
    // An afternoon off from noon leaves four hours.
    expect(routing.realDayFit({ window: eightToFour, leave: [{ start: 12 * 60, end: 18 * 60 }], totalMinutes: 290, travelComplete: true }))
      .toEqual({ leaveMinutes: 240, offAllDay: false, availableMinutes: 240, fits: false, overBy: 50 });
  });

  it("refuses a day the servicer is off for all of it, with or without known hours", () => {
    expect(routing.realDayFit({ window: eightToFour, leave: [{ start: 0, end: 1440 }], totalMinutes: 10, travelComplete: true }))
      .toMatchObject({ offAllDay: true, fits: false, availableMinutes: 0 });
    expect(routing.realDayFit({ window: null, leave: [{ start: 0, end: 1440 }], totalMinutes: 10, travelComplete: true }))
      .toMatchObject({ offAllDay: true, fits: false, availableMinutes: null });
  });

  it("cannot say with no hours known, or with a floor inside the hours", () => {
    expect(routing.realDayFit({ window: null, leave: [], totalMinutes: 290, travelComplete: true }).fits).toBeNull();
    expect(routing.realDayFit({ window: eightToFour, leave: [], totalMinutes: 290, travelComplete: false }).fits).toBeNull();
    // A floor already past the hours is a real refusal.
    expect(routing.realDayFit({ window: eightToFour, leave: [], totalMinutes: 500, travelComplete: false }))
      .toMatchObject({ fits: false, overBy: 20 });
  });

  it("counts overlapping leave once, and only inside the window", () => {
    expect(routing.coveredMinutes([{ start: 600, end: 720 }, { start: 660, end: 780 }, { start: 0, end: 300 }], eightToFour)).toBe(180);
    expect(routing.coveredMinutes([], eightToFour)).toBe(0);
  });
});
