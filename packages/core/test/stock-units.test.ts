import { describe, it, expect } from "vitest";
import * as inv from "../src/inventory/index.js";
import { money, toString as m, sum } from "../src/money/index.js";

/**
 * SERIALS, LOTS, LANDED COST, APPROVAL STEPS AND TRUCK RESTOCKING
 *
 * The four additions to purchasing and inventory that are arithmetic or a
 * rule, tested where they are pure. The figures are chosen not to divide
 * evenly, because a landed cost test where every share is a round number
 * passes just as well against an implementation that divides and rounds.
 */

const usd = (v: string) => money(v, "USD");
const q = inv.quantity;
const at = (day: number) => new Date(Date.UTC(2026, 0, day, 9));
const stamp = (id: string, sequence: number) => ({ id, sequence, occurredAt: at(sequence) });

function mv(id: string, sequence: number, kind: inv.MovementKind, quantity: string, extra: Partial<inv.Movement> = {}): inv.Movement {
  return { id, sequence, occurredAt: at(sequence), itemId: "COMP", locationId: "SHOP", kind, quantity: q(quantity), ...extra };
}

describe("landed cost, by value and by quantity", () => {
  it("spreads freight by quantity when the vendor charged per piece, and reconciles to the cent", () => {
    /**
     * Forty filters and four expensive coils on one pallet. By value the coils
     * would carry almost all of it; charged per piece, every unit costs the
     * same to carry.
     */
    const lines = [
      { lineId: "filters", value: usd("160.00"), quantity: q("40") },
      { lineId: "coils", value: usd("1240.00"), quantity: q("4") },
      { lineId: "caps", value: usd("33.00"), quantity: q("3") },
    ];
    const byQuantity = inv.allocateLandedCost(usd("47.00"), lines, "quantity");
    expect(byQuantity.map((s) => m(s.share))).toEqual(["40.0000", "4.0000", "3.0000"]);

    const awkward = inv.allocateLandedCost(usd("10.00"), lines, "quantity");
    expect(m(sum(awkward.map((s) => s.share)))).toBe("10.0000");
    for (const share of awkward) expect(m(share.share)).toMatch(/\.\d\d00$/);

    const byValue = inv.allocateLandedCost(usd("47.00"), lines, "value");
    expect(m(sum(byValue.map((s) => s.share)))).toBe("47.0000");
    expect(Number(m(byValue[1]!.share))).toBeGreaterThan(Number(m(byValue[0]!.share)));
  });

  it("falls back to an even split when nothing has a weight by the basis chosen", () => {
    const shares = inv.allocateLandedCost(usd("10.01"), [
      { lineId: "a", value: usd("0"), quantity: q("0") },
      { lineId: "b", value: usd("0"), quantity: q("0") },
    ], "quantity");
    expect(m(sum(shares.map((s) => s.share)))).toBe("10.0100");
  });
});

