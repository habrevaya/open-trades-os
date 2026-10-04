import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { PermissionError, time, type Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as booking from "../src/services/booking";
import * as contacts from "../src/services/contacts";
import * as customers from "../src/services/customers";
import * as payments from "../src/services/payments";
import * as portal from "../src/services/portal";
import * as portalAccess from "../src/services/portal-access";
import * as portalAccount from "../src/services/portal-account";
import * as portalBlocks from "../src/services/portal-blocks";
import * as portalBooking from "../src/services/portal-booking";
import * as portalSignIn from "../src/services/portal-sign-in";
import * as savedCards from "../src/services/saved-cards";
import * as agentIntake from "../src/services/agent-intake";
import { applyTradePack } from "../src/services/trade-pack";
import type {
  CardSetup, CardVault, ChargeOutcome, ChargeRequest, PaymentEvent, PaymentProvider, RefundOutcome,
} from "../src/payments/provider";
import {
  ConflictError, InvalidGrantError, NotFoundError, OrganizationSuspendedError,
  SignInRefusedError, type ServiceContext,
} from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * THE CUSTOMER SIDE, SEEN FROM BOTH ENDS
 *
 * Who may sign in to a customer's account and what the office can see and
 * end of it; the company's look on the sign in page and nothing else of it;
 * a bank payment's slow money, pending, failed and settled, through a fake
 * processor that records what it was asked; what a customer sees of the
 * work itself, laid out by the company's trade pack; and windows offered
 * from the technicians' real days rather than a number somebody typed in.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-access:org");
const USER = fixtureId("portal-access:user");
const OTHER_ORG = fixtureId("portal-access:other-org");
const OTHER_USER = fixtureId("portal-access:other-user");
const SLUG = "portal-access-pest";
const OTHER_SLUG = "portal-access-other";
const ZONE = "America/Chicago";

const RUN = Date.now().toString(36);
const DANA = `dana.${RUN}@portal-access.test`;
const SAM = `sam.${RUN}@portal-access.test`;
const TENANT = `tenant.${RUN}@portal-access.test`;

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], org = ORG, user = USER): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let ipSeq = 0;
const ip = () => `203.0.${Math.floor(Math.random() * 250)}.${(ipSeq += 1) % 250}`;

let dana = "";
let danaProperty = "";
let sam = "";
let ray = "";
let lee = "";
let connectionId = "";

async function aCustomer(name: string, email: string | null) {
  const c = await customers.create(owner(), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    ...(email ? { email } : {}),
  });
  const [p] = await raw<{ id: string }[]>`insert into public.property
    (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, ${`${name.length} Pecan St`}, 'Austin', 'TX', '78704') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, is_primary)
    values (${ORG}, ${c.id}, ${p!.id}, true)`;
  return { id: c.id as string, propertyId: p!.id };
}

async function technician(key: string, name: string) {
  const userId = fixtureId(`portal-access:tech:${key}`);
  await raw`delete from public."user" where id = ${userId} or email = ${`${key}.${RUN}@portal-access.test`}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${key}.${RUN}@portal-access.test`}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id;
}

/** The newest code emailed to an address, read off the outbox. */
async function codeSentTo(address: string): Promise<string | null> {
  const [row] = await raw<{ body: string }[]>`
    select body from public.message
     where organization_id = ${ORG} and to_address = ${address} and direction = 'outbound'
     order by created_at desc limit 1`;
  return /\b(\d{6})\b/.exec(row?.body ?? "")?.[1] ?? null;
}

async function signIn(address: string): Promise<string> {
  await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address }, { ip: ip() });
  const code = await codeSentTo(address);
  if (!code) throw new Error(`No code went to ${address}`);
  const verdict = await portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address, code }, { ip: ip() });
  if (verdict.status !== "signed_in") throw new Error("expected to sign in");
  return verdict.token;
}

