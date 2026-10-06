import { describe, it, expect } from "vitest";
import {
  occurrenceOnOrBefore, occurrenceAfter, occurrenceToRaise, describeSchedule, checkSchedule, cleanDays,
  weekdayOf, type TaskSchedule,
} from "../src/tasks/index.js";

// 2026-10-05 is a Monday. October 2026 starts on a Thursday.
const MONDAY = "2026-10-05";

describe("the first, second, third or fourth given weekday of the month", () => {
  const firstMonday: TaskSchedule = { frequency: "nth_weekday_of_month", weekday: 1, monthWeek: 1, startsOn: "2026-01-01" };
  const thirdThursday: TaskSchedule = { frequency: "nth_weekday_of_month", weekday: 4, monthWeek: 3, startsOn: "2026-01-01" };

  it("is the first Monday of the month, whichever date that is", () => {
    expect(weekdayOf("2026-10-05")).toBe(1);
    expect(occurrenceOnOrBefore(firstMonday, "2026-10-05")).toBe("2026-10-05");
    expect(occurrenceOnOrBefore(firstMonday, "2026-10-31")).toBe("2026-10-05");
    // November 2026 starts on a Sunday, so its first Monday is the 2nd.
    expect(occurrenceOnOrBefore(firstMonday, "2026-11-02")).toBe("2026-11-02");
    expect(occurrenceAfter(firstMonday, "2026-10-05")).toBe("2026-11-02");
  });

  it("goes back to last month before this month's has come", () => {
    // The first Monday of September 2026 is the 7th.
    expect(occurrenceOnOrBefore(firstMonday, "2026-10-04")).toBe("2026-09-07");
    expect(occurrenceAfter(firstMonday, "2026-10-01")).toBe("2026-10-05");
  });

  it("counts the third Thursday from the first one of the month", () => {
    // October 2026: Thursdays are the 1st, 8th, 15th, 22nd and 29th.
    expect(occurrenceOnOrBefore(thirdThursday, "2026-10-15")).toBe("2026-10-15");
    expect(occurrenceOnOrBefore(thirdThursday, "2026-10-14")).toBe("2026-09-17");
    expect(occurrenceAfter(thirdThursday, "2026-10-15")).toBe("2026-11-19");
  });

  it("has a fourth one in every month, February included", () => {
    const fourthSaturday: TaskSchedule = { frequency: "nth_weekday_of_month", weekday: 6, monthWeek: 4, startsOn: "2026-01-01" };
    // February 2026 starts on a Sunday: its Saturdays are the 7th, 14th, 21st and 28th.
    expect(occurrenceOnOrBefore(fourthSaturday, "2026-02-28")).toBe("2026-02-28");
    expect(occurrenceAfter(fourthSaturday, "2026-02-28")).toBe("2026-03-28");
  });

  it("raises nothing before the day it starts", () => {
    const late = { ...firstMonday, startsOn: "2026-10-06" };
    expect(occurrenceOnOrBefore(late, "2026-10-31")).toBeNull();
    expect(occurrenceAfter(late, "2026-10-06")).toBe("2026-11-02");
  });

  it("is read back as an owner would say it", () => {
    expect(describeSchedule(firstMonday)).toBe("On the first Monday of every month");
    expect(describeSchedule(thirdThursday)).toBe("On the third Thursday of every month");
  });

  it("needs a day of the week and which one, first to fourth", () => {
    expect(checkSchedule({ frequency: "nth_weekday_of_month", monthWeek: 1, startsOn: MONDAY }).ok).toBe(false);
    expect(checkSchedule({ frequency: "nth_weekday_of_month", weekday: 1, startsOn: MONDAY }).ok).toBe(false);
    expect(checkSchedule({ frequency: "nth_weekday_of_month", weekday: 1, monthWeek: 5, startsOn: MONDAY }).ok).toBe(false);
    expect(checkSchedule({ frequency: "nth_weekday_of_month", weekday: 1, monthWeek: 0, startsOn: MONDAY }).ok).toBe(false);
    expect(checkSchedule(firstMonday)).toEqual({ ok: true });
  });
});

