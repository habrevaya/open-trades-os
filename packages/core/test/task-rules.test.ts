import { describe, it, expect } from "vitest";
import {
  occurrenceOnOrBefore, occurrenceAfter, occurrenceToRaise, describeSchedule, checkSchedule,
  escalationDue, checkEscalationHours, closeVerdict, weekdayOf,
} from "../src/tasks/index.js";

// 2026-10-05 is a Monday.
const MONDAY = "2026-10-05";

describe("which day a recurring task is for", () => {
  it("is today for a daily task", () => {
    expect(occurrenceOnOrBefore({ frequency: "daily", startsOn: "2026-01-01" }, MONDAY)).toBe(MONDAY);
  });

  it("is the most recent of that weekday for a weekly one", () => {
    expect(weekdayOf(MONDAY)).toBe(1);
    const weekly = { frequency: "weekly" as const, weekday: 1, startsOn: "2026-01-01" };
    expect(occurrenceOnOrBefore(weekly, MONDAY)).toBe(MONDAY);
    expect(occurrenceOnOrBefore(weekly, "2026-10-08")).toBe(MONDAY);
    expect(occurrenceOnOrBefore(weekly, "2026-10-04")).toBe("2026-09-28");
  });

  it("holds the 31st to the length of a short month", () => {
    const monthly = { frequency: "monthly" as const, monthDay: 31, startsOn: "2026-01-01" };
    expect(occurrenceOnOrBefore(monthly, "2026-02-28")).toBe("2026-02-28");
    expect(occurrenceOnOrBefore(monthly, "2026-03-15")).toBe("2026-02-28");
    expect(occurrenceOnOrBefore(monthly, "2026-03-31")).toBe("2026-03-31");
  });

  it("goes to last month when this month's day has not come yet", () => {
    const monthly = { frequency: "monthly" as const, monthDay: 15, startsOn: "2026-01-01" };
    expect(occurrenceOnOrBefore(monthly, "2026-10-14")).toBe("2026-09-15");
    expect(occurrenceOnOrBefore(monthly, "2026-01-10")).toBeNull();
  });

  it("has nothing before the schedule starts", () => {
    expect(occurrenceOnOrBefore({ frequency: "daily", startsOn: "2026-10-06" }, MONDAY)).toBeNull();
    // A weekly schedule that starts mid week has no occurrence before its first weekday.
    expect(occurrenceOnOrBefore({ frequency: "weekly", weekday: 1, startsOn: "2026-10-07" }, "2026-10-09")).toBeNull();
  });
});

describe("every other week", () => {
  // 2026-10-05 is a Monday. Starting then, the on weeks are the weeks of the 5th, 19th, 2 Nov.
  const everyOther = { frequency: "every_other_week" as const, weekday: 1, startsOn: MONDAY };

  it("counts from the first such weekday on or after the day it starts", () => {
    expect(occurrenceOnOrBefore(everyOther, MONDAY)).toBe(MONDAY);
    expect(occurrenceOnOrBefore(everyOther, "2026-10-11")).toBe(MONDAY);
    expect(occurrenceOnOrBefore(everyOther, "2026-10-12")).toBe(MONDAY);
    expect(occurrenceOnOrBefore(everyOther, "2026-10-19")).toBe("2026-10-19");
    expect(occurrenceOnOrBefore(everyOther, "2026-11-01")).toBe("2026-10-19");
    expect(occurrenceOnOrBefore(everyOther, "2026-11-02")).toBe("2026-11-02");
  });

  it("starts on the weekday after the start day when the start day is another weekday", () => {
    // Starting on a Wednesday, an every other Monday task is first due the Monday after.
    const wed = { frequency: "every_other_week" as const, weekday: 1, startsOn: "2026-10-07" };
    expect(occurrenceOnOrBefore(wed, "2026-10-11")).toBeNull();
    expect(occurrenceOnOrBefore(wed, "2026-10-12")).toBe("2026-10-12");
    expect(occurrenceAfter(wed, "2026-10-01")).toBe("2026-10-12");
    expect(occurrenceAfter(wed, "2026-10-12")).toBe("2026-10-26");
  });

  it("keeps the same on weeks across a year end and a leap day", () => {
    const winter = { frequency: "every_other_week" as const, weekday: 5, startsOn: "2027-12-03" };
    expect(occurrenceAfter(winter, "2027-12-17")).toBe("2027-12-31");
    expect(occurrenceAfter(winter, "2027-12-31")).toBe("2028-01-14");
    const leap = { frequency: "every_other_week" as const, weekday: 2, startsOn: "2028-02-01" };
    expect(occurrenceAfter(leap, "2028-02-15")).toBe("2028-02-29");
    expect(occurrenceAfter(leap, "2028-02-29")).toBe("2028-03-14");
  });

  it("is never late for a worker that was down, and never raises the off week", () => {
    expect(occurrenceToRaise(everyOther, "2026-10-14", "2026-10-05")).toBeNull();
    expect(occurrenceToRaise(everyOther, "2026-10-19", "2026-10-05")).toBe("2026-10-19");
    expect(occurrenceToRaise(everyOther, "2026-11-04", "2026-10-05")).toBe("2026-11-02");
  });

  it("is the first day for a schedule that has not started", () => {
    expect(occurrenceAfter(everyOther, "2026-09-01")).toBe(MONDAY);
  });
});

