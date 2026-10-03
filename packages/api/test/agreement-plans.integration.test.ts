import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { PermissionError } from "@opentradesos/core";
import * as agreements from "../src/services/agreements";
import * as estimates from "../src/services/estimates";
import * as billing from "../src/services/billing";
import * as priceBook from "../src/services/pricebook";
import * as dispatch from "../src/services/dispatch";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A PLAN THAT CAN BE EDITED, AND THE BOOK ON THE API
 *
 * Plans could be defined and not changed, the book could be worked on the
 * screens and not over the API, and three of the perks every plan carried
 * (priority dispatch, a waived diagnostic fee, a waived after hours rate)
 * were recorded and applied by nothing. Each of those is a promise a company
 * makes to its members, so each is tested as the promise it is:
 *
 *   an edit reaches who it says it reaches, and a member's discount is the
 *   one they bought, not whatever the plan says this week;
 *
 *   a retry of a booking, a delivery, a bill or a cancellation over the API
 *   is the first call answered again, never a second job or invoice;
 *
 *   a member whose plan waives the diagnostic fee does not pay it, and one
 *   whose plan promised priority is first on the board.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("plans:org");
const USER = fixtureId("plans:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(), ...extra,
});
const owner = () => as(["owner"]);
const keyed = (key: string) => as(["owner"], { idempotencyKey: key });

