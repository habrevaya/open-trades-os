import { describe, it, expect } from "vitest";
import {
  occurrenceOnOrBefore, occurrenceAfter, describeSchedule, checkSchedule, everySoManyWeeksDays, type TaskSchedule,
} from "../src/tasks/index.js";

/**
 * EVERY SO MANY WEEKS, ON SEVERAL DAYS
 *
 * "Every third Monday and Thursday" used to be two templates. An every other
 * week or every so many weeks task may now name several days: the weeks run
 * Monday to Sunday, the first week is the one the first occurrence falls in
 * (so "Starting" says which week is the on week), and it comes round on every
 * named day of that week and of every gap after it. A task naming one day is
 * counted exactly as it always was.
 *
 * 2026-10-05 is a Monday.
 */
const every3 = (days: number[], startsOn: string): TaskSchedule =>
  ({ frequency: "every_n_weeks", intervalWeeks: 3, daysOfWeek: days, startsOn });

/** Every occurrence from the first to a day, by asking "what comes after" until past it. */
function walk(schedule: TaskSchedule, until: string, count = 12): string[] {
  const out: string[] = [];
  let at = occurrenceAfter(schedule, "2026-01-01");
  while (at <= until && out.length < count) {
    out.push(at);
    at = occurrenceAfter(schedule, at);
  }
  return out;
}

describe("every third week on Monday and Thursday", () => {
  const schedule = every3([1, 4], "2026-10-05");

  it("comes round on both days of the first week, then both days three weeks on", () => {
    expect(walk(schedule, "2026-12-31")).toEqual([
      "2026-10-05", "2026-10-08", "2026-10-26", "2026-10-29", "2026-11-16", "2026-11-19", "2026-12-07", "2026-12-10", "2026-12-28", "2026-12-31",
    ]);
  });

  it("is the latest named day in an on week for a worker that was down, and nothing in between weeks", () => {
    expect(occurrenceOnOrBefore(schedule, "2026-10-06")).toBe("2026-10-05");
    expect(occurrenceOnOrBefore(schedule, "2026-10-08")).toBe("2026-10-08");
    // Friday of the on week, and the whole of the two weeks off, are the Thursday's.
    expect(occurrenceOnOrBefore(schedule, "2026-10-09")).toBe("2026-10-08");
    expect(occurrenceOnOrBefore(schedule, "2026-10-25")).toBe("2026-10-08");
    expect(occurrenceOnOrBefore(schedule, "2026-10-26")).toBe("2026-10-26");
    expect(occurrenceOnOrBefore(schedule, "2026-11-15")).toBe("2026-10-29");
  });

  it("has not started before its first day", () => {
    expect(occurrenceOnOrBefore(schedule, "2026-10-04")).toBeNull();
    expect(occurrenceAfter(schedule, "2026-09-01")).toBe("2026-10-05");
  });

  it("is read back in words", () => {
    expect(describeSchedule(schedule)).toBe("Every 3 weeks on Monday and Thursday");
    expect(describeSchedule({ frequency: "every_other_week", daysOfWeek: [6, 2], startsOn: "2026-10-05" }))
      .toBe("Every other week on Tuesday and Saturday");
  });
});

describe("starting part way through the first week", () => {
  it("skips the named days that came before the starting day, and keeps that week as the on week", () => {
    // Starting on a Wednesday: the Monday has passed, the Thursday has not.
    const schedule = every3([1, 4], "2026-10-07");
    expect(walk(schedule, "2026-11-20")).toEqual(["2026-10-08", "2026-10-26", "2026-10-29", "2026-11-16", "2026-11-19"]);
    expect(occurrenceOnOrBefore(schedule, "2026-10-07")).toBeNull();
  });

  it("moves which week is the on week when the starting day moves", () => {
    const earlier = every3([1, 4], "2026-10-05");
    const later = every3([1, 4], "2026-10-12");
    expect(occurrenceAfter(earlier, "2026-10-09")).toBe("2026-10-26");
    expect(occurrenceAfter(later, "2026-10-09")).toBe("2026-10-12");
    expect(walk(later, "2026-11-12")).toEqual(["2026-10-12", "2026-10-15", "2026-11-02", "2026-11-05"]);
  });

  it("counts weeks Monday to Sunday, so a Sunday belongs to the week it ends", () => {
    // Every other week on Sunday and Wednesday, starting on a Sunday: that week is Sep 28 to Oct 4.
    const schedule: TaskSchedule = { frequency: "every_other_week", daysOfWeek: [0, 3], startsOn: "2026-10-04" };
    expect(walk(schedule, "2026-10-31")).toEqual(["2026-10-04", "2026-10-14", "2026-10-18", "2026-10-28"]);
  });
});

