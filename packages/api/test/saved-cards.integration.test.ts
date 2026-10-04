import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as payments from "../src/services/payments";
import * as portal from "../src/services/portal";
import * as savedCards from "../src/services/saved-cards";
import type {
  CardSetup, CardVault, ChargeOutcome, ChargeRequest, PaymentProvider, RefundOutcome,
} from "../src/payments/provider";
import {
  ConflictError, InvalidGrantError, NotFoundError, inTenant, type ServiceContext,
} from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A CARD THE CUSTOMER SAVED
 *
 * Saved through the processor's own setup flow, so the number never reaches
 * this server; recorded only when the processor, asked with the company's
 * key, says the setup succeeded for the processor customer made for THIS
 * customer; removed by telling the processor first; and paying with one is
 * still settled only by the processor's signed webhook. The processor is a
 * fake that records what it was asked, so nothing is charged.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("saved-cards:org");
const USER = fixtureId("saved-cards:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** Stripe, as far as these services can tell. */
class FakeStripe implements PaymentProvider {
  readonly name = "stripe";
  readonly publishableKey = "pk_test_cards";
  charges: ChargeRequest[] = [];
  customers: string[] = [];
  setups = new Map<string, CardSetup>();
  detached: string[] = [];
  refuseDetach = false;
  /** What the next setup will say when it is read back. */
  nextStatus = "succeeded";
  nextCustomerRef: string | null = null;

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.charges.push(request);
    return {
      ok: true,
      intent: {
        intentId: `pi_cards_${this.charges.length}_${Math.random().toString(36).slice(2)}`,
        clientSecret: "pi_secret", amountMinor: request.amountMinor, currency: "usd",
        status: request.paymentMethodRef ? "succeeded" : "requires_payment_method",
      },
    };
  }

  async refund(): Promise<RefundOutcome> {
    return { ok: true, refund: { refundId: "re_1", amountMinor: 0, status: "pending" } };
  }

  verify = () => true;
  parseEvent = () => null;

  cards: CardVault = {
    createCustomer: async () => {
      const ref = `cus_${this.customers.length + 1}_${Math.random().toString(36).slice(2, 8)}`;
      this.customers.push(ref);
      return { ok: true, value: { customerRef: ref } };
    },
    startSetup: async (request) => {
      const setupId = `seti_${this.setups.size + 1}_${Math.random().toString(36).slice(2, 8)}`;
      this.setups.set(setupId, {
        setupId,
        status: this.nextStatus,
        customerRef: this.nextCustomerRef ?? request.customerRef,
        card: { ref: `pm_${setupId}`, brand: "visa", last4: "4242", expMonth: 4, expYear: 2031 },
        metadata: request.metadata ?? {},
      });
      return { ok: true, value: { setupId, clientSecret: `${setupId}_secret` } };
    },
    readSetup: async (setupId) => {
      const setup = this.setups.get(setupId);
      if (!setup) return { ok: false, code: "resource_missing", message: "No such setup.", retryable: false };
      return { ok: true, value: setup };
    },
    detach: async (cardRef) => {
      if (this.refuseDetach) return { ok: false, code: "api_error", message: "Stripe is having a moment.", retryable: true };
      this.detached.push(cardRef);
      return { ok: true, value: { detached: true } };
    },
  };
}

let stripe: FakeStripe;
const deps = (): payments.PaymentDeps => ({ readSecret: async () => "sk_test_notreal", provider: stripe });

let dana = "";
let eli = "";
let connectionId = "";

async function aCustomer(name: string) {
  const c = await customers.create(owner(), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  return c.id as string;
}

/** A sign in, minted the way a right code mints one. */
async function signedIn(customerId: string): Promise<string> {
  const [signIn] = await raw<{ id: string }[]>`insert into public.portal_sign_in
    (organization_id, channel, address, expires_at, ended_at, ended_reason, customer_id)
    values (${ORG}, 'email', 'someone@cards.test', now(), now(), 'signed_in', ${customerId}) returning id`;
  const minted = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId, scope: "customer", expiresInDays: 7, signInId: signIn!.id,
  }));
  return minted.token;
}

