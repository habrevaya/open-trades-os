import { describe, it, expect } from "vitest";
import { notices } from "../src/index";

/**
 * TELLING THE COMPANY'S OWN PEOPLE
 *
 * The decisions the worker, the API and `/me` share: what a person gets
 * before they change anything, whether a text to their own mobile may go now,
 * wait for the morning or not go, and when a licence running out or an
 * unsigned talk is news.
 */
const now = new Date("2026-10-06T15:00:00Z");
const NINE_TO_EIGHT = { startHour: 21, endHour: 8 };
const consented: notices.StaffTextConsent = { state: "granted", address: "+15125550100" };
const ask = (overrides: Partial<Parameters<typeof notices.textDecision>[0]> = {}) => notices.textDecision({
  consent: consented,
  address: "+15125550100",
  suppressions: [],
  channelRegistered: true,
  quietHours: NINE_TO_EIGHT,
  localMinutes: 10 * 60,
  now,
  ...overrides,
});

describe("what a person gets before they change anything", () => {
  it("is the app and the phone, never a text", () => {
    expect(notices.DEFAULT_SWITCHES).toEqual({ inApp: true, push: true, text: false });
    for (const kind of notices.NOTICE_KINDS) {
      expect(notices.switchesFor([], kind)).toEqual(notices.DEFAULT_SWITCHES);
    }
  });

  it("is what they saved for a kind they changed, and the default for the rest", () => {
    const saved = [{ kind: "expense_decided", inApp: false, push: false, text: true }];
    expect(notices.switchesFor(saved, "expense_decided")).toEqual({ inApp: false, push: false, text: true });
    expect(notices.switchesFor(saved, "po_approval")).toEqual(notices.DEFAULT_SWITCHES);
  });

  it("has words for every kind, and knows a kind from a typo", () => {
    for (const kind of notices.NOTICE_KINDS) {
      expect(notices.NOTICE_KIND_WORDS[kind].label.length).toBeGreaterThan(3);
      expect(notices.isNoticeKind(kind)).toBe(true);
    }
    expect(notices.isNoticeKind("task_asigned")).toBe(false);
  });
});

describe("a text to a member of staff's own mobile", () => {
  it("goes in the working day when they turned texts on", () => {
    expect(ask()).toEqual({ action: "send" });
  });

  it("never goes without their own say so, whatever else is true", () => {
    expect(ask({ consent: null })).toEqual({ action: "refuse", reason: "no_consent" });
    expect(ask({ consent: { ...consented, state: "revoked" } })).toEqual({ action: "refuse", reason: "no_consent" });
  });

  it("does not go after a STOP from that number, even with texts still switched on", () => {
    expect(ask({ suppressions: [{ channel: "sms", purpose: null }] })).toEqual({ action: "refuse", reason: "suppressed" });
    // A lifted STOP is no longer one.
    expect(ask({ suppressions: [{ channel: "sms", purpose: null, liftedAt: now }] })).toEqual({ action: "send" });
  });

  it("does not follow a person to a new number with a text raised for the old one", () => {
    expect(ask({ consent: { state: "granted", address: "+15125550199" } }))
      .toEqual({ action: "refuse", reason: "number_changed" });
  });

  it("says when the company has no number that can send", () => {
    expect(ask({ channelRegistered: false })).toEqual({ action: "refuse", reason: "channel_not_registered" });
  });

  it("waits for the morning inside quiet hours rather than being lost", () => {
    // Eleven at night, company time: held until eight, nine hours on.
    const decision = ask({ localMinutes: 23 * 60 });
    expect(decision).toEqual({ action: "hold", until: new Date(now.getTime() + 9 * 3_600_000) });
    // Half past six in the morning: an hour and a half to go.
    expect(ask({ localMinutes: 6 * 60 + 30 })).toEqual({ action: "hold", until: new Date(now.getTime() + 90 * 60_000) });
  });

  it("goes at any hour when the company turned quiet hours off", () => {
    expect(ask({ quietHours: null, localMinutes: 2 * 60 })).toEqual({ action: "send" });
  });

  it("explains every refusal in words", () => {
    for (const reason of ["suppressed", "no_consent", "number_changed", "channel_not_registered"] as const) {
      expect(notices.textRefusalWords(reason)).not.toMatch(/_/);
    }
  });
});

describe("a licence or a skill running out", () => {
  it("is news from thirty days before, and on the day", () => {
    expect(notices.expiryNoticeDue("2026-11-05", "2026-10-05")).toBeNull();
    expect(notices.expiryNoticeDue("2026-11-05", "2026-10-06")).toBe("soon");
    expect(notices.expiryNoticeDue("2026-11-05", "2026-11-04")).toBe("soon");
    expect(notices.expiryNoticeDue("2026-11-05", "2026-11-05")).toBe("today");
  });

  it("is still said a few days late by a worker that was down, and not a season late", () => {
    expect(notices.expiryNoticeDue("2026-11-05", "2026-11-11")).toBe("today");
    expect(notices.expiryNoticeDue("2026-11-05", "2026-11-12")).toBeNull();
    expect(notices.expiryNoticeDue("2026-03-01", "2026-11-05")).toBeNull();
  });

  it("counts days across a month end and says them plainly", () => {
    expect(notices.daysUntil("2026-11-02", "2026-10-21")).toBe(12);
    expect(notices.expirySentence("EPA 608", "2026-11-02", "2026-10-21")).toBe("EPA 608 runs out in 12 days, on 2026-11-02.");
    expect(notices.expirySentence("EPA 608", "2026-11-02", "2026-11-01")).toBe("EPA 608 runs out tomorrow, 2026-11-02.");
    expect(notices.expirySentence("EPA 608", "2026-11-02", "2026-11-02")).toBe("EPA 608 runs out today.");
    expect(notices.expirySentence("EPA 608", "2026-11-02", "2026-11-04")).toBe("EPA 608 ran out on 2026-11-02.");
  });
});

describe("a time in the words of a notice", () => {
  it("is the company's wall clock, not UTC", () => {
    expect(notices.localWhen(new Date("2026-10-06T19:30:00Z"), "America/Chicago")).toBe("2026-10-06 at 14:30");
    expect(notices.localWhen(new Date("2026-10-07T03:05:00Z"), "America/Chicago")).toBe("2026-10-06 at 22:05");
  });
});

describe("an unsigned toolbox talk", () => {
  const heldAt = new Date("2026-10-06T12:00:00Z");
  it("is not nudged while the talk is still going", () => {
    expect(notices.talkNudgeDue(heldAt, new Date(heldAt.getTime() + 30 * 60_000))).toBe(false);
  });
  it("is nudged an hour on, and left to the office after a week", () => {
    expect(notices.talkNudgeDue(heldAt, new Date(heldAt.getTime() + 60 * 60_000))).toBe(true);
    expect(notices.talkNudgeDue(heldAt, new Date(heldAt.getTime() + 8 * 86_400_000))).toBe(false);
  });
});
