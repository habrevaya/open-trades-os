import { describe, it, expect } from "vitest";
import {
  TEMPLATES, buildTemplate, flattenPlan, checkBranches, canPublish, STEP_PERMISSIONS,
  CHECKS, isCheck, REVIEW_ASK_WORDING, REVIEW_ASK_CHANNELS, DEFAULT_REVIEW_ASK_CHANNEL, isReviewAskChannel,
} from "../src/automation/index.js";
import { SUBSCRIBABLE } from "../src/events/index.js";
import { ROLE_PRESETS } from "../src/access/roles.js";
import type { Permission } from "../src/access/permissions.js";

/**
 * A RECOMMENDED AUTOMATION IS AN ORDINARY ONE
 *
 * What a template installs goes through the same check a hand built workflow
 * does. These tests hold the half of that which needs no database: every
 * template builds into a definition the engine would accept, on an event that
 * is actually emitted, out of steps the engine knows.
 */
const values: Record<string, Record<string, unknown>> = {
  estimate_follow_up: { days: 3 },
  review_after_paid: { hours: 2, platform: "google" },
};

describe("every recommended automation", () => {
  for (const template of TEMPLATES) {
    it(`${template.key} builds into something the engine would publish`, () => {
      const built = buildTemplate(template.key, values[template.key] ?? {});
      expect(built.ok).toBe(true);
      if (!built.ok) return;

      for (const name of built.definition.triggerEvents) {
        expect(SUBSCRIBABLE as string[]).toContain(name);
      }

      const steps = flattenPlan(built.definition.steps);
      expect(checkBranches(steps)).toEqual([]);
      for (const step of steps) expect(STEP_PERMISSIONS).toHaveProperty(step.kind);

      // An owner holds everything a template needs, so the owner can turn it on.
      const owner = new Set(ROLE_PRESETS.owner.permissions as Permission[]);
      expect(canPublish(owner, steps).ok).toBe(true);
    });
  }
});

describe("following up an estimate", () => {
  it("waits, asks again whether it is still open, texts, emails and then raises a call", () => {
    const built = buildTemplate("estimate_follow_up", { days: 5 });
    if (!built.ok) throw new Error(built.reason);
    const steps = flattenPlan(built.definition.steps);
    expect(steps.map((s) => s.kind)).toEqual([
      "wait", "stop_unless", "send_estimate", "send_estimate", "create_task",
    ]);
    expect(steps[0]!.config).toEqual({ days: 5, hours: 0 });
    expect(isCheck(steps[1]!.config!["check"])).toBe(true);
    expect(steps.map((s) => s.config?.["channel"]).filter(Boolean)).toEqual(["sms", "email"]);
    expect(built.definition.triggerEvents).toEqual(["estimate.sent"]);
  });

  it("defaults the wait, and refuses one outside its bounds rather than clamping it", () => {
    const defaulted = buildTemplate("estimate_follow_up", {});
    expect(defaulted.ok && flattenPlan(defaulted.definition.steps)[0]!.config).toEqual({ days: 3, hours: 0 });
    expect(buildTemplate("estimate_follow_up", { days: 90 })).toEqual({
      ok: false, reason: "Days to wait after sending cannot be more than 30.",
    });
    expect(buildTemplate("estimate_follow_up", { days: "2.5" }).ok).toBe(false);
  });
});

describe("asking for a review", () => {
  it("runs on a paid invoice and asks the reviews module before it sends anything", () => {
    const built = buildTemplate("review_after_paid", { hours: 4, platform: "google" });
    if (!built.ok) throw new Error(built.reason);
    expect(built.definition.triggerEvents).toEqual(["invoice.paid"]);
    expect(flattenPlan(built.definition.steps).map((s) => s.kind))
      .toEqual(["wait", "request_review", "send_review_request"]);
  });

  it("needs to know where to send them", () => {
    expect(buildTemplate("review_after_paid", { hours: 2 }).ok).toBe(false);
  });

  const askStep = (values: Record<string, unknown>) => {
    const built = buildTemplate("review_after_paid", { hours: 2, platform: "google", ...values });
    if (!built.ok) throw new Error(built.reason);
    return flattenPlan(built.definition.steps).find((s) => s.kind === "send_review_request")!;
  };

  it("asks by text unless told otherwise", () => {
    expect(askStep({}).config).toEqual({ channel: "sms", body: REVIEW_ASK_WORDING.sms });
    expect(askStep({ channel: "sms" }).config).toEqual({ channel: "sms", body: REVIEW_ASK_WORDING.sms });
  });

  it("asks by email when that is the choice, with a subject of its own", () => {
    expect(askStep({ channel: "email" }).config).toEqual({
      channel: "email", subject: REVIEW_ASK_WORDING.emailSubject, body: REVIEW_ASK_WORDING.emailBody,
    });
  });

  it("asks by text first and then email in one step, so the email can never be sent as well as the text", () => {
    const built = buildTemplate("review_after_paid", { hours: 2, platform: "google", channel: "sms_then_email" });
    if (!built.ok) throw new Error(built.reason);
    const steps = flattenPlan(built.definition.steps);
    expect(steps.map((s) => s.kind)).toEqual(["wait", "request_review", "send_review_request"]);
    expect(steps[2]!.config).toEqual({
      channel: "sms_then_email", body: REVIEW_ASK_WORDING.sms,
      subject: REVIEW_ASK_WORDING.emailSubject, emailBody: REVIEW_ASK_WORDING.emailBody,
    });
    expect(built.definition.description).toContain("by text, then by email if the text cannot be sent");
  });

  it("refuses a way of asking that is not one of the three, rather than choosing one", () => {
    expect(buildTemplate("review_after_paid", { hours: 2, platform: "google", channel: "fax" })).toEqual({
      ok: false, reason: "How to ask has to be by text, by email, or by text first and then email.",
    });
  });

  it("declares the choice as a parameter, three ways with text the default", () => {
    const parameter = TEMPLATES.find((t) => t.key === "review_after_paid")!.parameters.find((p) => p.key === "channel")!;
    expect(parameter.kind).toBe("choice");
    expect(parameter.options!.map((o) => o.value)).toEqual(["sms", "email", "sms_then_email"]);
    expect(parameter.defaultChoice).toBe(DEFAULT_REVIEW_ASK_CHANNEL);
    expect(REVIEW_ASK_CHANNELS.every((c) => isReviewAskChannel(c.value))).toBe(true);
    expect(isReviewAskChannel("both")).toBe(false);
  });

  it("writes nothing a customer would take for an incentive or a nudge toward five stars", () => {
    for (const text of [REVIEW_ASK_WORDING.sms, REVIEW_ASK_WORDING.emailSubject, REVIEW_ASK_WORDING.emailBody]) {
      expect(text).not.toMatch(/five star|5 star|discount|free|\$|gift|reward|in exchange/i);
      expect(text).not.toMatch(/\u2014|\u2013/);
    }
  });
});

