import { describe, it, expect } from "vitest";
import * as labor from "../src/labor/index.js";

/**
 * M17. WHETHER A COMMISSION SETTLES BY ITSELF WHEN ITS INVOICE IS PAID IN FULL
 *
 * Only when nothing is left for a person to decide: one plan in force, which
 * pays on what was collected, and a split proposed between the people on the
 * job that a person would settle without a reason.
 */
const collected = { label: "Ten per cent collected", basis: "percent_of_collected" as const };
const revenue = { label: "Eight per cent", basis: "percent_of_revenue" as const };

describe("settling a commission when its invoice is paid", () => {
  it("settles under one collected plan with people on the job and no conflict", () => {
    expect(labor.onPaymentDecision({ plans: [collected], onJob: true, people: 2, conflict: null })).toEqual({ act: "settle" });
  });

  it("is not for a plan that earns when the work is invoiced", () => {
    expect(labor.onPaymentDecision({ plans: [revenue], onJob: true, people: 2, conflict: null })).toEqual({ act: "skip" });
    expect(labor.onPaymentDecision({ plans: [], onJob: true, people: 2, conflict: null })).toEqual({ act: "skip" });
  });

  it("leaves it for a person when two plans are in force and one of them pays on collection", () => {
    const decided = labor.onPaymentDecision({ plans: [collected, revenue], onJob: true, people: 2, conflict: null });
    expect(decided).toEqual({
      act: "leave",
      reason: "2 commission plans are in force (Ten per cent collected, Eight per cent). Which one this invoice is under is for a person to say.",
    });
  });

  it("leaves it when there is nobody to share it between", () => {
    expect(labor.onPaymentDecision({ plans: [collected], onJob: false, people: 0, conflict: null }))
      .toMatchObject({ act: "leave", reason: expect.stringContaining("not against a job") });
    expect(labor.onPaymentDecision({ plans: [collected], onJob: true, people: 0, conflict: null }))
      .toMatchObject({ act: "leave", reason: expect.stringContaining("Nobody is on this job's visits") });
  });

  it("leaves it when the standing shares cannot all be honoured, rather than settling the fallback", () => {
    const split = labor.proposeSplit(
      [{ personId: "a", isLead: false }, { personId: "b", isLead: false }, { personId: "c", isLead: false }],
      [
        { personId: "a", percent: 60, applies: "always", reason: "Sells", name: "Ana" },
        { personId: "b", percent: 50, applies: "always", reason: "Leads", name: "Bo" },
      ],
    );
    expect(split.conflict).not.toBeNull();
    expect(labor.onPaymentDecision({ plans: [collected], onJob: true, people: 3, conflict: split.conflict }))
      .toEqual({ act: "leave", reason: "The standing shares on this job cannot all be honoured, so how it is shared is for a person to decide." });
  });
});
