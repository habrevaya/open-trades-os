import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as creditNotes from "../src/services/credit-notes";
import * as reviews from "../src/services/reviews";
import * as workflows from "../src/services/workflows";
import * as reviewAsks from "../src/services/review-asks";
import { handleEvent, resume } from "../src/services/workflow-runner";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE ONE REMINDER, AND ASKING ABOUT JOBS THAT NEVER GET A PAYMENT
 *
 * A company may follow up once on an ask nobody answered: off until it says
 * how many days, sent once through the same consent gate as the ask, skipped
 * for anybody a review is tied to (or suspected to be from) whatever it says.
 * And the review automation can be turned on for every finished job that owes
 * nothing, which includes a job a credit note settled and one never invoiced.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("review-reminders:org");
const USER = fixtureId("review-reminders:user");
const REVIEW_URL = "https://g.page/r/remind-heating/review";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
let seq = 0;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Remind Heating", slug: "remind-heating" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559944', 'main', true)`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
            values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@remindheating.test","fromName":"Remind Heating"}'::jsonb)`;
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
  await reviews.setReminders(owner(), { afterDays: null });
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
const sixDaysOnNight = () => { const d = new Date(Date.now() + 7 * 86_400_000); d.setUTCHours(3, 30, 0, 0); return d; };

const outbound = () => raw<{ body: string; channel: string; subject: string | null }[]>`
  select body, channel, subject from public.message where organization_id = ${ORG} and direction = 'outbound' order by created_at`;
const requestOf = async (jobId: string) => {
  const [row] = await raw<{ state: string; sent_at: Date | null; reminder_at: Date | null; reminder_message_id: string | null; reminder_detail: string | null }[]>`
    select state, sent_at, reminder_at, reminder_message_id, reminder_detail from public.review_request where job_id = ${jobId}`;
  return row!;
};
const latestEvent = async (name: string) => {
  const [row] = await raw<{ id: string }[]>`select id from public.domain_event where organization_id = ${ORG} and name = ${name} order by sequence desc limit 1`;
  return row!.id;
};

/** Ask by hand and let the worker send it, leaving a sent ask to be reminded about. */
async function askedAndSent(who: Parameters<typeof aFinishedJob>[0]): Promise<Finished> {
  const job = await aFinishedJob(who);
  await reviews.requestFor(owner(), { jobId: job.jobId, platform: "google" });
  await reviewAsks.askPass(db(), { now: tomorrowAfternoon() });
  expect((await requestOf(job.jobId)).state).toBe("sent");
  return job;
}

