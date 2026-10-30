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
 * A SECOND REMINDER, AND THE FOLLOW UP BY EMAIL ON A TEXT NOBODY ANSWERED
 *
 * Beside the one reminder, a company may turn on a second, some days after the
 * first went, and, when it asks by text and then email, the ask again by email
 * some days after a text that got no answer. Both are off until the company
 * says how many days, both go through the consent gate and the sending hours,
 * both are skipped for anybody a review is tied to (or suspected to be from)
 * since the ask, and each goes once.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("review-follow-ups:org");
const USER = fixtureId("review-follow-ups:user");
const REVIEW_URL = "https://g.page/r/follow-up-heating/review";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
let seq = 0;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Follow Up Heating", slug: "follow-up-heating" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559955', 'main', true)`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
            values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@followupheating.test","fromName":"Follow Up Heating"}'::jsonb)`;
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
  await reviews.setReminders(owner(), { afterDays: null, followUpAfterDays: null });
});

interface Finished { customerId: string; jobId: string; invoiceId: string | null; visitId: string }

/** A customer with a finished job, optionally invoiced and optionally paid in full. */
async function aFinishedJob(input: { name: string; phone: string | null; email: string | null; invoice?: "none" | "unpaid" | "paid" }): Promise<Finished> {
  seq += 1;
  const customer = await customers.create(owner(), {
    type: "residential", name: input.name, ...(input.phone ? { phone: input.phone } : {}),
    ...(input.email ? { email: input.email } : {}),
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: `${seq} Remind Ln`, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
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
  let invoiceId: string | null = null;
  if ((input.invoice ?? "paid") !== "none") {
    const invoice = await billing.create(owner(), {
      customerId: customer.id, jobId: job.id,
      lines: [{ name: "Annual service", quantity: "1", unitPrice: "189.00", discountAmount: "0", taxable: false }],
    });
    invoiceId = invoice.id;
    if ((input.invoice ?? "paid") === "paid") {
      await billing.pay(owner(), {
        customerId: customer.id, method: "check", amount: invoice.total, tipAmount: "0",
        allocations: [{ invoiceId: invoice.id, amount: invoice.total }],
      });
    }
  }
  return { customerId: customer.id, jobId: job.id, invoiceId, visitId: visit.id };
}

const tomorrowAfternoon = () => { const d = new Date(Date.now() + 86_400_000); d.setUTCHours(20, 0, 0, 0); return d; };
/** Six days on, mid afternoon in Austin. */
const sixDaysOn = () => { const d = new Date(Date.now() + 6 * 86_400_000); d.setUTCHours(20, 0, 0, 0); return d; };

const outbound = () => raw<{ body: string; channel: string; subject: string | null }[]>`
  select body, channel, subject from public.message where organization_id = ${ORG} and direction = 'outbound' order by created_at`;
const requestOf = async (jobId: string) => {
  const [row] = await raw<{
    state: string; sent_at: Date | null; reminder_at: Date | null; reminder_message_id: string | null; reminder_detail: string | null;
    follow_up_at: Date | null; follow_up_message_id: string | null; follow_up_detail: string | null;
    second_reminder_at: Date | null; second_reminder_message_id: string | null; second_reminder_detail: string | null;
  }[]>`
    select state, sent_at, reminder_at, reminder_message_id, reminder_detail, follow_up_at, follow_up_message_id, follow_up_detail,
           second_reminder_at, second_reminder_message_id, second_reminder_detail
      from public.review_request where job_id = ${jobId}`;
  return row!;
};

/** Ask by hand and let the worker send it, leaving a sent ask to be reminded about. */
async function askedAndSent(who: Parameters<typeof aFinishedJob>[0]): Promise<Finished> {
  const job = await aFinishedJob(who);
  await reviews.requestFor(owner(), { jobId: job.jobId, platform: "google" });
  await reviewAsks.askPass(db(), { now: tomorrowAfternoon() });
  expect((await requestOf(job.jobId)).state).toBe("sent");
  return job;
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const askedBy = (channel: "sms" | "email" | "sms_then_email") =>
  workflows.installTemplate(owner(), { key: "review_after_paid", values: { hours: 2, platform: "google", channel } });

run("the second reminder", () => {
  it("is off until the company turns it on, needs the first, and goes off with the first", async () => {
    expect((await reviews.reminders(owner())).secondAfterDays).toBeNull();
    await expect(reviews.setReminders(owner(), { secondAfterDays: 7 })).rejects.toThrow("Turn the first reminder on");
    await expect(reviews.setReminders(owner(), { afterDays: 5, secondAfterDays: 2 })).rejects.toBeInstanceOf(ConflictError);
    expect((await reviews.setReminders(owner(), { afterDays: 5, secondAfterDays: 7 })).secondAfterDays).toBe(7);
    expect((await reviews.setReminders(owner(), { afterDays: null })).secondAfterDays).toBeNull();
    await expect(reviews.setReminders({ ...owner(), actor: { ...owner().actor, roles: ["csr"] } }, { afterDays: 5, secondAfterDays: 7 }))
      .rejects.toMatchObject({ name: "PermissionError" });
  });

  it("goes once, the days after the first reminder went, in words that say it is the last", async () => {
    await askedBy("email");
    const job = await askedAndSent({ name: "Sam Second", phone: "+15125550301", email: "sam@example.test" });
    await reviews.setReminders(owner(), { afterDays: 5, secondAfterDays: 7 });
    await raw`update public.review_request set sent_at = ${daysAgo(6)} where job_id = ${job.jobId}`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    let sent = await outbound();
    expect(sent).toHaveLength(2);
    /** With a second on, the first no longer says it is the only one. */
    expect(sent[1]!.body).toContain("a short reminder");
    expect(sent[1]!.body).not.toContain("only reminder");

    /** Not yet: the first reminder went just now. */
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(await outbound()).toHaveLength(2);

    await raw`update public.review_request set reminder_at = ${daysAgo(8)} where job_id = ${job.jobId}`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    sent = await outbound();
    expect(sent).toHaveLength(3);
    expect(sent[2]!.channel).toBe("email");
    expect(sent[2]!.subject).toBe("One last note, Sam");
    expect(sent[2]!.body).toContain("This is the last reminder we will send.");
    expect(sent[2]!.body).toContain(REVIEW_URL);
    expect((await requestOf(job.jobId)).second_reminder_message_id).not.toBeNull();

    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(await outbound()).toHaveLength(3);
    expect((await reviews.reminders(owner())).later).toEqual([
      expect.objectContaining({ kind: "second_reminder", customerName: "Sam Second", sent: true, detail: null }),
    ]);
  });

  it("is not sent once a review that is theirs came in after the ask, and says why", async () => {
    const job = await askedAndSent({ name: "Rae Reviewed", phone: "+15125550302", email: "rae@example.test" });
    await reviews.setReminders(owner(), { afterDays: 5, secondAfterDays: 7 });
    await raw`update public.review_request set sent_at = ${daysAgo(20)}, reminder_at = ${daysAgo(10)},
              reminder_message_id = ${crypto.randomUUID()} where job_id = ${job.jobId}`;
    await raw`insert into public.review (organization_id, platform, rating, posted_at, customer_id)
              values (${ORG}, 'google', 4, ${daysAgo(2)}, ${job.customerId})`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(await outbound()).toHaveLength(1);
    const request = await requestOf(job.jobId);
    expect(request.second_reminder_message_id).toBeNull();
    expect(request.second_reminder_detail).toMatch(/^Not sent: A review has come in since the ask/);
  });

  it("is not sent when the first reminder never went", async () => {
    const job = await askedAndSent({ name: "Nev Never", phone: "+15125550303", email: "nev@example.test" });
    await reviews.setReminders(owner(), { afterDays: 5, secondAfterDays: 7 });
    await raw`update public.review_request set sent_at = ${daysAgo(20)}, reminder_at = ${daysAgo(10)},
              reminder_detail = 'Not sent: replied STOP' where job_id = ${job.jobId}`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(await outbound()).toHaveLength(1);
    expect((await requestOf(job.jobId)).second_reminder_at).toBeNull();
  });
});

run("the follow up by email", () => {
  it("is off until the company turns it on, and the days are held to the reminder's", async () => {
    expect((await reviews.reminders(owner())).followUpAfterDays).toBeNull();
    await expect(reviews.setReminders(owner(), { followUpAfterDays: 1 })).rejects.toThrow(/between 3 and 60 whole days/);
    expect((await reviews.setReminders(owner(), { followUpAfterDays: 4 })).followUpAfterDays).toBe(4);
  });

  it("sends the ask again by email the days after a text nobody answered, once, for a company asking by text then email", async () => {
    await askedBy("sms_then_email");
    const job = await askedAndSent({ name: "Tess Texted", phone: "+15125550304", email: "tess@example.test" });
    expect((await outbound()).map((m) => m.channel)).toEqual(["sms"]);
    await reviews.setReminders(owner(), { followUpAfterDays: 4 });
    expect((await reviews.reminders(owner())).followUpApplies).toBe(true);
    await raw`update public.review_request set sent_at = ${daysAgo(5)} where job_id = ${job.jobId}`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    const sent = await outbound();
    expect(sent.map((m) => m.channel)).toEqual(["sms", "email"]);
    expect(sent[1]!.subject).toBe("How did we do, Tess?");
    expect(sent[1]!.body).toContain(REVIEW_URL);
    expect((await requestOf(job.jobId)).follow_up_message_id).not.toBeNull();
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(await outbound()).toHaveLength(2);
  });

  it("comes before the reminder, which then counts its days from the follow up", async () => {
    await askedBy("sms_then_email");
    const job = await askedAndSent({ name: "Fay Firstly", phone: "+15125550305", email: "fay@example.test" });
    await reviews.setReminders(owner(), { followUpAfterDays: 4, afterDays: 3 });
    await raw`update public.review_request set sent_at = ${daysAgo(5)} where job_id = ${job.jobId}`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    /** The follow up went; the reminder, due by the ask's date, waits for its days after the follow up. */
    expect((await outbound()).map((m) => m.channel)).toEqual(["sms", "email"]);
    expect((await requestOf(job.jobId)).reminder_at).toBeNull();
    await raw`update public.review_request set follow_up_at = ${daysAgo(4)} where job_id = ${job.jobId}`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect((await outbound()).map((m) => m.channel)).toEqual(["sms", "email", "sms"]);
  });

  it("is not sent for an ask that already went by email, nor for a company that asks by text alone", async () => {
    await askedBy("sms_then_email");
    const mailed = await askedAndSent({ name: "Mo Mailonly", phone: null, email: "mo@example.test" });
    await reviews.setReminders(owner(), { followUpAfterDays: 4 });
    await raw`update public.review_request set sent_at = ${daysAgo(5)} where job_id = ${mailed.jobId}`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect((await outbound()).map((m) => m.channel)).toEqual(["email"]);
    expect((await requestOf(mailed.jobId)).follow_up_at).toBeNull();

    await raw`delete from public.workflow_version where organization_id = ${ORG}`;
    await raw`delete from public.workflow where organization_id = ${ORG}`;
    await askedBy("sms");
    expect((await reviews.reminders(owner())).followUpApplies).toBe(false);
    const texted = await askedAndSent({ name: "Ty Textonly", phone: "+15125550306", email: "ty@example.test" });
    await raw`update public.review_request set sent_at = ${daysAgo(5)} where job_id = ${texted.jobId}`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect((await requestOf(texted.jobId)).follow_up_at).toBeNull();
  });

  it("is not sent to somebody who has asked not to be, and says why", async () => {
    await askedBy("sms_then_email");
    const job = await askedAndSent({ name: "Oz Optout", phone: "+15125550307", email: "oz@example.test" });
    await reviews.setReminders(owner(), { followUpAfterDays: 4 });
    await raw`update public.review_request set sent_at = ${daysAgo(5)} where job_id = ${job.jobId}`;
    await raw`update public.customer set do_not_service = true where id = ${job.customerId}`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(await outbound()).toHaveLength(1);
    expect((await requestOf(job.jobId)).follow_up_detail).toMatch(/^Not sent: This customer has asked not to be sent/);
  });
});
