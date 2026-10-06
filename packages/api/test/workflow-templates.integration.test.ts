import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as estimates from "../src/services/estimates";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as reviews from "../src/services/reviews";
import * as workflows from "../src/services/workflows";
import { handleEvent, resume } from "../src/services/workflow-runner";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE TWO AUTOMATIONS EVERY OFFICE WANTS, AS ONES IT CAN TURN ON
 *
 * Chasing the estimate nobody answered, and asking for a review once the job
 * is paid, both had to be built by hand on the canvas, and in practice were
 * not. These tests turn each on from the recommended list and drive the run
 * through the runner, the way the worker does: the event, the wait parked on
 * the row, the resume, and what reached the customer.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("tpl:org");
const USER = fixtureId("tpl:user");
const PHONE = "+15125550161";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (over: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"], ...over }, db: db(),
});

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Template Heating", slug: "template-heating" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559911', 'main', true)`;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Tess Quote", phone: PHONE, email: "tess@example.test",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "12 Template Ln", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.task where organization_id = ${ORG}`;
  await raw`delete from public.workflow_step_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_version where organization_id = ${ORG}`;
  await raw`delete from public.workflow where organization_id = ${ORG}`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
  await raw`delete from public.portal_event where organization_id = ${ORG}`;
  await raw`delete from public.portal_grant where organization_id = ${ORG}`;
  await raw`delete from public.review_request where organization_id = ${ORG}`;
  await raw`delete from public.review_platform where organization_id = ${ORG}`;
  await raw`delete from public.review_policy where organization_id = ${ORG}`;
  await raw`delete from public.integration_event where organization_id = ${ORG}`;
});

const latestEvent = async (name: string) => {
  const [row] = await raw<{ id: string }[]>`
    select id from public.domain_event where organization_id = ${ORG} and name = ${name}
    order by sequence desc limit 1`;
  return row!.id;
};

const outbound = () => raw<{ body: string; channel: string; automation_ref: string | null }[]>`
  select body, channel, automation_ref from public.message
  where organization_id = ${ORG} and direction = 'outbound' order by created_at`;

const stepsOf = (runId: string) => raw<{ step_index: number; step_kind: string; status: string; output: Record<string, unknown> }[]>`
  select step_index, step_kind, status, output from public.workflow_step_run
  where run_id = ${runId} order by step_index`;

const anEstimate = () => estimates.create(owner(), {
  customerId, propertyId, taxRate: "0", title: "Replace the water heater",
  options: [{
    name: "Fifty gallon", isRecommended: true,
    lines: [{
      name: "Water heater, installed", quantity: "1", unitPrice: "2400.00",
      discountAmount: "0", taxable: false, isOptional: false, isSelected: false,
    }],
  }],
});

/** Send one, and return the run the follow up started for it. */
async function sentAndFollowedUp() {
  const estimate = await anEstimate();
  await estimates.send(owner(), { id: estimate.id, channel: "link", expiresInDays: 30 });
  const [summary] = await handleEvent(owner(), await latestEvent("estimate.sent"));
  return { estimate, summary: summary! };
}

const resumeAfter = (runId: string, days: number) =>
  inTenant(owner(), (tx) => resume(tx, owner(), {
    runId, now: new Date(Date.now() + days * 86_400_000 + 60_000),
  }));

run("turning a recommended automation on", () => {
  it("installs an ordinary workflow, switched on, that the list then shows as on", async () => {
    const installed = await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 4 } });
    expect(installed).toMatchObject({ enabled: true, templateKey: "estimate_follow_up" });

    const listed = await workflows.list(owner());
    expect(listed.map((w) => w.steps.map((s) => s.kind))).toEqual([
      ["wait", "stop_unless", "send_estimate", "send_estimate", "create_task"],
    ]);
    expect(listed[0]!.triggerEvents).toEqual(["estimate.sent"]);

    const recommended = await workflows.recommended(owner());
    expect(recommended.find((t) => t.key === "estimate_follow_up")?.installed?.id).toBe(installed.id);

    /** Ordinary: it publishes a second version like anything drawn on the canvas. */
    const detail = await workflows.detail(owner(), { id: installed.id });
    const steps = detail.version!.steps as { kind: string; config?: Record<string, unknown> }[];
    await workflows.publish(owner(), {
      id: installed.id, name: "Chase quotes", triggerKind: "event", triggerEvents: ["estimate.sent"],
      steps: steps.filter((s) => !(s.kind === "send_estimate" && s.config?.["channel"] === "email")),
    });
    expect((await workflows.list(owner()))[0]!.steps).toHaveLength(4);
  });

  it("refuses a second copy, and treats a replayed press as the first", async () => {
    const keyed = { ...owner(), idempotencyKey: "turn-on-once" };
    const first = await workflows.installTemplate(keyed, { key: "estimate_follow_up" });
    expect((await workflows.installTemplate(keyed, { key: "estimate_follow_up" })).id).toBe(first.id);

    await expect(workflows.installTemplate(owner(), { key: "estimate_follow_up" })).rejects.toThrow(ConflictError);
    await expect(workflows.installTemplate(owner(), { key: "estimate_follow_up" }))
      .rejects.toThrow(/already installed/);

    // Deleted, it can be turned on again.
    await workflows.remove(owner(), { id: first.id });
    await workflows.installTemplate(owner(), { key: "estimate_follow_up" });
  });

  it("is not a way to get authority the installer does not hold", async () => {
    await expect(workflows.installTemplate(owner({ revocations: ["message:send"] }), { key: "estimate_follow_up" }))
      .rejects.toThrow(/You do not hold: .*message:send/);
  });

  it("refuses a value outside its bounds rather than quietly clamping it", async () => {
    await expect(workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 90 } }))
      .rejects.toThrow(/cannot be more than 30/);
  });
});

run("what a new company starts with", () => {
  it("has the estimate follow up installed and on, once however often it is asked, and it switches off", async () => {
    const first = await workflows.installStarters(owner());
    expect(first).toHaveLength(1);
    // A second call, a retry of sign up say, leaves the one it made alone.
    expect(await workflows.installStarters(owner())).toEqual([]);

    const listed = (await workflows.recommended(owner())).find((t) => t.key === "estimate_follow_up")!;
    expect(listed.onForNewCompanies).toBe(true);
    expect(listed.installed).toEqual({ id: first[0], enabled: true, name: "Follow up an estimate that has not been answered" });
    // Only the one marked for it: the review request needs rules a new company has not set.
    expect((await workflows.recommended(owner())).filter((t) => t.installed)).toHaveLength(1);

    await workflows.setEnabled(owner(), { id: first[0]!, enabled: false });
    const after = (await workflows.recommended(owner())).find((t) => t.key === "estimate_follow_up")!;
    expect(after.installed?.enabled).toBe(false);
  });
});

run("following up an estimate nobody answered", () => {
  it("waits, then texts the link, emails it if it can, and raises a call for the office", async () => {
    await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 3 } });
    const { estimate, summary } = await sentAndFollowedUp();
    expect(summary.status).toBe("waiting");

    // Two days in, nothing yet: the wait is on the row.
    const early = await inTenant(owner(), (tx) => resume(tx, owner(), {
      runId: summary.runId!, now: new Date(Date.now() + 2 * 86_400_000),
    }));
    expect(early.reason).toBe("not_due");
    expect(await outbound()).toHaveLength(0);

    const done = await resumeAfter(summary.runId!, 3);
    expect(done.status).toBe("succeeded");

    const sent = await outbound();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe("sms");
    expect(sent[0]!.body).toContain(`estimate #${estimate.number}`);
    expect(sent[0]!.body).toMatch(/\/e\/[A-Za-z0-9_-]{20,}/);
    expect(sent[0]!.automation_ref).toBe(`run:${summary.runId}`);

    /**
     * No email provider is connected, so the email is refused rather than
     * failing the run, and the link minted for it is withdrawn rather than
     * left live behind a message that never went.
     */
    const steps = await stepsOf(summary.runId!);
    expect(steps.map((s) => [s.step_kind, s.status])).toEqual([
      ["wait", "succeeded"], ["stop_unless", "succeeded"], ["send_estimate", "succeeded"],
      ["send_estimate", "succeeded"], ["create_task", "succeeded"],
    ]);
    expect(steps[3]!.output["sent"]).toBe(false);
    const live = await raw`select id from public.portal_grant
      where organization_id = ${ORG} and subject_id = ${estimate.id} and revoked_at is null`;
    // The office's own link from sending, and the one the text carried.
    expect(live).toHaveLength(2);

    const tasks = await raw<{ title: string; entity_type: string; entity_id: string; queue: string }[]>`
      select title, entity_type, entity_id, queue from public.task where organization_id = ${ORG}`;
    expect(tasks).toEqual([{
      title: `Ring Tess Quote about estimate #${estimate.number}`,
      entity_type: "estimate", entity_id: estimate.id, queue: "office",
    }]);
  });

  it("stops quietly when the customer approved in the meantime, and says so", async () => {
    await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 3 } });
    const { estimate, summary } = await sentAndFollowedUp();
    await estimates.approve(owner(), {
      id: estimate.id, optionId: estimate.options[0]!.id, selectedLineIds: [],
      signerName: "Tess Quote", capturedVia: "phone",
    });

    const done = await resumeAfter(summary.runId!, 3);
    expect(done.status).toBe("succeeded");
    expect(await outbound()).toHaveLength(0);
    expect(await raw`select id from public.task where organization_id = ${ORG}`).toHaveLength(0);

    const steps = await stepsOf(summary.runId!);
    expect(steps[1]!.output).toMatchObject({ held: false, because: `estimate #${estimate.number} is approved now` });
    expect(steps.slice(2).map((s) => s.status)).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("leaves a quote sent again to the follow up that send started", async () => {
    await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 3 } });
    const { estimate, summary } = await sentAndFollowedUp();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await estimates.send(owner(), { id: estimate.id, channel: "link", expiresInDays: 30 });

    await resumeAfter(summary.runId!, 3);
    const steps = await stepsOf(summary.runId!);
    expect(steps[1]!.output).toMatchObject({ held: false, because: `estimate #${estimate.number} was sent again since` });
    expect(await outbound()).toHaveLength(0);
  });

  it("does not text a customer who replied STOP, and still raises the call", async () => {
    await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 3 } });
    await raw`insert into public.suppression (organization_id, address, channel, reason)
              values (${ORG}, ${PHONE}, 'sms', 'stop')`;
    const { summary } = await sentAndFollowedUp();
    await resumeAfter(summary.runId!, 3);

    expect(await outbound()).toHaveLength(0);
    const steps = await stepsOf(summary.runId!);
    expect(steps[2]!.output).toMatchObject({ sent: false });
    expect(String(steps[2]!.output["refused"])).toContain("STOP");
    expect(await raw`select id from public.task where organization_id = ${ORG}`).toHaveLength(1);
  });
});