let jobNumber = 9000;
/** A job with one visit, straight into the tables, the way the field app leaves it. */
async function aVisit(input: {
  customerId: string; propertyId: string; summary: string; start: Date; minutes?: number;
  status?: string; technicianId?: string | null; technicianNotes?: string | null;
}) {
  jobNumber += 1;
  const [job] = await raw<{ id: string }[]>`insert into public.job
    (organization_id, number, customer_id, property_id, summary, status)
    values (${ORG}, ${jobNumber}, ${input.customerId}, ${input.propertyId}, ${input.summary}, 'scheduled') returning id`;
  const end = new Date(input.start.getTime() + (input.minutes ?? 60) * 60_000);
  const status = input.status ?? "scheduled";
  const [visit] = await raw<{ id: string }[]>`insert into public.visit
    (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes, technician_notes, completed_at)
    values (${ORG}, ${job!.id}, ${status}::visit_status, ${input.start}, ${end}, ${input.minutes ?? 60},
            ${input.technicianNotes ?? null}, ${status === "completed" ? end : null}) returning id`;
  if (input.technicianId) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
      values (${ORG}, ${visit!.id}, ${input.technicianId}, true)`;
  }
  return { jobId: job!.id, visitId: visit!.id };
}

/** Stripe, as far as these services can tell: a bank debit comes back processing. */
class FakeStripe implements PaymentProvider {
  readonly name = "stripe";
  readonly publishableKey = "pk_test_bank";
  charges: ChargeRequest[] = [];
  setups = new Map<string, CardSetup>();

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.charges.push(request);
    return {
      ok: true,
      intent: {
        intentId: `pi_bank_${RUN}_${this.charges.length}_${Math.random().toString(36).slice(2, 10)}`, clientSecret: "pi_secret",
        amountMinor: request.amountMinor, currency: "usd",
        status: request.methodKind === "bank_account" ? "processing" : "succeeded",
      },
    };
  }

  async refund(): Promise<RefundOutcome> {
    return { ok: true, refund: { refundId: "re_1", amountMinor: 0, status: "pending" } };
  }

  verify = () => true;
  parseEvent = () => null;

  cards: CardVault = {
    createCustomer: async () => ({ ok: true, value: { customerRef: `cus_bank_${RUN}` } }),
    startSetup: async (request) => {
      const setupId = `seti_bank_${this.setups.size + 1}_${RUN}`;
      this.setups.set(setupId, {
        setupId, status: "succeeded", customerRef: request.customerRef, card: null,
        bankAccount: request.kind === "bank_account"
          ? { ref: `pm_bank_${setupId}`, bankName: "Frost Bank", last4: "6789" }
          : null,
        metadata: request.metadata ?? {},
      });
      return { ok: true, value: { setupId, clientSecret: `${setupId}_secret` } };
    },
    readSetup: async (setupId) => {
      const setup = this.setups.get(setupId);
      return setup ? { ok: true, value: setup } : { ok: false, code: "resource_missing", message: "No such setup.", retryable: false };
    },
    detach: async () => ({ ok: true, value: { detached: true } }),
  };
}

let stripe: FakeStripe;
const deps = (): payments.PaymentDeps => ({ readSecret: async () => "sk_test_notreal", provider: stripe });

/** What Stripe's webhook would say about the last charge. */
function event(kind: PaymentEvent["kind"], charge: ChargeRequest, intentId: string, extra: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    eventId: `evt_${kind}_${intentId}_${Math.random().toString(36).slice(2)}`,
    kind, type: `payment_intent.${kind === "failed" ? "payment_failed" : kind}`,
    intentId, amountMinor: charge.amountMinor, currency: "usd", feeMinor: null, refundedMinor: null,
    metadata: charge.metadata ?? {}, failureMessage: null, methodType: "us_bank_account", ...extra,
  };
}

async function anInvoice(customerId: string, total: string) {
  const invoice = await billing.create(owner(), {
    customerId,
    lines: [{ name: "Quarterly treatment", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  await raw`update public.invoice set status = 'open' where id = ${invoice.id as string} and status = 'draft'`;
  return invoice.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Pecan Pest Control", slug: SLUG });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Somebody Else's Pest", slug: OTHER_SLUG });
  await raw`delete from public.public_rate_limit where key like 'portal-code:%' or key like 'portal-check:%'`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@portal-access.test" })})`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', 'TEST_BANK_KEY', ${raw.json({ publishableKey: "pk_test_bank" } as never)})
    returning id`;
  connectionId = row!.id;

  const d = await aCustomer("Dana Whitlock", DANA);
  dana = d.id;
  danaProperty = d.propertyId;
  sam = (await contacts.create(owner(), { name: "Sam Whitlock", customerId: dana, email: SAM, preferredChannel: "email" })).id;
  ray = await technician("ray", "Ray Ortiz");
  lee = await technician("lee", "Lee Park");
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await resetOrg(raw, OTHER_ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  stripe = new FakeStripe();
  await raw`delete from public.public_rate_limit where key like 'portal-code:%' or key like 'portal-check:%'`;
});

run("a contact signing in as the customer", () => {
  it("is refused until the office lets them, and then reaches the customer's account and nothing else", async () => {
    // Not allowed yet: the same answer as an address nobody has, and no code goes.
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: SAM }, { ip: ip() });
    expect(await codeSentTo(SAM)).toBeNull();
    await expect(portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: SAM, code: "123456" }, { ip: ip() }))
      .rejects.toThrow(SignInRefusedError);

    // A technician cannot give somebody the customer's bills.
    await expect(portalAccess.setContactAccess(as(["technician"]), { id: sam, allowed: true }))
      .rejects.toThrow(PermissionError);
    await portalAccess.setContactAccess(owner(), { id: sam, allowed: true });

    const token = await signIn(SAM);
    const session = await portalSignIn.sessionFor(db(), token);
    expect(session.customerId).toBe(dana);
    expect(session.contact).toEqual({ id: sam, name: "Sam Whitlock" });
    const account = await portalAccount.viewAccount(db(), { token });
    expect(account.customerName).toBe("Dana Whitlock");

    // What they do is recorded as them.
    const [audit] = await raw<{ actor_contact_id: string | null; actor_portal_grant_id: string | null }[]>`
      select actor_contact_id, actor_portal_grant_id from public.audit_log
       where organization_id = ${ORG} and action = 'portal.signed_in' order by created_at desc limit 1`;
    expect(audit).toMatchObject({ actor_contact_id: sam });
    expect(audit!.actor_portal_grant_id).not.toBeNull();

    // A record opened from their sign in is still theirs.
    const invoiceId = await anInvoice(dana, "80.00");
    const opened = await portalSignIn.openRecord(db(), { token, kind: "invoice", id: invoiceId });
    const narrower = await portal.peek(db(), opened.url.split("/").pop()!);
    expect(narrower.contactId).toBe(sam);

    // Taking it away ends the sign in at once, and the narrower link with it.
    const removed = await portalAccess.setContactAccess(owner(), { id: sam, allowed: false });
    expect(removed.endedSessions).toBeGreaterThanOrEqual(2);
    await expect(portalSignIn.sessionFor(db(), token)).rejects.toThrow(InvalidGrantError);
    await expect(portal.peek(db(), opened.url.split("/").pop()!)).rejects.toThrow(InvalidGrantError);
  });

  it("is not offered to a contact at one address only, or one with nowhere to send a code", async () => {
    const tenant = await contacts.create(owner(), { name: "Theo Tenant", propertyId: danaProperty, email: TENANT, preferredChannel: "email" });
    await expect(portalAccess.setContactAccess(owner(), { id: tenant.id, allowed: true })).rejects.toThrow(ConflictError);
  });
});

run("the office's view of sign ins", () => {
  it("lists a customer's sign ins and their failed codes, and ends a sign in everywhere", async () => {
    // A wrong code against Dana's own address is a failure on Dana.
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: DANA }, { ip: ip() });
    const code = (await codeSentTo(DANA))!;
    await expect(portalSignIn.verifyCode(db(), {
      organizationSlug: SLUG, address: DANA, code: code === "000000" ? "111111" : "000000",
    }, { ip: ip() })).rejects.toThrow(SignInRefusedError);
    const failed = (await portalAccess.attempts(owner(), { customerId: dana })).attempts[0]!;
    expect(failed).toMatchObject({ address: DANA, outcome: "wrong_code", wrongCodes: 1, delivery: "queued" });
    expect(failed.customers.map((c) => c.id)).toEqual([dana]);

    const token = await signIn(DANA);
    const listed = await portalAccess.attempts(owner(), {});
    expect(listed.attempts[0]).toMatchObject({ outcome: "signed_in", customers: [{ id: dana, name: "Dana Whitlock" }] });

    const { sessions } = await portalAccess.sessions(owner(), { customerId: dana });
    const open = sessions.find((s) => s.active)!;
    expect(open).toMatchObject({ address: DANA, channel: "email", contactName: null });

    // A technician hands out links; reading sign ins and ending them is the office's.
    await expect(portalAccess.attempts(as(["technician"]), { customerId: dana })).rejects.toThrow(PermissionError);
    await expect(portalAccess.endSessions(as(["csr"]), { customerId: dana })).rejects.toThrow(PermissionError);

    expect((await portalAccess.endSessions(owner(), { customerId: dana, sessionId: open.id })).ended).toBe(1);
    await expect(portalSignIn.sessionFor(db(), token)).rejects.toThrow(InvalidGrantError);
    expect((await portalAccess.endSessions(owner(), { customerId: dana })).ended).toBe(0);
    const after = (await portalAccess.sessions(owner(), { customerId: dana })).sessions.find((s) => s.id === open.id)!;
    expect(after).toMatchObject({ active: false, endedReason: "office" });
  });
});

run("the sign in page's brand", () => {
  it("is served by the company's public key, and is only the public mark", async () => {
    await raw`update public.organization set brand_color = '#0f766e' where id = ${ORG}`;
    await raw`delete from public.brand_asset where organization_id in (${ORG}, ${OTHER_ORG})`;
    await raw`insert into public.brand_asset (organization_id, kind, content_type, bytes, size_bytes)
      values (${ORG}, 'logo', 'image/png', ${Buffer.from("pecan-logo")}, 10)`;

    const brand = await portal.publicBrandingAt(db(), SLUG);
    expect(Object.keys(brand).sort()).toEqual(["color", "hasLogo", "on", "organizationName", "text", "version"]);
    expect(brand).toMatchObject({ organizationName: "Pecan Pest Control", color: "#0f766e", hasLogo: true });
    expect((await portal.publicLogoAt(db(), SLUG))!.bytes.toString()).toBe("pecan-logo");

    // Another company's slug is that company's mark, never this one's.
    const other = await portal.publicBrandingAt(db(), OTHER_SLUG);
    expect(other).toMatchObject({ organizationName: "Somebody Else's Pest", color: null, hasLogo: false });
    expect(await portal.publicLogoAt(db(), OTHER_SLUG)).toBeNull();

    await expect(portal.publicBrandingAt(db(), "no-such-company")).rejects.toThrow(NotFoundError);
    await raw`update public.organization set suspended_at = now() where id = ${OTHER_ORG}`;
    await expect(portal.publicBrandingAt(db(), OTHER_SLUG)).rejects.toThrow(OrganizationSuspendedError);
    await raw`update public.organization set suspended_at = null where id = ${OTHER_ORG}`;
  });
});

run("paying from a bank account", () => {
  it("is offered only once the company turns bank payments on", async () => {
    const token = await signIn(DANA);
    expect((await savedCards.list(db(), { token })).canSaveBank).toBe(false);
    await expect(savedCards.startSave(db(), { token, kind: "bank_account" }, undefined, deps())).rejects.toThrow(ConflictError);
  });

  it("is pending until the processor confirms, cannot be paid twice meanwhile, and settles as a bank payment", async () => {
    await raw`update public.organization set settings = settings || '{"portal":{"bankAccounts":true}}'::jsonb where id = ${ORG}`;
    const token = await signIn(DANA);
    expect((await savedCards.list(db(), { token })).canSaveBank).toBe(true);
    const started = await savedCards.startSave(db(), { token, kind: "bank_account" }, undefined, deps());
    const account = await savedCards.confirmSave(db(), { token, setupId: started.setupId }, deps());
    expect(account).toMatchObject({ kind: "bank_account", brand: "Frost Bank", last4: "6789", expMonth: null });

    const invoiceId = await anInvoice(dana, "120.00");
    const paid = await savedCards.pay(db(), { token, invoiceId, cardId: account.id },
      { ip: "203.0.113.9", userAgent: "Phone" }, deps());
    expect(paid.status).toBe("processing");
    const charge = stripe.charges.at(-1)!;
    expect(charge).toMatchObject({ methodKind: "bank_account", acceptance: { ip: "203.0.113.9", userAgent: "Phone" } });

    // Pending: on its way, the invoice still open and not offered again, anywhere.
    const view = await portalAccount.viewAccount(db(), { token });
    expect(view.invoices.find((i) => i.id === invoiceId)).toMatchObject({ payable: false, bankPaymentPending: true });
    expect(view.bankPayments[0]).toMatchObject({ status: "pending", amount: "120.0000" });
    await expect(savedCards.pay(db(), { token, invoiceId, cardId: account.id }, undefined, deps()))
      .rejects.toThrow(/already on its way/);
    expect((await payments.bankPayments(owner(), { invoiceId })).bankPayments[0]).toMatchObject({ status: "pending" });
    const [open] = await raw<{ status: string }[]>`select status from public.invoice where id = ${invoiceId}`;
    expect(open!.status).toBe("open");

    // The processor says it arrived: booked as a bank payment, and the invoice paid.
    const connection = (await payments.connectionById(db(), connectionId))!;
    await payments.receive(db(), { connection, event: event("succeeded", charge, paid.intentId) });
    const [payment] = await raw<{ method: string; status: string }[]>`
      select method, status from public.payment where processor_payment_id = ${paid.intentId}`;
    expect(payment).toMatchObject({ method: "ach", status: "succeeded" });
    const [settled] = await raw<{ status: string }[]>`select status from public.invoice where id = ${invoiceId}`;
    expect(settled!.status).toBe("paid");
  });

  it("fails with the invoice still open, the customer told, and a task in the office queue saying why", async () => {
    const token = await signIn(DANA);
    const [account] = (await savedCards.list(db(), { token })).cards.filter((c) => c.kind === "bank_account");
    const invoiceId = await anInvoice(dana, "95.00");
    const paid = await savedCards.pay(db(), { token, invoiceId, cardId: account!.id }, undefined, deps());
    const connection = (await payments.connectionById(db(), connectionId))!;
    await payments.receive(db(), {
      connection,
      event: event("failed", stripe.charges.at(-1)!, paid.intentId, { failureMessage: "The account has insufficient funds." }),
    });

    const [invoice] = await raw<{ status: string; balance: string }[]>`select status, balance from public.invoice where id = ${invoiceId}`;
    expect(invoice).toMatchObject({ status: "open", balance: "95.0000" });
    expect(await raw`select 1 from public.payment where processor_payment_id = ${paid.intentId}`).toHaveLength(0);
    const [task] = await raw<{ title: string; body: string; queue: string; priority: string; entity_id: string }[]>`
      select title, body, queue, priority, entity_id from public.task
       where organization_id = ${ORG} and entity_id = ${invoiceId}`;
    expect(task).toMatchObject({ queue: "office", priority: "high", entity_id: invoiceId });
    expect(task!.title).toMatch(/Dana Whitlock's bank payment of \$95\.00 for invoice #\d+ did not go through/);
    expect(task!.body).toContain("insufficient funds");

    const view = await portalAccount.viewAccount(db(), { token });
    expect(view.bankPayments.find((b) => b.status === "failed")).toMatchObject({ amount: "95.0000", reason: "The account has insufficient funds." });
    expect(view.invoices.find((i) => i.id === invoiceId)).toMatchObject({ payable: true, bankPaymentPending: false });
  });

  it("reverses a payment already booked when the bank returns it afterwards", async () => {
    const token = await signIn(DANA);
    const [account] = (await savedCards.list(db(), { token })).cards.filter((c) => c.kind === "bank_account");
    const invoiceId = await anInvoice(dana, "60.00");
    const paid = await savedCards.pay(db(), { token, invoiceId, cardId: account!.id }, undefined, deps());
    const charge = stripe.charges.at(-1)!;
    const connection = (await payments.connectionById(db(), connectionId))!;
    await payments.receive(db(), { connection, event: event("succeeded", charge, paid.intentId) });

    const late = event("failed", charge, paid.intentId, { failureMessage: "The customer's bank returned the debit." });
    await payments.receive(db(), { connection, event: late });
    const [payment] = await raw<{ id: string; status: string; refunded_amount: string }[]>`
      select id, status, refunded_amount from public.payment where processor_payment_id = ${paid.intentId}`;
    expect(payment).toMatchObject({ status: "failed", refunded_amount: "60.0000" });
    const [invoice] = await raw<{ status: string; balance: string }[]>`select status, balance from public.invoice where id = ${invoiceId}`;
    expect(invoice).toMatchObject({ status: "open", balance: "60.0000" });
    const tasks = await raw<{ title: string }[]>`select title from public.task where organization_id = ${ORG} and entity_id = ${invoiceId}`;
    expect(tasks.map((t) => t.title).join(" ")).toMatch(/was returned and has been taken back off invoice/);

    // The same failure delivered again does not reverse it twice.
    await payments.receive(db(), { connection, event: { ...late, eventId: `${late.eventId}_again` } });
    const [still] = await raw<{ refunded_amount: string }[]>`select refunded_amount from public.payment where id = ${payment!.id}`;
    expect(still!.refunded_amount).toBe("60.0000");
  });
});

run("what a customer sees of the work", () => {
  it("lays out the trade pack's blocks, with the published report, products used, shared notes and equipment", async () => {
    await applyTradePack(owner(), "pest-control");
    const { jobId, visitId } = await aVisit({
      customerId: dana, propertyId: danaProperty, summary: "Quarterly pest treatment",
      start: new Date(Date.now() - 5 * 864e5), status: "completed", technicianId: ray,
      technicianNotes: "Dog bit me. Never sending Lee here.",
    });
    await portalBlocks.shareVisitNotes(owner(), { id: visitId, notes: "Treated the perimeter and the garage. Keep pets off the lawn for two hours." });
    await expect(portalBlocks.shareVisitNotes(as(["technician"]), { id: visitId, notes: "x" })).rejects.toThrow(PermissionError);

    const [report] = await raw<{ id: string }[]>`insert into public.service_report
      (organization_id, visit_id, job_id, customer_id, property_id, summary, submitted_at, published_at, technician_notes)
      values (${ORG}, ${visitId}, ${jobId}, ${dana}, ${danaProperty}, 'Perimeter treatment, all stations checked', now(), now(),
              'Customer argued about the price') returning id`;
    await raw`insert into public.service_report_field
      (organization_id, report_id, property_id, key, label, kind, product_name, epa_registration_number, quantity_applied, application_unit, target_pest)
      values (${ORG}, ${report!.id}, ${danaProperty}, 'product_applied', 'Product applied', 'chemical', 'Termidor SC', '7969-210', '0.7500', 'gal', 'Ants')`;
    await raw`insert into public.service_report_field
      (organization_id, report_id, property_id, key, label, kind, value_numeric, customer_visible)
      values (${ORG}, ${report!.id}, ${danaProperty}, 'stations_serviced', 'Stations serviced', 'numeric', '6.0000', true),
             (${ORG}, ${report!.id}, ${danaProperty}, 'internal_margin', 'Internal margin', 'numeric', '42.0000', false)`;
    await raw`insert into public.equipment (organization_id, property_id, category, tag, manufacturer, attributes)
      values (${ORG}, ${danaProperty}, 'furnace', 'Hall closet', 'Carrier', ${raw.json({ filter_size: "16x25x1", afue: 96 } as never)})`;

    const token = await signIn(DANA);
    const { extras } = await portalAccount.viewAccount(db(), { token });

    // The pest pack's own order and words come first, then what every account shows.
    expect(extras.blocks.slice(0, 3).map((b) => b.kind)).toEqual(["next_visit", "service_report", "equipment_register"]);
    expect(extras.blocks.find((b) => b.kind === "service_report")).toMatchObject({ title: "What we did and what we used", declared: true });
    expect(extras.blocks.some((b) => b.kind === "visit_timeline" && !b.declared)).toBe(true);

    const visit = extras.history.find((h) => h.visitId === visitId)!;
    expect(visit).toMatchObject({ technicianName: "Ray", notes: "Treated the perimeter and the garage. Keep pets off the lawn for two hours." });
    expect(visit.report!.summary).toBe("Perimeter treatment, all stations checked");
    expect(visit.report!.fields.find((f) => f.key === "product_applied")!.product).toEqual({
      name: "Termidor SC", epaRegistrationNumber: "7969-210", quantity: "0.7500", unit: "gal", target: "Ants",
    });
    const shown = JSON.stringify(extras);
    expect(shown).not.toContain("Dog bit me");
    expect(shown).not.toContain("argued about the price");
    expect(shown).not.toContain("internal_margin");

    // Readings the pack asks to trend, the ones the customer may see.
    expect(extras.readings.find((r) => r.key === "stations_serviced")!.points.map((p) => p.value)).toEqual(["6.0000"]);

    expect(extras.equipment[0]).toMatchObject({ name: "Furnace", tag: "Hall closet", manufacturer: "Carrier" });
    expect(extras.equipment[0]!.details).toEqual(expect.arrayContaining([{ label: "Filter size", value: "16x25x1" }]));

    // Stopping shows nothing of the visit's notes.
    await portalBlocks.shareVisitNotes(owner(), { id: visitId, notes: null });
    const after = await portalAccount.viewAccount(db(), { token });
    expect(after.extras.history.find((h) => h.visitId === visitId)!.notes).toBeNull();
  });
});

run("windows offered from the technicians' days", () => {
  let service: Awaited<ReturnType<typeof setUp>>;
  const day = (offset: number) => time.dateIn(new Date(Date.now() + offset * 864e5), ZONE);
  const D = day(4);

  async function setUp() {
    const [type] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, default_duration_minutes)
      values (${ORG}, ${`Ant treatment ${RUN}`}, 120) returning id`;
    const [window] = await raw<{ id: string }[]>`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week)
      values (${ORG}, '8am to 12pm', '08:00', '12:00', ${[0, 1, 2, 3, 4, 5, 6]}) returning id`;
    for (const dow of [0, 1, 2, 3, 4, 5, 6]) {
      await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at) values (${ORG}, ${dow}, '07:00', '18:00')`;
    }
    const [row] = await raw<{ id: string }[]>`insert into public.bookable_service
      (organization_id, job_type_id, public_name, min_notice_hours, max_advance_days, max_per_window)
      values (${ORG}, ${type!.id}, 'Ant treatment', 0, 30, 5) returning id`;
    const [record] = await db().select().from(schema.bookableService).where(eq(schema.bookableService.id, row!.id));
    return { windowId: window!.id, record: record! };
  }

  const slotOn = async (date: string, technicianId?: string) => (await booking.openSlots(db(), {
    organizationId: ORG, timezone: ZONE, service: service.record, from: date, days: 1,
    ...(technicianId ? { technicianId } : {}),
  })).find((s) => s.arrivalWindowId === service.windowId);

  beforeAll(async () => {
    if (!url) return;
    service = await setUp();
  });

  it("counts what each technician still has free, under the company's own limit", async () => {
    // Two people with empty mornings, two hour jobs: four fit, the limit is five.
    expect((await slotOn(D))!.remaining).toBe(4);

    // Ray's morning is taken.
    const start = booking.windowStart(D, "08:00", ZONE);
    const { visitId } = await aVisit({ customerId: dana, propertyId: danaProperty, summary: "Big job", start, minutes: 240, technicianId: ray });
    expect((await slotOn(D))!.remaining).toBe(2);
    expect(await slotOn(D, ray)).toBeUndefined();

    // A booking request waiting for somebody takes one of Lee's two.
    const request = await booking.createRequest(db(), {
      organizationSlug: SLUG, bookableServiceId: service.record.id, requestedDate: D, arrivalWindowId: service.windowId,
      contactName: "Wren Waiting", contactEmail: `wren.${RUN}@portal-access.test`,
      addressLine1: "1 Waiting Way", city: "Austin", state: "TX", postalCode: "78704", intakeAnswers: {}, utm: {},
    });
    expect((await slotOn(D))!.remaining).toBe(1);

    // Lee is off: nobody can go, the window is not offered, and a booking for it is refused.
    await raw`insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
      values (${ORG}, ${lee}, ${booking.windowStart(D, "00:00", ZONE)}, ${booking.windowStart(D, "23:59", ZONE)}, true)`;
    expect(await slotOn(D)).toBeUndefined();
    await expect(booking.createRequest(db(), {
      organizationSlug: SLUG, bookableServiceId: service.record.id, requestedDate: D, arrivalWindowId: service.windowId,
      contactName: "Late Comer", contactEmail: `late.${RUN}@portal-access.test`,
      addressLine1: "2 Late Lane", city: "Austin", state: "TX", postalCode: "78704", intakeAnswers: {}, utm: {},
    })).rejects.toThrow(/just been taken/);

    // The window opens again the day after, with both free.
    expect((await slotOn(day(5)))!.remaining).toBe(4);
    await raw`delete from public.booking_request where id = ${request.request.id}`;
    await raw`delete from public.visit where id = ${visitId}`;
  });

  it("lets a returning customer ask for the technician who came before, from that person's own free time", async () => {
    const token = await signIn(DANA);
    const options = await portalBooking.options(db(), { token });
    expect(options.technicians.map((t) => t.name)).toEqual(["Ray"]);
    expect(options.services.map((s) => s.name)).toContain("Ant treatment");

    // Somebody who has never been here is not offered, and cannot be asked for.
    await expect(portalBooking.availability(db(), { token, bookableServiceId: service.record.id, technicianId: lee }))
      .rejects.toThrow(NotFoundError);

    const E = day(6);
    const { slots } = await portalBooking.availability(db(), { token, bookableServiceId: service.record.id, from: E, days: 1, technicianId: ray });
    expect(slots.find((s) => s.arrivalWindowId === service.windowId)!.remaining).toBe(2);

    const asked = await portalBooking.request(db(), {
      token, bookableServiceId: service.record.id, propertyId: danaProperty, requestedDate: E,
      arrivalWindowId: service.windowId, technicianId: ray, notes: "Ants by the back door again",
    }, { idempotencyKey: `ask-${RUN}` });
    // The same press twice is one request.
    const again = await portalBooking.request(db(), {
      token, bookableServiceId: service.record.id, propertyId: danaProperty, requestedDate: E,
      arrivalWindowId: service.windowId, technicianId: ray,
    }, { idempotencyKey: `ask-${RUN}` });
    expect(again.requestId).toBe(asked.requestId);
    expect((await portalAccount.viewAccount(db(), { token })).requested[0]).toMatchObject({
      serviceName: "Ant treatment", requestedDate: E, technicianName: "Ray",
    });
    // Ray's time for it is spoken for.
    expect((await slotOn(E, ray))!.remaining).toBe(1);

    // Booked with its visit, Ray goes on it, for Dana at her own address.
    const booked = await agentIntake.bookRequest(owner(), { id: asked.requestId });
    expect(booked.customerId).toBe(dana);
    const [assigned] = await raw<{ technician_id: string }[]>`
      select technician_id from public.visit_assignment where visit_id = ${booked.visitId}`;
    expect(assigned!.technician_id).toBe(ray);
    const [job] = await raw<{ property_id: string }[]>`select property_id from public.job where id = ${booked.jobId}`;
    expect(job!.property_id).toBe(danaProperty);
  });

  it("refuses a booking from an account link, which can be forwarded", async () => {
    const link = await portal.issueGrant(owner(), { customerId: dana, scope: "customer", expiresInDays: 7 });
    const token = link.url.split("/").pop()!;
    await expect(portalBooking.options(db(), { token })).rejects.toThrow(InvalidGrantError);
  });
});
