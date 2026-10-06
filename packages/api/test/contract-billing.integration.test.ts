import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { contractBilling as cb, money as m, recurrence, PermissionError, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as contracts from "../src/services/contracts";
import * as contractBilling from "../src/services/contract-billing";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A CONTRACT BILLED ON A SCHEDULE
 *
 * A fixed fee every month, raised by the worker on the billing day whether or
 * not anybody visited. These tests raise periods the way the worker does and
 * the way the button does, and hold the four things that cost money when they
 * go wrong: a period billed twice, a period billed while the contract was
 * paused, a part period charged whole when the contract says prorate, and
 * revenue posted anywhere but where an invoice posts it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cbill:org");
const USER = fixtureId("cbill:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});
const owner = () => as(["owner"]);

let clientId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Fixed Fee Co", slug: "fixed-fee-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  clientId = (await customers.create(owner(), {
    type: "commercial", name: "Meridian Facilities", phone: "+15125550700",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  })).id;
});

/** The first of the month `back` months before this one, in the company's calendar. */
const firstOf = (back: number) => recurrence.addMonths(`${companyToday().slice(0, 8)}01`, -back);

async function contractFrom(startsOn: string, extra: Partial<Parameters<typeof contracts.createContract>[1]> = {}) {
  return contracts.createContract(owner(), {
    customerId: clientId, name: "Meridian planned maintenance", startsOn, purchaseOrderNumber: "PO-7781", ...extra,
  });
}

/** The periods the core arithmetic says are owed today, for the expectations. */
const owedBy = (schedule: cb.Schedule) => cb.periodsThrough(schedule, companyToday(), 500);

async function invoicesOf() {
  return raw<{ id: string; total: string; due_on: string | null; issued_on: string; purchase_order_number: string | null; customer_id: string; tax_total: string }[]>`
    select id, total::text, due_on::text, issued_on::text, purchase_order_number, customer_id, tax_total::text
    from public.invoice where organization_id = ${ORG} order by number`;
}

async function periodsOf(contractId: string) {
  return raw<{ period_start: string; period_end: string; status: string; amount: string; invoice_id: string | null }[]>`
    select period_start::text, period_end::text, status::text, amount::text, invoice_id
    from public.contract_billing_period where contract_id = ${contractId} order by period_start`;
}

