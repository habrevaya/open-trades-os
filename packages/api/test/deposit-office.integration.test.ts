import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { PermissionError } from "@opentradesos/core";
import * as deposits from "../src/services/deposits";
import * as billing from "../src/services/billing";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * A HELD DEPOSIT APPLIED, GIVEN BACK OR KEPT FROM THE OFFICE
 *
 * The office screens call the same service the API does, so what is tested
 * here is the service's answer to the three things the screens offer: who may
 * put a deposit against an invoice (both permissions the route declares),
 * which invoices it can go against, and that a deposit that was kept no
 * longer reads as held.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("deposit-office/org");
const USER = fixtureId("deposit-office/user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctxFor = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const office = () => ctxFor(["office_manager"]);
const finance = () => ctxFor(["accountant"]);

let customerId = "";
let otherCustomerId = "";

async function heldDeposit(amount: string) {
  const d = await deposits.request(office(), { customerId, amount });
  await deposits.record(office(), { depositId: d.id, amount });
  return d.id;
}

async function invoiceFor(customer: string, unitPrice: string, draft = false) {
  const invoice = await billing.create(office(), {
    customerId: customer, draft,
    lines: [{ name: "Install", quantity: "1", unitPrice, discountAmount: "0", taxable: false }],
  }) as Record<string, unknown>;
  return invoice["id"] as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Deposit Office Co", slug: "deposit-office-co" });
  const [c] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Rae Held') returning id`;
  customerId = c!.id;
  const [o] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Sam Other') returning id`;
  otherCustomerId = o!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("applying a held deposit", () => {
  it("needs invoice:write as well as deposit:collect, as the route says", async () => {
    const id = await heldDeposit("300.00");
    const invoiceId = await invoiceFor(customerId, "500.00");
    // Customer service and a technician take deposits, and neither may change what an invoice asks for.
    await expect(deposits.apply(ctxFor(["csr"]), { id, invoiceId })).rejects.toThrow(PermissionError);
    await expect(deposits.apply(ctxFor(["technician"]), { id, invoiceId })).rejects.toThrow(PermissionError);
    await expect(deposits.apply(ctxFor(["readonly"]), { id, invoiceId })).rejects.toThrow(PermissionError);
    const [entries] = await raw`select count(*)::int as n from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'deposit_application' and source_id = ${id}`;
    expect(entries!.n).toBe(0);

    const applied = await deposits.apply(office(), { id, invoiceId });
    expect(applied.amountApplied).toBe("300.0000");
    const [invoice] = await raw`select balance, status from public.invoice where id = ${invoiceId}`;
    expect(invoice!.balance).toBe("200.0000");
    expect(invoice!.status).toBe("partially_paid");
    const [audit] = await raw`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'deposit.applied' and entity_id = ${id}`;
    expect(audit!.n).toBe(1);
  });

  it("applies nothing the second time, so a double press is harmless", async () => {
    const id = await heldDeposit("200.00");
    const invoiceId = await invoiceFor(customerId, "900.00");
    await deposits.apply(office(), { id, invoiceId });
    const again = await deposits.apply(office(), { id, invoiceId });
    expect(again.amountApplied).toBe("0.0000");
    const [invoice] = await raw`select balance from public.invoice where id = ${invoiceId}`;
    expect(invoice!.balance).toBe("700.0000");
  });

  it("refuses another customer's invoice, a draft, and a void one", async () => {
    const id = await heldDeposit("100.00");
    await expect(deposits.apply(office(), { id, invoiceId: await invoiceFor(otherCustomerId, "100.00") }))
      .rejects.toThrow(/different customer/);
    await expect(deposits.apply(office(), { id, invoiceId: await invoiceFor(customerId, "100.00", true) }))
      .rejects.toThrow(/draft/);
    const voided = await invoiceFor(customerId, "100.00");
    await raw`update public.invoice set status = 'void' where id = ${voided}`;
    await expect(deposits.apply(office(), { id, invoiceId: voided })).rejects.toThrow(ConflictError);

    const [held] = (await deposits.list(office(), { customerId })).deposits.filter((d) => d.id === id);
    expect(held!.outstanding).toBe("100.0000");
  });
});

run("a deposit given back or kept", () => {
  it("reads a kept deposit as no longer held, and counts it out of the total", async () => {
    const id = await heldDeposit("400.00");
    const before = (await deposits.list(finance(), { customerId })).totalOutstanding;
    await deposits.refund(finance(), { id, disposition: "forfeit", reason: "Cancelled the day before" });

    const after = await deposits.list(finance(), { customerId });
    const kept = after.deposits.find((d) => d.id === id)!;
    expect(kept.status).toBe("forfeited");
    expect(kept.amountForfeited).toBe("400.0000");
    expect(kept.outstanding).toBe("0.0000");
    expect(Number(after.totalOutstanding)).toBeCloseTo(Number(before) - 400, 4);
    expect((await deposits.list(finance(), { customerId, outstandingOnly: true })).deposits.map((d) => d.id))
      .not.toContain(id);
  });

  it("keeps the reason in the audit row, and refuses the office", async () => {
    const id = await heldDeposit("150.00");
    await expect(deposits.refund(office(), { id, disposition: "refund", reason: "Changed their mind" }))
      .rejects.toThrow(PermissionError);
    await deposits.refund(finance(), { id, disposition: "refund", reason: "Changed their mind" });
    const [audit] = await raw`select after from public.audit_log
      where organization_id = ${ORG} and action = 'deposit.refunded' and entity_id = ${id}`;
    expect((audit!.after as { reason: string }).reason).toBe("Changed their mind");
    const listed = (await deposits.list(finance(), { customerId })).deposits.find((d) => d.id === id)!;
    expect(listed.outstanding).toBe("0.0000");
    expect(listed.amountRefunded).toBe("150.0000");
  });
});
