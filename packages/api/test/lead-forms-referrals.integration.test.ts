import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as forms from "../src/services/forms";
import * as referrals from "../src/services/referrals";
import * as customers from "../src/services/customers";
import * as booking from "../src/services/booking";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as marketing from "../src/services/marketing";
import * as portal from "../src/services/portal";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A LEAD FROM A HOSTED FORM, AND A NEIGHBOUR SENT BY A CUSTOMER
 *
 * Two of the ways a trades company's own channels produce work, end to end:
 * a homeowner fills in a hosted form and becomes a customer the office rings
 * back, with the consent they ticked kept in the words they saw; a customer
 * shares their link, the neighbour books through it, and when the neighbour's
 * first job is paid the referrer is rewarded, once.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("leadform:org");
const USER = fixtureId("leadform:user");
const SLUG = "lead-form-co";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});
const meta = () => ({ ip: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });

const FIELDS = [
  { key: "name", label: "Your name", type: "text" as const, required: true },
  { key: "phone", label: "Mobile number", type: "phone" as const, required: true },
  { key: "email", label: "Email", type: "email" as const, required: false },
  { key: "address", label: "Where is the work?", type: "service_address" as const, required: false },
  {
    key: "texts_ok", label: "You may text me about offers.", type: "consent" as const, required: false,
    help: "Reply STOP at any time.", consentFor: { channel: "sms" as const, purpose: "marketing" as const },
  },
  { key: "website", label: "Leave this empty", type: "honeypot" as const, required: false },
];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Lead Form Co", slug: SLUG });
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125558000', 'main', true)`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("a hosted lead form", () => {
  let key = "";

  it("gets a public key when it is saved, and keeps it through an edit", async () => {
    const saved = await forms.save(owner(), {
      slug: "ac-check", title: "Free AC check", source: "direct_mail", fields: FIELDS,
      settings: { thankYou: "Thanks, we ring within the hour.", confirmationText: "Thanks from Lead Form Co, we will ring you soon." },
    });
    key = saved.publicKey;
    expect(key).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const again = await forms.save(owner(), { slug: "ac-check", title: "Free AC check", source: "direct_mail", fields: FIELDS });
    expect(again.publicKey).toBe(key);
  });

  it("refuses a consent box that says nothing it could record", async () => {
    await expect(forms.save(owner(), {
      slug: "bad", title: "Bad", fields: [
        ...FIELDS.slice(0, 2),
        { key: "x", label: "Agree", type: "text", required: false, consentFor: { channel: "sms", purpose: "marketing" } },
      ],
    })).rejects.toThrow(/not a consent box/);
  });

  it("serves the hosted page by its key with nothing but the form", async () => {
    const page = await forms.hosted(db(), { key });
    expect(page).toMatchObject({ organizationSlug: SLUG, formSlug: "ac-check", title: "Free AC check" });
    expect(page.fields.map((f) => f.key)).toContain("website");
    await expect(forms.hosted(db(), { key: "nothing-here" })).rejects.toThrow(/not found/);
  });

  it("turns a submission into a customer, the consent in the words shown, a call back and a confirmation text", async () => {
    const outcome = await forms.submit(db(), {
      organizationSlug: SLUG, formSlug: "ac-check",
      values: {
        name: "Hana Lead", phone: "(512) 555-8011", email: "Hana@Example.test", texts_ok: true,
        address: { line1: "4 Form St", city: "Austin", state: "TX", postalCode: "78701" },
      },
      visitorId: randomBytes(16).toString("hex"),
      landingQuery: "utm_source=mailer&utm_medium=print&email=leak%40x.y",
    }, meta());
    expect(outcome.accepted).toBe(true);
    expect(outcome.thankYou).toBe("Thanks, we ring within the hour.");
    const customerId = outcome.customerId!;

    const [customer] = await raw<{ name: string; phone: string; email: string; lead_source: string }[]>`
      select name, phone, email, lead_source from public.customer where id = ${customerId}`;
    expect(customer).toMatchObject({ name: "Hana Lead", phone: "+15125558011", email: "hana@example.test" });

    const [consent] = await raw<{ channel: string; purpose: string; state: string; method: string; proof_text: string }[]>`
      select channel, purpose, state, method, proof_text from public.communication_consent
      where organization_id = ${ORG} and address = '+15125558011' and superseded_at is null`;
    expect(consent).toEqual({
      channel: "sms", purpose: "marketing", state: "granted", method: "web_form",
      proof_text: "You may text me about offers. Reply STOP at any time.",
    });

    const tasks = await raw<{ title: string; queue: string; entity_id: string }[]>`
      select title, queue, entity_id from public.task where organization_id = ${ORG}`;
    expect(tasks).toEqual([{ title: "Ring back Hana Lead: Free AC check", queue: "office", entity_id: customerId }]);

    const [text] = await raw<{ from_address: string; body: string }[]>`
      select from_address, body from public.message where organization_id = ${ORG} and to_address = '+15125558011'`;
    expect(text).toEqual({ from_address: "+15125558000", body: "Thanks from Lead Form Co, we will ring you soon." });

    const [touch] = await raw<{ utm_source: string; customer_id: string }[]>`
      select t.utm_source, t.customer_id from public.marketing_touch t
      join public.form_submission s on s.touch_id = t.id where s.id = ${outcome.submissionId}`;
    expect(touch).toEqual({ utm_source: "mailer", customer_id: customerId });
  });

  it("matches the same person by phone rather than making a second customer, and records no consent unticked", async () => {
    const outcome = await forms.submit(db(), {
      organizationSlug: SLUG, formSlug: "ac-check",
      values: { name: "Hana L", phone: "+1 512 555 8011", texts_ok: false },
    }, meta());
    const [hana] = await raw<{ id: string }[]>`select id from public.customer where organization_id = ${ORG} and phone = '+15125558011'`;
    expect(outcome.customerId).toBe(hana!.id);
    expect(await raw`select 1 from public.customer where organization_id = ${ORG}`).toHaveLength(1);
    expect(await raw`select 1 from public.communication_consent where organization_id = ${ORG}`).toHaveLength(1);
  });

  it("keeps a filled honeypot as spam, makes nobody, and answers a replay with the first outcome", async () => {
    const replay = { ip: "10.1.1.1", idempotencyKey: randomBytes(8).toString("hex") };
    const spam = await forms.submit(db(), {
      organizationSlug: SLUG, formSlug: "ac-check",
      values: { name: "Bot", phone: "+15125558099", website: "http://spam.example" },
    }, replay);
    expect(spam.accepted).toBe(false);
    expect(spam.refusals[0]!.reason).toBe("spam");
    const again = await forms.submit(db(), {
      organizationSlug: SLUG, formSlug: "ac-check", values: { name: "Bot", phone: "+15125558099", website: "x" },
    }, replay);
    expect(again.submissionId).toBe(spam.submissionId);
    expect(await raw`select 1 from public.customer where phone = '+15125558099'`).toHaveLength(0);
  });
});

