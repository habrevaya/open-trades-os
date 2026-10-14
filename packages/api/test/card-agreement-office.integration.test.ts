import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { customerPortal as cp, PermissionError, type Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as files from "../src/services/files";
import * as payments from "../src/services/payments";
import * as portal from "../src/services/portal";
import * as savedCards from "../src/services/saved-cards";
import * as cardOnFile from "../src/services/card-on-file";
import type {
  CardSetup, CardVault, ChargeOutcome, ChargeRequest, PaymentProvider, RefundOutcome,
} from "../src/payments/provider";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A CARD AUTHORIZATION THE OFFICE RECORDS
 *
 * A customer who says yes on the phone, or signs a form, to being charged on
 * file. The office records it on the customer's page, and it sits in the same
 * `payment_agreement` records as the customer's own, so the one place that
 * decides whether a card may be charged stays the one place.
 *
 * This is about money, so the refusals come first: no scanned form means no
 * paper agreement, another company's customer is not found, a technician is
 * refused, a withdrawn agreement charges nothing, and the words are the
 * product's. Then the agreement as it is kept, what the customer sees in
 * their portal and can withdraw there, and a charge under it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("card-agreement-office:org");
const USER = fixtureId("card-agreement-office:user");
const OTHER_ORG = fixtureId("card-agreement-office:other-org");
const OTHER_USER = fixtureId("card-agreement-office:other-user");
const ACCOUNTANT = fixtureId("card-agreement-office:accountant");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, organizationId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId, roles: roles as Actor["roles"] }, db: db(),
});
const owner = (extra: Partial<ServiceContext> = {}): ServiceContext => ({ ...as(USER, ORG, ["owner"]), ...extra });
const accountant = (): ServiceContext => as(ACCOUNTANT, ORG, ["accountant"]);
const stranger = (): ServiceContext => as(OTHER_USER, OTHER_ORG, ["owner"]);
/** A technician takes payments from the person in front of them, and may not charge a saved card. */
const technician = (): ServiceContext => as(USER, ORG, ["technician"]);

/** Stripe, as far as these services can tell. */
class FakeStripe implements PaymentProvider {
  readonly name = "stripe";
  readonly publishableKey = "pk_test_office_agreement";
  charges: ChargeRequest[] = [];
  setups = new Map<string, CardSetup>();

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.charges.push(request);
    return {
      ok: true,
      intent: {
        intentId: `pi_office_${this.charges.length}_${Math.random().toString(36).slice(2)}`,
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

async function aCustomer(ctx: ServiceContext, name: string, email: string | null = null) {
  const c = await customers.create(ctx, {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    ...(email ? { email } : {}),
  });
  return c.id as string;
}

/** A sign in, minted the way a right code mints one. */
async function signedIn(customerId: string): Promise<string> {
  const [signIn] = await raw<{ id: string }[]>`insert into public.portal_sign_in
    (organization_id, channel, address, expires_at, ended_at, ended_reason, customer_id)
    values (${ORG}, 'email', 'someone@office-agree.test', now(), now(), 'signed_in', ${customerId}) returning id`;
  const minted = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId, scope: "customer", expiresInDays: 7, signInId: signIn!.id,
  }));
  return minted.token;
}

async function saveACard(token: string) {
  const started = await savedCards.startSave(db(), { token }, undefined, deps());
  return savedCards.confirmSave(db(), { token, setupId: started.setupId }, deps());
}

