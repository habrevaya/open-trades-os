import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as commissions from "../src/services/commissions";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import { backgroundHooks } from "../src/services/worker-hooks";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * M17. A COMMISSION SETTLES BY ITSELF WHEN ITS INVOICE IS PAID IN FULL
 *
 * Off unless the company turns it on. Then the worker settles each invoice
 * paid in full under the one plan in force that pays on what was collected,
 * with the split proposed, exactly as "Settle the ticked ones as proposed"
 * would, and leaves the ones a person has to decide with why. Real jobs,
 * real invoices, real payments.
 *
 *   An invoice of 1,000.00 under ten per cent of what was collected earns 100.00.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("commission-on-payment:org");
const USER = fixtureId("commission-on-payment:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);
const pass = () => commissions.settleOnPaymentFor(db(), ORG);

let ray = "";
let dana = "";
let customerId = "";
let propertyId = "";

async function technician(name: string): Promise<string> {
  const [membership] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [row] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, ${name}) returning id`;
  return row!.id;
}

async function invoiceFor(total: string, technicianIds: string[]): Promise<string> {
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "Changeout", tags: [], customFields: {},
    visit: {
      windowStart: "2026-02-03T14:00:00.000Z", windowEnd: "2026-02-03T18:00:00.000Z",
      estimatedDurationMinutes: 240, technicianIds,
    },
  });
  const invoice = await billing.create(owner(), {
    customerId, jobId: job.id as string,
    lines: [{ name: "Condenser", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  return invoice.id as string;
}

const pay = (invoiceId: string, amount: string) => billing.pay(owner(), {
  customerId, method: "check", amount, tipAmount: "0", allocations: [{ invoiceId, amount }],
});

const earningsOn = (invoiceId: string) => raw<{ id: string; total: string; standing_note: string | null; split_note: string | null }[]>`
  select id, total::text, standing_note, split_note from public.commission_event where invoice_id = ${invoiceId}`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Commission On Payment Co", slug: "commission-on-payment-co" });
  ray = await technician("Ray Nunez");
  dana = await technician("Dana Pike");
  const created = await customers.create(owner(), {
    type: "residential", name: "Okafor", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: "3 Pine St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
  });
  customerId = created.id as string;
  const [prop] = await raw`select id from public.property where organization_id = ${ORG}`;
  propertyId = (prop as { id: string }).id;
});
afterAll(async () => { if (raw) await raw.end(); });
beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.commission_on_payment where organization_id = ${ORG}`;
  await raw`delete from public.commission_entry where organization_id = ${ORG}`;
  await raw`delete from public.commission_reversal where organization_id = ${ORG}`;
  await raw`delete from public.commission_event where organization_id = ${ORG}`;
  await raw`delete from public.commission_plan where organization_id = ${ORG}`;
  await raw`delete from public.commission_standing_share where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'commission' where id = ${ORG}`;
  /** Every test starts with the log read to its end, as a company that has had the worker all along. */
  await pass();
  await commissions.declarePlan(owner(), {
    label: "Ten per cent collected", basis: "percent_of_collected", rate: "0.10",
    note: "Ten per cent of what the customer paid, net of tax.",
  });
});

