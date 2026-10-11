import { describe, it, expect } from "vitest";
import { rental } from "../src/index";

const week: rental.DayHours[] = [
  ...[1, 2, 3, 4, 5].map((day) => ({ day, opens: "07:00", closes: "16:30" })),
  { day: 6, opens: "08:00", closes: "12:00" },
];

describe("a facility's hours", () => {
  it("reads a week, and says a day it does not list is closed", () => {
    expect(rental.openingOn(week, 2)).toEqual({ opens: 420, closes: 990 });
    expect(rental.openingOn(week, 6)).toEqual({ opens: 480, closes: 720 });
    expect(rental.openingOn(week, 0)).toBeNull();
  });

  it("says the week in a line", () => {
    expect(rental.hoursWords(week)).toBe("Mon to Fri 7:00 AM to 4:30 PM, Sat 8:00 AM to 12:00 PM");
    expect(rental.hoursWords([])).toBe("Hours not recorded");
    /** Sunday follows Saturday, so a run can cross the end of the week. */
    expect(rental.hoursWords([{ day: 6, opens: "09:00", closes: "13:00" }, { day: 0, opens: "09:00", closes: "13:00" }]))
      .toBe("Sat to Sun 9:00 AM to 1:00 PM");
  });

  it("refuses a closed gate in words that name the day, the time and the hours", () => {
    expect(rental.closedWords("Austin Transfer", week, 2, 10 * 60)).toBeNull();
    const late = rental.closedWords("Austin Transfer", week, 2, 17 * 60 + 40);
    expect(late).toContain("Austin Transfer is closed at 5:40 PM on Tuesday");
    expect(late).toContain("open 7:00 AM to 4:30 PM that day");
    expect(rental.closedWords("Austin Transfer", week, 2, 6 * 60)).toContain("closed at 6:00 AM on Tuesday");
    const sunday = rental.closedWords("Austin Transfer", week, 0, 10 * 60);
    expect(sunday).toContain("closed on Sundays");
    expect(sunday).toContain("Mon to Fri 7:00 AM to 4:30 PM");
  });

  it("does not refuse anything for a facility whose hours nobody recorded", () => {
    expect(rental.closedWords("Austin Transfer", [], 0, 3 * 60)).toBeNull();
  });

  it("treats the minute it closes as still open, and the next one as closed", () => {
    expect(rental.closedWords("X", week, 2, 990)).toBeNull();
    expect(rental.closedWords("X", week, 2, 991)).not.toBeNull();
  });

  it("checks the hours a person typed and says which day is wrong", () => {
    expect(rental.checkHours(week)).toMatchObject({ ok: true });
    expect(rental.checkHours([{ day: 2, opens: "7:00", closes: "16:30" }])).toEqual({
      ok: false, message: "Tuesday: give the opening and closing time as hours and minutes, like 07:00 and 16:30.",
    });
    expect(rental.checkHours([{ day: 3, opens: "16:00", closes: "07:00" }]))
      .toEqual({ ok: false, message: "Wednesday: it has to close after it opens." });
    expect(rental.checkHours([{ day: 1, opens: "07:00", closes: "08:00" }, { day: 1, opens: "09:00", closes: "10:00" }]))
      .toEqual({ ok: false, message: "Monday is listed twice." });
  });
});

describe("what a facility charges for a load", () => {
  const perTon: rental.FacilityRate = { basis: "per_ton", amount: "62.5000", minimum: "40.0000" };

  it("charges the net tons at the per ton rate, rounded once", () => {
    expect(rental.disposalFee(perTon, "3.1000")).toEqual({ ok: true, fee: "193.7500", why: "3.1 tons at 62.5000 a ton" });
    expect(rental.disposalFee({ ...perTon, amount: "58.3300" }, "2.4000")).toMatchObject({ ok: true, fee: "139.9900" });
  });

  it("never charges less than the facility's minimum", () => {
    expect(rental.disposalFee(perTon, "0.4000")).toEqual({ ok: true, fee: "40.0000", why: "the facility's minimum for a load" });
  });

  it("charges a flat price for a load whatever it weighs, and says when it has no weight to go on", () => {
    const perLoad: rental.FacilityRate = { basis: "per_load", amount: "185.0000", minimum: null };
    expect(rental.disposalFee(perLoad, null)).toMatchObject({ ok: true, fee: "185.0000" });
    expect(rental.disposalFee(perLoad, "9.0000")).toMatchObject({ ok: true, fee: "185.0000" });
    expect(rental.disposalFee(perTon, null)).toEqual({
      ok: false, why: "The facility charges by the ton and this load has no weight yet. Record the scale ticket first.",
    });
  });

  it("is not a fee of nothing when there is no rate or the weight is not a number", () => {
    expect(rental.disposalFee(null, "3.0000")).toMatchObject({ ok: false });
    expect(rental.disposalFee(perTon, "-1")).toMatchObject({ ok: false });
  });
});