async function anInvoice(customerId: string, total: string) {
  const invoice = await billing.create(owner(), {
    customerId,
    lines: [{ name: "Tune up", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  return invoice.id as string;
}

/** The words the office is shown for a card, for either way of recording it. */
async function wordsFor(ctx: ServiceContext, customerId: string, cardId: string) {
  const { cards } = await cardOnFile.officeCardsFor(ctx, { customerId });
  return cards.find((c) => c.cardId === cardId)!.wording;
}

/** A scanned form, as a browser sends it: a PDF, base64. */
const scanned = (marker = "signed") => ({
  fileName: `authorization-${marker}.pdf`,
  contentType: "application/pdf",
  bytes: Buffer.from(`%PDF-1.4\n% ${marker} card authorization form\n%%EOF\n`).toString("base64"),
});

type Extra = Partial<Parameters<typeof cardOnFile.recordAgreement>[1]>;

async function byPhone(ctx: ServiceContext, customerId: string, cardId: string, extra: Extra = {}) {
  return cardOnFile.recordAgreement(ctx, {
    customerId, cardId, way: "phone", agreedOn: companyToday(),
    wording: extra.wording ?? (await wordsFor(owner(), customerId, cardId)).phone, ...extra,
  });
}

async function onPaper(ctx: ServiceContext, customerId: string, cardId: string, extra: Extra = {}) {
  return cardOnFile.recordAgreement(ctx, {
    customerId, cardId, way: "signed_form", agreedOn: companyToday(),
    wording: extra.wording ?? (await wordsFor(owner(), customerId, cardId)).form, form: scanned(), ...extra,
  });
}

const agreementRows = (customerId: string) => raw<Record<string, unknown>[]>`
  select * from public.payment_agreement where customer_id = ${customerId} order by created_at`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Office Agree Air", slug: "office-agree-air" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Agree Air", slug: "office-agree-other" });
  await raw`update public."user" set name = 'Sam Taker' where id = ${USER}`;
  await raw`insert into public."user" (id, email, name) values (${ACCOUNTANT}, 'accountant@office-agree.test', 'Alma Books')
    on conflict (id) do nothing`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${ACCOUNTANT}, 'accountant')`;
  await raw`insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', 'TEST_OFFICE_AGREE_KEY',
            ${raw.json({ publishableKey: "pk_test_office_agreement" } as never)})`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "billing@example-trades.com" } as never)})`;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await resetOrg(raw, OTHER_ORG);
  await raw`delete from public."user" where id = ${ACCOUNTANT}`;
  await raw.end();
});

beforeEach(() => {
  stripe = new FakeStripe();
});

/* ============================================================ refusals === */

