import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as referrals from "../src/services/referrals";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as creditNotes from "../src/services/credit-notes";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A REFERRAL REWARD'S CREDIT, ON AN INVOICE
 *
 * The credit note a referral earns can be put on the referrer's invoice by a
 * person (the invoice offers it, and the application is the credit note
 * application it has always been) or, when the company turns it on, by itself
 * on the first invoice issued after the reward was given. Off by default, only
 * for a credit on their account, never on an invoice already out, never twice
 * for one reward, and never past what the invoice owes.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("referral-credit:org");
const USER = fixtureId("referral-credit:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);

let referrerId = "";
/** A second referrer for the tests of the automatic path, so the first one's open bills are not in the way. */
let rexId = "";
let seq = 0;

/** A customer the referrer sent, whose first job is paid in full, so the worker can grant the reward. */
async function sentAndPaid(name: string, by = referrerId): Promise<string> {
  const referred = (await customers.create(owner(), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: `${++seq} Reward St`, city: "Austin", state: "TX", postalCode: "78704", country: "US" } },
  })).id as string;
  await raw`update public.customer set referred_by_customer_id = ${by} where id = ${referred}`;
  const [link] = await raw<{ property_id: string }[]>`select property_id from public.customer_property where customer_id = ${referred}`;
  const job = await jobs.create(owner(), { customerId: referred, propertyId: link!.property_id, summary: "Tune up", tags: [], customFields: {} });
  const invoice = await billing.create(owner(), {
    customerId: referred, jobId: job.id as string,
    lines: [{ name: "Tune up", quantity: "1", unitPrice: "150.00", discountAmount: "0", taxable: false }],
  });
  await billing.pay({ ...owner(), idempotencyKey: `credit-pay-${referred}` }, {
    customerId: referred, method: "check", amount: "150.00", tipAmount: "0",
    allocations: [{ invoiceId: invoice.id as string, amount: "150.00" }],
  });
  return referred;
}

/** An invoice for the referrer, issued now. */
async function invoiceFor(amount: string, who = referrerId): Promise<string> {
  /** Raised and issued in one go, as the office's "bill this" does. */
  const draft = await billing.create(owner(), {
    customerId: who,
    lines: [{ name: "Service", quantity: "1", unitPrice: amount, discountAmount: "0", taxable: false }],
  });
  return draft.id as string;
}

const invoiceRow = async (id: string) =>
  (await raw<{ balance: string; status: string; amount_credited: string }[]>`
    select balance, status, amount_credited from public.invoice where id = ${id}`)[0]!;
const noteRow = async (id: string) =>
  (await raw<{ balance: string; status: string }[]>`select balance, status from public.credit_note where id = ${id}`)[0]!;