run("the one reminder", () => {
  it("is off until the company says how many days, and the ask goes as it always did", async () => {
    const job = await askedAndSent({ name: "Off Owens", phone: "+15125550201", email: "off@example.test" });
    expect((await reviews.reminders(owner())).afterDays).toBeNull();
    const results = await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(results.find((r) => r.organizationId === ORG)).toBeUndefined();
    expect(await outbound()).toHaveLength(1);
    expect((await requestOf(job.jobId)).reminder_at).toBeNull();
  });

  it("refuses a gap that is a nag or too long to mean anything, and needs the settings permission", async () => {
    await expect(reviews.setReminders(owner(), { afterDays: 2 })).rejects.toBeInstanceOf(ConflictError);
    await expect(reviews.setReminders(owner(), { afterDays: 61 })).rejects.toThrow(/between 3 and 60 whole days/);
    await expect(reviews.setReminders({ ...owner(), actor: { ...owner().actor, roles: ["csr"] } }, { afterDays: 5 }))
      .rejects.toMatchObject({ name: "PermissionError" });
  });

  it("sends one reminder after the days, by the way the company asks, in its own words, and never a second", async () => {
    const job = await askedAndSent({ name: "Rita Remind", phone: "+15125550202", email: "rita@example.test" });
    await reviews.setReminders(owner(), { afterDays: 5 });
    await raw`update public.review_request set sent_at = ${new Date(Date.now() - 6 * 86_400_000)} where job_id = ${job.jobId}`;

    const results = await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(results.find((r) => r.organizationId === ORG)).toMatchObject({ reminded: 1 });
    const sent = await outbound();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.channel).toBe("sms");
    expect(sent[1]!.body).toContain("a quick reminder");
    expect(sent[1]!.body).toContain(REVIEW_URL);
    expect(sent[1]!.body).toContain("Hi Rita,");
    const request = await requestOf(job.jobId);
    expect(request.reminder_at).not.toBeNull();
    expect(request.reminder_message_id).not.toBeNull();

    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(await outbound()).toHaveLength(2);

    const view = await reviews.reminders(owner());
    expect(view.afterDays).toBe(5);
    expect(view.recent).toEqual([expect.objectContaining({ requestId: expect.any(String), jobNumber: expect.any(Number), customerName: "Rita Remind", sent: true, detail: null })]);
  });

  it("goes by email when that is how the company asks", async () => {
    await workflows.installTemplate(owner(), { key: "review_after_paid", values: { hours: 2, platform: "google", channel: "email" } });
    const job = await askedAndSent({ name: "Ed Mailer", phone: "+15125550203", email: "ed@example.test" });
    await reviews.setReminders(owner(), { afterDays: 4 });
    await raw`update public.review_request set sent_at = ${new Date(Date.now() - 5 * 86_400_000)} where job_id = ${job.jobId}`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    const sent = await outbound();
    expect(sent.map((m) => m.channel)).toEqual(["email", "email"]);
    expect(sent[1]!.subject).toBe("A quick reminder, Ed");
    expect(sent[1]!.body).toContain("only reminder we will send");
  });

  it("leaves it too soon alone, and a request an automation queued gets its reminder too", async () => {
    const job = await askedAndSent({ name: "Soon Sanchez", phone: "+15125550204", email: "soon@example.test" });
    await reviews.setReminders(owner(), { afterDays: 5 });
    await raw`update public.review_request set source = 'automation' where job_id = ${job.jobId}`;
    const early = await reviewAsks.askPass(db(), { now: tomorrowAfternoon() });
    expect(early.find((r) => r.organizationId === ORG)).toBeUndefined();
    await raw`update public.review_request set sent_at = ${new Date(Date.now() - 6 * 86_400_000)} where job_id = ${job.jobId}`;
    expect((await reviewAsks.askPass(db(), { now: sixDaysOn() })).find((r) => r.organizationId === ORG)).toMatchObject({ reminded: 1 });
  });

  it("is not sent to a customer a review is tied to since the ask, whatever it says, and says why", async () => {
    const job = await askedAndSent({ name: "Done Dawson", phone: "+15125550205", email: "done@example.test" });
    await reviews.setReminders(owner(), { afterDays: 5 });
    await raw`update public.review_request set sent_at = ${new Date(Date.now() - 6 * 86_400_000)} where job_id = ${job.jobId}`;
    await raw`insert into public.review (organization_id, platform, rating, posted_at, customer_id)
              values (${ORG}, 'google', 1, ${new Date(Date.now() - 2 * 86_400_000)}, ${job.customerId})`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(await outbound()).toHaveLength(1);
    const request = await requestOf(job.jobId);
    expect(request.reminder_message_id).toBeNull();
    expect(request.reminder_detail).toMatch(/^Not sent: A review has come in since the ask/);
    expect(request.reminder_at).not.toBeNull();
    /** Settled for good: the next pass does not look again. */
    expect((await reviewAsks.askPass(db(), { now: sixDaysOn() })).find((r) => r.organizationId === ORG)).toBeUndefined();
  });

  it("is not sent when a review that may be theirs came in, and is when the suggestion was dismissed", async () => {
    const maybe = await askedAndSent({ name: "Maybe Mills", phone: "+15125550206", email: "maybe@example.test" });
    const dismissed = await askedAndSent({ name: "Dismissed Dunn", phone: "+15125550207", email: "dunn@example.test" });
    await reviews.setReminders(owner(), { afterDays: 5 });
    await raw`update public.review_request set sent_at = ${new Date(Date.now() - 6 * 86_400_000)} where organization_id = ${ORG}`;
    await raw`insert into public.review (organization_id, platform, rating, posted_at, suggested_customer_id)
              values (${ORG}, 'google', 5, ${new Date(Date.now() - 2 * 86_400_000)}, ${maybe.customerId})`;
    await raw`insert into public.review (organization_id, platform, rating, posted_at, suggested_customer_id, suggestion_dismissed_at)
              values (${ORG}, 'google', 5, ${new Date(Date.now() - 2 * 86_400_000)}, ${dismissed.customerId}, now())`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect((await requestOf(maybe.jobId)).reminder_message_id).toBeNull();
    expect((await requestOf(maybe.jobId)).reminder_detail).toMatch(/^Not sent/);
    expect((await requestOf(dismissed.jobId)).reminder_message_id).not.toBeNull();
  });

  it("is not sent to a review from before the ask", async () => {
    const job = await askedAndSent({ name: "Before Bell", phone: "+15125550208", email: "bell@example.test" });
    await reviews.setReminders(owner(), { afterDays: 5 });
    await raw`update public.review_request set sent_at = ${new Date(Date.now() - 6 * 86_400_000)} where job_id = ${job.jobId}`;
    await raw`insert into public.review (organization_id, platform, rating, posted_at, customer_id)
              values (${ORG}, 'google', 5, ${new Date(Date.now() - 40 * 86_400_000)}, ${job.customerId})`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect((await requestOf(job.jobId)).reminder_message_id).not.toBeNull();
  });

  it("is not sent to somebody who has asked not to be, and waits out an open complaint", async () => {
    const out = await askedAndSent({ name: "Out Olsen", phone: "+15125550209", email: "out@example.test" });
    const upset = await askedAndSent({ name: "Upset Ung", phone: "+15125550210", email: "ung@example.test" });
    await reviews.setReminders(owner(), { afterDays: 5 });
    await raw`update public.review_request set sent_at = ${new Date(Date.now() - 6 * 86_400_000)} where organization_id = ${ORG}`;
    await raw`update public.customer set do_not_service = true where id = ${out.customerId}`;
    await raw`insert into public.obligation (organization_id, kind, entity_type, entity_id, due_at, state, consequence)
              values (${ORG}, 'contract.respond_by', 'job', ${upset.jobId}, now(), 'open', 'Ring them')`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect((await requestOf(out.jobId)).reminder_detail).toMatch(/^Not sent: This customer has asked not to be sent/);
    const held = await requestOf(upset.jobId);
    expect(held.reminder_at).toBeNull();
    expect(held.reminder_message_id).toBeNull();
    expect(await outbound()).toHaveLength(2);
  });

  it("waits for the morning rather than texting at night", async () => {
    const job = await askedAndSent({ name: "Night Nash", phone: "+15125550211", email: "nash@example.test" });
    await reviews.setReminders(owner(), { afterDays: 5 });
    await raw`update public.review_request set sent_at = ${new Date(Date.now() - 8 * 86_400_000)} where job_id = ${job.jobId}`;
    await reviewAsks.askPass(db(), { now: sixDaysOnNight() });
    expect(await outbound()).toHaveLength(1);
    expect((await requestOf(job.jobId)).reminder_at).toBeNull();
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(await outbound()).toHaveLength(2);
  });

  it("is final when the consent gate refuses it: one reminder, ever", async () => {
    const job = await askedAndSent({ name: "Stop Sorensen", phone: "+15125550212", email: null });
    await reviews.setReminders(owner(), { afterDays: 5 });
    await raw`update public.review_request set sent_at = ${new Date(Date.now() - 6 * 86_400_000)} where job_id = ${job.jobId}`;
    await raw`insert into public.suppression (organization_id, address, channel, purpose, reason)
              values (${ORG}, '+15125550212', 'sms', null, 'stop_keyword')`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    const request = await requestOf(job.jobId);
    expect(request.reminder_at).not.toBeNull();
    expect(request.reminder_message_id).toBeNull();
    expect(request.reminder_detail).toMatch(/^Not sent: text:/);
    await raw`delete from public.suppression where organization_id = ${ORG}`;
    await reviewAsks.askPass(db(), { now: sixDaysOn() });
    expect(await outbound()).toHaveLength(1);
    expect((await reviews.reminders(owner())).recent[0]).toMatchObject({ sent: false });
  });

  it("is kept when the service standard is saved again without it", async () => {
    await reviews.setReminders(owner(), { afterDays: 7 });
    await reviews.setPolicy(owner(), {
      timeZone: "America/Chicago", delayMinutes: 120, customerCooldownDays: 90,
      requirePaid: true, maxJobAgeDays: 14, earliestHour: 9, latestHour: 19,
    });
    expect((await reviews.reminders(owner())).afterDays).toBe(7);
    await reviews.setPolicy(owner(), {
      timeZone: "America/Chicago", delayMinutes: 120, customerCooldownDays: 90,
      requirePaid: true, maxJobAgeDays: 14, earliestHour: 9, latestHour: 19, reminderAfterDays: null,
    });
    expect((await reviews.reminders(owner())).afterDays).toBeNull();
  });
});

