import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as reviews from "../src/services/reviews";
import * as workflows from "../src/services/workflows";
import * as reviewAsks from "../src/services/review-asks";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE SECOND REVIEW REMINDER, IN THE COMPANY'S OWN WORDS
 *
 * The first reminder's words were always the company's to change; the second
 * went in the words we ship. It now has words of its own on the same screen,
 * checked by the same rules (only the three placeholders, the link in the text and
 * the email, nothing offered for a review, no stars asked for), kept apart from
 * the first's, put back with one press, and sent by the worker as written.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("review-second-words:org");
const USER = fixtureId("review-second-words:user");
const REVIEW_URL = "https://g.page/r/second-words-heating/review";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
let seq = 0;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Second Words Heating", slug: "second-words-heating" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559966', 'main', true)`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
            values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@secondwords.test","fromName":"Second Words Heating"}'::jsonb)`;
  await reviews.setPolicy(owner(), {
    timeZone: "America/Chicago", delayMinutes: 120, customerCooldownDays: 90,
    requirePaid: true, maxJobAgeDays: 14, earliestHour: 9, latestHour: 19,
  });
  await reviews.setPlatform(owner(), {
    platform: "google", displayName: "Google", reviewUrl: REVIEW_URL,
    prohibits: ["incentives", "bulk_requests", "templated_replies"], note: "Checked their policy.",
  });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  for (const table of ["workflow_step_run", "workflow_run", "workflow_version", "workflow", "message", "conversation", "suppression", "review_request", "review", "integration_event"]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
  await reviews.setReminders(owner(), { afterDays: null, secondWording: null });
});

const OWN = {
  sms: "Hi {{ customer.name }}, it is {{ organization.name }} again. Your review would mean a lot: {{ review.url }}",
  emailSubject: "Last call, {{ customer.name }}",
  emailBody: "Hi {{ customer.name }},\n\nA last, short note from {{ organization.name }}. If you can, tell us how we did:\n\n{{ review.url }}\n\nThank you.",
};

