import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as invoiceDelivery from "../src/services/invoice-delivery";
import * as laborSettings from "../src/services/labor-settings";
import * as payments from "../src/services/payments";
import * as payroll from "../src/services/payroll";
import * as portal from "../src/services/portal";
import * as portalAccount from "../src/services/portal-account";
import * as portalSettings from "../src/services/portal-settings";
import * as tips from "../src/services/tips";
import type { ChargeOutcome, ChargeRequest, PaymentProvider, RefundOutcome } from "../src/payments/provider";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A TIP FROM THE PORTAL
 *
 * Offered only when the company has turned tipping on and somebody is
 * recorded on the job to receive it; charged with the balance; split evenly
 * between the technicians; held on the books as owed to them (Tips payable,
 * a liability) and never as revenue; shown on the invoice beside the
 * payments without being counted in them; on each technician's pay register
 * and export line for the period it arrived in; and cleared against cash
 * when payroll passes it on.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("tips:org");
const OWNER = fixtureId("tips:owner");
const SAM_USER = fixtureId("tips:sam");
const PRIYA_USER = fixtureId("tips:priya");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

class FakeProcessor implements PaymentProvider {
  readonly name = "stripe";
  readonly publishableKey = "pk_test_tips";
  charges: ChargeRequest[] = [];
  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.charges.push(request);
    return {
      ok: true,
      intent: {
        intentId: `pi_tips_${this.charges.length}_${Math.random().toString(36).slice(2)}`,
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

/** A job two technicians went out on, invoiced, with the customer's link to the invoice. */
async function tippableInvoice(total: string, crew: string[] = [sam, priya]) {
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
  const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId, scope: "invoice", subjectId: invoiceId, expiresInDays: 30,
  }));
  return { invoiceId, jobId: job.id as string, token: link.token };
}

/** Stripe saying the money arrived, the way the webhook route hands it over once the signature checks out. */
async function arrived(intentId: string, amountMinor: number) {
  const connection = (await payments.connectionById(db(), connectionId))!;
  return payments.receive(db(), {
    connection,
    event: {
      eventId: `evt_tips_${Math.random().toString(36).slice(2)}`, kind: "succeeded", type: "payment_intent.succeeded",
      intentId, amountMinor, currency: "usd", feeMinor: null, refundedMinor: null, metadata: {}, failureMessage: null,
    },
  });
}

