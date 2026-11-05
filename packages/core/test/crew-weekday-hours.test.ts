import { describe, it, expect } from "vitest";
import { crewHoursOn, checkCrewWeekdayHours } from "../src/routing/crew-hours.js";

/** 2027-06-18 is a Friday, 2027-06-19 a Saturday, 2027-06-21 a Monday. */
const FRI = "2027-06-18";
const SAT = "2027-06-19";
const MON = "2027-06-21";

describe("a crew's hours on a date", () => {
  const crew = {
    workday: { startsAt: "06:00", endsAt: "14:00" },
    weekdayHours: [{ dayOfWeek: 5, startsAt: "06:00", endsAt: "12:00" }, { dayOfWeek: 6, startsAt: "07:00", endsAt: "11:00" }],
  };

  it("reads the weekday's own hours first", () => {
    expect(crewHoursOn(crew, FRI)).toEqual({ hours: { startsAt: "06:00", endsAt: "12:00" }, from: "weekday" });
    expect(crewHoursOn(crew, SAT)).toEqual({ hours: { startsAt: "07:00", endsAt: "11:00" }, from: "weekday" });
  });

  it("falls back to the crew's one set of hours, then the company's day", () => {
    expect(crewHoursOn(crew, MON)).toEqual({ hours: { startsAt: "06:00", endsAt: "14:00" }, from: "own" });
    expect(crewHoursOn({ workday: null, weekdayHours: crew.weekdayHours }, MON)).toEqual({ hours: null, from: "company" });
    expect(crewHoursOn({ workday: null }, FRI)).toEqual({ hours: null, from: "company" });
  });

  it("does not read hours that make no sense", () => {
    expect(crewHoursOn({ workday: null, weekdayHours: [{ dayOfWeek: 5, startsAt: "12:00", endsAt: "06:00" }] }, FRI).from).toBe("company");
  });
});

describe("checking a crew's hours by weekday", () => {
  it("sorts them Sunday first", () => {
    const check = checkCrewWeekdayHours([{ dayOfWeek: 6, startsAt: "07:00", endsAt: "11:00" }, { dayOfWeek: 1, startsAt: "06:00", endsAt: "14:00" }]);
    expect(check.ok && check.hours.map((h) => h.dayOfWeek)).toEqual([1, 6]);
  });

  it("refuses a day twice, a time that is not one, and a day that ends before it starts, in words", () => {
    expect(checkCrewWeekdayHours([{ dayOfWeek: 1, startsAt: "06:00", endsAt: "14:00" }, { dayOfWeek: 1, startsAt: "07:00", endsAt: "15:00" }]))
      .toEqual({ ok: false, message: "Monday is given twice. Give each day its hours once." });
    expect(checkCrewWeekdayHours([{ dayOfWeek: 2, startsAt: "6am", endsAt: "14:00" }]))
      .toEqual({ ok: false, message: "Tuesday's hours are two times of day, HH:MM." });
    expect(checkCrewWeekdayHours([{ dayOfWeek: 6, startsAt: "11:00", endsAt: "07:00" }]))
      .toEqual({ ok: false, message: "Saturday's working day has to end after it starts." });
    expect(checkCrewWeekdayHours([{ dayOfWeek: 7, startsAt: "06:00", endsAt: "14:00" }]).ok).toBe(false);
  });
});
