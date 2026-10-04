import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inflateSync } from "node:zlib";
import postgres from "postgres";
import { pdf, type Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as stockUnits from "../src/services/stock-units";
import * as stockReturns from "../src/services/stock-returns";
import * as landedCost from "../src/services/landed-cost";
import * as approvals from "../src/services/purchase-approvals";
import * as orderEmail from "../src/services/purchase-order-email";
import * as catalogue from "../src/services/vendor-catalogue";
import * as profitability from "../src/services/profitability";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * PURCHASING DEPTH, THROUGH A REAL DATABASE
 *
 * The arithmetic is tested in core. This proves what only rows can: that
 * numbers given to units on the shelf let them move, that a unit back off a
 * job lands at the cost it left at and comes off the job, that a freight bill
 * arriving after the delivery reaches the shelf, the job (as job costing reads
 * it) and the ledger in one balanced posting whose inventory balance every
 * later use relieves, that a vendor selling by the box is sent whole boxes at
 * the break the order reaches, that scoped approval steps apply to the orders
 * they name and an edit above an approval asks again, telling the approvers,
 * and that the emailed order carries its PDF.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("pd:org");
const OWNER = fixtureId("pd:owner");
const MANAGER = fixtureId("pd:manager");

let raw: postgres.Sql;
let compressor = "";
let coil = "";
let filter = "";
let wireNut = "";
let coils = "";
let shop = "";
let van = "";
let north = "";
let ferguson = "";
let watsco = "";
let job1 = "";
let job2 = "";

const db = () => testDb(url!);
const as = (userId: string, roles: string[], grants: string[] = [], key?: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], grants: grants as NonNullable<Actor["grants"]> },
  db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(OWNER, ["owner"], [], key);
const manager = () => as(MANAGER, ["office_manager"], ["po:approve"]);

async function item(code: string, name: string, categoryId: string | null = null): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code, category_id)
    values (${ORG}, 'material', ${code}, ${categoryId}) returning id`;
  await raw`
    insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, effective_from)
    values (${ORG}, ${row!.id}, 1, ${name}, '200.00', '5.00', now() - interval '1 day')`;
  return row!.id;
}

/** Each account's balance in this company's ledger, debits less credits. */
async function balances(): Promise<Record<string, string>> {
  const rows = await raw<{ account_code: string; net: string }[]>`
    select account_code, sum(case when direction = 'debit' then amount else -amount end)::numeric(14,4)::text as net
    from public.ledger_entry where organization_id = ${ORG} group by account_code`;
  return Object.fromEntries(rows.map((r) => [r.account_code, r.net]));
}

async function newJob(summary: string): Promise<string> {
  const customer = await customers.create(owner(), {
    type: "residential", name: `Customer for ${summary}`, phone: "+15125550177",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: `${summary.length} Elm St`, city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  return (await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary, tags: [], customFields: {},
  })).id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Depth Co", slug: "depth-co" });
  await raw`delete from public."user" where id = ${MANAGER} or email = 'manager@depth.test'`;
  await raw`insert into public."user" (id, email, name) values (${MANAGER}, 'manager@depth.test', 'Mona Manager')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${MANAGER}, 'office_manager')`;
  [{ id: coils }] = await raw<{ id: string }[]>`
    insert into public.price_book_category (organization_id, name) values (${ORG}, 'Coils') returning id` as unknown as [{ id: string }];
  compressor = await item("COMP-3T", "Compressor, 3 ton");
  coil = await item("COIL-3T", "Evaporator coil", coils);
  filter = await item("FLT-20", "Filter 20x25");
  wireNut = await item("WN-25", "Wire nut");
  [{ id: shop }] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, is_warehouse, address_line1, city, state)
    values (${ORG}, 'Shop', true, '9 Yard Rd', 'Austin', 'TX') returning id` as unknown as [{ id: string }];
  [{ id: van }] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name) values (${ORG}, 'Van 4') returning id` as unknown as [{ id: string }];
  [{ id: north }] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, is_warehouse) values (${ORG}, 'North yard', true) returning id` as unknown as [{ id: string }];
  ferguson = (await inventory.createVendor(owner(), { name: "Ferguson", email: "orders@ferguson.test" })).id;
  watsco = (await inventory.createVendor(owner(), { name: "Watsco", email: "orders@watsco.test" })).id;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@depth.test" })})`;
  job1 = await newJob("Compressor change");
  job2 = await newJob("Coil swap");
});

afterAll(async () => { if (raw) await raw.end(); });

