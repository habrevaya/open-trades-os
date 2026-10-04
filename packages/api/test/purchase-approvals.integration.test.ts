import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as approvals from "../src/services/purchase-approvals";
import * as orderEmail from "../src/services/purchase-order-email";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * APPROVAL STEPS AND EMAILING AN ORDER, THROUGH A REAL DATABASE
 *
 * The order of the steps and who may decide them are tested in core. This
 * proves the part that depends on rows: that the role is read from the
 * person's own membership, that an order waiting on a step cannot be sent by
 * any path (the status call or the email), and that every email attempt is
 * on the order whether it went or not, with a link that opens the order for a
 * vendor holding nothing but the link.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("pa:org");
const OWNER = fixtureId("pa:owner");
const MANAGER = fixtureId("pa:manager");
const BUYER = fixtureId("pa:buyer");

let raw: postgres.Sql;
let itemId = "";
let shop = "";
let vendorId = "";

const db = () => testDb(url!);
const as = (userId: string, roles: string[], grants: string[] = [], key?: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], grants: grants as NonNullable<Actor["grants"]> },
  db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(OWNER, ["owner"], [], key);
/** The office manager preset, given `po:approve` by name, as a company that wants them approving would. */
const manager = () => as(MANAGER, ["office_manager"], ["po:approve"]);
/** A buyer who may write orders and not approve them. */
const buyer = (key?: string) => as(BUYER, ["office_manager"], [], key);

