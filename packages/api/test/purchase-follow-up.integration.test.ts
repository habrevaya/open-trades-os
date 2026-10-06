import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as acks from "../src/services/purchase-acknowledgements";
import { routes } from "../src/contracts";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHAT THE VENDOR SAID BACK, AND WHICH ORDERS NEED A CALL
 *
 * A buyer writes down a vendor's reply by hand: the day they promised it by,
 * their reference, what they said. The purchasing list then holds the vendor to
 * it: an order nobody answered after the company's number of days, and an order
 * past its promise with something still owed. Nothing is read out of an email.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("pfu:org");
const OWNER = fixtureId("pfu:owner");
const CLERK = fixtureId("pfu:clerk");

let raw: postgres.Sql;
let itemId = "";
let shop = "";
let vendorId = "";

const db = () => testDb(url!);
const as = (userId: string, roles: string[], key?: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] },
  db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(OWNER, ["owner"], key);
/** Somebody in the office who writes orders and answers vendors, and does not approve spending. */
const clerk = (key?: string) => as(CLERK, ["office_manager"], key);
const reader = () => as(CLERK, ["accountant"]);

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** A sent order, sent `daysAgo` days ago. */
async function sentOrder(daysAgo = 0, quantity = "10") {
  const made = await inventory.createPurchaseOrder(owner(), {
    vendorId, defaultLocationId: shop, lines: [{ itemId, quantity, unitPrice: "20.00" }],
  });
  await inventory.setPurchaseOrderStatus(owner(), { id: made.id, status: "submitted" });
  await raw`update public.purchase_order set submitted_at = now() - ${daysAgo * 86_400_000 + 3_600_000} * interval '1 millisecond'
    where id = ${made.id}`;
  return made.id;
}

const listed = async (id: string) => (await inventory.purchaseOrders(owner())).find((o) => o.id === id)!;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Follow Up Co", slug: "follow-up-co" });
  await raw`delete from public."user" where id = ${CLERK} or email = 'clerk@follow-up.test'`;
  await raw`insert into public."user" (id, email, name) values (${CLERK}, 'clerk@follow-up.test', 'Cleo Clerk')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${CLERK}, 'office_manager')`;
  const [item] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'material', 'FILTER-16') returning id`;
  itemId = item!.id;
  await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
    values (${ORG}, ${itemId}, 1, 'Filter 16x25', '30.00', now() - interval '1 day')`;
  const [loc] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, is_warehouse, address_line1, city, state)
    values (${ORG}, 'Shop', true, '9 Yard Rd', 'Austin', 'TX') returning id`;
  shop = loc!.id;
  vendorId = (await inventory.createVendor(owner(), { name: "Watsco", email: "orders@watsco.test" })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.purchase_order_acknowledgement where organization_id = ${ORG}`;
  await acks.setSettings(owner(), { acknowledgeAfterDays: 3 });
});

