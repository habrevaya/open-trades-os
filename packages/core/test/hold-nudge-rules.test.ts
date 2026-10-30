import { describe, it, expect } from "vitest";
import * as work from "../src/work/index";

/**
 * THE HOLD NUDGE BY REASON AND BY BRANCH
 *
 * The company's numbers are the default; a rule changes some of them for one
 * reason, one branch or both. Most specific first, field by field.
 */
const company: work.HoldNudgeRules = { days: 5, dueDays: 2, repeatDays: 7, assignTo: "placed_by", assigneeUserId: null };
const HOUSTON = "bu-houston";
const AUSTIN = "bu-austin";

const rule = (reason: string | null, businessUnitId: string | null, overrides: work.HoldNudgeOverrides): work.HoldNudgeRuleRow =>
  ({ reason, businessUnitId, overrides });

describe("what applies to a hold", () => {
  it("is the company's numbers when no rule fits", () => {
    expect(work.holdNudgeFor(company, [], { reason: "part", businessUnitId: HOUSTON })).toEqual(company);
    expect(work.holdNudgeFor(company, [rule("weather", null, { days: 10 })], { reason: "part", businessUnitId: null })).toEqual(company);
  });

  it("lays a rule for the reason over the company's, saying nothing about the rest", () => {
    const got = work.holdNudgeFor(company, [rule("weather", null, { days: 10 })], { reason: "weather", businessUnitId: AUSTIN });
    expect(got).toEqual({ ...company, days: 10 });
  });

  it("takes the reason in the branch first, then the reason, then the branch, field by field", () => {
    const rules = [
      rule(null, HOUSTON, { days: 9, dueDays: 9, assign: { to: "branch_manager", userId: null } }),
      rule("part", null, { days: 4, dueDays: 4 }),
      rule("part", HOUSTON, { days: 3 }),
    ];
    expect(work.holdNudgeFor(company, rules, { reason: "part", businessUnitId: HOUSTON })).toEqual({
      days: 3, dueDays: 4, repeatDays: 7, assignTo: "branch_manager", assigneeUserId: null,
    });
    /** The same reason in another branch is the reason's rule alone. */
    expect(work.holdNudgeFor(company, rules, { reason: "part", businessUnitId: AUSTIN })).toEqual({ ...company, days: 4, dueDays: 4 });
    /** Another reason in Houston is the branch's rule. */
    expect(work.holdNudgeFor(company, rules, { reason: "customer", businessUnitId: HOUSTON })).toEqual({
      days: 9, dueDays: 9, repeatDays: 7, assignTo: "branch_manager", assigneeUserId: null,
    });
  });

  it("reads null as none: no nudge, no due date, never again", () => {
    const got = work.holdNudgeFor(company, [rule("customer", null, { days: null, dueDays: null, repeatDays: null })],
      { reason: "customer", businessUnitId: null });
    expect(got).toMatchObject({ days: null, dueDays: null, repeatDays: null });
  });

  it("gives the task to a role, and forgets the company's person or role", () => {
    const toRole: work.HoldNudgeRules = { ...company, assignTo: "role", assigneeRole: "dispatcher" };
    expect(work.holdNudgeFor(toRole, [rule("part", null, { assign: { to: "person", userId: "u1" } })], { reason: "part", businessUnitId: null }))
      .toEqual({ ...company, assignTo: "person", assigneeUserId: "u1" });
    expect(work.holdNudgeFor(company, [rule("part", null, { assign: { to: "role", userId: null, role: "csr" } })], { reason: "part", businessUnitId: null }))
      .toEqual({ ...company, assignTo: "role", assigneeUserId: null, assigneeRole: "csr" });
  });

  it("does not let a rule for a branch apply to a job in no branch", () => {
    expect(work.holdNudgeFor(company, [rule(null, HOUSTON, { days: 1 })], { reason: "part", businessUnitId: null })).toEqual(company);
  });
});

