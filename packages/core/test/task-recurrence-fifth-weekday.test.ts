import { describe, it, expect } from "vitest";
import {
  occurrenceOnOrBefore, occurrenceAfter, occurrenceToRaise, describeSchedule, checkSchedule, MAX_INTERVAL_WEEKS,
  type TaskSchedule,
} from "../src/tasks/index.js";

/**
 * THE FIFTH GIVEN WEEKDAY OF A MONTH, AND A GAP OF MORE THAN A YEAR
 *
 * A fifth Monday is in the months with five Mondays and in no others: a month
 * without one is skipped, not moved. In 2026 the fifth Mondays are March 30,
 * June 29, August 31 and November 30; 2027's first is March 29.
 */
const fifthMonday: TaskSchedule = { frequency: "nth_weekday_of_month", weekday: 1, monthWeek: 5, startsOn: "2026-01-01" };

describe("the fifth given weekday of the month", () => {
  it("is only in the months that have one", () => {
    expect(occurrenceOnOrBefore(fifthMonday, "2026-03-30")).toBe("2026-03-30");
    expect(occurrenceOnOrBefore(fifthMonday, "2026-05-31")).toBe("2026-03-30");
    expect(occurrenceOnOrBefore(fifthMonday, "2026-06-28")).toBe("2026-03-30");
    expect(occurrenceOnOrBefore(fifthMonday, "2026-10-15")).toBe("2026-08-31");
  });

  it("skips a month without one and goes on to the next that has one", () => {
    expect(occurrenceAfter(fifthMonday, "2026-03-30")).toBe("2026-06-29");
    expect(occurrenceAfter(fifthMonday, "2026-10-15")).toBe("2026-11-30");
    // December 2026 and the first two months of 2027 have four Mondays each.
    expect(occurrenceAfter(fifthMonday, "2026-11-30")).toBe("2027-03-29");
  });

  it("is not moved to the fourth in a month with four", () => {
    // October 2026 has Mondays on the 5th, 12th, 19th and 26th: nothing is due in it.
    for (let day = 1; day <= 31; day += 1) {
      const date = `2026-10-${String(day).padStart(2, "0")}`;
      expect(occurrenceOnOrBefore(fifthMonday, date)).toBe("2026-08-31");
    }
  });

  it("works from the day it starts", () => {
    const later = { ...fifthMonday, startsOn: "2026-09-01" };
    expect(occurrenceOnOrBefore(later, "2026-10-15")).toBeNull();
    expect(occurrenceAfter(later, "2026-09-01")).toBe("2026-11-30");
    expect(occurrenceOnOrBefore(later, "2026-11-30")).toBe("2026-11-30");
  });

  it("raises the latest fifth one once, and nothing in the months between", () => {
    expect(occurrenceToRaise(fifthMonday, "2026-11-30", null)).toBe("2026-11-30");
    expect(occurrenceToRaise(fifthMonday, "2026-12-15", "2026-11-30")).toBeNull();
    expect(occurrenceToRaise(fifthMonday, "2027-02-15", "2026-11-30")).toBeNull();
    expect(occurrenceToRaise(fifthMonday, "2027-03-29", "2026-11-30")).toBe("2027-03-29");
  });

  it("finds the fifth of every weekday within the year", () => {
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      const schedule: TaskSchedule = { frequency: "nth_weekday_of_month", weekday, monthWeek: 5, startsOn: "2026-01-01" };
      let day = "2026-01-01";
      let found = 0;
      for (let i = 0; i < 20; i += 1) {
        day = occurrenceAfter(schedule, day);
        expect(day.startsWith("20")).toBe(true);
        found += 1;
      }
      expect(found).toBe(20);
    }
  });

  it("is said in words, with the skipped months", () => {
    expect(describeSchedule(fifthMonday)).toBe("On the fifth Monday of the month, and a month without a fifth Monday is skipped");
    expect(describeSchedule({ ...fifthMonday, monthWeek: 4 })).toBe("On the fourth Monday of every month");
  });

  it("is a choice from the first to the fifth", () => {
    expect(checkSchedule(fifthMonday)).toEqual({ ok: true });
    expect(checkSchedule({ ...fifthMonday, monthWeek: 6 }).ok).toBe(false);
    expect(checkSchedule({ ...fifthMonday, monthWeek: 0 }).ok).toBe(false);
    const refused = checkSchedule({ ...fifthMonday, monthWeek: 6 });
    expect(refused.ok === false && refused.message).toContain("first, second, third, fourth or fifth");
  });
});

describe("a gap of more than fifty two weeks", () => {
  const every = (weeks: number): TaskSchedule => ({ frequency: "every_n_weeks", weekday: 1, intervalWeeks: weeks, startsOn: "2026-10-05" });

  it("is allowed up to five years", () => {
    expect(MAX_INTERVAL_WEEKS).toBe(260);
    expect(checkSchedule(every(53))).toEqual({ ok: true });
    expect(checkSchedule(every(104))).toEqual({ ok: true });
    expect(checkSchedule(every(260))).toEqual({ ok: true });
    const refused = checkSchedule(every(261));
    expect(refused.ok === false && refused.message).toContain("from 2 to 260");
  });

  it("counts whole gaps from the first one", () => {
    // 104 weeks is 728 days: 2026-10-05 then 2028-10-02.
    expect(occurrenceAfter(every(104), "2026-10-05")).toBe("2028-10-02");
    expect(occurrenceOnOrBefore(every(104), "2028-10-01")).toBe("2026-10-05");
    expect(occurrenceOnOrBefore(every(104), "2028-10-02")).toBe("2028-10-02");
    expect(occurrenceToRaise(every(104), "2027-06-01", "2026-10-05")).toBeNull();
    expect(describeSchedule(every(104))).toBe("Every 104 weeks on Monday");
  });

  it("counts several days of the week in a gap of more than a year", () => {
    const monThu: TaskSchedule = { frequency: "every_n_weeks", daysOfWeek: [1, 4], intervalWeeks: 78, startsOn: "2026-10-05" };
    expect(occurrenceAfter(monThu, "2026-10-05")).toBe("2026-10-08");
    // 78 weeks is 546 days after Monday 2026-10-05: Monday 2028-04-03.
    expect(occurrenceAfter(monThu, "2026-10-08")).toBe("2028-04-03");
    expect(occurrenceOnOrBefore(monThu, "2028-04-02")).toBe("2026-10-08");
  });
});
