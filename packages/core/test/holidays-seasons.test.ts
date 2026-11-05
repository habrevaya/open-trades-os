import { describe, it, expect } from "vitest";
import {
  weekFor, weekForNumber, weekOn, hoursOnDate, bookedAt, workingHoursOn,
  seasonCovers, seasonsOverlap, seasonClash, checkSeason, describeSeason,
  type SeasonDef, type WeekRow,
} from "../src/holidays/index.js";

const HOUSTON = "11111111-1111-4111-8111-111111111111";
const DALLAS = "22222222-2222-4222-8222-222222222222";
const LINE = "33333333-3333-4333-8333-333333333333";
const SUMMER = "44444444-4444-4444-8444-444444444444";
const COMPANY_SUMMER = "55555555-5555-4555-8555-555555555555";

function week(
  owner: Partial<Pick<WeekRow, "businessUnitId" | "phoneNumberId" | "seasonId">>, open: number[], opens = "08:00", closes = "17:00",
): WeekRow[] {
  return [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    businessUnitId: owner.businessUnitId ?? null,
    phoneNumberId: owner.phoneNumberId ?? null,
    seasonId: owner.seasonId ?? null,
    dayOfWeek,
    opensAt: open.includes(dayOfWeek) ? opens : null,
    closesAt: open.includes(dayOfWeek) ? closes : null,
    closed: !open.includes(dayOfWeek),
  }));
}

const COMPANY = week({}, [1, 2, 3, 4, 5]);
const HOUSTON_WEEK = week({ businessUnitId: HOUSTON }, [1, 2, 3, 4, 5], "07:00", "16:00");
/** Houston in summer: six to two, and Saturday mornings too. */
const HOUSTON_SUMMER = week({ businessUnitId: HOUSTON, seasonId: SUMMER }, [1, 2, 3, 4, 5, 6], "06:00", "14:00");
/** The company in summer: open Saturdays as well. */
const COMPANY_SUMMER_WEEK = week({ seasonId: COMPANY_SUMMER }, [1, 2, 3, 4, 5, 6], "07:00", "15:00");
const LINE_WEEK = week({ phoneNumberId: LINE }, [0, 1, 2, 3, 4, 5, 6], "00:00", "24:00");
const ROWS = [...COMPANY, ...HOUSTON_WEEK, ...HOUSTON_SUMMER, ...COMPANY_SUMMER_WEEK, ...LINE_WEEK];

const SEASONS: SeasonDef[] = [
  { id: SUMMER, businessUnitId: HOUSTON, name: "Summer hours", startsOn: "2026-06-01", endsOn: "2026-08-31", repeatsYearly: true },
  { id: COMPANY_SUMMER, businessUnitId: null, name: "Company summer", startsOn: "2027-06-15", endsOn: "2027-07-15", repeatsYearly: false },
];

/** 2027-06-19 is a Saturday, 2027-06-21 a Monday. */
const SATURDAY_IN_SUMMER = "2027-06-19";
const SATURDAY_IN_SPRING = "2027-04-17";

describe("seasons over the normal week", () => {
  it("never reads a season's rows as the normal week", () => {
    const company = weekFor(ROWS, null, SEASONS);
    expect(company.rows).toHaveLength(7);
    expect(company.rows.every((r) => !r.seasonId)).toBe(true);
    const houston = weekFor(ROWS, HOUSTON, SEASONS);
    expect(houston.source).toBe("branch");
    expect(houston.rows.every((r) => !r.seasonId)).toBe(true);
    /** Without seasons passed, as every reader before seasons asked, the answer is the normal week. */
    expect(weekFor(ROWS, HOUSTON).week?.[6]).toBeNull();
  });

  it("reads a branch's own season on the dates it covers, every year when it repeats", () => {
    const houston = weekFor(ROWS, HOUSTON, SEASONS);
    expect(houston.seasons?.map((s) => s.name)).toEqual(["Summer hours"]);
    const summer = weekOn(houston, SATURDAY_IN_SUMMER);
    expect(summer.season?.name).toBe("Summer hours");
    expect(summer.week?.[6]).toEqual({ openMinute: 6 * 60, closeMinute: 14 * 60 });
    expect(summer.rows.every((r) => r.seasonId === SUMMER)).toBe(true);
    const spring = weekOn(houston, SATURDAY_IN_SPRING);
    expect(spring.season).toBeNull();
    expect(spring.week?.[6]).toBeNull();
  });

  it("gives a branch with a week of its own none of the company's seasons", () => {
    /** Houston keeps its own week; on a date the company's summer covers and Houston's does not, Houston's normal week. */
    const houston = weekFor(ROWS, HOUSTON, [SEASONS[1]!]);
    expect(houston.seasons).toBeUndefined();
  });

  it("gives a branch on the company's week its own season first, then the company's", () => {
    const dallas = weekFor(ROWS, DALLAS, SEASONS);
    expect(dallas.source).toBe("company");
    expect(dallas.seasons?.map((s) => s.name)).toEqual(["Company summer"]);
    expect(weekOn(dallas, SATURDAY_IN_SUMMER).week?.[6]).toEqual({ openMinute: 7 * 60, closeMinute: 15 * 60 });
    /** The company's season was for 2027 only. */
    expect(weekOn(dallas, "2028-06-17").season).toBeNull();
  });

  it("gives a phone number on its own week no season, and one following its branch the branch's", () => {
    expect(weekForNumber(ROWS, { id: LINE, businessUnitId: HOUSTON, hoursFrom: "own" }, SEASONS).seasons).toBeUndefined();
    const following = weekForNumber(ROWS, { id: LINE, businessUnitId: HOUSTON, hoursFrom: "branch" }, SEASONS);
    expect(weekOn(following, SATURDAY_IN_SUMMER).season?.name).toBe("Summer hours");
  });

  it("is read by the date readers, with a holiday still over it", () => {
    const houston = weekFor(ROWS, HOUSTON, SEASONS);
    expect(hoursOnDate(SATURDAY_IN_SUMMER, houston.week, [], houston.seasons).hours).toEqual({ openMinute: 360, closeMinute: 840 });
    expect(hoursOnDate(SATURDAY_IN_SPRING, houston.week, [], houston.seasons).hours).toBeNull();
    const holiday = { name: "Juneteenth", date: "2027-06-19", repeatsYearly: false, closed: true, openMinute: null, closeMinute: null };
    expect(hoursOnDate(SATURDAY_IN_SUMMER, houston.week, [holiday], houston.seasons).hours).toBeNull();
    /** Seven in the morning on a summer Saturday is inside Houston's summer hours; on a spring Saturday it is a closed day. */
    expect(bookedAt({ week: houston.week, seasons: houston.seasons, holidays: [], date: SATURDAY_IN_SUMMER, minute: 7 * 60 }).outsideHours).toBe(false);
    expect(bookedAt({ week: houston.week, seasons: houston.seasons, holidays: [], date: SATURDAY_IN_SPRING, minute: 7 * 60 }).outsideHours).toBe(true);
    expect(workingHoursOn(SATURDAY_IN_SUMMER, { week: houston.week, holidays: [], seasons: houston.seasons })).toEqual({ openMinute: 360, closeMinute: 840 });
  });

  it("opens a company with no normal week only on its season's dates", () => {
    const rows = [...COMPANY_SUMMER_WEEK];
    const chosen = weekFor(rows, null, SEASONS);
    expect(chosen.source).toBe("none");
    expect(hoursOnDate("2027-06-21", chosen.week, [], chosen.seasons).hours).toEqual({ openMinute: 420, closeMinute: 900 });
    expect(hoursOnDate("2027-09-20", chosen.week, [], chosen.seasons).known).toBe(false);
  });
});

