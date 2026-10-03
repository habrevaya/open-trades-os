import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as agreements from "../src/services/agreements";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as estimates from "../src/services/estimates";
import * as billing from "../src/services/billing";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * RENEWALS, THE NOTICE BEFORE THEM, AND WHAT A MEMBERSHIP TAKES OFF THE PRICE
 *
 * The three things the agreement book recorded the inputs for and never did:
 * `auto_renews` was a column nothing read, `renewal_notice_days` was a number
 * nothing counted down, and `discount_rate` was a benefit nobody received.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("renew:org");
const USER = fixtureId("renew:user");
const PHONE = "+15125550188";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";
let otherPropertyId = "";
const today = () => time.dateIn(new Date(), "America/Chicago");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Renewal Air", slug: "renewal-air" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559900', 'main', true)`;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Rosa Member", phone: PHONE,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const home = await properties.create(owner(), {
    address: { line1: "4 Renewal Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = home.id;
  const rental = await properties.create(owner(), {
    address: { line1: "9 Rental Row", city: "Austin", state: "TX", postalCode: "78702", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  otherPropertyId = rental.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw.unsafe("set session_replication_role = replica");
  await raw`delete from public.ledger_entry where organization_id = ${ORG}`;
  await raw.unsafe("set session_replication_role = origin");
  await raw`delete from public.deferred_revenue_entry where organization_id = ${ORG}`;
  await raw`delete from public.agreement_billing where organization_id = ${ORG}`;
  await raw`delete from public.agreement_visit where organization_id = ${ORG}`;
  await raw`delete from public.invoice_line where organization_id = ${ORG}`;
  await raw`delete from public.invoice where organization_id = ${ORG}`;
  await raw`delete from public.estimate where organization_id = ${ORG}`;
  await raw`delete from public.agreement where organization_id = ${ORG}`;
  await raw`delete from public.agreement_plan where organization_id = ${ORG}`;
  await raw`delete from public.job where organization_id = ${ORG}`;
  await raw`delete from public.task where organization_id = ${ORG}`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
  await raw`delete from public.integration_event where organization_id = ${ORG}`;
  await raw`delete from public.domain_event where organization_id = ${ORG}`;
});

const PLAN = {
  name: "Comfort Club", price: "240.00",
  billingFrequency: "quarterly" as const, termMonths: 12,
  includedVisitsPerTerm: 2, renewalNoticeDays: 30,
};

const sellRunning = async (
  plan: Partial<agreements.PlanInput> = {},
  sale: Partial<agreements.SellInput> = {},
) => {
  const created = await agreements.createPlan(owner(), { ...PLAN, ...plan });
  return agreements.sell(owner(), {
    planId: created.id, customerId, propertyId, startedOn: "2025-06-01", ...sale,
  });
};

const sellOne = sellRunning;

run("renewing from the agreement screen", () => {
  it("adds a term that starts the day the last one ends and owes everything a sale owes", async () => {
    const sold = await sellOne();
    const renewed = await agreements.renew(owner(), { id: sold.id });

    expect(renewed).toMatchObject({ term: 2, startsOn: "2026-06-01", endsOn: "2027-06-01", price: "240.0000" });

    const detail = await agreements.get(owner(), { id: sold.id });
    expect(detail.agreement.endsOn).toBe("2027-06-01");
    expect(detail.agreement.renewalCount).toBe(1);

    /** Sequences carry on, and the term says which year each one belongs to. */
    expect(detail.visits.map((v) => [v.sequence, v.term])).toEqual([[1, 1], [2, 1], [3, 2], [4, 2]]);
    expect(detail.billing.map((b) => [b.sequence, b.term, b.dueOn])).toEqual([
      [1, 1, "2025-06-01"], [2, 1, "2025-09-01"], [3, 1, "2025-12-01"], [4, 1, "2026-03-01"],
      [5, 2, "2026-06-01"], [6, 2, "2026-09-01"], [7, 2, "2026-12-01"], [8, 2, "2027-03-01"],
    ]);

    /** The second term defers its price exactly as the first did, to the cent. */
    const [deferred] = await raw<{ total: string }[]>`
      select sum(amount)::numeric(14,2)::text as total from public.deferred_revenue_entry
      where agreement_id = ${sold.id}`;
    expect(deferred!.total).toBe("480.00");

    const [event] = await raw`select payload from public.domain_event
      where organization_id = ${ORG} and name = 'agreement.renewed'`;
    expect((event!.payload as { renewedBy: string }).renewedBy).toBe("office");
  });

  it("keeps the agreement's own price unless a new one is typed", async () => {
    const sold = await sellOne({}, { price: "199.00" });
    // The plan's price moved on; the member did not agree to it.
    await raw`update public.agreement_plan set price = 300 where organization_id = ${ORG}`;
    expect((await agreements.renew(owner(), { id: sold.id })).price).toBe("199.0000");
    expect((await agreements.renew(owner(), { id: sold.id, price: "260.00" })).price).toBe("260.0000");
    await expect(agreements.renew(owner(), { id: sold.id, price: "a lot" })).rejects.toThrow(/has to be an amount/);
  });

  it("refuses a cancelled agreement, and leaves last year's owed visit owed", async () => {
    const sold = await sellOne();
    await agreements.renew(owner(), { id: sold.id });
    const owed = await agreements.owed(owner(), { through: "2027-12-31" });
    expect(owed.filter((r) => r.agreementId === sold.id)).toHaveLength(4);

    await agreements.cancel(owner(), { id: sold.id, reason: "Moving away" });
    await expect(agreements.renew(owner(), { id: sold.id })).rejects.toThrow(ConflictError);
    await expect(agreements.renew(owner(), { id: sold.id })).rejects.toThrow(/Sell them a new one/);
  });

  it("is the same renewal when the request is replayed", async () => {
    const sold = await sellOne();
    const keyed = { ...owner(), idempotencyKey: "renew-once" };
    await agreements.renew(keyed, { id: sold.id });
    await agreements.renew(keyed, { id: sold.id });
    expect((await agreements.get(owner(), { id: sold.id })).agreement.endsOn).toBe("2027-06-01");
  });

  it("needs membership:write", async () => {
    const sold = await sellOne();
    await expect(agreements.renew(as(["accountant"]), { id: sold.id })).rejects.toThrow();
  });
});

run("the worker, on and around the end date", () => {
  it("renews when the plan and the agreement both say so, and only then", async () => {
    const both = await sellOne();
    const memberSaidNo = await sellOne({ name: "Club B" });
    await raw`update public.agreement set auto_renews = false where id = ${memberSaidNo.id}`;

    const result = await agreements.renewalsFor(db(), ORG, new Date("2026-06-01T15:00:00Z"));
    expect(result.renewed).toEqual([both.id]);
    /**
     * The other one is past its end and not renewing, so it lapsed: the
     * status the campaign audience "their plan lapsed" reads, and that
     * nothing used to set.
     */
    expect(result.lapsed).toEqual([memberSaidNo.id]);
    expect((await agreements.get(owner(), { id: memberSaidNo.id })).agreement.status).toBe("lapsed");

    // A second pass the same day does nothing more.
    const again = await agreements.renewalsFor(db(), ORG, new Date("2026-06-01T18:00:00Z"));
    expect(again.renewed).toEqual([]);
    expect((await agreements.get(owner(), { id: both.id })).agreement.endsOn).toBe("2027-06-01");
  });

  it("does not renew a plan that is not sold as renewing, even for a willing member", async () => {
    const sold = await sellOne({ name: "One year", autoRenews: false });
    const result = await agreements.renewalsFor(db(), ORG, new Date("2026-06-03T15:00:00Z"));
    expect(result.renewed).toEqual([]);
    expect(result.lapsed).toEqual([sold.id]);
  });

  it("is reached by the pass over every company", async () => {
    const sold = await sellOne();
    const results = await agreements.renewalsPass(db(), { now: new Date("2026-06-02T15:00:00Z") });
    const mine = results.find((r) => r.organizationId === ORG);
    expect(mine?.renewed).toEqual([sold.id]);
  });
});

run("the notice a plan owes before it renews", () => {
  const messages = () => raw<{ body: string; to_address: string; channel: string }[]>`
    select body, to_address, channel from public.message
    where organization_id = ${ORG} and direction = 'outbound' order by created_at`;

  it("texts it once, inside the window, through the consent gate", async () => {
    const sold = await sellOne();

    // A day before the window opens: nothing.
    await agreements.renewalsFor(db(), ORG, new Date("2026-05-01T15:00:00Z"));
    expect(await messages()).toHaveLength(0);

    const inside = await agreements.renewalsFor(db(), ORG, new Date("2026-05-10T15:00:00Z"));
    expect(inside.noticed).toEqual([{ agreementId: sold.id, outcome: "queued" }]);
    const sent = await messages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to_address).toBe(PHONE);
    expect(sent[0]!.body).toContain("Comfort Club");
    expect(sent[0]!.body).toContain("renews on June 1, 2026");
    expect(sent[0]!.body).toContain("$240.00");

    // Once per term, however many passes.
    await agreements.renewalsFor(db(), ORG, new Date("2026-05-11T15:00:00Z"));
    await agreements.renewalsFor(db(), ORG, new Date("2026-05-20T15:00:00Z"));
    expect(await messages()).toHaveLength(1);

    const [row] = await raw`select renewal_notice_sent_at, renewal_notice_outcome from public.agreement where id = ${sold.id}`;
    expect(row!.renewal_notice_sent_at).not.toBeNull();
    expect(row!.renewal_notice_outcome).toBe("queued");

    // Renewing clears it, so next year's term owes its own.
    await agreements.renewalsFor(db(), ORG, new Date("2026-06-01T15:00:00Z"));
    const [after] = await raw`select renewal_notice_sent_at from public.agreement where id = ${sold.id}`;
    expect(after!.renewal_notice_sent_at).toBeNull();
  });

  it("says when the plan ends, rather than renews, for a member who is not renewing", async () => {
    await sellOne({ autoRenews: false });
    await agreements.renewalsFor(db(), ORG, new Date("2026-05-10T15:00:00Z"));
    const [sent] = await messages();
    // The last covered day, not the exclusive end.
    expect(sent!.body).toContain("covers you until May 31, 2026");
    expect(sent!.body).toContain("would like to renew");
  });

  it("does not text somebody who replied STOP, and hands the office a task instead", async () => {
    const sold = await sellOne();
    await raw`insert into public.suppression (organization_id, address, channel, reason)
              values (${ORG}, ${PHONE}, 'sms', 'stop')`;

    const result = await agreements.renewalsFor(db(), ORG, new Date("2026-05-10T15:00:00Z"));
    expect(result.noticed[0]!.outcome).toMatch(/^Not texted/);
    expect(await messages()).toHaveLength(0);

    const tasks = await raw<{ title: string; entity_id: string; priority: string }[]>`
      select title, entity_id, priority from public.task where organization_id = ${ORG}`;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.entity_id).toBe(sold.id);
    expect(tasks[0]!.title).toContain("renews on June 1, 2026");

    // And it is not retried on every pass for a month.
    await agreements.renewalsFor(db(), ORG, new Date("2026-05-12T15:00:00Z"));
    expect(await raw`select id from public.task where organization_id = ${ORG}`).toHaveLength(1);
  });
});

run("agreements ending soon", () => {
  it("lists them soonest first, with the lapsed ones the office has not rung yet", async () => {
    const t = today();
    const shift = (days: number) => {
      const d = new Date(`${t}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    const soon = await sellOne({ name: "A" });
    const later = await sellOne({ name: "B" });
    const far = await sellOne({ name: "C" });
    const ended = await sellOne({ name: "D" });
    await raw`update public.agreement set ends_on = ${shift(10)} where id = ${soon.id}`;
    await raw`update public.agreement set ends_on = ${shift(50)} where id = ${later.id}`;
    await raw`update public.agreement set ends_on = ${shift(200)} where id = ${far.id}`;
    await raw`update public.agreement set ends_on = ${shift(-5)}, status = 'lapsed' where id = ${ended.id}`;

    const thirty = await agreements.expiring(owner(), { withinDays: 30 });
    expect(thirty.map((r) => r.id)).toEqual([ended.id, soon.id]);
    expect(thirty.map((r) => r.daysLeft)).toEqual([-5, 10]);
    expect(thirty[0]!.renewsAutomatically).toBe(false);
    expect(thirty[1]!.renewsAutomatically).toBe(true);

    const sixty = await agreements.expiring(owner(), { withinDays: 60 });
    expect(sixty.map((r) => r.id)).toEqual([ended.id, soon.id, later.id]);
  });
});

run("member pricing", () => {
  /** Sold a month ago, so it is running today whatever today is. */
  const monthAgo = () => {
    const d = new Date(`${today()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
  };
  const sellOne = (plan: Partial<agreements.PlanInput> = {}) => sellRunning(plan, { startedOn: monthAgo() });

  const line = (name: string, unitPrice: string, discountAmount = "0") => ({
    name, quantity: "1", unitPrice, discountAmount, taxable: false,
    isOptional: false, isSelected: false,
  });

  it("takes the plan's rate off each line of an estimate for a member's home, and says which agreement", async () => {
    const sold = await sellOne({ discountRate: "0.15" });
    const created = await estimates.create(owner(), {
      customerId, propertyId, taxRate: "0",
      options: [{ name: "Repair", isRecommended: false, lines: [line("Capacitor", "189.00"), line("Labour", "120.00")] }],
    });
    const option = created.options[0]!;
    expect(option.lines.map((l) => [l.discountAmount, l.memberDiscountAmount, l.memberAgreementId])).toEqual([
      ["28.3500", "28.3500", sold.id],
      ["18.0000", "18.0000", sold.id],
    ]);
    expect(option.subtotal).toBe("309.0000");
    expect(option.total).toBe("262.6500");
  });

  it("is not checked against the discount limit, which still governs what somebody types", async () => {
    await sellOne({ discountRate: "0.15" });
    /**
     * No discount policy at all: nobody short of unlimited authority may give
     * money away by hand. The office manager holds `estimate:discount` and
     * not the unlimited one, so the hand discount is refused while the member
     * discount on the same estimate would have been taken.
     */
    await expect(estimates.create(as(["office_manager"]), {
      customerId, propertyId, taxRate: "0",
      options: [{ name: "Repair", isRecommended: false, lines: [line("Capacitor", "189.00", "10.00")] }],
    })).rejects.toThrow(/discount/i);

    const memberOnly = await estimates.create(as(["office_manager"]), {
      customerId, propertyId, taxRate: "0",
      options: [{ name: "Repair", isRecommended: false, lines: [line("Capacitor", "189.00")] }],
    });
    expect(memberOnly.options[0]!.lines[0]!.memberDiscountAmount).toBe("28.3500");
  });

  it("does not price work at another address, or for somebody who is not a member, as member work", async () => {
    await sellOne({ discountRate: "0.15" });
    const elsewhere = await estimates.create(owner(), {
      customerId, propertyId: otherPropertyId, taxRate: "0",
      options: [{ name: "Repair", isRecommended: false, lines: [line("Capacitor", "189.00")] }],
    });
    expect(elsewhere.options[0]!.lines[0]!.memberDiscountAmount).toBe("0.0000");
    expect(elsewhere.options[0]!.lines[0]!.memberAgreementId).toBeNull();
  });

  it("carries the discount onto the invoice an approved estimate becomes, which then posts", async () => {
    const sold = await sellOne({ discountRate: "0.10" });
    const created = await estimates.create(owner(), {
      customerId, propertyId, taxRate: "0",
      options: [{ name: "Repair", isRecommended: false, lines: [line("Coil clean", "300.00")] }],
    });
    await estimates.approve(owner(), {
      id: created.id, optionId: created.options[0]!.id, selectedLineIds: [],
      signerName: "Rosa Member", capturedVia: "in_person",
    });
    const converted = await estimates.convert(owner(), { id: created.id, createJob: true, createInvoice: true });
    const draft = await billing.get(owner(), { id: converted.invoiceId! });
    expect(draft.discountTotal).toBe("30.0000");
    expect(draft.lines[0]!.memberAgreementId).toBe(sold.id);

    /**
     * Issuing builds the posting from the invoice's own totals. With the
     * discount left at zero this was a receivable of 270 against revenue of
     * 300, refused as unbalanced, for every converted estimate with a discount.
     */
    await billing.issue(owner(), { id: draft.id });
    const entries = await raw<{ account_code: string; direction: string; amount: string }[]>`
      select account_code, direction, amount::numeric(14,2)::text as amount from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'invoice' and source_id = ${draft.id}
      order by account_code`;
    expect(entries).toContainEqual({ account_code: "4900", direction: "debit", amount: "30.00" });
    expect(entries).toContainEqual({ account_code: "1200", direction: "debit", amount: "270.00" });
  });

  it("prices an invoice raised for a member's job the same way, and posts the discount to the discounts account", async () => {
    const sold = await sellOne({ discountRate: "0.20" });
    const [job] = await raw`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 9001, ${customerId}, ${propertyId}, 'completed', 'No heat') returning id`;

    const invoice = await billing.create(owner(), {
      customerId, jobId: job!.id,
      lines: [
        { name: "Igniter", quantity: "1", unitPrice: "150.00", discountAmount: "0", taxable: false },
        { name: "Diagnostic", quantity: "1", unitPrice: "89.00", discountAmount: "0", taxable: false },
      ],
    });
    expect(invoice.discountTotal).toBe("47.8000");
    expect(invoice.total).toBe("191.2000");
    expect(invoice.lines.every((l) => l.memberAgreementId === sold.id)).toBe(true);

    const [discount] = await raw<{ amount: string }[]>`
      select amount::numeric(14,2)::text as amount from public.ledger_entry
      where organization_id = ${ORG} and source_id = ${invoice.id} and account_code = '4900'`;
    expect(discount!.amount).toBe("47.80");
    const [revenue] = await raw<{ amount: string }[]>`
      select amount::numeric(14,2)::text as amount from public.ledger_entry
      where organization_id = ${ORG} and source_id = ${invoice.id} and account_code = '4000'`;
    expect(revenue!.amount).toBe("239.00");
  });

  it("does not take it twice when a draft is saved again with the discount somebody typed", async () => {
    await sellOne({ discountRate: "0.10" });
    const draft = await billing.create(owner(), {
      customerId, draft: true,
      lines: [{ name: "Filter", quantity: "1", unitPrice: "50.00", discountAmount: "0", taxable: false }],
    });
    expect(draft.discountTotal).toBe("5.0000");
    const saved = await billing.updateDraft(owner(), {
      id: draft.id,
      lines: [{ name: "Filter", quantity: "1", unitPrice: "50.00", discountAmount: "0", taxable: false }],
    });
    expect(saved.discountTotal).toBe("5.0000");
  });

  it("answers the screen that wants to say so before the save", async () => {
    const sold = await sellOne({ discountRate: "0.15" });
    expect(await agreements.memberPricing(owner(), { customerId, propertyId })).toMatchObject({
      applies: true, agreementId: sold.id, planName: "Comfort Club", percent: "15%",
    });
    expect((await agreements.memberPricing(owner(), { customerId, propertyId: otherPropertyId })).applies).toBe(false);
  });

  it("refuses a plan rate typed as a percentage", async () => {
    await expect(agreements.createPlan(owner(), { ...PLAN, discountRate: "15" })).rejects.toThrow(/fraction/);
  });
});
