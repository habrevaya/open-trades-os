import { describe, it, expect } from "vitest";
import {
  workingHoursOn, workingMinutesBetween, workingSpanOn, type CompanyHoliday, type WeekHours, type WorkingCalendar,
} from "../src/holidays/index.js";
import { escalationDue, minutesLate } from "../src/tasks/index.js";
import { instantOfLocal } from "../src/time/index.js";

/**
 * WORKING HOURS FOR A LATE TASK
 *
 * 2026-10-05 is a Monday. The company opens at eight and closes at five from
 * Monday to Friday and is shut at the weekend, in Chicago, where every time
 * below is the wall clock the office reads.
 */
const ZONE = "America/Chicago";
const DAY = { openMinute: 8 * 60, closeMinute: 17 * 60 };
const WEEK: WeekHours = [null, DAY, DAY, DAY, DAY, DAY, null];
const closed = (name: string, date: string, repeatsYearly = false): CompanyHoliday =>
  ({ name, date, repeatsYearly, closed: true, openMinute: null, closeMinute: null });
const calendar = (over: Partial<WorkingCalendar> = {}): WorkingCalendar =>
  ({ week: WEEK, holidays: [], timeZone: ZONE, ...over });
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return instantOfLocal(date, h * 60 + m, ZONE);
};

describe("the hours the company works on a date", () => {
  it("is the weekday's hours, and nothing on a closed day", () => {
    expect(workingHoursOn("2026-10-05", calendar())).toEqual(DAY);
    expect(workingHoursOn("2026-10-03", calendar())).toBeNull();
    expect(workingHoursOn("2026-10-04", calendar())).toBeNull();
  });

  it("lets a holiday decide the date: closed keeps none, a short day keeps its own", () => {
    const eve: CompanyHoliday = { name: "Christmas Eve", date: "2026-12-24", repeatsYearly: false, closed: false, openMinute: 480, closeMinute: 720 };
    const holidays = [closed("Christmas Day", "2020-12-25", true), eve];
    expect(workingHoursOn("2026-12-25", calendar({ holidays }))).toBeNull();
    expect(workingHoursOn("2026-12-24", calendar({ holidays }))).toEqual({ openMinute: 480, closeMinute: 720 });
  });

  it("counts every day, all day, when no weekly hours are declared, but still skips a holiday", () => {
    const holidays = [closed("Christmas Day", "2020-12-25", true)];
    expect(workingHoursOn("2026-10-04", calendar({ week: null }))).toEqual({ openMinute: 0, closeMinute: 1440 });
    expect(workingHoursOn("2026-12-25", calendar({ week: null, holidays }))).toBeNull();
  });
});

describe("working minutes between two instants", () => {
  it("counts only the open part of a single day", () => {
    expect(workingMinutesBetween(at("2026-10-05", "06:00"), at("2026-10-05", "10:30"), calendar())).toBe(150);
    expect(workingMinutesBetween(at("2026-10-05", "12:00"), at("2026-10-05", "20:00"), calendar())).toBe(300);
    expect(workingMinutesBetween(at("2026-10-05", "18:00"), at("2026-10-05", "23:00"), calendar())).toBe(0);
  });

  it("skips the evening, the weekend and a holiday", () => {
    // Friday 15:00 to Monday 10:00: two hours on Friday, two on Monday.
    expect(workingMinutesBetween(at("2026-10-02", "15:00"), at("2026-10-05", "10:00"), calendar())).toBe(240);
    // The same stretch with Monday a holiday leaves only Friday's two hours.
    const holidays = [closed("Founders Day", "2026-10-05")];
    expect(workingMinutesBetween(at("2026-10-02", "15:00"), at("2026-10-05", "10:00"), calendar({ holidays }))).toBe(120);
    // Christmas Eve to the 26th across a closed Christmas Day (a Friday in 2026).
    const christmas = [closed("Christmas Day", "2020-12-25", true)];
    expect(workingMinutesBetween(at("2026-12-24", "09:00"), at("2026-12-28", "09:00"), calendar({ holidays: christmas }))).toBe(8 * 60 + 60);
  });

  it("reads a short day by its own hours", () => {
    const eve: CompanyHoliday = { name: "Christmas Eve", date: "2026-12-24", repeatsYearly: false, closed: false, openMinute: 480, closeMinute: 720 };
    expect(workingMinutesBetween(at("2026-12-24", "00:00"), at("2026-12-25", "00:00"), calendar({ holidays: [eve] }))).toBe(240);
  });

  it("is zero when the end is not after the start, and when the company is never open", () => {
    expect(workingMinutesBetween(at("2026-10-05", "10:00"), at("2026-10-05", "09:00"), calendar())).toBe(0);
    expect(workingMinutesBetween(at("2026-10-05", "10:00"), at("2026-10-05", "10:00"), calendar())).toBe(0);
    const never: WeekHours = [null, null, null, null, null, null, null];
    expect(workingMinutesBetween(at("2026-01-05", "10:00"), at("2026-10-05", "10:00"), calendar({ week: never }))).toBe(0);
  });

  it("uses the company's day, so a Friday evening in Chicago is not Saturday", () => {
    // 21:30 Friday in Chicago is 02:30 Saturday UTC, and the office was still on Friday.
    expect(workingMinutesBetween(at("2026-10-02", "16:00"), at("2026-10-02", "21:30"), calendar())).toBe(60);
  });

  it("is not thrown by the day the clocks go back", () => {
    // 2026-11-01 is a Sunday: close the office's week to Monday and count across it.
    expect(workingMinutesBetween(at("2026-10-30", "16:00"), at("2026-11-02", "09:00"), calendar())).toBe(60 + 60);
    // A working Sunday of 08:00 to 17:00 is nine wall clock hours even though it is ten long.
    const sunday: WeekHours = [DAY, DAY, DAY, DAY, DAY, DAY, DAY];
    expect(workingMinutesBetween(at("2026-11-01", "00:00"), at("2026-11-02", "00:00"), calendar({ week: sunday }))).toBe(9 * 60);
  });

  it("stops early once it has what the caller asked for", () => {
    const got = workingMinutesBetween(at("2020-01-06", "08:00"), at("2026-10-05", "08:00"), calendar(), 60);
    expect(got).toBeGreaterThanOrEqual(60);
    expect(got).toBeLessThan(24 * 60);
  });
});

