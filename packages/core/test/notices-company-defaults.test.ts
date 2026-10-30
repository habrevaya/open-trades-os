import { describe, it, expect } from "vitest";
import { notices } from "../src/index";

/**
 * WHAT A NEW PERSON'S NOTICES START AS, AND WHO THE OFFICE QUEUE'S KINDS GO TO
 *
 * The company can change what a person added from now on starts with, per
 * kind. These are the rules the settings screen, the API and the database
 * trigger share: the product's own defaults when the company said nothing, the
 * company's over them where it did, no email box on a kind nothing emails, and
 * no text default at all.
 */
describe("the company's defaults for a new person", () => {
  it("are the product's own until the company changes a kind", () => {
    for (const kind of notices.NOTICE_KINDS) {
      const d = notices.defaultsFor([], kind);
      expect(d.inApp).toBe(notices.DEFAULT_SWITCHES.inApp);
      expect(d.push).toBe(notices.DEFAULT_SWITCHES.push);
      expect(d.email).toBe(notices.isEmailKind(kind) ? true : null);
    }
  });

  it("are the company's for a kind it changed and the product's for the rest", () => {
    const saved = [{ kind: "task_deadline", inApp: true, push: false, email: null }];
    expect(notices.defaultsFor(saved, "task_deadline")).toEqual({ inApp: true, push: false, email: null });
    expect(notices.defaultsFor(saved, "po_approval")).toEqual({ inApp: true, push: true, email: null });
  });

  it("keep an email choice only on a kind that is emailed", () => {
    const saved = [
      { kind: "qualification_expiry", inApp: true, push: true, email: false },
      { kind: "task_assigned", inApp: true, push: true, email: true },
    ];
    expect(notices.defaultsFor(saved, "qualification_expiry").email).toBe(false);
    expect(notices.defaultsFor(saved, "task_assigned").email).toBeNull();
  });

  it("refuse a kind that does not exist, a kind listed twice and an email box on a kind nothing emails", () => {
    expect(notices.defaultsProblem([{ kind: "task_deadline" }, { kind: "autopay_failed" }])).toBeNull();
    expect(notices.defaultsProblem([{ kind: "task_asigned" }])).toMatch(/no kind of notice/);
    expect(notices.defaultsProblem([{ kind: "task_deadline" }, { kind: "task_deadline" }])).toMatch(/twice/);
    expect(notices.defaultsProblem([{ kind: "task_deadline", email: true }])).toMatch(/does not come by email/);
    expect(notices.defaultsProblem([{ kind: "qualification_expiry", email: true }])).toBeNull();
  });

  it("have no text setting: the type carries none", () => {
    expect(Object.keys(notices.defaultsFor([], "task_assigned")).sort()).toEqual(["email", "inApp", "push"]);
  });
});

describe("the three kinds the office queue raises", () => {
  const queueKinds = ["task_deadline", "visit_change_requested", "autopay_failed"] as const;

  it("have words and are known kinds", () => {
    for (const kind of queueKinds) {
      expect(notices.isNoticeKind(kind)).toBe(true);
      expect(notices.NOTICE_KIND_WORDS[kind].label.length).toBeGreaterThan(5);
      expect(notices.NOTICE_KIND_WORDS[kind].description).not.toMatch(/\u2013|\u2014/);
    }
  });

  it("each go to the people who hold the permission that answers them", () => {
    expect(notices.QUEUE_KIND_HANDLER).toEqual({
      task_deadline: "task:write",
      visit_change_requested: "visit:reschedule",
      autopay_failed: "payment:charge_saved",
    });
  });

  it("start a new person in the app and on the phone, never by text, and are never emailed", () => {
    for (const kind of queueKinds) {
      expect(notices.switchesFor([], kind)).toEqual({ inApp: true, push: true, text: false });
      expect(notices.isEmailKind(kind)).toBe(false);
    }
  });
});