run("numbers for units already on the shelf, and a unit back off a job", () => {
  it("numbers what is on hand by a count at one place, refusing duplicates, and changes nothing else", async () => {
    await inventory.receive(owner(), { itemId: compressor, locationId: shop, quantity: "3", totalCost: "300.00" });
    const tracked = await stockUnits.setTracking(owner(), { itemId: compressor, mode: "serial" });
    expect(tracked.unnumbered).toEqual([{ locationId: shop, locationName: "Shop", quantity: "3" }]);

    const first = await stockUnits.numberUnits(owner("num-1"), { itemId: compressor, locationId: shop, units: [{ number: "A1" }, { number: "A2" }] });
    expect(first).toEqual({ numbered: ["A1", "A2"], alreadyHere: [], stillUnnumbered: "1" });
    // A retry is the first count, not a second.
    expect(await stockUnits.numberUnits(owner("num-1"), { itemId: compressor, locationId: shop, units: [{ number: "A1" }, { number: "A2" }] }))
      .toEqual(first);

    const second = await stockUnits.numberUnits(owner(), { itemId: compressor, locationId: shop, units: [{ number: "a1" }, { number: "A3" }] });
    expect(second).toEqual({ numbered: ["A3"], alreadyHere: ["A1"], stillUnnumbered: "0" });

    await expect(stockUnits.numberUnits(owner(), { itemId: compressor, locationId: van, units: [{ number: "A1" }] }))
      .rejects.toThrow(/Serial A1 of Compressor, 3 ton is already in stock at Shop/);
    await expect(stockUnits.numberUnits(owner(), { itemId: compressor, locationId: shop, units: [{ number: "A9" }] }))
      .rejects.toThrow(/Every Compressor, 3 ton at Shop already has its number/);

    const levels = (await inventory.levels(owner())).filter((l) => l.itemId === compressor);
    expect(levels.map((l) => [l.locationName, l.onHand])).toEqual([["Shop", "3"]]);
    const units = await stockUnits.units(owner(), { itemId: compressor });
    expect(units.map((u) => [u.number, u.state])).toEqual([["A1", "in_stock"], ["A2", "in_stock"], ["A3", "in_stock"]]);
  });

  it("uses a numbered unit as the customer's condenser, and shows the trace on their equipment page", async () => {
    await inventory.issue(owner(), {
      itemId: compressor, locationId: shop, quantity: "1", jobId: job1,
      units: [{ number: "A1", installAs: { category: "Condenser", manufacturer: "Copeland" } }],
    });
    const [lot] = await raw<{ equipment_id: string }[]>`
      select equipment_id from public.stock_lot where organization_id = ${ORG} and number = 'A1'`;
    const traces = await stockUnits.traceForEquipment(owner(), { equipmentId: lot!.equipment_id });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.unit.number).toBe("A1");
    expect(traces[0]!.steps.map((s) => s.label)).toEqual(["Numbered on the shelf", "Issued to a job"]);
    expect(await inventory.costOfJob(owner(), { jobId: job1 })).toBe("100.0000");
  });

  it("takes it back off the job by number at the cost it left at, off the job's cost, and refuses it twice", async () => {
    const back = await stockReturns.returnFromJob(owner(), { itemId: compressor, locationId: van, numbers: ["A1"] });
    expect(back.returned).toMatchObject([{ number: "A1", jobId: job1 }]);
    expect(back.equipmentStillOnRecord).toHaveLength(1);

    const [movement] = await raw<{ total_cost: string; job_id: string; revalues_movement_id: string }[]>`
      select total_cost, job_id, revalues_movement_id from public.stock_movement
      where organization_id = ${ORG} and kind = 'return_to_stock'`;
    expect(movement!.total_cost).toBe("100.0000");
    expect(movement!.job_id).toBe(job1);
    expect(await inventory.costOfJob(owner(), { jobId: job1 })).toBe("0.0000");

    const unit = (await stockUnits.units(owner(), { itemId: compressor, number: "A1" }))[0]!;
    expect(unit.state).toBe("in_stock");
    expect(unit.where.map((w) => w.locationName)).toEqual(["Van 4"]);
    expect(unit.equipmentId).toBeNull();

    await expect(stockReturns.returnFromJob(owner(), { itemId: compressor, locationId: shop, numbers: ["A1"] }))
      .rejects.toThrow(/is in stock at Van 4, so it cannot come back off a job/);
    await expect(inventory.receive(owner(), { itemId: compressor, locationId: shop, quantity: "1", totalCost: "1", units: [{ number: "A1" }] }))
      .rejects.toThrow(/already in stock at Van 4/);
  });

  it("sends a unit back to the vendor for a credit, needing a figure when its cost is not on record", async () => {
    await expect(stockReturns.createVendorReturn(owner(), {
      vendorId: watsco, itemId: compressor, locationId: shop, units: [{ number: "A2" }], reason: "Wrong voltage",
    })).rejects.toThrow(/Say what credit the vendor is giving/);
    await expect(stockReturns.createVendorReturn(as(OWNER, ["accountant"], ["po:write"]), {
      vendorId: watsco, itemId: compressor, locationId: shop, units: [{ number: "A2" }], reason: "Wrong voltage",
    })).rejects.toThrow(/inventory:adjust|permission/i);

    const made = await stockReturns.createVendorReturn(owner(), {
      vendorId: watsco, itemId: compressor, locationId: shop, units: [{ number: "A2" }], reason: "Wrong voltage",
      reference: "RMA-77", creditExpected: "95.00",
    });
    expect(made).toMatchObject({ number: 1, status: "awaiting_credit", creditExpected: "95.0000", reference: "RMA-77" });
    expect(made.units).toMatchObject([{ number: "A2", quantity: "1", locationName: "Shop" }]);
    expect((await stockUnits.units(owner(), { itemId: compressor, number: "A2" }))[0]!.state).toBe("gone");

    const credited = await stockReturns.recordVendorCredit(owner(), { id: made.id, amount: "90.00", reference: "CM-1" });
    expect(credited).toMatchObject({ status: "credited", creditReceived: "90.0000", creditReference: "CM-1" });
    await expect(stockReturns.recordVendorCredit(owner(), { id: made.id, amount: "5.00" })).rejects.toThrow(/already has its credit/);
  });
});