run("an agreement the office records cannot be made out of nothing", () => {
  let dana = "";
  let token = "";
  let cardId = "";

  /** A customer of its own for every test, so a row one test leaves cannot be counted by the next. */
  let count = 0;
  beforeEach(async () => {
    stripe = new FakeStripe();
    count += 1;
    dana = await aCustomer(owner(), `Dana Phoned ${count}`, `dana${count}@office-agree.test`);
    token = await signedIn(dana);
    cardId = (await saveACard(token)).id;
  });

  it("refuses an agreement on paper with no form, and the database refuses it too", async () => {
    const wording = (await wordsFor(owner(), dana, cardId)).form;
    await expect(cardOnFile.recordAgreement(owner(), {
      customerId: dana, cardId, way: "signed_form", agreedOn: companyToday(), wording,
    })).rejects.toThrow(/scanned form/);
    expect(await agreementRows(dana)).toHaveLength(0);

    // A second writer that forgot the rule is stopped by the table itself.
    await expect(raw`insert into public.payment_agreement
      (organization_id, customer_id, saved_payment_method_id, wording, agreed_via, given_by, agreed_on)
      values (${ORG}, ${dana}, ${cardId}, 'x', 'office_form', 'office', ${companyToday()})`)
      .rejects.toThrow(/payment_agreement_paper_needs_form/);
    // And an office agreement that claims to be the customer's own sign in.
    await expect(raw`insert into public.payment_agreement
      (organization_id, customer_id, saved_payment_method_id, wording, agreed_via, given_by, agreed_on)
      values (${ORG}, ${dana}, ${cardId}, 'x', 'portal_sign_in', 'office', ${companyToday()})`)
      .rejects.toThrow(/payment_agreement_given_by_way/);
    expect(await agreementRows(dana)).toHaveLength(0);
  });

  it("refuses a form that is not this customer's own scan, or that is not a file at all", async () => {
    const other = await aCustomer(owner(), "Not Dana", "notdana@office-agree.test");
    const theirs = await files.upload(owner(), {
      entityType: "customer", entityId: other, ...scanned("theirs"), fileName: "theirs.pdf",
    });
    await expect(onPaper(owner(), dana, cardId, { form: undefined, formAttachmentId: theirs.id }))
      .rejects.toThrow(/scanned form/);
    // Bytes that are not a PDF or a picture are refused by the one place that reads files.
    await expect(onPaper(owner(), dana, cardId, {
      form: { fileName: "form.pdf", contentType: "application/pdf", bytes: Buffer.from("not a pdf at all").toString("base64") },
    })).rejects.toThrow(ConflictError);
    expect(await agreementRows(dana)).toHaveLength(0);
  });

  it("refuses another company's customer as a customer that does not exist, and keeps nothing", async () => {
    await expect(byPhone(stranger(), dana, cardId, { wording: (await wordsFor(owner(), dana, cardId)).phone }))
      .rejects.toThrow(NotFoundError);
    await expect(cardOnFile.officeCardsFor(stranger(), { customerId: dana })).rejects.toThrow(NotFoundError);
    expect(await agreementRows(dana)).toHaveLength(0);
    // Their own customer with this company's card is not found either.
    const theirs = await aCustomer(stranger(), "Stranger's Customer");
    await expect(byPhone(stranger(), theirs, cardId, { wording: (await wordsFor(owner(), dana, cardId)).phone }))
      .rejects.toThrow(NotFoundError);
    expect(await agreementRows(dana)).toHaveLength(0);
  });

  it("refuses a technician, and a person who may only read payments", async () => {
    const wording = (await wordsFor(owner(), dana, cardId)).phone;
    await expect(cardOnFile.recordAgreement(technician(), {
      customerId: dana, cardId, way: "phone", agreedOn: companyToday(), wording,
    })).rejects.toThrow(PermissionError);
    await expect(cardOnFile.recordAgreement(as(USER, ORG, ["csr"]), {
      customerId: dana, cardId, way: "phone", agreedOn: companyToday(), wording,
    })).rejects.toThrow(PermissionError);
    expect(await agreementRows(dana)).toHaveLength(0);
    // Nor can the technician charge on the strength of one the office has since recorded.
    await byPhone(owner(), dana, cardId);
    const invoiceId = await anInvoice(dana, "40.00");
    await expect(cardOnFile.charge(technician(), { invoiceId, cardId }, deps())).rejects.toThrow(PermissionError);
    expect(stripe.charges).toHaveLength(0);
    await cardOnFile.withdraw(db(), { token, cardId });
  });

  it("refuses words that are not the product's, for the way it is being recorded", async () => {
    const words = await wordsFor(owner(), dana, cardId);
    await expect(byPhone(owner(), dana, cardId, { wording: "The customer said it was fine to charge them." }))
      .rejects.toThrow(/words on this page have changed/);
    // The form's words are not the phone script, and the phone script is not the form's.
    await expect(byPhone(owner(), dana, cardId, { wording: words.form })).rejects.toThrow(/words on this page have changed/);
    await expect(onPaper(owner(), dana, cardId, { wording: words.phone })).rejects.toThrow(/words on this page have changed/);
    expect(await agreementRows(dana)).toHaveLength(0);
  });

  it("refuses a day in the future, a day before the card was saved, a card that is not theirs, and a card taken off", async () => {
    await expect(byPhone(owner(), dana, cardId, { agreedOn: companyToday(2) })).rejects.toThrow(/future/);
    await expect(byPhone(owner(), dana, cardId, { agreedOn: companyToday(-40) })).rejects.toThrow(/before the card was saved/);
    await expect(byPhone(owner(), dana, cardId, { agreedOn: "next Tuesday" })).rejects.toThrow();

    const eli = await aCustomer(owner(), "Eli Other", "eli@office-agree.test");
    await expect(byPhone(owner(), eli, cardId, { wording: (await wordsFor(owner(), dana, cardId)).phone }))
      .rejects.toThrow(NotFoundError);

    const spare = await saveACard(token);
    const spareWords = (await wordsFor(owner(), dana, spare.id)).phone;
    await savedCards.remove(db(), { token, cardId: spare.id }, undefined, deps());
    await expect(byPhone(owner(), dana, spare.id, { wording: spareWords })).rejects.toThrow(NotFoundError);
    expect(await agreementRows(dana)).toHaveLength(0);
  });

  it("refuses to charge a card whose recorded agreement was withdrawn, by the customer or by the office", async () => {
    const invoiceId = await anInvoice(dana, "95.00");
    const phoned = await byPhone(owner(), dana, cardId);
    await cardOnFile.withdraw(db(), { token, cardId });
    await expect(cardOnFile.charge(owner(), { invoiceId, cardId }, deps())).rejects.toThrow(/withdrawn/);

    const again = await byPhone(owner(), dana, cardId);
    expect(again.id).not.toBe(phoned.id);
    await cardOnFile.withdrawForCustomer(owner(), { customerId: dana, agreementId: again.id });
    await expect(cardOnFile.charge(owner(), { invoiceId, cardId }, deps())).rejects.toThrow(/withdrawn/);
    // A direct ask of the processor path, naming the withdrawn agreement, is refused too.
    await expect(payments.intent(owner(), {
      customerId: dana, invoiceIds: [invoiceId], savedCardId: cardId, offSession: { agreementId: again.id },
    }, deps())).rejects.toThrow(/has not agreed/);
    expect(stripe.charges).toHaveLength(0);
  });

  it("refuses a second live agreement on a card, and a withdrawal by somebody who may not charge it", async () => {
    const live = await byPhone(owner(), dana, cardId);
    await expect(byPhone(owner(), dana, cardId)).rejects.toThrow(/already agreed/);
    await expect(onPaper(owner(), dana, cardId)).rejects.toThrow(/already agreed/);
    await expect(cardOnFile.withdrawForCustomer(technician(), { customerId: dana, agreementId: live.id }))
      .rejects.toThrow(PermissionError);
    await expect(cardOnFile.withdrawForCustomer(stranger(), { customerId: dana, agreementId: live.id }))
      .rejects.toThrow(NotFoundError);
    const [row] = await agreementRows(dana);
    expect(row!["withdrawn_at"]).toBeNull();
    await cardOnFile.withdraw(db(), { token, cardId });
  });
});

