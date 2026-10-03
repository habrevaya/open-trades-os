import { describe, it, expect } from "vitest";
import {
  visitNotice, windowWords, pushUrgency, isExpoPushToken, NOTICE_FOR_EVENT,
  newCode, normalizeCode, codeMessage, CODE_LENGTH, CODE_TTL_MINUTES,
  CONFLICT_RULES, OPERATION_KINDS,
} from "../src/field/index.js";
import { EVENTS } from "../src/events/index.js";

/**
 * What a technician's lock screen says when their day changes, when it may
 * ring, and the rules a one time sign in code lives by. Each is pinned as a
 * sentence or a number somebody can read, because a notice is read on a
 * phone in a van and a wrong hour in one sends somebody to the wrong house.
 */

const zone = "America/Chicago";
const start = new Date("2026-10-06T18:00:00Z"); // 1:00 PM in Chicago
const end = new Date("2026-10-06T21:00:00Z");

describe("the notice a change becomes", () => {
  it("names the job, the customer and the window in the company's zone", () => {
    expect(visitNotice({
      kind: "assigned", jobNumber: 1042, customerName: "Nina Patel",
      windowStart: start, windowEnd: end, timezone: zone,
    })).toEqual({
      title: "New job on your day",
      body: "Job 1042, Nina Patel. Tue, Oct 6, 1:00 PM to 4:00 PM.",
    });
  });

  it("says when a new job has no time yet rather than inventing one", () => {
    expect(visitNotice({
      kind: "assigned", jobNumber: 7, customerName: "Al", windowStart: null, windowEnd: null, timezone: zone,
    }).body).toBe("Job 7, Al. No time set yet.");
  });

  it("says a move with both times", () => {
    expect(visitNotice({
      kind: "rescheduled", jobNumber: 1042, customerName: "Nina Patel",
      windowStart: new Date("2026-10-07T14:00:00Z"), windowEnd: new Date("2026-10-07T17:00:00Z"),
      previousWindowStart: start, timezone: zone,
    }).body).toBe("Job 1042, Nina Patel: now Wed, Oct 7, 9:00 AM to 12:00 PM (was Tue, Oct 6, 1:00 PM).");
  });

  it("tells somebody not to go to a cancelled job, and that a job taken away needs nothing", () => {
    const cancelled = visitNotice({
      kind: "cancelled", jobNumber: 9, customerName: "Bo", windowStart: start, windowEnd: null, timezone: zone,
    });
    expect(cancelled.title).toBe("Job cancelled");
    expect(cancelled.body).toBe("Job 9, Bo, Tue, Oct 6, 1:00 PM, is cancelled. Do not go.");
    expect(visitNotice({
      kind: "unassigned", jobNumber: 9, customerName: "Bo", windowStart: null, windowEnd: null, timezone: zone,
    }).body).toBe("Job 9, Bo, is no longer yours. Nothing to do.");
  });

  it("never puts the street address on a lock screen", () => {
    const facts = { jobNumber: 1, customerName: "Nina", windowStart: start, windowEnd: end, timezone: zone };
    for (const kind of ["assigned", "unassigned", "rescheduled", "cancelled"] as const) {
      const notice = visitNotice({ ...facts, kind });
      expect(`${notice.title} ${notice.body}`).not.toMatch(/street|St\b|Ave\b/);
    }
  });

  it("formats a window in the zone it was promised in, not the server's", () => {
    expect(windowWords(start, null, "America/New_York")).toBe("Tue, Oct 6, 2:00 PM");
    expect(windowWords(null, null, zone)).toBeNull();
  });

  it("maps only events the catalogue says are emitted", () => {
    for (const name of Object.keys(NOTICE_FOR_EVENT)) {
      expect(EVENTS[name as keyof typeof EVENTS]?.emitted, name).toBe(true);
    }
  });
});

describe("when a notice may ring", () => {
  const window = { startHour: 21, endHour: 8 };
  // 11:00 PM in Chicago on Oct 5 is 04:00 UTC on Oct 6.
  const lateNight = new Date("2026-10-06T04:00:00Z");
  const elevenPm = 23 * 60;

  it("rings outside quiet hours", () => {
    expect(pushUrgency({ localMinutes: 14 * 60, now: start, window, visitStartsAt: null })).toBe("normal");
  });

  it("is quiet at night for work that starts after the quiet hours end", () => {
    expect(pushUrgency({ localMinutes: elevenPm, now: lateNight, window, visitStartsAt: start })).toBe("quiet");
    expect(pushUrgency({ localMinutes: elevenPm, now: lateNight, window, visitStartsAt: null })).toBe("quiet");
  });

  it("rings at night for work that starts before the quiet hours end", () => {
    const midnight = new Date("2026-10-06T05:00:00Z");
    expect(pushUrgency({ localMinutes: elevenPm, now: lateNight, window, visitStartsAt: midnight })).toBe("normal");
    // 7:30 the next morning, before eight, is still inside the window.
    const halfSeven = new Date("2026-10-06T12:30:00Z");
    expect(pushUrgency({ localMinutes: elevenPm, now: lateNight, window, visitStartsAt: halfSeven })).toBe("normal");
  });

  it("always rings for a company that turned quiet hours off", () => {
    expect(pushUrgency({ localMinutes: elevenPm, now: lateNight, window: null, visitStartsAt: start })).toBe("normal");
  });

  it("counts the time left across midnight in the small hours too", () => {
    // 3:00 AM local: five hours left until eight.
    const threeAm = new Date("2026-10-06T08:00:00Z");
    const sevenAm = new Date("2026-10-06T12:00:00Z");
    const nineAm = new Date("2026-10-06T14:00:00Z");
    expect(pushUrgency({ localMinutes: 180, now: threeAm, window, visitStartsAt: sevenAm })).toBe("normal");
    expect(pushUrgency({ localMinutes: 180, now: threeAm, window, visitStartsAt: nineAm })).toBe("quiet");
  });
});

describe("a push token", () => {
  it("accepts the shapes Expo hands out and nothing else", () => {
    expect(isExpoPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abcdefgh12345678]")).toBe(true);
    expect(isExpoPushToken("")).toBe(false);
    expect(isExpoPushToken("ExponentPushToken[]")).toBe(false);
    expect(isExpoPushToken("fcm:abcdef")).toBe(false);
  });
});

describe("a one time sign in code", () => {
  it("is six digits, zero padded, from the injected source", () => {
    expect(newCode(() => 42)).toBe("000042");
    expect(newCode((max) => max - 1)).toBe("999999");
    expect(newCode(() => 123456)).toHaveLength(CODE_LENGTH);
  });

  it("forgives spaces and dashes and refuses anything else as a typo", () => {
    expect(normalizeCode(" 123 456 ")).toBe("123456");
    expect(normalizeCode("123-456")).toBe("123456");
    expect(normalizeCode("12345")).toBeNull();
    expect(normalizeCode("1234567")).toBeNull();
    expect(normalizeCode("12a456")).toBeNull();
  });

  it("puts the code first and the warning last", () => {
    const text = codeMessage("Patel Plumbing", "123456");
    expect(text.startsWith("123456 is your Patel Plumbing sign in code")).toBe(true);
    expect(text).toContain(`${CODE_TTL_MINUTES} minutes`);
    expect(text.endsWith("Nobody from the office will ever ask you for it.")).toBe(true);
  });
});

describe("money taken on site", () => {
  it("is in the catalogue and always applies", () => {
    expect(OPERATION_KINDS).toContain("payment.collect");
    expect(CONFLICT_RULES["payment.collect"]).toBe("append");
  });
});