describe("when a season runs", () => {
  const yearly = (startsOn: string, endsOn: string) => ({ startsOn, endsOn, repeatsYearly: true });
  const dated = (startsOn: string, endsOn: string) => ({ startsOn, endsOn, repeatsYearly: false });

  it("covers its dates, both ends kept, and runs across the new year when it repeats", () => {
    expect(seasonCovers(dated("2027-06-01", "2027-08-31"), "2027-08-31")).toBe(true);
    expect(seasonCovers(dated("2027-06-01", "2027-08-31"), "2028-07-01")).toBe(false);
    expect(seasonCovers(yearly("2026-06-01", "2026-08-31"), "2031-06-01")).toBe(true);
    expect(seasonCovers(yearly("2026-12-01", "2027-02-28"), "2030-01-15")).toBe(true);
    expect(seasonCovers(yearly("2026-12-01", "2027-02-28"), "2030-03-01")).toBe(false);
  });

  it("finds overlaps between dated and yearly seasons", () => {
    expect(seasonsOverlap(dated("2027-06-01", "2027-06-30"), dated("2027-06-30", "2027-07-31"))).toBe(true);
    expect(seasonsOverlap(dated("2027-06-01", "2027-06-29"), dated("2027-06-30", "2027-07-31"))).toBe(false);
    expect(seasonsOverlap(yearly("2026-06-01", "2026-08-31"), dated("2029-08-15", "2029-09-15"))).toBe(true);
    expect(seasonsOverlap(yearly("2026-06-01", "2026-08-31"), dated("2029-09-01", "2029-09-15"))).toBe(false);
    expect(seasonsOverlap(yearly("2026-12-01", "2027-02-28"), yearly("2026-02-01", "2026-03-31"))).toBe(true);
    expect(seasonsOverlap(yearly("2026-12-01", "2027-02-28"), yearly("2026-03-01", "2026-11-30"))).toBe(false);
    /** A dated season over the new year meets a yearly one in January. */
    expect(seasonsOverlap(dated("2027-12-20", "2028-01-05"), yearly("2026-01-01", "2026-01-31"))).toBe(true);
    /** A dated season of a year or more meets any yearly one. */
    expect(seasonsOverlap(dated("2027-01-15", "2028-01-20"), yearly("2026-10-01", "2026-10-02"))).toBe(true);
    expect(seasonClash(dated("2027-07-01", "2027-07-02"), [{ ...yearly("2026-06-01", "2026-08-31"), name: "Summer" }])?.name).toBe("Summer");
  });

  it("refuses dates that make no sense, in words", () => {
    const check = (s: { startsOn: string; endsOn: string; repeatsYearly: boolean }, name = "Summer") => checkSeason({ ...s, name });
    expect(check(dated("2027-06-01", "2027-08-31")).ok).toBe(true);
    expect(check(dated("2027-08-31", "2027-06-01"))).toEqual({ ok: false, message: "The season ends on 2027-06-01, before it starts on 2027-08-31." });
    expect(check(dated("2027-06-01", "2027-02-30")).ok).toBe(false);
    expect(check(yearly("2028-02-29", "2028-04-01")).ok).toBe(false);
    expect(check(yearly("2026-06-01", "2027-06-01")).ok).toBe(false);
    expect(check(dated("2027-06-01", "2027-08-31"), " ").ok).toBe(false);
  });

  it("says when it runs in words", () => {
    expect(describeSeason(yearly("2026-06-01", "2026-08-31"))).toBe("June 1 to August 31, every year");
    expect(describeSeason(dated("2027-06-15", "2027-07-15"))).toBe("June 15, 2027 to July 15, 2027");
  });
});