run("asking about every finished job that owes nothing", () => {
  const install = (jobs: string | undefined) => workflows.installTemplate(owner(), {
    key: "review_after_paid", values: { hours: 2, platform: "google", ...(jobs ? { jobs } : {}) },
  });
  const triggersOf = async () => (await raw<{ trigger_events: string[] }[]>`
    select trigger_events from public.workflow where organization_id = ${ORG} and deleted_at is null`)[0]!.trigger_events;

  it("listens for a paid invoice only, unless told otherwise", async () => {
    await install(undefined);
    expect(await triggersOf()).toEqual(["invoice.paid"]);
  });

  it("also listens for a credit note settling an invoice and a job being finished, when that is the choice", async () => {
    await install("finished");
    expect((await triggersOf()).sort()).toEqual(["invoice.credited", "invoice.paid", "job.completed"]);
  });

  it("refuses a choice that is neither, and offers the choice with paid jobs the default", async () => {
    await expect(install("everything")).rejects.toThrow(/paid jobs, or every finished job/);
    const listed = (await workflows.recommended(owner())).find((t) => t.key === "review_after_paid")!;
    const choice = listed.parameters.find((p) => p.key === "jobs")!;
    expect(choice.defaultChoice).toBe("paid");
    expect(choice.options!.map((o) => o.value)).toEqual(["paid", "finished"]);
  });

  it("asks about a job that was finished and never invoiced, once the wait is over", async () => {
    await install("finished");
    const job = await aFinishedJob({ name: "Nina Nobill", phone: "+15125550221", email: "nobill@example.test", invoice: "none" });
    const [summary] = await handleEvent(owner(), await latestEvent("job.completed"));
    expect(summary!.status).toBe("waiting");
    const done = await inTenant(owner(), (tx) => resume(tx, owner(), { runId: summary!.runId!, now: tomorrowAfternoon() }));
    expect(done.status).toBe("succeeded");
    expect((await outbound()).map((m) => m.channel)).toEqual(["sms"]);
    expect((await requestOf(job.jobId)).state).toBe("sent");
  });

  it("does not ask about the same job twice when it is paid as well as finished", async () => {
    await install("finished");
    const job = await aFinishedJob({ name: "Twice Tran", phone: "+15125550222", email: "tran@example.test", invoice: "paid" });
    const first = await handleEvent(owner(), await latestEvent("job.completed"));
    const second = await handleEvent(owner(), await latestEvent("invoice.paid"));
    for (const [summary] of [first, second]) {
      await inTenant(owner(), (tx) => resume(tx, owner(), { runId: summary!.runId!, now: tomorrowAfternoon() }));
    }
    expect(await outbound()).toHaveLength(1);
    expect((await requestOf(job.jobId)).state).toBe("sent");
  });

  it("holds a finished job whose invoice is not paid, as it always does", async () => {
    await install("finished");
    const job = await aFinishedJob({ name: "Owe Ortiz", phone: "+15125550223", email: "owe@example.test", invoice: "unpaid" });
    const [summary] = await handleEvent(owner(), await latestEvent("job.completed"));
    await inTenant(owner(), (tx) => resume(tx, owner(), { runId: summary!.runId!, now: tomorrowAfternoon() }));
    expect(await outbound()).toHaveLength(0);
    const [request] = await raw<{ state: string; withheld_reason: string }[]>`select state, withheld_reason from public.review_request where job_id = ${job.jobId}`;
    expect(request).toMatchObject({ state: "withheld", withheld_reason: "job_not_paid" });
  });

  it("asks about a job a credit note settled, when the credit is applied", async () => {
    await install("finished");
    const job = await aFinishedJob({ name: "Cred Cole", phone: "+15125550224", email: "cole@example.test", invoice: "unpaid" });
    const invoice = await billing.get(owner(), { id: job.invoiceId! });
    await creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "billing_error", draft: false, apply: true,
      lines: [{ invoiceLineId: invoice.lines[0]!.id, quantity: "1", unitPrice: "189.00" }],
    });
    const [summary] = await handleEvent(owner(), await latestEvent("invoice.credited"));
    expect(summary!.status).toBe("waiting");
    await inTenant(owner(), (tx) => resume(tx, owner(), { runId: summary!.runId!, now: tomorrowAfternoon() }));
    expect((await outbound()).map((m) => m.channel)).toEqual(["sms"]);
    expect((await requestOf(job.jobId)).state).toBe("sent");
  });

  it("leaves a never invoiced job unasked when only paid jobs were chosen", async () => {
    await install("paid");
    const job = await aFinishedJob({ name: "Paid Only", phone: "+15125550225", email: "paidonly@example.test", invoice: "none" });
    const asked = await inTenant(owner(), (tx) => reviews.requestWithin(tx, ORG, { jobId: job.jobId, platform: "google" }));
    expect(asked).toMatchObject({ asked: false, withheld: "job_not_paid" });
  });
});

