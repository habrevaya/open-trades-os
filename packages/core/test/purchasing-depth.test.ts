import { describe, it, expect } from "vitest";
import * as inv from "../src/inventory/index.js";
import * as ledger from "../src/ledger/index.js";
import * as catalogue from "../src/catalogue/index.js";
import { pdf } from "../src/index";
import { money, toString as m, sum, zero, add } from "../src/money/index.js";

/**
 * PURCHASING DEPTH: NUMBERS ON THE SHELF, UNITS BACK OFF A JOB, FREIGHT THAT
 * CAME LATE, PACKS AND BREAKS, AND SCOPED APPROVALS
 *
 * The fixtures do not divide evenly on purpose. A late freight bill of $10.00
 * over three parts that splits into 3.33 three times has lost a cent, and the
 * only way to see that is a test where the arithmetic does not come out.
 */

const usd = (v: string) => money(v, "USD");
const q = inv.quantity;
const at = (day: number, minute = 0) => new Date(Date.UTC(2026, 0, day, 9, minute));
const SHOP = "SHOP";
const VAN = "VAN";

type Extra = Omit<Partial<inv.Movement>, "id" | "sequence" | "occurredAt" | "kind" | "quantity">;
const mv = (id: string, sequence: number, kind: inv.MovementKind, quantity: string, extra: Extra = {}): inv.Movement => ({
  id, sequence, occurredAt: at(1, sequence), itemId: "COMP", locationId: SHOP, kind, quantity: q(quantity), ...extra,
});
const stamps = (from: number, count: number): inv.MovementStamp[] =>
  Array.from({ length: count }, (_, i) => ({ id: `s${from + i}`, sequence: from + i, occurredAt: at(2, from + i) }));