describe("weekdays only", () => {
  const weekdays = { frequency: "weekdays" as const, startsOn: "2026-01-01" };

  it("is today on a working day and the Friday before on a weekend", () => {
    expect(occurrenceOnOrBefore(weekdays, MONDAY)).toBe(MONDAY);
    expect(occurrenceOnOrBefore(weekdays, "2026-10-09")).toBe("2026-10-09");
    expect(occurrenceOnOrBefore(weekdays, "2026-10-10")).toBe("2026-10-09");
    expect(occurrenceOnOrBefore(weekdays, "2026-10-11")).toBe("2026-10-09");
  });

  it("raises nothing at the weekend once Friday's was raised", () => {
    expect(occurrenceToRaise(weekdays, "2026-10-10", "2026-10-09")).toBeNull();
    expect(occurrenceToRaise(weekdays, "2026-10-12", "2026-10-09")).toBe("2026-10-12");
  });

  it("skips the weekend when asked for the next one", () => {
    expect(occurrenceAfter(weekdays, "2026-10-08")).toBe("2026-10-09");
    expect(occurrenceAfter(weekdays, "2026-10-09")).toBe("2026-10-12");
    expect(occurrenceAfter(weekdays, "2026-10-10")).toBe("2026-10-12");
    expect(occurrenceAfter(weekdays, "2026-10-11")).toBe("2026-10-12");
  });

  it("has nothing before it starts, and nothing on a weekend before a first Monday", () => {
    // Starting on a Saturday, the first one is the Monday after; there is no Friday before it to raise.
    const saturday = { frequency: "weekdays" as const, startsOn: "2026-10-10" };
    expect(occurrenceOnOrBefore(saturday, "2026-10-11")).toBeNull();
    expect(occurrenceOnOrBefore(saturday, "2026-10-12")).toBe("2026-10-12");
    expect(occurrenceAfter(saturday, "2026-10-01")).toBe("2026-10-12");
  });
});

