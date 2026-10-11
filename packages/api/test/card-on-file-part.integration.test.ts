import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as payments from "../src/services/payments";
import * as portal from "../src/services/portal";
import * as savedCards from "../src/services/saved-cards";
import * as cardOnFile from "../src/services/card-on-file";
import type {
  CardSetup, CardVault, ChargeOutcome, ChargeRequest, PaymentProvider, RefundOutcome,
} from "../src/payments/provider";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * PART OF A BILL ON A SAVED CARD, AND MORE THAN ONE CARD AGREED
 *
 * The office charges part of what an invoice owes to a card the customer
 * agreed may be charged: the processor is asked for exactly that, the money
 * lands on that invoice, and the rest stays owed. Every refusal of a whole
 * charge still holds for a part, and the part has its own: nothing, more
 * than is owed, fractions of a cent, a tip, and the customer's own browser
 * naming a figure. A customer keeps agreements on two cards and chooses which
 * pays automatically, and the next day try of a declined automatic payment
 * goes to the card they chose since.
 *
 * The processor is a fake that records what it was asked and answers as
 * told, so nothing is charged.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("card-part:org");
const USER = fixtureId("card-part:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(), ...extra,
});
const technician = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["technician"] as Actor["roles"] }, db: db(),
});

type Answer = "succeeded" | "processing" | { code: string; message: string };

/** Stripe, as far as these services can tell. */
class FakeStripe implements PaymentProvider {
  readonly name = "stripe";
  readonly publishableKey = "pk_test_part";
  charges: ChargeRequest[] = [];
  setups = new Map<string, CardSetup>();
  answers: Answer[] = ["succeeded"];

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.charges.push(request);
    const answer = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!;
    if (typeof answer === "object") return { ok: false, code: answer.code, message: answer.message, retryable: false };
    return {
      ok: true,
      intent: {
        intentId: `pi_part_${this.charges.length}_${Math.random().toString(36).slice(2)}`,
        clientSecret: "pi_secret", amountMinor: request.amountMinor, currency: "usd",
        status: request.paymentMethodRef ? answer : "requires_payment_method",
      },
    };
  }

  async refund(): Promise<RefundOutcome> {
    return { ok: true, refund: { refundId: "re_1", amountMinor: 0, status: "pending" } };
  }

  verify = () => true;
  parseEvent = () => null;

  cards: CardVault = {
    createCustomer: async () => ({ ok: true, value: { customerRef: `cus_${Math.random().toString(36).slice(2, 8)}` } }),
    startSetup: async (request) => {
      const setupId = `seti_${this.setups.size + 1}_${Math.random().toString(36).slice(2, 8)}`;
      const last4 = this.setups.size % 2 === 0 ? "4242" : "5556";
      this.setups.set(setupId, {
        setupId, status: "succeeded", customerRef: request.customerRef,
        card: { ref: `pm_${setupId}`, brand: "visa", last4, expMonth: 4, expYear: 2031 },
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
let connectionId = "";

async function aCustomer(name: string, email: string) {
  return (await customers.create(owner(), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {}, email,
  })).id as string;
}

async function signedIn(customerId: string): Promise<string> {
  const [signIn] = await raw<{ id: string }[]>`insert into public.portal_sign_in
    (organization_id, channel, address, expires_at, ended_at, ended_reason, customer_id)
    values (${ORG}, 'email', 'someone@part.test', now(), now(), 'signed_in', ${customerId}) returning id`;
  const minted = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId, scope: "customer", expiresInDays: 7, signInId: signIn!.id, contactId: null,
  }));
  return minted.token;
}

