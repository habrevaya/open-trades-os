import { describe, it, expect } from "vitest";
import * as inv from "../src/inventory/index.js";
import { money } from "../src/money/index.js";

/**
 * APPROVAL STEPS THAT COUNT PART OF AN ORDER
 *
 * "Over five hundred dollars of refrigerant" and "over two thousand for the
 * Houston warehouse" are about some lines of an order, not its total. The
 * order below is built so the whole total, the category's share and the
 * location's share all come out different, because a test where they agree
 * proves nothing about which one a step counted.
 */

const usd = (v: string) => money(v, "USD");
const REF = "CAT-REF";
const PARTS = "CAT-PARTS";
const HOUSTON = "HOU";
const AUSTIN = "AUS";

const line = (id: string, label: string, categoryId: string, locationId: string, amount: string): inv.OrderLineShare =>
  ({ id, label, categoryId, locationId, amount: usd(amount) });

/** 3,000 in all: 540 of refrigerant (one line in Austin), 2,460 of parts (Houston). */
const lines = [
  line("l1", "R-410A, 25 lb", REF, HOUSTON, "300.00"),
  line("l2", "R-22 reclaim, 30 lb", REF, AUSTIN, "240.00"),
  line("l3", "Condenser fan motor", PARTS, HOUSTON, "2460.00"),
];
const order = { vendorId: "V", categoryIds: [REF, PARTS], locationIds: [HOUSTON, AUSTIN], lines };
const total = usd("3000.00");

const rule = (extra: Omit<Partial<inv.ApprovalRule>, "minimumTotal"> & { step: number; minimumTotal: string }): inv.ApprovalRule => {
  const { minimumTotal, ...rest } = extra;
  return { id: `r${extra.step}`, roleLabel: "Owner", role: "owner", roleId: null, ...rest, step: extra.step, minimumTotal: usd(minimumTotal) };
};

