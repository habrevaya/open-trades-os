import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as invoiceDelivery from "../src/services/invoice-delivery";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as email from "../src/services/email";
import * as portal from "../src/services/portal";
import type { EmailProvider, OutboundEmail, SendResult } from "../src/email/provider";
import type {
  ChargeOutcome, PaymentProvider, RefundOutcome,
} from "../src/payments/provider";
import type { PaymentDeps } from "../src/services/payments";
import {
  ConflictError, NotFoundError, InvalidGrantError, type ServiceContext,
} from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * ACTUALLY SENDING AN INVOICE
 *
 * `invoice_delivery` sat in the schema from the first migration with no
 * writer, so a company could raise an invoice and had no way to give it to
 * anybody. The properties worth testing are the ones that cost money when
 * they are wrong, and they are not the happy path.
 *
 * AN INVOICE NOBODY SENT IS A RECEIVABLE NOBODY CHASES. Every refusal from
 * the mail system has to land in a row and on a screen, because the
 * alternative is an open balance ageing quietly against a customer who never
 * received anything.
 *
 * A BOUNCED INVOICE IS NOT A LATE PAYER. They look identical on an ageing
 * report and need opposite responses.
 *
 * AND THE PAY LINK CANNOT BE TRUSTED WITH AN AMOUNT. It is held by a browser.
 *
 * No test here reaches a mail server or a processor. Both are injected fakes,
 * for the reason the outbox gives: a test that monkey patches the network
 * passes against a shape that has drifted.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("invdel:org");
const USER = fixtureId("invdel:user");
const FROM = "billing@example-trades.com";
const TO = "payer@customer.test";
const KEY_REF = "TEST_INVDEL_STRIPE_KEY";

let raw: postgres.Sql;
const db = () => testDb(url!);

const ctx = (extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] },
  db: db(),
  ...extra,
});

/** The Finance role, which is the one whose job this is. See the service. */
const accountant = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["accountant"] as Actor["roles"] },
  db: db(),
});

const dispatcher = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["dispatcher"] as Actor["roles"] },
  db: db(),
});

/** A mail provider that never opens a socket. */
function fakeMail(behaviour: { result?: SendResult } = {}): EmailProvider & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = [];
  return {
    name: "fake",
    sent,
    delivery: { kind: "webhook", verify: () => true, parse: () => null },
    async send(message) {
      sent.push(message);
      return behaviour.result ?? { ok: true, providerMessageId: `re_${sent.length}` };
    },
  };
}

interface ChargeRecord { amountMinor: number; metadata: Record<string, string> }

/** A processor that never reaches the network, and remembers what it was asked. */
function fakeProcessor(charges: ChargeRecord[]): PaymentProvider {
  return {
    name: "stripe",
    publishableKey: "pk_test_invdel",
    async charge(request): Promise<ChargeOutcome> {
      charges.push({ amountMinor: request.amountMinor, metadata: request.metadata ?? {} });
      return {
        ok: true,
        intent: {
          intentId: `pi_${charges.length}`,
          clientSecret: `pi_${charges.length}_secret`,
          amountMinor: request.amountMinor,
          currency: "usd",
          status: "requires_payment_method",
        },
      };
    },
    async refund(): Promise<RefundOutcome> {
      return { ok: true, refund: { refundId: "re_1", amountMinor: 0, status: "pending" } };
    },
    verify: () => true,
    parseEvent: () => null,
  };
}

const payDeps = (provider: PaymentProvider): PaymentDeps =>
  ({ readSecret: async () => "sk_test_notreal", provider });

async function connectMail(): Promise<void> {
  await raw`
    insert into public.integration_connection
      (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected',
            ${raw.json({ fromAddress: FROM } as never)})`;
}

async function connectProcessor(): Promise<void> {
  await raw`
    insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', ${KEY_REF},
            ${raw.json({ publishableKey: "pk_test_invdel" } as never)})`;
}

