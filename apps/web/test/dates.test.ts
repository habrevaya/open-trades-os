import { describe, it, expect } from "vitest";
import { todayIn, formatDay } from "../src/lib/dates";

/**
 * "Today" in the company's timezone.
 *
 * The tempting implementation is `new Date().toISOString().slice(0, 10)`,
 * which always answers in UTC whatever the server is set to. A shop in Austin
 * on a UTC server would find that at seven in the evening the dispatch board
 * rolled over to tomorrow and emptied itself, in the busiest part of the day.
 */
describe("the company's today", () => {
  it("is still yesterday's date in Austin at seven in the evening", () => {
    // 00:30 UTC on the 23rd is 19:30 on the 22nd in Chicago.
    const instant = new Date("2026-09-23T00:30:00Z");
    expect(todayIn("America/Chicago", instant)).toBe("2026-09-22");
    // The UTC shortcut gets this wrong, which is the whole point.
    expect(instant.toISOString().slice(0, 10)).toBe("2026-09-23");
  });

  it("is already tomorrow in Auckland at midday UTC", () => {
    expect(todayIn("Pacific/Auckland", new Date("2026-09-22T12:00:00Z"))).toBe("2026-09-23");
  });

  it("agrees with UTC for a company in UTC", () => {
    expect(todayIn("UTC", new Date("2026-09-22T23:59:00Z"))).toBe("2026-09-22");
  });

  it("formats as YYYY-MM-DD, which is what every date parameter expects", () => {
    expect(todayIn("America/New_York", new Date("2026-01-05T15:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("zero pads single digit months and days", () => {
    expect(todayIn("America/Chicago", new Date("2026-01-05T15:00:00Z"))).toBe("2026-01-05");
  });

  it("handles a half hour offset", () => {
    // 18:45 UTC is 00:15 the next day in Kolkata.
    expect(todayIn("Asia/Kolkata", new Date("2026-09-22T18:45:00Z"))).toBe("2026-09-23");
  });
});

/**
 * OVERDUE, AND THE MIDNIGHT THAT BREAKS IT
 *
 * A date with no time in it is a calendar day, not a moment. `new Date("2026-09-06")`
 * parses at UTC midnight, so formatting it in a zone behind UTC renders the
 * day before: an invoice due the 6th shows as due the 5th, and at a due date
 * boundary that is the difference between late and not.
 */
describe("formatting a date-only value", () => {
  it("does not shift a day backwards in a zone behind UTC", () => {
    expect(formatDay("2026-09-06", "America/Chicago")).toBe("Sep 6, 2026");
    expect(formatDay("2026-01-01", "America/Los_Angeles")).toBe("Jan 1, 2026");
  });

  it("does not shift a day forwards in a zone ahead of UTC", () => {
    expect(formatDay("2026-09-06", "Australia/Sydney")).toBe("Sep 6, 2026");
    expect(formatDay("2026-12-31", "Asia/Tokyo")).toBe("Dec 31, 2026");
  });

  it("returns the value unchanged rather than Invalid Date", () => {
    // A malformed date in one row must not replace the cell with a word that
    // looks like a system error to whoever is reading the column.
    expect(formatDay("not-a-date", "America/Chicago")).toBe("not-a-date");
  });
});
