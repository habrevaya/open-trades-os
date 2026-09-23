import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { PermissionError } from "@opentradesos/core";
import * as agreements from "../src/services/agreements";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * MAINTENANCE AGREEMENTS
 *
 * The single biggest lever on what a home services company is worth, and the
 * module most easily made decorative. Three things have to be true or it is:
 *
 *   IT GENERATES ITS OWN VISITS. A plan that includes two tune ups a year and
 *   relies on somebody remembering to book them is a plan that quietly does
 *   not get delivered, and the first anybody hears of it is at renewal.
 *
 *   BILLING AND DELIVERY ARE SEPARATE. Pay monthly, visited twice a year.
 *
 *   MONEY BILLED IS NOT MONEY EARNED. Twelve months collected up front is a
 *   liability that unwinds as visits are delivered.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ag:org");
const USER = fixtureId("ag:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Member Co", slug: "member-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Mira Member", phone: "+15125550177",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "9 Member Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  /**
   * The ledger refuses a DELETE, by a trigger, on purpose: it is append only
   * and a correction is a reversing entry rather than a removal. That is one
   * of the properties this project rests on, so a test suspends the trigger
   * for its own session rather than weakening it. Same mechanism the shared
   * teardown helper uses, and for the same reason.
   */
  await raw.unsafe("set session_replication_role = replica");
  await raw`delete from public.ledger_entry where organization_id = ${ORG}`;
  await raw.unsafe("set session_replication_role = origin");
  await raw`delete from public.deferred_revenue_entry where organization_id = ${ORG}`;
  await raw`delete from public.agreement_billing where organization_id = ${ORG}`;
  await raw`delete from public.agreement_visit where organization_id = ${ORG}`;
  await raw`delete from public.agreement where organization_id = ${ORG}`;
  await raw`delete from public.agreement_plan where organization_id = ${ORG}`;
  await raw`delete from public.invoice_line where organization_id = ${ORG}`;
  await raw`delete from public.invoice where organization_id = ${ORG}`;
  await raw`delete from public.job where organization_id = ${ORG}`;
  await raw`delete from public.domain_event where organization_id = ${ORG}`;
});

const PLAN = {
  name: "Comfort Club", price: "228.00",
  billingFrequency: "monthly" as const, termMonths: 12,
  includedVisitsPerTerm: 2,
};

const sellOne = async (over: Partial<Parameters<typeof agreements.sell>[1]> = {}) => {
  const plan = await agreements.createPlan(owner(), PLAN);
  return agreements.sell(owner(), {
    planId: plan.id, customerId, propertyId, startedOn: "2026-01-15", ...over,
  });
};

