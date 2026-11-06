import { describe, it, expect } from "vitest";
import {
  checkSeason, describeSeason, seasonCovers, seasonsOverlap, weekInForce, weekdayHoursOn, type SeasonWeek,
} from "../src/holidays/seasons.js";
import { weekFor, weekOn, type SeasonDef, type WeekRow } from "../src/holidays/week.js";
import type { WeekHours } from "../src/holidays/index.js";

const NINE_TO_FIVE: WeekHours = [null, ...Array.from({ length: 5 }, () => ({ openMinute: 540, closeMinute: 1020 })), null];

/** Memorial Day (the last Monday of May) to Labor Day (the first Monday of September), every year. */
const summer = {
  name: "Summer hours", startsOn: "2027-05-31", endsOn: "2027-09-06", repeatsYearly: true,
  startsRule: { month: 5, weekday: 1, week: "last" as const },
  endsRule: { month: 9, weekday: 1, week: 1 as const },
};

describe("a yearly season on a day of the week in a month", () => {
  it("is worked out for each year", () => {
    /** 2027: May 31 to September 6. 2028: May 29 to September 4. */
    expect(seasonCovers(summer, "2027-05-30")).toBe(false);
    expect(seasonCovers(summer, "2027-05-31")).toBe(true);
    expect(seasonCovers(summer, "2027-09-06")).toBe(true);
    expect(seasonCovers(summer, "2027-09-07")).toBe(false);
    expect(seasonCovers(summer, "2028-05-29")).toBe(true);
    expect(seasonCovers(summer, "2028-09-05")).toBe(false);
  });

  it("can have a date at one end and a day of the week at the other, and run across the new year", () => {
    const toLabor = { ...summer, startsRule: null, startsOn: "2027-06-01" };
    expect(seasonCovers(toLabor, "2027-05-31")).toBe(false);
    expect(seasonCovers(toLabor, "2027-06-01")).toBe(true);
    /** The first Monday of December to the last Friday of February. */
    const winter = {
      startsOn: "2027-12-06", endsOn: "2028-02-25", repeatsYearly: true,
      startsRule: { month: 12, weekday: 1, week: 1 as const }, endsRule: { month: 2, weekday: 5, week: "last" as const },
    };
    expect(seasonCovers(winter, "2028-01-15")).toBe(true);
    expect(seasonCovers(winter, "2028-02-25")).toBe(true);
    expect(seasonCovers(winter, "2028-02-26")).toBe(false);
    expect(seasonCovers(winter, "2027-12-05")).toBe(false);
  });

  it("is said in words", () => {
    expect(describeSeason(summer)).toBe("Last Monday of May to the first Monday of September, every year");
    expect(describeSeason({ ...summer, startsRule: null, startsOn: "2027-06-01" })).toBe("June 1 to the first Monday of September, every year");
  });

  it("is refused when it does not come back every year, or its ends fall in a different order in some years", () => {
    expect(checkSeason({ ...summer, repeatsYearly: false })).toEqual({
      ok: false, message: "A season on a day of the week in a month comes back every year. Tick Every year.",
    });
    /** The first Monday of June against June 5: some years before it, some after. */
    expect(checkSeason({ ...summer, startsRule: { month: 6, weekday: 1, week: 1 }, endsRule: null, endsOn: "2027-06-05" }))
      .toMatchObject({ ok: false });
    expect(checkSeason(summer)).toEqual({ ok: true });
  });

  it("overlaps another season that could share a day with it in any year", () => {
    /** June 1 to the first Monday of September can meet September 7: the first Monday is the 7th at the latest. */
    const fall = { startsOn: "2027-09-07", endsOn: "2027-11-30", repeatsYearly: true };
    expect(seasonsOverlap(summer, fall)).toBe(true);
    expect(seasonsOverlap(summer, { ...fall, startsOn: "2027-09-08" })).toBe(false);
    /** The last Monday of May is the 25th at the earliest. */
    expect(seasonsOverlap(summer, { startsOn: "2031-05-24", endsOn: "2031-05-24", repeatsYearly: false })).toBe(false);
    expect(seasonsOverlap(summer, { startsOn: "2031-05-25", endsOn: "2031-05-25", repeatsYearly: false })).toBe(true);
  });
});

describe("a season that changes only some days", () => {
  /** Saturday mornings in June; every other day as the normal week. 2027-06-12 is a Saturday, 2027-06-14 a Monday. */
  const saturdays: SeasonWeek = {
    name: "Saturday mornings", startsOn: "2027-06-01", endsOn: "2027-06-30", repeatsYearly: false,
    week: [null, null, null, null, null, null, { openMinute: 480, closeMinute: 720 }], days: [6],
  };

  it("gives its own days and leaves the rest to the normal week", () => {
    expect(weekdayHoursOn("2027-06-12", NINE_TO_FIVE, [saturdays])).toEqual({ openMinute: 480, closeMinute: 720 });
    expect(weekdayHoursOn("2027-06-14", NINE_TO_FIVE, [saturdays])).toEqual({ openMinute: 540, closeMinute: 1020 });
    expect(weekInForce("2027-06-14", NINE_TO_FIVE, [saturdays]).season).toBeNull();
    expect(weekInForce("2027-06-12", NINE_TO_FIVE, [saturdays]).season?.name).toBe("Saturday mornings");
  });

  it("lets a season further down the list say the days it does not change", () => {
    const summerWeek: SeasonWeek = {
      name: "Summer", startsOn: "2027-05-01", endsOn: "2027-08-31", repeatsYearly: false,
      week: Array.from({ length: 7 }, () => ({ openMinute: 360, closeMinute: 840 })),
    };
    expect(weekdayHoursOn("2027-06-14", NINE_TO_FIVE, [saturdays, summerWeek])).toEqual({ openMinute: 360, closeMinute: 840 });
    expect(weekdayHoursOn("2027-06-12", NINE_TO_FIVE, [saturdays, summerWeek])).toEqual({ openMinute: 480, closeMinute: 720 });
  });

  it("is read from the rows it has, beside the normal week's rows", () => {
    const row = (dayOfWeek: number, opensAt: string | null, closesAt: string | null, seasonId: string | null = null): WeekRow =>
      ({ businessUnitId: null, seasonId, dayOfWeek, opensAt, closesAt, closed: opensAt === null });
    const normal = [0, 1, 2, 3, 4, 5, 6].map((d) => (d === 0 || d === 6 ? row(d, null, null) : row(d, "09:00", "17:00")));
    const def: SeasonDef = { id: "s1", businessUnitId: null, name: "Saturday mornings", startsOn: "2027-06-01", endsOn: "2027-06-30", repeatsYearly: false, onlySomeDays: true };
    const chosen = weekFor([...normal, row(6, "08:00", "12:00", "s1")], null, [def]);
    const saturday = weekOn(chosen, "2027-06-12");
    expect(saturday.season?.name).toBe("Saturday mornings");
    expect(saturday.week?.[6]).toEqual({ openMinute: 480, closeMinute: 720 });
    expect(saturday.week?.[1]).toEqual({ openMinute: 540, closeMinute: 1020 });
    expect(saturday.rows.map((r) => r.dayOfWeek).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(saturday.rows.find((r) => r.dayOfWeek === 6)?.seasonId).toBe("s1");
    /** A season with all seven rows is read as the whole week, as it always was. */
    const whole = weekFor([...normal, row(6, "08:00", "12:00", "s1")], null, [{ ...def, onlySomeDays: false }]);
    expect(weekOn(whole, "2027-06-14").week?.[1]).toBeNull();
  });
});
