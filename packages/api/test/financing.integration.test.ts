import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as financing from "../src/services/financing";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import * as portal from "../src/services/portal";
import type { ServiceContext } from "../src/services/context";
import { wisetackProvider, verifyWisetackSignature, SIGNATURE_HEADER, statusOf } from "../src/financing/wisetack";
import { fakeLender, type FakeLender } from "./financing-fake";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";
import { createHmac } from "node:crypto";

/**
 * CONSUMER FINANCING, FROM THE OFFER TO THE MONEY
 *
 * The property most of this file is about is the one the payments tests are
 * about: nothing records money except a verified delivery, and then only once.
 * A lender's webhook is checked, the application is read back from the lender
 * (a fake here), and only the lender's own answer is applied, forward only.
 * When it says funded, the payment lands on the invoice through the ordinary
 * payments path with the lender's fee as an expense, exactly once however many
 * deliveries say so.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("financing:org");
const USER = fixtureId("financing:user");
const HOOK_REF = "TEST_LENDER_WEBHOOK";
const SECRET = "lender-signing-value-for-tests";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...extra,
});
const owner = (extra: Partial<ServiceContext> = {}) => as(["owner"], extra);

let lender: FakeLender;
const deps = (): financing.FinancingDeps => ({
  readSecret: async (ref) => (ref === HOOK_REF ? SECRET : "api-token-not-real"),
  provider: lender,
});

let connectionId = "";
let customerId = "";
let propertyId = "";

async function connect(settings: Record<string, unknown> = {}) {
  const [row] = await raw`
    insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'financing', 'wisetack', 'connected', 'TEST_LENDER_TOKEN',
            ${raw.json({ merchantId: "m_1", webhookSecretRef: HOOK_REF, plans: ["60@17.9"], ...settings } as never)})
    returning id`;
  connectionId = (row as { id: string }).id;
}

async function invoiceFor(total: string) {
  const invoice = await billing.create(owner(), {
    customerId,
    lines: [{ name: "Furnace replacement", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  return invoice.id as string;
}

async function account(code: string): Promise<string> {
  const [row] = await raw`
    select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::numeric(14,4)::text as net
    from public.ledger_entry where organization_id = ${ORG} and account_code = ${code}`;
  return (row as { net: string }).net;
}

const deliver = (externalId: string, eventId: string, status = "approved", secret = SECRET) =>
  financing.receiveWebhook(db(), { connectionId, request: lender.event(externalId, eventId, secret, status) }, deps());

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Lender Co", slug: "lender-co" });
  lender = fakeLender();
  const [c] = await raw`insert into public.customer (organization_id, name, phone, email)
    values (${ORG}, 'Jamie Ortiz', '+15125550199', 'jamie@example.com') returning id`;
  customerId = (c as { id: string }).id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Elm St', 'Austin', 'TX', '78702') returning id`;
  propertyId = (p as { id: string }).id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
    values (${ORG}, ${customerId}, ${propertyId})`;
  await connect();
});

run("the offer", () => {
  it("shows as low as for the balance, with subject to approval in the same sentence", async () => {
    const invoiceId = await invoiceFor("12500.00");
    const view = await financing.forInvoice(owner(), { invoiceId }, deps());
    expect(view.connected).toBe(true);
    expect(view.applicable).toBe(true);
    expect(view.offer?.monthly).toBe("316.7400");
    expect(view.offer?.sentence).toContain("Subject to approval");
    expect(view.applications).toEqual([]);
  });

  it("offers nothing on an amount the lender does not finance", async () => {
    const invoiceId = await invoiceFor("120.00");
    const view = await financing.forInvoice(owner(), { invoiceId }, deps());
    expect(view.offer).toBeNull();
    expect(view.applicable).toBe(false);
    await expect(financing.send(owner(), { invoiceId, channel: "link" }, deps())).rejects.toThrow(/finances from \$500/);
  });

  it("hides the figure when the company turned it off, and keeps the link", async () => {
    await raw`update public.integration_connection set settings = settings || '{"showMonthly": false}'::jsonb where id = ${connectionId}`;
    const invoiceId = await invoiceFor("2000.00");
    const view = await financing.forInvoice(owner(), { invoiceId }, deps());
    expect(view.offer).toBeNull();
    expect(view.applicable).toBe(true);
  });
});

run("opening an application", () => {
  it("reads the amount from the invoice, reuses a live application, and replays a retried request", async () => {
    const invoiceId = await invoiceFor("4800.00");
    const first = await financing.send(owner({ idempotencyKey: "send-1" }), { invoiceId, channel: "link" }, deps());
    expect(first.reused).toBe(false);
    expect(first.application.amount).toBe("4800.0000");
    expect(first.application.status).toBe("sent");
    expect(lender.opened).toHaveLength(1);
    expect(lender.opened[0]!.amountMinor).toBe(480000);
    expect(lender.opened[0]!.customer.lastName).toBe("Ortiz");

    const replay = await financing.send(owner({ idempotencyKey: "send-1" }), { invoiceId, channel: "link" }, deps());
    expect(replay.application.id).toBe(first.application.id);

    const again = await financing.send(owner(), { invoiceId, channel: "link" }, deps());
    expect(again.reused).toBe(true);
    expect(lender.opened).toHaveLength(1);
  });

  it("refuses a role that does not take payments", async () => {
    const invoiceId = await invoiceFor("4800.00");
    await expect(financing.send(as(["dispatcher"]), { invoiceId, channel: "link" }, deps())).rejects.toThrow();
  });

  it("records a text that cannot go as a refusal, not a failure", async () => {
    const invoiceId = await invoiceFor("4800.00");
    const sent = await financing.send(owner(), { invoiceId, channel: "sms" }, deps());
    expect(sent.delivery?.sent).toBe(false);
    expect(sent.application.sentVia).toBe("sms");
  });

  it("opens one from the customer's own invoice link, which is not spent by it", async () => {
    const invoiceId = await invoiceFor("3000.00");
    const { url: link } = await portal.issueGrant(owner(), { customerId, scope: "invoice", subjectId: invoiceId, expiresInDays: 30 });
    const token = link.split("/").pop()!;
    const offer = await financing.portalInvoice(db(), { token }, deps());
    expect(offer?.offer?.sentence).toContain("Subject to approval");
    const applied = await financing.applyFromLink(db(), { token }, deps());
    expect(applied.url).toMatch(/^https:\/\/lender\.test\/apply\//);
    const after = await financing.portalInvoice(db(), { token }, deps());
    expect(after?.application?.status).toBe("sent");
  });

  it("finances the chosen option of an estimate, and asks which when there are several", async () => {
    const created = await estimates.create(owner(), {
      customerId, propertyId, taxRate: "0",
      options: [
        { name: "Repair", isRecommended: false, lines: [{ name: "Repair", quantity: "1", unitPrice: "900.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }] },
        { name: "Replace", isRecommended: true, lines: [{ name: "Replace", quantity: "1", unitPrice: "9000.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }] },
      ],
    }) as Record<string, unknown>;
    const estimateId = created["id"] as string;
    await raw`update public.estimate set status = 'sent' where id = ${estimateId}`;
    await expect(financing.send(owner(), { estimateId, channel: "link" }, deps())).rejects.toThrow(/Choose which option/);
    const view = await financing.forEstimate(owner(), { estimateId }, deps());
    const replace = view.options.find((o) => o.name === "Replace")!;
    expect(replace.offer?.monthly).toBe("228.0600");
    const sent = await financing.send(owner(), { estimateId, optionId: replace.optionId, channel: "link" }, deps());
    expect(sent.application.amount).toBe("9000.0000");
    expect(sent.application.estimateNumber).not.toBeNull();
  });
});

run("the lender's webhook", () => {
  it("refuses a delivery whose signature is wrong, and changes nothing", async () => {
    const invoiceId = await invoiceFor("4800.00");
    const { application } = await financing.send(owner(), { invoiceId, channel: "link" }, deps());
    const external = `fake_${application.id}`;
    lender.set(external, { status: "funded", fundedAmountMinor: 480000, feeMinor: 19200 });

    const forged = await deliver(external, "evt_forged", "funded", "not-the-secret");
    expect(forged.status).toBe(401);
    expect(lender.reads).toBe(0);
    const [row] = await raw`select status, payment_id from public.financing_application where id = ${application.id}`;
    expect(row).toMatchObject({ status: "sent", payment_id: null });
  });

  it("answers an unknown connection 404, a missing secret 409 and an unreadable body 422", async () => {
    const unknown = await financing.receiveWebhook(db(), {
      connectionId: fixtureId("no-such-connection"), request: { headers: {}, body: "{}" },
    }, deps());
    expect(unknown.status).toBe(404);

    const body = "not json";
    const signed = { headers: { "x-fake-lender-signature": createHmac("sha256", SECRET).update(body).digest("hex") }, body };
    const unreadable = await financing.receiveWebhook(db(), { connectionId, request: signed }, deps());
    expect(unreadable.status).toBe(422);

    await raw`update public.integration_connection set settings = settings - 'webhookSecretRef' where id = ${connectionId}`;
    const unsecured = await deliver("fake_x", "evt_1");
    expect(unsecured.status).toBe(409);
  });

  it("follows the application to funded, and posts the payment and the fee once", async () => {
    const invoiceId = await invoiceFor("4800.00");
    const { application } = await financing.send(owner(), { invoiceId, channel: "link" }, deps());
    const external = `fake_${application.id}`;

    lender.set(external, { status: "applied", rawStatus: "INITIATED" });
    expect((await deliver(external, "evt_1", "applied")).body["status"]).toBe("applied");

    lender.set(external, {
      status: "approved", rawStatus: "LOAN_TERMS_ACCEPTED", approvedAmountMinor: 480000,
      chosenOffer: { months: 60, aprPercent: "17.9", monthlyPaymentMinor: 12163 },
    });
    await deliver(external, "evt_2", "approved");
    const [approved] = await raw`select status, approved_amount::text, chosen_offer from public.financing_application where id = ${application.id}`;
    expect(approved).toMatchObject({ status: "approved", approved_amount: "4800.0000" });
    expect((approved as { chosen_offer: { months: number } }).chosen_offer.months).toBe(60);

    lender.set(external, { status: "funded", rawStatus: "SETTLED", fundedAmountMinor: 480000, feeMinor: 19200 });
    const funded = await deliver(external, "evt_3", "funded");
    expect(funded.status).toBe(200);
    expect(funded.body["status"]).toBe("funded");
    const paymentId = funded.body["paymentId"] as string;
    expect(paymentId).toBeTruthy();

    const [payment] = await raw`select method, amount::text, fee_amount::text, processor, processor_payment_id from public.payment where id = ${paymentId}`;
    expect(payment).toMatchObject({
      method: "financing", amount: "4800.0000", fee_amount: "192.0000", processor: "wisetack", processor_payment_id: external,
    });
    const invoice = await billing.get(owner(), { id: invoiceId });
    expect(invoice.status).toBe("paid");
    expect(await account("1000")).toBe("4608.0000");
    expect(await account("6100")).toBe("192.0000");
    expect(await account("1200")).toBe("0.0000");

    const [row] = await raw`select funded_amount::text, fee_amount::text, payment_id from public.financing_application where id = ${application.id}`;
    expect(row).toMatchObject({ funded_amount: "4800.0000", fee_amount: "192.0000", payment_id: paymentId });

    /** The same delivery again, and a second one saying the same thing: one payment. */
    const duplicate = await deliver(external, "evt_3", "funded");
    expect(duplicate.body["note"]).toBe("already handled");
    await deliver(external, "evt_4", "funded");
    const payments = await raw`select id from public.payment where organization_id = ${ORG}`;
    expect(payments).toHaveLength(1);
    expect(await account("6100")).toBe("192.0000");
  });

  it("does not step back on a late delivery, and flags money going back after funding", async () => {
    const invoiceId = await invoiceFor("1500.00");
    const { application } = await financing.send(owner(), { invoiceId, channel: "link" }, deps());
    const external = `fake_${application.id}`;
    lender.set(external, { status: "funded", fundedAmountMinor: 150000, feeMinor: 6000 });
    await deliver(external, "evt_a", "funded");

    lender.set(external, { status: "approved" });
    const late = await deliver(external, "evt_b", "approved");
    expect(late.body["status"]).toBe("funded");

    lender.set(external, { status: "cancelled", rawStatus: "REFUNDED" });
    await deliver(external, "evt_c", "cancelled");
    const [row] = await raw`select status, attention from public.financing_application where id = ${application.id}`;
    expect((row as { status: string }).status).toBe("funded");
    expect((row as { attention: string }).attention).toContain("record the refund");
  });

  it("books no fee it was not told, and says so", async () => {
    const invoiceId = await invoiceFor("1500.00");
    const { application } = await financing.send(owner(), { invoiceId, channel: "link" }, deps());
    const external = `fake_${application.id}`;
    lender.set(external, { status: "funded", fundedAmountMinor: 150000, feeMinor: null });
    await deliver(external, "evt_n", "funded");
    expect(await account("6100")).toBe("0.0000");
    const [row] = await raw`select fee_amount, attention from public.financing_application where id = ${application.id}`;
    expect((row as { fee_amount: string | null }).fee_amount).toBeNull();
    expect((row as { attention: string }).attention).toContain("did not say what fee");
  });

  it("asks the lender again when it could not be reached, rather than recording the delivery", async () => {
    const invoiceId = await invoiceFor("1500.00");
    const { application } = await financing.send(owner(), { invoiceId, channel: "link" }, deps());
    lender.failReads = true;
    const down = await deliver(`fake_${application.id}`, "evt_down", "approved");
    expect(down.status).toBe(503);
    lender.failReads = false;
    lender.set(`fake_${application.id}`, { status: "approved" });
    const retried = await deliver(`fake_${application.id}`, "evt_down", "approved");
    expect(retried.body["status"]).toBe("approved");
  });

  it("holds an estimate's loan on the customer's account until there is an invoice", async () => {
    const created = await estimates.create(owner(), {
      customerId, propertyId, taxRate: "0",
      options: [{ name: "Only", isRecommended: true, lines: [{ name: "Install", quantity: "1", unitPrice: "6000.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }] }],
    }) as Record<string, unknown>;
    await raw`update public.estimate set status = 'approved' where id = ${created["id"] as string}`;
    const { application } = await financing.send(owner(), { estimateId: created["id"] as string, channel: "link" }, deps());
    lender.set(`fake_${application.id}`, { status: "funded", fundedAmountMinor: 600000, feeMinor: 24000 });
    await deliver(`fake_${application.id}`, "evt_e", "funded");
    expect(await account("2300")).toBe("-6000.0000");
    expect(await account("6100")).toBe("240.0000");
  });

  it("lets the office ask the lender itself", async () => {
    const invoiceId = await invoiceFor("1500.00");
    const { application } = await financing.send(owner(), { invoiceId, channel: "link" }, deps());
    lender.set(`fake_${application.id}`, { status: "declined", rawStatus: "DECLINED" });
    const view = await financing.refresh(owner(), { applicationId: application.id }, deps());
    expect(view.status).toBe("declined");
  });
});

run("the financing report", () => {
  it("counts applications, the approval rate over decisions, funded volume and fees", async () => {
    const ids: string[] = [];
    for (const total of ["1000.00", "2000.00", "3000.00", "4000.00"]) {
      const invoiceId = await invoiceFor(total);
      ids.push((await financing.send(owner(), { invoiceId, channel: "link" }, deps())).application.id);
    }
    lender.set(`fake_${ids[0]}`, { status: "funded", fundedAmountMinor: 100000, feeMinor: 4000 });
    await deliver(`fake_${ids[0]}`, "r1", "funded");
    lender.set(`fake_${ids[1]}`, { status: "approved" });
    await deliver(`fake_${ids[1]}`, "r2", "approved");
    lender.set(`fake_${ids[2]}`, { status: "declined" });
    await deliver(`fake_${ids[2]}`, "r3", "declined");

    const report = await financing.report(owner(), {});
    expect(report.applications).toBe(4);
    expect(report.decided).toBe(3);
    expect(report.approvalRate).toBe(66.7);
    expect(report.fundedVolume).toBe("1000.0000");
    expect(report.fees).toBe("40.0000");
    expect(report.feePercent).toBe(4);
    expect(report.pendingVolume).toBe("6000.0000");
    await expect(financing.report(as(["office_manager"]), {})).rejects.toThrow();
  });
});

describe("the Wisetack adapter", () => {
  it("verifies an HMAC of the raw body, and nothing else", () => {
    const body = JSON.stringify({ messageId: "m1", transactionId: "t1", changedStatus: "AUTHORIZED" });
    const good = createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifyWisetackSignature({ headers: { [SIGNATURE_HEADER]: good }, body }, "s3cret")).toBe(true);
    expect(verifyWisetackSignature({ headers: { [SIGNATURE_HEADER]: `sha256=${good}` }, body }, "s3cret")).toBe(true);
    expect(verifyWisetackSignature({ headers: { [SIGNATURE_HEADER]: good }, body: `${body} ` }, "s3cret")).toBe(false);
    expect(verifyWisetackSignature({ headers: {}, body }, "s3cret")).toBe(false);
    expect(verifyWisetackSignature({ headers: { [SIGNATURE_HEADER]: good }, body }, "")).toBe(false);
  });

  it("reads a delivery and Wisetack's statuses in our words", () => {
    const provider = wisetackProvider({ merchantId: "m", plans: ["60@17.9", "nonsense"], minAmount: "500" }, "t");
    expect(provider.parseEvent({ headers: {}, body: JSON.stringify({ messageId: "m1", transactionId: "t1", changedStatus: "SETTLED" }) }))
      .toMatchObject({ eventId: "m1", externalId: "t1", reportedStatus: "funded" });
    expect(provider.parseEvent({ headers: {}, body: "{}" })).toBeNull();
    expect(provider.terms().plans).toEqual([{ months: 60, aprPercent: "17.9" }]);
    expect(statusOf("LOAN_TERMS_ACCEPTED")).toBe("approved");
    expect(statusOf("SOMETHING_NEW")).toBeNull();
  });

  it("refuses to call Wisetack without a merchant id", async () => {
    const provider = wisetackProvider({}, "t");
    const outcome = await provider.readApplication("t1");
    expect(outcome.ok).toBe(false);
  });
});
