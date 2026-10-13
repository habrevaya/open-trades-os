import { describe, it, expect } from "vitest";
import * as time from "../src/time/index.js";

/**
 * M17. WHETHER LEAVE MEETS A VISIT'S HOURS.
 *
 * The question the crew check, the map's suggestions and the multi day
 * rebalance ask about a visit: not "is this person off today" but "is this
 * person off when it is". Central time, the 6th of October 2026 (UTC-5), so
 * 1 PM is 18:00Z.
 */
const at = (iso: string) => new Date(iso);
const leave = (startsAt: string, endsAt: string) => ({ startsAt: at(startsAt), endsAt: at(endsAt) });
const visit = (start: string, end: string) => ({ start: at(start), end: at(end) });

describe("leave against a visit's hours", () => {
  const afternoon = [leave("2026-10-06T18:00:00Z", "2026-10-06T22:00:00Z")];

  it("meets a visit inside the hours off, and one that runs into them", () => {
    expect(time.leaveMeets(afternoon, visit("2026-10-06T19:00:00Z", "2026-10-06T20:00:00Z"))).toBe(true);
    expect(time.leaveMeets(afternoon, visit("2026-10-06T17:00:00Z", "2026-10-06T18:30:00Z"))).toBe(true);
    expect(time.leaveMeets(afternoon, visit("2026-10-06T21:30:00Z", "2026-10-06T23:00:00Z"))).toBe(true);
  });

  it("leaves a visit in the morning, and one after the hours, alone", () => {
    expect(time.leaveMeets(afternoon, visit("2026-10-06T14:00:00Z", "2026-10-06T16:00:00Z"))).toBe(false);
    expect(time.leaveMeets(afternoon, visit("2026-10-06T22:30:00Z", "2026-10-07T00:00:00Z"))).toBe(false);
  });

  it("does not count a visit that ends the moment the leave begins, or begins the moment it ends", () => {
    expect(time.leaveMeets(afternoon, visit("2026-10-06T16:00:00Z", "2026-10-06T18:00:00Z"))).toBe(false);
    expect(time.leaveMeets(afternoon, visit("2026-10-06T22:00:00Z", "2026-10-06T23:00:00Z"))).toBe(false);
  });

  it("meets any visit on a whole day off, and none when there is no leave", () => {
    const whole = [leave("2026-10-06T05:00:00Z", "2026-10-07T05:00:00Z")];
    expect(time.leaveMeets(whole, visit("2026-10-06T13:00:00Z", "2026-10-06T14:00:00Z"))).toBe(true);
    expect(time.leaveMeets([], visit("2026-10-06T13:00:00Z", "2026-10-06T14:00:00Z"))).toBe(false);
  });

  it("reads several rows, and a run across days, against the visit's own hours", () => {
    const runs = [leave("2026-10-05T18:00:00Z", "2026-10-07T17:00:00Z"), leave("2026-10-09T15:00:00Z", "2026-10-09T16:00:00Z")];
    expect(time.leaveMeets(runs, visit("2026-10-06T14:00:00Z", "2026-10-06T15:00:00Z"))).toBe(true);
    expect(time.leaveMeets(runs, visit("2026-10-07T18:00:00Z", "2026-10-07T19:00:00Z"))).toBe(false);
    expect(time.leaveMeets(runs, visit("2026-10-09T15:30:00Z", "2026-10-09T17:00:00Z"))).toBe(true);
  });
});

describe("the hours a visit occupies", () => {
  it("are its window, or an hour's worth of work from its start when it has no end", () => {
    const start = at("2026-10-06T14:00:00Z");
    expect(time.visitSpan(start, at("2026-10-06T16:00:00Z"), 30)).toEqual({ start, end: at("2026-10-06T16:00:00Z") });
    expect(time.visitSpan(start, null, 90)).toEqual({ start, end: at("2026-10-06T15:30:00Z") });
    expect(time.visitSpan(null, null, 60)).toBeNull();
  });

  it("are never empty, so a zero length window still meets the leave it falls inside", () => {
    const start = at("2026-10-06T19:00:00Z");
    const span = time.visitSpan(start, start, 0)!;
    expect(span.end.getTime()).toBeGreaterThan(span.start.getTime());
    expect(time.leaveMeets([leave("2026-10-06T18:00:00Z", "2026-10-06T22:00:00Z")], span)).toBe(true);
  });
});

describe("leave that covers a whole stretch", () => {
  const day = { start: at("2026-10-06T05:00:00Z"), end: at("2026-10-07T05:00:00Z") };

  it("is a row over all of it, however far it runs either side", () => {
    expect(time.leaveCovers([leave("2026-10-06T05:00:00Z", "2026-10-07T05:00:00Z")], day)).toBe(true);
    expect(time.leaveCovers([leave("2026-10-01T05:00:00Z", "2026-10-20T05:00:00Z")], day)).toBe(true);
  });

  it("is two rows that meet, and not two rows with an hour between them", () => {
    expect(time.leaveCovers([leave("2026-10-06T05:00:00Z", "2026-10-06T17:00:00Z"), leave("2026-10-06T17:00:00Z", "2026-10-07T05:00:00Z")], day)).toBe(true);
    expect(time.leaveCovers([leave("2026-10-06T05:00:00Z", "2026-10-06T17:00:00Z"), leave("2026-10-06T18:00:00Z", "2026-10-07T05:00:00Z")], day)).toBe(false);
  });

  it("forgives a minute, because some clients write the end of a day as 23:59", () => {
    expect(time.leaveCovers([leave("2026-10-06T05:00:00Z", "2026-10-07T04:59:00Z")], day)).toBe(true);
    expect(time.leaveCovers([leave("2026-10-06T05:00:00Z", "2026-10-07T04:58:00Z")], day)).toBe(false);
    expect(time.leaveCovers([leave("2026-10-06T05:00:00Z", "2026-10-07T04:58:00Z")], day, 2)).toBe(true);
  });

  it("is not part of a day, and not no leave", () => {
    expect(time.leaveCovers([leave("2026-10-06T18:00:00Z", "2026-10-06T22:00:00Z")], day)).toBe(false);
    expect(time.leaveCovers([], day)).toBe(false);
  });
});

describe("a part day off in words", () => {
  it("says the hours in the company's own clock", () => {
    expect(time.describeLeave([leave("2026-10-06T18:00:00Z", "2026-10-06T22:00:00Z")], "America/Chicago")).toBe("1:00 PM to 5:00 PM");
    expect(time.describeLeave([
      leave("2026-10-06T14:00:00Z", "2026-10-06T15:00:00Z"), leave("2026-10-06T18:00:00Z", "2026-10-06T22:00:00Z"),
    ], "America/Chicago")).toBe("9:00 AM to 10:00 AM and 1:00 PM to 5:00 PM");
  });
});
