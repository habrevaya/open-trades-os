import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { customerPortal as cp, PermissionError, type Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as payments from "../src/services/payments";
import * as portal from "../src/services/portal";
import * as savedCards from "../src/services/saved-cards";
import * as cardOnFile from "../src/services/card-on-file";
import type {
  CardSetup, CardVault, ChargeOutcome, ChargeRequest, PaymentProvider, RefundOutcome,
} from "../src/payments/provider";
import {
  ConflictError, InvalidGrantError, NotFoundError, inTenant, type ServiceContext,
} from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A SAVED CARD THE COMPANY MAY CHARGE, AND PAYING BILLS AUTOMATICALLY
 *
 * The refusals first, because charging a card without the customer's
 * recorded agreement must be impossible: no agreement, a withdrawn one,
 * another company's customer, another customer's card, a technician who
 * takes payments but may not charge a saved card, and `payments.intent`
 * asked directly by a path that forgot to check. Then the agreement as it is
 * recorded, the office's charge, a bank that wants the customer to confirm
 * it, and the worker paying bills automatically: once per invoice, one next
 * day try, a link and a task when it fails.
 *
 * The processor is a fake that records what it was asked and answers as
 * told, so nothing is charged.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("card-on-file:org");
const USER = fixtureId("card-on-file:user");
const OTHER_ORG = fixtureId("card-on-file:other-org");
const OTHER_USER = fixtureId("card-on-file:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(), ...extra,
});
const stranger = (): ServiceContext => ({
  actor: { userId: OTHER_USER, organizationId: OTHER_ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
/** A technician: takes payments from the person in front of them, and may not charge a saved card. */
const technician = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["technician"] as Actor["roles"] }, db: db(),
});

type Answer = "succeeded" | "processing" | { code: string; message: string };