describe("texting back a missed call", () => {
  it("waits, looks again, texts the caller and raises a call back, on a missed call", () => {
    const built = buildTemplate("missed_call_text_back", { minutes: 3 });
    if (!built.ok) throw new Error(built.reason);
    expect(built.definition.triggerEvents).toEqual(["call.missed"]);
    const steps = flattenPlan(built.definition.steps);
    expect(steps.map((s) => s.kind)).toEqual(["wait", "stop_unless", "text_caller", "create_task"]);
    expect(steps[0]!.config).toEqual({ minutes: 3 });
    expect(steps[1]!.config).toEqual({ check: "caller_not_reached" });
  });

  it("texts at once when told to wait nought minutes, rather than writing a wait of nothing", () => {
    const built = buildTemplate("missed_call_text_back", { minutes: 0 });
    if (!built.ok) throw new Error(built.reason);
    expect(flattenPlan(built.definition.steps)[0]!.kind).toBe("stop_unless");
  });

  it("refuses an hour of waiting, which is a call back nobody needs any more", () => {
    expect(buildTemplate("missed_call_text_back", { minutes: 61 }).ok).toBe(false);
  });

  it("needs only the permission to send a message to text the caller", () => {
    expect(STEP_PERMISSIONS["text_caller"]).toEqual(["message:send"]);
  });
});

describe("the checks a run can ask again", () => {
  it("names only what the catalogue declares", () => {
    expect(isCheck("estimate_undecided")).toBe(true);
    expect(isCheck("caller_not_reached")).toBe(true);
    expect(isCheck("__proto__")).toBe(false);
    expect(isCheck("drop table")).toBe(false);
    expect(Object.keys(CHECKS)).toEqual([
      "estimate_undecided", "caller_not_reached", "invoice_unpaid", "visit_still_booked", "job_not_done",
    ]);
  });

  it("refuses a template nobody wrote", () => {
    expect(buildTemplate("nope", {}).ok).toBe(false);
  });
});

describe("ringing before a warranty runs out", () => {
  it("waits on the warranty sweep rather than an event, and raises one call about the unit", () => {
    const built = buildTemplate("warranty_call", { days: 45 });
    if (!built.ok) throw new Error(built.reason);
    expect(built.definition.triggerKind).toBe("dwell");
    expect(built.definition.triggerEvents).toEqual([]);
    expect(built.definition.dwell).toEqual({ shape: "warranty_lapsing", afterDays: 45 });
    const steps = flattenPlan(built.definition.steps);
    expect(steps.map((s) => s.kind)).toEqual(["create_task"]);
    expect(String(steps[0]!.config!["title"])).toContain("{{ until }}");
  });

  it("is off for new companies, like every recommended automation but the estimate follow up", () => {
    expect(TEMPLATES.find((t) => t.key === "warranty_call")!.onForNewCompanies).not.toBe(true);
    expect(buildTemplate("warranty_call", {}).ok && buildTemplate("warranty_call", {})).toMatchObject({
      definition: { dwell: { afterDays: 30 } },
    });
    expect(buildTemplate("warranty_call", { days: 0 })).toEqual({
      ok: false, reason: "Days before the warranty ends cannot be less than 1.",
    });
  });
});

describe("the questions a run can ask again", () => {
  it("knows the invoice, visit and job questions as well as the first two", () => {
    for (const key of ["estimate_undecided", "caller_not_reached", "invoice_unpaid", "visit_still_booked", "job_not_done"]) {
      expect(isCheck(key)).toBe(true);
    }
    expect(CHECKS.invoice_unpaid.entity).toBe("invoice");
    expect(isCheck("__proto__")).toBe(false);
    expect(isCheck("toString")).toBe(false);
  });
});