run("asking for a review after a paid job", () => {
  const setPolicy = () => reviews.setPolicy(owner(), {
    timeZone: "America/Chicago", delayMinutes: 120, customerCooldownDays: 90,
    requirePaid: true, maxJobAgeDays: 14, earliestHour: 9, latestHour: 19,
  });
  const declareGoogle = (reviewUrl: string | null = "https://g.page/r/template-heating/review") =>
    reviews.setPlatform(owner(), {
      platform: "google", displayName: "Google", reviewUrl,
      prohibits: ["incentives", "bulk_requests", "templated_replies"],
      note: "Checked their policy in September.",
    });

  /** A finished job, its invoice paid in full, which is what emits `invoice.paid`. */
  async function aPaidJob() {
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Annual service", tags: [], customFields: {},
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
      customerId, jobId: job.id,
      lines: [{ name: "Annual service", quantity: "1", unitPrice: "189.00", discountAmount: "0", taxable: false }],
    });
    await billing.pay(owner(), {
      customerId, method: "check", amount: invoice.total, tipAmount: "0",
      allocations: [{ invoiceId: invoice.id, amount: invoice.total }],
    });
    return job.id;
  }

  /** Mid afternoon in Austin tomorrow, inside the review rules' hours. */
  const tomorrowAfternoon = () => {
    const d = new Date(Date.now() + 86_400_000);
    d.setUTCHours(20, 0, 0, 0);
    return d;
  };

  it("cannot be turned on without review rules or a review site to send people to", async () => {
    await expect(workflows.installTemplate(owner(), { key: "review_after_paid", values: { platform: "google" } }))
      .rejects.toThrow(/No review policy/);
    await setPolicy();
    await declareGoogle(null);
    await expect(workflows.installTemplate(owner(), { key: "review_after_paid", values: { platform: "google" } }))
      .rejects.toThrow(/nowhere to send them/);
    const listed = (await workflows.recommended(owner())).find((t) => t.key === "review_after_paid");
    expect(listed?.blockedBy).toMatch(/Declare where your customers leave reviews/);
  });

  it("asks through the reviews module, sends the link, and marks the request sent", async () => {
    await setPolicy();
    await declareGoogle();
    await workflows.installTemplate(owner(), { key: "review_after_paid", values: { hours: 2, platform: "google" } });

    const jobId = await aPaidJob();
    const [summary] = await handleEvent(owner(), await latestEvent("invoice.paid"));
    expect(summary!.status).toBe("waiting");

    const done = await inTenant(owner(), (tx) => resume(tx, owner(), { runId: summary!.runId!, now: tomorrowAfternoon() }));
    expect(done.status).toBe("succeeded");

    const sent = await outbound();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("https://g.page/r/template-heating/review");
    expect(sent[0]!.body).toContain("Hi Tess");

    const [request] = await raw<{ state: string; message_id: string | null }[]>`
      select state, message_id from public.review_request where job_id = ${jobId}`;
    expect(request!.state).toBe("sent");
    expect(request!.message_id).not.toBeNull();
  });

  it("does not ask somebody asked recently, and records why", async () => {
    await setPolicy();
    await declareGoogle();
    await workflows.installTemplate(owner(), { key: "review_after_paid", values: { hours: 2, platform: "google" } });

    await aPaidJob();
    const [first] = await handleEvent(owner(), await latestEvent("invoice.paid"));
    await inTenant(owner(), (tx) => resume(tx, owner(), { runId: first!.runId!, now: tomorrowAfternoon() }));

    const secondJob = await aPaidJob();
    const [second] = await handleEvent(owner(), await latestEvent("invoice.paid"));
    await inTenant(owner(), (tx) => resume(tx, owner(), { runId: second!.runId!, now: tomorrowAfternoon() }));

    expect(await outbound()).toHaveLength(1);
    const [withheld] = await raw<{ state: string; withheld_reason: string }[]>`
      select state, withheld_reason from public.review_request where job_id = ${secondJob}`;
    expect(withheld).toEqual({ state: "withheld", withheld_reason: "customer_asked_recently" });
    const steps = await stepsOf(second!.runId!);
    expect(steps[1]!.output).toMatchObject({ asked: false, withheld: "customer_asked_recently" });
    expect(steps[2]!.output).toMatchObject({ sent: false, because: "nothing is queued for this job" });
  });
});