/** Stripe, as far as these services can tell. */
class FakeStripe implements PaymentProvider {
  readonly name = "stripe";
  readonly publishableKey = "pk_test_on_file";
  charges: ChargeRequest[] = [];
  setups = new Map<string, CardSetup>();
  /** How the next charges are answered, in order; the last repeats. */
  answers: Answer[] = ["succeeded"];

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.charges.push(request);
    const answer = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!;
    if (typeof answer === "object") return { ok: false, code: answer.code, message: answer.message, retryable: false };
    return {
      ok: true,
      intent: {
        intentId: `pi_onfile_${this.charges.length}_${Math.random().toString(36).slice(2)}`,
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
      this.setups.set(setupId, {
        setupId, status: "succeeded", customerRef: request.customerRef,
        card: { ref: `pm_${setupId}`, brand: "visa", last4: "4242", expMonth: 4, expYear: 2031 },
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

async function aCustomer(org: string, ctx: ServiceContext, name: string, email: string | null = null) {
  const c = await customers.create(ctx, {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    ...(email ? { email } : {}),
  });
  void org;
  return c.id as string;
}

/** A sign in, minted the way a right code mints one, as the customer or as one of their contacts. */
async function signedIn(customerId: string, contactId: string | null = null): Promise<string> {
  const [signIn] = await raw<{ id: string }[]>`insert into public.portal_sign_in
    (organization_id, channel, address, expires_at, ended_at, ended_reason, customer_id)
    values (${ORG}, 'email', 'someone@onfile.test', now(), now(), 'signed_in', ${customerId}) returning id`;
  const minted = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId, scope: "customer", expiresInDays: 7, signInId: signIn!.id, contactId,
  }));
  return minted.token;
}

async function anInvoice(customerId: string, total: string, extra: { payer?: string; ctx?: ServiceContext } = {}) {
  const invoice = await billing.create(extra.ctx ?? owner(), {
    customerId,
    lines: [{ name: "Tune up", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  if (extra.payer) await raw`update public.invoice set payer_customer_id = ${extra.payer} where id = ${invoice.id as string}`;
  return invoice.id as string;
}

async function saveACard(token: string) {
  const started = await savedCards.startSave(db(), { token }, undefined, deps());
  return savedCards.confirmSave(db(), { token, setupId: started.setupId }, deps());
}

/** The words the page shows for a card, as the customer reads them. */
async function wordsFor(token: string, cardId: string) {
  const listed = await savedCards.list(db(), { token });
  return listed.cards.find((c) => c.id === cardId)!.wording;
}

async function agreed(token: string, cardId: string) {
  return cardOnFile.agree(db(), { token, cardId, wording: (await wordsFor(token, cardId)).agreement },
    { ip: "203.0.113.9", userAgent: "Test browser" });
}

const charges = (invoiceId: string) => raw<{
  id: string; trigger: string; attempt: number; status: string; failure_code: string | null;
  retry_at: Date | null; customer_told: string | null; task_id: string | null; requested_by_user_id: string | null;
}[]>`select id, trigger, attempt, status, failure_code, retry_at, customer_told, task_id, requested_by_user_id
     from public.card_on_file_charge where invoice_id = ${invoiceId} order by attempt, created_at`;

const settle = async (intentId: string, amountMinor: number) => {
  const connection = (await payments.connectionById(db(), connectionId))!;
  await payments.receive(db(), {
    connection,
    event: {
      eventId: `evt_onfile_${Math.random().toString(36).slice(2)}`, kind: "succeeded", type: "payment_intent.succeeded",
      intentId, amountMinor, currency: "usd", feeMinor: 30, refundedMinor: null, metadata: {}, failureMessage: null,
    },
  });
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "On File Air", slug: "on-file-air" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Air", slug: "on-file-other" });
  const [row] = await raw<{ id: string }[]>`
    insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', 'TEST_ON_FILE_KEY',
            ${raw.json({ publishableKey: "pk_test_on_file" } as never)})
    returning id`;
  connectionId = row!.id;
  await raw`insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${OTHER_ORG}, 'payments', 'stripe', 'connected', 'TEST_ON_FILE_OTHER', ${raw.json({} as never)})`;
  /** Mail goes into the outbox, which is as far as a link to pay needs to get here. */
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "billing@example-trades.com" } as never)})`;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await resetOrg(raw, OTHER_ORG);
  await raw.end();
});

beforeEach(() => {
  stripe = new FakeStripe();
});

/* ============================================================ refusals === */

run("charging a saved card without the customer's agreement is impossible", () => {
  let dana = "";
  let danaToken = "";
  let cardId = "";

  beforeAll(async () => {
    if (!url) return;
    stripe = new FakeStripe();
    dana = await aCustomer(ORG, owner(), "Dana Refused", "dana@onfile.test");
    danaToken = await signedIn(dana);
    cardId = (await saveACard(danaToken)).id;
  });

  it("refuses a card the customer saved and never agreed may be charged", async () => {
    const invoiceId = await anInvoice(dana, "120.00");
    await expect(cardOnFile.charge(owner(), { invoiceId, cardId }, deps())).rejects.toThrow(ConflictError);
    expect(stripe.charges).toHaveLength(0);
    expect(await charges(invoiceId)).toHaveLength(0);
  });

  it("refuses the processor path itself, asked directly without an agreement or with another card's", async () => {
    const invoiceId = await anInvoice(dana, "80.00");
    await expect(payments.intent(owner(), {
      customerId: dana, invoiceIds: [invoiceId], savedCardId: cardId, offSession: { agreementId: fixtureId("no-such-agreement") },
    }, deps())).rejects.toThrow(/has not agreed/);
    // An agreement on a different card of the same customer does not cover this one.
    const second = await saveACard(danaToken);
    const theirs = await agreed(danaToken, second.id);
    await expect(payments.intent(owner(), {
      customerId: dana, invoiceIds: [invoiceId], savedCardId: cardId, offSession: { agreementId: theirs.id },
    }, deps())).rejects.toThrow(/has not agreed/);
    expect(stripe.charges).toHaveLength(0);
    await cardOnFile.withdraw(db(), { token: danaToken, cardId: second.id });
  });

  it("refuses an agreement the customer withdrew, and a card they took off", async () => {
    const invoiceId = await anInvoice(dana, "95.00");
    await agreed(danaToken, cardId);
    await cardOnFile.withdraw(db(), { token: danaToken, cardId });
    await expect(cardOnFile.charge(owner(), { invoiceId, cardId }, deps())).rejects.toThrow(/withdrawn/);

    const spare = await saveACard(danaToken);
    const live = await agreed(danaToken, spare.id);
    await savedCards.remove(db(), { token: danaToken, cardId: spare.id }, undefined, deps());
    await expect(cardOnFile.charge(owner(), { invoiceId, cardId: spare.id }, deps())).rejects.toThrow(NotFoundError);
    await expect(payments.intent(owner(), {
      customerId: dana, invoiceIds: [invoiceId], savedCardId: spare.id, offSession: { agreementId: live.id },
    }, deps())).rejects.toThrow(NotFoundError);
    const [row] = await raw<{ withdrawn_reason: string }[]>`select withdrawn_reason from public.payment_agreement where id = ${live.id}`;
    expect(row!.withdrawn_reason).toBe("card_removed");
    expect(stripe.charges).toHaveLength(0);
  });

  it("refuses another company's customer, as an invoice that does not exist", async () => {
    await agreed(danaToken, cardId);
    const invoiceId = await anInvoice(dana, "60.00");
    await expect(cardOnFile.charge(stranger(), { invoiceId, cardId }, deps())).rejects.toThrow(NotFoundError);
    await expect(cardOnFile.forInvoice(stranger(), { invoiceId })).rejects.toThrow(NotFoundError);
    expect(stripe.charges).toHaveLength(0);
  });

  it("refuses another customer's card, and the homeowner's card on an invoice somebody else pays", async () => {
    const eli = await aCustomer(ORG, owner(), "Eli Payer", "eli@onfile.test");
    const own = await anInvoice(eli, "70.00");
    await expect(cardOnFile.charge(owner(), { invoiceId: own, cardId }, deps())).rejects.toThrow(NotFoundError);
    const theirs = await anInvoice(dana, "70.00", { payer: eli });
    await expect(cardOnFile.charge(owner(), { invoiceId: theirs, cardId }, deps())).rejects.toThrow(NotFoundError);
    expect(stripe.charges).toHaveLength(0);
  });

  it("refuses a technician, who takes payments but may not charge a saved card", async () => {
    const invoiceId = await anInvoice(dana, "45.00");
    await expect(cardOnFile.charge(technician(), { invoiceId, cardId }, deps())).rejects.toThrow(PermissionError);
    await expect(payments.intent(technician(), {
      customerId: dana, invoiceIds: [invoiceId], savedCardId: cardId,
      offSession: { agreementId: (await cardOnFile.forCustomer(owner(), { customerId: dana })).cards[0]!.agreementId },
    }, deps())).rejects.toThrow(PermissionError);
    expect(stripe.charges).toHaveLength(0);
  });

  it("lets only the customer's own sign in agree, to the words they were shown", async () => {
    const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
      organizationId: ORG, customerId: dana, scope: "customer", expiresInDays: 30,
    }));
    const words = (await wordsFor(danaToken, cardId)).agreement;
    await expect(cardOnFile.agree(db(), { token: link.token, cardId, wording: words })).rejects.toThrow(InvalidGrantError);
    const other = await saveACard(danaToken);
    await expect(cardOnFile.agree(db(), {
      token: danaToken, cardId: other.id, wording: words.replace("4242", "1111"),
    })).rejects.toThrow(/words on this page have changed/);
    const [none] = await raw<{ n: number }[]>`select count(*)::int as n from public.payment_agreement
      where saved_payment_method_id = ${other.id}`;
    expect(none!.n).toBe(0);
  });
});

/* =========================================================== agreeing === */

run("the customer's agreement", () => {
  it("keeps the words shown, when, how, from which sign in, as which contact and from where", async () => {
    const frank = await aCustomer(ORG, owner(), "Frank Agree", "frank@onfile.test");
    const [contact] = await raw<{ id: string }[]>`insert into public.contact
      (organization_id, customer_id, name, email, portal_access_at) values (${ORG}, ${frank}, 'Fay Agree', 'fay@onfile.test', now()) returning id`;
    const token = await signedIn(frank, contact!.id);
    const card = await saveACard(token);
    const words = await wordsFor(token, card.id);
    expect(words.agreement).toBe(cp.agreementWording({ company: "On File Air", method: "Visa ending 4242", kind: "card" }));

    const agreement = await agreed(token, card.id);
    expect(agreement).toMatchObject({ cardId: card.id, autopay: false, agreedByContact: "Fay Agree" });
    const [row] = await raw<Record<string, unknown>[]>`select * from public.payment_agreement where id = ${agreement.id}`;
    expect(row).toMatchObject({
      wording: words.agreement, agreed_via: "portal_sign_in", contact_id: contact!.id,
      ip: "203.0.113.9", user_agent: "Test browser", withdrawn_at: null,
    });
    const [grant] = await raw<{ sign_in_id: string }[]>`select sign_in_id from public.portal_grant where id = ${row!["grant_id"] as string}`;
    expect(grant!.sign_in_id).toBeTruthy();
    const [audit] = await raw<{ actor_contact_id: string }[]>`select actor_contact_id from public.audit_log
      where organization_id = ${ORG} and action = 'portal.card.agreement_given' and entity_id = ${frank}`;
    expect(audit!.actor_contact_id).toBe(contact!.id);

    // Agreeing again is the same agreement.
    expect((await agreed(token, card.id)).id).toBe(agreement.id);
    const listed = await savedCards.list(db(), { token });
    expect(listed.cards[0]!.agreement!.id).toBe(agreement.id);
  });

  it("turns paying automatically on only over an agreement and its own words, on one card at a time", async () => {
    const gus = await aCustomer(ORG, owner(), "Gus Auto", "gus@onfile.test");
    const token = await signedIn(gus);
    const first = await saveACard(token);
    const second = await saveACard(token);
    const words = await wordsFor(token, first.id);
    await expect(cardOnFile.setAutopay(db(), { token, cardId: first.id, on: true, wording: words.autopay }))
      .rejects.toThrow(/Agree to let the company charge this card first/);
    await agreed(token, first.id);
    await agreed(token, second.id);
    await expect(cardOnFile.setAutopay(db(), { token, cardId: first.id, on: true, wording: words.agreement }))
      .rejects.toThrow(/words on this page have changed/);
    const on = await cardOnFile.setAutopay(db(), { token, cardId: first.id, on: true, wording: words.autopay });
    expect(on).toMatchObject({ autopay: true, autopayWording: words.autopay });
    await cardOnFile.setAutopay(db(), { token, cardId: second.id, on: true, wording: (await wordsFor(token, second.id)).autopay });
    const auto = await raw<{ saved_payment_method_id: string }[]>`select saved_payment_method_id from public.payment_agreement
      where customer_id = ${gus} and withdrawn_at is null and autopay_at is not null`;
    expect(auto.map((a) => a.saved_payment_method_id)).toEqual([second.id]);
    const off = await cardOnFile.setAutopay(db(), { token, cardId: second.id, on: false });
    expect(off.autopay).toBe(false);
  });
});

/* ===================================================== the office charges === */

run("the office charging a card the customer agreed may be charged", () => {
  let hana = "";
  let token = "";
  let cardId = "";

  beforeAll(async () => {
    if (!url) return;
    stripe = new FakeStripe();
    hana = await aCustomer(ORG, owner(), "Hana Charged", "hana@onfile.test");
    token = await signedIn(hana);
    cardId = (await saveACard(token)).id;
    await agreed(token, cardId);
  });

  it("charges it off session, names who did, and the invoice is paid only when the webhook says so", async () => {
    const invoiceId = await anInvoice(hana, "210.00");
    const result = await cardOnFile.charge(owner({ idempotencyKey: "press-1" }), { invoiceId, cardId }, deps());
    expect(result.status).toBe("submitted");
    const [request] = stripe.charges;
    expect(request).toMatchObject({ amountMinor: 21000, offSession: true });
    expect(request!.paymentMethodRef).toMatch(/^pm_/);
    expect(request!.acceptance).toBeUndefined();
    const [row] = await charges(invoiceId);
    expect(row).toMatchObject({ trigger: "office", status: "submitted", requested_by_user_id: USER });
    // The charge's own id is the processor's key, so asking again cannot be a second charge.
    expect(request!.idempotencyKey).toBe(row!.id);

    const [audit] = await raw<{ actor_user_id: string }[]>`select actor_user_id from public.audit_log
      where organization_id = ${ORG} and action = 'payment.charged_on_file' and entity_id = ${invoiceId}`;
    expect(audit!.actor_user_id).toBe(USER);

    // A double press with the same key is the same charge; a new press while it is with the processor is refused.
    await cardOnFile.charge(owner({ idempotencyKey: "press-1" }), { invoiceId, cardId }, deps());
    await expect(cardOnFile.charge(owner({ idempotencyKey: "press-2" }), { invoiceId, cardId }, deps()))
      .rejects.toThrow(/already with the card processor/);
    expect(stripe.charges).toHaveLength(1);

    const before = await raw<{ status: string }[]>`select status from public.invoice where id = ${invoiceId}`;
    expect(before[0]!.status).toBe("open");
    const intentId = (await raw<{ intent_id: string }[]>`select intent_id from public.card_on_file_charge where id = ${row!.id}`)[0]!.intent_id;
    await settle(intentId, 21000);
    const after = await raw<{ status: string }[]>`select status from public.invoice where id = ${invoiceId}`;
    expect(after[0]!.status).toBe("paid");
    const seen = await cardOnFile.forInvoice(owner(), { invoiceId });
    expect(seen.charges[0]).toMatchObject({ status: "paid", requestedBy: expect.any(String) });
  });

  it("sends the customer the link to pay when their bank wants them to confirm it, and says so", async () => {
    stripe.answers = [{ code: "authentication_required", message: "This payment requires authentication." }];
    const invoiceId = await anInvoice(hana, "88.00");
    const result = await cardOnFile.charge(owner(), { invoiceId, cardId }, deps());
    expect(result.status).toBe("needs_customer");
    expect(result.message).toMatch(/confirm this payment themselves\. We emailed them the link to pay/);
    const [row] = await charges(invoiceId);
    expect(row).toMatchObject({ status: "needs_customer", failure_code: "authentication_required", customer_told: "email", retry_at: null });
    const [delivery] = await raw<{ destination: string }[]>`select destination from public.invoice_delivery where invoice_id = ${invoiceId}`;
    expect(delivery!.destination).toBe("hana@onfile.test");
  });

  it("tells the person who pressed Charge about a decline, and does not try again by itself", async () => {
    stripe.answers = [{ code: "insufficient_funds", message: "Your card has insufficient funds." }];
    const invoiceId = await anInvoice(hana, "64.00");
    const result = await cardOnFile.charge(owner(), { invoiceId, cardId }, deps());
    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("insufficient funds") });
    const [row] = await charges(invoiceId);
    expect(row).toMatchObject({ status: "failed", retry_at: null, customer_told: null, task_id: null });
  });
});

/* ================================================== paying automatically === */

run("paying each bill automatically", () => {
  let ivy = "";
  let token = "";
  let cardId = "";

  beforeAll(async () => {
    if (!url) return;
    stripe = new FakeStripe();
    ivy = await aCustomer(ORG, owner(), "Ivy Automatic", "ivy@onfile.test");
    token = await signedIn(ivy);
    cardId = (await saveACard(token)).id;
  });

  it("charges each bill issued after it was turned on, once, and nothing issued before", async () => {
    const before = await anInvoice(ivy, "50.00");
    await agreed(token, cardId);
    await cardOnFile.setAutopay(db(), { token, cardId, on: true, wording: (await wordsFor(token, cardId)).autopay });
    const issued = await anInvoice(ivy, "130.00");
    /**
     * An instalment of a plan is invoiced straight to open by M08, without
     * the issue event a draft gets: written the same way here.
     */
    const [instalment] = await raw<{ id: string }[]>`
      insert into public.invoice (organization_id, number, customer_id, status, issued_on, due_on, total, balance, memo)
      select ${ORG}, coalesce(max(number), 0) + 1, ${ivy}, 'open', current_date, current_date, 40.0000, 40.0000, 'Gold plan, instalment 2'
        from public.invoice where organization_id = ${ORG}
      returning id`;

    const first = await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    expect(first.charged).toBe(2);
    const again = await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    expect(again.charged).toBe(0);
    expect(stripe.charges.map((c) => c.amountMinor).sort()).toEqual([13000, 4000].sort());
    expect(stripe.charges.every((c) => c.offSession === true)).toBe(true);
    expect(await charges(before)).toHaveLength(0);
    expect((await charges(issued))[0]).toMatchObject({ trigger: "autopay", attempt: 1, status: "submitted", requested_by_user_id: null });
    expect(await charges(instalment!.id)).toHaveLength(1);
  });

  it("sends the link and raises a task when it fails, tries once more the next day, and never a third time", async () => {
    stripe.answers = [{ code: "insufficient_funds", message: "Your card has insufficient funds." }];
    const invoiceId = await anInvoice(ivy, "75.00");
    const now = new Date();
    await cardOnFile.autopayFor(db(), ORG, { deps: deps(), now });
    const [first] = await charges(invoiceId);
    expect(first).toMatchObject({ status: "failed", failure_code: "insufficient_funds", customer_told: "email" });
    expect(first!.retry_at!.getTime()).toBeGreaterThan(now.getTime() + 23 * 3600e3);
    const [task] = await raw<{ title: string; body: string; queue: string }[]>`select title, body, queue from public.task where id = ${first!.task_id!}`;
    expect(task!.title).toMatch(/Ivy Automatic's automatic payment of \$75\.00 for invoice #\d+ did not go through/);
    expect(task!.body).toMatch(/tried once more tomorrow/);

    // Not before the day is out.
    await cardOnFile.autopayFor(db(), ORG, { deps: deps(), now: new Date(now.getTime() + 3600e3) });
    expect(await charges(invoiceId)).toHaveLength(1);

    const tomorrow = new Date(now.getTime() + 25 * 3600e3);
    await cardOnFile.autopayFor(db(), ORG, { deps: deps(), now: tomorrow });
    const rows = await charges(invoiceId);
    expect(rows.map((r) => [r.attempt, r.status])).toEqual([[1, "failed"], [2, "failed"]]);
    expect(rows[1]!.retry_at).toBeNull();
    const [last] = await raw<{ body: string }[]>`select body from public.task where id = ${rows[1]!.task_id!}`;
    expect(last!.body).toMatch(/will not be tried again/);

    await cardOnFile.autopayFor(db(), ORG, { deps: deps(), now: new Date(now.getTime() + 72 * 3600e3) });
    expect(await charges(invoiceId)).toHaveLength(2);
    expect(stripe.charges.filter((c) => c.amountMinor === 7500)).toHaveLength(2);
  });

  it("does not try again what only the customer can finish", async () => {
    stripe.answers = [{ code: "authentication_required", message: "This payment requires authentication." }];
    const invoiceId = await anInvoice(ivy, "33.00");
    await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    const [row] = await charges(invoiceId);
    expect(row).toMatchObject({ status: "needs_customer", retry_at: null, customer_told: "email" });
    expect(row!.task_id).not.toBeNull();
  });

  it("charges nothing once the customer withdraws, nor a bill with a bank payment on its way", async () => {
    stripe.answers = ["succeeded"];
    const pending = await anInvoice(ivy, "22.00");
    await raw`insert into public.integration_event (organization_id, direction, provider, event_type, idempotency_key, status,
      entity_type, entity_id, request_payload)
      values (${ORG}, 'outbound', 'stripe', 'payment.intent', ${`bank-${pending}`}, 'in_flight', 'customer', ${ivy},
        ${raw.json({ amount: "22.0000", method: "ach", allocations: [{ invoiceId: pending, amount: "22.0000" }] } as never)})`;
    await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    expect((await charges(pending))[0]).toMatchObject({ status: "cancelled" });

    await cardOnFile.withdraw(db(), { token, cardId });
    const later = await anInvoice(ivy, "19.00");
    const pass = await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    expect(pass.charged).toBe(0);
    expect(await charges(later)).toHaveLength(0);
    expect(stripe.charges).toHaveLength(0);
  });
});

/* ============================================= following a charge up === */

run("a charge followed up after the processor took it", () => {
  let jo = "";
  let token = "";
  let cardId = "";

  beforeAll(async () => {
    if (!url) return;
    stripe = new FakeStripe();
    jo = await aCustomer(ORG, owner(), "Jo Later", "jo@onfile.test");
    token = await signedIn(jo);
    cardId = (await saveACard(token)).id;
    await agreed(token, cardId);
    await cardOnFile.setAutopay(db(), { token, cardId, on: true, wording: (await wordsFor(token, cardId)).autopay });
  });

  it("is failed, with the link sent and a task raised, when the processor later says it did not go through", async () => {
    stripe.answers = ["processing"];
    const invoiceId = await anInvoice(jo, "140.00");
    await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    const [row] = await charges(invoiceId);
    expect(row!.status).toBe("submitted");
    const intentId = (await raw<{ intent_id: string }[]>`select intent_id from public.card_on_file_charge where id = ${row!.id}`)[0]!.intent_id;

    const connection = (await payments.connectionById(db(), connectionId))!;
    await payments.receive(db(), {
      connection,
      event: {
        eventId: `evt_onfile_fail_${Math.random().toString(36).slice(2)}`, kind: "failed", type: "payment_intent.payment_failed",
        intentId, amountMinor: 14000, currency: "usd", feeMinor: null, refundedMinor: null, metadata: {},
        failureMessage: "The card was declined.",
      },
    });
    await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    const [after] = await charges(invoiceId);
    expect(after).toMatchObject({ status: "failed", customer_told: "email" });
    expect(after!.task_id).not.toBeNull();
    const seen = await cardOnFile.forInvoice(owner(), { invoiceId });
    expect(seen.charges[0]).toMatchObject({ status: "failed", failureReason: expect.stringContaining("declined") });
  });

  it("asks again with the same key when a worker died in the middle, and adopts what it had already asked", async () => {
    stripe.answers = ["succeeded"];
    const invoiceId = await anInvoice(jo, "55.00");
    const [agreement] = await raw<{ id: string }[]>`select id from public.payment_agreement
      where saved_payment_method_id = ${cardId} and withdrawn_at is null`;
    const [abandoned] = await raw<{ id: string }[]>`insert into public.card_on_file_charge
      (organization_id, invoice_id, customer_id, agreement_id, saved_payment_method_id, trigger, attempt, status, amount, updated_at)
      values (${ORG}, ${invoiceId}, ${jo}, ${agreement!.id}, ${cardId}, 'autopay', 1, 'charging', 55.0000, now() - interval '20 minutes')
      returning id`;
    await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    expect(stripe.charges.map((c) => c.idempotencyKey)).toEqual([abandoned!.id]);
    expect((await charges(invoiceId))[0]!.status).toBe("submitted");

    // Left as charging again, with its attempt already on file: adopted, not asked for a second time.
    await raw`update public.card_on_file_charge set status = 'charging', updated_at = now() - interval '20 minutes' where id = ${abandoned!.id}`;
    await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    expect(stripe.charges).toHaveLength(1);
    expect((await charges(invoiceId))[0]!.status).toBe("submitted");
  });
});

/* ======================================================= the adapter === */

run("Stripe's off session charge, as the adapter sends it", () => {
  it("confirms the saved card off session, with no customer acceptance, and keeps a decline's reason", async () => {
    const { createServer } = await import("node:http");
    const { stripeProvider } = await import("../src/payments/stripe");
    const bodies: string[] = [];
    let answer: { status: number; body: unknown } = { status: 200, body: {} };
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => {
        bodies.push(body);
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const provider = stripeProvider({ baseUrl: `http://127.0.0.1:${port}/v1` }, "sk_test_x");
      const request: ChargeRequest = {
        amountMinor: 5000, currency: "usd", idempotencyKey: "k1", customerRef: "cus_1", paymentMethodRef: "pm_1",
        methodKind: "bank_account", offSession: true, acceptance: { ip: "1.2.3.4", userAgent: "x" },
      };
      answer = { status: 200, body: { id: "pi_1", client_secret: "pi_1_secret", amount: 5000, currency: "usd", status: "processing" } };
      const ok = await provider.charge(request);
      expect(ok).toMatchObject({ ok: true, intent: { status: "processing" } });
      const sent = new URLSearchParams(bodies[0]!);
      expect(sent.get("off_session")).toBe("true");
      expect(sent.get("confirm")).toBe("true");
      expect([...sent.keys()].some((k) => k.startsWith("mandate_data"))).toBe(false);

      answer = { status: 402, body: { error: { type: "card_error", code: "authentication_required", message: "This payment requires authentication." } } };
      expect(await provider.charge({ ...request, methodKind: "card" })).toMatchObject({ ok: false, code: "authentication_required" });
      answer = { status: 402, body: { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." } } };
      expect(await provider.charge({ ...request, methodKind: "card" })).toMatchObject({ ok: false, code: "insufficient_funds" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
