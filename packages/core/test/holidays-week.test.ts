import { describe, it, expect } from "vitest";
import {
  weekFor, weekForNumber, weekOfRows, openWeekdays, hoursOnDate, bookedAt, workingHoursOn,
  type CompanyHoliday, type WeekRow,
} from "../src/holidays/index.js";

const HOUSTON = "11111111-1111-4111-8111-111111111111";
const DALLAS = "22222222-2222-4222-8222-222222222222";
const LINE = "33333333-3333-4333-8333-333333333333";

/** A week of seven rows for one owner: open `opens` to `closes` on the weekdays given, closed on the rest. */
function week(owner: Partial<Pick<WeekRow, "businessUnitId" | "phoneNumberId">>, open: number[], opens = "08:00", closes = "17:00"): WeekRow[] {
  return [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    businessUnitId: owner.businessUnitId ?? null,
    phoneNumberId: owner.phoneNumberId ?? null,
    dayOfWeek,
    opensAt: open.includes(dayOfWeek) ? opens : null,
    closesAt: open.includes(dayOfWeek) ? closes : null,
    closed: !open.includes(dayOfWeek),
  }));
}

const COMPANY = week({}, [1, 2, 3, 4, 5]);
/** Houston opens Saturday mornings and keeps Monday shut. */
const HOUSTON_WEEK = week({ businessUnitId: HOUSTON }, [2, 3, 4, 5, 6], "07:00", "12:00");
const LINE_WEEK = week({ phoneNumberId: LINE }, [0, 1, 2, 3, 4, 5, 6], "00:00", "24:00");
const ALL = [...COMPANY, ...HOUSTON_WEEK, ...LINE_WEEK];

describe("whose week a reader is given", () => {
  it("gives a branch with a week of its own that week, whole", () => {
    const chosen = weekFor(ALL, HOUSTON);
    expect(chosen.source).toBe("branch");
    expect(chosen.rows).toHaveLength(7);
    expect(chosen.week?.[6]).toEqual({ openMinute: 7 * 60, closeMinute: 12 * 60 });
    /** Monday is closed in Houston though the company opens: the branch's week is all seven days, never mixed. */
    expect(chosen.week?.[1]).toBeNull();
  });

  it("falls back to the company's week for a branch that keeps none", () => {
    const chosen = weekFor(ALL, DALLAS);
    expect(chosen.source).toBe("company");
    expect(chosen.week?.[1]).toEqual({ openMinute: 8 * 60, closeMinute: 17 * 60 });
    expect(chosen.week?.[6]).toBeNull();
  });

  it("gives a reader that knows no branch the company's week, never a branch's or a number's", () => {
    const chosen = weekFor(ALL, null);
    expect(chosen.source).toBe("company");
    expect(chosen.rows.every((r) => r.businessUnitId === null && !r.phoneNumberId)).toBe(true);
  });

  it("says nobody has declared a week when the company has none, even if a branch does", () => {
    const chosen = weekFor(HOUSTON_WEEK, null);
    expect(chosen).toEqual({ rows: [], week: null, source: "none" });
    expect(weekFor(HOUSTON_WEEK, DALLAS).source).toBe("none");
    expect(weekFor(HOUSTON_WEEK, HOUSTON).source).toBe("branch");
  });

  it("reads a partial week as closed on the days it leaves out", () => {
    const partial = COMPANY.filter((r) => r.dayOfWeek !== 3);
    expect(weekOfRows(partial)?.[3]).toBeNull();
    expect(weekOfRows([])).toBeNull();
  });
});

describe("a phone number's week", () => {
  it("is its own when it keeps its own", () => {
    const chosen = weekForNumber(ALL, { id: LINE, businessUnitId: HOUSTON, hoursFrom: "own" });
    expect(chosen.source).toBe("number");
    expect(chosen.week?.[0]).toEqual({ openMinute: 0, closeMinute: 24 * 60 });
  });

  it("is none, not the company's, when it is set to keep its own and has not said what that is", () => {
    const chosen = weekForNumber(COMPANY, { id: LINE, businessUnitId: null, hoursFrom: "own" });
    expect(chosen).toEqual({ rows: [], week: null, source: "none" });
  });

  it("is its branch's when it follows its branch, and the company's for a branch with none", () => {
    expect(weekForNumber(ALL, { id: LINE, businessUnitId: HOUSTON, hoursFrom: "branch" }).source).toBe("branch");
    expect(weekForNumber(ALL, { id: LINE, businessUnitId: DALLAS, hoursFrom: "branch" }).source).toBe("company");
    expect(weekForNumber(ALL, { id: LINE, businessUnitId: null, hoursFrom: "branch" }).source).toBe("company");
  });

  it("is the company's when it follows the company, whatever its branch keeps", () => {
    expect(weekForNumber(ALL, { id: LINE, businessUnitId: HOUSTON, hoursFrom: "company" }).source).toBe("company");
  });
});

describe("the days a week opens, and the hours on a date", () => {
  const houston = weekFor(ALL, HOUSTON).week;
  const CHRISTMAS: CompanyHoliday = { name: "Christmas Day", date: "2020-12-25", repeatsYearly: true, closed: true, openMinute: null, closeMinute: null };
  const EVE: CompanyHoliday = { name: "Christmas Eve", date: "2026-12-24", repeatsYearly: false, closed: false, openMinute: 8 * 60, closeMinute: 11 * 60 };

  it("lists the weekdays a branch opens, and nothing when no week is declared", () => {
    expect([...openWeekdays(houston)!].sort()).toEqual([2, 3, 4, 5, 6]);
    expect(openWeekdays(null)).toBeNull();
  });

  it("reads a date by the branch's week, and a holiday over it", () => {
    /** 2026-12-26 is a Saturday: Houston's short morning. */
    expect(hoursOnDate("2026-12-26", houston, [])).toEqual({ holiday: null, hours: { openMinute: 420, closeMinute: 720 }, known: true });
    /** 2026-12-28 is a Monday, which Houston keeps closed. */
    expect(hoursOnDate("2026-12-28", houston, [])).toEqual({ holiday: null, hours: null, known: true });
    expect(hoursOnDate("2026-12-25", houston, [CHRISTMAS])).toMatchObject({ holiday: { name: "Christmas Day" }, hours: null, known: true });
    expect(hoursOnDate("2026-12-24", houston, [EVE]).hours).toEqual({ openMinute: 480, closeMinute: 660 });
  });

  it("does not know a date's hours when no week is declared and no holiday is on it", () => {
    expect(hoursOnDate("2026-12-28", null, [])).toEqual({ holiday: null, hours: null, known: false });
    expect(hoursOnDate("2026-12-25", null, [CHRISTMAS]).known).toBe(true);
  });

  it("gives the rates and working time the branch's week too", () => {
    /** Saturday at 09:00 is inside Houston's hours and outside the company's. */
    expect(bookedAt({ week: houston, holidays: [], date: "2026-12-26", minute: 9 * 60 }).outsideHours).toBe(false);
    expect(bookedAt({ week: weekFor(ALL, null).week, holidays: [], date: "2026-12-26", minute: 9 * 60 }).outsideHours).toBe(true);
    expect(workingHoursOn("2026-12-28", { week: houston, holidays: [] })).toBeNull();
  });
});