async function anInvoice(opts: { total?: string; email?: string | null } = {}) {
  const customer = await customers.create(ctx(), {
    type: "residential", name: "Pat Payer", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
  });
  const address = opts.email === undefined ? TO : opts.email;
  await raw`update public.customer set email = ${address} where id = ${customer.id}`;

  const invoice = await billing.create(ctx(), {
    customerId: customer.id,
    lines: [{
      name: "Condenser replacement", quantity: "1",
      unitPrice: opts.total ?? "458.00", discountAmount: "0", taxable: false,
    }],
  });
  return {
    customerId: customer.id,
    invoiceId: invoice.id as string,
    number: invoice.number as number,
    balance: invoice.balance as string,
  };
}

const tokenOf = (portalUrl: string): string => portalUrl.split("/").pop()!;

const deliveryRows = (invoiceId: string) => raw<{
  id: string; channel: string; destination: string | null;
  submitted_at: Date | null; error: string | null;
  message_id: string | null; portal_grant_id: string | null;
}[]>`
  select id, channel, destination, submitted_at, error, message_id, portal_grant_id
  from public.invoice_delivery where invoice_id = ${invoiceId}
  order by created_at`;

const messageCount = () => raw<{ n: string }[]>`
  select count(*)::text as n from public.message where organization_id = ${ORG}`;

/** Hand the queued mail to the fake provider, which is what "sent" means. */
async function flushMail(provider: EmailProvider) {
  return email.flush(db(), ORG, { provider });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Invoice Co", slug: "invoice-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Invoice Co", slug: "invoice-co" });
  await connectMail();
});

/* ======================================================= the send itself */

