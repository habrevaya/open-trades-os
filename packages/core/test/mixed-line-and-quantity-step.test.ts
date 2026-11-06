import { describe, it, expect } from "vitest";
import * as inv from "../src/inventory/index.js";
import { money, toString as m } from "../src/money/index.js";

/**
 * A MIXED LINE (2 BOXES OF 25 AND 3 EACH) AND A STEP ON A LINE'S QUANTITY
 */
const usd = (v: string) => money(v, "USD");
const q = inv.quantity;

describe("a mixed line", () => {
  const line = {
    unitPrice: usd("0.55"), packQuantity: q("25"), packPrice: usd("10.00"),
    quantityOrdered: q("53"), looseQuantity: q("3"),
  };

  it("costs the boxes at the box price and the rest by the each", () => {
    expect(m(inv.lineCost(line, q("53")))).toBe("21.6500");
    expect(m(inv.lineCost(line, q("50")))).toBe("20.0000");
    expect(m(inv.lineCost(line, q("3"), q("50")))).toBe("1.6500");
  });

  it("prices any way of cutting it into deliveries so the slices add back to the line", () => {
    for (const cuts of [[53], [25, 28], [10, 15, 28], [1, 52], [24, 1, 28], [49, 4], [27, 26]]) {
      let already = 0n;
      let total = money("0", "USD");
      for (const cut of cuts) {
        const slice = inv.lineCost(line, q(String(cut)), already);
        expect(slice.amount > 0n).toBe(true);
        total = { amount: total.amount + slice.amount, currency: "USD" };
        already += q(String(cut));
      }
      expect(m(total)).toBe("21.6500");
    }
  });

  it("is a line bought one way, as before, when nothing is loose", () => {
    const boxes = { unitPrice: usd("0.4"), packQuantity: q("25"), packPrice: usd("10.00") };
    expect(m(inv.lineCost(boxes, q("50")))).toBe("20.0000");
    expect(m(inv.lineCost({ ...boxes, quantityOrdered: q("50"), looseQuantity: q("0") }, q("50"), q("0")))).toBe("20.0000");
  });
});

describe("a step on a line's quantity", () => {
  const rule = (extra: Partial<inv.ApprovalRule>): inv.ApprovalRule => ({
    id: "r1", step: 1, minimumTotal: usd("0"), roleLabel: "Owner", role: "owner", roleId: null, ...extra,
  });
  const order: inv.OrderScope = {
    vendorId: "v1", categoryIds: [], locationIds: ["L"],
    lines: [
      { id: "a", label: "Motor", categoryId: null, locationId: "L", amount: usd("250"), quantity: q("25") },
      { id: "b", label: "Bolt", categoryId: null, locationId: "L", amount: usd("5"), quantity: q("5") },
    ],
  };

  it("applies only when a line is that many or more", () => {
    const plan = (lineQuantityAtLeast: bigint) => inv.approvalPlan({
      rules: [rule({ lineQuantityAtLeast })], total: usd("255"), approvals: [], order,
    });
    expect(plan(q("20")).state).toBe("waiting");
    expect(plan(q("25")).state).toBe("waiting");
    expect(plan(q("26")).state).toBe("not_needed");
  });

  it("counts only the big lines when it counts part of the order", () => {
    const plan = inv.approvalPlan({
      rules: [rule({ lineQuantityAtLeast: q("20"), amountOf: "matching_lines", minimumTotal: usd("100"), scopeLabel: "the lines of 20 or more" })],
      total: usd("255"), approvals: [], order,
    });
    expect(plan.steps[0]!.lines.map((l) => l.id)).toEqual(["a"]);
    expect(m(plan.steps[0]!.amount)).toBe("250.0000");
  });

  it("counts by vendor alone as every line of that vendor's orders", () => {
    const rules = [rule({ vendorId: "v1", amountOf: "matching_lines", minimumTotal: usd("100") })];
    expect(inv.approvalPlan({ rules, total: usd("255"), approvals: [], order }).steps[0]!.lines).toHaveLength(2);
    expect(inv.approvalPlan({ rules, total: usd("255"), approvals: [], order: { ...order, vendorId: "v2" } }).state).toBe("not_needed");
  });
});
