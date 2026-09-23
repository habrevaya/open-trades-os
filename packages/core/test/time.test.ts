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

/**
 * AN HOUR THAT HAPPENS TWICE
 *
 * `instantOfLocal` iterated from a single seed and returned wherever it
 * settled. An ambiguous wall time has two fixed points, and which one it
 * settled on depended on where the seed landed relative to the transition,
 * which depends on the sign of the zone's offset. So it returned the earlier
 * occurrence in America and the LATER one everywhere at or east of
 * Greenwich, while its own comment promised the earlier everywhere.
 *
 * The two real instants are found by brute force rather than written down,
 * so this cannot drift out of date with the zone database and cannot be
 * satisfied by a constant somebody pasted in from a failing run.
 */
describe("an hour that happens twice", () => {
  function bothInstants(date: string, minutes: number, zone: string): string[] {
    const midnight = Date.parse(`${date}T00:00:00Z`);
    const want = `${date} ${String(Math.floor(minutes / 60)).padStart(2, "0")}`
      + `:${String(minutes % 60).padStart(2, "0")}`;
    const found: string[] = [];

    for (let offsetHours = -14; offsetHours <= 14; offsetHours += 0.25) {
      const candidate = new Date(midnight + minutes * 60_000 - offsetHours * 3600_000);
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hour12: false, hour: "2-digit", minute: "2-digit",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(candidate);
      const get = (type: string) => parts.find((p) => p.type === type)!.value;
      const wall = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
      if (wall === want && !found.includes(candidate.toISOString())) {
        found.push(candidate.toISOString());
      }
    }
    return found.sort();
  }

  const CASES = [
    { zone: "America/New_York", date: "2026-11-01", minutes: 90 },
    { zone: "Europe/London", date: "2026-10-25", minutes: 90 },
    { zone: "Europe/Berlin", date: "2026-10-25", minutes: 150 },
    { zone: "Australia/Sydney", date: "2026-04-05", minutes: 150 },
  ];

  it("picks the earlier of the two, in every zone and not only in America", () => {
    const wrong: string[] = [];
    for (const c of CASES) {
      const both = bothInstants(c.date, c.minutes, c.zone);
      // A fixture that found one instant would make the assertion vacuous.
      expect(both, `${c.zone} should have two readings`).toHaveLength(2);

      const got = time.instantOfLocal(c.date, c.minutes, c.zone).toISOString();
      if (got !== both[0]) {
        wrong.push(`${c.zone}: chose ${got}, the later of ${both.join(" and ")}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("still answers an ordinary wall time, where there is only one", () => {
    const summer = time.instantOfLocal("2026-07-01", 90, "Europe/London");
    expect(summer.toISOString()).toBe("2026-07-01T00:30:00.000Z");
  });

  it("returns something for a wall time that never happened", () => {
    /**
     * The spring gap. `wallTimeExists` is the function that says so; this one
     * returns the naive reading rather than throwing, which is what it always
     * did and what every caller is written against.
     */
    expect(time.wallTimeExists("2026-03-29", 90, "Europe/London")).toBe(false);
    expect(() => time.instantOfLocal("2026-03-29", 90, "Europe/London")).not.toThrow();
  });
});