/* ====================================================== recording it === */

run("recording an agreement the customer gave on the phone or on paper", () => {
  it("keeps the product's script, the day, who took it and that it was by phone", async () => {
    stripe = new FakeStripe();
    const frank = await aCustomer(owner(), "Frank Phoned", "frank@office-agree.test");
    const token = await signedIn(frank);
    const card = await saveACard(token);
    await raw`update public.saved_payment_method set created_at = now() - interval '10 days' where id = ${card.id}`;

    const words = await wordsFor(owner(), frank, card.id);
    expect(words.phone).toBe(cp.phoneScript({ company: "Office Agree Air", method: "Visa ending 4242", kind: "card" }));
    expect(words.phone).toMatch(/Do you agree\?$/);
    expect(words.form).toBe(cp.formWording({ company: "Office Agree Air", method: "Visa ending 4242", kind: "card" }));

    const recorded = await byPhone(owner({ idempotencyKey: "phone-frank-1" }), frank, card.id, { agreedOn: companyToday(-1) });
    expect(recorded).toMatchObject({
      cardId: card.id, givenBy: "office", way: "office_phone", agreedOn: companyToday(-1), takenBy: "Sam Taker",
      wording: words.phone, form: null, autopay: false,
    });
    const [row] = await agreementRows(frank);
    expect(row).toMatchObject({
      agreed_via: "office_phone", given_by: "office", taken_by_user_id: USER, wording: words.phone,
      form_attachment_id: null, grant_id: null, contact_id: null, withdrawn_at: null,
    });
    const [audit] = await raw<{ actor_user_id: string; after: Record<string, unknown> }[]>`
      select actor_user_id, "after" from public.audit_log
      where organization_id = ${ORG} and action = 'card_agreement.recorded' and entity_id = ${frank}`;
    expect(audit!.actor_user_id).toBe(USER);
    expect(audit!.after).toMatchObject({ agreementId: recorded.id, way: "phone", agreedOn: companyToday(-1) });

    // The same press again is the same agreement.
    const replay = await byPhone(owner({ idempotencyKey: "phone-frank-1" }), frank, card.id, { agreedOn: companyToday(-1) });
    expect(replay.id).toBe(recorded.id);
    expect(await agreementRows(frank)).toHaveLength(1);
  });

  it("keeps the scanned form as an attachment on the customer, and the agreement points at it", async () => {
    stripe = new FakeStripe();
    const gwen = await aCustomer(owner(), "Gwen Signed", "gwen@office-agree.test");
    const token = await signedIn(gwen);
    const card = await saveACard(token);

    // An accountant holds payment:charge_saved and not document:write: the form goes up as part of the agreement.
    const recorded = await onPaper(accountant(), gwen, card.id);
    expect(recorded).toMatchObject({ givenBy: "office", way: "office_form", takenBy: "Alma Books" });
    expect(recorded.form).toMatchObject({ fileName: "authorization-signed.pdf" });
    const [row] = await agreementRows(gwen);
    expect(row).toMatchObject({ agreed_via: "office_form", taken_by_user_id: ACCOUNTANT });
    const [attachment] = await raw<{ id: string; entity_type: string; entity_id: string; kind: string; content_type: string; shared_with_customer_at: Date | null }[]>`
      select id, entity_type, entity_id, kind, content_type, shared_with_customer_at from public.attachment
      where id = ${row!["form_attachment_id"] as string}`;
    expect(attachment).toMatchObject({
      entity_type: "customer", entity_id: gwen, kind: "document", content_type: "application/pdf", shared_with_customer_at: null,
    });
    // The attachment path lists it on the customer, as for any other file.
    const listed = await files.attachmentsFor(owner(), { entityType: "customer", entityId: gwen });
    expect(listed.map((a) => a.id)).toContain(attachment!.id);
  });

  it("can use a form already uploaded to the customer through the attachment path", async () => {
    const hugo = await aCustomer(owner(), "Hugo Uploaded", "hugo@office-agree.test");
    const token = await signedIn(hugo);
    const card = await saveACard(token);
    const uploaded = await files.upload(owner(), { entityType: "customer", entityId: hugo, ...scanned("uploaded"), fileName: "scan.pdf" });
    const recorded = await onPaper(owner(), hugo, card.id, { form: undefined, formAttachmentId: uploaded.id });
    expect(recorded.form).toMatchObject({ attachmentId: uploaded.id, fileName: "scan.pdf" });
    // The same scan cannot stand behind two agreements.
    const second = await saveACard(token);
    await expect(onPaper(owner(), hugo, second.id, { form: undefined, formAttachmentId: uploaded.id }))
      .rejects.toThrow(/already behind an agreement/);
  });
});

