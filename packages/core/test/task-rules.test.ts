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
