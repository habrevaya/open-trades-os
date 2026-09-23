import { describe, it, expect } from "vitest";
import { automation } from "../src/index";

/**
 * A SCHEDULE IS DATA
 *
 * Parsed into the values it allows and then asked "when next". Never turned
 * into a function and never handed to anything that could run it, which is
 * the same rule the conditions follow and for the same reason: a workflow
 * builder in a product people self host must not be a way to execute a
 * string.
 *
 * The answers below are in a company's own timezone. Every one of them is
 * different in UTC, which is how a nightly summary ends up going out in the
 * middle of the working day.
 */

const AUSTIN = "America/Chicago";
const next = (cron: string, after: string, zone = AUSTIN) =>
  automation.nextRunOf(cron, new Date(after), zone)?.toISOString() ?? null;

describe("reading a schedule", () => {
  it("reads the fields", () => {
    const parsed = automation.parseSchedule("30 9 * * 1-5");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.schedule.minutes).toEqual([30]);
    expect(parsed.schedule.hours).toEqual([9]);
    expect(parsed.schedule.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads a step", () => {
    const parsed = automation.parseSchedule("*/15 * * * *");
    expect(parsed.ok && parsed.schedule.minutes).toEqual([0, 15, 30, 45]);
  });

  it("reads a step from a starting point", () => {
    // `5/20` has to mean "from five, every twenty" to be consistent with
    // `*/20` meaning "from the start, every twenty".
    const parsed = automation.parseSchedule("5/20 * * * *");
    expect(parsed.ok && parsed.schedule.minutes).toEqual([5, 25, 45]);
  });

  it("reads a list", () => {
    const parsed = automation.parseSchedule("0 8,12,17 * * *");
    expect(parsed.ok && parsed.schedule.hours).toEqual([8, 12, 17]);
  });

  it("reads the names people actually write", () => {
    const parsed = automation.parseSchedule("0 9 * jan-mar mon,fri");
    expect(parsed.ok && parsed.schedule.months).toEqual([1, 2, 3]);
    expect(parsed.ok && parsed.schedule.daysOfWeek).toEqual([1, 5]);
  });

  it("treats 7 as Sunday, like 0", () => {
    const parsed = automation.parseSchedule("0 9 * * 7");
    expect(parsed.ok && parsed.schedule.daysOfWeek).toEqual([0]);
  });

  it("refuses an expression it cannot read rather than treating it as never", () => {
    /**
     * A schedule that silently becomes "never" is the automation failure
     * nobody notices until a customer does. Every one of these is refused
     * with a reason at the point somebody saves it.
     */
    for (const bad of ["", "0 9 * *", "0 9 * * * *", "61 * * * *", "0 25 * * *",
                       "0 9 0 * *", "0 9 * 13 *", "bananas * * * *", "0 9-5 * * *"]) {
      expect(automation.parseSchedule(bad).ok, `${JSON.stringify(bad)} was accepted`).toBe(false);
    }
  });
});