run("freight billed after the delivery", () => {
  let orderId = "";
  let receiptId = "";

  it("follows the parts to a van, a job and a loss, posts one balanced entry, and job costing sees the job's share", async () => {
    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: shop,
      lines: [{ itemId: coil, quantity: "3", unitPrice: "100.00" }, { itemId: filter, quantity: "1", unitPrice: "100.00" }],
    });
    orderId = order.id;
    await inventory.setPurchaseOrderStatus(owner(), { id: order.id, status: "submitted" });
    const detail = await inventory.purchaseOrder(owner(), { id: order.id });
    const received = await inventory.receivePurchaseOrder(owner(), {
      purchaseOrderId: order.id, lines: detail.lines.map((l) => ({ lineId: l.id, quantity: l.quantityOrdered })),
    });
    receiptId = received.receiptId;

    await inventory.transfer(owner(), { itemId: coil, fromLocationId: shop, toLocationId: van, quantity: "1" });
    await inventory.issue(owner(), { itemId: coil, locationId: shop, quantity: "1", jobId: job2 });
    await inventory.count(owner(), { itemId: coil, locationId: shop, counted: "0", reasonCode: "dropped" });

    await expect(landedCost.recordLateBill(owner(), { receiptId, charges: [{ description: "Freight", amount: "10.005" }] }))
      .rejects.toThrow(/give it to the cent/);

    const before = await balances();
    const bill = await landedCost.recordLateBill(owner("bill-1"), {
      receiptId, charges: [{ description: "Freight", amount: "7.00" }, { description: "Fuel surcharge", amount: "3.00" }],
      basis: "value", reference: "PRO-4471",
    });
    expect(bill).toMatchObject({ total: "10.0000", onShelf: "5.0000", onJobs: "2.5000", onGone: "2.5000" });
    expect(bill.jobs).toMatchObject([{ jobId: job2, amount: "2.5000" }]);
    // A retry is the same bill, not a second one.
    expect((await landedCost.recordLateBill(owner("bill-1"), { receiptId, charges: [{ description: "Freight", amount: "10.00" }] })).id).toBe(bill.id);

    const after = await balances();
    const moved = (code: string) => (Number(after[code] ?? 0) - Number(before[code] ?? 0)).toFixed(4);
    expect(moved("1300")).toBe("5.0000");
    expect(moved("5000")).toBe("5.0000");
    expect(moved("2000")).toBe("-10.0000");
    const entries = await raw<{ account_code: string; job_id: string | null; amount: string }[]>`
      select account_code, job_id, amount from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'landed_cost_bill' and source_id = ${bill.id} order by account_code, amount`;
    expect(entries.find((e) => e.job_id === job2)).toMatchObject({ account_code: "5000", amount: "2.5000" });

    // Job costing reads it: the job's material cost and the row behind it.
    const statement = await profitability.statement(owner(), { jobId: job2 });
    expect(statement.materialCost).toBe("2.5000");
    expect(statement.costEntries.map((e) => [e.accountCode, e.amount])).toEqual([["5000", "2.5000"]]);
    expect(await inventory.costOfJob(owner(), { jobId: job2 })).toBe("102.5000");

    const po = await inventory.purchaseOrder(owner(), { id: orderId });
    expect(po.receipts[0]!.lateBills).toMatchObject([{
      reference: "PRO-4471", total: "10.0000", onShelf: "5.0000", onJobs: "2.5000", onGone: "2.5000",
      charges: [{ description: "Freight", amount: "7.0000" }, { description: "Fuel surcharge", amount: "3.0000" }],
    }]);
  });

  it("relieves the inventory account by exactly the share a later use takes, onto that job", async () => {
    const before = await balances();
    await inventory.issue(owner(), { itemId: coil, locationId: van, quantity: "1", jobId: job1 });
    const after = await balances();
    expect((Number(after["1300"]) - Number(before["1300"])).toFixed(4)).toBe("-2.5000");
    const relief = await raw<{ job_id: string | null; amount: string }[]>`
      select job_id, amount from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'stock_movement' and account_code = '5000'`;
    expect(relief).toEqual([{ job_id: job1, amount: "2.5000" }]);
    // What is left in the account is the late freight still on a shelf: the filter's.
    expect(after["1300"]).toBe("2.5000");
  });

  it("refuses a bill for a delivery that does not exist", async () => {
    await expect(landedCost.recordLateBill(owner(), {
      receiptId: "00000000-0000-0000-0000-00000000dead", charges: [{ description: "Freight", amount: "1.00" }],
    })).rejects.toThrow(/Delivery/);
  });
});