run("the unsold estimates list", () => {
  it("is sent and undecided only, oldest first, or largest first", async () => {
    await raw`delete from public.estimate where organization_id = ${ORG}`;
    const small = await anEstimate();
    const big = await estimates.create(owner(), {
      customerId, propertyId, taxRate: "0",
      options: [
        { name: "Repair", isRecommended: false, lines: [{ name: "Repair", quantity: "1", unitPrice: "900.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }] },
        { name: "Replace", isRecommended: true, lines: [{ name: "Replace", quantity: "1", unitPrice: "7400.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }] },
      ],
    });
    const decided = await anEstimate();
    const draft = await anEstimate();
    for (const e of [small, big, decided]) {
      await estimates.send(owner(), { id: e.id, channel: "link", expiresInDays: 30 });
    }
    await estimates.decline(owner(), { id: decided.id, reason: "Went elsewhere" });
    await raw`update public.estimate set sent_at = now() - interval '9 days' where id = ${small.id}`;
    await raw`update public.estimate set sent_at = now() - interval '2 days' where id = ${big.id}`;

    const byAge = await estimates.unsold(owner());
    expect(byAge.map((e) => [e.id, e.ageDays, e.value])).toEqual([
      [small.id, 9, "2400.0000"],
      [big.id, 2, "7400.0000"],
    ]);
    expect(byAge.map((e) => e.id)).not.toContain(draft.id);

    const byValue = await estimates.unsold(owner(), { sort: "value" });
    expect(byValue.map((e) => e.id)).toEqual([big.id, small.id]);
  });
});