async function accountNet(account: string): Promise<string> {
  const [row] = await raw<{ net: string }[]>`
    select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0)::numeric(14,4)::text as net
      from public.ledger_entry where organization_id = ${ORG} and account_code = ${account}`;
  return row!.net;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Tip Top Plumbing", slug: "tip-top-plumbing" });
  const [row] = await raw<{ id: string }[]>`
    insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', 'TEST_TIPS_KEY', ${raw.json({ publishableKey: "pk_test_tips" } as never)})
    returning id`;
  connectionId = row!.id;

  for (const [id, email] of [[SAM_USER, "tips-sam@test.local"], [PRIYA_USER, "tips-priya@test.local"]]) {
    await raw`insert into public."user" (id, email) values (${id!}, ${email!}) on conflict (id) do nothing`;
    await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id!}, 'technician')`;
  }
  const memberships = await raw<{ id: string; user_id: string }[]>`
    select id, user_id from public.membership where organization_id = ${ORG}`;
  const membershipOf = (userId: string) => memberships.find((m) => m.user_id === userId)!.id;
  sam = (await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, wage_classification)
    values (${ORG}, ${membershipOf(SAM_USER)}, 'Sam Ortega', 'Journeyman') returning id`)[0]!.id;
  priya = (await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, wage_classification)
    values (${ORG}, ${membershipOf(PRIYA_USER)}, 'Priya Nair', 'Journeyman') returning id`)[0]!.id;

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
});

run("offering a tip", () => {
  it("is off until the company turns it on, and a tip is then refused before anything is charged", async () => {
    await portalSettings.set(owner(), { tipping: { enabled: false, presets: [10, 15, 20] } });
    const { token } = await tippableInvoice("200.00");
    expect((await invoiceDelivery.viewInvoice(db(), { token })).tipping.available).toBe(false);
    await expect(invoiceDelivery.startPayment(db(), { token, tip: "20.00" }, undefined, deps())).rejects.toThrow(ConflictError);
    expect(processor.charges).toHaveLength(0);
    // No tip at all still pays.
    await invoiceDelivery.startPayment(db(), { token }, undefined, deps());
    expect(processor.charges[0]!.amountMinor).toBe(20000);
  });

  it("offers the company's percentages of the balance, for the technicians by first name", async () => {
    const { token } = await tippableInvoice("259.11");
    const view = await invoiceDelivery.viewInvoice(db(), { token });
    expect(view.tipping).toEqual({
      available: true,
      presets: [
        { percent: 10, amount: "25.9100" }, { percent: 15, amount: "38.8700" }, { percent: 20, amount: "51.8200" },
      ],
      // In the order the crew is read, which is by technician id, so the same page reads the same way twice.
      for: [sam, priya].sort().map((id) => (id === sam ? "Sam" : "Priya")),
    });
  });

  it("is not offered, and is refused, on work nobody is recorded as having done", async () => {
    const { token } = await tippableInvoice("120.00", []);
    expect((await invoiceDelivery.viewInvoice(db(), { token })).tipping.available).toBe(false);
    await expect(invoiceDelivery.startPayment(db(), { token, tip: "10" }, undefined, deps())).rejects.toThrow(/nobody to give a tip to/);
  });

  it("refuses a tip larger than the bill, a stray zero being the usual cause", async () => {
    const { token } = await tippableInvoice("120.00");
    await expect(invoiceDelivery.startPayment(db(), { token, tip: "1500" }, undefined, deps())).rejects.toThrow(ConflictError);
    await expect(invoiceDelivery.startPayment(db(), { token, tip: "-5" }, undefined, deps())).rejects.toThrow(ConflictError);
  });

  it("is offered from the account link too, per invoice owed", async () => {
    const { invoiceId } = await tippableInvoice("80.00");
    const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
      organizationId: ORG, customerId, scope: "customer", expiresInDays: 30,
    }));
    const account = await portalAccount.viewAccount(db(), { token: link.token });
    expect(account.invoices.find((i) => i.id === invoiceId)?.tipping.available).toBe(true);
    const started = await portalAccount.startInvoicePayment(db(), { token: link.token, invoiceId, tip: "8.00" }, undefined, deps());
    expect(started).toMatchObject({ amount: "88.0000", tip: "8.0000" });
  });
});

run("a tip that arrived", () => {
  it("charges the balance and the tip, pays the invoice with the balance, and holds the tip for the technicians", async () => {
    const { invoiceId, jobId, token } = await tippableInvoice("200.00");
    const tipsPayableBefore = await accountNet("2250");
    const revenueBefore = await accountNet("4000");

    const started = await invoiceDelivery.startPayment(db(), { token, tip: "15.00" }, undefined, deps());
    expect(started).toMatchObject({ amount: "215.0000", tip: "15.0000" });
    expect(processor.charges[0]!.amountMinor).toBe(21500);

    const settled = await arrived(started.intentId, 21500);
    expect(settled.handled).toBe(true);

    const [payment] = await raw<{ id: string; amount: string; tip_amount: string }[]>`
      select id, amount, tip_amount from public.payment where id = ${settled.paymentId!}`;
    expect(payment).toMatchObject({ amount: "200.0000", tip_amount: "15.0000" });

    const [invoice] = await raw<{ status: string; balance: string; amount_paid: string }[]>`
      select status, balance, amount_paid from public.invoice where id = ${invoiceId}`;
    expect(invoice).toEqual({ status: "paid", balance: "0.0000", amount_paid: "200.0000" });

    // On the books: owed to the technicians, and not one cent of it revenue.
    const legs = await raw<{ account_code: string; direction: string; amount: string }[]>`
      select account_code, direction, amount from public.ledger_entry
       where organization_id = ${ORG} and source_type = 'payment' and source_id = ${payment!.id}
       order by account_code`;
    expect(legs).toContainEqual({ account_code: "2250", direction: "credit", amount: "15.0000" });
    expect(legs).toContainEqual({ account_code: "1000", direction: "debit", amount: "215.0000" });
    expect(legs.some((l) => l.account_code.startsWith("4"))).toBe(false);
    expect(await accountNet("2250")).toBe((Number(tipsPayableBefore) + 15).toFixed(4));
    expect(await accountNet("4000")).toBe(revenueBefore);

    // Split evenly, to the cent, between the two who went out.
    const shares = await raw<{ technician_id: string; amount: string; job_id: string; invoice_id: string }[]>`
      select technician_id, amount, job_id, invoice_id from public.tip_share where payment_id = ${payment!.id}
      order by technician_id`;
    expect(shares).toHaveLength(2);
    expect(shares.map((s) => s.amount)).toEqual(["7.5000", "7.5000"]);
    expect(shares.map((s) => s.technician_id).sort()).toEqual([sam, priya].sort());
    expect(shares.every((s) => s.job_id === jobId && s.invoice_id === invoiceId)).toBe(true);

    // On the invoice the customer sees: beside the payment, not inside it.
    const view = await invoiceDelivery.viewInvoice(db(), { token });
    expect(view.payments.map((p) => p.amount)).toEqual(["200.0000"]);
    expect(view.tips.map((t) => t.amount)).toEqual(["15.0000"]);

    // And on the office's.
    const office = await tips.forInvoice(owner(), { invoiceId });
    expect(office.tips[0]!.amount).toBe("15.0000");
    expect(office.tips[0]!.shares.map((s) => s.technicianName).sort()).toEqual(["Priya Nair", "Sam Ortega"]);
  });

  it("pays the bill first when less arrived than was asked for", async () => {
    const { invoiceId, token } = await tippableInvoice("100.00");
    const started = await invoiceDelivery.startPayment(db(), { token, tip: "15.00" }, undefined, deps());
    const settled = await arrived(started.intentId, 10500);
    const [payment] = await raw<{ amount: string; tip_amount: string }[]>`
      select amount, tip_amount from public.payment where id = ${settled.paymentId!}`;
    expect(payment).toEqual({ amount: "100.0000", tip_amount: "5.0000" });
    const [invoice] = await raw<{ status: string }[]>`select status from public.invoice where id = ${invoiceId}`;
    expect(invoice!.status).toBe("paid");
    const shares = await raw<{ amount: string }[]>`select amount from public.tip_share where invoice_id = ${invoiceId}`;
    expect(shares.map((s) => s.amount).sort()).toEqual(["2.5000", "2.5000"]);
  });

  it("is written once when the processor's event is delivered twice", async () => {
    const { invoiceId, token } = await tippableInvoice("60.00");
    const started = await invoiceDelivery.startPayment(db(), { token, tip: "6.00" }, undefined, deps());
    const connection = (await payments.connectionById(db(), connectionId))!;
    const event = {
      eventId: `evt_twice_${Math.random().toString(36).slice(2)}`, kind: "succeeded" as const, type: "payment_intent.succeeded",
      intentId: started.intentId, amountMinor: 6600, currency: "usd", feeMinor: null, refundedMinor: null,
      metadata: {}, failureMessage: null,
    };
    await payments.receive(db(), { connection, event });
    const again = await payments.receive(db(), { connection, event });
    expect(again.handled).toBe(false);
    const shares = await raw`select 1 from public.tip_share where invoice_id = ${invoiceId}`;
    expect(shares).toHaveLength(2);
  });
});

run("passing tips on through payroll", () => {
  const START = "2026-01-05";

  beforeEach(async () => {
    await raw`delete from public.payroll_export where organization_id = ${ORG}`;
    await raw`delete from public.pay_period_close where organization_id = ${ORG}`;
    await raw`update public.tip_share set paid_in_period_id = null, paid_at = null where organization_id = ${ORG}`;
    await raw`delete from public.pay_period where organization_id = ${ORG}`;
    await raw`delete from public.overtime_policy where organization_id = ${ORG}`;
    await raw`delete from public.wage_scale where organization_id = ${ORG}`;
    await laborSettings.setScale(owner(), {
      classification: "Journeyman", baseRate: "40.00", fringeRate: "0", effectiveFrom: "2026-01-01",
    });
    await laborSettings.setPolicy(owner(), {
      label: "Federal", timeZone: "America/Chicago", weekStartsOn: 1,
      dayAttribution: "shift_start", weeklyThresholdMinutes: 2400,
      overtimeMultiplier: "1.5", doubleTimeMultiplier: "2",
      onCallTreatment: "separate_rate_not_hours_worked",
      note: "Forty hours a week at time and a half.",
    });
    // Every tip from the tests above, moved before the period so only this test's tip is inside it.
    await raw`update public.tip_share set occurred_at = '2025-12-01T18:00:00Z', paid_at = now()
               where organization_id = ${ORG}`;
  });

  it("is a line on each technician's register and export, and paying it out clears what is owed against cash", async () => {
    const { token } = await tippableInvoice("300.00");
    const started = await invoiceDelivery.startPayment(db(), { token, tip: "45.00" }, undefined, deps());
    const settled = await arrived(started.intentId, 34500);
    // Arrived inside the fortnight, which has finished, so it can be closed.
    await raw`update public.tip_share set occurred_at = '2026-01-07T18:00:00Z' where payment_id = ${settled.paymentId!}`;
    const invoiceNumber = (await raw<{ number: number }[]>`
      select i.number from public.invoice i join public.tip_share t on t.invoice_id = i.id
       where t.payment_id = ${settled.paymentId!} limit 1`)[0]!.number;

    const period = await payroll.declarePeriod(owner(), { label: "Fortnight to 18 January", startDate: START, weeks: 2 });
    const register = await payroll.register(owner(), { periodId: period.id });
    for (const name of ["Sam Ortega", "Priya Nair"]) {
      const row = register.rows.find((r) => r.technicianName === name)!;
      expect(row.lines.filter((l) => l.kind === "tip"))
        .toEqual([expect.objectContaining({ label: `Tip, invoice ${invoiceNumber}`, amount: "22.5000" })]);
      expect(row.gross).toBe("22.5000");
    }

    await payroll.closePeriod(owner(), { periodId: period.id });
    const exported = await payroll.exportPeriod(owner(), { periodId: period.id });
    const tipLines = exported.content.split("\n").filter((line) => line.includes(",tip,"));
    expect(tipLines).toHaveLength(2);
    expect(tipLines.every((line) => line.endsWith(",22.5000"))).toBe(true);

    const owedBefore = Number(await accountNet("2250"));
    const paid = await payroll.payTips(owner(), { periodId: period.id });
    expect(paid.total).toBe("45.0000");
    expect(paid.people.map((p) => p.amount)).toEqual(["22.5000", "22.5000"]);
    expect(Number(await accountNet("2250"))).toBeCloseTo(owedBefore - 45, 4);
    const legs = await raw<{ account_code: string; direction: string; amount: string }[]>`
      select account_code, direction, amount from public.ledger_entry
       where organization_id = ${ORG} and source_type = 'tip_payout' and source_id = ${period.id} order by account_code`;
    expect(legs).toEqual([
      { account_code: "1000", direction: "credit", amount: "45.0000" },
      { account_code: "2250", direction: "debit", amount: "45.0000" },
    ]);

    // Run again, nothing is paid twice.
    expect((await payroll.payTips(owner(), { periodId: period.id })).total).toBe("0.0000");
  });

  it("refuses to pay out of a period that is still open", async () => {
    const period = await payroll.declarePeriod(owner(), { label: "Fortnight to 18 January", startDate: START, weeks: 2 });
    await expect(payroll.payTips(owner(), { periodId: period.id })).rejects.toThrow(ConflictError);
  });

  it("notices a tip that arrived inside a period after it was closed, and refuses the export", async () => {
    const period = await payroll.declarePeriod(owner(), { label: "Fortnight to 18 January", startDate: START, weeks: 2 });
    await payroll.closePeriod(owner(), { periodId: period.id });
    const { token } = await tippableInvoice("90.00");
    const started = await invoiceDelivery.startPayment(db(), { token, tip: "9.00" }, undefined, deps());
    const settled = await arrived(started.intentId, 9900);
    await raw`update public.tip_share set occurred_at = '2026-01-08T18:00:00Z' where payment_id = ${settled.paymentId!}`;
    await expect(payroll.exportPeriod(owner(), { periodId: period.id })).rejects.toThrow(/changed after it was closed/);
  });
});
