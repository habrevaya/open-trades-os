import { describe, it, expect } from "vitest";
import { work } from "../src/index.js";

/**
 * THE HOLD NUDGE GIVEN TO WHOEVER IS ON THE OFFICE ROTA TODAY
 *
 * `on_call` needs no person and no role, is read back as itself, and says what
 * it is in words on a rule's summary.
 */
describe("a hold nudge given to whoever is on the office rota", () => {
  it("is a choice that needs nothing beside it", () => {
    expect(work.holdNudgeRules({ days: 3, assignTo: "on_call" })).toMatchObject({ days: 3, assignTo: "on_call", assigneeUserId: null });
    expect(work.holdNudgeRulesProblem({ ...work.HOLD_NUDGE_OFF, assignTo: "on_call" })).toBeNull();
    expect(work.holdNudgeOverridesProblem({ assign: { to: "on_call", userId: null } })).toBeNull();
    expect(work.holdNudgeOverrides({ assign: { to: "on_call" } })).toEqual({ assign: { to: "on_call", userId: null } });
  });

  it("is taken from a rule over the company's own choice", () => {
    const company = { ...work.HOLD_NUDGE_OFF, days: 3, assignTo: "placed_by" as const };
    const rule = { reason: "part", businessUnitId: null, overrides: { assign: { to: "on_call" as const, userId: null } } };
    expect(work.holdNudgeFor(company, [rule], { reason: "part", businessUnitId: null })).toMatchObject({ assignTo: "on_call" });
    expect(work.holdNudgeFor(company, [rule], { reason: "weather", businessUnitId: null })).toMatchObject({ assignTo: "placed_by" });
  });

  it("is said in words", () => {
    expect(work.holdNudgeAssignWords("on_call", {})).toBe("whoever is on the office rota today");
    expect(work.holdNudgeRuleSummary({
      reason: "part", businessUnitName: null, overrides: { assign: { to: "on_call", userId: null } },
    })).toBe("Jobs waiting on a part: give it to whoever is on the office rota today.");
  });
});
