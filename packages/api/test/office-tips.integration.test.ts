import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as payExtras from "../src/services/pay-extras";
import * as payments from "../src/services/payments";
import * as portalSettings from "../src/services/portal-settings";
import * as tips from "../src/services/tips";
import type { ChargeOutcome, ChargeRequest, PaymentProvider, RefundOutcome } from "../src/payments/provider";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M13. A TIP THE OFFICE TAKES, ON ITS OWN CARD AND CASH SCREENS
 *
 * The customer at the counter or on the phone adds something for the
 * technicians. It is held to the limits a portal or on site tip is, credited
 * to Tips payable and never to revenue, shared by the company's tip rule, and
 * the payment is audited as every payment is.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("office-tips:org");
const OWNER = fixtureId("office-tips:owner");
const SAM_USER = fixtureId("office-tips:sam");
const PRIYA_USER = fixtureId("office-tips:priya");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], key?: string): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);

class FakeProcessor implements PaymentProvider {
  readonly name = "stripe";
  readonly publishableKey = "pk_test_office_tips";
  charges: ChargeRequest[] = [];
  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.charges.push(request);
    return {
      ok: true,
      intent: {
        intentId: `pi_office_tips_${this.charges.length}_${Math.random().toString(36).slice(2)}`,
        clientSecret: "secret", amountMinor: request.amountMinor, currency: "usd", status: "requires_payment_method",
      },
    };
  }
  async refund(): Promise<RefundOutcome> {
    return { ok: true, refund: { refundId: "re_1", amountMinor: 0, status: "pending" } };
  }
  verify = () => true;
  parseEvent = () => null;
}

let processor: FakeProcessor;
const deps = (): payments.PaymentDeps => ({ readSecret: async () => "sk_test_notreal", provider: processor });
let connectionId = "";
let customerId = "";
let propertyId = "";
let sam = "";
let priya = "";

async function invoiceFor(total: string, crew: string[] = [sam, priya]) {
  const job = await jobs.create(owner(), { customerId, propertyId, summary: "Water heater", tags: [], customFields: {} });
  const [visit] = await raw<{ id: string }[]>`insert into public.visit
    (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${job.id as string}, 'completed', now() - interval '2 hours', now()) returning id`;
  for (const technicianId of crew) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
              values (${ORG}, ${visit!.id}, ${technicianId}, ${technicianId === crew[0]})`;
  }
  const invoice = await billing.create(owner(), {
    customerId, jobId: job.id as string,
    lines: [{ name: "Water heater flush", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  const invoiceId = invoice.id as string;
  await raw`update public.invoice set status = 'open' where id = ${invoiceId} and status = 'draft'`;
  return invoiceId;
}

const sharesOf = (paymentId: string) => raw<{ technician_id: string; amount: string; split_rule: string }[]>`
  select technician_id, amount::text, split_rule from public.tip_share where payment_id = ${paymentId} order by technician_id`;

async function accountNet(account: string): Promise<string> {
  const [row] = await raw<{ net: string }[]>`
    select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0)::numeric(14,4)::text as net
      from public.ledger_entry where organization_id = ${ORG} and account_code = ${account}`;
  return row!.net;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Office Tips Plumbing", slug: "office-tips-plumbing" });
  const [row] = await raw<{ id: string }[]>`
    insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', 'TEST_OFFICE_TIPS_KEY', ${raw.json({ publishableKey: "pk_test_office_tips" } as never)})
    returning id`;
  connectionId = row!.id;
  for (const [id, email] of [[SAM_USER, "office-tips-sam@test.local"], [PRIYA_USER, "office-tips-priya@test.local"]]) {
    await raw`insert into public."user" (id, email) values (${id!}, ${email!}) on conflict (id) do nothing`;
    await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id!}, 'technician')`;
  }
  const memberships = await raw<{ id: string; user_id: string }[]>`select id, user_id from public.membership where organization_id = ${ORG}`;
  const membershipOf = (userId: string) => memberships.find((m) => m.user_id === userId)!.id;
  sam = (await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membershipOf(SAM_USER)}, 'Sam Ortega') returning id`)[0]!.id;
  priya = (await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membershipOf(PRIYA_USER)}, 'Priya Nair') returning id`)[0]!.id;
  const created = await customers.create(owner(), {
    type: "residential", name: "Hollis Grant", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: "40 Pecan Ln", city: "Austin", state: "TX", postalCode: "78702", country: "US" } },
  });
  customerId = created.id as string;
  propertyId = (await raw<{ id: string }[]>`select id from public.property where organization_id = ${ORG}`)[0]!.id;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  processor = new FakeProcessor();
  await portalSettings.set(owner(), { tipping: { enabled: true, presets: [10, 15, 20] } });
  await payExtras.set(owner(), { tipSplit: "even" });
});

