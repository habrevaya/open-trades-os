import { describe, it, expect } from "vitest";
import * as time from "../src/time/index.js";

/**
 * M17. WHAT A DAY'S LEAVE COVERS.
 *
 * Central time, the 6th of October 2026 (UTC-5): the day runs from 05:00Z to
 * 05:00Z the next morning. Each case is worked out by hand in the comment.
 */
const ZONE = "America/Chicago";
const day = time.dayBoundsIn("2026-10-06", ZONE);
const at = (iso: string) => new Date(iso);
const leave = (startsAt: string, endsAt: string) => ({ startsAt: at(startsAt), endsAt: at(endsAt) });
const iso = (d: Date) => d.toISOString();

describe("leave on a day", () => {
  it("is nothing for a day with no leave", () => {
    expect(time.leaveOnDay([], day)).toEqual({ whole: false, spans: [] });
  });

  it("is the whole day for a row that covers it, however far it runs either side", () => {
    expect(time.leaveOnDay([leave("2026-10-06T05:00:00Z", "2026-10-07T05:00:00Z")], day).whole).toBe(true);
    expect(time.leaveOnDay([leave("2026-10-01T05:00:00Z", "2026-10-20T05:00:00Z")], day).whole).toBe(true);
  });

  it("is only the hours for part of the day: 1 to 5 in the afternoon is 18:00Z to 22:00Z", () => {
    const result = time.leaveOnDay([leave("2026-10-06T18:00:00Z", "2026-10-06T22:00:00Z")], day);
    expect(result.whole).toBe(false);
    expect(result.spans.map((s) => [iso(s.startsAt), iso(s.endsAt)])).toEqual([["2026-10-06T18:00:00.000Z", "2026-10-06T22:00:00.000Z"]]);
  });

  it("clips a run that starts part way through the first day and ends part way through the last", () => {
    /** From 1 PM on the 5th to noon on the 7th: the 6th in the middle is all of it. */
    const run = leave("2026-10-05T18:00:00Z", "2026-10-07T17:00:00Z");
    expect(time.leaveOnDay([run], day).whole).toBe(true);
    /** The 5th is from 1 PM to the end of that day; the 7th is from the start to noon. */
    const first = time.leaveOnDay([run], time.dayBoundsIn("2026-10-05", ZONE));
    expect(first.whole).toBe(false);
    expect(first.spans.map((s) => [iso(s.startsAt), iso(s.endsAt)])).toEqual([["2026-10-05T18:00:00.000Z", "2026-10-06T05:00:00.000Z"]]);
    const last = time.leaveOnDay([run], time.dayBoundsIn("2026-10-07", ZONE));
    expect(last.spans.map((s) => [iso(s.startsAt), iso(s.endsAt)])).toEqual([["2026-10-07T05:00:00.000Z", "2026-10-07T17:00:00.000Z"]]);
  });

  it("joins rows that meet or overlap, and keeps separate hours apart", () => {
    const joined = time.leaveOnDay([
      leave("2026-10-06T15:00:00Z", "2026-10-06T17:00:00Z"),
      leave("2026-10-06T17:00:00Z", "2026-10-06T19:00:00Z"),
      leave("2026-10-06T18:00:00Z", "2026-10-06T20:00:00Z"),
      leave("2026-10-06T22:00:00Z", "2026-10-06T23:00:00Z"),
    ], day);
    expect(joined.spans.map((s) => [iso(s.startsAt), iso(s.endsAt)])).toEqual([
      ["2026-10-06T15:00:00.000Z", "2026-10-06T20:00:00.000Z"],
      ["2026-10-06T22:00:00.000Z", "2026-10-06T23:00:00.000Z"],
    ]);
    /** A morning and an afternoon that meet are the whole day. */
    expect(time.leaveOnDay([
      leave("2026-10-06T05:00:00Z", "2026-10-06T17:00:00Z"),
      leave("2026-10-06T17:00:00Z", "2026-10-07T05:00:00Z"),
    ], day).whole).toBe(true);
  });

  it("does not count a row that only touches the day", () => {
    /** Whole days off tomorrow start the instant today ends. Today is not off. */
    expect(time.leaveOnDay([leave("2026-10-07T05:00:00Z", "2026-10-08T05:00:00Z")], day)).toEqual({ whole: false, spans: [] });
    expect(time.leaveOnDay([leave("2026-10-05T05:00:00Z", "2026-10-06T05:00:00Z")], day)).toEqual({ whole: false, spans: [] });
  });
});
