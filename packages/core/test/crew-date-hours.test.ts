import { describe, it, expect } from "vitest";
import { crewHoursOn, crewDayOffWords, checkCrewDateHours, checkCrewDaysOff } from "../src/routing/crew-hours.js";

/** 2027-06-18 is a Friday, 2027-06-19 a Saturday, 2027-06-20 a Sunday, 2027-06-21 a Monday. */
const FRI = "2027-06-18";
const SAT = "2027-06-19";
const SUN = "2027-06-20";
const MON = "2027-06-21";

describe("a crew's hours on one date, and its days off", () => {
  const crew = {
    workday: { startsAt: "06:00", endsAt: "14:00" },
    weekdayHours: [{ dayOfWeek: 6, startsAt: "07:00", endsAt: "11:00" }],
    daysOff: [0],
    dateHours: [
      { date: FRI, off: false, startsAt: "05:00", endsAt: "18:00" },
      { date: MON, off: true, startsAt: null, endsAt: null },
      { date: "2027-06-27", off: false, startsAt: "08:00", endsAt: "12:00" },
    ],
  };

  it("reads a date's own hours before anything else", () => {
    expect(crewHoursOn(crew, FRI)).toEqual({ hours: { startsAt: "05:00", endsAt: "18:00" }, from: "date" });
  });

  it("is off on a date marked off, and on a weekday it does not work", () => {
    expect(crewHoursOn(crew, MON)).toEqual({ hours: null, from: "date", off: true });
    expect(crewHoursOn(crew, SUN)).toEqual({ hours: null, from: "weekday", off: true });
  });

  it("works a weekday it usually has off when that date has hours of its own", () => {
    /** 2027-06-27 is a Sunday. */
    expect(crewHoursOn(crew, "2027-06-27")).toEqual({ hours: { startsAt: "08:00", endsAt: "12:00" }, from: "date" });
  });

  it("keeps the weekday's hours and its usual hours on other days", () => {
    expect(crewHoursOn(crew, SAT)).toEqual({ hours: { startsAt: "07:00", endsAt: "11:00" }, from: "weekday" });
    expect(crewHoursOn(crew, "2027-06-22")).toEqual({ hours: { startsAt: "06:00", endsAt: "14:00" }, from: "own" });
  });

  it("says why the crew is off in words", () => {
    expect(crewDayOffWords("Post crew", SUN, crewHoursOn(crew, SUN))).toBe("Post crew does not work on Sundays.");
    expect(crewDayOffWords("Post crew", MON, crewHoursOn(crew, MON))).toBe(`Post crew is off on ${MON}.`);
    expect(crewDayOffWords("Post crew", FRI, crewHoursOn(crew, FRI))).toBeNull();
  });
});

describe("checking a crew's dates and days off", () => {
  it("refuses a date given twice, a date that is not one, half a day and a day that ends before it starts", () => {
    expect(checkCrewDateHours([{ date: FRI, off: true }, { date: FRI, startsAt: "06:00", endsAt: "10:00" }]))
      .toEqual({ ok: false, message: `${FRI} is given twice. Give each date once.` });
    expect(checkCrewDateHours([{ date: "2027-02-30", off: true }]))
      .toEqual({ ok: false, message: "2027-02-30 is not a date. Use YYYY-MM-DD." });
    expect(checkCrewDateHours([{ date: "2027-02-32", off: true }]))
      .toEqual({ ok: false, message: "2027-02-32 is not a date. Use YYYY-MM-DD." });
    expect(checkCrewDateHours([{ date: FRI, startsAt: "06:00" }]))
      .toEqual({ ok: false, message: `Give ${FRI} a start and a finish, or mark the crew off that day.` });
    expect(checkCrewDateHours([{ date: FRI, startsAt: "10:00", endsAt: "06:00" }]))
      .toEqual({ ok: false, message: `The working day on ${FRI} has to end after it starts.` });
    expect(checkCrewDateHours([{ date: FRI, off: true, startsAt: "06:00", endsAt: "10:00" }]))
      .toEqual({ ok: false, message: `${FRI} is marked off and has hours. Choose one.` });
  });

  it("keeps good entries sorted by date", () => {
    expect(checkCrewDateHours([{ date: MON, off: true }, { date: FRI, startsAt: "06:00", endsAt: "10:00" }])).toEqual({
      ok: true,
      dates: [
        { date: FRI, off: false, startsAt: "06:00", endsAt: "10:00" },
        { date: MON, off: true, startsAt: null, endsAt: null },
      ],
    });
  });

  it("refuses every day of the week off, a day given twice, and a day off that has hours of its own", () => {
    expect(checkCrewDaysOff([0, 1, 2, 3, 4, 5, 6]).ok).toBe(false);
    expect(checkCrewDaysOff([0, 0])).toEqual({ ok: false, message: "Sunday is given twice." });
    expect(checkCrewDaysOff([6], [{ dayOfWeek: 6, startsAt: "07:00", endsAt: "11:00" }]))
      .toEqual({ ok: false, message: "Saturday is a day off and has hours of its own. Clear one of them." });
    expect(checkCrewDaysOff([6, 0])).toEqual({ ok: true, daysOff: [0, 6] });
  });
});
