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

  it("is not repeatable: a repeat with the same key asks the processor for a second charge", async () => {
    /**
     * The title is kept as it was first written; what it names is gone.
     * This test showed the repeat reaching the processor as a second charge,
     * which is why `payPortalInvoiceWithCard` was not marked idempotent. A
     * repeat with the same key is now answered with the first charge and
     * never reaches the processor, so the contract marks the route
     * idempotent and this test asserts one charge (M26).
     */
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const invoiceId = await anInvoice(dana, "40.00");
    const meta = { idempotencyKey: `cards-repeat-${Date.now()}` };
    const first = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, meta, deps());
    const second = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, meta, deps());
    expect(stripe.charges).toHaveLength(1);
    expect(second).toMatchObject({ intentId: first.intentId, status: first.status, amount: first.amount });
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

/* =========================================== twice before the webhook === */

/**
 * PAYING TWICE BEFORE THE PROCESSOR'S WEBHOOK ARRIVES CHARGES ONCE.
 *
 * The fake here answers a repeated idempotency key with the intent it
 * answered the first time, as Stripe does, so "how many charges" is how
 * many different keys reached it.
 */
run("paying with a saved card twice before the webhook arrives", () => {
  type Intent = { intentId: string; status: string; clientSecret: string };
  let byKey: Map<string, Intent>;
  /** What the next new charge answers, how long it takes, and whether the next ask is lost on the way back. */
  let answer: string;
  let delayMs: number;
  let loseNext: boolean;

  beforeEach(() => {
    byKey = new Map();
    answer = "succeeded";
    delayMs = 0;
    loseNext = false;
    stripe.charge = async (request: ChargeRequest): Promise<ChargeOutcome> => {
      stripe.charges.push(request);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      let intent = byKey.get(request.idempotencyKey);
      if (!intent) {
        intent = {
          intentId: `pi_twice_${byKey.size + 1}_${Math.random().toString(36).slice(2)}`,
          status: answer,
          clientSecret: `secret_${byKey.size + 1}`,
        };
        byKey.set(request.idempotencyKey, intent);
      }
      if (loseNext) {
        loseNext = false;
        throw new Error("socket hang up");
      }
      return { ok: true, intent: { ...intent, amountMinor: request.amountMinor, currency: "usd" } };
    };
  });

  const keys = () => new Set(stripe.charges.map((c) => c.idempotencyKey)).size;
  const attempts = (invoiceId: string) => raw<{ id: string; status: string }[]>`select id, status from public.integration_event
    where organization_id = ${ORG} and event_type = 'payment.intent'
      and request_payload->'allocations' @> ${raw.json([{ invoiceId }] as never)}
    order by created_at`;
  const webhook = async (kind: "succeeded" | "failed" | "cancelled", intentId: string, amountMinor: number) => {
    const connection = (await payments.connectionById(db(), connectionId))!;
    await payments.receive(db(), {
      connection,
      event: {
        eventId: `evt_twice_${Math.random().toString(36).slice(2)}`, kind,
        type: kind === "succeeded" ? "payment_intent.succeeded" : kind === "failed" ? "payment_intent.payment_failed" : "payment_intent.canceled",
        intentId, amountMinor, currency: "usd", feeMinor: kind === "succeeded" ? 30 : null, refundedMinor: null,
        metadata: {}, failureMessage: kind === "failed" ? "Your card was declined." : null,
      },
    });
  };

  it("gives a second press the first charge back, and asks the processor once", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const invoiceId = await anInvoice(dana, "120.00");
    const first = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps());
    const second = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps());
    expect(stripe.charges).toHaveLength(1);
    expect(second).toMatchObject({ intentId: first.intentId, status: "succeeded", amount: "120.0000", tip: "0.0000" });
    expect(await attempts(invoiceId)).toHaveLength(1);

    // Once the webhook says the money moved, the invoice is paid and a third press is refused.
    await webhook("succeeded", first.intentId, 12000);
    await expect(savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps()))
      .rejects.toThrow(/nothing outstanding/);
    expect(stripe.charges).toHaveLength(1);
  });

  it("charges once when two requests arrive in the same instant", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const invoiceId = await anInvoice(dana, "95.00");
    /** Slow enough that the second request arrives while the first is still with the processor. */
    delayMs = 300;
    const [a, b] = await Promise.all([
      savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps()),
      savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps()),
    ]);
    expect(stripe.charges).toHaveLength(1);
    expect(a.intentId).toBe(b.intentId);
    expect(await attempts(invoiceId)).toHaveLength(1);
  });

  it("charges once when two tabs ask for different amounts in the same instant, and refuses the second in words", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const other = await saveACard(token);
    const invoiceId = await anInvoice(dana, "70.00");
    const number = (await raw<{ number: number }[]>`select number from public.invoice where id = ${invoiceId}`)[0]!.number;
    delayMs = 300;
    const results = await Promise.allSettled([
      savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps()),
      savedCards.pay(db(), { token, invoiceId, cardId: other.id }, undefined, deps()),
    ]);
    expect(stripe.charges).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ConflictError);
    expect((refused.reason as Error).message).toBe(
      `A payment for invoice ${number} is already going through. Wait for it to finish before paying again.`,
    );
  });

  it("refuses a different amount while the first charge is unresolved", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const invoiceId = await anInvoice(dana, "150.00");
    await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps());
    /** Part of it was paid another way meanwhile, so the same press is now for a different amount. */
    await raw`update public.invoice set balance = 100.0000, status = 'partially_paid' where id = ${invoiceId}`;
    await expect(savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps()))
      .rejects.toThrow(/is already going through\. Wait for it to finish before paying again\./);
    expect(stripe.charges).toHaveLength(1);
  });

  it("frees the invoice for a fresh payment once the webhook says the first failed, or was cancelled", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const invoiceId = await anInvoice(dana, "88.00");

    answer = "requires_action";
    const first = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps());
    expect(first.status).toBe("requires_action");
    await webhook("failed", first.intentId, 8800);
    expect((await attempts(invoiceId)).map((a) => a.status)).toEqual(["failed"]);

    answer = "succeeded";
    const second = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps());
    expect(second.intentId).not.toBe(first.intentId);
    expect(keys()).toBe(2);

    await webhook("cancelled", second.intentId, 8800);
    expect((await attempts(invoiceId)).map((a) => a.status)).toEqual(["failed", "abandoned"]);
    const third = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps());
    expect(third.intentId).not.toBe(second.intentId);
    expect(keys()).toBe(3);

    // The invoice was never marked paid by any of it.
    const [row] = await raw<{ status: string }[]>`select status from public.invoice where id = ${invoiceId}`;
    expect(row!.status).toBe("open");
  });

  it("gives the bank's check back to a second tab with what it needs to finish it, from the same intent", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const invoiceId = await anInvoice(dana, "64.00");
    answer = "requires_action";
    const first = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps());
    const second = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps());
    expect(second).toMatchObject({ intentId: first.intentId, status: "requires_action", clientSecret: first.clientSecret });
    // Asked again for the client secret, which is never stored, with the first attempt's own key: one charge.
    expect(stripe.charges).toHaveLength(2);
    expect(keys()).toBe(1);
  });

  it("stops holding the invoice after the window: an hour for a bank check, three days otherwise", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const other = await saveACard(token);

    const waiting = await anInvoice(dana, "40.00");
    answer = "requires_action";
    await savedCards.pay(db(), { token, invoiceId: waiting, cardId: card.id }, undefined, deps());
    answer = "succeeded";
    await expect(savedCards.pay(db(), { token, invoiceId: waiting, cardId: other.id }, undefined, deps()))
      .rejects.toThrow(/already going through/);
    await raw`update public.integration_event set created_at = now() - interval '61 minutes'
      where request_payload->'allocations' @> ${raw.json([{ invoiceId: waiting }] as never)}`;
    await savedCards.pay(db(), { token, invoiceId: waiting, cardId: other.id }, undefined, deps());
    expect(keys()).toBe(2);

    const moving = await anInvoice(dana, "41.00");
    await savedCards.pay(db(), { token, invoiceId: moving, cardId: card.id }, undefined, deps());
    await raw`update public.integration_event set created_at = now() - interval '71 hours'
      where request_payload->'allocations' @> ${raw.json([{ invoiceId: moving }] as never)}`;
    await expect(savedCards.pay(db(), { token, invoiceId: moving, cardId: other.id }, undefined, deps()))
      .rejects.toThrow(/already going through/);
    await raw`update public.integration_event set created_at = now() - interval '73 hours'
      where request_payload->'allocations' @> ${raw.json([{ invoiceId: moving }] as never)}`;
    await savedCards.pay(db(), { token, invoiceId: moving, cardId: other.id }, undefined, deps());
    expect(keys()).toBe(4);
    expect(payments.CHARGE_HOLD).toEqual({ moving: 72 * 3600_000, waiting: 3600_000 });
  });

  it("keeps a charge nobody heard back on, and asks the processor again with the same key", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const other = await saveACard(token);
    const invoiceId = await anInvoice(dana, "77.00");
    loseNext = true;
    await expect(savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps()))
      .rejects.toThrow(payments.ChargeUnansweredError);
    expect((await attempts(invoiceId)).map((a) => a.status)).toEqual(["pending"]);
    // Another card meanwhile would be a second charge if the first went through.
    await expect(savedCards.pay(db(), { token, invoiceId, cardId: other.id }, undefined, deps()))
      .rejects.toThrow(/already going through/);

    const again = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps());
    expect(again.status).toBe("succeeded");
    expect(stripe.charges).toHaveLength(2);
    expect(keys()).toBe(1);
    const [attempt] = await attempts(invoiceId);
    expect(stripe.charges[0]!.metadata).toMatchObject({ otos_attempt: attempt!.id });

    // The webhook finds the one attempt and the invoice is paid once.
    await webhook("succeeded", again.intentId, 7700);
    const [row] = await raw<{ status: string }[]>`select status from public.invoice where id = ${invoiceId}`;
    expect(row!.status).toBe("paid");
    const paid = await raw`select 1 from public.payment where processor_payment_id = ${again.intentId}`;
    expect(paid).toHaveLength(1);
  });

  it("answers a repeat of the same request key with the first answer, even once paid, and asks the processor with a key made from it", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const invoiceId = await anInvoice(dana, "52.00");
    const meta = { idempotencyKey: `twice-key-${Math.random().toString(36).slice(2)}` };

    // The answer to the first ask is lost, so the client sends it again with the same key.
    loseNext = true;
    await expect(savedCards.pay(db(), { token, invoiceId, cardId: card.id }, meta, deps()))
      .rejects.toThrow(payments.ChargeUnansweredError);
    const first = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, meta, deps());
    expect(keys()).toBe(1);
    expect(stripe.charges[0]!.idempotencyKey).toMatch(/^pay-[0-9a-f]{48}$/);
    expect(stripe.charges[0]!.idempotencyKey).not.toContain(meta.idempotencyKey);

    await webhook("succeeded", first.intentId, 5200);
    const later = await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, meta, deps());
    expect(later).toMatchObject({ intentId: first.intentId, status: "succeeded", amount: "52.0000" });
    expect(keys()).toBe(1);

    // The same key for another invoice is a different request, and is refused.
    const another = await anInvoice(dana, "53.00");
    await expect(savedCards.pay(db(), { token, invoiceId: another, cardId: card.id }, meta, deps()))
      .rejects.toThrow(/already used for a different payment/);
    // Another customer's request with the same key is their own.
    const theirs = await signedIn(eli);
    const theirCard = await saveACard(theirs);
    const theirInvoice = await anInvoice(eli, "54.00");
    const own = await savedCards.pay(db(), { token: theirs, invoiceId: theirInvoice, cardId: theirCard.id }, meta, deps());
    expect(own.intentId).not.toBe(first.intentId);
    expect(keys()).toBe(2);
  });

  it("refuses to start another card payment of the invoice from its link while the saved card's charge is unresolved", async () => {
    const token = await signedIn(dana);
    const card = await saveACard(token);
    const invoiceId = await anInvoice(dana, "66.00");
    await savedCards.pay(db(), { token, invoiceId, cardId: card.id }, undefined, deps());
    await expect(payments.intent(owner(), { customerId: dana, invoiceIds: [invoiceId] }, deps()))
      .rejects.toThrow(/already going through/);
    expect(stripe.charges).toHaveLength(1);
  });
});