async function anInvoice(customerId: string, total: string, payer?: string) {
  const invoice = await billing.create(owner(), {
    customerId,
    lines: [{ name: "Tune up", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  await raw`update public.invoice set status = 'open' where id = ${invoice.id as string} and status = 'draft'`;
  if (payer) await raw`update public.invoice set payer_customer_id = ${payer} where id = ${invoice.id as string}`;
  return invoice.id as string;
}

async function saveACard(token: string) {
  const started = await savedCards.startSave(db(), { token }, undefined, deps());
  return savedCards.confirmSave(db(), { token, setupId: started.setupId }, deps());
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Saved Cards Air", slug: "saved-cards-air" });
  const [row] = await raw<{ id: string }[]>`
    insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', 'TEST_SAVED_CARDS_KEY',
            ${raw.json({ publishableKey: "pk_test_cards" } as never)})
    returning id`;
  connectionId = row!.id;
  dana = await aCustomer("Dana Card");
  eli = await aCustomer("Eli Card");
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(() => {
  stripe = new FakeStripe();
});

run("saving a card", () => {
  it("is recorded only once the processor says the setup succeeded, and only the card's description is kept", async () => {
    const token = await signedIn(dana);
    stripe.nextStatus = "requires_payment_method";
    const started = await savedCards.startSave(db(), { token }, undefined, deps());
    expect(started.clientSecret).toContain("_secret");
    expect(started.publishableKey).toBe("pk_test_cards");

    // Back from Stripe with a setup that did not go through: nothing is saved.
    await expect(savedCards.confirmSave(db(), { token, setupId: started.setupId }, deps())).rejects.toThrow(ConflictError);
    expect((await savedCards.list(db(), { token })).cards).toHaveLength(0);

    // The same setup, now succeeded.
    stripe.setups.get(started.setupId)!.status = "succeeded";
    const card = await savedCards.confirmSave(db(), { token, setupId: started.setupId }, deps());
    expect(card).toMatchObject({ brand: "visa", last4: "4242", expMonth: 4, expYear: 2031 });

    // A refresh of the page Stripe returned to records it once.
    await savedCards.confirmSave(db(), { token, setupId: started.setupId }, deps());
    expect((await savedCards.list(db(), { token })).cards).toHaveLength(1);

    const [row] = await raw<Record<string, unknown>[]>`select * from public.saved_payment_method where id = ${card.id}`;
    expect(Object.keys(row!).sort()).toEqual([
      "brand", "created_at", "customer_id", "exp_month", "exp_year", "external_ref", "id", "kind", "last4",
      "organization_id", "profile_id", "provider", "removed_at", "saved_by_grant_id", "updated_at",
    ]);
  });

  it("makes one processor customer per customer, however many cards they save", async () => {
    const token = await signedIn(dana);
    await saveACard(token);
    await saveACard(token);
    const profiles = await raw`select 1 from public.payment_profile
      where organization_id = ${ORG} and customer_id = ${dana} and connection_id = ${connectionId}`;
    expect(profiles).toHaveLength(1);
  });

  it("refuses a setup another customer started, and one the processor made for somebody else", async () => {
    const theirs = await signedIn(eli);
    const started = await savedCards.startSave(db(), { token: theirs }, undefined, deps());
    const mine = await signedIn(dana);
    await expect(savedCards.confirmSave(db(), { token: mine, setupId: started.setupId }, deps()))
      .rejects.toThrow(NotFoundError);

    stripe.nextCustomerRef = "cus_somebody_else";
    const forged = await savedCards.startSave(db(), { token: mine }, undefined, deps());
    await expect(savedCards.confirmSave(db(), { token: mine, setupId: forged.setupId }, deps()))
      .rejects.toThrow(NotFoundError);
  });

  it("is refused to a link somebody was sent, which can be forwarded", async () => {
    const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
      organizationId: ORG, customerId: dana, scope: "customer", expiresInDays: 30,
    }));
    await expect(savedCards.startSave(db(), { token: link.token }, undefined, deps())).rejects.toThrow(InvalidGrantError);
  });
});

run("seeing and removing a card", () => {
  it("lists only this customer's cards, and another customer's card is not found", async () => {
    const mine = await signedIn(dana);
    const theirs = await signedIn(eli);
    const card = await saveACard(theirs);
    expect((await savedCards.list(db(), { token: mine })).cards.map((c) => c.id)).not.toContain(card.id);
    await expect(savedCards.remove(db(), { token: mine, cardId: card.id }, undefined, deps())).rejects.toThrow(NotFoundError);
    const invoiceId = await anInvoice(dana, "100.00");
    await expect(savedCards.pay(db(), { token: mine, invoiceId, cardId: card.id }, undefined, deps()))
      .rejects.toThrow(NotFoundError);
  });

  it("tells the processor to forget it first, and keeps it when the processor will not", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const ref = (await raw<{ external_ref: string }[]>`select external_ref from public.saved_payment_method where id = ${card.id}`)[0]!.external_ref;

    stripe.refuseDetach = true;
    await expect(savedCards.remove(db(), { token, cardId: card.id }, undefined, deps())).rejects.toThrow(ConflictError);
    expect((await savedCards.list(db(), { token })).cards.map((c) => c.id)).toContain(card.id);

    stripe.refuseDetach = false;
    await savedCards.remove(db(), { token, cardId: card.id }, undefined, deps());
    expect(stripe.detached).toEqual([ref]);
    expect((await savedCards.list(db(), { token })).cards.map((c) => c.id)).not.toContain(card.id);
    // Removing it again is the state already asked for.
    await savedCards.remove(db(), { token, cardId: card.id }, undefined, deps());
  });
});

run("paying with a saved card", () => {
  it("confirms the charge with the card on the spot, and the invoice changes only when the webhook says so", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const invoiceId = await anInvoice(dana, "180.00");

    const paid = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps());
    expect(paid.status).toBe("succeeded");
    expect(paid.amount).toBe("180.0000");
    const [request] = stripe.charges;
    expect(request!.amountMinor).toBe(18000);
    expect(request!.paymentMethodRef).toMatch(/^pm_/);
    expect(request!.customerRef).toMatch(/^cus_/);

    const before = await raw<{ status: string; balance: string }[]>`select status, balance from public.invoice where id = ${invoiceId}`;
    expect(before[0]).toEqual({ status: "open", balance: "180.0000" });

    const connection = (await payments.connectionById(db(), connectionId))!;
    await payments.receive(db(), {
      connection,
      event: {
        eventId: `evt_cards_${Math.random().toString(36).slice(2)}`, kind: "succeeded", type: "payment_intent.succeeded",
        intentId: paid.intentId, amountMinor: 18000, currency: "usd", feeMinor: 552, refundedMinor: null,
        metadata: {}, failureMessage: null,
      },
    });
    const after = await raw<{ status: string; balance: string }[]>`select status, balance from public.invoice where id = ${invoiceId}`;
    expect(after[0]).toEqual({ status: "paid", balance: "0.0000" });
  });

  it("does not pay an invoice somebody else is billed for", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const invoiceId = await anInvoice(dana, "75.00", eli);
    await expect(savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps())).rejects.toThrow(ConflictError);
    expect(stripe.charges).toHaveLength(0);
  });

  it("does not use a card saved with a payment account the company has since replaced", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const invoiceId = await anInvoice(dana, "60.00");
    /** The card was saved against an account the company has since disconnected. */
    const [old] = await raw<{ id: string }[]>`
      insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
      values (${ORG}, 'payments', 'oldpay', 'disconnected', 'TEST_OLD_KEY', ${raw.json({} as never)})
      returning id`;
    await raw`update public.payment_profile set connection_id = ${old!.id} where customer_id = ${dana}`;
    try {
      await expect(savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps())).rejects.toThrow(ConflictError);
      expect(stripe.charges).toHaveLength(0);
    } finally {
      await raw`update public.payment_profile set connection_id = ${connectionId} where customer_id = ${dana}`;
      await raw`delete from public.integration_connection where id = ${old!.id}`;
    }
  });
});