describe("every so many weeks", () => {
  // Starting on Monday 5 October, every third Monday: 5 Oct, 26 Oct, 16 Nov.
  const everyThird: TaskSchedule = { frequency: "every_n_weeks", weekday: 1, intervalWeeks: 3, startsOn: MONDAY };

  it("counts from the first such weekday on or after the day it starts", () => {
    expect(occurrenceOnOrBefore(everyThird, MONDAY)).toBe(MONDAY);
    expect(occurrenceOnOrBefore(everyThird, "2026-10-25")).toBe(MONDAY);
    expect(occurrenceOnOrBefore(everyThird, "2026-10-26")).toBe("2026-10-26");
    expect(occurrenceOnOrBefore(everyThird, "2026-11-15")).toBe("2026-10-26");
    expect(occurrenceOnOrBefore(everyThird, "2026-11-16")).toBe("2026-11-16");
    expect(occurrenceAfter(everyThird, MONDAY)).toBe("2026-10-26");
    expect(occurrenceAfter(everyThird, "2026-10-26")).toBe("2026-11-16");
  });

  it("starts on the weekday after the start day when the start day is another weekday", () => {
    const wed = { ...everyThird, startsOn: "2026-10-07" };
    expect(occurrenceOnOrBefore(wed, "2026-10-11")).toBeNull();
    expect(occurrenceOnOrBefore(wed, "2026-10-12")).toBe("2026-10-12");
    expect(occurrenceAfter(wed, "2026-10-08")).toBe("2026-10-12");
    expect(occurrenceAfter(wed, "2026-10-12")).toBe("2026-11-02");
  });

  it("is every other week when the gap is two, counted the same way", () => {
    const two: TaskSchedule = { frequency: "every_n_weeks", weekday: 1, intervalWeeks: 2, startsOn: MONDAY };
    const other: TaskSchedule = { frequency: "every_other_week", weekday: 1, startsOn: MONDAY };
    for (const day of ["2026-10-05", "2026-10-12", "2026-10-19", "2026-11-01", "2026-11-02", "2027-01-04"]) {
      expect(occurrenceOnOrBefore(two, day)).toBe(occurrenceOnOrBefore(other, day));
      expect(occurrenceAfter(two, day)).toBe(occurrenceAfter(other, day));
    }
  });

  it("raises the latest one after a worker was down, not every one it missed", () => {
    expect(occurrenceToRaise(everyThird, "2026-12-01", MONDAY)).toBe("2026-11-16");
    expect(occurrenceToRaise(everyThird, "2026-12-01", "2026-11-16")).toBeNull();
  });

  it("is read back with the gap and the day", () => {
    expect(describeSchedule(everyThird)).toBe("Every 3 weeks on Monday");
  });

  it("needs a gap of two to fifty two weeks and a day", () => {
    expect(checkSchedule({ ...everyThird, intervalWeeks: 1 }).ok).toBe(false);
    expect(checkSchedule({ ...everyThird, intervalWeeks: 53 }).ok).toBe(false);
    expect(checkSchedule({ ...everyThird, intervalWeeks: 2.5 }).ok).toBe(false);
    expect(checkSchedule({ ...everyThird, intervalWeeks: null }).ok).toBe(false);
    expect(checkSchedule({ ...everyThird, weekday: null }).ok).toBe(false);
    expect(checkSchedule({ ...everyThird, intervalWeeks: 52 })).toEqual({ ok: true });
  });
});

describe("these weekdays", () => {
  // Monday, Wednesday and Saturday.
  const crew: TaskSchedule = { frequency: "chosen_weekdays", daysOfWeek: [6, 1, 3], startsOn: "2026-01-01" };

  it("is today on a chosen day, and the latest chosen day before it otherwise", () => {
    expect(occurrenceOnOrBefore(crew, MONDAY)).toBe(MONDAY);
    expect(occurrenceOnOrBefore(crew, "2026-10-06")).toBe(MONDAY);
    expect(occurrenceOnOrBefore(crew, "2026-10-07")).toBe("2026-10-07");
    expect(occurrenceOnOrBefore(crew, "2026-10-09")).toBe("2026-10-07");
    expect(occurrenceOnOrBefore(crew, "2026-10-10")).toBe("2026-10-10");
    // Sunday belongs to the Saturday before it.
    expect(occurrenceOnOrBefore(crew, "2026-10-11")).toBe("2026-10-10");
  });

  it("goes to the next chosen day", () => {
    expect(occurrenceAfter(crew, MONDAY)).toBe("2026-10-07");
    expect(occurrenceAfter(crew, "2026-10-07")).toBe("2026-10-10");
    expect(occurrenceAfter(crew, "2026-10-10")).toBe("2026-10-12");
  });

  it("can be a weekend only schedule, which weekdays only cannot", () => {
    const weekend: TaskSchedule = { frequency: "chosen_weekdays", daysOfWeek: [0, 6], startsOn: "2026-01-01" };
    expect(occurrenceOnOrBefore(weekend, "2026-10-09")).toBe("2026-10-04");
    expect(occurrenceAfter(weekend, MONDAY)).toBe("2026-10-10");
  });

  it("is every day of the week with all seven chosen", () => {
    const all: TaskSchedule = { frequency: "chosen_weekdays", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startsOn: "2026-01-01" };
    expect(occurrenceOnOrBefore(all, "2026-10-08")).toBe("2026-10-08");
    expect(occurrenceAfter(all, "2026-10-08")).toBe("2026-10-09");
  });

  it("raises nothing before the day it starts, and starts on the first chosen day after", () => {
    const late = { ...crew, startsOn: "2026-10-08" };
    expect(occurrenceOnOrBefore(late, "2026-10-09")).toBeNull();
    expect(occurrenceOnOrBefore(late, "2026-10-10")).toBe("2026-10-10");
    expect(occurrenceAfter(late, "2026-10-01")).toBe("2026-10-10");
  });

  it("is read back Monday first", () => {
    expect(describeSchedule(crew)).toBe("Every Monday, Wednesday and Saturday");
    expect(describeSchedule({ frequency: "chosen_weekdays", daysOfWeek: [2], startsOn: MONDAY })).toBe("Every Tuesday");
    expect(describeSchedule({ frequency: "chosen_weekdays", daysOfWeek: [0, 1], startsOn: MONDAY })).toBe("Every Monday and Sunday");
  });

  it("needs at least one real day, and keeps each once", () => {
    expect(checkSchedule({ frequency: "chosen_weekdays", daysOfWeek: [], startsOn: MONDAY }).ok).toBe(false);
    expect(checkSchedule({ frequency: "chosen_weekdays", startsOn: MONDAY }).ok).toBe(false);
    expect(checkSchedule({ frequency: "chosen_weekdays", daysOfWeek: [7], startsOn: MONDAY }).ok).toBe(false);
    expect(checkSchedule(crew)).toEqual({ ok: true });
    expect(cleanDays([6, 1, 3, 1, 9])).toEqual([1, 3, 6]);
  });
});