/* =============================================== the customer sees it === */

run("what the customer sees of an agreement the office recorded, and withdrawing it", () => {
  it("shows it in their portal as the office's, with who took it, and lets them withdraw it", async () => {
    stripe = new FakeStripe();
    const iris = await aCustomer(owner(), "Iris Portal", "iris@office-agree.test");
    const token = await signedIn(iris);
    const card = await saveACard(token);
    const before = await savedCards.list(db(), { token });
    expect(before.cards[0]!.agreement).toBeNull();

    await onPaper(owner(), iris, card.id);
    const listed = await savedCards.list(db(), { token });
    expect(listed.cards[0]!.agreement).toMatchObject({
      cardId: card.id, givenBy: "office", way: "office_form", wayLabel: "Agreed on a signed form",
      takenBy: "Sam", hasForm: true, autopay: false,
    });
    // The customer's page never carries the scan's storage key: the file is the company's to open.
    expect(JSON.stringify(listed)).not.toMatch(/storageKey|storage_key|\.pdf/);

    // They can turn paying automatically on over it, since it is a live agreement.
    const on = await cardOnFile.setAutopay(db(), { token, cardId: card.id, on: true, wording: listed.cards[0]!.wording.autopay });
    expect(on.autopay).toBe(true);

    // They can withdraw it, as they can their own, and then the office cannot charge.
    await cardOnFile.withdraw(db(), { token, cardId: card.id });
    const after = await savedCards.list(db(), { token });
    expect(after.cards[0]!.agreement).toBeNull();
    const [row] = await agreementRows(iris);
    expect(row).toMatchObject({ withdrawn_reason: "customer", autopay_at: null });
    expect(row!["form_attachment_id"]).toBeTruthy();
    await expect(cardOnFile.charge(owner(), { invoiceId: await anInvoice(iris, "30.00"), cardId: card.id }, deps()))
      .rejects.toThrow(/withdrawn/);
  });

  it("lets the customer's own agreement stand where it is, and reads as theirs", async () => {
    const jo = await aCustomer(owner(), "Jo Own", "jo@office-agree.test");
    const token = await signedIn(jo);
    const card = await saveACard(token);
    const wording = (await savedCards.list(db(), { token })).cards[0]!.wording.agreement;
    const own = await cardOnFile.agree(db(), { token, cardId: card.id, wording });
    expect(own).toMatchObject({ givenBy: "customer", way: "portal_sign_in", wayLabel: "Agreed in their account", takenBy: null, hasForm: false });
    // The office cannot record a second one over it.
    await expect(byPhone(owner(), jo, card.id)).rejects.toThrow(/already agreed/);
    const seen = await cardOnFile.officeCardsFor(owner(), { customerId: jo });
    expect(seen.cards[0]!.agreement).toMatchObject({ givenBy: "customer", agreedByContact: null });
  });
});