run("the second reminder's words", () => {
  it("starts as the words we ship, and the shipped words saved back stay ours, whatever the line ends", async () => {
    const shown = await reviews.reminders(owner());
    expect(shown.secondWording.custom).toBe(false);
    expect(shown.secondWording.emailBody).toContain("This is the last reminder we will send.");
    const { custom: _custom, ...words } = shown.secondWording;
    expect((await reviews.setReminders(owner(), { secondWording: words })).secondWording.custom).toBe(false);
    const posted = { ...words, emailBody: words.emailBody.replace(/\n/g, "\r\n") };
    expect((await reviews.setReminders(owner(), { secondWording: posted })).secondWording.custom).toBe(false);
  });

  it("keeps the company's own words apart from the first reminder's, and puts ours back on null", async () => {
    const saved = await reviews.setReminders(owner(), { afterDays: 5, secondAfterDays: 7, secondWording: OWN });
    expect(saved.secondWording).toMatchObject({ ...OWN, custom: true });
    expect(saved.wording.custom).toBe(false);
    const [row] = await raw`select second_reminder_sms, reminder_sms from public.review_policy where organization_id = ${ORG}`;
    expect(row!.second_reminder_sms).toBe(OWN.sms);
    expect(row!.reminder_sms).toBeNull();

    /** Changing the days or the first's words leaves them alone. */
    const days = await reviews.setReminders(owner(), { secondAfterDays: 9 });
    expect(days.secondWording.custom).toBe(true);
    const first = await reviews.setReminders(owner(), { wording: { ...OWN, emailBody: OWN.emailBody.replace("last, short", "short") } });
    expect(first.wording.custom).toBe(true);
    expect(first.secondWording.emailBody).toBe(OWN.emailBody);

    const back = await reviews.setReminders(owner(), { secondWording: null });
    expect(back.secondWording.custom).toBe(false);
    expect(back.wording.custom).toBe(true);
    const [audit] = await raw`select after from public.audit_log
      where organization_id = ${ORG} and action = 'review_policy.reminders_set' order by created_at desc limit 1`;
    expect(audit!.after).toMatchObject({ secondReminderSms: null });
  });

  it("holds the words to the rules of the first, naming the second reminder, and keeps what was there", async () => {
    await reviews.setReminders(owner(), { secondWording: OWN });
    const refusals: [Partial<typeof OWN>, RegExp][] = [
      [{ sms: "Hi, please review us." }, /The second reminder: The text has no \{\{ review.url \}\}/],
      [{ emailBody: "Hi {{ customer.nickname }}, {{ review.url }}" }, /The second reminder: The email uses \{\{ customer.nickname \}\}/],
      [{ emailBody: `${OWN.emailBody}\n\nGet a $10 coupon for it.` }, /The second reminder: The email offers something for a review/],
      [{ sms: `${OWN.sms} Five stars please.` }, /The second reminder: The text asks for a number of stars/],
      [{ emailSubject: "" }, /The second reminder: The email's subject is empty/],
    ];
    for (const [change, message] of refusals) {
      await expect(reviews.setReminders(owner(), { secondWording: { ...OWN, ...change } })).rejects.toThrow(message);
      await expect(reviews.setReminders(owner(), { secondWording: { ...OWN, ...change } })).rejects.toBeInstanceOf(ConflictError);
    }
    expect((await reviews.reminders(owner())).secondWording).toMatchObject({ ...OWN, custom: true });
  });

  it("needs the permission to change settings", async () => {
    await expect(reviews.setReminders({ ...owner(), actor: { ...owner().actor, roles: ["csr"] } }, { secondWording: OWN }))
      .rejects.toMatchObject({ name: "PermissionError" });
  });

  it("is what the worker sends, with the customer's first name and the review link filled in", async () => {
    seq += 1;
    await workflows.installTemplate(owner(), { key: "review_after_paid", values: { hours: 2, platform: "google", channel: "email" } });
    const customer = await customers.create(owner(), {
      type: "residential", name: "Pat Personal", phone: "+15125550401", email: "pat@example.test",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    const property = await properties.create(owner(), {
      address: { line1: `${seq} Words Ln`, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
    });
    const job = await jobs.create(owner(), {
      customerId: customer.id, propertyId: property.id, summary: "Annual service", tags: [], customFields: {},
    });
    const visit = await jobs.addVisit(owner(), {
      id: job.id,
      windowStart: new Date(Date.now() - 5 * 3600_000).toISOString(),
      windowEnd: new Date(Date.now() - 4 * 3600_000).toISOString(),
      estimatedDurationMinutes: 60, technicianIds: [],
    });
    await jobs.complete(owner(), { id: visit.id });
    await raw`update public.visit set completed_at = ${new Date(Date.now() - 4 * 3600_000)} where id = ${visit.id}`;
    const invoice = await billing.create(owner(), {
      customerId: customer.id, jobId: job.id,
      lines: [{ name: "Annual service", quantity: "1", unitPrice: "189.00", discountAmount: "0", taxable: false }],
    });
    await billing.pay(owner(), {
      customerId: customer.id, method: "check", amount: invoice.total, tipAmount: "0",
      allocations: [{ invoiceId: invoice.id, amount: invoice.total }],
    });

    const afternoon = (days: number) => { const d = new Date(Date.now() + days * 86_400_000); d.setUTCHours(20, 0, 0, 0); return d; };
    await reviews.requestFor(owner(), { jobId: job.id, platform: "google" });
    await reviewAsks.askDueFor(db(), ORG, { now: afternoon(1) });
    await reviews.setReminders(owner(), { afterDays: 5, secondAfterDays: 7, secondWording: OWN });
    await raw`update public.review_request set sent_at = ${new Date(Date.now() - 20 * 86_400_000)},
              reminder_at = ${new Date(Date.now() - 10 * 86_400_000)}, reminder_message_id = ${crypto.randomUUID()}
              where job_id = ${job.id}`;
    await reviewAsks.askDueFor(db(), ORG, { now: afternoon(6) });
    const sent = await raw<{ body: string; subject: string | null; channel: string }[]>`
      select body, subject, channel from public.message
      where organization_id = ${ORG} and direction = 'outbound' order by created_at desc limit 1`;
    expect(sent[0]!.subject).toBe("Last call, Pat");
    expect(sent[0]!.body).toContain("A last, short note from Second Words Heating.");
    expect(sent[0]!.body).toContain(REVIEW_URL);
    expect(sent[0]!.body).not.toContain("{{");
  });
});