describe("one day is counted as it always was", () => {
  it("is the same whether it is the weekday or the single ticked day", () => {
    const old: TaskSchedule = { frequency: "every_n_weeks", weekday: 1, intervalWeeks: 3, startsOn: "2026-10-07" };
    const ticked: TaskSchedule = { frequency: "every_n_weeks", daysOfWeek: [1], intervalWeeks: 3, startsOn: "2026-10-07" };
    expect(everySoManyWeeksDays(old)).toEqual([1]);
    expect(everySoManyWeeksDays(ticked)).toEqual([1]);
    // Starting on a Wednesday, the first Monday on or after is the 12th, then every twenty first day.
    expect(walk(old, "2026-12-31")).toEqual(["2026-10-12", "2026-11-02", "2026-11-23", "2026-12-14"]);
    expect(walk(ticked, "2026-12-31")).toEqual(walk(old, "2026-12-31"));
    expect(describeSchedule(old)).toBe("Every 3 weeks on Monday");
  });

  it("keeps an every other week task on one day reading as before", () => {
    expect(describeSchedule({ frequency: "every_other_week", weekday: 2, startsOn: "2026-10-05" })).toBe("Every other Tuesday");
  });

  it("lets two or more ticked days win over a stale weekday", () => {
    const both: TaskSchedule = { frequency: "every_n_weeks", weekday: 2, daysOfWeek: [1, 4], intervalWeeks: 3, startsOn: "2026-10-05" };
    expect(everySoManyWeeksDays(both)).toEqual([1, 4]);
  });
});

describe("what is refused", () => {
  const ok = (s: TaskSchedule) => checkSchedule(s);

  it("takes ticked days in place of the one day, and nothing at all is refused in the old words", () => {
    expect(ok({ frequency: "every_n_weeks", daysOfWeek: [1, 4], intervalWeeks: 3, startsOn: "2026-10-05" })).toEqual({ ok: true });
    expect(ok({ frequency: "every_other_week", daysOfWeek: [4], startsOn: "2026-10-05" })).toEqual({ ok: true });
    expect(ok({ frequency: "every_other_week", startsOn: "2026-10-05" }))
      .toEqual({ ok: false, message: "A task every few weeks needs the day of the week it comes round on." });
  });

  it("still needs the gap", () => {
    expect(ok({ frequency: "every_n_weeks", daysOfWeek: [1, 4], startsOn: "2026-10-05" }).ok).toBe(false);
    expect(ok({ frequency: "every_n_weeks", daysOfWeek: [1, 4], intervalWeeks: 60, startsOn: "2026-10-05" }).ok).toBe(false);
  });

  it("refuses a day that is not a day of the week, and two different ways of naming one day", () => {
    expect(ok({ frequency: "every_n_weeks", daysOfWeek: [1, 9], intervalWeeks: 3, startsOn: "2026-10-05" }))
      .toEqual({ ok: false, message: "A day of the week is 0 for Sunday to 6 for Saturday." });
    expect(ok({ frequency: "every_n_weeks", weekday: 2, daysOfWeek: [4], intervalWeeks: 3, startsOn: "2026-10-05" }).ok).toBe(false);
    expect(ok({ frequency: "every_n_weeks", weekday: 4, daysOfWeek: [4], intervalWeeks: 3, startsOn: "2026-10-05" }).ok).toBe(true);
  });

  it("does not let a weekly or monthly task borrow ticked days", () => {
    expect(ok({ frequency: "weekly", daysOfWeek: [1, 4], startsOn: "2026-10-05" }).ok).toBe(false);
  });
});