describe("the last given weekday of the month", () => {
  const lastFriday = { frequency: "last_weekday_of_month" as const, weekday: 5, startsOn: "2026-01-01" };

  it("is the fourth Friday in one month and the fifth in another", () => {
    // October 2026 has five Fridays, the last on the 30th; November has four, the last on the 27th.
    expect(occurrenceOnOrBefore(lastFriday, "2026-10-31")).toBe("2026-10-30");
    expect(occurrenceOnOrBefore(lastFriday, "2026-11-30")).toBe("2026-11-27");
  });

  it("is the last day of the month when that day is the weekday", () => {
    // 31 July 2026 is a Friday.
    expect(occurrenceOnOrBefore(lastFriday, "2026-07-31")).toBe("2026-07-31");
    expect(occurrenceAfter(lastFriday, "2026-07-30")).toBe("2026-07-31");
  });

  it("goes to last month before this month's has come", () => {
    expect(occurrenceOnOrBefore(lastFriday, "2026-10-29")).toBe("2026-09-25");
    expect(occurrenceOnOrBefore(lastFriday, "2026-01-30")).toBe("2026-01-30");
    expect(occurrenceOnOrBefore(lastFriday, "2026-01-29")).toBeNull();
  });

  it("finds the next one across a year end and in a leap February", () => {
    expect(occurrenceAfter(lastFriday, "2026-12-25")).toBe("2027-01-29");
    expect(occurrenceAfter(lastFriday, "2026-12-31")).toBe("2027-01-29");
    const leapMonday = { frequency: "last_weekday_of_month" as const, weekday: 2, startsOn: "2028-01-01" };
    // The last Tuesday of February 2028 is the 29th, the leap day.
    expect(occurrenceAfter(leapMonday, "2028-02-01")).toBe("2028-02-29");
    expect(occurrenceAfter(leapMonday, "2028-02-29")).toBe("2028-03-28");
  });

  it("raises once, and not the month before when a worker was down over a month end", () => {
    expect(occurrenceToRaise(lastFriday, "2026-11-02", "2026-09-25")).toBe("2026-10-30");
    expect(occurrenceToRaise(lastFriday, "2026-10-31", "2026-10-30")).toBeNull();
  });
});

describe("raising it once", () => {
  const daily = { frequency: "daily" as const, startsOn: "2026-01-01" };

  it("raises today's when today's has not been raised", () => {
    expect(occurrenceToRaise(daily, MONDAY, "2026-10-04")).toBe(MONDAY);
  });

  it("raises nothing when today's already was", () => {
    expect(occurrenceToRaise(daily, MONDAY, MONDAY)).toBeNull();
  });

  it("does not backfill the days a worker was down for", () => {
    // Down from Wednesday to Monday: one task, today's, not five stale ones.
    expect(occurrenceToRaise(daily, MONDAY, "2026-09-30")).toBe(MONDAY);
  });
});

describe("the next one", () => {
  it("is tomorrow, next week or next month", () => {
    expect(occurrenceAfter({ frequency: "daily", startsOn: "2026-01-01" }, MONDAY)).toBe("2026-10-06");
    expect(occurrenceAfter({ frequency: "weekly", weekday: 1, startsOn: "2026-01-01" }, MONDAY)).toBe("2026-10-12");
    expect(occurrenceAfter({ frequency: "weekly", weekday: 3, startsOn: "2026-01-01" }, MONDAY)).toBe("2026-10-07");
    expect(occurrenceAfter({ frequency: "monthly", monthDay: 31, startsOn: "2026-01-01" }, "2026-10-31")).toBe("2026-11-30");
  });

  it("is the first day for a schedule that has not started", () => {
    expect(occurrenceAfter({ frequency: "daily", startsOn: "2026-12-01" }, MONDAY)).toBe("2026-12-01");
  });
});