run("dates, which is most of this module", () => {
  it("clamps rather than rolling over a short month", () => {
    /**
     * An agreement sold on the 31st of January bills on the 28th of
     * February, not the 3rd of March. Rolling forward drifts the whole
     * schedule by three days every year and lands a customer's billing date
     * in a different month from the one they agreed to.
     */
    expect(agreements.addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(agreements.addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(agreements.addMonths("2026-01-15", 12)).toBe("2027-01-15");
  });

  it("spreads included visits across the term", () => {
    // "Two a year" means one in about six months and another at the end, not
    // two in the same week.
    expect(agreements.visitDueDates({ startedOn: "2026-01-15", termMonths: 12, count: 2 }))
      .toEqual(["2026-07-15", "2027-01-15"]);
  });

  it("pins seasonal visits to the months they belong in", () => {
    /**
     * A heating tune up belongs in autumn regardless of when the agreement
     * was sold. Counting forward from the sale date puts a company's heating
     * checks in July for anybody who joined in January.
     */
    expect(agreements.visitDueDates({
      startedOn: "2026-01-15", termMonths: 12, count: 2, anchorMonths: [4, 10],
    })).toEqual(["2026-04-15", "2026-10-15"]);
  });

  it("falls back to spreading when the anchors cannot fill the term", () => {
    // Owing fewer visits than the plan sold is the one answer that is wrong.
    const dates = agreements.visitDueDates({
      startedOn: "2026-01-15", termMonths: 6, count: 4, anchorMonths: [3],
    });
    expect(dates).toHaveLength(4);
  });

  it("splits the price so the instalments sum to it exactly", () => {
    /**
     * Dividing and rounding each instalment independently leaves a cent
     * unbilled on most terms, and that cent sits in deferred revenue forever
     * with nothing to release it.
     */
    const schedule = agreements.billingSchedule({
      startedOn: "2026-01-15", termMonths: 12, frequency: "monthly",
      price: { amount: 2280000n, currency: "USD" },
    });
    expect(schedule).toHaveLength(12);
    const total = schedule.reduce((n, s) => n + s.amount.amount, 0n);
    expect(total).toBe(2280000n);
    expect(schedule[1]!.dueOn).toBe("2026-02-15");
  });

  it("splits a price that does not divide evenly without losing a cent", () => {
    /**
     * 199.00 over twelve months is 16.583333 each. Rounding each instalment
     * independently bills 198.96 and leaves four cents in deferred revenue
     * that nothing will ever release. Allocation puts the odd cents on the
     * early instalments instead, and the parts sum exactly.
     */
    const schedule = agreements.billingSchedule({
      startedOn: "2026-01-15", termMonths: 12, frequency: "monthly",
      price: { amount: 1990000n, currency: "USD" },
    });
    expect(schedule).toHaveLength(12);
    expect(schedule.reduce((n, s) => n + s.amount.amount, 0n)).toBe(1990000n);
    // Not all equal: the remainder has to land somewhere, and it lands early.
    expect(schedule[0]!.amount.amount).toBeGreaterThan(schedule[11]!.amount.amount);
  });
});

run("selling one", () => {
  it("writes down every visit it owes, at the moment of sale", async () => {
    /**
     * Not on a nightly job. A term that owes nothing because a job never ran
     * is invisible until renewal, which is the failure this module exists to
     * prevent.
     */
    const agreement = await sellOne();
    // `due_on` cast to text, because the driver parses a date column into a
    // JavaScript Date and a Date is an instant rather than a calendar day.
    const visits = await raw<{ sequence: number; due_on: string; recognition_amount: string }[]>`
      select sequence, due_on::text as due_on, recognition_amount from public.agreement_visit
      where agreement_id = ${agreement.id} order by sequence`;
    expect(visits.map((v) => v.due_on)).toEqual(["2026-07-15", "2027-01-15"]);
    // Half the term price each, and the halves sum to the whole.
    expect(visits.map((v) => v.recognition_amount)).toEqual(["114.0000", "114.0000"]);
  });

  it("bills on its own schedule, not the visit schedule", async () => {
    // Pay monthly, visited twice a year. Tying the two together is the
    // obvious shortcut and breaks the moment somebody prepays annually.
    const agreement = await sellOne();
    const billing = await raw`select id from public.agreement_billing
                              where agreement_id = ${agreement.id}`;
    expect(billing).toHaveLength(12);
  });

  it("defers the whole price rather than recognising it", async () => {
    const agreement = await sellOne();
    expect(await agreements.unearned(owner())).toBe("228.0000");
    const entries = await raw`select id from public.deferred_revenue_entry
                              where agreement_id = ${agreement.id}`;
    expect(entries).toHaveLength(2);
  });

  it("defers a plan with no visits over its term too", async () => {
    /**
     * A discount-only membership would otherwise recognise a year of revenue
     * on the day it was sold, which is the exact error this module exists to
     * avoid, arriving through the one shape nobody thinks to check.
     */
    const plan = await agreements.createPlan(owner(), { ...PLAN, includedVisitsPerTerm: 0 });
    await agreements.sell(owner(), { planId: plan.id, customerId, propertyId, startedOn: "2026-01-15" });
    expect(await agreements.unearned(owner())).toBe("228.0000");
  });

  it("splits the recognition slices without losing a cent either", async () => {
    // Same argument on the delivery side: a cent lost here sits in deferred
    // revenue after the last visit has been delivered, with nothing left to
    // release it.
    const plan = await agreements.createPlan(owner(), {
      ...PLAN, name: "Odd Club", code: "odd", price: "100.00", includedVisitsPerTerm: 3,
    });
    const agreement = await agreements.sell(owner(), {
      planId: plan.id, customerId, propertyId, startedOn: "2026-01-15",
    });
    const rows = await raw<{ recognition_amount: string }[]>`
      select recognition_amount from public.agreement_visit
      where agreement_id = ${agreement.id} order by sequence`;
    const total = rows.reduce((n, r) => n + Math.round(Number(r.recognition_amount) * 10000), 0);
    expect(total).toBe(1000000);
  });

  it("freezes the price at sale", async () => {
    // Raising the plan price must not reprice existing members.
    const plan = await agreements.createPlan(owner(), PLAN);
    const agreement = await agreements.sell(owner(), {
      planId: plan.id, customerId, propertyId, startedOn: "2026-01-15",
    });
    await raw`update public.agreement_plan set price = '499.0000' where id = ${plan.id}`;
    const [row] = await raw<{ price: string }[]>`
      select price from public.agreement where id = ${agreement.id}`;
    expect(row!.price).toBe("228.0000");
  });

  it("will not sell a retired plan", async () => {
    // A retired plan keeps its existing members and takes no new ones.
    const plan = await agreements.createPlan(owner(), PLAN);
    await agreements.retirePlan(owner(), { id: plan.id });
    await expect(agreements.sell(owner(), { planId: plan.id, customerId, propertyId }))
      .rejects.toThrow(/retired/);
  });

  it("needs membership:write", async () => {
    const plan = await agreements.createPlan(owner(), PLAN);
    await expect(agreements.sell(as(["dispatcher"]), { planId: plan.id, customerId, propertyId }))
      .rejects.toThrow(PermissionError);
  });
});

run("the report that keeps a book alive", () => {
  it("lists what is owed and not yet booked", async () => {
    const agreement = await sellOne();
    const list = await agreements.owed(owner(), { through: "2027-12-31" });
    expect(list.filter((r) => r.agreementId === agreement.id)).toHaveLength(2);
  });

  it("drops one once it is booked", async () => {
    const agreement = await sellOne();
    const [first] = await agreements.owed(owner(), { through: "2027-12-31" });
    await agreements.book(owner(), { agreementVisitId: first!.visit.id });
    const after = await agreements.owed(owner(), { through: "2027-12-31" });
    expect(after.filter((r) => r.agreementId === agreement.id)).toHaveLength(1);
  });

  it("drops one that was delivered without ever being booked", async () => {
    /**
     * Which happens whenever the technician was there anyway and somebody
     * ticks it off afterwards. Found by looking at the screen: the seeded
     * member with a delivered visit still had it on the owed list, and a
     * list with permanent residents is a list people stop reading.
     */
    const agreement = await sellOne();
    const [first] = await agreements.owed(owner(), { through: "2027-12-31" });
    await agreements.deliver(owner(), { agreementVisitId: first!.visit.id });

    const after = await agreements.owed(owner(), { through: "2027-12-31" });
    expect(after.filter((r) => r.agreementId === agreement.id)).toHaveLength(1);
    expect(after.some((r) => r.visit.id === first!.visit.id)).toBe(false);
  });

  it("owes nothing once the agreement is cancelled", async () => {
    const agreement = await sellOne();
    await agreements.cancel(owner(), { id: agreement.id, reason: "Sold the house" });
    const after = await agreements.owed(owner(), { through: "2027-12-31" });
    expect(after.filter((r) => r.agreementId === agreement.id)).toHaveLength(0);
  });
});

run("delivering it", () => {
  it("makes a job the visit points at, worth nothing", async () => {
    /**
     * Zero, deliberately. The customer has already been billed for this
     * under the agreement, so putting the plan price on the job would bill
     * them twice and overstate the month.
     */
    const agreement = await sellOne();
    const [first] = await agreements.owed(owner(), { through: "2027-12-31" });
    const { job } = await agreements.book(owner(), { agreementVisitId: first!.visit.id });
    expect(job.total).toBe("0.0000");
    expect(job.customerId).toBe(customerId);
    const [visit] = await raw<{ job_id: string }[]>`
      select job_id from public.agreement_visit where id = ${first!.visit.id}`;
    expect(visit!.job_id).toBe(job.id);
    expect(agreement.id).toBeTruthy();
  });

  it("will not book the same obligation twice", async () => {
    // Two people working the owed list at the same moment.
    await sellOne();
    const [first] = await agreements.owed(owner(), { through: "2027-12-31" });
    await agreements.book(owner(), { agreementVisitId: first!.visit.id });
    await expect(agreements.book(owner(), { agreementVisitId: first!.visit.id }))
      .rejects.toThrow(ConflictError);
  });

  it("refuses to book one that was booked out from under it", async () => {
    /**
     * Driven by setting the row rather than by racing two calls, because a
     * race is only a test when it loses. The claim is the only decision, so
     * a visit already carrying a job is refused by the update rather than by
     * a read repeating the same condition.
     */
    await sellOne();
    const [first] = await agreements.owed(owner(), { through: "2027-12-31" });
    const { job } = await agreements.book(owner(), { agreementVisitId: first!.visit.id });

    const [second] = await agreements.owed(owner(), { through: "2027-12-31" });
    await raw`update public.agreement_visit set job_id = ${job.id} where id = ${second!.visit.id}`;
    await expect(agreements.book(owner(), { agreementVisitId: second!.visit.id }))
      .rejects.toThrow(/already booked/);
  });

  it("refuses to book one somebody skipped", async () => {
    // A skipped visit is a customer who declined, which is data rather than
    // noise: booking it anyway re-offers something they already refused.
    await sellOne();
    const [first] = await agreements.owed(owner(), { through: "2027-12-31" });
    await raw`update public.agreement_visit set skipped_on = current_date,
              skip_reason = 'Customer declined' where id = ${first!.visit.id}`;
    await expect(agreements.book(owner(), { agreementVisitId: first!.visit.id }))
      .rejects.toThrow(/skipped/);
  });

  it("turns liability into revenue when the visit is delivered", async () => {
    /**
     * The whole point. Liability down, revenue up, by exactly the slice this
     * visit was allocated at sale. Recomputing it after a price change would
     * recognise an amount that was never deferred.
     */
    await sellOne();
    const [first] = await agreements.owed(owner(), { through: "2027-12-31" });
    const result = await agreements.deliver(owner(), { agreementVisitId: first!.visit.id, on: "2026-07-15" });

    expect(result.recognized).toBe("114.0000");
    expect(await agreements.unearned(owner())).toBe("114.0000");

    const entries = await raw<{ direction: string; account_code: string; amount: string }[]>`
      select direction, account_code, amount from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'agreement_recognition'`;
    expect(entries).toHaveLength(2);
    // 2400 is deferred revenue, a liability. It goes down.
    expect(entries.find((e) => e.direction === "debit")!.account_code).toBe("2400");
    expect(entries.find((e) => e.direction === "credit")!.account_code).toBe("4100");
  });

  it("will not recognise the same visit twice", async () => {
    // Delivering twice would be revenue out of thin air.
    await sellOne();
    const [first] = await agreements.owed(owner(), { through: "2027-12-31" });
    await agreements.deliver(owner(), { agreementVisitId: first!.visit.id });
    await expect(agreements.deliver(owner(), { agreementVisitId: first!.visit.id }))
      .rejects.toThrow(/already delivered/);
    expect(await agreements.unearned(owner())).toBe("114.0000");
  });
});

run("billing it", () => {
  it("invoices an instalment as a liability rather than as revenue", async () => {
    /**
     * A plain invoice here would recognise a year of revenue on the day the
     * customer paid, which is the single most common way this module is got
     * wrong in the products contractors already use.
     */
    const agreement = await sellOne();
    const [first] = await raw<{ id: string }[]>`
      select id from public.agreement_billing where agreement_id = ${agreement.id} order by sequence limit 1`;
    const invoice = await agreements.bill(owner(), { agreementBillingId: first!.id });

    expect(invoice.total).toBe("19.0000");
    const entries = await raw<{ direction: string; account_code: string }[]>`
      select direction, account_code from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'agreement_billing'`;
    // Receivable up, deferred revenue up. No revenue account touched.
    expect(entries.find((e) => e.direction === "debit")!.account_code).toBe("1200");
    expect(entries.find((e) => e.direction === "credit")!.account_code).toBe("2400");
    expect(entries.some((e) => e.account_code === "4000")).toBe(false);
  });

  it("will not invoice the same instalment twice", async () => {
    const agreement = await sellOne();
    const [first] = await raw<{ id: string }[]>`
      select id from public.agreement_billing where agreement_id = ${agreement.id} order by sequence limit 1`;
    await agreements.bill(owner(), { agreementBillingId: first!.id });
    await expect(agreements.bill(owner(), { agreementBillingId: first!.id }))
      .rejects.toThrow(/already invoiced/);
  });
});

run("cancelling it", () => {
  it("releases what has not been earned", async () => {
    /**
     * Leaving the balance sitting in deferred revenue forever, which is what
     * doing nothing amounts to, is the one answer that is wrong either way.
     */
    const agreement = await sellOne();
    const [first] = await agreements.owed(owner(), { through: "2027-12-31" });
    await agreements.deliver(owner(), { agreementVisitId: first!.visit.id });

    const result = await agreements.cancel(owner(), { id: agreement.id, reason: "Sold the house" });
    expect(result.released).toBe("114.0000");
    expect(await agreements.unearned(owner())).toBe("0.0000");

    const entries = await raw<{ direction: string; account_code: string }[]>`
      select direction, account_code from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'deferred_release'`;
    // Refunded by default: the liability goes and the customer is credited.
    expect(entries.find((e) => e.direction === "credit")!.account_code).toBe("1200");
  });

  it("recognises the balance instead when the company keeps the prepayment", async () => {
    // A policy decision rather than a technical one, so it is a parameter
    // rather than a default the accountant has to discover.
    const agreement = await sellOne();
    await agreements.cancel(owner(), {
      id: agreement.id, reason: "Non payment", keepThePrepayment: true,
    });
    const entries = await raw<{ direction: string; account_code: string }[]>`
      select direction, account_code from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'deferred_release'`;
    expect(entries.find((e) => e.direction === "credit")!.account_code).toBe("4100");
  });

  it("cancels the instalments nobody has invoiced yet, and leaves the ones they have", async () => {
    // An invoiced instalment stands: the customer owes it, and voiding an
    // issued invoice is a different decision made on the invoice.
    const agreement = await sellOne();
    const [first] = await raw<{ id: string }[]>`
      select id from public.agreement_billing where agreement_id = ${agreement.id} order by sequence limit 1`;
    await agreements.bill(owner(), { agreementBillingId: first!.id });
    await agreements.cancel(owner(), { id: agreement.id, reason: "Moved away" });

    const rows = await raw<{ status: string }[]>`
      select status from public.agreement_billing where agreement_id = ${agreement.id} order by sequence`;
    expect(rows[0]!.status).toBe("invoiced");
    expect(rows.slice(1).every((r) => r.status === "cancelled")).toBe(true);
  });

  it("refuses a cancellation with no reason", async () => {
    // The reason is the whole of a win-back campaign, and a cancellation
    // without one is indistinguishable from a mistake.
    const agreement = await sellOne();
    await expect(agreements.cancel(owner(), { id: agreement.id, reason: "  " }))
      .rejects.toThrow(/needs a reason/);
  });

  it("does not release twice", async () => {
    const agreement = await sellOne();
    await agreements.cancel(owner(), { id: agreement.id, reason: "Sold the house" });
    await expect(agreements.cancel(owner(), { id: agreement.id, reason: "Again" }))
      .rejects.toThrow(/already cancelled/);
  });
});
