import { describe, it, expect } from "vitest";
import { decideLaterMessage, checkReviewWording, type LaterFacts } from "../src/reviews/index.js";
import {
  REVIEW_REMINDER_WORDING, REVIEW_REMINDER_BEFORE_SECOND_WORDING, REVIEW_SECOND_REMINDER_WORDING,
} from "../src/automation/index.js";

/**
 * THE FOLLOW UP BY EMAIL AND THE SECOND REMINDER
 *
 * Each is held to the first reminder's rules, counted from the message before
 * it, and said in its own words when it is withheld.
 */
const policy = { timeZone: "America/Chicago", afterDays: 7, earliestHour: 9, latestHour: 19 };
/** Mid afternoon in Chicago. */
const now = new Date("2026-10-20T20:00:00Z");
const facts = (over: Partial<LaterFacts> = {}): LaterFacts => ({
  jobId: "j", customerId: "c", previousAt: new Date("2026-10-10T20:00:00Z"), done: false,
  reviewSince: false, optedOut: false, complaintOpen: false, callback: null, ...over,
});

describe("deciding a later message", () => {
  it("sends once the days have passed since the message before it, in the sending hours", () => {
    expect(decideLaterMessage("second_reminder", facts(), policy, now)).toEqual({ remind: true, sendAt: now, readyNow: true });
    const night = new Date("2026-10-21T04:00:00Z");
    const held = decideLaterMessage("follow_up", facts(), policy, night);
    expect(held).toMatchObject({ remind: true, readyNow: false });
  });

  it("is off until the company sets the days, and goes once", () => {
    expect(decideLaterMessage("follow_up", facts(), { ...policy, afterDays: null }, now))
      .toMatchObject({ remind: false, explanation: expect.stringContaining("The follow up by email is off") });
    expect(decideLaterMessage("second_reminder", facts({ done: true }), policy, now))
      .toMatchObject({ remind: false, clearsOnItsOwn: false, explanation: expect.stringContaining("second reminder this job gets") });
  });

  it("is held to the first reminder's rules, in its own words", () => {
    expect(decideLaterMessage("second_reminder", facts({ previousAt: new Date("2026-10-18T20:00:00Z") }), policy, now))
      .toMatchObject({ remind: false, clearsOnItsOwn: true, explanation: "The first reminder went out less than 7 days ago." });
    expect(decideLaterMessage("follow_up", facts({ reviewSince: true }), policy, now))
      .toMatchObject({ remind: false, clearsOnItsOwn: false, explanation: expect.stringContaining("a follow up by email would be a nudge") });
    expect(decideLaterMessage("follow_up", facts({ optedOut: true }), policy, now)).toMatchObject({ remind: false, clearsOnItsOwn: false });
    expect(decideLaterMessage("second_reminder", facts({ complaintOpen: true }), policy, now)).toMatchObject({ remind: false, clearsOnItsOwn: true });
  });
});

describe("the words we ship for them", () => {
  it("pass the check every review message is held to", () => {
    expect(checkReviewWording({ ...REVIEW_SECOND_REMINDER_WORDING })).toEqual({ ok: true });
    expect(checkReviewWording({ ...REVIEW_REMINDER_BEFORE_SECOND_WORDING })).toEqual({ ok: true });
  });

  it("say the second is the last, and drop 'only' from the first when a second follows", () => {
    expect(REVIEW_SECOND_REMINDER_WORDING.emailBody).toContain("This is the last reminder we will send.");
    expect(REVIEW_REMINDER_WORDING.emailBody).toContain("only reminder");
    expect(REVIEW_REMINDER_BEFORE_SECOND_WORDING.emailBody).not.toContain("only reminder");
    expect(REVIEW_REMINDER_BEFORE_SECOND_WORDING.sms).toBe(REVIEW_REMINDER_WORDING.sms);
  });
});