describe("serial numbers and lots", () => {
  const numbers = new Map([["S1", "SN-1001"], ["S2", "SN-1002"], ["L1", "LOT-7"]]);
  const history = [
    mv("r1", 1, "receipt", "1", { lotId: "S1", totalCost: usd("900") }),
    mv("r2", 2, "receipt", "1", { lotId: "S2", totalCost: usd("900") }),
    mv("t1", 3, "transfer_out", "1", { lotId: "S2", transferId: "T1" }),
    mv("t2", 4, "transfer_in", "1", { lotId: "S2", transferId: "T1", locationId: "VAN" }),
  ];

  it("folds where each serial is from the movements that name it", () => {
    const levels = inv.deriveUnitLevels(history);
    expect(inv.unitWhereabouts(levels, "S1").map((l) => l.locationId)).toEqual(["SHOP"]);
    expect(inv.unitWhereabouts(levels, "S2").map((l) => l.locationId)).toEqual(["VAN"]);
    expect(inv.serialState(history, "S2")).toEqual({ state: "in_stock", locationId: "VAN" });
  });

  it("says a serial issued to a job was used on that job, rather than nowhere", () => {
    const used = [...history, mv("i1", 5, "issue", "1", { lotId: "S2", locationId: "VAN", jobId: "JOB-1" })];
    expect(inv.serialState(used, "S2")).toEqual({ state: "used", jobId: "JOB-1", at: at(5) });
  });

  it("refuses a tracked item moved without naming its units", () => {
    const check = inv.checkUnitPicks({
      mode: "serial", itemLabel: "Compressor", quantity: q("1"), picks: [], numbers,
      from: { locationId: "SHOP", locationLabel: "Shop", levels: inv.deriveUnitLevels(history) },
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(inv.explainUnitRefusal(check)).toContain("tracked by serial number");
  });

  it("refuses a serial that is somewhere else, naming where it was looked for", () => {
    const check = inv.checkUnitPicks({
      mode: "serial", itemLabel: "Compressor", quantity: q("1"), picks: [{ lotId: "S2", quantity: q("1") }], numbers,
      from: { locationId: "SHOP", locationLabel: "Shop", levels: inv.deriveUnitLevels(history) },
    });
    expect(check).toMatchObject({ ok: false, reason: "unit_not_here" });
    if (!check.ok) expect(inv.explainUnitRefusal(check)).toBe("SN-1002 is not at Shop. Look up where it is before moving it.");
  });

  it("refuses a serial of more than one, one named twice, and a count that does not add up", () => {
    const base = { mode: "serial" as const, itemLabel: "Compressor", numbers, from: null };
    expect(inv.checkUnitPicks({ ...base, quantity: q("2"), picks: [{ lotId: "S1", quantity: q("2") }] }))
      .toMatchObject({ reason: "serial_not_one" });
    expect(inv.checkUnitPicks({ ...base, quantity: q("2"), picks: [{ lotId: "S1", quantity: q("1") }, { lotId: "S1", quantity: q("1") }] }))
      .toMatchObject({ reason: "unit_twice" });
    expect(inv.checkUnitPicks({ ...base, quantity: q("2"), picks: [{ lotId: "S1", quantity: q("1") }] }))
      .toMatchObject({ reason: "units_do_not_add_up" });
    expect(inv.checkUnitPicks({ ...base, quantity: q("1"), picks: [{ lotId: "S1", quantity: q("1") }] })).toEqual({ ok: true });
  });

  it("lets a lot move part of itself, and not more than is there", () => {
    const lot = [mv("r", 1, "receipt", "12.5", { lotId: "L1", totalCost: usd("250") })];
    const from = { locationId: "SHOP", locationLabel: "Shop", levels: inv.deriveUnitLevels(lot) };
    expect(inv.checkUnitPicks({ mode: "lot", itemLabel: "R-410A", quantity: q("2.75"), picks: [{ lotId: "L1", quantity: q("2.75") }], numbers, from }))
      .toEqual({ ok: true });
    expect(inv.checkUnitPicks({ mode: "lot", itemLabel: "R-410A", quantity: q("13"), picks: [{ lotId: "L1", quantity: q("13") }], numbers, from }))
      .toMatchObject({ reason: "unit_not_here" });
  });

  it("cuts a receipt into one movement per unit with the cost allocated, never divided", () => {
    const receipt = mv("r", 1, "receipt", "3", { totalCost: usd("100.00") });
    const pieces = inv.splitAcrossUnits(receipt, [
      { lotId: "A", quantity: q("1") }, { lotId: "B", quantity: q("1") }, { lotId: "C", quantity: q("1") },
    ], [stamp("a", 1), stamp("b", 2), stamp("c", 3)]);
    expect(pieces.map((p) => p.lotId)).toEqual(["A", "B", "C"]);
    expect(pieces.map((p) => p.sequence)).toEqual([1, 2, 3]);
    expect(m(sum(pieces.map((p) => p.totalCost!)))).toBe("100.0000");
  });

  it("splits a transfer into one pair per unit, each with its own transfer id, so costing still pairs them", () => {
    const pieces = inv.splitTransfer({
      out: mv("o", 1, "transfer_out", "2", { transferId: "X" }),
      in: mv("i", 2, "transfer_in", "2", { transferId: "X", locationId: "VAN" }),
      picks: [{ lotId: "A", quantity: q("1") }, { lotId: "B", quantity: q("1") }],
      stamps: [
        { out: stamp("o1", 3), in: stamp("i1", 4), transferId: "T-A" },
        { out: stamp("o2", 5), in: stamp("i2", 6), transferId: "T-B" },
      ],
    });
    const receipts = [
      mv("ra", 1, "receipt", "1", { lotId: "A", totalCost: usd("10") }),
      mv("rb", 2, "receipt", "1", { lotId: "B", totalCost: usd("20") }),
    ];
    const run = inv.costMovements({ movements: [...receipts, ...pieces], method: "fifo" });
    expect(run.ok).toBe(true);
    expect(inv.deriveLevel([...receipts, ...pieces], "COMP", "VAN").onHand).toBe(q("2"));
  });

  it("reads a box of scanned serials in the order they were scanned", () => {
    expect(inv.parseSerialList("SN1\nSN2, SN3  SN4;\n\n")).toEqual(["SN1", "SN2", "SN3", "SN4"]);
  });
});

describe("approval steps", () => {
  const rules: inv.ApprovalRule[] = [
    { id: "r2", step: 2, minimumTotal: usd("5000"), roleLabel: "Owner", role: "owner", roleId: null },
    { id: "r1", step: 1, minimumTotal: usd("1000"), roleLabel: "Office manager", role: "office_manager", roleId: null },
  ];

  it("asks nothing of an order under every threshold", () => {
    const plan = inv.approvalPlan({ rules, total: usd("999.99"), approvals: [] });
    expect(plan.state).toBe("not_needed");
    expect(plan.steps).toEqual([]);
  });

  it("asks an order at exactly a threshold for that step, because at or over is the rule", () => {
    const plan = inv.approvalPlan({ rules, total: usd("1000.00"), approvals: [] });
    expect(plan.steps.map((s) => s.step)).toEqual([1]);
    expect(plan.next?.roleLabel).toBe("Office manager");
  });

  it("takes the steps in order, and is approved only when every one is", () => {
    const first = inv.approvalPlan({ rules, total: usd("6000"), approvals: [] });
    expect(first.state).toBe("waiting");
    expect(first.next?.step).toBe(1);
    expect(first.sentence).toContain("step 1 of 2");

    const second = inv.approvalPlan({
      rules, total: usd("6000"),
      approvals: [{ step: 1, decision: "approved", decidedByUserId: "U-OM", roleLabel: "Office manager", minimumTotal: usd("1000") }],
    });
    expect(second.next?.step).toBe(2);
    expect(second.steps.map((s) => s.state)).toEqual(["approved", "waiting"]);

    const done = inv.approvalPlan({
      rules, total: usd("6000"),
      approvals: [
        { step: 1, decision: "approved", decidedByUserId: "U-OM", roleLabel: "Office manager", minimumTotal: usd("1000") },
        { step: 2, decision: "approved", decidedByUserId: "U-OWN", roleLabel: "Owner", minimumTotal: usd("5000") },
      ],
    });
    expect(done.state).toBe("approved");
  });

  it("ends at a rejection", () => {
    const plan = inv.approvalPlan({
      rules, total: usd("6000"),
      approvals: [{ step: 1, decision: "rejected", decidedByUserId: "U-OM", roleLabel: "Office manager", minimumTotal: usd("1000") }],
    });
    expect(plan.state).toBe("rejected");
    expect(inv.checkDecision({ plan, userId: "U-OWN", holds: () => true })).toMatchObject({ ok: false, reason: "rejected" });
  });

  it("refuses the wrong role, and one person deciding two steps of one order", () => {
    const fresh = inv.approvalPlan({ rules, total: usd("6000"), approvals: [] });
    expect(inv.checkDecision({ plan: fresh, userId: "U", holds: (s) => s.role === "owner" }))
      .toMatchObject({ ok: false, reason: "wrong_role" });

    const half = inv.approvalPlan({
      rules, total: usd("6000"),
      approvals: [{ step: 1, decision: "approved", decidedByUserId: "U-BOTH", roleLabel: "Office manager", minimumTotal: usd("1000") }],
    });
    expect(inv.checkDecision({ plan: half, userId: "U-BOTH", holds: () => true }))
      .toMatchObject({ ok: false, reason: "already_decided_a_step" });
    expect(inv.checkDecision({ plan: half, userId: "U-OWN", holds: () => true })).toMatchObject({ ok: true });
  });

  it("keeps a decision already made when the rule behind it has gone", () => {
    const plan = inv.approvalPlan({
      rules: [rules[1]!], total: usd("6000"),
      approvals: [
        { step: 1, decision: "approved", decidedByUserId: "A", roleLabel: "Office manager", minimumTotal: usd("1000") },
        { step: 2, decision: "approved", decidedByUserId: "B", roleLabel: "Owner", minimumTotal: usd("5000") },
      ],
    });
    expect(plan.steps.map((s) => s.roleLabel)).toEqual(["Office manager", "Owner"]);
    expect(plan.state).toBe("approved");
  });
});

describe("filling the trucks", () => {
  const level = (locationId: string, onHand: string, committed = "0"): inv.StockLevel =>
    ({ itemId: "CAP", locationId, onHand: q(onHand), committed: q(committed) });

  it("suggests a transfer from the warehouse with the most, up to the target", () => {
    const [s] = inv.suggestRestock({
      minimums: [{ itemId: "CAP", locationId: "VAN", minimum: q("2"), target: q("6") }],
      levels: [level("VAN", "3", "1"), level("SHOP", "10"), level("ANNEX", "1")],
      warehouses: ["SHOP", "ANNEX"],
    });
    expect(s).toMatchObject({ fromLocationId: "SHOP", wanted: q("4"), take: q("4"), short: q("0") });
  });

  it("leaves a truck above its minimum alone", () => {
    expect(inv.suggestRestock({
      minimums: [{ itemId: "CAP", locationId: "VAN", minimum: q("2"), target: q("6") }],
      levels: [level("VAN", "3"), level("SHOP", "10")],
      warehouses: ["SHOP"],
    })).toEqual([]);
  });

  it("says how much short the warehouse is, rather than suggesting a purchase itself", () => {
    const [s] = inv.suggestRestock({
      minimums: [{ itemId: "CAP", locationId: "VAN", minimum: q("2"), target: q("6") }],
      levels: [level("SHOP", "1")],
      warehouses: ["SHOP"],
    });
    expect(s).toMatchObject({ take: q("1"), short: q("5") });
    expect(s!.why).toContain("5 short");
  });
});