run("a vendor that sells by the box, with price breaks", () => {
  it("imports pack and breaks, costs the item per each, and orders whole boxes at the break reached", async () => {
    const csv = [
      "Part #,Description,Net Price,Vendor,Case Qty,UOM,Break 1 Qty,Break 1 Price",
      "WN-25,Wire nut,112.50,Ferguson,25,box,10,105.00",
    ].join("\n");
    const applied = await catalogue.apply(owner(), { csv, updateItemCost: true });
    expect(applied.rows[0]).toMatchObject({ action: "link", eachCost: "4.5000", itemCostAfter: "4.5000" });
    const [link] = await catalogue.links(owner(), { itemId: wireNut });
    expect(link).toMatchObject({ packQuantity: "25.0000", purchaseUnit: "box", cost: "112.5000", eachCost: "4.5000" });
    expect(link!.priceBreaks).toEqual([{ minimum: "10.0000", cost: "105.0000" }]);

    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: shop, lines: [{ itemId: wireNut, quantity: "30" }],
    })).rejects.toThrow("This vendor sells WN-25 by the box of 25. Order 25 or 50, not 30.");

    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: shop, lines: [{ partNumber: "WN-25", quantity: "250" }],
    });
    const detail = await inventory.purchaseOrder(owner(), { id: order.id });
    expect(detail.total).toBe("1050.0000");
    expect(detail.lines[0]).toMatchObject({
      quantityOrdered: "250.0000", unitPrice: "4.2000", lineTotal: "1050.0000",
      packs: { count: "10", size: "25", unit: "box", price: "105.0000" },
    });

    // Emailed with the PDF attached, which says it as the vendor sells it.
    const sent = await orderEmail.emailOrder(owner(), { id: order.id });
    expect(sent.state).toBe("queued");
    const [file] = await raw<{ file_name: string; content_type: string; content: Buffer }[]>`
      select a.file_name, a.content_type, a.content from public.message_attachment a
      join public.message msg on msg.id = a.message_id
      where a.organization_id = ${ORG} and msg.to_address = 'orders@ferguson.test'`;
    expect(file!.file_name).toBe(`purchase-order-${detail.number}.pdf`);
    expect(file!.content_type).toBe("application/pdf");
    const read = pdf.inspectPdf(new Uint8Array(file!.content), (bytes) => new Uint8Array(inflateSync(bytes)));
    expect(read.problems).toEqual([]);
    expect(read.text).toContain("10 box of 25");
    expect(read.text).toContain("WN-25");
    expect(read.text).toContain("$1,050.00");
    const [body] = await raw<{ body: string }[]>`
      select body from public.message where organization_id = ${ORG} and to_address = 'orders@ferguson.test'`;
    expect(body!.body).toContain("10 box of 25 x WN-25  Wire nut  at $105.00  = $1,050.00  (250 in all)");

    // Received in our units at the pack price, exactly.
    await inventory.receivePurchaseOrder(owner(), { purchaseOrderId: order.id, lines: [{ lineId: detail.lines[0]!.id, quantity: "250" }] });
    const [receipt] = await raw<{ total_cost: string }[]>`
      select total_cost from public.stock_movement where organization_id = ${ORG} and item_id = ${wireNut} and kind = 'receipt'`;
    expect(receipt!.total_cost).toBe("1050.0000");
  });
});

