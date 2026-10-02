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

describe("the checks a run can ask again", () => {
  it("names only what the catalogue declares", () => {
    expect(isCheck("estimate_undecided")).toBe(true);
    expect(isCheck("__proto__")).toBe(false);
    expect(isCheck("drop table")).toBe(false);
    expect(Object.keys(CHECKS)).toEqual(["estimate_undecided"]);
  });

  it("refuses a template nobody wrote", () => {
    expect(buildTemplate("nope", {}).ok).toBe(false);
  });
});