describe("a step that counts the lines it is for", () => {
  it("compares the category's share, not the order's total", () => {
    const refrigerant = rule({ step: 1, minimumTotal: "500", categoryId: REF, amountOf: "matching_lines", scopeLabel: "the Refrigerant lines" });
    const plan = inv.approvalPlan({ rules: [refrigerant], total, approvals: [], order });
    expect(plan.state).toBe("waiting");
    expect(plan.next?.amount).toEqual(usd("540.00"));
    expect(plan.next?.lines.map((l) => l.label)).toEqual(["R-410A, 25 lb", "R-22 reclaim, 30 lb"]);
    expect(plan.sentence).toContain("because the Refrigerant lines come to $540.00 and anything at or over $500.00 of them needs one");

    // The same order and the same step, counted on the whole order, is read as it always was.
    const whole = rule({ step: 1, minimumTotal: "500", categoryId: REF, scopeLabel: "orders with a line from Refrigerant" });
    const wholePlan = inv.approvalPlan({ rules: [whole], total, approvals: [], order });
    expect(wholePlan.next?.amount).toEqual(total);
    expect(wholePlan.next?.lines).toEqual([]);
  });

  it("does not trip when the lines are under the amount, however large the order is", () => {
    const refrigerant = rule({ step: 1, minimumTotal: "600", categoryId: REF, amountOf: "matching_lines" });
    expect(inv.approvalPlan({ rules: [refrigerant], total, approvals: [], order }).state).toBe("not_needed");
    // The very same step counted on the whole order trips on the 3,000.
    const whole = rule({ step: 1, minimumTotal: "600", categoryId: REF });
    expect(inv.approvalPlan({ rules: [whole], total, approvals: [], order }).state).toBe("waiting");
  });

  it("counts the lines at one location, and the lines that are both a category and a location", () => {
    const houston = rule({ step: 1, minimumTotal: "2000", locationId: HOUSTON, amountOf: "matching_lines" });
    const plan = inv.approvalPlan({ rules: [houston], total, approvals: [], order });
    expect(plan.next?.amount).toEqual(usd("2760.00"));
    expect(plan.next?.lines.map((l) => l.id)).toEqual(["l1", "l3"]);

    // Refrigerant going to Houston is one line, 300, not 540 and not 2,760.
    const both = rule({ step: 1, minimumTotal: "300", categoryId: REF, locationId: HOUSTON, amountOf: "matching_lines" });
    const bothPlan = inv.approvalPlan({ rules: [both], total, approvals: [], order });
    expect(bothPlan.next?.amount).toEqual(usd("300.00"));
    expect(bothPlan.next?.lines.map((l) => l.id)).toEqual(["l1"]);
    const over = rule({ step: 1, minimumTotal: "300.01", categoryId: REF, locationId: HOUSTON, amountOf: "matching_lines" });
    expect(inv.approvalPlan({ rules: [over], total, approvals: [], order }).state).toBe("not_needed");
  });

  it("never applies to an order with none of its lines, even at a zero amount", () => {
    const hvac = rule({ step: 1, minimumTotal: "0", categoryId: "CAT-NONE", amountOf: "matching_lines" });
    expect(inv.approvalPlan({ rules: [hvac], total, approvals: [], order }).state).toBe("not_needed");
  });

  it("falls back to the whole total, which asks for more approval, when it has no lines to count", () => {
    const refrigerant = rule({ step: 1, minimumTotal: "2500", categoryId: REF, amountOf: "matching_lines" });
    const noLines = { vendorId: "V", categoryIds: [REF], locationIds: [HOUSTON] };
    const plan = inv.approvalPlan({ rules: [refrigerant], total, approvals: [], order: noLines });
    expect(plan.state).toBe("waiting");
    expect(plan.next?.amountOf).toBe("order");
  });

  it("is held beside a whole-order step, each with its own amount", () => {
    const rules = [
      rule({ step: 1, minimumTotal: "1000", roleLabel: "Office manager", role: "office_manager" }),
      rule({ step: 2, minimumTotal: "500", categoryId: REF, amountOf: "matching_lines", scopeLabel: "the Refrigerant lines" }),
    ];
    const plan = inv.approvalPlan({ rules, total, approvals: [], order });
    expect(plan.steps.map((s) => [s.step, s.amountOf, s.amount])).toEqual([
      [1, "order", usd("3000.00")], [2, "matching_lines", usd("540.00")],
    ]);
  });

  it("counts a vendor step's amount on the order, because a vendor picks no lines", () => {
    const v = rule({ step: 1, minimumTotal: "100", vendorId: "V", amountOf: "matching_lines" });
    expect(inv.countsPartOfOrder(v)).toBe(false);
    expect(inv.approvalPlan({ rules: [v], total, approvals: [], order }).next?.amount).toEqual(total);
  });
});

describe("asking again after an edit, step by step", () => {
  it("compares each step's own amount with what it approved", () => {
    const decisions = [
      { step: 1, decision: "approved" as const, amount: usd("3000.00") },
      { step: 2, decision: "approved" as const, amount: usd("540.00") },
    ];
    // The total went up a little; the refrigerant went up too, so only step 2 asks again.
    const current = new Map([[1, usd("3000.00")], [2, usd("540.01")]]);
    expect(inv.approvalsUndoneByAmounts(current, decisions)).toEqual([2]);
    // Refrigerant down, the rest up: step 1 asks again and step 2 stands.
    expect(inv.approvalsUndoneByAmounts(new Map([[1, usd("3100.00")], [2, usd("400.00")]]), decisions)).toEqual([1]);
    // Nothing above what was approved, or a step the order no longer reaches: nothing asks again.
    expect(inv.approvalsUndoneByAmounts(new Map([[1, usd("3000.00")]]), decisions)).toEqual([]);
    expect(inv.approvalsUndoneByAmounts(new Map([[1, usd("1.00")], [2, usd("540.00")]]), [
      { step: 1, decision: "rejected", amount: usd("0.50") }, decisions[1]!,
    ])).toEqual([]);
  });
});
