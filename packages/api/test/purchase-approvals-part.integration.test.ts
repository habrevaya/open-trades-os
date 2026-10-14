import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as approvals from "../src/services/purchase-approvals";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * AN APPROVAL STEP FOR PART OF AN ORDER, THROUGH A REAL DATABASE
 *
 * The arithmetic is tested in core. This proves what rows add: that a step
 * saved as counting some lines compares only those lines, that the approver
 * is shown which lines tripped it (on the order and in the email), that the
 * amount each approval said yes to is kept, and that an edit asks the step
 * again only when the lines it counts went above that amount.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("pp:org");
const OWNER = fixtureId("pp:owner");
const MANAGER = fixtureId("pp:manager");

let raw: postgres.Sql;
let refrigerant = "";
let parts = "";
let r410 = "";
let r22 = "";
let motor = "";
let austin = "";
let houston = "";
let vendorId = "";

const db = () => testDb(url!);
const as = (userId: string, roles: string[], grants: string[] = [], key?: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], grants: grants as NonNullable<Actor["grants"]> },
  db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(OWNER, ["owner"], [], key);
const manager = () => as(MANAGER, ["office_manager"], ["po:approve"]);

async function item(code: string, name: string, categoryId: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code, category_id)
    values (${ORG}, 'material', ${code}, ${categoryId}) returning id`;
  await raw`
    insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, effective_from)
    values (${ORG}, ${row!.id}, 1, ${name}, '200.00', '5.00', now() - interval '1 day')`;
  return row!.id;
}

const place = async (name: string) => (await raw<{ id: string }[]>`
  insert into public.location (organization_id, name, is_warehouse, address_line1, city, state)
  values (${ORG}, ${name}, true, '9 Yard Rd', 'Austin', 'TX') returning id`)[0]!.id;

const category = async (name: string) => (await raw<{ id: string }[]>`
  insert into public.price_book_category (organization_id, name) values (${ORG}, ${name}) returning id`)[0]!.id;

/** 540 of refrigerant (300 in Houston, 240 in Austin) and 2,460 of parts in Houston: 3,000 in all. */
const bigOrder = (extra: { motorQuantity?: string; r410Quantity?: string } = {}) => inventory.createPurchaseOrder(owner(), {
  vendorId, defaultLocationId: houston,
  lines: [
    { itemId: r410, quantity: extra.r410Quantity ?? "3", unitPrice: "100.00", locationId: houston },
    { itemId: r22, quantity: "2", unitPrice: "120.00", locationId: austin },
    { itemId: motor, quantity: extra.motorQuantity ?? "6", unitPrice: "410.00", locationId: houston },
  ],
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Part Order Co", slug: "part-order-co" });
  await raw`delete from public."user" where id = ${MANAGER} or email = 'manager@partorder.test'`;
  await raw`insert into public."user" (id, email, name) values (${MANAGER}, 'manager@partorder.test', 'Mona Manager')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${MANAGER}, 'office_manager')`;
  refrigerant = await category("Refrigerant");
  parts = await category("Motors");
  r410 = await item("R410-25", "R-410A, 25 lb", refrigerant);
  r22 = await item("R22-30", "R-22 reclaim, 30 lb", refrigerant);
  motor = await item("FAN-1", "Condenser fan motor", parts);
  austin = await place("Austin shop");
  houston = await place("Houston warehouse");
  vendorId = (await inventory.createVendor(owner(), { name: "Johnstone", email: "orders@johnstone.test" })).id;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@partorder.test" })})`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("approval steps for part of an order", () => {
  it("refuses to count some lines without saying which, and keeps the choice on the step", async () => {
    await expect(approvals.addRule(owner(), { minimumTotal: "500", approverRole: "owner", vendorId, amountOf: "matching_lines" }))
      .rejects.toThrow(/say which: a category, a location, or both/);
    await expect(approvals.addRule(owner(), { minimumTotal: "500", approverRole: "owner", amountOf: "matching_lines" }))
      .rejects.toThrow(/say which/);
    await expect(approvals.addRule(manager(), { minimumTotal: "500", approverRole: "owner", categoryId: refrigerant, amountOf: "matching_lines" }))
      .rejects.toThrow();

    const added = await approvals.addRule(owner("part-1"), {
      minimumTotal: "500", approverRole: "office_manager", categoryId: refrigerant, amountOf: "matching_lines",
    });
    expect(added).toMatchObject({ step: 1, amountOf: "matching_lines", scopeLabel: "the Refrigerant lines" });
    // A retry is the first call, not a second step.
    expect((await approvals.addRule(owner("part-1"), {
      minimumTotal: "500", approverRole: "office_manager", categoryId: refrigerant, amountOf: "matching_lines",
    })).id).toBe(added.id);
    expect((await approvals.listRules(owner())).map((r) => r.amountOf)).toEqual(["matching_lines"]);
  });

  it("counts the refrigerant, not the order, and shows the approver which lines tripped it", async () => {
    // 3,000 in all but only 540 of it refrigerant: over 500, so it waits, on the lines.
    const order = await bigOrder();
    const view = await approvals.approvalsFor(owner(), { id: order.id });
    expect(view.state).toBe("waiting");
    expect(view.sentence).toContain("because the Refrigerant lines come to $540.00 and anything at or over $500.00 of them needs one");
    expect(view.steps[0]).toMatchObject({
      amountOf: "matching_lines", amount: "540.0000",
      lines: [{ description: "R-410A, 25 lb", amount: "300.0000" }, { description: "R-22 reclaim, 30 lb", amount: "240.0000" }],
    });
    expect((await inventory.purchaseOrder(owner(), { id: order.id })).approval.steps[0]!.lines).toHaveLength(2);

    // The approver's email names the lines.
    const [mail] = await raw<{ body: string }[]>`
      select body from public.message where organization_id = ${ORG} and to_address = 'manager@partorder.test'
      order by created_at desc limit 1`;
    expect(mail!.body).toContain("R-410A, 25 lb: $300.00");
    expect(mail!.body).toContain("R-22 reclaim, 30 lb: $240.00");
    expect(mail!.body).not.toContain("Condenser fan motor");

    // A big order with little refrigerant does not trip the step at all.
    const small = await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: houston,
      lines: [{ itemId: r410, quantity: "2", unitPrice: "100.00" }, { itemId: motor, quantity: "9", unitPrice: "410.00" }],
    });
    expect((await approvals.approvalsFor(owner(), { id: small.id })).state).toBe("not_needed");
  });

  it("asks again only when the lines it counts go above what was approved", async () => {
    const order = await bigOrder();
    await approvals.decide(manager(), { id: order.id, decision: "approved" });
    const [recorded] = await raw<{ counted_total: string; order_total: string }[]>`
      select counted_total, order_total from public.purchase_order_approval where purchase_order_id = ${order.id}`;
    expect(recorded).toMatchObject({ counted_total: "540.0000", order_total: "3000.0000" });

    const lines = (r410Quantity: string, motorQuantity: string) => [
      { itemId: r410, quantity: r410Quantity, unitPrice: "100.00", locationId: houston },
      { itemId: r22, quantity: "2", unitPrice: "120.00", locationId: austin },
      { itemId: motor, quantity: motorQuantity, unitPrice: "410.00", locationId: houston },
    ];
    // The parts doubled and the refrigerant did not move: the yes to the refrigerant stands.
    const parts = await inventory.editPurchaseOrder(owner(), { id: order.id, lines: lines("3", "12") });
    expect(parts.askedAgain).toEqual([]);
    expect((await approvals.approvalsFor(owner(), { id: order.id })).state).toBe("approved");
    // The refrigerant went up a little and the total barely: the step asks again.
    const gas = await inventory.editPurchaseOrder(owner(), { id: order.id, lines: lines("4", "12") });
    expect(gas.askedAgain).toEqual([1]);
    expect((await approvals.approvalsFor(owner(), { id: order.id })).state).toBe("waiting");
    await expect(inventory.setPurchaseOrderStatus(owner(), { id: order.id, status: "submitted" }))
      .rejects.toThrow(/Waiting for an office manager/);
    // The refrigerant down under the step: it no longer applies, and the order is free to go.
    await inventory.editPurchaseOrder(owner(), { id: order.id, lines: lines("1", "12") });
    expect((await approvals.approvalsFor(owner(), { id: order.id })).state).toBe("not_needed");
  });

  it("counts the lines for a location, and the lines that are both a category and a location", async () => {
    // Replace the refrigerant step with two: over 2,000 for Houston, and over 250 of refrigerant for Houston.
    for (const rule of await approvals.listRules(owner())) await approvals.removeRule(owner(), { id: rule.id });
    const houstonStep = await approvals.addRule(owner(), {
      minimumTotal: "2000", approverRole: "office_manager", locationId: houston, amountOf: "matching_lines",
    });
    expect(houstonStep.scopeLabel).toBe("the lines for Houston warehouse");
    const gasInHouston = await approvals.addRule(owner(), {
      minimumTotal: "250", approverRole: "owner", categoryId: refrigerant, locationId: houston, amountOf: "matching_lines",
    });
    expect(gasInHouston.scopeLabel).toBe("the Refrigerant lines for Houston warehouse");

    const order = await bigOrder();
    const view = await approvals.approvalsFor(owner(), { id: order.id });
    expect(view.steps.map((s) => [s.amount, s.lines.map((l) => l.description)])).toEqual([
      ["2760.0000", ["R-410A, 25 lb", "Condenser fan motor"]],
      ["300.0000", ["R-410A, 25 lb"]],
    ]);

    // The Austin line is not Houston's: with the motor taken off, 300 is under 2,000 and the first step goes.
    const noMotor = await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: houston,
      lines: [{ itemId: r410, quantity: "3", unitPrice: "100.00", locationId: houston }, { itemId: r22, quantity: "9", unitPrice: "120.00", locationId: austin }],
    });
    expect((await approvals.approvalsFor(owner(), { id: noMotor.id })).steps.map((s) => s.step)).toEqual([gasInHouston.step]);
  });
});
