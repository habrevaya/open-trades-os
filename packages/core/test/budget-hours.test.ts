import { describe, it, expect } from "vitest";
import { reporting as r } from "../src/index";

const punch = (minutes: number, kind = "on_site", ended = true) => ({ kind, minutes, ended });

describe("a job's crew hours against its budget", () => {
  it("is actual crew hours less the budget, every person separately", () => {
    /** Three people for four hours each, and a forty minute drive each, against ten budgeted. */
    const job = {
      budgetedHours: 10, approvedChangeHours: 0,
      punches: [punch(240), punch(240), punch(240), punch(40, "travel"), punch(40, "travel"), punch(40, "travel")],
    };
    expect(r.budgetVarianceOf(job)).toEqual({ counted: true, overHours: 4, budgetedHours: 10 });
  });

  it("takes the hours of an approved change order off the actual, so an upsell is not an overrun", () => {
    const job = { budgetedHours: 10, approvedChangeHours: 3, punches: [punch(780)] };
    expect(r.budgetVarianceOf(job)).toEqual({ counted: true, overHours: 0, budgetedHours: 10 });
  });

  it("does not count leave or an unpaid break as crew hours", () => {
    const job = { budgetedHours: 8, approvedChangeHours: 0, punches: [punch(480), punch(30, "unpaid_break"), punch(480, "pto")] };
    expect(r.budgetVarianceOf(job)).toMatchObject({ counted: true, overHours: 0 });
  });

  it("leaves out a job with no budget, a punch still running, or no hours at all", () => {
    expect(r.budgetVarianceOf({ budgetedHours: null, approvedChangeHours: 0, punches: [punch(60)] }))
      .toEqual({ counted: false, why: "no_budget" });
    expect(r.budgetVarianceOf({ budgetedHours: 4, approvedChangeHours: 0, punches: [punch(60), punch(0, "on_site", false)] }))
      .toEqual({ counted: false, why: "punch_open" });
    expect(r.budgetVarianceOf({ budgetedHours: 4, approvedChangeHours: 0, punches: [] }))
      .toEqual({ counted: false, why: "no_hours" });
  });

  it("reads under budget as a negative variance", () => {
    expect(r.budgetVarianceOf({ budgetedHours: 10, approvedChangeHours: 0, punches: [punch(480)] }))
      .toMatchObject({ overHours: -2 });
    expect(r.combine("percent", -2, 10)).toBe("-20.0");
  });
});