run("approval steps for some orders, edits and telling the approvers", () => {
  it("applies a step only to its vendor, category or location, and emails whoever it waits for", async () => {
    await approvals.addRule(owner(), { minimumTotal: "0", approverRole: "office_manager", vendorId: watsco });
    await approvals.addRule(owner(), { minimumTotal: "500", approverRole: "owner", categoryId: coils });
    await approvals.addRule(owner(), { minimumTotal: "100", approverRole: "owner", locationId: north });

    const plain = await inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: shop, lines: [{ itemId: filter, quantity: "1", unitPrice: "50.00" }],
    });
    expect((await approvals.approvalsFor(owner(), { id: plain.id })).state).toBe("not_needed");

    const toWatsco = await inventory.createPurchaseOrder(owner(), {
      vendorId: watsco, defaultLocationId: shop, lines: [{ itemId: filter, quantity: "4", unitPrice: "100.00" }],
    });
    const waiting = await approvals.approvalsFor(owner(), { id: toWatsco.id });
    expect(waiting.state).toBe("waiting");
    expect(waiting.sentence).toContain("on orders from Watsco needs one");
    const told = (await inventory.purchaseOrder(owner(), { id: toWatsco.id })).approvalNotices;
    expect(told).toMatchObject([{ step: 1, name: "Mona Manager", destination: "manager@depth.test", state: "queued" }]);
    const [mail] = await raw<{ subject: string; body: string }[]>`
      select subject, body from public.message where organization_id = ${ORG} and to_address = 'manager@depth.test'`;
    expect(mail!.subject).toMatch(/^Purchase order \d+ is waiting for your approval$/);
    expect(mail!.body).toContain("to Watsco, for $400.00");

    const coilsNorth = await inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: north, lines: [{ itemId: coil, quantity: "6", unitPrice: "100.00" }],
    });
    expect((await approvals.approvalsFor(owner(), { id: coilsNorth.id })).steps.map((s) => s.scopeLabel))
      .toEqual(["orders with a line from Coils", "orders for North yard"]);
  });

  it("asks again when an edit goes above what was approved, and not when it stays under", async () => {
    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId: watsco, defaultLocationId: shop, lines: [{ itemId: filter, quantity: "2", unitPrice: "100.00" }],
    });
    await approvals.decide(manager(), { id: order.id, decision: "approved" });
    expect((await approvals.approvalsFor(owner(), { id: order.id })).state).toBe("approved");

    const lower = await inventory.editPurchaseOrder(owner(), { id: order.id, lines: [{ itemId: filter, quantity: "1", unitPrice: "100.00" }] });
    expect(lower).toMatchObject({ total: "100.0000", askedAgain: [] });
    expect((await approvals.approvalsFor(owner(), { id: order.id })).state).toBe("approved");

    const higher = await inventory.editPurchaseOrder(owner(), { id: order.id, lines: [{ itemId: filter, quantity: "3", unitPrice: "100.00" }] });
    expect(higher.askedAgain).toEqual([1]);
    expect(higher.approval).toContain("Waiting for an office manager");
    await expect(inventory.setPurchaseOrderStatus(owner(), { id: order.id, status: "submitted" })).rejects.toThrow(/Waiting for an office manager/);
    const notices = (await inventory.purchaseOrder(owner(), { id: order.id })).approvalNotices;
    expect(notices.filter((n) => n.destination === "manager@depth.test")).toHaveLength(2);

    // The set aside approval is kept as the record.
    const decisions = await raw<{ superseded_at: Date | null }[]>`
      select superseded_at from public.purchase_order_approval where purchase_order_id = ${order.id} order by created_at`;
    expect(decisions[0]!.superseded_at).not.toBeNull();
    await approvals.decide(manager(), { id: order.id, decision: "approved" });
    await inventory.setPurchaseOrderStatus(owner(), { id: order.id, status: "submitted" });
    await expect(inventory.editPurchaseOrder(owner(), { id: order.id, lines: [{ itemId: filter, quantity: "1" , unitPrice: "1.00" }] }))
      .rejects.toThrow(/the vendor already has it/);
  });
});