describe("escalating by working hours", () => {
  const rule = { afterHours: 12, minimumPriority: null, workingHours: true };
  const task = { dueAt: at("2026-10-02", "17:00"), status: "open", priority: "normal" as const };

  it("does not escalate on Saturday morning, as the clock does", () => {
    const saturday = at("2026-10-03", "09:00");
    // Sixteen clock hours have passed, so a clock rule has already fired.
    expect(escalationDue(task, { ...rule, workingHours: false }, saturday, calendar())).toBe(true);
    expect(escalationDue(task, { afterHours: 12, minimumPriority: null }, saturday)).toBe(true);
    expect(escalationDue(task, rule, saturday, calendar())).toBe(false);
  });

  it("escalates once twelve open hours have passed: Monday's nine and three of Tuesday's", () => {
    expect(escalationDue(task, rule, at("2026-10-06", "10:59"), calendar())).toBe(false);
    expect(escalationDue(task, rule, at("2026-10-06", "11:00"), calendar())).toBe(true);
  });

  it("does not count a holiday Monday", () => {
    const holidays = [closed("Founders Day", "2026-10-05")];
    expect(escalationDue(task, rule, at("2026-10-06", "17:00"), calendar({ holidays }))).toBe(false);
    expect(escalationDue(task, rule, at("2026-10-07", "11:00"), calendar({ holidays }))).toBe(true);
  });

  it("counts the clock when a working hours rule is given no calendar, rather than going quiet", () => {
    expect(escalationDue(task, rule, at("2026-10-03", "09:00"))).toBe(true);
    expect(minutesLate(task.dueAt, at("2026-10-03", "09:00"), true, null)).toBe(16 * 60);
  });

  it("still leaves finished and undated tasks alone", () => {
    expect(escalationDue({ ...task, status: "done" }, rule, at("2026-10-09", "12:00"), calendar())).toBe(false);
    expect(escalationDue({ ...task, dueAt: null }, rule, at("2026-10-09", "12:00"), calendar())).toBe(false);
  });
});

describe("the stretch of a date the company works", () => {
  const span = (date: string, over: Partial<WorkingCalendar> = {}) => {
    const s = workingSpanOn(date, calendar(over));
    return [s.start.toISOString(), s.end.toISOString()];
  };

  it("is its hours that day, as instants in its own zone", () => {
    expect(span("2026-10-05")).toEqual([at("2026-10-05", "08:00").toISOString(), at("2026-10-05", "17:00").toISOString()]);
  });

  it("is the whole calendar day when it is shut, or keeps no hours, so a question about leave is never about nothing", () => {
    const whole = [instantOfLocal("2026-10-04", 0, ZONE).toISOString(), instantOfLocal("2026-10-05", 0, ZONE).toISOString()];
    expect(span("2026-10-04")).toEqual(whole);
    expect(span("2026-10-04", { week: null })).toEqual(whole);
  });

  it("is a short day's own hours on a holiday that keeps some", () => {
    const eve: CompanyHoliday = { name: "Christmas Eve", date: "2026-12-24", repeatsYearly: false, closed: false, openMinute: 480, closeMinute: 720 };
    expect(span("2026-12-24", { holidays: [eve] })).toEqual([at("2026-12-24", "08:00").toISOString(), at("2026-12-24", "12:00").toISOString()]);
  });
});