async function anInvoice(customerId: string, total: string) {
  const invoice = await billing.create(owner(), {
    customerId,
    lines: [{ name: "Furnace", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  return invoice.id as string;
}

async function saveACard(token: string) {
  const started = await savedCards.startSave(db(), { token }, undefined, deps());
  return savedCards.confirmSave(db(), { token, setupId: started.setupId }, deps());
}

async function wordsFor(token: string, cardId: string) {
  const listed = await savedCards.list(db(), { token });
  return listed.cards.find((c) => c.id === cardId)!.wording;
}

const agreed = async (token: string, cardId: string) =>
  cardOnFile.agree(db(), { token, cardId, wording: (await wordsFor(token, cardId)).agreement });

const settle = async (intentId: string, amountMinor: number) => {
  const connection = (await payments.connectionById(db(), connectionId))!;
  await payments.receive(db(), {
    connection,
    event: {
      eventId: `evt_part_${Math.random().toString(36).slice(2)}`, kind: "succeeded", type: "payment_intent.succeeded",
      intentId, amountMinor, currency: "usd", feeMinor: 30, refundedMinor: null, metadata: {}, failureMessage: null,
    },
  });
};

const invoiceRow = async (id: string) => (await raw<{ status: string; balance: string; amount_paid: string }[]>`
  select status, balance::text, amount_paid::text from public.invoice where id = ${id}`)[0]!;

const charges = (invoiceId: string) => raw<{
  id: string; trigger: string; attempt: number; status: string; amount: string; intent_id: string | null;
  saved_payment_method_id: string;
}[]>`select id, trigger, attempt, status, amount::text, intent_id, saved_payment_method_id
     from public.card_on_file_charge where invoice_id = ${invoiceId} order by attempt, created_at`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Part Charge Air", slug: "part-charge-air" });
  const [row] = await raw<{ id: string }[]>`
    insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', 'TEST_PART_KEY', ${raw.json({ publishableKey: "pk_test_part" } as never)})
    returning id`;
  connectionId = row!.id;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "billing@part.example" } as never)})`;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(() => {
  stripe = new FakeStripe();
});

run("the office charging part of a bill to a saved card", () => {
  let kai = "";
  let token = "";
  let cardId = "";

  beforeAll(async () => {
    if (!url) return;
    stripe = new FakeStripe();
    kai = await aCustomer("Kai Part", "kai@part.test");
    token = await signedIn(kai);
    cardId = (await saveACard(token)).id;
  });

  it("refuses a part with no agreement, and refuses a technician, exactly as a whole charge", async () => {
    const invoiceId = await anInvoice(kai, "300.00");
    await expect(cardOnFile.charge(owner(), { invoiceId, cardId, amount: "100.00" }, deps())).rejects.toThrow(/has not agreed/);
    await agreed(token, cardId);
    await expect(cardOnFile.charge(technician(), { invoiceId, cardId, amount: "100.00" }, deps())).rejects.toThrow(PermissionError);
    expect(stripe.charges).toHaveLength(0);
  });

  it("charges exactly the part, puts it on that invoice, and leaves the rest owed", async () => {
    const invoiceId = await anInvoice(kai, "300.00");
    const result = await cardOnFile.charge(owner({ idempotencyKey: "part-1" }), { invoiceId, cardId, amount: "120.00" }, deps());
    expect(result.status).toBe("submitted");
    expect(stripe.charges).toHaveLength(1);
    expect(stripe.charges[0]).toMatchObject({ amountMinor: 12000, offSession: true });
    const [row] = await charges(invoiceId);
    expect(row).toMatchObject({ trigger: "office", amount: "120.0000", status: "submitted" });

    /** Nothing has arrived yet: still owed in full until the webhook says so. */
    expect(await invoiceRow(invoiceId)).toMatchObject({ status: "open", balance: "300.0000" });
    await settle(row!.intent_id!, 12000);
    expect(await invoiceRow(invoiceId)).toMatchObject({ status: "partially_paid", balance: "180.0000", amount_paid: "120.0000" });
    const [allocation] = await raw<{ amount: string }[]>`select a.amount::text from public.payment_allocation a
      join public.payment p on p.id = a.payment_id where a.invoice_id = ${invoiceId}`;
    expect(allocation!.amount).toBe("120.0000");

    /** The rest, as a whole charge, settles the bill. */
    stripe = new FakeStripe();
    await cardOnFile.charge(owner({ idempotencyKey: "part-2" }), { invoiceId, cardId }, deps());
    expect(stripe.charges[0]!.amountMinor).toBe(18000);
    const rest = (await charges(invoiceId))[1]!;
    await settle(rest.intent_id!, 18000);
    expect(await invoiceRow(invoiceId)).toMatchObject({ status: "paid", balance: "0.0000" });
  });

  it("refuses nothing, more than is owed, and fractions of a cent, before asking the processor", async () => {
    const invoiceId = await anInvoice(kai, "90.00");
    await expect(cardOnFile.charge(owner(), { invoiceId, cardId, amount: "0" }, deps())).rejects.toThrow(/more than nothing/);
    await expect(cardOnFile.charge(owner(), { invoiceId, cardId, amount: "90.01" }, deps())).rejects.toThrow(/no more than that/);
    await expect(cardOnFile.charge(owner(), { invoiceId, cardId, amount: "10.005" }, deps())).rejects.toThrow(/dollars and cents/);
    await expect(cardOnFile.charge(owner(), { invoiceId, cardId, amount: "ten" }, deps())).rejects.toThrow(ConflictError);
    expect(stripe.charges).toHaveLength(0);
    expect(await charges(invoiceId)).toHaveLength(0);
  });

  it("never lets a part ride with a tip, nor a customer's own browser name its figure", async () => {
    const invoiceId = await anInvoice(kai, "60.00");
    const [agreement] = await raw<{ id: string }[]>`select id from public.payment_agreement
      where saved_payment_method_id = ${cardId} and withdrawn_at is null`;
    await expect(payments.intent(owner(), {
      customerId: kai, invoiceIds: [invoiceId], savedCardId: cardId, offSession: { agreementId: agreement!.id },
      partOfBalance: "20.0000", tip: "5.00",
    }, deps())).rejects.toThrow(ConflictError);
    /** Without nobody on the page there is no part: a portal payment pays the balance. */
    await expect(payments.intent(owner(), {
      customerId: kai, invoiceIds: [invoiceId], savedCardId: cardId, partOfBalance: "20.0000",
    }, deps())).rejects.toThrow(/saved card by the office/);
    /** And a part is never more than the balance in the database, whatever the caller says. */
    await expect(payments.intent(owner(), {
      customerId: kai, invoiceIds: [invoiceId], savedCardId: cardId, offSession: { agreementId: agreement!.id },
      partOfBalance: "60.0100",
    }, deps())).rejects.toThrow(/less than the/);
    expect(stripe.charges).toHaveLength(0);
  });
});

run("a customer with two cards agreed, choosing which one pays automatically", () => {
  let lee = "";
  let token = "";
  let first = "";
  let second = "";

  beforeAll(async () => {
    if (!url) return;
    stripe = new FakeStripe();
    lee = await aCustomer("Lee Two Cards", "lee@part.test");
    token = await signedIn(lee);
    first = (await saveACard(token)).id;
    second = (await saveACard(token)).id;
    await agreed(token, first);
    await agreed(token, second);
  });

  it("keeps both agreed, one paying automatically, and the office may charge either", async () => {
    await cardOnFile.setAutopay(db(), { token, cardId: first, on: true, wording: (await wordsFor(token, first)).autopay });
    await cardOnFile.setAutopay(db(), { token, cardId: second, on: true, wording: (await wordsFor(token, second)).autopay });
    const invoiceId = await anInvoice(lee, "45.00");
    const seen = await cardOnFile.forInvoice(owner(), { invoiceId });
    expect(seen.cards.map((c) => [c.cardId, c.autopay]).sort()).toEqual([[first, false], [second, true]].sort());
    await cardOnFile.charge(owner(), { invoiceId, cardId: first, amount: "15.00" }, deps());
    expect(stripe.charges[0]).toMatchObject({ amountMinor: 1500 });
  });

  it("tries a declined automatic payment again the next day on the card the customer chose since", async () => {
    await cardOnFile.setAutopay(db(), { token, cardId: first, on: true, wording: (await wordsFor(token, first)).autopay });
    stripe.answers = [{ code: "insufficient_funds", message: "Your card has insufficient funds." }, "succeeded"];
    const invoiceId = await anInvoice(lee, "70.00");
    const now = new Date();
    await cardOnFile.autopayFor(db(), ORG, { deps: deps(), now });
    expect((await charges(invoiceId))[0]).toMatchObject({ attempt: 1, status: "failed", saved_payment_method_id: first });

    /** Told their card was declined, the customer chooses the other card to pay automatically. */
    await cardOnFile.setAutopay(db(), { token, cardId: second, on: true, wording: (await wordsFor(token, second)).autopay });
    await cardOnFile.autopayFor(db(), ORG, { deps: deps(), now: new Date(now.getTime() + 25 * 3600e3) });
    const rows = await charges(invoiceId);
    expect(rows.map((r) => [r.attempt, r.status, r.saved_payment_method_id])).toEqual([
      [1, "failed", first], [2, "submitted", second],
    ]);
  });

  it("does not try again when no card pays automatically any more", async () => {
    stripe.answers = [{ code: "insufficient_funds", message: "Your card has insufficient funds." }];
    const invoiceId = await anInvoice(lee, "33.00");
    const now = new Date();
    await cardOnFile.autopayFor(db(), ORG, { deps: deps(), now });
    expect((await charges(invoiceId))[0]).toMatchObject({ attempt: 1, status: "failed" });
    await cardOnFile.setAutopay(db(), { token, cardId: second, on: false });
    await cardOnFile.autopayFor(db(), ORG, { deps: deps(), now: new Date(now.getTime() + 25 * 3600e3) });
    expect(await charges(invoiceId)).toHaveLength(1);
  });
});
