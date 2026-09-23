import { describe, it, expect } from "vitest";
import { time } from "../src/index";

/**
 * A CALENDAR DAY IS NOT TWENTY FOUR HOURS FROM UTC MIDNIGHT
 *
 * The dispatch board bounded its day with `new Date(\`${date}T00:00:00Z\`)`,
 * which for a shop in Austin runs from seven the previous evening to seven
 * that evening. An emergency booked for nine at night was not on today's
 * board, and the evening before was, all day. It shipped, and it is visible
 * in a marketing screenshot: an unassigned emergency the caption describes
 * and the picture does not contain.
 */

const AUSTIN = "America/Chicago";

describe("the bounds of a calendar day", () => {
  it("starts at local midnight, not UTC midnight", () => {
    // Austin is five hours behind UTC in September.
    const { start } = time.dayBoundsIn("2026-09-22", AUSTIN);
    expect(start.toISOString()).toBe("2026-09-22T05:00:00.000Z");
  });

  it("contains an evening appointment on its own day", () => {
    /**
     * The failure itself. Nine at night in Austin on the 22nd is two in the
     * morning on the 23rd in UTC, so the old bounds put it on the next day's
     * board, where nobody dispatching that evening would look.
     */
    const evening = new Date("2026-09-23T02:00:00Z");
    const { start, end } = time.dayBoundsIn("2026-09-22", AUSTIN);
    expect(evening >= start && evening < end).toBe(true);

    // And not on the next day, which is where it used to appear.
    const tomorrow = time.dayBoundsIn("2026-09-23", AUSTIN);
    expect(evening >= tomorrow.start).toBe(false);
  });

  it("leaves the previous evening out", () => {
    // The other half. Eight in the evening on the 21st was inside the UTC
    // window for the 22nd, so it sat on today's board all day.
    const yesterdayEvening = new Date("2026-09-22T01:00:00Z");
    const { start } = time.dayBoundsIn("2026-09-22", AUSTIN);
    expect(yesterdayEvening >= start).toBe(false);
  });

  it("is twenty four hours on an ordinary day", () => {
    const { start, end } = time.dayBoundsIn("2026-09-22", AUSTIN);
    expect(end.getTime() - start.getTime()).toBe(24 * 3600_000);
  });

  it("is twenty three hours when the clocks go forward", () => {
    // Daylight saving starts on 8 March 2026 in the United States. A day
    // bounded by start plus 864e5 would run an hour into the next one.
    const { start, end } = time.dayBoundsIn("2026-03-08", AUSTIN);
    expect(end.getTime() - start.getTime()).toBe(23 * 3600_000);
  });

  it("is twenty five hours when the clocks go back", () => {
    // 1 November 2026.
    const { start, end } = time.dayBoundsIn("2026-11-01", AUSTIN);
    expect(end.getTime() - start.getTime()).toBe(25 * 3600_000);
  });

  it("handles a zone that is not a whole number of hours off", () => {
    // India is five and a half hours ahead. A helper built on whole hours
    // would be half an hour wrong for every shop in the country.
    const { start } = time.dayBoundsIn("2026-09-22", "Asia/Kolkata");
    expect(start.toISOString()).toBe("2026-09-21T18:30:00.000Z");
  });

  it("handles a zone ahead of UTC at all", () => {
    const { start } = time.dayBoundsIn("2026-09-22", "Australia/Sydney");
    expect(start.toISOString()).toBe("2026-09-21T14:00:00.000Z");
  });

  it("is the identity in UTC, which is what makes the bug invisible in CI", () => {
    const { start, end } = time.dayBoundsIn("2026-09-22", "UTC");
    expect(start.toISOString()).toBe("2026-09-22T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-23T00:00:00.000Z");
  });

  it("refuses something that is not a date", () => {
    expect(() => time.dayBoundsIn("not a date", AUSTIN)).toThrow(/calendar date/);
  });
});

describe("a span of whole days", () => {
  it("covers exactly that many local days", () => {
    const { start, end } = time.daysFrom("2026-09-22", 3, AUSTIN);
    expect(start.toISOString()).toBe("2026-09-22T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-25T05:00:00.000Z");
  });

  it("is 167 hours for a week containing a spring forward", () => {
    // Not 168. A technician's sync window built on start plus n times 864e5
    // would end an hour late, which is a visit either missing or duplicated
    // at the boundary depending on which end moved.
    const { start, end } = time.daysFrom("2026-03-05", 7, AUSTIN);
    expect((end.getTime() - start.getTime()) / 3600_000).toBe(167);
  });

  it("gives an empty span for zero days rather than a backwards one", () => {
    const { start, end } = time.daysFrom("2026-09-22", 0, AUSTIN);
    expect(start.getTime()).toBe(end.getTime());
  });
});

describe("the date an instant falls on", () => {
  it("is the company's date, not the server's", () => {
    // The same instant, two answers. This is the whole reason the helper
    // takes a zone instead of reading the process's.
    const instant = new Date("2026-09-23T02:00:00Z");
    expect(time.dateIn(instant, AUSTIN)).toBe("2026-09-22");
    expect(time.dateIn(instant, "UTC")).toBe("2026-09-23");
  });
});