describe("when it next fires", () => {
  it("is in the company's morning, not London's", () => {
    // Nine in the morning in Austin is fourteen hundred UTC in the summer.
    expect(next("0 9 * * *", "2026-09-22T12:00:00Z")).toBe("2026-09-22T14:00:00.000Z");
  });

  it("is strictly after, so a run does not schedule itself again", () => {
    // Asked at exactly nine, the answer is tomorrow. Otherwise a worker that
    // fires and then computes the next run would fire forever.
    expect(next("0 9 * * *", "2026-09-22T14:00:00Z")).toBe("2026-09-23T14:00:00.000Z");
  });

  it("changes UTC time when the clocks change, and keeps local time", () => {
    /**
     * The whole point. Nine in the morning is nine in the morning either
     * side of the change, and a schedule stored as an offset from UTC would
     * drift by an hour twice a year.
     */
    expect(next("0 9 * * *", "2026-11-05T12:00:00Z")).toBe("2026-11-05T15:00:00.000Z");
    expect(next("0 9 * * *", "2026-09-22T15:00:00Z")).toBe("2026-09-23T14:00:00.000Z");
  });

  it("skips a wall time that does not exist", () => {
    /**
     * The clocks go forward at two on 8 March 2026, so there is no half past
     * two that morning. A nightly job set for then does not run that day,
     * and runs the next as normal, rather than being quietly moved an hour.
     */
    const after = new Date("2026-03-08T04:00:00Z"); // 22:00 on the 7th, Austin
    const fire = automation.nextRunOf("30 2 * * *", after, AUSTIN)!;
    expect(new Intl.DateTimeFormat("en-CA", {
      timeZone: AUSTIN, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(fire)).toBe("2026-03-09");
  });

  it("fires once on the morning an hour happens twice", () => {
    /**
     * The clocks go back at two on 1 November 2026, so half past one comes
     * round again. It fires on the first, and the run after it is the next
     * day. A summary sent twice reads as a bug to whoever receives it.
     */
    const first = automation.nextRunOf("30 1 * * *", new Date("2026-11-01T04:00:00Z"), AUSTIN)!;
    expect(first.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    const second = automation.nextRunOf("30 1 * * *", first, AUSTIN)!;
    expect(second.toISOString()).toBe("2026-11-02T07:30:00.000Z");
  });

  it("fires on either day when both day fields are narrowed", () => {
    /**
     * Cron's oldest wart and it is load bearing. `0 9 1 * 1` is the first of
     * the month AND every Monday, not the first when it falls on a Monday.
     * Reading it as "both" makes a schedule fire far less often than its
     * author expected; the other way round is a text bill.
     */
    // 1 October 2026 is a Thursday, and it still fires.
    expect(next("0 9 1 * 1", "2026-09-30T12:00:00Z")).toBe("2026-10-01T14:00:00.000Z");
    // And the Monday after it, the 5th.
    expect(next("0 9 1 * 1", "2026-10-01T15:00:00Z")).toBe("2026-10-05T14:00:00.000Z");
  });

  it("requires both when only one day field is narrowed", () => {
    // `0 9 * * 1` is Mondays, and the day-of-month field being open must not
    // turn that into every day.
    expect(next("0 9 * * 1", "2026-09-22T15:00:00Z")).toBe("2026-09-28T14:00:00.000Z");
  });

  it("finds the 29th of February", () => {
    expect(next("0 9 29 2 *", "2027-01-01T00:00:00Z")).toBe("2028-02-29T15:00:00.000Z");
  });

  it("answers never rather than looping forever", () => {
    // 30 February. Somebody will type it.
    expect(next("0 0 30 2 *", "2026-01-01T00:00:00Z")).toBeNull();
  });

  it("is the same instant in UTC, which is why nothing caught this before", () => {
    // Same expression, same starting instant, five hours apart in the answer.
    expect(next("0 9 * * *", "2026-09-22T06:00:00Z", "UTC")).toBe("2026-09-22T09:00:00.000Z");
    expect(next("0 9 * * *", "2026-09-22T06:00:00Z", AUSTIN)).toBe("2026-09-22T14:00:00.000Z");
  });

  it("works for a company on the other side of the world", () => {
    // Nine in the morning in Sydney on the 23rd is 23:00 UTC on the 22nd.
    expect(next("0 9 * * *", "2026-09-22T12:00:00Z", "Australia/Sydney"))
      .toBe("2026-09-22T23:00:00.000Z");
  });
});

describe("saying what a schedule means", () => {
  it("describes the common ones in words", () => {
    expect(automation.describeSchedule("0 9 * * *")).toBe("Every day at 09:00");
    expect(automation.describeSchedule("30 17 * * 1,5")).toBe("Mon, Fri at 17:30");
  });

  it("says why it could not read one, rather than pretending", () => {
    expect(automation.describeSchedule("nonsense")).toMatch(/five fields/);
  });
});
