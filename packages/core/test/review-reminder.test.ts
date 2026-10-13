import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  decideReminder, checkReminderDays, REMINDER_INPUTS, MIN_REMINDER_DAYS, MAX_REMINDER_DAYS,
  type ReminderFacts, type ReminderPolicy,
} from "../src/reviews/index.js";

/**
 * THE ONE REMINDER
 *
 * A company may follow up once on an ask nobody answered. It is off until the
 * company says how many days, it is sent once, it is skipped for a customer a
 * review is tied to (or suspected to be from) whatever it says, and it keeps
 * to the same sending hours, opt outs, complaints and callbacks the ask does.
 * Like the ask it reads nothing about what anybody is expected to say.
 */
const NOW = new Date("2026-06-17T16:00:00Z"); // noon in Chicago, a Wednesday
const ASKED = new Date("2026-06-10T15:00:00Z");

const POLICY: ReminderPolicy = { timeZone: "America/Chicago", reminderAfterDays: 5, earliestHour: 9, latestHour: 19 };
const facts = (over: Partial<ReminderFacts> = {}): ReminderFacts => ({
  jobId: "job-1", customerId: "cust-1", askedAt: ASKED, reminded: false, reviewSince: false,
  optedOut: false, complaintOpen: false, callback: null, ...over,
});

describe("when a reminder goes", () => {
  it("is off until the company says how many days", () => {
    const decision = decideReminder(facts(), { ...POLICY, reminderAfterDays: null }, NOW);
    expect(decision).toMatchObject({ remind: false, withheld: "reminders_off", clearsOnItsOwn: false });
  });

  it("waits the days, from when the ask went out", () => {
    expect(decideReminder(facts(), POLICY, new Date("2026-06-15T14:59:00Z"))).toMatchObject({ remind: false, withheld: "too_soon" });
    expect(decideReminder(facts(), POLICY, new Date("2026-06-15T15:00:00Z"))).toMatchObject({ remind: true, readyNow: true });
  });

  it("goes now inside the sending hours, and waits for the morning outside them", () => {
    const evening = new Date("2026-06-18T02:00:00Z"); // nine at night in Chicago
    const decision = decideReminder(facts(), POLICY, evening);
    expect(decision).toMatchObject({ remind: true, readyNow: false });
    if (decision.remind) expect(decision.sendAt.toISOString()).toBe("2026-06-18T14:00:00.000Z");
  });

  it("is sent once", () => {
    expect(decideReminder(facts({ reminded: true }), POLICY, NOW))
      .toMatchObject({ remind: false, withheld: "reminder_already_sent", clearsOnItsOwn: false });
  });
});

describe("who is not reminded", () => {
  it("is a customer who opted out", () => {
    expect(decideReminder(facts({ optedOut: true }), POLICY, NOW)).toMatchObject({ remind: false, withheld: "customer_opted_out" });
  });

  it("is a customer a review is tied to, or suspected to be from, since the ask", () => {
    expect(decideReminder(facts({ reviewSince: true }), POLICY, NOW))
      .toMatchObject({ remind: false, withheld: "review_since_ask", clearsOnItsOwn: false });
  });

  it("is held by an open complaint and an unresolved callback, which clear themselves", () => {
    expect(decideReminder(facts({ complaintOpen: true }), POLICY, NOW)).toMatchObject({ withheld: "complaint_open", clearsOnItsOwn: true });
    expect(decideReminder(facts({ callback: { resolvedAt: null } }), POLICY, NOW)).toMatchObject({ withheld: "callback_unresolved" });
    expect(decideReminder(facts({ callback: { resolvedAt: new Date("2026-06-12T12:00:00Z") } }), POLICY, NOW)).toMatchObject({ remind: true });
  });

  it("says why in words for somebody asking why a customer was not reminded", () => {
    const decision = decideReminder(facts({ reviewSince: true }), POLICY, NOW);
    expect(decision.remind === false && decision.explanation).toMatch(/already answered/);
  });
});

