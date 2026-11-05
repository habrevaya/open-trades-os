import { describe, it, expect } from "vitest";
import {
  occurrenceOnOrBefore, occurrenceAfter, occurrenceToRaise, describeSchedule, checkSchedule,
  type TaskSchedule,
} from "../src/tasks/index.js";

/**
 * A TASK ONCE A YEAR, ON A MONTH AND A DAY
 *
 * Renew the contractor licence every March 1. The 29th of February is raised on
 * the 28th in a year that has no 29th, the earlier of the two.
 */
const licence: TaskSchedule = { frequency: "yearly", yearMonth: 3, monthDay: 1, startsOn: "2026-01-01" };
const leapDay: TaskSchedule = { frequency: "yearly", yearMonth: 2, monthDay: 29, startsOn: "2026-01-01" };

describe("a yearly task", () => {
  it("is on its date and the latest one is the one raised", () => {
    expect(occurrenceOnOrBefore(licence, "2026-03-01")).toBe("2026-03-01");
    expect(occurrenceOnOrBefore(licence, "2026-12-31")).toBe("2026-03-01");
    expect(occurrenceOnOrBefore(licence, "2026-02-28")).toBeNull();
    expect(occurrenceOnOrBefore(licence, "2027-02-28")).toBe("2026-03-01");
    expect(occurrenceOnOrBefore(licence, "2027-03-01")).toBe("2027-03-01");
  });

  it("shows the next one, a year on once this year's has gone", () => {
    expect(occurrenceAfter(licence, "2026-01-15")).toBe("2026-03-01");
    expect(occurrenceAfter(licence, "2026-03-01")).toBe("2027-03-01");
    expect(occurrenceAfter(licence, "2026-10-31")).toBe("2027-03-01");
  });

  it("does not raise a date before the day it starts, and does not backfill the years it missed", () => {
    const late = { ...licence, startsOn: "2026-10-31" };
    expect(occurrenceOnOrBefore(late, "2026-10-31")).toBeNull();
    expect(occurrenceAfter(late, "2026-10-31")).toBe("2027-03-01");
    // A worker down for three years raises the latest one, never each of them.
    expect(occurrenceToRaise(licence, "2029-06-01", "2026-03-01")).toBe("2029-03-01");
    expect(occurrenceToRaise(licence, "2029-06-01", "2029-03-01")).toBeNull();
  });

  it("puts the 29th of February on the 28th in a year without one, and on the 29th in a leap year", () => {
    expect(occurrenceOnOrBefore(leapDay, "2027-03-05")).toBe("2027-02-28");
    expect(occurrenceOnOrBefore(leapDay, "2027-02-27")).toBe("2026-02-28");
    expect(occurrenceAfter(leapDay, "2026-10-31")).toBe("2027-02-28");
    expect(occurrenceAfter(leapDay, "2027-10-31")).toBe("2028-02-29");
    expect(occurrenceOnOrBefore(leapDay, "2028-02-28")).toBe("2027-02-28");
    expect(occurrenceOnOrBefore(leapDay, "2028-02-29")).toBe("2028-02-29");
    expect(occurrenceAfter(leapDay, "2028-02-29")).toBe("2029-02-28");
  });

  it("says itself in words, and says what happens on a leap day", () => {
    expect(describeSchedule(licence)).toBe("Every year on March 1");
    expect(describeSchedule({ ...licence, yearMonth: 12, monthDay: 31 })).toBe("Every year on December 31");
    expect(describeSchedule(leapDay))
      .toBe("Every year on February 29, or on February 28 in a year without a February 29");
  });

  it("is refused without a month or a day, or with a day the month never has", () => {
    expect(checkSchedule(licence)).toEqual({ ok: true });
    expect(checkSchedule(leapDay)).toEqual({ ok: true });
    expect(checkSchedule({ ...licence, yearMonth: null })).toMatchObject({ ok: false, message: /month it comes round in/ });
    expect(checkSchedule({ ...licence, yearMonth: 13 })).toMatchObject({ ok: false });
    expect(checkSchedule({ ...licence, monthDay: null })).toMatchObject({ ok: false, message: /day of the month/ });
    expect(checkSchedule({ ...licence, yearMonth: 4, monthDay: 31 })).toMatchObject({ ok: false, message: /April has no day 31/ });
    expect(checkSchedule({ ...licence, yearMonth: 2, monthDay: 30 })).toMatchObject({ ok: false, message: /February has no day 30/ });
  });
});
