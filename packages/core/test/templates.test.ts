import { describe, it, expect } from "vitest";
import {
  TEMPLATES, buildTemplate, flattenPlan, checkBranches, canPublish, STEP_PERMISSIONS,
  CHECKS, isCheck,
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
      "agreement_active", "agreement_not_renewed", "agreement_renewed", "task_open", "record_field_unchanged",
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
