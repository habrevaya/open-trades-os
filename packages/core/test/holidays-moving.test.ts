import { describe, it, expect } from "vitest";
import { holidays } from "../src/index";

/**
 * HOLIDAYS THAT MOVE, AND A BRANCH'S OWN
 *
 * Every date below was checked against a printed calendar: Thanksgiving,
 * Memorial Day, Labor Day, and Christmas and New Year's Day in the years
 * they land on a weekend.
 */

const day = (name: string, extra: Partial<holidays.CompanyHoliday>): holidays.CompanyHoliday => ({
  name, date: "2026-01-01", repeatsYearly: true, closed: true, openMinute: null, closeMinute: null, ...extra,
});

const THANKSGIVING = day("Thanksgiving", { rule: { month: 11, weekday: 4, week: 4 } });
const MEMORIAL = day("Memorial Day", { rule: { month: 5, weekday: 1, week: "last" } });
const LABOR = day("Labor Day", { rule: { month: 9, weekday: 1, week: 1 } });
const CHRISTMAS_MONDAY = day("Christmas", { date: "2020-12-25", observed: "sunday_to_monday" });
const NEW_YEAR_WEEKDAY = day("New Year's Day", { date: "2020-01-01", observed: "weekend_to_weekday" });

describe("a day of the week in a month", () => {
  it("works out the fourth Thursday of November each year", () => {
    expect(holidays.weekdayOfMonth(2026, { month: 11, weekday: 4, week: 4 })).toBe("2026-11-26");
    expect(holidays.weekdayOfMonth(2027, { month: 11, weekday: 4, week: 4 })).toBe("2027-11-25");
    expect(holidays.weekdayOfMonth(2028, { month: 11, weekday: 4, week: 4 })).toBe("2028-11-23");
  });

  it("works out the last Monday of May, the fourth or the fifth", () => {
    expect(holidays.weekdayOfMonth(2026, { month: 5, weekday: 1, week: "last" })).toBe("2026-05-25");
    expect(holidays.weekdayOfMonth(2027, { month: 5, weekday: 1, week: "last" })).toBe("2027-05-31");
    expect(holidays.weekdayOfMonth(2028, { month: 5, weekday: 1, week: "last" })).toBe("2028-05-29");
  });

  it("works out the first Monday of a month that starts on one", () => {
    expect(holidays.weekdayOfMonth(2025, { month: 9, weekday: 1, week: 1 })).toBe("2025-09-01");
    expect(holidays.weekdayOfMonth(2026, { month: 9, weekday: 1, week: 1 })).toBe("2026-09-07");
  });

  it("is read from the list on the right date and no other", () => {
    expect(holidays.holidayOn([THANKSGIVING], "2026-11-26")).toMatchObject({ name: "Thanksgiving", closed: true });
    expect(holidays.holidayOn([THANKSGIVING], "2027-11-26")).toBeNull();
    expect(holidays.holidayOn([MEMORIAL, LABOR], "2027-05-31")?.name).toBe("Memorial Day");
    expect(holidays.closedOn([LABOR], "2026-09-07")).toBe(true);
    expect(holidays.holidaysBetween([THANKSGIVING], "2026-01-01", "2027-12-31").map((d) => d.date))
      .toEqual(["2026-11-26", "2027-11-25"]);
  });

  it("says when it next falls", () => {
    expect(holidays.nextDate(THANKSGIVING, "2026-10-14")).toBe("2026-11-26");
    expect(holidays.nextDate(THANKSGIVING, "2026-11-27")).toBe("2027-11-25");
  });

  it("refuses a rule that is not one, and one that does not repeat", () => {
    expect(holidays.checkHoliday(day("Bad", { rule: { month: 13, weekday: 1, week: 1 } }))).toMatchObject({ ok: false, field: "date" });
    expect(holidays.checkHoliday(day("Bad", { rule: { month: 5, weekday: 7, week: 1 } }))).toMatchObject({ ok: false });
    expect(holidays.checkHoliday(day("Bad", { rule: { month: 5, weekday: 1, week: 5 as never } }))).toMatchObject({ ok: false });
    expect(holidays.checkHoliday(day("Once", { repeatsYearly: false, rule: { month: 5, weekday: 1, week: 1 } }))).toMatchObject({ ok: false });
    expect(holidays.checkHoliday(MEMORIAL)).toEqual({ ok: true });
  });

  it("names itself in words", () => {
    expect(holidays.describeWhen(THANKSGIVING)).toBe("Fourth Thursday of November");
    expect(holidays.describeWhen(MEMORIAL)).toBe("Last Monday of May");
    expect(holidays.describeWhen(CHRISTMAS_MONDAY)).toBe("Every year on December 25, or the Monday after when it falls on a Sunday");
  });
});

