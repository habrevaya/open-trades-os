import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as agreements from "../src/services/agreements";
import * as agreementNotices from "../src/services/agreement-notices";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as estimates from "../src/services/estimates";
import * as billing from "../src/services/billing";
import * as priceBook from "../src/services/pricebook";
import * as priceCategories from "../src/services/price-categories";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * MEMBERSHIP DEPTH: WHAT THE DISCOUNT LEAVES OUT, THE NOTICE IN THE
 * COMPANY'S WORDS, AND WHAT A TERM RELEASES WHEN IT ENDS
 *
 * A plan that discounts labour and not equipment, priced on an estimate and
 * an invoice and read by the phone and the portal; the renewal notice from
 * the company's own templates, by the channel it chose; and breakage, the
 * deferred revenue behind visits never taken, released on the day a term
 * ends, once, and never before.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("depth:org");
const USER = fixtureId("depth:user");
const PHONE = "+15125550177";
const EMAIL = "rosa.depth@example.com";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);
const today = () => time.dateIn(new Date(), "America/Chicago");
const monthAgo = () => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
};

let customerId = "";
let propertyId = "";
let equipment = "";
let furnaces = "";
let furnace = "";
let labour = "";
let permit = "";
let diagnostic = "";

const PLAN = {
  name: "Comfort Club", price: "240.00",
  billingFrequency: "quarterly" as const, termMonths: 12,
  includedVisitsPerTerm: 2, renewalNoticeDays: 30,
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Depth Air", slug: "depth-air" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559911', 'main', true)`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
            values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@depthair.test","fromName":"Depth Air"}'::jsonb)`;
  const customer = await customers.create(owner(), {
    type: "residential", name: "Rosa Member", phone: PHONE, email: EMAIL,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  propertyId = (await properties.create(owner(), {
    address: { line1: "4 Depth Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id;

  equipment = (await priceCategories.create(owner(), { name: "Equipment" })).id;
  furnaces = (await priceCategories.create(owner(), { name: "Furnaces", parentId: equipment })).id;
  const labourShelf = (await priceCategories.create(owner(), { name: "Labour" })).id;
  furnace = (await priceBook.create(owner(), {
    kind: "equipment", code: "FURN-80", name: "80% furnace", price: "3000.00", taxable: false, categoryId: furnaces,
  } as Parameters<typeof priceBook.create>[1])).id;
  labour = (await priceBook.create(owner(), {
    kind: "labor", code: "LAB", name: "Labour, per hour", price: "120.00", taxable: false, categoryId: labourShelf,
  } as Parameters<typeof priceBook.create>[1])).id;
  permit = (await priceBook.create(owner(), {
    kind: "fee", code: "PERMIT", name: "Permit", price: "75.00", taxable: false,
  } as Parameters<typeof priceBook.create>[1])).id;
  diagnostic = (await priceBook.create(owner(), {
    kind: "fee", code: "DIAG", name: "Diagnostic", price: "89.00", taxable: false, feeRole: "diagnostic", categoryId: equipment,
  } as Parameters<typeof priceBook.create>[1])).id;
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
  await raw`delete from public.agreement_term where organization_id = ${ORG}`;
  await raw`delete from public.invoice_line where organization_id = ${ORG}`;
  await raw`delete from public.invoice where organization_id = ${ORG}`;
  await raw`delete from public.estimate where organization_id = ${ORG}`;
  await raw`delete from public.agreement where organization_id = ${ORG}`;
  await raw`delete from public.agreement_plan where organization_id = ${ORG}`;
  await raw`delete from public.task where organization_id = ${ORG}`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
  await raw`delete from public.message_template where organization_id = ${ORG}`;
  await raw`delete from public.integration_event where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'renewalNotices' where id = ${ORG}`;
});

const sell = async (plan: Partial<agreements.PlanInput> = {}, sale: Partial<agreements.SellInput> = {}) => {
  const created = await agreements.createPlan(owner(), { ...PLAN, ...plan });
  const sold = await agreements.sell(owner(), { planId: created.id, customerId, propertyId, startedOn: monthAgo(), ...sale });
  return { plan: created, sold };
};

const bookLine = (priceBookItemId: string, name: string, unitPrice: string) => ({
  priceBookItemId, name, quantity: "1", unitPrice, discountAmount: "0", taxable: false,
  isOptional: false, isSelected: false,
});

run("what a plan's discount leaves out", () => {
  it("discounts labour and not equipment, anywhere under the category, on an estimate", async () => {
    const { sold } = await sell({ discountRate: "0.10", discountExclusions: { categoryIds: [equipment], itemIds: [permit] } });
    const created = await estimates.create(owner(), {
      customerId, propertyId, taxRate: "0",
      options: [{
        name: "Replace", isRecommended: false,
        lines: [bookLine(furnace, "80% furnace", "3000.00"), bookLine(labour, "Labour, per hour", "120.00"), bookLine(permit, "Permit", "75.00")],
      }],
    });
    const lines = created.options[0]!.lines;
    expect(lines.map((l) => [l.name, l.memberDiscountAmount])).toEqual([
      ["80% furnace", "0.0000"], ["Labour, per hour", "12.0000"], ["Permit", "0.0000"],
    ]);
    expect(lines[1]!.memberAgreementId).toBe(sold.id);
    expect(created.options[0]!.total).toBe("3183.0000");
  });

  it("does the same on an invoice, and still waives a waived fee filed under an excluded category", async () => {
    await sell({
      discountRate: "0.10", waivesDiagnosticFee: true,
      discountExclusions: { categoryIds: [equipment], itemIds: [] },
    });
    const invoice = await billing.create(owner(), {
      customerId,
      lines: [
        { priceBookItemId: furnace, name: "80% furnace", quantity: "1", unitPrice: "3000.00", discountAmount: "0", taxable: false },
        { priceBookItemId: labour, name: "Labour", quantity: "2", unitPrice: "120.00", discountAmount: "0", taxable: false },
        { priceBookItemId: diagnostic, name: "Diagnostic", quantity: "1", unitPrice: "89.00", discountAmount: "0", taxable: false },
        { name: "Typed by hand", quantity: "1", unitPrice: "50.00", discountAmount: "0", taxable: false },
      ],
    });
    expect(invoice.lines.map((l) => l.memberDiscountAmount)).toEqual(["0.0000", "24.0000", "89.0000", "5.0000"]);
    expect(invoice.discountTotal).toBe("118.0000");
  });

  it("is frozen on the agreement at sale, like the rate", async () => {
    const { plan } = await sell({ discountRate: "0.10", discountExclusions: { categoryIds: [equipment], itemIds: [] } });
    await agreements.updatePlan(owner(), { id: plan.id, discountExclusions: { categoryIds: [], itemIds: [] } });
    const invoice = await billing.create(owner(), {
      customerId,
      lines: [{ priceBookItemId: furnace, name: "80% furnace", quantity: "1", unitPrice: "3000.00", discountAmount: "0", taxable: false }],
    });
    expect(invoice.lines[0]!.memberDiscountAmount).toBe("0.0000");
  });

  it("is said by name before the save, flattened for the phone, and shown on the member's own account", async () => {
    const { sold } = await sell({ discountRate: "0.15", discountExclusions: { categoryIds: [equipment], itemIds: [permit] } });
    const pricing = await agreements.memberPricing(owner(), { customerId, propertyId });
    expect(pricing.leavesOut).toEqual(["Equipment", "Permit"]);
    const detail = await agreements.get(owner(), { id: sold.id });
    expect(detail.leavesOut).toEqual(["Equipment", "Permit"]);

    const flat = await inTenant(owner(), (tx) => agreements.excludedItemsWithin(tx, { categoryIds: [equipment], itemIds: [permit] }));
    expect(flat.sort()).toEqual([furnace, diagnostic, permit].sort());
  });

  it("refuses a category that is not in this company's price book", async () => {
    await expect(agreements.createPlan(owner(), {
      ...PLAN, name: "Odd", discountExclusions: { categoryIds: [fixtureId("depth:nowhere")], itemIds: [] },
    })).rejects.toThrow(/not in your price book/);
  });
});

run("the renewal notice in the company's words", () => {
  const sent = () => raw<{ body: string; channel: string; subject: string | null }[]>`
    select body, channel::text as channel, subject from public.message
    where organization_id = ${ORG} and direction = 'outbound' order by channel`;

  it("sends the product's own wording, text first, when nothing is set", async () => {
    await sell({}, { startedOn: "2025-06-01" });
    const settings = await agreementNotices.settings(owner());
    expect(settings.channel).toBe("text_first");
    expect(settings.templates.every((t) => t.isDefault)).toBe(true);
    await agreements.renewalsFor(db(), ORG, new Date("2026-05-10T15:00:00Z"));
    const messages = await sent();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.channel).toBe("sms");
    expect(messages[0]!.body).toBe(
      "Hi Rosa, your Comfort Club with Depth Air renews on June 1, 2026 for another 12 months at $240.00. "
      + "Reply to this message if you would like to change or cancel it.",
    );
  });

  it("sends the company's own words by text and by email when it chose both", async () => {
    await sell({}, { startedOn: "2025-06-01" });
    await agreementNotices.update(owner(), {
      channel: "both",
      templates: [
        { code: "agreement_renewal.renews.sms", body: "{{ customer.firstName }}, {{ plan.name }} renews {{ agreement.renewsOn }}." },
        { code: "agreement_renewal.renews.email", subject: "{{ plan.name }} is renewing", body: "Dear {{ customer.firstName }}, it renews at {{ agreement.price }}." },
      ],
    });
    const result = await agreements.renewalsFor(db(), ORG, new Date("2026-05-10T15:00:00Z"));
    expect(result.noticed[0]!.outcome).toBe("queued");
    const messages = await sent();
    expect(messages.map((m) => m.channel).sort()).toEqual(["email", "sms"]);
    expect(messages.find((m) => m.channel === "sms")!.body).toBe("Rosa, Comfort Club renews June 1, 2026.");
    expect(messages.find((m) => m.channel === "email")!.body).toBe("Dear Rosa, it renews at $240.00.");

    const settings = await agreementNotices.settings(owner());
    expect(settings.channel).toBe("both");
    expect(settings.templates.find((t) => t.code === "agreement_renewal.renews.sms")!.isDefault).toBe(false);
  });

  it("falls back to the other way when the first cannot go", async () => {
    const sold = await sell({}, { startedOn: "2025-06-01" });
    await agreementNotices.update(owner(), { channel: "email_first" });
    await raw`update public.customer set email = null where id = ${customerId}`;
    try {
      const result = await agreements.renewalsFor(db(), ORG, new Date("2026-05-10T15:00:00Z"));
      expect(result.noticed).toEqual([{ agreementId: sold.sold.id, outcome: expect.stringMatching(/^Sent by text\. Not emailed/) }]);
      expect((await sent()).map((m) => m.channel)).toEqual(["sms"]);
    } finally {
      await raw`update public.customer set email = ${EMAIL} where id = ${customerId}`;
    }
  });

  it("refuses a placeholder the notice does not have, and needs settings:write", async () => {
    await expect(agreementNotices.update(owner(), {
      templates: [{ code: "agreement_renewal.ends.sms", body: "Hi {{ customer.nickname }}" }],
    })).rejects.toThrow(/does not declare|declare/);
    await expect(agreementNotices.update(as(["office_manager"]), { channel: "both" }))
      .rejects.toMatchObject({ name: "PermissionError" });
  });

  it("is seeded with the product's wording for a new company", async () => {
    await inTenant(owner(), (tx) => agreementNotices.seedNoticeTemplates(tx, ORG));
    const settings = await agreementNotices.settings(owner());
    expect(settings.templates.every((t) => !t.isDefault)).toBe(true);
    expect(settings.templates.find((t) => t.code === "agreement_renewal.ends.email")!.subject)
      .toBe("Your {{ plan.name }} is coming to an end");
  });
});

run("breakage: what a term held for visits never taken", () => {
  const postings = (termId: string) => raw<{ account_code: string; direction: string; amount: string }[]>`
    select account_code, direction, amount::numeric(14,2)::text as amount from public.ledger_entry
    where organization_id = ${ORG} and source_type = 'agreement_breakage' and source_id = ${termId}
    order by direction`;

  it("is released to revenue on the day the term ends, once, and shows on the agreement", async () => {
    const { sold } = await sell({ autoRenews: false }, { startedOn: "2025-06-01" });
    const before = await agreements.get(owner(), { id: sold.id });
    await agreements.deliver(owner(), { agreementVisitId: before.visits[0]!.id, on: "2025-09-01" });

    /** The day before the end: nothing. */
    const early = await agreements.renewalsFor(db(), ORG, new Date("2026-05-31T15:00:00Z"));
    expect(early.released).toEqual([]);

    const ended = await agreements.renewalsFor(db(), ORG, new Date("2026-06-01T15:00:00Z"));
    expect(ended.lapsed).toEqual([sold.id]);
    expect(ended.released).toEqual([{ agreementId: sold.id, term: 1, amount: "120.0000" }]);

    const detail = await agreements.get(owner(), { id: sold.id });
    expect(detail.unearned).toBe("0.0000");
    expect(detail.terms).toMatchObject([{ term: 1, endsOn: "2026-06-01", breakageReleasedOn: "2026-06-01", breakageAmount: "120.0000", breakageVisits: 1 }]);
    /** Liability down, agreement revenue up, balanced. */
    expect(await postings(detail.terms[0]!.id)).toEqual([
      { account_code: "2400", direction: "debit", amount: "120.00" },
      { account_code: "4100", direction: "credit", amount: "120.00" },
    ]);

    /** Again: nothing more. */
    const again = await agreements.renewalsFor(db(), ORG, new Date("2026-06-02T15:00:00Z"));
    expect(again.released).toEqual([]);
    expect(await postings(detail.terms[0]!.id)).toHaveLength(2);

    /** The visit is still owed, and doing it now earns nothing more. */
    const late = await agreements.deliver(owner(), { agreementVisitId: before.visits[1]!.id, on: "2026-06-10" });
    expect(late.recognized).toBe("0.0000");
  });

  it("is released when the worker renews on the end date, and the new term keeps its own", async () => {
    const { sold } = await sell({}, { startedOn: "2025-06-01" });
    const result = await agreements.renewalsFor(db(), ORG, new Date("2026-06-01T15:00:00Z"));
    expect(result.renewed).toEqual([sold.id]);
    const detail = await agreements.get(owner(), { id: sold.id });
    expect(detail.terms.map((t) => [t.term, t.breakageAmount, t.breakageVisits])).toEqual([[1, "240.0000", 2], [2, null, null]]);
    expect(detail.unearned).toBe("240.0000");
  });

  it("is not released early when somebody renews before the end", async () => {
    const start = (() => {
      const d = new Date(`${today()}T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - 11);
      return d.toISOString().slice(0, 10);
    })();
    const { sold } = await sell({}, { startedOn: start });
    await agreements.renew(owner(), { id: sold.id });
    const detail = await agreements.get(owner(), { id: sold.id });
    expect(detail.terms.every((t) => t.breakageReleasedOn === null)).toBe(true);
    expect(detail.unearned).toBe("480.0000");
  });

  it("writes down the current term of an agreement sold before terms were recorded, and releases it", async () => {
    const { sold } = await sell({ autoRenews: false }, { startedOn: "2025-06-01" });
    await raw`delete from public.agreement_term where agreement_id = ${sold.id}`;
    const ended = await agreements.renewalsFor(db(), ORG, new Date("2026-06-03T15:00:00Z"));
    expect(ended.released).toEqual([{ agreementId: sold.id, term: 1, amount: "240.0000" }]);
  });

  it("releases nothing more for a term a cancellation already settled", async () => {
    const { sold } = await sell({ autoRenews: false }, { startedOn: "2025-06-01" });
    await agreements.cancel(owner(), { id: sold.id, reason: "Moved away", keepThePrepayment: true });
    const ended = await agreements.renewalsFor(db(), ORG, new Date("2026-06-03T15:00:00Z"));
    expect(ended.released).toEqual([{ agreementId: sold.id, term: 1, amount: "0.0000" }]);
    const [counted] = await raw<{ n: number }[]>`select count(*)::int as n from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'agreement_breakage'`;
    expect(counted!.n).toBe(0);
  });
});