run("writing down what the vendor said", () => {
  it("acknowledges a sent order with their promise and reference, and leaves what the buyer asked for alone", async () => {
    const id = await sentOrder(0);
    await raw`update public.purchase_order set expected_at = ${new Date(Date.now() + 5 * 86_400_000).toISOString()} where id = ${id}`;
    const [before] = await raw`select expected_at from public.purchase_order where id = ${id}`;

    const answer = await acks.record(clerk(), { id, promisedOn: day(7), reference: "SO-5541", note: "Ships Friday from Dallas" });
    expect(answer).toMatchObject({ id, status: "acknowledged", promisedOn: day(7) });

    const order = await inventory.purchaseOrder(owner(), { id });
    expect(order).toMatchObject({ status: "acknowledged", promisedOn: day(7), vendorReference: "SO-5541" });
    expect(order.acknowledgedAt).not.toBeNull();
    expect(order.replies).toEqual([expect.objectContaining({
      promisedOn: day(7), previousPromisedOn: null, reference: "SO-5541", note: "Ships Friday from Dallas", recordedByName: "Cleo Clerk",
    })]);
    const [after] = await raw`select expected_at from public.purchase_order where id = ${id}`;
    expect(after!.expected_at).toEqual(before!.expected_at);
    const [audit] = await raw`select action from public.audit_log where entity_id = ${id} and action = 'purchase_order.acknowledged'`;
    expect(audit).toBeDefined();
  });

  it("keeps every reply with the promise it replaced, and needs something new once they have answered", async () => {
    const id = await sentOrder(0);
    await acks.record(clerk(), { id, promisedOn: day(3) });
    await expect(acks.record(clerk(), { id })).rejects.toThrow(/already answered this one/);
    await acks.record(clerk(), { id, promisedOn: day(10), note: "Pushed again" });
    const order = await inventory.purchaseOrder(owner(), { id });
    expect(order.promisedOn).toBe(day(10));
    expect(order.replies.map((r) => [r.promisedOn, r.previousPromisedOn])).toEqual([[day(3), null], [day(10), day(3)]]);
  });

  it("takes a bare confirmation from the first reply, and the status button leaves the same record", async () => {
    const a = await sentOrder(0);
    await acks.record(clerk(), { id: a });
    expect((await inventory.purchaseOrder(owner(), { id: a })).replies).toEqual([expect.objectContaining({ promisedOn: null })]);

    const b = await sentOrder(0);
    await inventory.setPurchaseOrderStatus(clerk(), { id: b, status: "acknowledged" });
    const order = await inventory.purchaseOrder(owner(), { id: b });
    expect(order.status).toBe("acknowledged");
    expect(order.acknowledgedAt).not.toBeNull();
    expect(order.replies).toHaveLength(1);
  });

  it("refuses a draft, a finished order, a promise before it was sent and a slip of the keys", async () => {
    const draft = await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: shop, lines: [{ itemId, quantity: "1", unitPrice: "20.00" }],
    });
    await expect(acks.record(clerk(), { id: draft.id, promisedOn: day(3) })).rejects.toThrow(/has not been sent/);

    const id = await sentOrder(0);
    await expect(acks.record(clerk(), { id, promisedOn: day(-3) })).rejects.toThrow(/before the order was sent/);
    await expect(acks.record(clerk(), { id, promisedOn: day(500) })).rejects.toThrow(/more than a year/);
    await expect(acks.record(clerk(), { id, promisedOn: "next week" })).rejects.toThrow(/Say the day/);
    expect((await inventory.purchaseOrder(owner(), { id })).replies).toEqual([]);

    await inventory.setPurchaseOrderStatus(owner(), { id, status: "cancelled" });
    await expect(acks.record(clerk(), { id, promisedOn: day(3) })).rejects.toThrow(/cancelled, so there is nothing left/);
  });

  it("answers a retry with the first answer rather than a second reply", async () => {
    const id = await sentOrder(0);
    const first = await acks.record(clerk("ack-key-1"), { id, promisedOn: day(4) });
    const again = await acks.record(clerk("ack-key-1"), { id, promisedOn: day(4) });
    expect(again).toEqual(first);
    expect((await inventory.purchaseOrder(owner(), { id })).replies).toHaveLength(1);
  });

  it("is for whoever writes orders: a reader cannot", async () => {
    const id = await sentOrder(0);
    await expect(acks.record(reader(), { id, promisedOn: day(3) })).rejects.toThrow(/po:write/);
  });
});