run("the office takes a tip with cash or a check", () => {
  it("records the payment on the invoice and the tip as owed to the crew, never as revenue, audited as any payment", async () => {
    const invoiceId = await invoiceFor("200.00");
    const payablesBefore = await accountNet("2250");
    const paid = await tips.payWithTip(owner(), { invoiceId, method: "cash", amount: "200.00", tip: "30.01" });
    expect(paid.tipAmount).toBe("30.0100");
    const [invoice] = await raw<{ status: string; balance: string }[]>`select status, balance::text from public.invoice where id = ${invoiceId}`;
    expect(invoice).toEqual({ status: "paid", balance: "0.0000" });
    /** Shared evenly to the cent, the odd cent landing where the portal's rule puts it. */
    const shares = await sharesOf(paid.id);
    expect(shares.map((s) => s.amount).sort()).toEqual(["15.0000", "15.0100"]);
    expect(shares.every((s) => s.split_rule === "even")).toBe(true);
    expect(Number(await accountNet("2250")) - Number(payablesBefore)).toBeCloseTo(30.01, 4);
    /** The invoice's tips list shows it, as one from the portal. */
    const listed = await tips.forInvoice(owner(), { invoiceId });
    expect(listed.tips.map((t) => t.amount)).toEqual(["30.0100"]);
    const [audit] = await raw<{ after: { tipAmount: string } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and action = 'payment.recorded' and entity_id = ${paid.id}`;
    expect(audit!.after.tipAmount).toBe("30.0100");
  });

  it("shares it by the company's own rule", async () => {
    await payExtras.set(owner(), { tipSplit: "lead" });
    const invoiceId = await invoiceFor("100.00", [priya, sam]);
    const paid = await tips.payWithTip(owner(), { invoiceId, method: "check", amount: "100.00", tip: "20", checkNumber: "1001" });
    expect((await sharesOf(paid.id)).map((s) => [s.technician_id, s.amount, s.split_rule])).toEqual([[priya, "20.0000", "lead"]]);
  });

  it("holds the tip to the portal's limits, in the same words", async () => {
    const invoiceId = await invoiceFor("120.00");
    await expect(tips.payWithTip(owner(), { invoiceId, method: "cash", amount: "120.00", tip: "1500" }))
      .rejects.toThrow("A tip can be at most the amount being paid, $120.00.");
    await expect(tips.payWithTip(owner(), { invoiceId, method: "cash", amount: "120.00", tip: "12.345" }))
      .rejects.toThrow("A tip is an amount in dollars and cents, like 15 or 12.50.");
    /** Measured against what goes on the bill, not what was handed over. */
    await expect(tips.payWithTip(owner(), { invoiceId, method: "cash", amount: "500.00", tip: "130" }))
      .rejects.toThrow("A tip can be at most the amount being paid, $120.00.");

    const nobody = await invoiceFor("80.00", []);
    await expect(tips.payWithTip(owner(), { invoiceId: nobody, method: "cash", amount: "80.00", tip: "10" }))
      .rejects.toThrow(/nobody to give a tip to/);

    await portalSettings.set(owner(), { tipping: { enabled: false, presets: [10, 15, 20] } });
    await expect(tips.payWithTip(owner(), { invoiceId, method: "cash", amount: "120.00", tip: "10" }))
      .rejects.toThrow("This company does not take tips with a payment. Record the payment without one.");
    const [{ n } = { n: "0" }] = await raw<{ n: string }[]>`select count(*)::text as n from public.payment_allocation where invoice_id = ${invoiceId}`;
    expect(n).toBe("0");
  });

  it("refuses a tip on an invoice somebody else pays", async () => {
    const invoiceId = await invoiceFor("90.00");
    const other = await customers.create(owner(), {
      type: "commercial", name: "Acme Home Warranty", paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
    });
    await raw`update public.invoice set payer_customer_id = ${other.id as string} where id = ${invoiceId}`;
    expect((await tips.officeOffer(owner(), { invoiceId })).available).toBe(false);
    await expect(tips.payWithTip(owner(), { invoiceId, method: "check", amount: "90.00", tip: "5" }))
      .rejects.toThrow(/paid by somebody other than the customer/);
  });

  it("answers a retry with the payment already recorded, and shares the tip once", async () => {
    const invoiceId = await invoiceFor("60.00");
    const first = await tips.payWithTip(owner("office-tip-retry-1"), { invoiceId, method: "cash", amount: "60.00", tip: "6" });
    const again = await tips.payWithTip(owner("office-tip-retry-1"), { invoiceId, method: "cash", amount: "60.00", tip: "6" });
    expect(again.id).toBe(first.id);
    expect(again.tipAmount).toBe("6.0000");
    expect(await sharesOf(first.id)).toHaveLength(2);
    const [{ n } = { n: "0" }] = await raw<{ n: string }[]>`select count(*)::text as n from public.payment where organization_id = ${ORG} and id in (${first.id})`;
    expect(n).toBe("1");
  });

  it("is taken only by somebody who takes payments", async () => {
    const invoiceId = await invoiceFor("50.00");
    await expect(tips.payWithTip(as(["dispatcher"]), { invoiceId, method: "cash", amount: "50.00", tip: "5" })).rejects.toThrow();
    await expect(tips.officeOffer(as(["dispatcher"]), { invoiceId })).rejects.toThrow();
  });
});

run("the office takes a tip with a card", () => {
  it("offers the company's percentages on the invoice for the crew by first name", async () => {
    const invoiceId = await invoiceFor("100.00");
    const offer = await tips.officeOffer(owner(), { invoiceId });
    expect(offer.available).toBe(true);
    expect(offer.presets.map((p) => p.amount)).toEqual(["10.0000", "15.0000", "20.0000"]);
    expect([...offer.for].sort()).toEqual(["Priya", "Sam"]);
  });

  it("charges the balance and the tip together, and shares the tip when the processor says it arrived", async () => {
    const invoiceId = await invoiceFor("100.00");
    const started = await payments.intent(owner(), { customerId, invoiceIds: [invoiceId], tip: "15" }, deps());
    expect(processor.charges.at(-1)!.amountMinor).toBe(11500);
    const connection = (await payments.connectionById(db(), connectionId))!;
    await payments.receive(db(), {
      connection,
      event: {
        eventId: `evt_office_tips_${Math.random().toString(36).slice(2)}`, kind: "succeeded", type: "payment_intent.succeeded",
        intentId: started.intentId, amountMinor: 11500, currency: "usd", feeMinor: null, refundedMinor: null, metadata: {}, failureMessage: null,
      },
    });
    const listed = await tips.forInvoice(owner(), { invoiceId });
    expect(listed.tips.map((t) => [t.amount, t.shares.length])).toEqual([["15.0000", 2]]);
  });

  it("refuses a card tip past the limits before anything is charged", async () => {
    const invoiceId = await invoiceFor("100.00");
    await expect(payments.intent(owner(), { customerId, invoiceIds: [invoiceId], tip: "1000" }, deps())).rejects.toThrow(ConflictError);
    expect(processor.charges).toHaveLength(0);
  });
});