function ok<R extends { ok: boolean }>(result: R): Extract<R, { ok: true }> {
  if (!result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  return result as Extract<R, { ok: true }>;
}

describe("numbering units already on the shelf", () => {
  const level = { itemId: "COMP", locationId: SHOP, onHand: q("3") };
  const numbers = new Map([["A", "SN-A"], ["B", "SN-B"], ["C", "SN-C"], ["D", "SN-D"]]);

  it("gives each new number one unnumbered unit, and changes neither the shelf nor the money", () => {
    const decision = ok(inv.planNumbering({
      mode: "serial", itemLabel: "Compressor", locationLabel: "Shop", level, unitLevels: [], numbers,
      picks: [{ lotId: "A", quantity: q("1") }, { lotId: "B", quantity: q("1") }], stamps: stamps(10, 2),
    }));
    expect(decision.movements.map((x) => [x.kind, x.lotId])).toEqual([["numbered", "A"], ["numbered", "B"]]);
    expect(decision.stillUnnumbered).toBe(q("1"));

    const history = [mv("r1", 1, "receipt", "3", { totalCost: usd("100.00") }), ...decision.movements];
    expect(inv.deriveLevel(history, "COMP", SHOP).onHand).toBe(q("3"));
    expect(inv.unitWhereabouts(inv.deriveUnitLevels(history), "A")).toEqual([
      { lotId: "A", itemId: "COMP", locationId: SHOP, onHand: q("1") },
    ]);
    expect(inv.serialState(history, "B")).toEqual({ state: "in_stock", locationId: SHOP });
    const run = ok(inv.costMovements({ movements: history, method: "fifo" }));
    expect(m(run.value)).toBe("100.0000");
  });

  it("recognises a number already on this shelf, refuses one read twice, and refuses more numbers than unnumbered units", () => {
    const unitLevels = [{ lotId: "A", itemId: "COMP", locationId: SHOP, onHand: q("1") }];
    const again = ok(inv.planNumbering({
      mode: "serial", itemLabel: "Compressor", locationLabel: "Shop", level, unitLevels, numbers,
      picks: [{ lotId: "A", quantity: q("1") }, { lotId: "B", quantity: q("1") }], stamps: stamps(10, 2),
    }));
    expect(again.alreadyHere).toEqual(["SN-A"]);
    expect(again.movements).toHaveLength(1);

    const twice = inv.planNumbering({
      mode: "serial", itemLabel: "Compressor", locationLabel: "Shop", level, unitLevels: [], numbers,
      picks: [{ lotId: "A", quantity: q("1") }, { lotId: "A", quantity: q("1") }], stamps: stamps(10, 2),
    });
    expect(twice.ok ? null : inv.explainUnitRefusal(twice)).toBe("SN-A is named twice. Each unit moves once.");

    const extra = inv.planNumbering({
      mode: "serial", itemLabel: "Compressor", locationLabel: "Shop", level, unitLevels, numbers,
      picks: ["B", "C", "D"].map((lotId) => ({ lotId, quantity: q("1") })), stamps: stamps(10, 3),
    });
    expect(extra.ok).toBe(false);
    expect(extra.ok ? "" : inv.explainUnitRefusal(extra)).toMatch(/There are 2 of Compressor at Shop with no number, and 3 new numbers were read/);
  });

  it("says how many of each place have no numbers yet", () => {
    const history = [
      mv("r1", 1, "receipt", "3", { totalCost: usd("90.00") }),
      mv("n1", 2, "numbered", "1", { lotId: "A" }),
    ];
    expect(inv.unnumberedByLocation(inv.deriveLevels(history), inv.deriveUnitLevels(history)))
      .toEqual([{ locationId: SHOP, quantity: q("2") }]);
  });
});

describe("costing follows each part's receipt", () => {
  it("carries whose parts they were through a transfer, one layer per receipt it took", () => {
    const run = ok(inv.costMovements({
      movements: [
        mv("r1", 1, "receipt", "1", { totalCost: usd("10.00") }),
        mv("r2", 2, "receipt", "1", { totalCost: usd("20.00") }),
        mv("to", 3, "transfer_out", "2", { transferId: "T" }),
        mv("ti", 4, "transfer_in", "2", { transferId: "T", locationId: VAN }),
        mv("i1", 5, "issue", "1", { locationId: VAN, jobId: "J1" }),
      ],
      method: "fifo",
    }));
    // First in, first out at the far end too: the job took the ten dollar part.
    expect(m(run.issues[0]!.cost)).toBe("10.0000");
    expect(run.layers.map((l) => [l.origin, l.locationId, m(l.cost)])).toEqual([["r2", VAN, "20.0000"]]);
    expect(run.consumptions[0]!.slices.map((s) => s.origin)).toEqual(["r1"]);
  });

  it("puts a unit back off a job at the cost it left at, as the receipt's part again, and takes it off the job", () => {
    const history = [
      mv("r1", 1, "receipt", "3", { totalCost: usd("100.00") }),
      mv("i1", 2, "issue", "1", { jobId: "J1" }),
    ];
    const first = ok(inv.costMovements({ movements: history, method: "fifo" }));
    const left = first.issues[0]!.cost;
    const back = mv("b1", 3, "return_to_stock", "1", { jobId: "J1", totalCost: left, revaluesMovementId: "i1" });
    const run = ok(inv.costMovements({ movements: [...history, back], method: "fifo" }));
    expect(m(run.value)).toBe("100.0000");
    expect(run.consumptions[0]!.returned).toBe(true);
    expect(run.layers.every((l) => l.origin === "r1")).toBe(true);
    expect(m(inv.cogsByJob(run.issues, "USD", run.returns).get("J1")!)).toBe("0.0000");
  });
});

describe("a freight bill that arrived after the delivery", () => {
  /**
   * Three compressors and one coil came on one truck. One compressor went to
   * a van, one was used on job J1 and one was dropped and scrapped; the coil
   * is still on the shelf. Then a $10.00 freight bill arrives.
   */
  const delivery = [
    mv("rc", 1, "receipt", "3", { totalCost: usd("300.00") }),
    mv("rk", 2, "receipt", "1", { itemId: "COIL", totalCost: usd("100.00") }),
    mv("to", 3, "transfer_out", "1", { transferId: "T" }),
    mv("ti", 4, "transfer_in", "1", { transferId: "T", locationId: VAN }),
    mv("i1", 5, "issue", "1", { jobId: "J1" }),
    mv("x1", 6, "scrap", "1", { reasonCode: "dropped" }),
  ];
  const lines: inv.LateReceiptLine[] = [
    { movementId: "rc", itemId: "COMP", value: usd("300.00"), quantity: q("3") },
    { movementId: "rk", itemId: "COIL", value: usd("100.00"), quantity: q("1") },
  ];
  const replay = () => ok(inv.costMovements({ movements: delivery, method: "fifo" }));

  it("finds where each receipt's parts went: a shelf, a van, a job, the bin", () => {
    const fates = inv.fatesOf(replay(), ["rc", "rk"]);
    expect(fates.get("rc")!.map((f) => [f.kind, f.locationId, inv.quantityLabel(f.quantity)])).toEqual([
      ["shelf", VAN, "1"], ["used", SHOP, "1"], ["gone", SHOP, "1"],
    ]);
    expect(fates.get("rk")!.map((f) => f.kind)).toEqual(["shelf"]);
  });

  it("spreads the bill by value, then follows the parts, to the cent with nothing lost", () => {
    const plan = ok(inv.planLateLandedCost({ amount: usd("10.00"), basis: "value", lines, fates: inv.fatesOf(replay(), ["rc", "rk"]) }));
    expect(plan.lines.map((l) => [l.movementId, m(l.share)])).toEqual([["rc", "7.5000"], ["rk", "2.5000"]]);
    // 7.50 over three compressors is 2.50 each, exactly; the leftover cent rule is exercised below.
    expect(plan.pieces.map((p) => [p.fate.kind, m(p.amount)])).toEqual([
      ["shelf", "2.5000"], ["used", "2.5000"], ["gone", "2.5000"], ["shelf", "2.5000"],
    ]);
    expect(m(add(add(plan.onShelf, plan.onJobs), plan.onGone))).toBe("10.0000");
    expect(plan.byJob.map((j) => [j.jobId, m(j.amount)])).toEqual([["J1", "2.5000"]]);
  });

  it("places a leftover cent the same way every time, on the first of the largest", () => {
    const fates = inv.fatesOf(replay(), ["rc", "rk"]);
    const once = ok(inv.planLateLandedCost({ amount: usd("10.01"), basis: "quantity", lines, fates }));
    const twice = ok(inv.planLateLandedCost({ amount: usd("10.01"), basis: "quantity", lines, fates }));
    expect(once.pieces.map((p) => m(p.amount))).toEqual(twice.pieces.map((p) => m(p.amount)));
    // By quantity: 3 parts and 1 part, so 7.51 and 2.50; 7.51 over three is 2.51, 2.50, 2.50.
    expect(once.lines.map((l) => m(l.share))).toEqual(["7.5100", "2.5000"]);
    expect(once.pieces.map((p) => m(p.amount))).toEqual(["2.5100", "2.5000", "2.5000", "2.5000"]);
    for (const piece of once.pieces) expect(piece.amount.amount % 100n).toBe(0n);
    expect(m(sum(once.pieces.map((p) => p.amount)))).toBe("10.0100");
  });

  it("raises what is on the shelf, adds to what the job used, and every later use relieves exactly its share", () => {
    const plan = ok(inv.planLateLandedCost({ amount: usd("10.00"), basis: "value", lines, fates: inv.fatesOf(replay(), ["rc", "rk"]) }));
    const revaluations = inv.lateLandedMovements(plan.pieces, stamps(20, plan.pieces.length));
    const run = ok(inv.costMovements({ movements: [...delivery, ...revaluations], method: "fifo" }));
    expect(m(run.value)).toBe("205.0000");
    expect(m(run.issues[0]!.cost)).toBe("102.5000");
    expect(m(run.issues[0]!.late)).toBe("2.5000");
    expect(m(sum(run.layers.map((l) => l.late)))).toBe(m(plan.onShelf));

    // The van's compressor is used later: its late freight leaves stock with it.
    const later = { ...mv("i2", 30, "issue", "1", { locationId: VAN, jobId: "J2" }), occurredAt: at(3) };
    const after = ok(inv.costMovements({ movements: [...delivery, ...revaluations, later], method: "fifo" }));
    expect(inv.lateRelief(after, ["i2"]).map((r) => [r.jobId, m(r.amount)])).toEqual([["J2", "2.5000"]]);
  });

  it("refuses a bill in fractions of a cent, a bill for nothing, and a history that loses parts", () => {
    const fates = inv.fatesOf(replay(), ["rc", "rk"]);
    expect(inv.planLateLandedCost({ amount: usd("10.005"), basis: "value", lines, fates })).toMatchObject({ ok: false, reason: "not_cents" });
    expect(inv.planLateLandedCost({ amount: usd("0"), basis: "value", lines, fates })).toMatchObject({ ok: false, reason: "not_positive" });
    const missing = new Map(fates);
    missing.set("rc", fates.get("rc")!.slice(1));
    expect(inv.planLateLandedCost({ amount: usd("10.00"), basis: "value", lines, fates: missing }))
      .toMatchObject({ ok: false, reason: "unaccounted" });
  });

  it("puts the freight back on the shelf when a unit comes back off the job", () => {
    const plan = ok(inv.planLateLandedCost({ amount: usd("10.00"), basis: "value", lines, fates: inv.fatesOf(replay(), ["rc", "rk"]) }));
    const revaluations = inv.lateLandedMovements(plan.pieces, stamps(20, plan.pieces.length));
    const used = ok(inv.costMovements({ movements: [...delivery, ...revaluations], method: "fifo" })).issues[0]!;
    const back = {
      ...mv("b1", 40, "return_to_stock", "1", { jobId: "J1", totalCost: used.cost, lateCost: used.late, revaluesMovementId: "i1" }),
      occurredAt: at(3),
    };
    const run = ok(inv.costMovements({ movements: [...delivery, ...revaluations, back], method: "fifo" }));
    expect(m(sum(run.layers.map((l) => l.late)))).toBe(m(add(plan.onShelf, used.late)));
    expect(m(run.value)).toBe("307.5000");
  });
});

describe("the ledger for late freight", () => {
  it("owes the whole bill and puts each share on stock, a job or nothing, balanced", () => {
    const posting = ledger.postLateLandedCost({
      billId: "b", occurredAt: at(3), total: usd("10.00"), onShelf: usd("5.00"),
      byJob: [{ jobId: "J1", amount: usd("2.50") }], onGone: usd("2.50"),
    });
    const net = (code: string) => m(sum(posting.entries.filter((e) => e.accountCode === code)
      .map((e) => (e.direction === "debit" ? e.amount : { ...e.amount, amount: -e.amount.amount }))));
    expect(net(ledger.ACCOUNTS.INVENTORY)).toBe("5.0000");
    expect(net(ledger.ACCOUNTS.COGS)).toBe("5.0000");
    expect(net(ledger.ACCOUNTS.ACCOUNTS_PAYABLE)).toBe("-10.0000");
    expect(posting.entries.find((e) => e.jobId === "J1")).toMatchObject({ accountCode: "5000", direction: "debit" });
    expect(() => ledger.postLateLandedCost({
      billId: "b", occurredAt: at(3), total: usd("10.00"), onShelf: usd("5.00"), byJob: [], onGone: usd("2.50"),
    })).toThrow(ledger.UnbalancedPostingError);
  });

  it("relieves stock on a use and puts it back on a return, on the job", () => {
    const used = ledger.postLateCostRelief({ movementId: "i", occurredAt: at(3), amount: usd("2.50"), jobId: "J1" });
    const back = ledger.postLateCostReturn({ movementId: "b", occurredAt: at(4), amount: usd("2.50"), jobId: "J1" });
    expect(used.entries.map((e) => [e.direction, e.accountCode, e.jobId ?? null])).toEqual([["debit", "5000", "J1"], ["credit", "1300", null]]);
    expect(back.entries.map((e) => [e.direction, e.accountCode, e.jobId ?? null])).toEqual([["debit", "1300", null], ["credit", "5000", "J1"]]);
  });
});

describe("packs and price breaks from a catalogue", () => {
  it("reads pack size, unit and break columns in the supply houses' spellings", () => {
    const parsed = catalogue.parseCatalogue([
      "Part #,Description,Net Price,Vendor,Case Qty,UOM,Break 1 Qty,Break 1 Price,Qty Break 2,Price Break 2",
      "WN-25,Wire nut,112.50,Ferguson,25,box,10,105.00,50,98.00",
      "CAP-1,Capacitor,12.50,Ferguson,,,,,,",
      "BAD,Bad pack,1.00,Ferguson,a dozen,,,,,",
    ].join("\n"));
    expect(parsed.rows[0]).toMatchObject({
      sku: "WN-25", cost: "112.50", pack: "25", unit: "box",
      breaks: [{ minimum: "10.0000", cost: "105.0000" }, { minimum: "50.0000", cost: "98.0000" }],
    });
    expect(parsed.rows[1]).toMatchObject({ sku: "CAP-1", pack: "1", breaks: [] });
    expect(parsed.problems).toEqual([{ line: 4, message: 'BAD comes in packs of "a dozen", which is not a number of our units.' }]);
  });

  it("costs the price book item per each, never per box", () => {
    const plan = catalogue.planCatalogue(
      [{ line: 2, sku: "WN-25", description: "Wire nut", cost: "112.50", vendor: "Ferguson", pack: "25", unit: "box", breaks: [] }],
      { vendors: [{ id: "v1", name: "Ferguson" }], links: [], items: [{ id: "i1", code: "WN-25", name: "Wire nut", cost: "5.00" }] },
      { updateItemCost: true },
    );
    expect(plan.rows[0]).toMatchObject({ action: "link", cost: "112.5000", eachCost: "4.5000", itemCostAfter: "4.5000", pack: "25.0000", unit: "box" });

    const created = catalogue.planCatalogue(
      [{ line: 2, sku: "NEW-1", description: "New", cost: "30.00", vendor: "Ferguson", pack: "12" }],
      { vendors: [{ id: "v1", name: "Ferguson" }], links: [], items: [] },
      { updateItemCost: false, margin: "0.5" },
    );
    expect(created.rows[0]).toMatchObject({ action: "create", eachCost: "2.5000", price: "5.0000" });
  });

  it("notices a changed pack or break table on a link that is otherwise the same", () => {
    const state: catalogue.CatalogueState = {
      vendors: [{ id: "v1", name: "Ferguson" }],
      links: [{ vendorId: "v1", itemId: "i1", partNumber: "WN-25", cost: "112.50", description: "Wire nut", packQuantity: "25", purchaseUnit: "box", priceBreaks: [] }],
      items: [{ id: "i1", code: "WN", name: "Wire nut", cost: "4.50" }],
    };
    const same = catalogue.planCatalogue([{ line: 2, sku: "WN-25", description: "Wire nut", cost: "112.50", vendor: "Ferguson", pack: "25", unit: "box", breaks: [] }], state, { updateItemCost: false });
    expect(same.rows[0]!.action).toBe("unchanged");
    const broke = catalogue.planCatalogue([{ line: 2, sku: "WN-25", description: "Wire nut", cost: "112.50", vendor: "Ferguson", pack: "25", unit: "box", breaks: [{ minimum: "10", cost: "100" }] }], state, { updateItemCost: false });
    expect(broke.rows[0]!.action).toBe("update");
  });

  it("prices an order from the highest break it reaches, and counts it in whole packs", () => {
    const breaks = [{ minimum: "10", cost: "105.00" }, { minimum: "50", cost: "98.00" }];
    expect(catalogue.packPriceFor("112.50", breaks, "9")).toEqual({ cost: "112.5000", breakMinimum: null });
    expect(catalogue.packPriceFor("112.50", breaks, "10")).toEqual({ cost: "105.0000", breakMinimum: "10" });
    expect(catalogue.packPriceFor("112.50", breaks, "60")).toEqual({ cost: "98.0000", breakMinimum: "50" });
    expect(catalogue.packsIn("250", "25")).toEqual({ ok: true, packs: "10" });
    expect(catalogue.packsIn("30", "25")).toEqual({ ok: false, below: "25", above: "50" });
    expect(catalogue.checkBreaks([{ minimum: "10", cost: "1" }, { minimum: "10.0", cost: "2" }]))
      .toEqual({ ok: false, message: "Two price breaks start at 10.0. Each quantity has one price." });
  });
});

describe("approval steps for some orders only", () => {
  const rules: inv.ApprovalRule[] = [
    { id: "r1", step: 1, minimumTotal: usd("0"), roleLabel: "Office manager", role: "office_manager", roleId: null, vendorId: "V-FERG", scopeLabel: "orders from Ferguson" },
    { id: "r2", step: 2, minimumTotal: usd("500"), roleLabel: "Owner", role: "owner", roleId: null, categoryId: "CAT-REF", scopeLabel: "orders with refrigerant" },
    { id: "r3", step: 3, minimumTotal: usd("100"), roleLabel: "Admin", role: "admin", roleId: null, locationId: "NORTH", scopeLabel: "orders for North yard" },
  ];
  const order = (vendorId: string, categoryIds: string[], locationIds: string[]) => ({ vendorId, categoryIds, locationIds });

  it("applies a step only to the vendor, category or location it names", () => {
    expect(inv.approvalPlan({ rules, total: usd("50"), approvals: [], order: order("V-OTHER", [], [SHOP]) }).state).toBe("not_needed");
    const ferg = inv.approvalPlan({ rules, total: usd("50"), approvals: [], order: order("V-FERG", [], [SHOP]) });
    expect(ferg.steps.map((s) => s.step)).toEqual([1]);
    expect(ferg.sentence).toContain("on orders from Ferguson needs one");
    const both = inv.approvalPlan({ rules, total: usd("600"), approvals: [], order: order("V-OTHER", ["CAT-REF", "CAT-X"], ["NORTH"]) });
    expect(both.steps.map((s) => s.step)).toEqual([2, 3]);
    // Without an order to read, a scoped step cannot be shown to apply, so only unscoped ones do.
    expect(inv.approvalPlan({ rules, total: usd("600"), approvals: [] }).state).toBe("not_needed");
  });

  it("asks again for a step whose approval an edit has gone above", () => {
    const decisions = [
      { step: 1, decision: "approved" as const, orderTotal: usd("400") },
      { step: 2, decision: "approved" as const, orderTotal: usd("900") },
    ];
    expect(inv.approvalsUndoneBy(usd("400"), decisions)).toEqual([]);
    expect(inv.approvalsUndoneBy(usd("650"), decisions)).toEqual([1]);
    expect(inv.approvalsUndoneBy(usd("901"), decisions)).toEqual([1, 2]);
  });
});

describe("a purchase order as a file", () => {
  it("prints the vendor's part number, packs as they sell them, and where each line goes", () => {
    const bytes = pdf.purchaseOrderPdf({
      company: { name: "Lone Star Air", color: "#1F6FEB", contact: ["9 Yard Rd, Austin, TX"] },
      number: 1042, status: "submitted", vendorName: "Ferguson", vendorAccount: "A-1188",
      submittedAt: "2026-06-15T12:00:00Z", expectedAt: null, notes: "Back gate, please.", total: "1250.00",
      lines: [
        { vendorPartNumber: "WN-25", itemCode: "WN", itemName: "Wire nut", quantityOrdered: "250", unitPrice: "4.50", lineTotal: "1125.00", deliverTo: "Shop, 9 Yard Rd", packs: { count: "10", size: "25", unit: "box", price: "112.50" } },
        { vendorPartNumber: null, itemCode: "CAP-1", itemName: "Capacitor", quantityOrdered: "10", unitPrice: "12.50", lineTotal: "125.00", deliverTo: "Van 4" },
      ],
      generatedAt: new Date("2026-06-15T12:00:00Z"),
    });
    const read = pdf.inspectPdf(bytes);
    expect(read.problems).toEqual([]);
    expect(read.title).toBe("Lone Star Air purchase order 1042");
    for (const text of ["Purchase order 1042", "Ferguson", "WN-25", "10 box of 25", "(250)", "$112.50", "Deliver to Van 4", "CAP-1", "$1,250.00", "Back gate, please."]) {
      expect(read.text).toContain(text);
    }
  });
});

it("keeps zero late freight at zero through every cost path", () => {
  const run = ok(inv.costMovements({
    movements: [mv("r1", 1, "receipt", "3", { totalCost: usd("10.00") }), mv("i1", 2, "issue", "2", { jobId: "J" })],
    method: "fifo",
  }));
  expect(run.issues[0]!.late).toEqual(zero("USD"));
  expect(inv.lateRelief(run, ["i1"])).toEqual([]);
});