const rewardOf = async (referred: string) =>
  (await raw<{ id: string; credit_note_id: string; auto_applied_at: Date | null }[]>`
    select id, credit_note_id, auto_applied_at from public.referral_reward where referred_customer_id = ${referred}`)[0]!;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Credit Co", slug: "referral-credit-co" });
  referrerId = (await customers.create(owner(), {
    type: "residential", name: "Rosa Referrer", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  rexId = (await customers.create(owner(), {
    type: "residential", name: "Rex Referrer", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("the reward's credit on an invoice a person chooses", () => {
  let ned = "";
  let early = "";

  it("is offered on an invoice only once there is credit, and only on one that is owed", async () => {
    early = await invoiceFor("40.00");
    expect(await referrals.creditForInvoice(owner(), { id: early })).toEqual({ invoiceBalance: "40.0000", credits: [] });

    await referrals.setSettings(owner(), { reward: "credit_note", amount: "25" });
    ned = await sentAndPaid("Ned Neighbour");
    expect((await referrals.grantDue(db(), ORG)).granted).toBe(1);

    const offer = await referrals.creditForInvoice(owner(), { id: early });
    expect(offer.credits).toHaveLength(1);
    expect(offer.credits[0]).toMatchObject({ referredName: "Ned Neighbour", balance: "25.0000", apply: "25.00" });
    /** The referred customer's own paid invoice is owed nothing and is offered nothing. */
    const [paid] = await raw<{ id: string }[]>`select id from public.invoice where customer_id = ${ned}`;
    expect((await referrals.creditForInvoice(owner(), { id: paid!.id })).credits).toEqual([]);
  });

  it("takes the credit off through the credit note application, for the smaller of the credit and the bill", async () => {
    const offer = (await referrals.creditForInvoice(owner(), { id: early })).credits[0]!;
    await creditNotes.apply(owner("referral-credit:test-1"), {
      id: offer.creditNoteId, applications: [{ invoiceId: early, amount: offer.apply }],
    });
    expect(await invoiceRow(early)).toMatchObject({ balance: "15.0000", status: "partially_paid", amount_credited: "25.0000" });
    expect(await noteRow(offer.creditNoteId)).toEqual({ balance: "0.0000", status: "applied" });
    expect((await referrals.creditForInvoice(owner(), { id: early })).credits).toEqual([]);
    const view = await referrals.overview(owner());
    expect(view.referred.find((r) => r.id === ned)!.reward).toMatchObject({ creditLeft: "0.0000", autoAppliedAt: null });
  });

  it("offers two rewards on one bill without taking more than it owes", async () => {
    const pia = await sentAndPaid("Pia Pal");
    const sam = await sentAndPaid("Sam Sent");
    expect((await referrals.grantDue(db(), ORG)).granted).toBe(2);
    const small = await invoiceFor("30.00");
    const offer = await referrals.creditForInvoice(owner(), { id: small });
    expect(offer.credits.map((c) => c.apply)).toEqual(["25.00", "5.00"]);
    expect([pia, sam]).toHaveLength(2);
  });

  it("is read by whoever may read invoices, and applied only by whoever may credit them", async () => {
    const small = (await raw<{ id: string }[]>`select id from public.invoice where customer_id = ${referrerId} and balance = 30 limit 1`)[0]!.id;
    const offer = (await referrals.creditForInvoice(owner(), { id: small })).credits[0]!;
    await expect(creditNotes.apply(as(["technician"]), {
      id: offer.creditNoteId, applications: [{ invoiceId: small, amount: offer.apply }],
    })).rejects.toThrow();
  });
});

run("the reward's credit on the next invoice by itself", () => {
  it("is off until the company turns it on, and only for a credit on their account", async () => {
    const view = await referrals.overview(owner());
    expect(view.settings).toMatchObject({ reward: "credit_note", applyToNextInvoice: false });
    expect((await referrals.applyDue(db(), ORG)).applied).toBe(0);
    await expect(referrals.setSettings(owner(), { reward: "owed", amount: "25", applyToNextInvoice: true }))
      .rejects.toThrow(/Only a credit on their account/);
    await expect(referrals.setSettings(owner(), { reward: "none", applyToNextInvoice: true })).rejects.toThrow();
  });

  it("puts the credit on the first invoice issued after the reward, once, and not on a bill already out", async () => {
    /** A bill out for days before the reward was given: a thank you today does not change it. */
    const older = await invoiceFor("90.00", rexId);
    await raw`update public.invoice set issued_on = (issued_on - interval '5 days')::date where id = ${older}`;
    /** The first referrer's rewards from the tests above are not what this one is about. */
    await raw`update public.referral_reward set auto_applied_at = now() where referrer_customer_id = ${referrerId}`;
    const view = await referrals.setSettings(owner(), { reward: "credit_note", amount: "25", applyToNextInvoice: true });
    expect(view).toEqual({ reward: "credit_note", amount: "25", applyToNextInvoice: true });

    const pat = await sentAndPaid("Pat Pass", rexId);
    expect((await referrals.grantDue(db(), ORG)).granted).toBe(1);
    const reward = await rewardOf(pat);
    const next = await invoiceFor("60.00", rexId);
    expect((await referrals.applyDue(db(), ORG)).applied).toBe(1);
    expect(await invoiceRow(next)).toMatchObject({ balance: "35.0000", status: "partially_paid", amount_credited: "25.0000" });
    expect(await invoiceRow(older)).toMatchObject({ balance: "90.0000", amount_credited: "0.0000" });
    expect(await noteRow(reward.credit_note_id)).toEqual({ balance: "0.0000", status: "applied" });
    expect((await rewardOf(pat)).auto_applied_at).not.toBeNull();

    /** A second pass, or a second worker, does nothing. */
    expect((await referrals.applyDue(db(), ORG)).applied).toBe(0);
    const [audit] = await raw<{ n: string }[]>`
      select count(*) as n from public.audit_log where organization_id = ${ORG} and action = 'referral_reward.auto_applied' and entity_id = ${reward.id}`;
    expect(Number(audit!.n)).toBe(1);
    const view2 = await referrals.overview(owner());
    expect(view2.referred.find((r) => r.id === pat)!.reward).toMatchObject({ creditLeft: "0.0000" });
    expect(view2.referred.find((r) => r.id === pat)!.reward!.autoAppliedAt).not.toBeNull();
  });

  it("leaves what a small invoice cannot take on the account, and does not put it on a second invoice", async () => {
    const uma = await sentAndPaid("Uma Unit", rexId);
    expect((await referrals.grantDue(db(), ORG)).granted).toBe(1);
    const reward = await rewardOf(uma);
    const tiny = await invoiceFor("10.00", rexId);
    expect((await referrals.applyDue(db(), ORG)).applied).toBe(1);
    expect(await invoiceRow(tiny)).toMatchObject({ balance: "0.0000", status: "paid" });
    expect(await noteRow(reward.credit_note_id)).toEqual({ balance: "15.0000", status: "partially_applied" });

    const later = await invoiceFor("50.00", rexId);
    expect((await referrals.applyDue(db(), ORG)).applied).toBe(0);
    expect(await invoiceRow(later)).toMatchObject({ balance: "50.0000", amount_credited: "0.0000" });
    /** What is left is still offered on the invoice, for a person to apply. */
    const left = (await referrals.creditForInvoice(owner(), { id: later })).credits.find((c) => c.referredName === "Uma Unit");
    expect(left).toMatchObject({ balance: "15.0000" });
  });

  it("gives the claim back when the application is refused, so the next pass tries again", async () => {
    const vic = await sentAndPaid("Vic Void", rexId);
    expect((await referrals.grantDue(db(), ORG)).granted).toBe(1);
    const reward = await rewardOf(vic);
    const after = await invoiceFor("20.00", rexId);
    /** The credit is voided between the worker finding it and applying it. */
    await creditNotes.voidNote(owner(), { id: reward.credit_note_id, reason: "Issued by mistake" });
    expect((await referrals.applyDue(db(), ORG)).applied).toBe(0);
    expect((await rewardOf(vic)).auto_applied_at).toBeNull();
    expect(await invoiceRow(after)).toMatchObject({ balance: "20.0000" });
  });
});