run("settling a commission by itself when its invoice is paid in full", () => {
  it("is off by default and settles nothing", async () => {
    expect((await commissions.onPayment(owner())).on).toBe(false);
    const invoiceId = await invoiceFor("1000.00", [dana, ray]);
    await pay(invoiceId, "1000.00");
    expect(await pass()).toMatchObject({ settled: [], left: [] });
    expect(await earningsOn(invoiceId)).toEqual([]);
  });

  it("settles with the proposed split exactly as settling it as proposed would, audited as the system", async () => {
    await commissions.setStandingShare(owner(), { technicianId: ray, percent: 25, applies: "always", reason: "Sells it" });
    const view = await commissions.setOnPayment(owner(), { on: true });
    expect(view.on).toBe(true);
    expect(view.earnsOnPayment.map((p) => p.label)).toEqual(["Ten per cent collected"]);

    const invoiceId = await invoiceFor("1000.00", [dana, ray]);
    await pay(invoiceId, "400.00");
    expect((await pass()).settled).toEqual([]);

    await pay(invoiceId, "600.00");
    const done = await pass();
    expect(done.settled.map((s) => s.invoiceId)).toEqual([invoiceId]);
    const [earning] = await earningsOn(invoiceId);
    expect(earning!.total).toBe("100.0000");
    expect(earning!.standing_note).toContain("Ray Nunez takes 25%");
    expect(earning!.split_note).toBeNull();

    /** The same parts, weights and words as one settled by a person as proposed. */
    const alone = await invoiceFor("1000.00", [dana, ray]);
    await commissions.setOnPayment(owner(), { on: false });
    await pay(alone, "1000.00");
    await pass();
    const byHand = await commissions.settleProposed(owner(), { invoiceIds: [alone] });
    const parts = async (eventId: string) => raw<{ technician_id: string; amount: string; weight: string; explanation: string }[]>`
      select technician_id, amount::text, weight::text, explanation from public.commission_entry where event_id = ${eventId} order by share_index`;
    /** Each names its own invoice, and nothing else differs. */
    const shaped = (rows: Awaited<ReturnType<typeof parts>>, id: string) =>
      rows.map((p) => [p.technician_id, p.amount, p.weight, p.explanation.replace(id, "INVOICE")]);
    expect(shaped(await parts(earning!.id), invoiceId))
      .toEqual(shaped(await parts(byHand.settled[0]!.eventId!), alone));

    /** Posted to the ledger, and audited with no user, by the worker, with the proposal unchanged. */
    const [posted] = await raw<{ ledger_transaction_id: string | null }[]>`select ledger_transaction_id from public.commission_event where id = ${earning!.id}`;
    expect(posted!.ledger_transaction_id).not.toBeNull();
    const audits = await raw<{ action: string; actor_user_id: string | null; actor_agent_id: string | null; after: { changed?: boolean } }[]>`
      select action, actor_user_id, actor_agent_id, after from public.audit_log
      where organization_id = ${ORG} and entity_id in (${earning!.id}, (select id from public.commission_on_payment where invoice_id = ${invoiceId}))
      order by created_at`;
    expect(audits.map((a) => [a.action, a.actor_user_id, a.actor_agent_id])).toEqual([
      ["commission.earned", null, "commission-on-payment"],
      ["commission_on_payment.settled", null, "commission-on-payment"],
    ]);
    expect(audits[0]!.after.changed).toBe(false);

    const shown = await commissions.onPayment(owner());
    expect(shown.settled.map((s) => [s.invoiceId, s.total])).toEqual([[invoiceId, "100.0000"]]);
  });

  it("never settles twice: a second pass, a second worker and one settled by a person are all passed over", async () => {
    await commissions.setOnPayment(owner(), { on: true });
    const first = await invoiceFor("1000.00", [dana, ray]);
    const byPerson = await invoiceFor("500.00", [dana, ray]);
    await pay(byPerson, "500.00");
    await commissions.settleSplit(owner(), {
      invoiceId: byPerson, shares: [{ technicianId: ray, weight: "2" }, { technicianId: dana, weight: "1" }], reason: "Ray sold it.",
    });
    await pay(first, "1000.00");
    /** Two workers reading the same events at once. */
    const [a, b] = await Promise.all([pass(), pass()]);
    expect([...a.settled, ...b.settled].map((s) => s.invoiceId)).toEqual([first]);
    expect(await pass()).toMatchObject({ settled: [], left: [] });
    expect(await earningsOn(first)).toHaveLength(1);
    const [kept] = await earningsOn(byPerson);
    expect(kept!.split_note).toBe("Ray sold it.");
  });

  it("leaves for a person, with why, what it cannot settle, and drops it from the list once a person does", async () => {
    await commissions.setOnPayment(owner(), { on: true });
    /** Standing shares that cannot all be honoured. */
    await commissions.setStandingShare(owner(), { technicianId: ray, percent: 60, applies: "always", reason: "Sells it" });
    await commissions.setStandingShare(owner(), { technicianId: dana, percent: 50, applies: "always", reason: "Leads it" });
    const conflicted = await invoiceFor("1000.00", [dana, ray]);
    await pay(conflicted, "1000.00");
    const done = await pass();
    expect(done.settled).toEqual([]);
    expect(done.left).toEqual([{
      invoiceId: conflicted,
      reason: "The standing shares on this job cannot all be honoured, so how it is shared is for a person to decide.",
    }]);
    expect(await earningsOn(conflicted)).toEqual([]);

    const view = await commissions.onPayment(owner());
    expect(view.left.map((l) => [l.invoiceId, l.reason])).toEqual([[conflicted, done.left[0]!.reason]]);

    await commissions.settleSplit(owner(), {
      invoiceId: conflicted, shares: [{ technicianId: ray, weight: "60" }, { technicianId: dana, weight: "40" }], reason: "Ray sold it.",
    });
    expect((await commissions.onPayment(owner())).left).toEqual([]);
  });

  it("leaves it when two plans are in force, in the words settling refuses with", async () => {
    await commissions.setOnPayment(owner(), { on: true });
    await commissions.declarePlan(owner(), {
      label: "Installs, five per cent", basis: "percent_of_revenue", rate: "0.05", note: "Five per cent on installs.",
    });
    const invoiceId = await invoiceFor("1000.00", [dana]);
    await pay(invoiceId, "1000.00");
    const done = await pass();
    expect(done.left.map((l) => l.reason)).toEqual([
      "2 commission plans are in force (Installs, five per cent, Ten per cent collected). Which one this invoice is under is for a person to say.",
    ]);
  });

  it("leaves it when nobody is on the job's visits", async () => {
    await commissions.setOnPayment(owner(), { on: true });
    const invoiceId = await invoiceFor("1000.00", [dana]);
    await raw`delete from public.visit_assignment where technician_id = ${dana} and visit_id in (select id from public.visit where job_id = (select job_id from public.invoice where id = ${invoiceId}))`;
    await pay(invoiceId, "1000.00");
    const done = await pass();
    expect(done.left.map((l) => l.reason)).toEqual(["Nobody is on this job's visits, so there is no split to propose. Name who it is for."]);
  });

  it("leaves one settling refuses, in settling's own words", async () => {
    await commissions.setOnPayment(owner(), { on: true });
    /** A plan that lost its note: core refuses to work out a commission under it, whoever presses the button. */
    await raw`update public.commission_plan set note = '' where organization_id = ${ORG}`;
    const invoiceId = await invoiceFor("1000.00", [dana]);
    await pay(invoiceId, "1000.00");
    const done = await pass();
    expect(done.left.map((l) => l.reason)).toEqual([
      "This commission plan has no note on it. The note is what a technician is shown when they ask how the number was worked out.",
    ]);
    expect(await earningsOn(invoiceId)).toEqual([]);
  });

  it("does nothing for a plan that earns when the work is invoiced", async () => {
    await raw`update public.commission_plan set active = false where organization_id = ${ORG}`;
    await commissions.declarePlan(owner(), {
      label: "Eight per cent", basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of what the job invoiced for.",
    });
    await commissions.setOnPayment(owner(), { on: true });
    expect((await commissions.onPayment(owner())).earnsOnPayment).toEqual([]);
    const invoiceId = await invoiceFor("1000.00", [dana, ray]);
    await pay(invoiceId, "1000.00");
    expect(await pass()).toMatchObject({ settled: [], left: [] });
    expect(await earningsOn(invoiceId)).toEqual([]);
  });

  it("settles only invoices paid in full after it was turned on", async () => {
    const before = await invoiceFor("1000.00", [dana]);
    await pay(before, "1000.00");
    /** The worker came round while it was off. */
    await pass();
    await commissions.setOnPayment(owner(), { on: true });
    const after = await invoiceFor("300.00", [dana]);
    await pay(after, "300.00");
    expect((await pass()).settled.map((s) => s.invoiceId)).toEqual([after]);
    expect(await earningsOn(before)).toEqual([]);
  });

  it("a refund afterwards is what it is for a person's earning: nothing reverses by itself, and paying again settles nothing twice", async () => {
    await commissions.setOnPayment(owner(), { on: true });
    const invoiceId = await invoiceFor("1000.00", [dana, ray]);
    const payment = await pay(invoiceId, "1000.00");
    await pass();
    await billing.recordRefund(owner(), { id: payment.id as string, amount: "200.00", method: "check", reason: "Part undone" });
    const reversals = () => raw`select id from public.commission_reversal where organization_id = ${ORG}`;
    expect(await reversals()).toHaveLength(0);
    await commissions.reverse(owner(), {
      invoiceId, reason: "refund", creditedRevenue: "200.00", causeType: "payment.refunded", causeId: payment.id as string,
    });
    expect(await reversals()).toHaveLength(1);
    await pay(invoiceId, "200.00");
    expect(await pass()).toMatchObject({ settled: [], left: [] });
    expect(await earningsOn(invoiceId)).toHaveLength(1);
  });

  it("runs from the worker's hook after a drain", async () => {
    await commissions.setOnPayment(owner(), { on: true });
    const invoiceId = await invoiceFor("1000.00", [dana]);
    await pay(invoiceId, "1000.00");
    await backgroundHooks(db())(ORG);
    expect(await earningsOn(invoiceId)).toHaveLength(1);
  });

  it("keeps the item rule when it is turned on, and the other way round", async () => {
    await commissions.setItemRule(owner(), { rule: "higher" });
    await commissions.setOnPayment(owner(), { on: true });
    expect((await commissions.itemRule(owner())).rule).toBe("higher");
    await commissions.setItemRule(owner(), { rule: "item_wins" });
    expect((await commissions.onPayment(owner())).on).toBe(true);
  });

  it("is turned on only by somebody who may settle commission, and read by anybody who reads it", async () => {
    await expect(commissions.setOnPayment(as(["office_manager"]), { on: true })).rejects.toThrow();
    await expect(commissions.onPayment(as(["dispatcher"]))).rejects.toThrow();
    expect((await commissions.onPayment(as(["accountant"]))).on).toBe(false);
    const audits = await raw`select id from public.audit_log where organization_id = ${ORG} and action = 'commission_on_payment.set'`;
    await commissions.setOnPayment(owner(), { on: true });
    await commissions.setOnPayment(owner(), { on: true });
    const after = await raw`select id from public.audit_log where organization_id = ${ORG} and action = 'commission_on_payment.set'`;
    expect(after.length - audits.length).toBe(1);
  });
});