run("a referral, from the link to the reward", () => {
  let referrerId = "";
  let code = "";
  let neighbourId = "";

  it("mints the referrer a code and a link to the booking page", async () => {
    referrerId = (await customers.create(owner(), {
      type: "residential", name: "Rosa Referrer", phone: "+15125558100",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    })).id;
    const mine = await referrals.forCustomer(owner(), referrerId);
    code = mine.code;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(mine.link).toContain(`/book/${SLUG}?ref=${code}`);
    expect((await referrals.forCustomer(owner(), referrerId)).code).toBe(code);
  });

  it("credits a booking through the link to customer referrals, naming the referrer", async () => {
    const [jobType] = await raw<{ id: string }[]>`insert into public.job_type
      (organization_id, name, capacity_model) values (${ORG}, 'AC tune up', 'technician_dispatch') returning id`;
    const service = await booking.createService(owner(), {
      jobTypeId: jobType!.id, publicName: "AC tune up", minNoticeHours: 1, maxAdvanceDays: 30, maxPerWindow: 4,
    });
    await booking.setWindows(owner(), {
      windows: [{ name: "Morning", startsAt: "08:00", endsAt: "12:00", daysOfWeek: [0, 1, 2, 3, 4, 5, 6] }],
    });
    const [window] = await raw<{ id: string }[]>`select id from public.arrival_window where organization_id = ${ORG} limit 1`;
    const slot = { date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), arrivalWindowId: window!.id };
    const visitorId = randomBytes(16).toString("hex");
    const made = await booking.createRequest(db(), {
      organizationSlug: SLUG, bookableServiceId: service.id, requestedDate: slot.date,
      arrivalWindowId: slot.arrivalWindowId, contactName: "Ned Neighbour", contactPhone: "+15125558200",
      addressLine1: "9 Next Door", city: "Austin", state: "TX", postalCode: "78701",
      intakeAnswers: {}, utm: {}, landingQuery: `ref=${code.toLowerCase()}&otv=${visitorId}`, visitorId,
    });
    const [touch] = await raw<{ source: string; basis: string; referrer_customer_id: string }[]>`
      select source, basis, referrer_customer_id from public.marketing_touch
      where organization_id = ${ORG} and visitor_id = ${visitorId}`;
    expect(touch).toEqual({ source: "referral_customer", basis: "declared", referrer_customer_id: referrerId });

    const confirmed = await booking.confirm(owner(), { id: made.request.id });
    neighbourId = confirmed.customerId;
    const [neighbour] = await raw<{ referred_by_customer_id: string }[]>`
      select referred_by_customer_id from public.customer where id = ${neighbourId}`;
    expect(neighbour!.referred_by_customer_id).toBe(referrerId);
    const job = await jobs.get(owner(), { id: confirmed.jobId });
    expect(job.leadSource).toBe("referral_customer");
  });

  it("rewards nothing until the first job is paid, then a credit note, once", async () => {
    await referrals.setSettings(owner(), { reward: "credit_note", amount: "25" });
    expect((await referrals.grantDue(db(), ORG)).granted).toBe(0);

    const [job] = await raw<{ id: string }[]>`select id from public.job where customer_id = ${neighbourId}`;
    const invoice = await billing.create(owner(), {
      customerId: neighbourId, jobId: job!.id,
      lines: [{ name: "Tune up", quantity: "1", unitPrice: "150.00", discountAmount: "0", taxable: false }],
    });
    expect((await referrals.grantDue(db(), ORG)).granted).toBe(0);
    await billing.pay({ ...owner(), idempotencyKey: `ref-pay-${job!.id}` }, {
      customerId: neighbourId, method: "check", amount: "150.00", tipAmount: "0",
      allocations: [{ invoiceId: invoice.id as string, amount: "150.00" }],
    });

    expect((await referrals.grantDue(db(), ORG)).granted).toBe(1);
    expect((await referrals.grantDue(db(), ORG)).granted).toBe(0);
    const view = await referrals.overview(owner());
    const reward = view.referred.find((r) => r.id === neighbourId)!.reward!;
    expect(reward).toMatchObject({ kind: "credit_note", state: "credited" });
    const [note] = await raw<{ customer_id: string; total: string; status: string }[]>`
      select customer_id, total, status from public.credit_note where id = ${reward.creditNoteId}`;
    expect(note).toEqual({ customer_id: referrerId, total: "25.0000", status: "open" });
    expect(view.referrers).toEqual([{ id: referrerId, name: "Rosa Referrer", referred: 1, rewarded: 1 }]);
  });

  it("refuses to move a rewarded referral to somebody else", async () => {
    const other = (await customers.create(owner(), {
      type: "residential", name: "Otto Other", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    })).id;
    await expect(referrals.setReferredBy(owner(), { customerId: neighbourId, referrerId: other, replace: true }))
      .rejects.toThrow(/already been given/);
  });

  it("records a word of mouth referral the office was told about, as a touch naming the referrer", async () => {
    const told = (await customers.create(owner(), {
      type: "residential", name: "Wendy Word", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    })).id;
    await referrals.setReferredBy(owner(), { customerId: told, referrerId });
    const touches = await marketing.touchesFor(owner(), { customerId: told });
    expect(touches.some((t) => t.source === "referral_customer")).toBe(true);
    const [row] = await raw<{ referrer_customer_id: string }[]>`
      select referrer_customer_id from public.marketing_touch where customer_id = ${told} and source = 'referral_customer'`;
    expect(row!.referrer_customer_id).toBe(referrerId);
  });

  it("shows the customer their own link from their account page, and nothing about anybody else", async () => {
    const { token } = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
      organizationId: ORG, customerId: referrerId, scope: "customer", expiresInDays: 1,
    }));
    const view = await referrals.forPortal(db(), { token });
    expect(view.code).toBe(code);
    expect(view.referred).toEqual([{ firstName: "Ned", rewarded: true }, { firstName: "Wendy", rewarded: false }]);
  });

  it("an owed reward is marked paid by somebody who may give money back, and not by anybody else", async () => {
    const [reward] = await raw<{ id: string }[]>`select id from public.referral_reward where organization_id = ${ORG}`;
    await expect(referrals.settleReward(owner(["csr"]), { id: reward!.id, action: "void" })).rejects.toThrow();
    await expect(referrals.settleReward(owner(), { id: reward!.id, action: "paid" })).rejects.toThrow(/nothing to pay/);
  });
});