run("a contract billed on a schedule", () => {
  it("raises each owed month once, to the contract's customer, on their terms, with the contract's PO", async () => {
    const contract = await contractFrom(firstOf(2));
    const set = await contractBilling.set(owner(), {
      contractId: contract.id, amount: "1200.00", frequency: "monthly", billingDay: 1,
      description: "Planned maintenance, both sites",
    });
    expect(set.schedule).toMatchObject({ startsOn: firstOf(2), state: "active", lastDay: null });
    expect(set.due).toBe(3);
    expect(set.next?.billOn).toBe(firstOf(-1));

    /** The worker's pass, twice, and the button: three periods, three invoices. */
    const first = await contractBilling.billingFor(db(), ORG);
    expect(first.error).toBeNull();
    expect(first.raised.map((r) => r.periodStart)).toEqual([firstOf(2), firstOf(1), firstOf(0)]);
    expect((await contractBilling.billingFor(db(), ORG)).raised).toEqual([]);
    expect((await contractBilling.raiseDue(owner(), { contractId: contract.id })).raised).toEqual([]);

    const invoices = await invoicesOf();
    expect(invoices).toHaveLength(3);
    for (const invoice of invoices) {
      expect(invoice).toMatchObject({
        total: "1200.0000", customer_id: clientId, purchase_order_number: "PO-7781", issued_on: companyToday(), tax_total: "0.0000",
      });
      expect(invoice.due_on).toBe(recurrence.addDays(companyToday(), 30));
    }
    const lines = await raw<{ name: string; description: string; price_authority: string; price_basis: string }[]>`
      select name, description, price_authority, price_basis from public.invoice_line
      where organization_id = ${ORG} order by created_at`;
    expect(lines[0]).toMatchObject({ name: "Planned maintenance, both sites", price_authority: "contract", price_basis: "contract_fee" });
    expect(lines[0]!.description).toBe(cb.periodWords(firstOf(2), recurrence.addDays(firstOf(1), -1)));

    const view = await contractBilling.view(owner(), { contractId: contract.id });
    expect(view.due).toBe(0);
    expect(view.periods.map((p) => [p.start, p.status])).toEqual([
      [firstOf(0), "invoiced"], [firstOf(1), "invoiced"], [firstOf(2), "invoiced"],
    ]);
    expect(view.periods.every((p) => p.invoiceNumber !== null)).toBe(true);
  });

  it("posts revenue the way any invoice does, and nothing to deferred revenue", async () => {
    const contract = await contractFrom(firstOf(0));
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "500.00", frequency: "monthly", billingDay: 1, description: "Fee",
    });
    await contractBilling.raiseDue(owner(), { contractId: contract.id });
    const entries = await raw<{ account_code: string; direction: string; amount: string }[]>`
      select account_code, direction::text, sum(amount)::text as amount from public.ledger_entry
      where organization_id = ${ORG} group by account_code, direction order by account_code`;
    expect(entries).toEqual([
      { account_code: "1200", direction: "debit", amount: "500.0000" },
      { account_code: "4000", direction: "credit", amount: "500.0000" },
    ]);
  });

  it("bills a part first month whole, unless the contract says prorate, and then its share by day", async () => {
    const start = recurrence.addDays(firstOf(1), 14);
    const contract = await contractFrom(start);
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "1200.00", frequency: "monthly", billingDay: 1, description: "Fee", prorate: true,
    });
    await contractBilling.raiseDue(owner(), { contractId: contract.id });
    const expected = owedBy({
      amount: m.money("1200.00"), frequency: "monthly", billingDay: 1, startsOn: start, endsOn: null, prorate: true,
    });
    expect(expected[0]!.prorated).toBe(true);
    const periods = await periodsOf(contract.id);
    expect(periods.map((p) => [p.period_start, p.amount])).toEqual(expected.map((p) => [p.start, m.toString(p.amount)]));
    expect((await invoicesOf()).map((i) => i.total)).toEqual(expected.map((p) => m.toString(p.amount)));

    /** The same contract not prorating bills the part month whole. */
    const whole = await contractFrom(start, { name: "Whole months" });
    await contractBilling.set(owner(), {
      contractId: whole.id, amount: "1200.00", frequency: "monthly", billingDay: 1, description: "Fee",
    });
    await contractBilling.raiseDue(owner(), { contractId: whole.id });
    expect((await periodsOf(whole.id)).map((p) => p.amount)).toEqual(expected.map(() => "1200.0000"));
  });

  it("raises nothing while paused, and skips the months it was paused for when it is resumed", async () => {
    const contract = await contractFrom(firstOf(3));
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "300.00", frequency: "monthly", billingDay: 1, description: "Fee",
    });
    const paused = await contractBilling.pause(owner(), { contractId: contract.id });
    expect(paused.schedule?.state).toBe("paused");
    expect(paused.standing).toMatch(/Paused since/);
    expect((await contractBilling.billingFor(db(), ORG)).raised).toEqual([]);

    /** Paused from the first of two months back, as if it had been since then. */
    await raw`update public.contract_billing_schedule set paused_on = ${firstOf(2)} where contract_id = ${contract.id}`;
    await contractBilling.resume(owner(), { contractId: contract.id });
    await contractBilling.raiseDue(owner(), { contractId: contract.id });

    const today = companyToday();
    const periods = await periodsOf(contract.id);
    const expected = owedBy({
      amount: m.money("300.00"), frequency: "monthly", billingDay: 1, startsOn: firstOf(3), endsOn: null, prorate: false,
    }).map((p) => [p.start, p.billOn >= firstOf(2) && p.billOn < today ? "skipped" : "invoiced"]);
    expect(periods.map((p) => [p.period_start, p.status])).toEqual(expected);
    /** The month owed from before the pause is billed; the paused ones never are. */
    expect(periods[0]).toMatchObject({ period_start: firstOf(3), status: "invoiced" });
    expect(periods.filter((p) => p.status === "skipped").every((p) => p.invoice_id === null)).toBe(true);
    expect(await invoicesOf()).toHaveLength(expected.filter(([, s]) => s === "invoiced").length);
  });

  it("bills up to the last day it was ended on and nothing after, cut and prorated", async () => {
    const contract = await contractFrom(firstOf(2));
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "1240.00", frequency: "monthly", billingDay: 1, description: "Fee", prorate: true,
    });
    const lastDay = recurrence.addDays(firstOf(1), 9);
    const ended = await contractBilling.end(owner(), { contractId: contract.id, lastDay });
    expect(ended.schedule).toMatchObject({ state: "ended", lastDay });
    await contractBilling.raiseDue(owner(), { contractId: contract.id });
    const periods = await periodsOf(contract.id);
    expect(periods.map((p) => [p.period_start, p.period_end])).toEqual([
      [firstOf(2), recurrence.addDays(firstOf(1), -1)],
      [firstOf(1), lastDay],
    ]);
    const days = cb.daysBetween(firstOf(1), recurrence.addDays(firstOf(0), -1));
    expect(periods[1]!.amount).toBe(m.toString(cb.prorate(m.money("1240.00"), 10, days)));
    expect((await contractBilling.view(owner(), { contractId: contract.id })).next).toBeNull();
  });

  it("starts a changed pattern the day after the last period billed, so no day is billed twice", async () => {
    const contract = await contractFrom(firstOf(1));
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "1000.00", frequency: "monthly", billingDay: 1, description: "Fee",
    });
    await contractBilling.raiseDue(owner(), { contractId: contract.id });
    const changed = await contractBilling.set(owner(), {
      contractId: contract.id, amount: "1000.00", frequency: "monthly", billingDay: 15, startsOn: firstOf(1), description: "Fee",
    });
    expect(changed.schedule?.startsOn).toBe(firstOf(-1));

    await expect(contractBilling.set(owner(), {
      contractId: contract.id, amount: "1000.00", frequency: "monthly", billingDay: 15, startsOn: firstOf(1), description: "Fee",
    })).rejects.toThrow(/billed up to/);
  });

  it("refuses what a schedule cannot say, and who may not set or raise it", async () => {
    const contract = await contractFrom(firstOf(0));
    await expect(contractBilling.set(owner(), {
      contractId: contract.id, amount: "0", frequency: "monthly", billingDay: 1, description: "Fee",
    })).rejects.toBeInstanceOf(ConflictError);
    await expect(contractBilling.set(owner(), {
      contractId: contract.id, amount: "100.00", frequency: "monthly", billingDay: 30, description: "Fee",
    })).rejects.toThrow(/1 to 28/);
    await expect(contractBilling.pause(owner(), { contractId: contract.id })).rejects.toThrow(/not billed on a schedule/);
    await expect(contractBilling.set(as(["technician"]), {
      contractId: contract.id, amount: "100.00", frequency: "monthly", billingDay: 1, description: "Fee",
    })).rejects.toBeInstanceOf(PermissionError);
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "100.00", frequency: "monthly", billingDay: 1, description: "Fee",
    });
    await expect(contractBilling.raiseDue(as(["dispatcher"]), { contractId: contract.id })).rejects.toBeInstanceOf(PermissionError);
    expect(await invoicesOf()).toHaveLength(0);
  });

  it("is found by the worker's own pass, which asks the database which companies to visit", async () => {
    const contract = await contractFrom(firstOf(0));
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "100.00", frequency: "monthly", billingDay: 1, description: "Fee",
    });
    const mine = (await contractBilling.billingPass(db(), { force: true, limit: 10_000 }))
      .filter((r) => r.organizationId === ORG);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.raised.map((r) => r.periodStart)).toEqual([firstOf(0)]);
    /** Paused, the company is not visited at all. */
    await contractBilling.pause(owner(), { contractId: contract.id });
    expect((await contractBilling.billingPass(db(), { force: true, limit: 10_000 })).filter((r) => r.organizationId === ORG)).toEqual([]);
  });

  it("raises nothing on a contract switched off", async () => {
    const contract = await contractFrom(firstOf(1));
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "100.00", frequency: "monthly", billingDay: 1, description: "Fee",
    });
    await contracts.updateContract(owner(), { id: contract.id, active: false });
    expect((await contractBilling.raiseDue(owner(), { contractId: contract.id })).raised).toEqual([]);
    expect((await contractBilling.view(owner(), { contractId: contract.id })).standing).toMatch(/switched off/);
  });
});