describe("the schedule in words", () => {
  it("says it the way an owner would", () => {
    expect(describeSchedule({ frequency: "daily", startsOn: MONDAY })).toBe("Every day");
    expect(describeSchedule({ frequency: "weekly", weekday: 1, startsOn: MONDAY })).toBe("Every Monday");
    expect(describeSchedule({ frequency: "monthly", monthDay: 1, startsOn: MONDAY })).toBe("On the 1st of every month");
    expect(describeSchedule({ frequency: "monthly", monthDay: 31, startsOn: MONDAY })).toContain("last day");
    expect(describeSchedule({ frequency: "every_other_week", weekday: 5, startsOn: MONDAY })).toBe("Every other Friday");
    expect(describeSchedule({ frequency: "weekdays", startsOn: MONDAY })).toBe("Every weekday, Monday to Friday");
    expect(describeSchedule({ frequency: "last_weekday_of_month", weekday: 5, startsOn: MONDAY }))
      .toBe("On the last Friday of every month");
  });

  it("wants a weekday for every other week and the last of the month, and none for weekdays only", () => {
    expect(checkSchedule({ frequency: "every_other_week", startsOn: MONDAY }).ok).toBe(false);
    expect(checkSchedule({ frequency: "last_weekday_of_month", weekday: 7, startsOn: MONDAY }).ok).toBe(false);
    expect(checkSchedule({ frequency: "last_weekday_of_month", weekday: 0, startsOn: MONDAY }).ok).toBe(true);
    expect(checkSchedule({ frequency: "every_other_week", weekday: 2, startsOn: MONDAY }).ok).toBe(true);
    expect(checkSchedule({ frequency: "weekdays", startsOn: MONDAY }).ok).toBe(true);
  });

  it("refuses a weekly task with no weekday and a monthly one with no day", () => {
    expect(checkSchedule({ frequency: "weekly", startsOn: MONDAY }).ok).toBe(false);
    expect(checkSchedule({ frequency: "monthly", monthDay: 32, startsOn: MONDAY }).ok).toBe(false);
    expect(checkSchedule({ frequency: "daily", startsOn: "2026-13-01" }).ok).toBe(false);
    expect(checkSchedule({ frequency: "weekly", weekday: 6, startsOn: MONDAY }).ok).toBe(true);
  });
});

describe("escalating a late task", () => {
  const now = new Date("2026-10-05T15:00:00Z");
  const due = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000);

  it("acts once the task is late by the rule's hours", () => {
    const rule = { afterHours: 4, minimumPriority: null };
    expect(escalationDue({ dueAt: due(4), status: "open", priority: "normal" }, rule, now)).toBe(true);
    expect(escalationDue({ dueAt: due(3), status: "open", priority: "normal" }, rule, now)).toBe(false);
  });

  it("leaves finished, undated and low priority work alone", () => {
    const rule = { afterHours: 1, minimumPriority: "high" as const };
    expect(escalationDue({ dueAt: due(5), status: "done", priority: "urgent" }, rule, now)).toBe(false);
    expect(escalationDue({ dueAt: null, status: "open", priority: "urgent" }, rule, now)).toBe(false);
    expect(escalationDue({ dueAt: due(5), status: "open", priority: "normal" }, rule, now)).toBe(false);
    expect(escalationDue({ dueAt: due(5), status: "in_progress", priority: "urgent" }, rule, now)).toBe(true);
  });

  it("refuses a rule of no hours or of months", () => {
    expect(checkEscalationHours(0).ok).toBe(false);
    expect(checkEscalationHours(2.5).ok).toBe(false);
    expect(checkEscalationHours(24 * 60).ok).toBe(false);
    expect(checkEscalationHours(24).ok).toBe(true);
  });
});

describe("closing a task with a checklist", () => {
  const items = [{ done: true }, { done: false }, { done: false }];

  it("closes when everything is ticked", () => {
    expect(closeVerdict({ items: [{ done: true }], dismissed: false })).toEqual({ ok: true, overrideReason: null });
    expect(closeVerdict({ items: [], dismissed: false })).toEqual({ ok: true, overrideReason: null });
  });

  it("asks why when something is not", () => {
    const verdict = closeVerdict({ items, dismissed: false });
    expect(verdict).toMatchObject({ ok: false, open: 2 });
    expect(closeVerdict({ items, dismissed: false, overrideReason: "  " }).ok).toBe(false);
  });

  it("closes with the reason kept", () => {
    expect(closeVerdict({ items, dismissed: false, overrideReason: "Gauge missing" }))
      .toEqual({ ok: true, overrideReason: "Gauge missing" });
  });

  it("does not ask when it is being dismissed", () => {
    expect(closeVerdict({ items, dismissed: true })).toEqual({ ok: true, overrideReason: null });
  });
});