describe("a fixed date kept on a weekday", () => {
  it("keeps Christmas on the Monday after when it falls on a Sunday, and on the day otherwise", () => {
    /** 2022-12-25 was a Sunday; 2026-12-25 is a Friday; 2021-12-25 was a Saturday. */
    expect(holidays.holidayOn([CHRISTMAS_MONDAY], "2022-12-26")?.name).toBe("Christmas");
    expect(holidays.holidayOn([CHRISTMAS_MONDAY], "2022-12-25")).toBeNull();
    expect(holidays.holidayOn([CHRISTMAS_MONDAY], "2026-12-25")?.name).toBe("Christmas");
    expect(holidays.holidayOn([CHRISTMAS_MONDAY], "2021-12-25")?.name).toBe("Christmas");
  });

  it("keeps a Saturday holiday on the Friday before, into the year before when it has to", () => {
    /** 2022-01-01 was a Saturday: kept on Friday 2021-12-31. */
    expect(holidays.holidayOn([NEW_YEAR_WEEKDAY], "2021-12-31")?.name).toBe("New Year's Day");
    expect(holidays.holidayOn([NEW_YEAR_WEEKDAY], "2022-01-01")).toBeNull();
    /** 2023-01-01 was a Sunday: kept on Monday the second. */
    expect(holidays.holidayOn([NEW_YEAR_WEEKDAY], "2023-01-02")?.name).toBe("New Year's Day");
    expect(holidays.nextDate(NEW_YEAR_WEEKDAY, "2021-12-01")).toBe("2021-12-31");
  });

  it("does not move a one off date, and says so", () => {
    expect(holidays.checkHoliday(day("Once", { repeatsYearly: false, date: "2022-12-25", observed: "sunday_to_monday" })))
      .toMatchObject({ ok: false });
  });

  it("keeps the old reading for a yearly date with no weekend rule", () => {
    const plain = day("Christmas Day", { date: "2020-12-25" });
    expect(holidays.holidayOn([plain], "2022-12-25")?.name).toBe("Christmas Day");
    expect(holidays.occurrenceIn(plain, 2031)).toBe("2031-12-25");
  });
});

describe("a branch's own holidays", () => {
  const RODEO = day("Rodeo day", { date: "2026-03-03", repeatsYearly: false, branchId: "houston" });
  const COMPANY_OPEN = day("Short day", { date: "2026-03-03", repeatsYearly: false, closed: false, openMinute: 480, closeMinute: 720 });
  const list = [THANKSGIVING, RODEO];

  it("is read by that branch beside the company's, and by no other", () => {
    expect(holidays.holidayOn(holidays.forBranch(list, "houston"), "2026-03-03")?.name).toBe("Rodeo day");
    expect(holidays.holidayOn(holidays.forBranch(list, "austin"), "2026-03-03")).toBeNull();
    expect(holidays.holidayOn(holidays.forBranch(list, null), "2026-03-03")).toBeNull();
    expect(holidays.holidayOn(holidays.forBranch(list, "austin"), "2026-11-26")?.name).toBe("Thanksgiving");
  });

  it("beats the company's entry on the same date", () => {
    expect(holidays.holidayOn(holidays.forBranch([COMPANY_OPEN, RODEO], "houston"), "2026-03-03")).toMatchObject({ name: "Rodeo day", closed: true });
    expect(holidays.holidayOn(holidays.forBranch([COMPANY_OPEN, RODEO], "austin"), "2026-03-03")).toMatchObject({ name: "Short day", closed: false });
  });
});