/* ================================================= charging under it === */

run("charging a card on an agreement the office recorded", () => {
  it("charges as for any agreement, naming the person who charged and the agreement it was under", async () => {
    stripe = new FakeStripe();
    const kim = await aCustomer(owner(), "Kim Charged", "kim@office-agree.test");
    const token = await signedIn(kim);
    const card = await saveACard(token);
    const agreement = await byPhone(owner(), kim, card.id);
    const invoiceId = await anInvoice(kim, "140.00");

    const seen = await cardOnFile.forInvoice(owner(), { invoiceId });
    expect(seen.cards).toHaveLength(1);
    expect(seen.cards[0]).toMatchObject({ agreementId: agreement.id, givenBy: "office", way: "office_phone" });

    const result = await cardOnFile.charge(owner(), { invoiceId, cardId: card.id }, deps());
    expect(result.status).toBe("submitted");
    expect(stripe.charges).toHaveLength(1);
    expect(stripe.charges[0]).toMatchObject({ amountMinor: 14000, offSession: true });
    const [charge] = await raw<{ agreement_id: string; requested_by_user_id: string }[]>`
      select agreement_id, requested_by_user_id from public.card_on_file_charge where invoice_id = ${invoiceId}`;
    expect(charge).toMatchObject({ agreement_id: agreement.id, requested_by_user_id: USER });
  });

  it("is withdrawn by the office when the customer asks by phone, with who and why, and nothing is charged after", async () => {
    stripe = new FakeStripe();
    const lou = await aCustomer(owner(), "Lou Stopped", "lou@office-agree.test");
    const token = await signedIn(lou);
    const card = await saveACard(token);
    const agreement = await onPaper(owner(), lou, card.id);
    await cardOnFile.setAutopay(db(), { token, cardId: card.id, on: true, wording: (await savedCards.list(db(), { token })).cards[0]!.wording.autopay });

    await cardOnFile.withdrawForCustomer(accountant(), { customerId: lou, agreementId: agreement.id });
    const [row] = await agreementRows(lou);
    expect(row).toMatchObject({ withdrawn_reason: "office", withdrawn_by_user_id: ACCOUNTANT, autopay_at: null });
    expect(row!["form_attachment_id"]).toBeTruthy();
    const [audit] = await raw<{ actor_user_id: string }[]>`select actor_user_id from public.audit_log
      where organization_id = ${ORG} and action = 'portal.card.agreement_withdrawn' and entity_id = ${lou}`;
    expect(audit!.actor_user_id).toBe(ACCOUNTANT);
    await expect(cardOnFile.charge(owner(), { invoiceId: await anInvoice(lou, "20.00"), cardId: card.id }, deps()))
      .rejects.toThrow(/withdrawn/);
    // Withdrawing what is already withdrawn is the same answer, not an error to retry.
    await cardOnFile.withdrawForCustomer(owner(), { customerId: lou, agreementId: agreement.id });
    expect(stripe.charges).toHaveLength(0);
  });
});