run("sending an invoice", () => {
  it("writes one delivery row carrying the channel, the address and the message", async () => {
    const { invoiceId } = await anInvoice();
    const result = await invoiceDelivery.send(ctx(), { invoiceId });

    expect(result.state).toBe("queued");
    expect(result.channel).toBe("email");
    expect(result.destination).toBe(TO);
    expect(result.attempt).toBe(1);

    const rows = await deliveryRows(invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("email");
    expect(rows[0]!.destination).toBe(TO);
    /**
     * The message id is the join that answers "did it arrive". Without it a
     * bounce can only be matched to an invoice by address and timestamp.
     */
    expect(rows[0]!.message_id).toBe(result.messageId);
    expect(rows[0]!.submitted_at).not.toBeNull();
    expect(rows[0]!.error).toBeNull();
  });

  it("puts the link in both the text and the HTML part", async () => {
    const { invoiceId } = await anInvoice();
    const result = await invoiceDelivery.send(ctx(), { invoiceId });

    const [message] = await raw<{ subject: string; body: string; body_html: string }[]>`
      select subject, body, body_html from public.message where id = ${result.messageId}`;

    expect(message!.subject).toContain("Invoice");
    expect(message!.body).toContain(result.portalUrl);
    expect(message!.body_html).toContain(result.portalUrl);
    /**
     * HTML with no plain text alternative is the strongest content signal a
     * spam filter has, and is what anybody reading in plain text receives.
     * `email.queue` refuses it, so a composer that produced only HTML would
     * fail every send rather than quietly degrade.
     */
    expect(message!.body.length).toBeGreaterThan(50);
  });

  it("sends to the payer rather than the customer when they differ", async () => {
    /**
     * On a warranty or insurance job the homeowner is not who owes the money.
     * Sending to them means the person who does owe it never sees a bill.
     */
    const { invoiceId } = await anInvoice();
    const warranty = await customers.create(ctx(), {
      type: "commercial", name: "Shield Home Warranty", paymentTermsDays: 30,
      taxExempt: false, tags: [], customFields: {},
    });
    await raw`update public.customer set email = 'ap@shield.test' where id = ${warranty.id}`;
    await raw`update public.invoice set payer_customer_id = ${warranty.id} where id = ${invoiceId}`;

    const result = await invoiceDelivery.send(ctx(), { invoiceId });
    expect(result.destination).toBe("ap@shield.test");
  });

  it("lets the caller override the address", async () => {
    const { invoiceId } = await anInvoice();
    const result = await invoiceDelivery.send(ctx(), { invoiceId, to: "ap@building.test" });
    expect(result.destination).toBe("ap@building.test");
  });

  it("refuses a draft, because a document still being edited is two invoices", async () => {
    const { invoiceId } = await anInvoice();
    await raw`update public.invoice set status = 'draft' where id = ${invoiceId}`;
    await expect(invoiceDelivery.send(ctx(), { invoiceId }))
      .rejects.toThrow(/draft/i);
  });

  it("refuses a voided invoice, because there is nothing to collect", async () => {
    const { invoiceId } = await anInvoice();
    await raw`update public.invoice set status = 'void' where id = ${invoiceId}`;
    await expect(invoiceDelivery.send(ctx(), { invoiceId }))
      .rejects.toThrow(/voided/i);
  });

  it("escapes the operator's note rather than putting it in the markup", async () => {
    /**
     * The note is typed by a person and lands in an HTML email. An unescaped
     * one is markup in somebody else's mail client, and the cheapest version
     * of that is a stray angle bracket silently eating the rest of the note.
     */
    const { invoiceId } = await anInvoice();
    const result = await invoiceDelivery.send(ctx(), {
      invoiceId, note: `Thanks <b>again</b> & see you "soon"`,
    });

    const [message] = await raw<{ body_html: string }[]>`
      select body_html from public.message where id = ${result.messageId}`;
    expect(message!.body_html).toContain("&lt;b&gt;again&lt;/b&gt;");
    expect(message!.body_html).not.toContain("<b>again</b>");
  });

  it("leaves nothing behind when the transport refuses the input outright", async () => {
    /**
     * The delivery row, the portal grant and the message are written in one
     * transaction, so there is no ordering in which a live link to a document
     * exists and the send that produced it does not. `email.queue` throws on
     * an address that is not one, which is the cheapest way to make the
     * transport fail after the row has been inserted.
     */
    const { invoiceId } = await anInvoice();
    const grantsBefore = await raw<{ n: string }[]>`
      select count(*)::text as n from public.portal_grant where organization_id = ${ORG}`;

    await expect(invoiceDelivery.send(ctx(), { invoiceId, to: "not-an-address" }))
      .rejects.toBeInstanceOf(ConflictError);

    expect(await deliveryRows(invoiceId)).toHaveLength(0);
    const grantsAfter = await raw<{ n: string }[]>`
      select count(*)::text as n from public.portal_grant where organization_id = ${ORG}`;
    expect(grantsAfter[0]!.n).toBe(grantsBefore[0]!.n);
  });

  it("refuses when there is no address and writes no attempt", async () => {
    const { invoiceId } = await anInvoice({ email: null });
    /**
     * The message names the real problem. Letting this fall through to the
     * mail service produces "that is not an email address", which sends
     * somebody looking for a typo in a field that is simply empty.
     */
    await expect(invoiceDelivery.send(ctx(), { invoiceId }))
      .rejects.toThrow(/no email address on file/);
    /** No address is no attempt. A row here would read as a send to nowhere. */
    expect(await deliveryRows(invoiceId)).toHaveLength(0);
  });

  it("says so rather than inventing an invoice", async () => {
    await expect(invoiceDelivery.send(ctx(), { invoiceId: fixtureId("invdel:nope") }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

/* ============================================ resend versus double send */

run("resending, and not double sending", () => {
  it("refuses a second send and names the first", async () => {
    const { invoiceId, number } = await anInvoice();
    await invoiceDelivery.send(ctx(), { invoiceId });

    /**
     * The annoyance case: somebody clicks twice. The refusal says when it
     * went and to whom, so the operator can see that the first one worked
     * rather than wondering whether anything happened at all.
     */
    await expect(invoiceDelivery.send(ctx(), { invoiceId }))
      .rejects.toThrow(new RegExp(`Invoice ${number} was already sent to ${TO}`));

    expect((await messageCount())[0]!.n).toBe("1");
    expect(await deliveryRows(invoiceId)).toHaveLength(1);
  });

  it("sends again when asked on purpose, and keeps both attempts", async () => {
    const { invoiceId } = await anInvoice();
    await invoiceDelivery.send(ctx(), { invoiceId });
    const second = await invoiceDelivery.send(ctx(), { invoiceId, resend: true });

    expect(second.attempt).toBe(2);
    const rows = await deliveryRows(invoiceId);
    expect(rows).toHaveLength(2);
    /** Two attempts, two messages, both visible. A resend is not a rewrite. */
    expect((await messageCount())[0]!.n).toBe("2");

    const { deliveries } = await invoiceDelivery.history(ctx(), { invoiceId });
    expect(deliveries.map((d) => d.attempt)).toEqual([1, 2]);
  });

  it("does not need permission to retry a send that never left", async () => {
    /**
     * The asymmetry is the point. Refusing to retry a failed send would turn
     * one bad afternoon at a mail provider into an invoice that can never be
     * sent at all, which is the failure this whole service exists to end.
     */
    const { invoiceId } = await anInvoice();
    await raw`
      insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, ${TO}, 'email', 'hard_bounce')`;

    const refused = await invoiceDelivery.send(ctx(), { invoiceId });
    expect(refused.state).toBe("refused");

    await raw`delete from public.suppression where organization_id = ${ORG}`;
    const retried = await invoiceDelivery.send(ctx(), { invoiceId });
    expect(retried.state).toBe("queued");
    expect(retried.attempt).toBe(2);
  });

  it("treats a retried request with the same idempotency key as the same send", async () => {
    const { invoiceId } = await anInvoice();
    const key = "idem-invoice-send-1";
    const first = await invoiceDelivery.send(ctx({ idempotencyKey: key }), { invoiceId });
    const again = await invoiceDelivery.send(ctx({ idempotencyKey: key }), { invoiceId });

    expect(again.deliveryId).toBe(first.deliveryId);
    expect((await messageCount())[0]!.n).toBe("1");
    expect(await deliveryRows(invoiceId)).toHaveLength(1);
    /**
     * The token exists once. A replay cannot be handed the link again,
     * because minting a second one would turn one retried request into two
     * live links to the same document.
     */
    expect(again.portalUrl).toBe("");
  });
});

/* ================================================ the refusal, recorded */

run("a send that cannot go out", () => {
  it("records the refusal instead of throwing it away", async () => {
    const { invoiceId } = await anInvoice();
    await raw`
      insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, ${TO}, 'email', 'hard_bounce')`;

    const result = await invoiceDelivery.send(ctx(), { invoiceId });

    expect(result.state).toBe("refused");
    expect(result.reason).toBe("suppressed");
    expect(result.explanation).toMatch(/do-not-email/i);

    const rows = await deliveryRows(invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toContain("suppressed");
    /** Nothing was handed over, and the row says so rather than claiming it was. */
    expect(rows[0]!.submitted_at).toBeNull();
    expect(rows[0]!.message_id).toBeNull();
    expect((await messageCount())[0]!.n).toBe("0");
  });

  it("records a refusal when no mail provider is connected", async () => {
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
    const { invoiceId } = await anInvoice();

    const result = await invoiceDelivery.send(ctx(), { invoiceId });
    expect(result.state).toBe("refused");
    expect(result.reason).toBe("channel_not_registered");
  });

  it("puts the refused invoice on the undelivered list with the money beside it", async () => {
    const { invoiceId, number } = await anInvoice({ total: "458.00" });
    await raw`
      insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, ${TO}, 'email', 'hard_bounce')`;
    await invoiceDelivery.send(ctx(), { invoiceId });

    const { invoices } = await invoiceDelivery.undelivered(ctx(), {});
    const found = invoices.find((i) => i.invoiceId === invoiceId);
    expect(found).toBeDefined();
    expect(found!.state).toBe("refused");
    expect(found!.number).toBe(number);
    expect(Number(found!.balance)).toBe(458);
  });
});

/* ======================================================= the link itself */

run("the link a customer with no account can open", () => {
  it("opens the invoice and shows what the customer is entitled to see", async () => {
    const { invoiceId } = await anInvoice({ total: "458.00" });
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });

    const view = await invoiceDelivery.viewInvoice(db(), { token: tokenOf(sent.portalUrl) });
    expect(view.organizationName).toBe("Invoice Co");
    expect(Number(view.balance)).toBe(458);
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]!.name).toBe("Condenser replacement");
    expect(view.payable).toBe(true);
    /** No processor connected, so the pay button would lead nowhere. */
    expect(view.onlinePaymentAvailable).toBe(false);
  });

  it("never exposes the unit cost, which is not the customer's to have", async () => {
    const { invoiceId } = await anInvoice();
    await raw`update public.invoice_line set unit_cost = '210.00' where invoice_id = ${invoiceId}`;
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });

    const view = await invoiceDelivery.viewInvoice(db(), { token: tokenOf(sent.portalUrl) });
    expect(JSON.stringify(view)).not.toContain("210.00");
    expect(Object.keys(view.lines[0]!)).not.toContain("unitCost");
  });

  it("refuses a token for a different kind of record", async () => {
    /**
     * The subject comes from the grant. A customer grant pointed at nothing
     * must not open an invoice, or the scope on a grant means nothing.
     */
    const { customerId } = await anInvoice();
    const issued = await portal.issueGrant(ctx(), {
      customerId, scope: "customer", expiresInDays: 30,
    });
    await expect(invoiceDelivery.viewInvoice(db(), { token: tokenOf(issued.url) }))
      .rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("refuses a revoked link", async () => {
    const { invoiceId } = await anInvoice();
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });
    const [row] = await deliveryRows(invoiceId);
    await raw`update public.portal_grant set revoked_at = now() where id = ${row!.portal_grant_id}`;

    await expect(invoiceDelivery.viewInvoice(db(), { token: tokenOf(sent.portalUrl) }))
      .rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("records the grant so a link sent to the wrong address can be withdrawn", async () => {
    const { invoiceId } = await anInvoice();
    await invoiceDelivery.send(ctx(), { invoiceId, to: "typo@wrong.test" });

    const { deliveries } = await invoiceDelivery.history(ctx(), { invoiceId });
    expect(deliveries[0]!.portalGrantId).not.toBeNull();
    expect(deliveries[0]!.linkActive).toBe(true);

    await raw`update public.portal_grant set revoked_at = now()
              where id = ${deliveries[0]!.portalGrantId}`;
    const after = await invoiceDelivery.history(ctx(), { invoiceId });
    /** The operator has to be able to see that the bad link is dead. */
    expect(after.deliveries[0]!.linkActive).toBe(false);
  });

  it("issues a link without sending anything when asked", async () => {
    const { invoiceId } = await anInvoice();
    const result = await invoiceDelivery.send(ctx(), { invoiceId, channel: "portal_link" });

    expect(result.state).toBe("link_issued");
    /** Nobody knows where the operator will paste it, so no address is claimed. */
    expect(result.destination).toBeNull();
    expect((await messageCount())[0]!.n).toBe("0");

    const view = await invoiceDelivery.viewInvoice(db(), { token: tokenOf(result.portalUrl) });
    expect(view.number).toBeGreaterThan(0);
  });
});

/* ========================================================= the pay path */

run("paying from the link", () => {
  it("charges the invoice balance rather than anything the caller named", async () => {
    await connectProcessor();
    const charges: ChargeRecord[] = [];
    const { invoiceId } = await anInvoice({ total: "458.00" });
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });

    const start = await invoiceDelivery.startPayment(
      db(), { token: tokenOf(sent.portalUrl) }, undefined, payDeps(fakeProcessor(charges)),
    );

    /** Four decimal places is the money type's own scale, not a rounding. */
    expect(Number(start.amount)).toBe(458);
    expect(charges).toHaveLength(1);
    /**
     * THE AMOUNT IS READ FROM THE BALANCE. There is no field on the input a
     * browser could use to name a dollar against a four hundred dollar
     * invoice, and no invoice id it could swap.
     */
    expect(charges[0]!.amountMinor).toBe(45800);
  });

  it("creates no payment, because a browser saying so is a claim by a browser", async () => {
    await connectProcessor();
    const { invoiceId } = await anInvoice();
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });
    await invoiceDelivery.startPayment(
      db(), { token: tokenOf(sent.portalUrl) }, undefined, payDeps(fakeProcessor([])),
    );

    const [payments] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.payment where organization_id = ${ORG}`;
    expect(payments!.n).toBe("0");

    const [invoice] = await raw<{ status: string; balance: string }[]>`
      select status, balance::text from public.invoice where id = ${invoiceId}`;
    expect(invoice!.status).toBe("open");
  });

  it("names the grant in the audit trail rather than a sleeping user", async () => {
    await connectProcessor();
    const { invoiceId } = await anInvoice();
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });
    await invoiceDelivery.startPayment(
      db(), { token: tokenOf(sent.portalUrl) }, undefined, payDeps(fakeProcessor([])),
    );

    const [entry] = await raw<{ actor_user_id: string | null; actor_portal_grant_id: string | null }[]>`
      select actor_user_id, actor_portal_grant_id from public.audit_log
      where organization_id = ${ORG} and action = 'payment.intent_created'`;
    expect(entry!.actor_user_id).toBeNull();
    expect(entry!.actor_portal_grant_id).not.toBeNull();
  });

  it("refuses when there is nothing outstanding", async () => {
    await connectProcessor();
    const { invoiceId } = await anInvoice();
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });
    await raw`update public.invoice set balance = '0', status = 'paid' where id = ${invoiceId}`;

    await expect(invoiceDelivery.startPayment(
      db(), { token: tokenOf(sent.portalUrl) }, undefined, payDeps(fakeProcessor([])),
    )).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a link for anything that is not an invoice", async () => {
    await connectProcessor();
    const { customerId } = await anInvoice();
    const issued = await portal.issueGrant(ctx(), {
      customerId, scope: "customer", expiresInDays: 30,
    });
    await expect(invoiceDelivery.startPayment(
      db(), { token: tokenOf(issued.url) }, undefined, payDeps(fakeProcessor([])),
    )).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("says a pay button would lead somewhere once a processor is connected", async () => {
    await connectProcessor();
    const { invoiceId } = await anInvoice();
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });
    const view = await invoiceDelivery.viewInvoice(db(), { token: tokenOf(sent.portalUrl) });
    expect(view.onlinePaymentAvailable).toBe(true);
  });
});

/* =================================================== the outcome coming back */

run("what the provider says afterwards", () => {
  it("follows the message from queued to sent to delivered", async () => {
    const { invoiceId } = await anInvoice();
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });

    const first = await invoiceDelivery.history(ctx(), { invoiceId });
    expect(first.deliveries[0]!.state).toBe("queued");

    const provider = fakeMail();
    await flushMail(provider);
    expect(provider.sent).toHaveLength(1);

    const after = await invoiceDelivery.history(ctx(), { invoiceId });
    expect(after.deliveries[0]!.state).toBe("sent");
    expect(after.deliveries[0]!.sentAt).not.toBeNull();

    await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: sent.messageId!, type: "delivered",
    });

    const final = await invoiceDelivery.history(ctx(), { invoiceId });
    expect(final.deliveries[0]!.state).toBe("delivered");
    expect(final.deliveries[0]!.deliveredAt).not.toBeNull();
  });

  it("shows a bounce as a bounce, with the provider's own words", async () => {
    const { invoiceId } = await anInvoice();
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });
    await flushMail(fakeMail());

    await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: sent.messageId!, type: "bounced",
      permanent: true, code: "550", message: "No such recipient here",
    });

    const { deliveries } = await invoiceDelivery.history(ctx(), { invoiceId });
    expect(deliveries[0]!.state).toBe("bounced");
    expect(deliveries[0]!.failureReason).toBe("No such recipient here");
  });

  it("puts a bounced invoice on the undelivered list beside the balance", async () => {
    /**
     * THE WHOLE POINT. A bounced invoice and a late payer are the same row on
     * an ageing report and need opposite responses: one gets chased, the
     * other gets a correct address.
     */
    const { invoiceId } = await anInvoice({ total: "458.00" });
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });
    await flushMail(fakeMail());

    const beforeBounce = await invoiceDelivery.undelivered(ctx(), {});
    expect(beforeBounce.invoices.find((i) => i.invoiceId === invoiceId)).toBeUndefined();

    await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: sent.messageId!, type: "bounced",
      permanent: true, code: "550", message: "No such recipient here",
    });

    const { invoices } = await invoiceDelivery.undelivered(ctx(), {});
    const found = invoices.find((i) => i.invoiceId === invoiceId);
    expect(found).toBeDefined();
    expect(found!.state).toBe("bounced");
    expect(found!.destination).toBe(TO);
    expect(found!.failureReason).toBe("No such recipient here");
  });

  it("shows a spam complaint without calling it a delivery failure", async () => {
    const { invoiceId } = await anInvoice();
    const sent = await invoiceDelivery.send(ctx(), { invoiceId });
    await flushMail(fakeMail());
    await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: sent.messageId!, type: "delivered",
    });
    await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: sent.messageId!, type: "complained",
    });

    const { deliveries } = await invoiceDelivery.history(ctx(), { invoiceId });
    /** It arrived. A human read it and pressed a button. Both facts are kept. */
    expect(deliveries[0]!.state).toBe("delivered");
    expect(deliveries[0]!.complained).toBe(true);
  });

  it("lists an invoice nobody ever tried to send", async () => {
    const { invoiceId } = await anInvoice();
    const { invoices } = await invoiceDelivery.undelivered(ctx(), {});
    const found = invoices.find((i) => i.invoiceId === invoiceId);
    expect(found).toBeDefined();
    expect(found!.state).toBe("never_attempted");
    expect(found!.deliveryId).toBeNull();
  });

  it("drops an invoice off the list once it is paid", async () => {
    const { invoiceId } = await anInvoice();
    await raw`update public.invoice set balance = '0', status = 'paid' where id = ${invoiceId}`;
    const { invoices } = await invoiceDelivery.undelivered(ctx(), {});
    expect(invoices.find((i) => i.invoiceId === invoiceId)).toBeUndefined();
  });

  it("does not call a handed-over link a problem", async () => {
    /**
     * A portal link tells us nothing after it is minted, and an operator's
     * list that fills with every link they ever issued is a list they learn
     * to ignore.
     */
    const { invoiceId } = await anInvoice();
    await invoiceDelivery.send(ctx(), { invoiceId, channel: "portal_link" });
    const { invoices } = await invoiceDelivery.undelivered(ctx(), {});
    expect(invoices.find((i) => i.invoiceId === invoiceId)).toBeUndefined();
  });
});

/* ========================================================== the guards */

run("who may do this", () => {
  it("lets the Finance role send, although it holds no messaging permission", async () => {
    /**
     * `ROLE_PRESETS.accountant` holds `invoice:send` and neither
     * `message:send` nor `portal:grant`. That role exists to send invoices.
     * If the transport's permission were required as well, the one role whose
     * job this is could not do it.
     */
    const { invoiceId } = await anInvoice();
    const result = await invoiceDelivery.send(accountant(), { invoiceId });
    expect(result.state).toBe("queued");
  });

  it("refuses somebody without invoice:send", async () => {
    const { invoiceId } = await anInvoice();
    await expect(invoiceDelivery.send(dispatcher(), { invoiceId }))
      .rejects.toThrow(/invoice:send/);
  });

  it("refuses somebody without invoice:read on the delivery log", async () => {
    const { invoiceId } = await anInvoice();
    await invoiceDelivery.send(ctx(), { invoiceId });
    await expect(invoiceDelivery.history(dispatcher(), { invoiceId }))
      .rejects.toThrow(/invoice:read/);
    await expect(invoiceDelivery.undelivered(dispatcher(), {}))
      .rejects.toThrow(/invoice:read/);
  });

  it("still honours a deliberate revocation of messaging", async () => {
    /**
     * The transport permission is added to the caller's grants, and
     * revocation beats a grant. Somebody who was explicitly barred from
     * messaging customers stays barred, and the error names the permission
     * rather than failing silently.
     */
    const { invoiceId } = await anInvoice();
    const barred: ServiceContext = {
      actor: {
        userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"],
        revocations: ["message:send"],
      },
      db: db(),
    };
    await expect(invoiceDelivery.send(barred, { invoiceId }))
      .rejects.toThrow(/message:send/);
  });
});

/* ====================================================== the derivation */

describe("the state of one attempt", () => {
  /**
   * Pure, so every message status is covered without a database. Two call
   * sites deciding separately what "bounced" means is how a list screen and a
   * detail screen come to disagree about the same row.
   */
  const row = (over: Partial<Parameters<typeof invoiceDelivery.stateOf>[0]> = {}) => ({
    channel: "email", submittedAt: new Date(), error: null,
    messageId: "m", messageStatus: "sent", ...over,
  });

  it("calls a refusal a refusal whatever else is on the row", () => {
    expect(invoiceDelivery.stateOf(row({ error: "suppressed: they asked to stop" })))
      .toBe("refused");
  });

  it("calls an attempt with no message interrupted", () => {
    expect(invoiceDelivery.stateOf(row({ messageId: null, messageStatus: null })))
      .toBe("interrupted");
  });

  it("maps every message status a send can reach", () => {
    expect(invoiceDelivery.stateOf(row({ messageStatus: "queued" }))).toBe("queued");
    expect(invoiceDelivery.stateOf(row({ messageStatus: "sending" }))).toBe("queued");
    expect(invoiceDelivery.stateOf(row({ messageStatus: "sent" }))).toBe("sent");
    expect(invoiceDelivery.stateOf(row({ messageStatus: "delivered" }))).toBe("delivered");
    expect(invoiceDelivery.stateOf(row({ messageStatus: "undelivered" }))).toBe("bounced");
    expect(invoiceDelivery.stateOf(row({ messageStatus: "failed" }))).toBe("failed");
  });

  it("knows which states mean the customer did not get it", () => {
    expect(invoiceDelivery.isUndelivered("bounced")).toBe(true);
    expect(invoiceDelivery.isUndelivered("refused")).toBe(true);
    expect(invoiceDelivery.isUndelivered("interrupted")).toBe(true);
    expect(invoiceDelivery.isUndelivered("failed")).toBe(true);
    /**
     * `sent` is all a plain SMTP relay will ever say. Treating it as a
     * problem would fill the list with every message a self hoster sends.
     */
    expect(invoiceDelivery.isUndelivered("sent")).toBe(false);
    expect(invoiceDelivery.isUndelivered("queued")).toBe(false);
    expect(invoiceDelivery.isUndelivered("delivered")).toBe(false);
    expect(invoiceDelivery.isUndelivered("link_issued")).toBe(false);
  });

  it("calls a link issued rather than sent", () => {
    expect(invoiceDelivery.stateOf(row({ channel: "portal_link", messageId: null, messageStatus: null })))
      .toBe("link_issued");
    expect(invoiceDelivery.stateOf(row({ channel: "portal_link", submittedAt: null, messageId: null, messageStatus: null })))
      .toBe("interrupted");
  });
});
