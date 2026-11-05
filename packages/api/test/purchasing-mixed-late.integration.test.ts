import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as landedCost from "../src/services/landed-cost";
import * as approvals from "../src/services/purchase-approvals";
import * as catalogue from "../src/services/vendor-catalogue";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * ONE LINE OF BOXES AND SOME OVER, A STEP ON A LINE'S QUANTITY OR A VENDOR,
 * AND A LATE FREIGHT BILL ON STOCK THAT CAME WITHOUT AN ORDER
 *
 * The arithmetic of a mixed line's slices is tested in core. This proves what
 * rows add: that a line of 2 boxes and 3 each is priced and received exactly,
 * that approval steps count by quantity and by vendor, and that a freight bill
 * can be put on stock received outside an order and follows its parts.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("mx:org");
const OWNER = fixtureId("mx:owner");
const TECH = fixtureId("mx:tech");

let raw: postgres.Sql;
let wireNut = "";
let bolt = "";
let motor = "";
let shop = "";
let ferguson = "";
let watsco = "";
let job1 = "";

const db = () => testDb(url!);
const as = (userId: string, roles: string[], key?: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], grants: [] as NonNullable<Actor["grants"]> },
  db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(OWNER, ["owner"], key);

async function item(code: string, name: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'material', ${code}) returning id`;
  await raw`
    insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, effective_from)
    values (${ORG}, ${row!.id}, 1, ${name}, '200.00', '5.00', now() - interval '1 day')`;
  return row!.id;
}

async function balances(): Promise<Record<string, string>> {
  const rows = await raw<{ account_code: string; net: string }[]>`
    select account_code, sum(case when direction = 'debit' then amount else -amount end)::numeric(14,4)::text as net
    from public.ledger_entry where organization_id = ${ORG} group by account_code`;
  return Object.fromEntries(rows.map((r) => [r.account_code, r.net]));
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Mixed Late Co", slug: "mixed-late-co" });
  await raw`delete from public."user" where id = ${TECH} or email = 'tech@mixedlate.test'`;
  await raw`insert into public."user" (id, email, name) values (${TECH}, 'tech@mixedlate.test', 'Tess Tech')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${TECH}, 'technician')`;
  wireNut = await item("WN-MIX", "Wire nut");
  bolt = await item("BOLT-MIX", "Anchor bolt");
  motor = await item("MTR-MIX", "Blower motor");
  [{ id: shop }] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, is_warehouse, address_line1, city, state)
    values (${ORG}, 'Shop', true, '9 Yard Rd', 'Austin', 'TX') returning id` as unknown as [{ id: string }];
  ferguson = (await inventory.createVendor(owner(), { name: "Ferguson", email: "orders@ferguson.test" })).id;
  watsco = (await inventory.createVendor(owner(), { name: "Watsco", email: "orders@watsco.test" })).id;
  await catalogue.setLink(owner(), {
    vendorId: ferguson, itemId: wireNut, partNumber: "NUT-EA", cost: "0.55",
    secondPack: { packQuantity: "25", purchaseUnit: "box", cost: "10.00" },
  });
  await catalogue.setLink(owner(), { vendorId: watsco, itemId: motor, partNumber: "MTR-1", cost: "100.00" });
  const customer = await customers.create(owner(), {
    type: "residential", name: "Mixed Late Customer", phone: "+15125550178", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "5 Elm St", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  job1 = (await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "Anchor job", tags: [], customFields: {},
  })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("one line of boxes and some over", () => {
  it("prices 2 boxes and 3 each as one line, and shows both on the order", async () => {
    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: shop, lines: [{ itemId: wireNut, quantity: "53", looseQuantity: "3" }],
    });
    const view = await inventory.purchaseOrder(owner(), { id: order.id });
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]).toMatchObject({
      quantityOrdered: "53.0000", unitPrice: "0.5500", lineTotal: "21.6500",
      packs: { count: "2", size: "25", unit: "box", price: "10.0000", loose: "3", loosePrice: "0.5500" },
    });
    expect(view.total).toBe("21.6500");
  });

  it("refuses what it cannot price: a vendor that sells one way, a part that is not whole boxes, all of it loose", async () => {
    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId: watsco, defaultLocationId: shop, lines: [{ itemId: motor, quantity: "5", looseQuantity: "2" }],
    })).rejects.toThrow(/both by the each and by the pack/);
    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: shop, lines: [{ itemId: wireNut, quantity: "50", looseQuantity: "3" }],
    })).rejects.toThrow(/a whole number of packs of 25/);
    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: shop, lines: [{ itemId: wireNut, quantity: "3", looseQuantity: "3" }],
    })).rejects.toThrow(/would be bought by the each/);
  });

  it("costs every delivery of it so the slices add back to the line exactly", async () => {
    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: shop, lines: [{ itemId: wireNut, quantity: "53", looseQuantity: "3" }],
    });
    await inventory.setPurchaseOrderStatus(owner(), { id: order.id, status: "submitted" });
    const line = (await inventory.purchaseOrder(owner(), { id: order.id })).lines[0]!;
    for (const quantity of ["10", "15", "28"]) {
      await inventory.receivePurchaseOrder(owner(), { purchaseOrderId: order.id, lines: [{ lineId: line.id, quantity }] });
    }
    const costs = await raw<{ quantity: string; total_cost: string }[]>`
      select quantity, total_cost from public.stock_movement
      where organization_id = ${ORG} and purchase_order_id = ${order.id} and kind = 'receipt' order by sequence`;
    expect(costs.map((c) => Number(c.quantity))).toEqual([10, 15, 28]);
    const total = costs.reduce((sum, c) => sum + Math.round(Number(c.total_cost) * 10000), 0);
    expect(total).toBe(216500);
    // The first 25 pieces are the box: exactly its price, however they came in.
    expect(Number(costs[0]!.total_cost) + Number(costs[1]!.total_cost)).toBeCloseTo(10, 4);
    expect((await inventory.purchaseOrder(owner(), { id: order.id })).status).toBe("received");
  });
});