run("which orders need a call", () => {
  it("lists a sent order nobody answered once it is older than the company's days, and not before", async () => {
    const young = await sentOrder(2);
    const old = await sentOrder(5);
    expect((await listed(young)).followUp).toBeNull();
    const call = (await listed(old)).followUp!;
    expect(call).toMatchObject({ kind: "not_acknowledged", days: 5 });
    expect(call.sentence).toMatch(/^Watsco has not answered\. It was sent on \d{4}-\d{2}-\d{2}, 5 days ago\.$/);

    // The company's own number of days.
    await acks.setSettings(owner(), { acknowledgeAfterDays: 7 });
    expect((await listed(old)).followUp).toBeNull();
    await acks.setSettings(owner(), { acknowledgeAfterDays: 2 });
    expect((await listed(young)).followUp).toMatchObject({ kind: "not_acknowledged" });
  });

  it("stops asking once they have answered, and starts again when the promise passes", async () => {
    const id = await sentOrder(5);
    await acks.record(clerk(), { id, promisedOn: day(2) });
    expect((await listed(id)).followUp).toBeNull();
    expect((await listed(id)).promisedOn).toBe(day(2));

    // A promise that has passed, with everything still owed.
    await raw`update public.purchase_order set promised_on = ${day(-2)} where id = ${id}`;
    const late = (await listed(id)).followUp!;
    expect(late).toMatchObject({ kind: "past_promise", days: 2 });
    expect(late.sentence).toBe(`Watsco promised it by ${day(-2)}, 2 days ago, and it has not all arrived.`);

    // Moved again, it is a call no longer.
    await acks.record(clerk(), { id, promisedOn: day(4), note: "Pushed" });
    expect((await listed(id)).followUp).toBeNull();
  });

  it("holds a part delivered order to its promise for the rest, and lets a fully delivered one go", async () => {
    const id = await sentOrder(6, "10");
    await acks.record(clerk(), { id, promisedOn: day(-1) });
    const detail = await inventory.purchaseOrder(owner(), { id });
    const line = detail.lines[0]!;
    await inventory.receivePurchaseOrder(owner(), { purchaseOrderId: id, lines: [{ lineId: line.id, quantity: "4" }] });
    expect((await listed(id)).followUp).toMatchObject({ kind: "past_promise" });
    await inventory.receivePurchaseOrder(owner(), { purchaseOrderId: id, lines: [{ lineId: line.id, quantity: "6" }] });
    expect((await listed(id)).status).toBe("received");
    expect((await listed(id)).followUp).toBeNull();
  });

  it("leaves drafts and cancelled orders out", async () => {
    const draft = await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: shop, lines: [{ itemId, quantity: "1", unitPrice: "20.00" }],
    });
    expect((await listed(draft.id)).followUp).toBeNull();
    const gone = await sentOrder(9);
    await inventory.setPurchaseOrderStatus(owner(), { id: gone, status: "cancelled" });
    expect((await listed(gone)).followUp).toBeNull();
  });

  it("is what the reorder suggestions call late too, so the two never disagree", async () => {
    // Earlier tests left sent orders for this part, so the point is set well above all of them.
    await inventory.setReorderPolicy(owner(), { itemId, locationId: shop, reorderPoint: "5000", reorderQuantity: "20" });
    const id = await sentOrder(2, "5");
    await acks.record(clerk(), { id, promisedOn: day(-1) });
    const suggestion = (await inventory.toOrder(owner())).find((s) => s.itemId === itemId)!;
    expect(suggestion.overdue.map((o) => o.purchaseOrderId)).toContain(id);
    await acks.record(clerk(), { id, promisedOn: day(5) });
    const later = (await inventory.toOrder(owner())).find((s) => s.itemId === itemId)!;
    expect(later.overdue.map((o) => o.purchaseOrderId)).not.toContain(id);
  });
});

run("how long a vendor may sit on an order", () => {
  it("is a whole number of days from 1 to 30, set by whoever writes orders", async () => {
    expect(await acks.getSettings(reader())).toEqual({ acknowledgeAfterDays: 3 });
    expect(await acks.setSettings(clerk(), { acknowledgeAfterDays: 10 })).toEqual({ acknowledgeAfterDays: 10 });
    await expect(acks.setSettings(clerk(), { acknowledgeAfterDays: 0 })).rejects.toThrow(/1 to 30/);
    await expect(acks.setSettings(clerk(), { acknowledgeAfterDays: 31 })).rejects.toThrow(/1 to 30/);
    await expect(acks.setSettings(clerk(), { acknowledgeAfterDays: 2.5 })).rejects.toThrow(/whole number/);
    await expect(acks.setSettings(reader(), { acknowledgeAfterDays: 4 })).rejects.toThrow(/po:write/);
  });

  it("declares the permissions the services demand", () => {
    expect(routes.recordPurchaseOrderAcknowledgement.permissions).toEqual(["po:write"]);
    expect(routes.getPurchasingSettings.permissions).toEqual(["po:read"]);
    expect(routes.setPurchasingSettings.permissions).toEqual(["po:write"]);
  });
});