describe("how many days may be asked for", () => {
  it("is between three and sixty whole days, or off", () => {
    expect(checkReminderDays(null).ok).toBe(true);
    expect(checkReminderDays(MIN_REMINDER_DAYS).ok).toBe(true);
    expect(checkReminderDays(MAX_REMINDER_DAYS).ok).toBe(true);
    expect(checkReminderDays(2).ok).toBe(false);
    expect(checkReminderDays(61).ok).toBe(false);
    expect(checkReminderDays(4.5).ok).toBe(false);
  });
});

describe("what the reminder is not allowed to read", () => {
  /** Records every property the decision touches, as the ask's own test does. */
  function watched(input: ReminderFacts): { proxy: ReminderFacts; read: Set<string> } {
    const read = new Set<string>();
    const wrap = <T extends object>(target: T, prefix: string): T => new Proxy(target, {
      get(object, property, receiver) {
        if (typeof property !== "string") return Reflect.get(object, property, receiver);
        const path = prefix === "" ? property : `${prefix}.${property}`;
        read.add(path);
        const value: unknown = Reflect.get(object, property, receiver);
        return value !== null && typeof value === "object" && !(value instanceof Date) ? wrap(value as object, path) : value;
      },
    });
    return { proxy: wrap(input, ""), read };
  }

  it("reads only the declared facts, none of them a guess about what the customer will say", () => {
    const shapes = [
      facts(), facts({ reminded: true }), facts({ optedOut: true }), facts({ reviewSince: true }), facts({ complaintOpen: true }),
      facts({ callback: { resolvedAt: null } }), facts({ callback: { resolvedAt: new Date("2026-06-12T12:00:00Z") } }),
    ];
    const allowed = new Set(REMINDER_INPUTS);
    for (const shape of shapes) {
      const { proxy, read } = watched(shape);
      decideReminder(proxy, POLICY, NOW);
      for (const path of read) expect(allowed.has(path), `the reminder read "${path}", which is not in REMINDER_INPUTS`).toBe(true);
    }
    expect(Object.isFrozen(REMINDER_INPUTS)).toBe(true);
  });

  it("ignores a prediction attached to the facts", () => {
    const plain = decideReminder(facts(), POLICY, NOW);
    const smuggled = decideReminder({ ...facts(), predictedRating: 1, rating: 5, likelyToComplain: true } as unknown as ReminderFacts, POLICY, NOW);
    expect(smuggled).toEqual(plain);
  });

  it("has no word in its code for guessing how pleased anybody is", () => {
    const source = readFileSync(new URL("../src/reviews/index.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, "``");
    expect(source).not.toMatch(/sentiment|predict|happy|satisf|mood/i);
  });
});

describe("the reminder's words and the choice of jobs", () => {
  it("offer nothing and push toward no number of stars, and use no dashes", async () => {
    const { REVIEW_REMINDER_WORDING } = await import("../src/automation/index.js");
    for (const text of [REVIEW_REMINDER_WORDING.sms, REVIEW_REMINDER_WORDING.emailSubject, REVIEW_REMINDER_WORDING.emailBody]) {
      expect(text).not.toMatch(/five star|5 star|discount|free|\$|gift|reward|in exchange/i);
      expect(text).not.toMatch(/\u2014|\u2013/);
    }
    expect(REVIEW_REMINDER_WORDING.emailBody).toContain("only reminder");
  });

  it("builds the paid-only automation as before, and the every-finished-job one with three triggers", async () => {
    const { buildTemplate } = await import("../src/automation/index.js");
    const paid = buildTemplate("review_after_paid", { hours: 2, platform: "google" });
    const finished = buildTemplate("review_after_paid", { hours: 2, platform: "google", jobs: "finished" });
    if (!paid.ok || !finished.ok) throw new Error("did not build");
    expect(paid.definition.triggerEvents).toEqual(["invoice.paid"]);
    expect(finished.definition.triggerEvents).toEqual(["invoice.paid", "invoice.credited", "job.completed"]);
    expect(JSON.stringify(paid.definition.steps)).not.toContain("uninvoiced");
    expect(JSON.stringify(finished.definition.steps)).toContain("\"uninvoiced\":true");
    expect(buildTemplate("review_after_paid", { hours: 2, platform: "google", jobs: "all" }).ok).toBe(false);
  });
});
