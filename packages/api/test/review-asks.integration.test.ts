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
import { runPass } from "../src/services/workflow-worker";
import { handleEvent, resume } from "../src/services/workflow-runner";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE ASK FOR A REVIEW, BY TEXT, BY EMAIL OR BY BOTH, AND THE DUE LIST
 *
 * The recommended automation can ask by text, by email, or by text first and
 * then email (the email only when the text could not go, never as well as it),
 * by a choice made when it is turned on. And a request the office queued for
 * later, whose answer was "not before nine tomorrow", is sent by the worker on
 * its passes through the same send, judged again at the moment it is due.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("review-asks:org");
const USER = fixtureId("review-asks:user");
const REVIEW_URL = "https://g.page/r/ask-heating/review";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let seq = 0;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Ask Heating", slug: "ask-heating" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559922', 'main', true)`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
            values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@askheating.test","fromName":"Ask Heating"}'::jsonb)`;
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
  await raw`delete from public.workflow_step_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_version where organization_id = ${ORG}`;
  await raw`delete from public.workflow where organization_id = ${ORG}`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
  await raw`delete from public.review_request where organization_id = ${ORG}`;
  await raw`delete from public.integration_event where organization_id = ${ORG}`;
});

/** A customer with a finished job whose invoice is paid in full, so the reviews module may ask about it. */
async function aPaidJob(input: { name: string; phone: string | null; email: string | null }) {
  seq += 1;
  const customer = await customers.create(owner(), {
    type: "residential", name: input.name, ...(input.phone ? { phone: input.phone } : {}),
    ...(input.email ? { email: input.email } : {}),
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: `${seq} Ask Ln`, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
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
  return { customerId: customer.id, jobId: job.id };
}

/** Mid afternoon in Austin tomorrow, inside the review rules' hours. */
const tomorrowAfternoon = () => {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCHours(20, 0, 0, 0);
  return d;
};
/** Late evening in Austin tomorrow, after the review rules' last hour. */
const tomorrowNight = () => {
  const d = new Date(Date.now() + 2 * 86_400_000);
  d.setUTCHours(3, 30, 0, 0);
  return d;
};

const latestEvent = async (name: string) => {
  const [row] = await raw<{ id: string }[]>`
    select id from public.domain_event where organization_id = ${ORG} and name = ${name}
    order by sequence desc limit 1`;
  return row!.id;
};

const outbound = () => raw<{ body: string; channel: string; subject: string | null; automation_ref: string | null }[]>`
  select body, channel, subject, automation_ref from public.message
  where organization_id = ${ORG} and direction = 'outbound' order by created_at`;

const requestOf = async (jobId: string) => {
  const [row] = await raw<{ state: string; source: string; send_at: Date | null; message_id: string | null; withheld_reason: string | null; withheld_detail: string | null }[]>`
    select state, source, send_at, message_id, withheld_reason, withheld_detail
    from public.review_request where job_id = ${jobId}`;
  return row!;
};

/** Turn the automation on with a choice, pay a job, and drive the run through its wait to the send. */
async function askedByAutomation(channel: string | undefined, who: { name: string; phone: string | null; email: string | null }) {
  await workflows.installTemplate(owner(), {
    key: "review_after_paid", values: { hours: 2, platform: "google", ...(channel ? { channel } : {}) },
  });
  const job = await aPaidJob(who);
  const [summary] = await handleEvent(owner(), await latestEvent("invoice.paid"));
  expect(summary!.status).toBe("waiting");
  const done = await inTenant(owner(), (tx) => resume(tx, owner(), { runId: summary!.runId!, now: tomorrowAfternoon() }));
  expect(done.status).toBe("succeeded");
  return job;
}

run("asking for a review by text, by email, or by both", () => {
  it("asks by text unless told otherwise, as it always did", async () => {
    const job = await askedByAutomation(undefined, { name: "Tess Quote", phone: "+15125550171", email: "tess@example.test" });
    const sent = await outbound();
    expect(sent.map((m) => m.channel)).toEqual(["sms"]);
    expect(sent[0]!.body).toContain(REVIEW_URL);
    expect((await requestOf(job.jobId)).state).toBe("sent");
  });

  it("asks by email when that is the choice, with a subject, the link, and the customer's name", async () => {
    const job = await askedByAutomation("email", { name: "Eli Mail", phone: "+15125550172", email: "eli@example.test" });
    const sent = await outbound();
    expect(sent.map((m) => m.channel)).toEqual(["email"]);
    expect(sent[0]!.subject).toBe("How did we do, Eli?");
    expect(sent[0]!.body).toContain(REVIEW_URL);
    expect(sent[0]!.body).toContain("Hi Eli,");
    expect(sent[0]!.automation_ref).toMatch(/^run:/);
    expect((await requestOf(job.jobId)).state).toBe("sent");
  });

  it("asks by text only, and not by email as well, when the text goes", async () => {
    const job = await askedByAutomation("sms_then_email", { name: "Una Both", phone: "+15125550173", email: "una@example.test" });
    expect((await outbound()).map((m) => m.channel)).toEqual(["sms"]);
    expect((await requestOf(job.jobId)).state).toBe("sent");
  });

  it("falls back to the email when the text cannot go, because they replied STOP", async () => {
    await raw`insert into public.suppression (organization_id, address, channel, purpose, reason)
              values (${ORG}, '+15125550174', 'sms', null, 'stop_keyword')`;
    const job = await askedByAutomation("sms_then_email", { name: "Stan Stopped", phone: "+15125550174", email: "stan@example.test" });
    const sent = await outbound();
    expect(sent.map((m) => m.channel)).toEqual(["email"]);
    expect(sent[0]!.body).toContain(REVIEW_URL);
    expect((await requestOf(job.jobId)).state).toBe("sent");
  });

  it("falls back to the email for a customer with no phone number at all", async () => {
    await askedByAutomation("sms_then_email", { name: "Nora Noph", phone: null, email: "nora@example.test" });
    expect((await outbound()).map((m) => m.channel)).toEqual(["email"]);
  });

  it("asks nobody, and says why on the request, when neither channel can go", async () => {
    await raw`insert into public.suppression (organization_id, address, channel, purpose, reason)
              values (${ORG}, '+15125550175', 'sms', null, 'stop_keyword')`;
    const job = await askedByAutomation("sms_then_email", { name: "Nan Nomail", phone: "+15125550175", email: null });
    expect(await outbound()).toHaveLength(0);
    const request = await requestOf(job.jobId);
    expect(request.state).toBe("failed");
    expect(request.withheld_detail).toContain("text:");
    expect(request.withheld_detail).toContain("customer has no email address");
  });

  it("does not ask by text for an email choice, nor by email for a text one, when only the other can go", async () => {
    const job = await askedByAutomation("email", { name: "Ed Nomail", phone: "+15125550176", email: null });
    expect(await outbound()).toHaveLength(0);
    expect((await requestOf(job.jobId)).state).toBe("failed");
  });

  it("refuses a way of asking that is not one of the three, rather than choosing for the company", async () => {
    await expect(workflows.installTemplate(owner(), { key: "review_after_paid", values: { platform: "google", channel: "carrier pigeon" } }))
      .rejects.toThrow(ConflictError);
    await expect(workflows.installTemplate(owner(), { key: "review_after_paid", values: { platform: "google", channel: "carrier pigeon" } }))
      .rejects.toThrow(/by text, by email, or by text first and then email/);
  });

  it("offers the choice on the recommended list, text by default", async () => {
    const listed = (await workflows.recommended(owner())).find((t) => t.key === "review_after_paid")!;
    const choice = listed.parameters.find((p) => p.key === "channel")!;
    expect(choice.kind).toBe("choice");
    expect(choice.defaultChoice).toBe("sms");
    expect(choice.options!.map((o) => o.value)).toEqual(["sms", "email", "sms_then_email"]);
  });
});

run("the due list, worked by the worker", () => {
  const polices = (jobId: string, source: "office" | "automation" = "office") => inTenant(owner(), (tx) =>
    reviews.requestWithin(tx, ORG, { jobId, platform: "google", source }));

  it("sends a request the office queued when its time comes, by text, and never twice", async () => {
    const job = await aPaidJob({ name: "Wes Worker", phone: "+15125550181", email: "wes@example.test" });
    const queued = await reviews.requestFor(owner(), { jobId: job.jobId, platform: "google" });
    expect(queued.asked).toBe(true);
    expect((await requestOf(job.jobId)).source).toBe("office");

    /** Before its time, nothing. */
    const early = await reviewAsks.askPass(db(), { now: new Date(Date.now() - 3600_000) });
    expect(early.reduce((n, r) => n + r.sent, 0)).toBe(0);

    const results = await reviewAsks.askPass(db(), { now: tomorrowAfternoon() });
    expect(results.find((r) => r.organizationId === ORG)).toMatchObject({ sent: 1, failed: 0 });
    const sent = await outbound();
    expect(sent.map((m) => m.channel)).toEqual(["sms"]);
    expect(sent[0]!.body).toContain(REVIEW_URL);
    expect(sent[0]!.body).toContain("Hi Wes,");
    const request = await requestOf(job.jobId);
    expect(request.state).toBe("sent");
    expect(request.message_id).not.toBeNull();

    await reviewAsks.askPass(db(), { now: tomorrowAfternoon() });
    expect(await outbound()).toHaveLength(1);
  });

  it("is a pass of the worker's own, run with the others", async () => {
    const job = await aPaidJob({ name: "Pat Pass", phone: "+15125550182", email: "pat@example.test" });
    await reviews.requestFor(owner(), { jobId: job.jobId, platform: "google" });
    await runPass({ db: db(), reviewAsks: { now: tomorrowAfternoon() }, geocoding: false, push: false });
    expect((await requestOf(job.jobId)).state).toBe("sent");
    /** A whole pass visits every company's clocks, which takes longer on a busy machine than a single test's five seconds. */
  }, 60_000);

  it("asks the way the company's own automation asks, by email when that is how it was turned on", async () => {
    await workflows.installTemplate(owner(), { key: "review_after_paid", values: { hours: 2, platform: "google", channel: "email" } });
    const job = await aPaidJob({ name: "Ivy Installed", phone: "+15125550183", email: "ivy@example.test" });
    /** The office queues this one by hand; the installed automation only decides the way it is asked. */
    await reviews.requestFor(owner(), { jobId: job.jobId, platform: "google" });
    await reviewAsks.askPass(db(), { now: tomorrowAfternoon() });
    const sent = await outbound();
    expect(sent.map((m) => m.channel)).toEqual(["email"]);
    expect(sent[0]!.subject).toBe("How did we do, Ivy?");
  });

  it("leaves a request an automation queued to that automation's own run", async () => {
    const job = await aPaidJob({ name: "Al Auto", phone: "+15125550184", email: "al@example.test" });
    await polices(job.jobId, "automation");
    expect((await requestOf(job.jobId)).source).toBe("automation");
    const results = await reviewAsks.askPass(db(), { now: tomorrowAfternoon() });
    expect(results.find((r) => r.organizationId === ORG)).toBeUndefined();
    expect(await outbound()).toHaveLength(0);
    expect((await requestOf(job.jobId)).state).toBe("queued");
  });

  it("waits through quiet hours rather than texting at night, and moves the request to the morning", async () => {
    const job = await aPaidJob({ name: "Quinn Quiet", phone: "+15125550185", email: "quinn@example.test" });
    await reviews.requestFor(owner(), { jobId: job.jobId, platform: "google" });
    const results = await reviewAsks.askPass(db(), { now: tomorrowNight() });
    expect(results.find((r) => r.organizationId === ORG)).toMatchObject({ sent: 0, held: 1 });
    expect(await outbound()).toHaveLength(0);
    const request = await requestOf(job.jobId);
    expect(request.state).toBe("queued");
    expect(request.send_at!.getTime()).toBeGreaterThan(tomorrowNight().getTime());
    /** In the morning it goes. */
    const morning = new Date(request.send_at!.getTime() + 60_000);
    const again = await reviewAsks.askPass(db(), { now: morning });
    expect(again.find((r) => r.organizationId === ORG)).toMatchObject({ sent: 1 });
    expect((await requestOf(job.jobId)).state).toBe("sent");
  });

  it("asks again whether it may, so a customer put on do not service since is not asked", async () => {
    const job = await aPaidJob({ name: "Dina Dns", phone: "+15125550186", email: "dina@example.test" });
    await reviews.requestFor(owner(), { jobId: job.jobId, platform: "google" });
    await raw`update public.customer set do_not_service = true where id = ${job.customerId}`;
    await reviewAsks.askPass(db(), { now: tomorrowAfternoon() });
    expect(await outbound()).toHaveLength(0);
    const request = await requestOf(job.jobId);
    expect(request.state).toBe("withheld");
    expect(request.withheld_reason).not.toBeNull();
  });

  it("respects consent: a customer who replied STOP is not texted, and the request says so", async () => {
    await raw`insert into public.suppression (organization_id, address, channel, purpose, reason)
              values (${ORG}, '+15125550187', 'sms', null, 'stop_keyword')`;
    const job = await aPaidJob({ name: "Sid Stop", phone: "+15125550187", email: "sid@example.test" });
    await reviews.requestFor(owner(), { jobId: job.jobId, platform: "google" });
    const results = await reviewAsks.askPass(db(), { now: tomorrowAfternoon() });
    expect(results.find((r) => r.organizationId === ORG)).toMatchObject({ sent: 0, failed: 1 });
    expect(await outbound()).toHaveLength(0);
    const request = await requestOf(job.jobId);
    expect(request.state).toBe("failed");
    expect(request.withheld_detail).toMatch(/STOP|asked us to stop|opted out/i);
  });

  it("marks a request whose review site has lost its link rather than trying it every pass", async () => {
    const job = await aPaidJob({ name: "Lou Link", phone: "+15125550188", email: "lou@example.test" });
    await reviews.requestFor(owner(), { jobId: job.jobId, platform: "google" });
    await raw`update public.review_platform set review_url = null where organization_id = ${ORG} and platform = 'google'`;
    try {
      await reviewAsks.askPass(db(), { now: tomorrowAfternoon() });
      const request = await requestOf(job.jobId);
      expect(request.state).toBe("failed");
      expect(request.withheld_detail).toContain("nowhere to send them");
    } finally {
      await raw`update public.review_platform set review_url = ${REVIEW_URL} where organization_id = ${ORG} and platform = 'google'`;
    }
  });

  it("is listed for the worker only for companies with an office request due, and never for an automation's", async () => {
    const job = await aPaidJob({ name: "Lee List", phone: "+15125550189", email: "lee@example.test" });
    await reviews.requestFor(owner(), { jobId: job.jobId, platform: "google" });
    await raw`update public.review_request set send_at = now() - interval '1 minute' where job_id = ${job.jobId}`;
    const due = await raw<{ organization_id: string }[]>`select organization_id from app.review_ask_organizations(200)`;
    expect(due.map((d) => d.organization_id)).toContain(ORG);
    await raw`update public.review_request set source = 'automation' where job_id = ${job.jobId}`;
    const none = await raw<{ organization_id: string }[]>`select organization_id from app.review_ask_organizations(200)`;
    expect(none.map((d) => d.organization_id)).not.toContain(ORG);
  });
});
