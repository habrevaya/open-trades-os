import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as payments from "../src/services/payments";
import * as portal from "../src/services/portal";
import * as savedCards from "../src/services/saved-cards";
import * as cardOnFile from "../src/services/card-on-file";
import type {
  CardSetup, CardVault, ChargeOutcome, ChargeRequest, PaymentProvider, RefundOutcome,
} from "../src/payments/provider";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A BACKUP CARD WHEN THE AUTOMATIC PAYMENT FAILS
 *
 * Remy pays automatically with a Visa and keeps a Mastercard, and then a
 * bank account, as backups, each agreed in its own words. When the Visa is
 * declined the Mastercard is tried once, in the same run; when it pays, the
 * customer is told which card paid once the processor says the money moved.
 * When every card fails, the customer gets the link and the office one task
 * naming every card, and tomorrow's one more try is on the Visa alone.
 *
 * Only cards the customer agreed may be charged can be backups, never one
 * saved to pay once; and nothing but the processor's references is stored.
 * The processor is a fake that answers by the card it is asked to charge.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("card-backup:org");
const USER = fixtureId("card-backup:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

type Answer = "succeeded" | { code: string; message: string };

/** Stripe as these services see it, answering each card by its reference. */
class FakeStripe implements PaymentProvider {
  readonly name = "stripe";
  readonly publishableKey = "pk_test_backup";
  charges: ChargeRequest[] = [];
  setups = new Map<string, CardSetup>();
  /** How each card is answered, by its last four digits; anything else succeeds. */
  answers = new Map<string, Answer>();
  private next = 0;
  private readonly made = [
    { brand: "visa", last4: "4242" }, { brand: "mastercard", last4: "5555" }, { brand: "amex", last4: "0005" },
  ];

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.charges.push(request);
    const last4 = /_(\d{4})$/.exec(request.paymentMethodRef ?? "")?.[1] ?? "";
    const answer = this.answers.get(last4) ?? "succeeded";
    if (typeof answer === "object") return { ok: false, code: answer.code, message: answer.message, retryable: false };
    return {
      ok: true,
      intent: {
        intentId: `pi_backup_${this.charges.length}_${Math.random().toString(36).slice(2)}`,
        clientSecret: "pi_secret", amountMinor: request.amountMinor, currency: "usd", status: "succeeded",
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
      const made = this.made[this.next % this.made.length]!;
      this.next += 1;
      const setupId = `seti_${this.next}_${Math.random().toString(36).slice(2, 8)}`;
      this.setups.set(setupId, {
        setupId, status: "succeeded", customerRef: request.customerRef,
        card: { ref: `pm_${setupId}_${made.last4}`, brand: made.brand, last4: made.last4, expMonth: 4, expYear: 2031 },
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

async function signedIn(customerId: string): Promise<string> {
  const [signIn] = await raw<{ id: string }[]>`insert into public.portal_sign_in
    (organization_id, channel, address, expires_at, ended_at, ended_reason, customer_id)
    values (${ORG}, 'email', 'remy@backup.test', now(), now(), 'signed_in', ${customerId}) returning id`;
  const minted = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId, scope: "customer", expiresInDays: 7, signInId: signIn!.id, contactId: null,
  }));
  return minted.token;
}

async function saveACard(token: string) {
  const started = await savedCards.startSave(db(), { token }, undefined, deps());
  return savedCards.confirmSave(db(), { token, setupId: started.setupId }, deps());
}

async function wordsFor(token: string, cardId: string) {
  const listed = await savedCards.list(db(), { token });
  return listed.cards.find((c) => c.id === cardId)!.wording;
}

async function anInvoice(customerId: string, total: string) {
  const invoice = await billing.create(owner(), {
    customerId, lines: [{ name: "Tune up", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  return invoice.id as string;
}

const charges = (invoiceId: string) => raw<{
  id: string; attempt: number; card_rank: number; status: string; failure_code: string | null;
  retry_at: Date | null; customer_told: string | null; task_id: string | null; intent_id: string | null;
  saved_payment_method_id: string;
}[]>`select id, attempt, card_rank, status, failure_code, retry_at, customer_told, task_id, intent_id, saved_payment_method_id
     from public.card_on_file_charge where invoice_id = ${invoiceId} order by attempt, card_rank`;

const settle = async (intentId: string, amountMinor: number) => {
  const connection = (await payments.connectionById(db(), connectionId))!;
  await payments.receive(db(), {
    connection,
    event: {
      eventId: `evt_backup_${Math.random().toString(36).slice(2)}`, kind: "succeeded", type: "payment_intent.succeeded",
      intentId, amountMinor, currency: "usd", feeMinor: 30, refundedMinor: null, metadata: {}, failureMessage: null,
    },
  });
};

let remy = "", token = "";
let visa = "", master = "", amex = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  stripe = new FakeStripe();
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Backup Air", slug: "backup-air" });
  const [row] = await raw<{ id: string }[]>`
    insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', 'TEST_BACKUP_KEY', ${raw.json({ publishableKey: "pk_test_backup" } as never)})
    returning id`;
  connectionId = row!.id;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "billing@backup-air.test" } as never)})`;
  remy = (await customers.create(owner(), {
    type: "residential", name: "Remy Backup", email: "remy@backup.test", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  token = await signedIn(remy);
  visa = (await saveACard(token)).id;
  master = (await saveACard(token)).id;
  amex = (await saveACard(token)).id;
});

/** Agreed, the Visa paying automatically, and the cards named kept as backups in that order. */
async function setUp(backups: string[]) {
  for (const id of [visa, master, amex]) {
    await cardOnFile.agree(db(), { token, cardId: id, wording: (await wordsFor(token, id)).agreement });
  }
  await cardOnFile.setAutopay(db(), { token, cardId: visa, on: true, wording: (await wordsFor(token, visa)).autopay });
  for (const id of backups) {
    await cardOnFile.setBackup(db(), { token, cardId: id, on: true, wording: (await wordsFor(token, id)).backup });
  }
}

run("choosing a backup", () => {
  it("is only a card the customer agreed may be charged, in its own words, behind a card paying automatically", async () => {
    const backupWords = (await wordsFor(token, master)).backup;
    expect(backupWords).toMatch(/^Use my Mastercard ending 5555 as a backup/);

    /** A card saved and never agreed may be charged, as one saved to pay once, is never a backup. */
    await expect(cardOnFile.setBackup(db(), { token, cardId: master, on: true, wording: backupWords }))
      .rejects.toThrow(/Agree to let the company charge this card first/);
    await cardOnFile.agree(db(), { token, cardId: master, wording: (await wordsFor(token, master)).agreement });
    await expect(cardOnFile.setBackup(db(), { token, cardId: master, on: true, wording: backupWords }))
      .rejects.toThrow(/Choose a card to pay your bills automatically first/);

    await cardOnFile.agree(db(), { token, cardId: visa, wording: (await wordsFor(token, visa)).agreement });
    await cardOnFile.setAutopay(db(), { token, cardId: visa, on: true, wording: (await wordsFor(token, visa)).autopay });
    await expect(cardOnFile.setBackup(db(), { token, cardId: master, on: true, wording: (await wordsFor(token, master)).autopay }))
      .rejects.toThrow(/words on this page have changed/);
    await expect(cardOnFile.setBackup(db(), { token, cardId: visa, on: true, wording: (await wordsFor(token, visa)).backup }))
      .rejects.toThrow(/already pays your bills automatically/);

    const kept = await cardOnFile.setBackup(db(), { token, cardId: master, on: true, wording: backupWords });
    expect(kept).toMatchObject({ autopay: false, autopayRank: 2, autopayWording: backupWords });
    /** Pressed twice, it is the same backup. */
    expect(await cardOnFile.setBackup(db(), { token, cardId: master, on: true, wording: backupWords })).toMatchObject({ autopayRank: 2 });

    const office = await cardOnFile.forCustomer(owner(), { customerId: remy });
    expect(Object.fromEntries(office.cards.map((c) => [c.label, c.autopayRank]))).toEqual({
      "Visa ending 4242": 1, "Mastercard ending 5555": 2,
    });

    /** Nothing but the processor's reference and what names the card is kept. */
    const [stored] = await raw<Record<string, unknown>[]>`select * from public.saved_payment_method where id = ${master}`;
    expect(Object.keys(stored!).filter((k) => /number|cvc|cvv|pan/.test(k))).toEqual([]);
    expect(stored!.external_ref).toMatch(/^pm_/);
  });

  it("keeps two backups at most, and stops them all when paying automatically stops", async () => {
    await setUp([master, amex]);
    const listed = await savedCards.list(db(), { token });
    expect(listed.cards.map((c) => [c.id, c.agreement?.autopayRank])).toEqual(expect.arrayContaining([
      [visa, 1], [master, 2], [amex, 3],
    ]));

    /** One taken out leaves the other where it was. */
    await cardOnFile.setBackup(db(), { token, cardId: master, on: false });
    const after = await savedCards.list(db(), { token });
    expect(after.cards.find((c) => c.id === master)!.agreement!.autopayRank).toBeNull();
    expect(after.cards.find((c) => c.id === amex)!.agreement!.autopayRank).toBe(3);

    await cardOnFile.setAutopay(db(), { token, cardId: visa, on: false });
    const off = await savedCards.list(db(), { token });
    expect(off.cards.map((c) => c.agreement?.autopayRank ?? null)).toEqual([null, null, null]);
  });

  it("refuses a third backup", async () => {
    const fourth = (await saveACard(token)).id;
    await setUp([master, amex]);
    await cardOnFile.agree(db(), { token, cardId: fourth, wording: (await wordsFor(token, fourth)).agreement });
    await expect(cardOnFile.setBackup(db(), { token, cardId: fourth, on: true, wording: (await wordsFor(token, fourth)).backup }))
      .rejects.toThrow(/You can keep 2 backups/);
  });
});

run("a backup when the automatic payment fails", () => {
  it("tries the backup once in the same run, records every try, and tells the customer which card paid", async () => {
    await setUp([master, amex]);
    stripe.answers.set("4242", { code: "insufficient_funds", message: "Your card has insufficient funds." });
    const invoiceId = await anInvoice(remy, "120.00");

    const pass = await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    expect(pass).toMatchObject({ charged: 1, failed: 0 });
    const rows = await charges(invoiceId);
    expect(rows.map((r) => [r.attempt, r.card_rank, r.status, r.saved_payment_method_id])).toEqual([
      [1, 1, "failed", visa], [1, 2, "submitted", master],
    ]);
    /** The first card's failure is quiet: no link, no task, no next day try, because the backup paid. */
    expect(rows[0]).toMatchObject({ failure_code: "insufficient_funds", customer_told: null, task_id: null, retry_at: null });
    expect(stripe.charges.map((c) => c.paymentMethodRef?.slice(-4))).toEqual(["4242", "5555"]);
    expect(stripe.charges.every((c) => c.offSession === true && c.amountMinor === 12000)).toBe(true);

    /** Told once the processor says the money moved. */
    await settle(rows[1]!.intent_id!, 12000);
    await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    const [, paid] = await charges(invoiceId);
    expect(paid).toMatchObject({ status: "paid", customer_told: "email" });
    const [note] = await raw<{ body: string }[]>`select body from public.message
      where organization_id = ${ORG} and body like '%the backup you chose%' order by created_at desc limit 1`;
    expect(note!.body).toMatch(/could not take this bill from your Visa ending 4242, so we took it from your Mastercard ending 5555/);

    const office = await cardOnFile.forInvoice(owner(), { invoiceId });
    expect(office.charges.map((c) => [c.cardRank, c.card, c.status])).toEqual([
      [2, "Mastercard ending 5555", "paid"], [1, "Visa ending 4242", "failed"],
    ]);

    /** Nothing more is tried on a bill a backup paid, then or the next day. */
    await cardOnFile.autopayFor(db(), ORG, { deps: deps(), now: new Date(Date.now() + 30 * 3600e3) });
    expect(stripe.charges).toHaveLength(2);
  });

  it("when every card fails, sends the link once and raises one task naming each, and tomorrow tries the first card alone", async () => {
    await setUp([master, amex]);
    stripe.answers.set("4242", { code: "insufficient_funds", message: "Your card has insufficient funds." });
    stripe.answers.set("5555", { code: "card_declined", message: "Your card was declined." });
    stripe.answers.set("0005", { code: "expired_card", message: "Your card has expired." });
    const invoiceId = await anInvoice(remy, "80.00");
    const now = new Date();

    const pass = await cardOnFile.autopayFor(db(), ORG, { deps: deps(), now });
    expect(pass).toMatchObject({ charged: 0, failed: 1 });
    const rows = await charges(invoiceId);
    expect(rows.map((r) => [r.card_rank, r.status, r.task_id !== null, r.customer_told])).toEqual([
      [1, "failed", false, null], [2, "failed", false, null], [3, "failed", true, "email"],
    ]);
    /** Tomorrow's try is the first card's answer: insufficient funds may be fine tomorrow, though the last card has expired. */
    expect(rows[2]!.retry_at!.getTime()).toBeGreaterThan(now.getTime() + 23 * 3600e3);
    const [task] = await raw<{ body: string }[]>`select body from public.task where id = ${rows[2]!.task_id!}`;
    expect(task!.body).toMatch(/Visa ending 4242: Your card has insufficient funds\. Mastercard ending 5555: Your card was declined\. American Express ending 0005: Your card has expired\./);
    const [tasks] = await raw<{ n: number }[]>`select count(*)::int as n from public.task where organization_id = ${ORG} and entity_id = ${invoiceId}`;
    expect(tasks!.n).toBe(1);

    stripe.answers.clear();
    await cardOnFile.autopayFor(db(), ORG, { deps: deps(), now: new Date(now.getTime() + 25 * 3600e3) });
    const after = await charges(invoiceId);
    expect(after.map((r) => [r.attempt, r.card_rank, r.status])).toEqual([
      [1, 1, "failed"], [1, 2, "failed"], [1, 3, "failed"], [2, 1, "submitted"],
    ]);
    expect(stripe.charges.map((c) => c.paymentMethodRef?.slice(-4))).toEqual(["4242", "5555", "0005", "4242"]);
  });

  it("tries no backup the customer stopped, and none once the first card is withdrawn", async () => {
    await setUp([master]);
    stripe.answers.set("4242", { code: "card_declined", message: "Your card was declined." });
    await cardOnFile.setBackup(db(), { token, cardId: master, on: false });
    const first = await anInvoice(remy, "30.00");
    await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    expect((await charges(first)).map((r) => r.card_rank)).toEqual([1]);

    await cardOnFile.setBackup(db(), { token, cardId: master, on: true, wording: (await wordsFor(token, master)).backup });
    await cardOnFile.withdraw(db(), { token, cardId: visa });
    const second = await anInvoice(remy, "31.00");
    const pass = await cardOnFile.autopayFor(db(), ORG, { deps: deps() });
    expect(pass.charged).toBe(0);
    expect(await charges(second)).toHaveLength(0);
    const listed = await savedCards.list(db(), { token });
    expect(listed.cards.find((c) => c.id === master)!.agreement!.autopayRank).toBeNull();
  });
});