run("a step on a line's quantity, and one counted by vendor", () => {
  const order = (vendorId: string, quantity: string, extra?: { itemId: string; quantity: string }) => inventory.createPurchaseOrder(owner(), {
    vendorId, defaultLocationId: shop,
    lines: [{ itemId: motor, quantity, unitPrice: "10.00" }, ...(extra ? [{ itemId: extra.itemId, quantity: extra.quantity, unitPrice: "1.00" }] : [])],
  });

  it("asks for approval only when a line is that many or more, and says so", async () => {
    await expect(approvals.addRule(owner(), { minimumTotal: "0", approverRole: "owner", lineQuantityAtLeast: "0" }))
      .rejects.toThrow(/above zero/);
    await expect(approvals.addRule(owner(), { minimumTotal: "0", approverRole: "owner", lineQuantityAtLeast: "lots" }))
      .rejects.toThrow(/not a quantity/);
    await expect(approvals.addRule(as(TECH, ["technician"]), { minimumTotal: "0", approverRole: "owner", lineQuantityAtLeast: "20" }))
      .rejects.toThrow();
    const rule = await approvals.addRule(owner(), { minimumTotal: "0", approverRole: "owner", lineQuantityAtLeast: "20" });
    try {
      expect(rule).toMatchObject({ lineQuantityAtLeast: "20", scopeLabel: "orders with a line of 20 or more" });
      const small = await approvals.approvalsFor(owner(), { id: (await order(watsco, "19")).id });
      expect(small.state).toBe("not_needed");
      const big = await approvals.approvalsFor(owner(), { id: (await order(watsco, "20")).id });
      expect(big.state).toBe("waiting");
      expect(big.sentence).toContain("with a line of 20 or more");
    } finally {
      await approvals.removeRule(owner(), { id: rule.id });
    }
  });

  it("counts only the lines of that size when the step counts part of the order", async () => {
    const rule = await approvals.addRule(owner(), {
      minimumTotal: "150", approverRole: "office_manager", lineQuantityAtLeast: "20", amountOf: "matching_lines",
    });
    try {
      expect(rule.scopeLabel).toBe("the lines of 20 or more");
      // 25 motors at 10 is 250; the 5 bolts at 1 are not counted.
      const over = await approvals.approvalsFor(owner(), { id: (await order(watsco, "25", { itemId: bolt, quantity: "5" })).id });
      expect(over.steps[0]).toMatchObject({ amount: "250.0000", amountOf: "matching_lines" });
      expect(over.steps[0]!.lines.map((l) => l.description)).toEqual(["Blower motor"]);
      // 10 motors (100) and 30 bolts (30): a line of 20 or more is there, but its share, 30, is under 150.
      const under = await approvals.approvalsFor(owner(), { id: (await order(watsco, "10", { itemId: bolt, quantity: "30" })).id });
      expect(under.state).toBe("not_needed");
    } finally {
      await approvals.removeRule(owner(), { id: rule.id });
    }
  });

  it("lets a step count by vendor alone, as every line of that vendor's orders", async () => {
    const rule = await approvals.addRule(owner(), {
      minimumTotal: "100", approverRole: "office_manager", vendorId: watsco, amountOf: "matching_lines",
    });
    try {
      expect(rule).toMatchObject({ amountOf: "matching_lines", scopeLabel: "the lines on orders from Watsco" });
      const theirs = await approvals.approvalsFor(owner(), { id: (await order(watsco, "12")).id });
      expect(theirs.state).toBe("waiting");
      expect(theirs.steps[0]).toMatchObject({ amount: "120.0000" });
      const ours = await approvals.approvalsFor(owner(), { id: (await order(ferguson, "12")).id });
      expect(ours.state).toBe("not_needed");
    } finally {
      await approvals.removeRule(owner(), { id: rule.id });
    }
    await expect(approvals.addRule(owner(), { minimumTotal: "100", approverRole: "owner", amountOf: "matching_lines" }))
      .rejects.toThrow(/say which/);
  });
});

