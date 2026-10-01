import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as estimates from "../src/services/estimates";
import * as deposits from "../src/services/deposits";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as payments from "../src/services/payments";
import * as portal from "../src/services/portal";
import * as portalAccount from "../src/services/portal-account";
import type { ChargeOutcome, PaymentProvider, RefundOutcome } from "../src/payments/provider";
import { InvalidGrantError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * THE CUSTOMER LINK AND THE DEPOSIT LINK
 *
 * Both were URLs the product could hand a customer with no page behind them.
 * The deposit one was also the deposit's bare id. These are the services
 * behind the two pages, driven the way the pages drive them: from the token
 * alone, with a fake processor so nothing is charged.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-account:org");
const USER = fixtureId("portal-account:user");
const KEY_REF = "TEST_PORTAL_ACCOUNT_STRIPE_KEY";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const tokenOf = (link: string) => link.split("/").pop()!;

function fakeProcessor(charges: number[]): PaymentProvider {
  return {
    name: "stripe",
    publishableKey: "pk_test_account",
    async charge(request): Promise<ChargeOutcome> {
      charges.push(request.amountMinor);
      return {
        ok: true,
        intent: {
          intentId: `pi_acct_${charges.length}_${Math.random().toString(36).slice(2)}`,
          clientSecret: "secret", amountMinor: request.amountMinor,
          currency: "usd", status: "requires_payment_method",
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
const deps = (provider: PaymentProvider): payments.PaymentDeps =>
  ({ readSecret: async () => "sk_test_notreal", provider });

async function connectProcessor(): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', ${KEY_REF},
            ${raw.json({ publishableKey: "pk_test_account" } as never)})
    returning id`;
  return row!.id;
}

async function aCustomer(name: string) {
  const c = await customers.create(owner(), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const [p] = await raw<{ id: string }[]>`insert into public.property
    (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '118 Mesquite Ln', 'Austin', 'TX', '78702') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
    values (${ORG}, ${c.id}, ${p!.id})`;
  return { customerId: c.id, propertyId: p!.id };
}

async function anInvoice(customerId: string, total: string) {
  const invoice = await billing.create(owner(), {
    customerId,
    lines: [{ name: "Repair", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  // Sent, as far as the customer is concerned: a draft is the office's and is not shown.
  await raw`update public.invoice set status = 'open' where id = ${invoice.id as string} and status = 'draft'`;
  return invoice.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Account Co", slug: "account-co" });
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.integration_connection where organization_id = ${ORG}`;
});

run("the deposit link", () => {
  async function approvedWithDeposit() {
    const { customerId, propertyId } = await aCustomer("Dana Deposit");
    const created = await estimates.create(owner(), {
      customerId, propertyId, taxRate: "0",
      options: [{
        name: "Replace", isRecommended: true,
        lines: [{
          name: "Condenser", quantity: "1", unitPrice: "2000.00", unitCost: "900.00",
          discountAmount: "0", taxable: false, isOptional: false, isSelected: false,
        }],
      }],
    }) as Record<string, unknown>;
    const estimateId = created["id"] as string;
    await deposits.request(owner(), { customerId, estimateId, amount: "500.00" });
    const sent = await estimates.send(owner(), { id: estimateId, channel: "email", expiresInDays: 30 });
    const token = tokenOf(sent.approvalUrl);
    const view = await portal.viewEstimate(db(), { token });
    const approved = await portal.approveEstimate(db(), {
      token, optionId: view.options[0]!.id, selectedLineIds: [], signerName: "Dana", acceptedTerms: true,
    });
    return { customerId, estimateId, approved };
  }

  it("is a token to a page, not the deposit's id", async () => {
    const { approved } = await approvedWithDeposit();
    expect(approved.depositDue).toBe("500.0000");
    expect(approved.paymentUrl).toMatch(/\/pay\/[A-Za-z0-9_-]{43}$/);

    const [deposit] = await raw<{ id: string }[]>`
      select id from public.deposit where organization_id = ${ORG} order by created_at desc limit 1`;
    expect(approved.paymentUrl).not.toContain(deposit!.id);

    const view = await portalAccount.viewDeposit(db(), { token: tokenOf(approved.paymentUrl!) });
    expect(view.outstanding).toBe("500.0000");
    expect(view.payable).toBe(true);
    expect(view.estimateNumber).not.toBeNull();
  });

  it("charges what is outstanding and holds it as a deposit when the processor says it arrived", async () => {
    const connectionId = await connectProcessor();
    const { approved } = await approvedWithDeposit();
    const token = tokenOf(approved.paymentUrl!);
    const charges: number[] = [];

    const start = await portalAccount.startDepositPayment(db(), { token }, undefined, deps(fakeProcessor(charges)));
    expect(charges).toEqual([50000]);

    const connection = (await payments.connectionById(db(), connectionId))!;
    const event: payments.PaymentEvent = {
      eventId: `evt_${Math.random().toString(36).slice(2)}`, kind: "succeeded",
      type: "payment_intent.succeeded", intentId: start.intentId, amountMinor: 50000,
      currency: "usd", feeMinor: null, refundedMinor: null, metadata: {}, failureMessage: null,
    };
    expect((await payments.receive(db(), { connection, event })).handled).toBe(true);

    const view = await portalAccount.viewDeposit(db(), { token });
    expect(view.status).toBe("held");
    expect(Number(view.amountReceived)).toBe(500);
    expect(view.payable).toBe(false);

    /** No invoice payment: a deposit is a liability, not a sale. */
    const [n] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.payment where organization_id = ${ORG}`;
    expect(n!.n).toBe(0);

    /** And a second delivery of the same event does not hold it twice. */
    await payments.receive(db(), { connection, event: { ...event, eventId: `${event.eventId}_again` } });
    expect(Number((await portalAccount.viewDeposit(db(), { token })).amountReceived)).toBe(500);
  });

  it("opens nothing for a link of another scope", async () => {
    const { customerId } = await aCustomer("Wrong Scope");
    const issued = await portal.issueGrant(owner(), { customerId, scope: "customer", expiresInDays: 30 });
    await expect(portalAccount.viewDeposit(db(), { token: tokenOf(issued.url) }))
      .rejects.toBeInstanceOf(InvalidGrantError);
  });
});

run("the customer link", () => {
  it("shows the customer their own invoices, and nobody else's", async () => {
    const mine = await aCustomer("Casey Customer");
    const theirs = await aCustomer("Someone Else");
    const myInvoice = await anInvoice(mine.customerId, "120.00");
    await anInvoice(theirs.customerId, "999.00");

    const issued = await portal.issueGrant(owner(), {
      customerId: mine.customerId, scope: "customer", expiresInDays: 30,
    });
    expect(issued.url).toMatch(/\/c\/[A-Za-z0-9_-]{43}$/);

    const account = await portalAccount.viewAccount(db(), { token: tokenOf(issued.url) });
    expect(account.customerName).toBe("Casey Customer");
    const ids = account.invoices.map((i) => i.id);
    expect(ids.every((id) => id === myInvoice)).toBe(true);
    expect(JSON.stringify(account)).not.toContain("999");
  });

  it("pays one of the customer's invoices and refuses another customer's", async () => {
    await connectProcessor();
    const mine = await aCustomer("Casey Pays");
    const theirs = await aCustomer("Not Casey");
    const myInvoice = await anInvoice(mine.customerId, "80.00");
    const theirInvoice = await anInvoice(theirs.customerId, "80.00");

    const issued = await portal.issueGrant(owner(), {
      customerId: mine.customerId, scope: "customer", expiresInDays: 30,
    });
    const token = tokenOf(issued.url);
    const charges: number[] = [];

    await portalAccount.startInvoicePayment(db(), { token, invoiceId: myInvoice }, undefined, deps(fakeProcessor(charges)));
    expect(charges).toEqual([8000]);

    await expect(portalAccount.startInvoicePayment(
      db(), { token, invoiceId: theirInvoice }, undefined, deps(fakeProcessor(charges)),
    )).rejects.toBeInstanceOf(NotFoundError);
    expect(charges).toEqual([8000]);
  });
});
