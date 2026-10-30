import { describe, it, expect } from "vitest";
import { time } from "@opentradesos/core";
import { windowOn } from "../src/services/dispatch-days";
import type * as dm from "../src/services/dispatch-map";

/**
 * A VISIT MOVED OFF THE DAY THE CLOCKS CHANGE KEEPS ITS CLOCK TIME
 *
 * Moving a visit to another day keeps the time on the clock. On the day the
 * clocks go back, eight in the morning is nine hours after midnight, and the
 * move used to copy nine hours onto the next day, so the visit landed at nine.
 * Fixed dates, so this does not depend on when the suite runs.
 */
const ZONE = "America/Chicago";
const visitAt = (date: string, startHour: number, endHour: number) => ({
  windowStart: time.instantOfLocal(date, startHour * 60, ZONE),
  windowEnd: time.instantOfLocal(date, endHour * 60, ZONE),
}) as unknown as dm.DayVisit;
const dayOf = (date: string) => ({ date, zone: ZONE, origin: time.instantOfLocal(date, 0, ZONE) }) as unknown as dm.Day;

describe("moving a visit across a clock change", () => {
  it("keeps eight in the morning when it leaves the day the clocks go back", () => {
    const moved = windowOn(visitAt("2027-11-07", 8, 17), dayOf("2027-11-07"), "2027-11-08", ZONE);
    expect(moved.start.toISOString()).toBe(time.instantOfLocal("2027-11-08", 8 * 60, ZONE).toISOString());
    expect(time.minutesInDay(moved.start, ZONE)).toBe(8 * 60);
  });

  it("keeps eight in the morning when it leaves the day the clocks go forward", () => {
    const moved = windowOn(visitAt("2027-03-14", 8, 17), dayOf("2027-03-14"), "2027-03-15", ZONE);
    expect(time.minutesInDay(moved.start, ZONE)).toBe(8 * 60);
  });

  it("keeps eight in the morning when it moves onto either day", () => {
    expect(time.minutesInDay(windowOn(visitAt("2027-11-06", 8, 17), dayOf("2027-11-06"), "2027-11-07", ZONE).start, ZONE)).toBe(8 * 60);
    expect(time.minutesInDay(windowOn(visitAt("2027-03-13", 8, 17), dayOf("2027-03-13"), "2027-03-14", ZONE).start, ZONE)).toBe(8 * 60);
  });

  it("keeps the length of the visit", () => {
    const moved = windowOn(visitAt("2027-11-07", 8, 17), dayOf("2027-11-07"), "2027-11-08", ZONE);
    expect(moved.end!.getTime() - moved.start.getTime()).toBe(9 * 3_600_000);
  });
});