describe("the company's own setting, with a role", () => {
  it("keeps a good role and leaves the key out otherwise", () => {
    expect(work.holdNudgeRules({ days: 3, assignTo: "role", assigneeRole: "dispatcher" }))
      .toEqual({ ...work.HOLD_NUDGE_OFF, days: 3, assignTo: "role", assigneeRole: "dispatcher" });
    expect(work.holdNudgeRules({ days: 3, assignTo: "role" })).toEqual({ ...work.HOLD_NUDGE_OFF, days: 3 });
    expect(work.holdNudgeRules({ days: 3, assignTo: "role", assigneeRole: "technician" })).toEqual({ ...work.HOLD_NUDGE_OFF, days: 3 });
    expect(work.holdNudgeRules({ days: 3, assignTo: "branch_manager" })).toMatchObject({ assignTo: "branch_manager" });
    expect(work.holdNudgeRules({ days: 3, assignTo: "nobody", assigneeRole: "csr" })).not.toHaveProperty("assigneeRole");
  });

  it("refuses a role task with no role", () => {
    expect(work.holdNudgeRulesProblem({ ...work.HOLD_NUDGE_OFF, assignTo: "role" })).toMatch(/Choose which role/);
    expect(work.holdNudgeRulesProblem({ ...work.HOLD_NUDGE_OFF, assignTo: "role", assigneeRole: "csr" })).toBeNull();
    expect(work.holdNudgeRulesProblem({ ...work.HOLD_NUDGE_OFF, assignTo: "branch_manager" })).toBeNull();
  });
});

describe("a rule as saved", () => {
  it("keeps what is good and drops the rest", () => {
    expect(work.holdNudgeOverrides({ days: 4, dueDays: null, repeatDays: 0, assign: { to: "role", role: "csr" } }))
      .toEqual({ days: 4, dueDays: null, assign: { to: "role", userId: null, role: "csr" } });
    expect(work.holdNudgeOverrides({ days: 400, assign: { to: "person" } })).toEqual({});
    expect(work.holdNudgeOverrides("nonsense")).toEqual({});
  });

  it("refuses a rule that changes nothing, and numbers out of range, in words", () => {
    expect(work.holdNudgeOverridesProblem({})).toMatch(/Say what is different/);
    expect(work.holdNudgeOverridesProblem({ days: 3 })).toBeNull();
    expect(work.holdNudgeOverridesProblem({ days: null })).toBeNull();
    expect(work.holdNudgeOverridesProblem({ days: 91 })).toMatch(/from 1 to 90/);
    expect(work.holdNudgeOverridesProblem({ dueDays: 31 })).toMatch(/from 0 to 30/);
    expect(work.holdNudgeOverridesProblem({ repeatDays: 0 })).toMatch(/from 1 to 90/);
    expect(work.holdNudgeOverridesProblem({ assign: { to: "person", userId: null } })).toMatch(/Choose which person/);
    expect(work.holdNudgeOverridesProblem({ assign: { to: "role", userId: null } })).toMatch(/Choose which role/);
    expect(work.holdNudgeOverridesProblem({ assign: { to: "branch_manager", userId: null } })).toBeNull();
  });

  it("needs a reason or a branch", () => {
    expect(work.holdNudgeRuleReachProblem(null, null)).toMatch(/Choose a reason, a branch or both/);
    expect(work.holdNudgeRuleReachProblem("part", null)).toBeNull();
    expect(work.holdNudgeRuleReachProblem(null, HOUSTON)).toBeNull();
  });

  it("reads back as a sentence", () => {
    expect(work.holdNudgeRuleSummary({
      reason: "weather", businessUnitName: "Houston",
      overrides: { days: 7, dueDays: 2, repeatDays: 3, assign: { to: "role", userId: null, role: "dispatcher" } },
    })).toBe("Jobs waiting on the weather, in Houston: nudge after 7 days, due 2 days later, remind every 3 days, give it to the dispatchers.");
    expect(work.holdNudgeRuleSummary({
      reason: null, businessUnitName: "Austin", overrides: { days: null, assign: { to: "branch_manager", userId: null } },
    })).toBe("Jobs on hold, in Austin: never nudge, give it to the manager of the job's branch.");
    expect(work.holdNudgeRuleSummary({
      reason: "other", businessUnitName: null, overrides: { dueDays: 0, repeatDays: null, assign: { to: "nobody", userId: null } },
    })).toBe("Jobs on hold for another reason: due the same day, do not remind again, keep it in the office queue.");
  });

  it("says who the task was sent to at the top of it, and nothing when it was not", () => {
    const input = {
      customerName: "Dana", summary: "No cool", reason: "part", note: null, held: 5, since: "May 1, 2026", placedBy: null, days: 3,
    };
    expect(work.holdNudgeBody({ ...input, sentTo: "Sent to the dispatchers." })).toMatch(/^Sent to the dispatchers\. Dana: No cool\./);
    expect(work.holdNudgeBody(input)).toMatch(/^Dana: No cool\./);
  });
});