run("the reminder in the company's own words", () => {
  const own = {
    sms: "Hello {{ customer.name }}, {{ organization.name }} again. One last nudge, if you have a minute: {{ review.url }}",
    emailSubject: "One last note from {{ organization.name }}",
    emailBody: "Hello {{ customer.name }},\n\nOne last note. If you have a minute: {{ review.url }}\n\n{{ organization.name }}",
  };

  it("sends the reminder in the words the company wrote, and keeps the days when only the words change", async () => {
    try {
      await reviews.setReminders(owner(), { afterDays: 5 });
      const saved = await reviews.setReminders(owner(), { wording: own });
      expect(saved.afterDays).toBe(5);
      expect(saved.wording).toEqual({ ...own, custom: true });

      const job = await askedAndSent({ name: "Wanda Words", phone: "+15125550231", email: "wanda@example.test" });
      await raw`update public.review_request set sent_at = ${new Date(Date.now() - 6 * 86_400_000)} where job_id = ${job.jobId}`;
      await reviewAsks.askPass(db(), { now: sixDaysOn() });
      const sent = await outbound();
      expect(sent).toHaveLength(2);
      expect(sent[1]!.body).toBe(`Hello Wanda, Remind Heating again. One last nudge, if you have a minute: ${REVIEW_URL}`);
    } finally {
      await reviews.setReminders(owner(), { wording: null });
    }
  });

  it("refuses words with a placeholder it cannot fill, no link, or something offered, and changes nothing", async () => {
    await expect(reviews.setReminders(owner(), { wording: { ...own, sms: "Hi {{ customer.first }}: {{ review.url }}" } }))
      .rejects.toThrow("The text uses {{ customer.first }}, which is not something we can fill in.");
    await expect(reviews.setReminders(owner(), { wording: { ...own, emailBody: "Please review us." } }))
      .rejects.toThrow("The email has no {{ review.url }}");
    await expect(reviews.setReminders(owner(), { wording: { ...own, sms: "10% off for a review: {{ review.url }}" } }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(reviews.setReminders({ ...owner(), actor: { ...owner().actor, roles: ["csr"] } }, { wording: own }))
      .rejects.toMatchObject({ name: "PermissionError" });
    expect((await reviews.reminders(owner())).wording.custom).toBe(false);
  });

  it("goes back to the words we ship, and treats them typed back in as ours", async () => {
    const { automation } = await import("@opentradesos/core");
    await reviews.setReminders(owner(), { wording: own });
    const back = await reviews.setReminders(owner(), { wording: null });
    expect(back.wording).toEqual({ ...automation.REVIEW_REMINDER_WORDING, custom: false });
    const typed = await reviews.setReminders(owner(), { wording: { ...automation.REVIEW_REMINDER_WORDING } });
    expect(typed.wording.custom).toBe(false);
    const [row] = await raw<{ reminder_sms: string | null }[]>`
      select reminder_sms from public.review_policy where organization_id = ${ORG} and active`;
    expect(row!.reminder_sms).toBeNull();
  });
});
