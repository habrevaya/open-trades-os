import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as creditNotes from "../src/services/credit-notes";
import * as customers from "../src/services/customers";
import * as statements from "../src/services/statements";
import { UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A CUSTOMER STATEMENT
 *
 * What a customer owed at the start of a period, everything that happened in
 * it, and what they owe at the end. Read from the ledger, so these tests are
 * about the statement agreeing with the documents that made the postings, and
 * about the commercial case: an invoice a property manager pays belongs on the
 * manager's statement and not the tenant's.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("st:org");
const USER = fixtureId("st:user");
let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/**
 * UTC calendar arithmetic, against a company pinned to UTC in `beforeAll`.
 *
 * The company's timezone decides what "today" is for the service, and an
 * organization with none set falls back to a default that is not UTC. Left
 * unpinned, this file failed every night between midnight UTC and the
 * default zone's midnight, which is exactly the kind of failure that gets
 * called flaky.
 */
const today = () => time.dateIn(new Date(), "UTC");
const daysAgo = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

let rosa = "";
let tenant = "";
let manager = "";
let first = { id: "", total: "" };
let second = { id: "", total: "" };

const line = (unitPrice: string) => ({ name: "Service", quantity: "1", unitPrice, discountAmount: "0", taxable: false });

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Statement Co", slug: "statement-co" });
  await raw`update public.organization set timezone = 'UTC' where id = ${ORG}`;
  const make = async (name: string, phone: string) => (await customers.create(owner(), {
    type: "residential", name, phone, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id;
  rosa = await make("Rosa Statement", "+15125550201");
  tenant = await make("Tess Tenant", "+15125550202");
  manager = await make("Meridian Management", "+15125550203");

  /** Twenty days ago, due fifteen days ago: late. */
  first = await billing.create(owner(), {
    customerId: rosa, issuedOn: daysAgo(20), dueOn: daysAgo(15), lines: [line("400.00")],
  });
  second = await billing.create(owner(), { customerId: rosa, dueOn: today(), lines: [line("200.00")] });
  await billing.pay(owner(), {
    customerId: rosa, method: "check", checkNumber: "2209", amount: "150.00", tipAmount: "0",
    allocations: [{ invoiceId: first.id, amount: "150.00" }],
  });
  await creditNotes.create(owner(), {
    invoiceId: second.id, reason: "billing_error", draft: false, apply: true,
    lines: [{ name: "Wrong rate", quantity: "1", unitPrice: "50.00" }],
  });
  /** Held: paid ahead, against nothing. */
  await billing.pay(owner(), { customerId: rosa, method: "cash", amount: "30.00", tipAmount: "0", allocations: [] });
});

afterAll(async () => { if (raw) await raw.end(); });

run("a customer's statement", () => {
  it("opens, runs and closes on what the documents say", async () => {
    const s = await statements.statement(owner(), { id: rosa, from: daysAgo(30), to: today() });
    expect(Number(s.openingBalance)).toBe(0);
    expect(s.lines.map((l) => [l.description, Number(l.amount)])).toEqual([
      [`Invoice ${(await billing.get(owner(), { id: first.id })).number}`, 400],
      [`Invoice ${(await billing.get(owner(), { id: second.id })).number}`, 200],
      ["Payment, cheque 2209", -150],
      [expect.stringMatching(/^Credit note \d+$/), -50],
      ["Payment, cash", -30],
    ]);
    expect(Number(s.lines.at(-1)!.balance)).toBe(370);
    expect(Number(s.closingBalance)).toBe(370);
    // The two halves: 400 still owed on invoices, 30 held for them.
    expect(Number(s.owedOnInvoices)).toBe(400);
    expect(Number(s.heldOnAccount)).toBe(30);
    expect(Number(s.lines[0]!.charge)).toBe(400);
    expect(Number(s.lines[2]!.credit)).toBe(150);
  });

  it("carries what came before the period into the opening balance", async () => {
    const s = await statements.statement(owner(), { id: rosa, from: daysAgo(10), to: today() });
    expect(Number(s.openingBalance)).toBe(400);
    expect(s.lines).toHaveLength(4);
    expect(Number(s.closingBalance)).toBe(370);
  });

  it("ages the open invoices by days past due", async () => {
    const s = await statements.statement(owner(), { id: rosa });
    expect(Number(s.aging.days1To30)).toBe(250);
    expect(Number(s.aging.current)).toBe(150);
    expect(s.openInvoices.map((i) => i.daysOverdue)).toEqual([15, 0]);
  });

  it("does not add a line when held money is used, because nothing owed changed", async () => {
    const before = await statements.statement(owner(), { id: rosa });
    const [held] = await raw<{ id: string }[]>`
      select id from public.payment where organization_id = ${ORG} and customer_id = ${rosa} and method = 'cash'`;
    await billing.applyPayment(owner(), { id: held!.id, allocations: [{ invoiceId: second.id, amount: "30.00" }] });
    const after = await statements.statement(owner(), { id: rosa });
    expect(after.lines).toHaveLength(before.lines.length);
    expect(after.closingBalance).toBe(before.closingBalance);
    expect(Number(after.heldOnAccount)).toBe(0);
    expect(Number(after.owedOnInvoices)).toBe(370);
  });

  it("puts an invoice on the payer's statement and not the tenant's", async () => {
    const invoice = await billing.create(owner(), {
      customerId: tenant, payerCustomerId: manager, lines: [line("900.00")],
    });
    const theirs = await statements.statement(owner(), { id: manager });
    expect(theirs.lines.map((l) => l.invoiceId)).toContain(invoice.id);
    expect(Number(theirs.closingBalance)).toBe(900);
    expect(theirs.openInvoices.map((i) => i.id)).toEqual([invoice.id]);

    const tenants = await statements.statement(owner(), { id: tenant });
    expect(tenants.lines).toHaveLength(0);
    expect(Number(tenants.closingBalance)).toBe(0);
  });

  it("refuses a period that runs past today or backwards", async () => {
    await expect(statements.statement(owner(), { id: rosa, to: daysAgo(-1) })).rejects.toBeInstanceOf(UnprocessableError);
    await expect(statements.statement(owner(), { id: rosa, from: today(), to: daysAgo(1) })).rejects.toBeInstanceOf(UnprocessableError);
  });
});