async function member(userId: string, role: string, email: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${email.split("@")[0]!})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role})`;
}

async function order(price: string) {
  return inventory.createPurchaseOrder(buyer(), {
    vendorId, defaultLocationId: shop, lines: [{ itemId, quantity: "2", unitPrice: price }],
  });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Approve Co", slug: "approve-co" });
  await member(MANAGER, "office_manager", "manager@approve.test");
  await member(BUYER, "office_manager", "buyer@approve.test");
  const [item] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'equipment', 'COND-5T') returning id`;
  itemId = item!.id;
  await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
    values (${ORG}, ${itemId}, 1, 'Condenser, 5 ton', '4200.00', now() - interval '1 day')`;
  const [loc] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, is_warehouse, address_line1, city, state)
    values (${ORG}, 'Shop', true, '9 Yard Rd', 'Austin', 'TX') returning id`;
  shop = loc!.id;
  vendorId = (await inventory.createVendor(owner(), { name: "Watsco", email: "orders@watsco.test", accountNumber: "A-1188" })).id;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@approve.test" })})`;
  await approvals.addRule(owner(), { minimumTotal: "1000", approverRole: "office_manager" });
  await approvals.addRule(owner(), { minimumTotal: "5000", approverRole: "owner" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.purchase_order_send where organization_id = ${ORG}`;
});

run("approval steps", () => {
  it("refuses a later step that starts below an earlier one, and a step with no role", async () => {
    await expect(approvals.addRule(owner(), { step: 3, minimumTotal: "100", approverRole: "admin" }))
      .rejects.toThrow(/A later step asks for more, never less/);
    await expect(approvals.addRule(owner(), { minimumTotal: "100" })).rejects.toThrow(/Name one role/);
    await expect(approvals.addRule(manager(), { minimumTotal: "9000", approverRole: "owner" })).rejects.toThrow();
  });

  it("lets an order under every step go on the sender's own approval, and not on a buyer's", async () => {
    const small = await order("100.00");
    await expect(inventory.setPurchaseOrderStatus(buyer(), { id: small.id, status: "submitted" }))
      .rejects.toThrow(/po:approve/);
    await inventory.setPurchaseOrderStatus(manager(), { id: small.id, status: "submitted" });
  });

  it("holds a large order until each step is approved in order by somebody holding its role", async () => {
    const big = await order("3000.00");
    const before = await approvals.approvalsFor(buyer(), { id: big.id });
    expect(before.state).toBe("waiting");
    expect(before.sentence).toContain("step 1 of 2");

    // Not sendable by anybody while a step waits, the owner included.
    await expect(inventory.setPurchaseOrderStatus(owner(), { id: big.id, status: "submitted" }))
      .rejects.toThrow(/Waiting for an office manager/);
    await expect(orderEmail.emailOrder(owner(), { id: big.id })).rejects.toThrow(/Waiting for an office manager/);

    // The owner is not the office manager the first step names.
    await expect(approvals.decide(owner(), { id: big.id, decision: "approved" })).rejects.toThrow(/needs an office manager/);
    await approvals.decide(manager(), { id: big.id, decision: "approved" });
    // Nobody decides two steps of one order.
    await expect(approvals.decide(as(MANAGER, ["owner"]), { id: big.id, decision: "approved" }))
      .rejects.toThrow(/needs an owner|already decided a step/);
    const done = await approvals.decide(owner(), { id: big.id, decision: "approved", note: "Bulk price agreed" });
    expect(done.state).toBe("approved");
    expect(done.steps.map((s) => s.decidedBy)).toEqual(["manager", "approve-co@test.local"]);

    // Approved at every step, the buyer who wrote it may now send it.
    await inventory.setPurchaseOrderStatus(buyer(), { id: big.id, status: "submitted" });
  });

  it("ends at a rejection, which needs a reason", async () => {
    const big = await order("700.00");
    await expect(approvals.decide(manager(), { id: big.id, decision: "rejected" })).rejects.toThrow(/Say why/);
    const rejected = await approvals.decide(manager(), { id: big.id, decision: "rejected", note: "Wrong tonnage" });
    expect(rejected.state).toBe("rejected");
    await expect(inventory.setPurchaseOrderStatus(owner(), { id: big.id, status: "submitted" })).rejects.toThrow(/Rejected at step 1/);
    await inventory.setPurchaseOrderStatus(buyer(), { id: big.id, status: "cancelled" });
  });
});

run("emailing an order to its vendor", () => {
  it("sends an approved draft, marks it sent, records the send, and opens for the vendor by its link", async () => {
    const big = await order("600.00");
    await approvals.decide(manager(), { id: big.id, decision: "approved" });
    const sent = await orderEmail.emailOrder(buyer("email-1"), { id: big.id, message: "Deliver to the back gate." });
    expect(sent).toMatchObject({ state: "queued", destination: "orders@watsco.test", status: "submitted" });
    expect(sent.link).toMatch(/\/po\/[A-Za-z0-9_-]{40,}$/);

    // A retry is the first send, not a second email.
    const again = await orderEmail.emailOrder(buyer("email-1"), { id: big.id });
    expect(again.sendId).toBe(sent.sendId);
    const messages = await raw<{ subject: string; body: string }[]>`
      select subject, body from public.message where organization_id = ${ORG} and to_address = 'orders@watsco.test'`;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.subject).toMatch(/^Purchase order \d+ from Approve Co$/);
    expect(messages[0]!.body).toContain("Deliver to the back gate.");
    expect(messages[0]!.body).toContain("2 x COND-5T  Condenser, 5 ton  at $600.00  = $1,200.00  (deliver to Shop, 9 Yard Rd, Austin, TX)");

    const detail = await inventory.purchaseOrder(buyer(), { id: big.id });
    expect(detail.status).toBe("submitted");
    expect(detail.sends).toMatchObject([{ destination: "orders@watsco.test", state: "queued", sentBy: "buyer" }]);

    const token = sent.link.split("/po/")[1]!;
    const printable = await orderEmail.forVendor(db(), { token });
    expect(printable).toMatchObject({ vendorName: "Watsco", vendorAccount: "A-1188", total: "1200.0000" });
    await expect(orderEmail.forVendor(db(), { token: "not-a-token" })).rejects.toThrow();
  });

  it("refuses a vendor with no address, and records a send the mail path would not take without sending the order", async () => {
    const noMail = (await inventory.createVendor(owner(), { name: "Counter Only Supply" })).id;
    const draft = await inventory.createPurchaseOrder(buyer(), {
      vendorId: noMail, defaultLocationId: shop, lines: [{ itemId, quantity: "1", unitPrice: "50.00" }],
    });
    await expect(orderEmail.emailOrder(manager(), { id: draft.id })).rejects.toThrow(/has no email address on file/);

    await raw`insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, 'blocked@counter.test', 'email', 'complaint')`;
    const refused = await orderEmail.emailOrder(manager(), { id: draft.id, to: "blocked@counter.test" });
    expect(refused.state).toBe("refused");
    expect(refused.status).toBe("draft");
    expect(refused.link).toBe("");
    const detail = await inventory.purchaseOrder(manager(), { id: draft.id });
    expect(detail.status).toBe("draft");
    expect(detail.sends[0]).toMatchObject({ state: "refused", destination: "blocked@counter.test" });
  });

  it("sends a copy of an order already sent, and refuses a cancelled one", async () => {
    const small = await order("10.00");
    await inventory.setPurchaseOrderStatus(manager(), { id: small.id, status: "submitted" });
    const copy = await orderEmail.emailOrder(buyer(), { id: small.id });
    expect(copy).toMatchObject({ state: "queued", status: "submitted" });
    await inventory.setPurchaseOrderStatus(buyer(), { id: small.id, status: "cancelled" });
    await expect(orderEmail.emailOrder(buyer(), { id: small.id })).rejects.toThrow(/cancelled/);
  });
});