run("a freight bill on stock that came without an order", () => {
  it("follows the parts to the shelf and the job, posts one balanced entry, and keeps its place in the list", async () => {
    await inventory.receive(owner(), { itemId: bolt, locationId: shop, quantity: "10", totalCost: "100.00" });
    await inventory.issue(owner(), { itemId: bolt, locationId: shop, quantity: "4", jobId: job1 });
    const [delivery] = (await landedCost.listStockReceipts(owner())).filter((r) => r.itemId === bolt);
    expect(delivery).toMatchObject({ itemCode: "BOLT-MIX", locationName: "Shop", quantity: "10", cost: "100.0000", lateTotal: "0.0000", lateBills: [] });

    await expect(landedCost.recordLateBill(as(TECH, ["technician"]), {
      stockReceiptId: delivery!.id, charges: [{ description: "Freight", amount: "20.00" }],
    })).rejects.toThrow();
    await expect(landedCost.recordLateBill(owner(), {
      stockReceiptId: delivery!.id, charges: [{ description: "Freight", amount: "20.005" }],
    })).rejects.toThrow(/to the cent/);
    await expect(landedCost.recordLateBill(owner(), { charges: [{ description: "Freight", amount: "1.00" }] }))
      .rejects.toThrow(/Name the delivery/);
    await expect(landedCost.recordLateBill(owner(), {
      stockReceiptId: "00000000-0000-0000-0000-00000000dead", charges: [{ description: "Freight", amount: "1.00" }],
    })).rejects.toThrow(/Delivery/);

    const before = await balances();
    const bill = await landedCost.recordLateBill(owner("stock-bill-1"), {
      stockReceiptId: delivery!.id, charges: [{ description: "Freight", amount: "20.00" }], reference: "PRO-9",
    });
    expect(bill).toMatchObject({ receiptId: null, purchaseOrderId: null, stockReceiptId: delivery!.id, total: "20.0000", onShelf: "12.0000", onJobs: "8.0000", onGone: "0.0000" });
    expect(bill.jobs).toMatchObject([{ jobId: job1, amount: "8.0000" }]);
    expect((await landedCost.recordLateBill(owner("stock-bill-1"), {
      stockReceiptId: delivery!.id, charges: [{ description: "Freight", amount: "20.00" }],
    })).id).toBe(bill.id);

    const after = await balances();
    const moved = (code: string) => (Number(after[code] ?? 0) - Number(before[code] ?? 0)).toFixed(4);
    expect(moved("1300")).toBe("12.0000");
    expect(moved("5000")).toBe("8.0000");
    expect(moved("2000")).toBe("-20.0000");

    const listed = (await landedCost.listStockReceipts(owner())).find((r) => r.id === delivery!.id)!;
    expect(listed.lateTotal).toBe("20.0000");
    expect(listed.lateBills).toMatchObject([{ reference: "PRO-9", total: "20.0000", onShelf: "12.0000", onJobs: "8.0000", onGone: "0.0000" }]);
  });

  it("does not list a delivery to somebody who may not read orders", async () => {
    await expect(landedCost.listStockReceipts(as(TECH, ["technician"]))).rejects.toThrow();
  });
});