let customerId = "";
let propertyId = "";
let otherPropertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Plan Co", slug: "plan-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  const [c] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Mira Member') returning id`;
  customerId = c!.id;
  for (const line of ["9 Member Way", "12 Rental Rd"]) {
    const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, ${line}, 'Austin', 'TX', '78701') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id)
      values (${ORG}, ${customerId}, ${p!.id})`;
    if (!propertyId) propertyId = p!.id; else otherPropertyId = p!.id;
  }
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw.unsafe("set session_replication_role = replica");
  for (const table of [
    "ledger_entry", "deferred_revenue_entry", "agreement_billing", "agreement_visit", "agreement",
    "agreement_plan", "invoice_line", "invoice", "estimate_line", "estimate_option", "estimate",
    "entitlement", "visit_assignment", "visit", "job", "domain_event", "integration_event",
    "price_book_item_version", "price_book_item",
  ]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
  await raw.unsafe("set session_replication_role = origin");
});

const PLAN = {
  name: "Comfort Club", price: "240.00", billingFrequency: "annual" as const,
  termMonths: 12, includedVisitsPerTerm: 2, discountRate: "0.15",
};

const sell = async (planId: string, over: Partial<Parameters<typeof agreements.sell>[1]> = {}) =>
  agreements.sell(owner(), { planId, customerId, propertyId, startedOn: "2026-01-15", ...over });

const pricedOn = async () => {
  const written = await estimates.create(owner(), {
    customerId, propertyId, taxRate: "0",
    options: [{
      name: "Repair", isRecommended: false,
      lines: [{ name: "Igniter", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }],
    }],
  });
  return written.options[0]!.lines[0]!;
};

run("editing a plan", () => {
  it("changes what it says, and keeps the price and the discount each member bought", async () => {
    const plan = await agreements.createPlan(owner(), PLAN);
    const sold = await sell(plan.id);

    const edited = await agreements.updatePlan(owner(), {
      id: plan.id, price: "300.00", discountRate: "0.05", priorityDispatch: true,
      benefits: ["Two tune ups a year", " ", "No overtime charges"],
    });
    expect(edited).toMatchObject({ price: "300.0000", discountRate: "0.050000", priorityDispatch: true });
    expect(edited.benefits).toEqual(["Two tune ups a year", "No overtime charges"]);

    /** The member sold at fifteen per cent is still priced at fifteen, mid term. */
    const [mine] = await raw`select price, discount_rate from public.agreement where id = ${sold.id}`;
    expect(mine).toMatchObject({ price: "240.0000", discount_rate: "0.150000" });
    expect((await pricedOn()).memberDiscountAmount).toBe("30.0000");

    /** A new member takes the plan as it stands. */
    await agreements.cancel(owner(), { id: sold.id, reason: "Moved", keepThePrepayment: true });
    const next = await sell(plan.id);
    expect(next).toMatchObject({ price: "300.0000", discountRate: "0.050000" });
    expect((await pricedOn()).memberDiscountAmount).toBe("10.0000");
  });

  it("refuses an edit a new plan would be refused for", async () => {
    const plan = await agreements.createPlan(owner(), { ...PLAN, code: "CC" });
    await agreements.createPlan(owner(), { ...PLAN, name: "Other", code: "OTHER" });
    await expect(agreements.updatePlan(owner(), { id: plan.id, discountRate: "15" })).rejects.toThrow(/fraction/);
    await expect(agreements.updatePlan(owner(), { id: plan.id, termMonths: 0 })).rejects.toThrow(ConflictError);
    await expect(agreements.updatePlan(owner(), { id: plan.id, code: "OTHER" })).rejects.toThrow(/already the code/);
    await expect(agreements.updatePlan(as(["csr"]), { id: plan.id, name: "Mine" })).resolves.toBeTruthy();
    await expect(agreements.updatePlan(as(["dispatcher"]), { id: plan.id, name: "Mine" }))
      .rejects.toThrow(PermissionError);
  });

  it("takes a discount off with an empty rate, and says how many members an edit reaches", async () => {
    const plan = await agreements.createPlan(owner(), PLAN);
    await sell(plan.id);
    expect((await agreements.updatePlan(owner(), { id: plan.id, discountRate: "" })).discountRate).toBeNull();
    expect((await agreements.getPlan(owner(), { id: plan.id })).members).toBe(1);
  });

  it("keeps a member on the billing they were sold when the plan's frequency changes", async () => {
    /**
     * A renewal used to read the plan's frequency, so editing the plan to
     * monthly would have turned an annual member's next year into twelve
     * invoices on the night the worker renewed them.
     */
    const plan = await agreements.createPlan(owner(), PLAN);
    const sold = await sell(plan.id);
    await agreements.updatePlan(owner(), { id: plan.id, billingFrequency: "monthly" });
    const renewed = await agreements.renew(owner(), { id: sold.id });
    expect(renewed.instalments).toBe(1);
    const [row] = await raw`select billing_frequency from public.agreement where id = ${sold.id}`;
    expect(row!.billing_frequency).toBe("annual");
  });
});

run("the book on the API", () => {
  it("lists and reads plans and agreements the way the screens do", async () => {
    const plan = await agreements.createPlan(owner(), PLAN);
    const sold = await sell(plan.id);
    const listed = await agreements.handlers.listAgreementPlans(owner(), {});
    expect(listed.plans.map((p) => p.name)).toEqual(["Comfort Club"]);
    expect((await agreements.handlers.listAgreements(owner(), { customerId })).agreements[0])
      .toMatchObject({ id: sold.id, planName: "Comfort Club", customerName: "Mira Member", discountRate: "0.150000" });
    const read = await agreements.handlers.getAgreement(owner(), { id: sold.id });
    expect(read.visits).toHaveLength(2);
    expect(read.instalments).toHaveLength(1);
    expect(read.unearned).toBe("240.0000");
  });

  it("books an owed visit once, however many times the request is retried", async () => {
    const plan = await agreements.createPlan(owner(), PLAN);
    const sold = await sell(plan.id);
    const [visit] = (await agreements.handlers.getAgreement(owner(), { id: sold.id })).visits;

    const first = await agreements.handlers.bookAgreementVisit(keyed("book-1"), { id: visit!.id });
    const again = await agreements.handlers.bookAgreementVisit(keyed("book-1"), { id: visit!.id });
    expect(again).toEqual(first);
    const [jobs] = await raw`select count(*)::int as n, max(total)::text as total from public.job where organization_id = ${ORG}`;
    expect(jobs).toMatchObject({ n: 1, total: "0.0000" });

    /** A different request for the same visit is somebody else booking it, and is refused. */
    await expect(agreements.handlers.bookAgreementVisit(keyed("book-2"), { id: visit!.id }))
      .rejects.toThrow(/already booked/);
  });

  it("delivers, skips and unskips, recognising only what was delivered", async () => {
    const plan = await agreements.createPlan(owner(), PLAN);
    const sold = await sell(plan.id);
    const [first, second] = (await agreements.handlers.getAgreement(owner(), { id: sold.id })).visits;

    const delivered = await agreements.handlers.deliverAgreementVisit(keyed("deliver-1"), { id: first!.id, on: "2026-04-02" });
    expect(delivered).toEqual({ agreementVisitId: first!.id, recognized: "120.0000" });
    expect(await agreements.handlers.deliverAgreementVisit(keyed("deliver-1"), { id: first!.id })).toEqual(delivered);

    const skipped = await agreements.handlers.skipAgreementVisit(owner(), { id: second!.id, reason: "Away all autumn" });
    expect(skipped).toMatchObject({ skipReason: "Away all autumn", stillDeferred: "120.0000" });
    expect((await agreements.handlers.listOwedAgreementVisits(owner(), { through: "2027-06-01" })).visits).toHaveLength(0);
    await agreements.handlers.unskipAgreementVisit(owner(), { id: second!.id });
    expect((await agreements.handlers.listOwedAgreementVisits(owner(), { through: "2027-06-01" })).visits
      .map((v) => v.id)).toEqual([second!.id]);
    expect((await agreements.handlers.getAgreement(owner(), { id: sold.id })).unearned).toBe("120.0000");
  });

  it("bills an instalment once, as deferred revenue, on invoice:write", async () => {
    const plan = await agreements.createPlan(owner(), PLAN);
    const sold = await sell(plan.id);
    const [instalment] = (await agreements.handlers.getAgreement(owner(), { id: sold.id })).instalments;

    await expect(agreements.handlers.invoiceAgreementInstalment(as(["csr"]), { id: instalment!.id }))
      .rejects.toThrow(PermissionError);
    const billed = await agreements.handlers.invoiceAgreementInstalment(keyed("bill-1"), { id: instalment!.id });
    expect(await agreements.handlers.invoiceAgreementInstalment(keyed("bill-1"), { id: instalment!.id })).toEqual(billed);
    expect(billed.total).toBe("240.0000");
    const [invoices] = await raw`select count(*)::int as n from public.invoice where organization_id = ${ORG}`;
    expect(invoices!.n).toBe(1);
    const credits = await raw`select account_code from public.ledger_entry
      where organization_id = ${ORG} and direction = 'credit'`;
    expect(credits.map((c) => c.account_code)).not.toContain("4000");
  });

  it("cancels with a reason and releases what was not earned", async () => {
    const plan = await agreements.createPlan(owner(), PLAN);
    const sold = await sell(plan.id);
    const cancelled = await agreements.handlers.cancelAgreement(keyed("cancel-1"), {
      id: sold.id, reason: "Sold the house", keepThePrepayment: true,
    });
    expect(cancelled).toMatchObject({ status: "cancelled", cancellationReason: "Sold the house", released: "240.0000" });
    expect(await agreements.handlers.cancelAgreement(keyed("cancel-1"), {
      id: sold.id, reason: "Sold the house", keepThePrepayment: true,
    })).toEqual(cancelled);
  });

  it("retires a plan without touching its members, and says so twice without complaint", async () => {
    const plan = await agreements.createPlan(owner(), PLAN);
    const sold = await sell(plan.id);
    expect((await agreements.handlers.retireAgreementPlan(owner(), { id: plan.id })).active).toBe(false);
    expect((await agreements.handlers.retireAgreementPlan(owner(), { id: plan.id })).active).toBe(false);
    expect((await agreements.handlers.getAgreement(owner(), { id: sold.id })).status).toBe("active");
    await expect(sell(plan.id)).rejects.toThrow(/retired/);
  });
});

run("the perks a plan promised", () => {
  const fee = async (code: string, feeRole: "diagnostic" | "after_hours", price: string) =>
    priceBook.create(owner(), {
      kind: "fee", code, name: code, price, taxable: false, feeRole,
    });

  it("waives the diagnostic fee for a member, on the estimate and on the invoice", async () => {
    const diagnostic = await fee("DIAG", "diagnostic", "89.00");
    const plan = await agreements.createPlan(owner(), {
      ...PLAN, discountRate: undefined, waivesDiagnosticFee: true,
    });
    const sold = await sell(plan.id);

    const written = await estimates.create(owner(), {
      customerId, propertyId, taxRate: "0",
      options: [{
        name: "Visit", isRecommended: false,
        lines: [
          { priceBookItemId: diagnostic.id, name: "x", quantity: "1", unitPrice: "0", discountAmount: "0", taxable: false, isOptional: false, isSelected: false },
          { name: "Igniter", quantity: "1", unitPrice: "150.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false },
        ],
      }],
    });
    const [waived, igniter] = written.options[0]!.lines;
    expect(waived).toMatchObject({ unitPrice: "89.0000", memberDiscountAmount: "89.0000", lineTotal: "0.0000", memberAgreementId: sold.id });
    expect(igniter!.memberDiscountAmount).toBe("0.0000");
    expect(written.options[0]!.total).toBe("150.0000");

    const invoice = await billing.create(owner(), {
      customerId,
      lines: [{ priceBookItemId: diagnostic.id, name: "x", quantity: "1", unitPrice: "0", discountAmount: "0", taxable: false }],
    });
    expect(invoice.total).toBe("0.0000");
    expect(invoice.lines[0]).toMatchObject({ memberDiscountAmount: "89.0000", memberAgreementId: sold.id });
  });

  it("waives the after hours rate only for a plan that says so, and only at the address it covers", async () => {
    const afterHours = await fee("AFTER", "after_hours", "150.00");
    const plan = await agreements.createPlan(owner(), { ...PLAN, discountRate: "0.10", waivesAfterHoursRate: true });
    await sell(plan.id);
    const line = (property: string) => estimates.create(owner(), {
      customerId, propertyId: property, taxRate: "0",
      options: [{
        name: "Night call", isRecommended: false,
        lines: [{ priceBookItemId: afterHours.id, name: "x", quantity: "1", unitPrice: "0", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }],
      }],
    }).then((e) => e.options[0]!.lines[0]!);
    expect((await line(propertyId)).memberDiscountAmount).toBe("150.0000");
    expect((await line(otherPropertyId)).memberDiscountAmount).toBe("0.0000");
  });

  it("charges a fee item that is not marked as the diagnostic fee at the plan's rate only", async () => {
    const trip = await priceBook.create(owner(), { kind: "fee", code: "TRIP", name: "Trip", price: "89.00", taxable: false });
    const plan = await agreements.createPlan(owner(), { ...PLAN, discountRate: "0.10", waivesDiagnosticFee: true });
    await sell(plan.id);
    const written = await estimates.create(owner(), {
      customerId, propertyId, taxRate: "0",
      options: [{
        name: "Visit", isRecommended: false,
        lines: [{ priceBookItemId: trip.id, name: "x", quantity: "1", unitPrice: "0", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }],
      }],
    });
    expect(written.options[0]!.lines[0]!.memberDiscountAmount).toBe("8.9000");
  });

  it("puts a member whose plan promised priority at the top of the unassigned pile, and says why", async () => {
    const plan = await agreements.createPlan(owner(), { ...PLAN, priorityDispatch: true });
    await sell(plan.id);
    const [stranger] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Walk In') returning id`;
    const day = "2026-06-10";
    const visitFor = async (customer: string, property: string, hour: number, number: number) => {
      const [job] = await raw`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
        values (${ORG}, ${number}, ${customer}, ${property}, 'scheduled', 'No cool') returning id`;
      const at = new Date(`2026-06-10T${String(hour + 5).padStart(2, "0")}:00:00Z`);
      const [visit] = await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end)
        values (${ORG}, ${job!.id}, 'unassigned', ${at}, ${new Date(at.getTime() + 2 * 3600e3)}) returning id`;
      return visit!.id as string;
    };
    const early = await visitFor(stranger!.id, propertyId, 8, 7001);
    const rental = await visitFor(customerId, otherPropertyId, 9, 7002);
    const member = await visitFor(customerId, propertyId, 13, 7003);

    const board = await dispatch.board(owner(), { date: day });
    const pile = board.unassigned.filter((v) => [early, rental, member].includes(v.id));
    expect(pile.map((v) => [v.id, v.priorityPlan])).toEqual([
      [member, "Comfort Club"], [early, null], [rental, null],
    ]);
  });
});
