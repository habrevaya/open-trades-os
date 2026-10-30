import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { PermissionError, time, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as estimates from "../src/services/estimates";
import * as expiry from "../src/services/estimate-expiry";
import * as workflows from "../src/services/workflows";
import * as dwell from "../src/services/workflow-dwell";
import { handleEvent, resume } from "../src/services/workflow-runner";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * GIVING THE CUSTOMER LONGER RESTARTS THE FOLLOW UP, UNLESS THE OFFICE SAYS NOT
 *
 * "Can you hold that price until the end of the month?" The estimate was sent
 * weeks ago and the follow up has long since run. When the office moves the
 * date later it can start the follow up again from that day, with the same
 * wait as at the send, using the runner and the sweep that already do the
 * chasing. Left alone, nothing starts: an API caller has to ask.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;
/** Installing the follow up and running it through the runner is several round trips; the machine is shared. */
vi.setConfig({ testTimeout: 30_000 });

const ORG = fixtureId("fu-restart:org");
const USER = fixtureId("fu-restart:user");
const ZONE = "America/Chicago";
const PHONE = "+15125550171";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";

const today = () => time.dateIn(new Date(), ZONE);
const plus = (days: number) => time.addDays(today(), days);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Restart Heating", slug: "follow-up-restart-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559921', 'main', true)`;
  const customer = await customers.create(owner(), {
    type: "residential", name: "Rhea Restart", phone: PHONE, email: "rhea@example.test",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "4 Restart Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
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
  await raw`delete from public.portal_grant where organization_id = ${ORG}`;
  await raw`delete from public.domain_event where organization_id = ${ORG} and name = 'estimate.follow_up_restarted'`;
  // Earlier tests' estimates are answered, so no sweep counts them.
  await raw`update public.estimate set status = 'declined' where organization_id = ${ORG}`;
});

const latestEvent = async (name: string) => {
  const [row] = await raw<{ id: string }[]>`
    select id from public.domain_event where organization_id = ${ORG} and name = ${name}
    order by sequence desc limit 1`;
  return row!.id;
};

const runsOf = (workflowId: string) => raw<{ id: string; status: string; resume_at: Date | null; event_id: string }[]>`
  select id, status, resume_at, event_id from public.workflow_run
   where organization_id = ${ORG} and workflow_id = ${workflowId} order by created_at`;

const stepsOf = (runId: string) => raw<{ step_kind: string; status: string; output: Record<string, unknown> }[]>`
  select step_kind, status, output from public.workflow_step_run where run_id = ${runId} order by step_index`;

const outbound = () => raw<{ body: string }[]>`
  select body from public.message where organization_id = ${ORG} and direction = 'outbound'`;

/** An estimate sent by link and good until a date, with its follow up (if installed) started by the send. */
async function sentEstimate(expiresOn: string, followUpWorkflow?: string) {
  const written = await estimates.create(owner(), {
    customerId, propertyId, taxRate: "0", title: "Replace the water heater", expiresOn,
    options: [{
      name: "Fifty gallon", isRecommended: true,
      lines: [{
        name: "Water heater, installed", quantity: "1", unitPrice: "2400.00",
        discountAmount: "0", taxable: false, isOptional: false, isSelected: false,
      }],
    }],
  } as Parameters<typeof estimates.create>[1]);
  await estimates.send(owner(), { id: written.id, channel: "link", expiresInDays: 30 } as Parameters<typeof estimates.send>[1]);
  const first = followUpWorkflow ? (await handleEvent(owner(), await latestEvent("estimate.sent")))[0]! : null;
  return { id: written.id, number: written.number, first };
}

const estimateRow = async (id: string) => (await raw<{
  follow_up_from: Date | null; expiry_extended_at: Date | null; sent_at: Date;
}[]>`select follow_up_from, expiry_extended_at, sent_at from public.estimate where id = ${id}`)[0]!;

const resumeAfter = (runId: string, days: number) =>
  inTenant(owner(), (tx) => resume(tx, owner(), {
    runId, now: new Date(Date.now() + days * 86_400_000 + 60_000),
  }));

run("the recommended follow up, started again", () => {
  it("starts afresh from the day the customer is given longer, with the same wait, and the old run stops", async () => {
    const flow = await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 3 } });
    const { id, number, first } = await sentEstimate(plus(2), flow.id);
    expect(first).toMatchObject({ status: "waiting" });

    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "Waiting on their insurer.", restartFollowUp: true });

    const runs = await runsOf(flow.id);
    expect(runs).toHaveLength(2);
    const restarted = runs[1]!;
    expect(restarted.status).toBe("waiting");
    const wait = restarted.resume_at!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(3 * 86_400_000 - 120_000);
    expect(wait).toBeLessThan(3 * 86_400_000 + 120_000);

    const [event] = await raw<{ name: string; payload: { estimate: Record<string, unknown>; customer: { name: string } } }[]>`
      select name, payload from public.domain_event where id = ${restarted.event_id}`;
    expect(event!.name).toBe("estimate.follow_up_restarted");
    expect(event!.payload.estimate).toMatchObject({ id, number });
    expect(event!.payload.customer.name).toBe("Rhea Restart");

    // The run waiting from the send stops at its question: the date was moved since.
    const old = await resumeAfter(runs[0]!.id, 3);
    expect(old.status).toBe("succeeded");
    expect((await stepsOf(runs[0]!.id))[1]!.output).toMatchObject({
      held: false, because: `estimate #${number} was given longer by the office since it was sent`,
    });
    expect(await outbound()).toHaveLength(0);

    // The restarted one chases, once the wait is up.
    const done = await resumeAfter(restarted.id, 3);
    expect(done.status).toBe("succeeded");
    const texts = await outbound();
    expect(texts).toHaveLength(1);
    expect(texts[0]!.body).toContain(`estimate #${number}`);
    expect((await raw`select id from public.task where organization_id = ${ORG}`)).toHaveLength(1);
  });

  it("stops if the date is moved again, and the second time is left alone", async () => {
    const flow = await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 3 } });
    const { id, number } = await sentEstimate(plus(2), flow.id);
    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "First.", restartFollowUp: true });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expiry.extend(owner(), { id, expiresOn: plus(40), reason: "Again, and leave them be." });

    const runs = await runsOf(flow.id);
    expect(runs).toHaveLength(2);
    await resumeAfter(runs[1]!.id, 3);
    expect((await stepsOf(runs[1]!.id))[1]!.output).toMatchObject({
      held: false, because: `estimate #${number} was given longer again since this follow up started`,
    });
    expect(await outbound()).toHaveLength(0);
  });

  it("stops if the estimate is sent again before the wait is up", async () => {
    const flow = await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 3 } });
    const { id, number } = await sentEstimate(plus(2), flow.id);
    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "Holding.", restartFollowUp: true });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await estimates.send(owner(), { id, channel: "link", expiresInDays: 30 } as Parameters<typeof estimates.send>[1]);
    const runs = await runsOf(flow.id);
    await resumeAfter(runs[1]!.id, 3);
    expect((await stepsOf(runs[1]!.id))[1]!.output).toMatchObject({
      held: false, because: `estimate #${number} was sent again since`,
    });
  });

  it("starts nothing when the office leaves it alone, and nothing when the API caller leaves the flag out", async () => {
    const flow = await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 3 } });
    const { id } = await sentEstimate(plus(2), flow.id);
    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "No flag.", restartFollowUp: false });
    await expiry.extend(owner(), { id, expiresOn: plus(30), reason: "Flag left out." });
    expect(await runsOf(flow.id)).toHaveLength(1);
    expect((await estimateRow(id)).follow_up_from).toBeNull();
    expect(await raw`select 1 from public.domain_event where organization_id = ${ORG} and name = 'estimate.follow_up_restarted'`)
      .toHaveLength(0);
  });

  it("starts no other automation that begins at a send, and none when the follow up is switched off", async () => {
    const flow = await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 3 } });
    const other = await workflows.create(owner(), {
      name: "Tell the sales lead", triggerKind: "event", triggerEvents: ["estimate.sent"],
      steps: [{ kind: "create_task", config: { title: "Estimate {{ estimate.number }} went out", queue: "office" } }],
    });
    await workflows.setEnabled(owner(), { id: other.id, enabled: true });
    const { id } = await sentEstimate(plus(2), flow.id);
    await workflows.setEnabled(owner(), { id: flow.id, enabled: false });
    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "Holding.", restartFollowUp: true });
    expect(await runsOf(flow.id)).toHaveLength(1);
    // Its one run is the one the send started; the date moving started no second.
    expect(await runsOf(other.id)).toHaveLength(1);
    // Still recorded, for the sweep.
    expect((await estimateRow(id)).follow_up_from).not.toBeNull();
  });

  it("starts it once for a retry of the same change", async () => {
    const flow = await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 3 } });
    const { id } = await sentEstimate(plus(2), flow.id);
    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "Holding.", restartFollowUp: true });
    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "Holding.", restartFollowUp: true });
    expect(await runsOf(flow.id)).toHaveLength(2);
  });

  it("is still the estimate writer's, and the audit says it was restarted", async () => {
    const flow = await workflows.installTemplate(owner(), { key: "estimate_follow_up", values: { days: 3 } });
    const { id } = await sentEstimate(plus(2), flow.id);
    await expect(expiry.extend(as(["dispatcher"]), { id, expiresOn: plus(20), reason: "x", restartFollowUp: true }))
      .rejects.toThrow(PermissionError);
    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "Holding.", restartFollowUp: true });
    const [audited] = await raw<{ after: { followUpRestarted: boolean; followUpRuns: number } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and action = 'estimate.expiry_extended'`;
    expect(audited!.after).toMatchObject({ followUpRestarted: true, followUpRuns: 1 });
  });
});

run("the sweep for estimates nobody answered", () => {
  const defineDwell = async (afterDays: number) => {
    const flow = await workflows.create(owner(), {
      name: "Chase quiet quotes", triggerKind: "dwell", dwell: { shape: "estimate_unanswered", afterDays },
      steps: [{ kind: "create_task", config: { title: "Chase estimate {{ estimate.number }}", queue: "office" } }],
    });
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });
    return flow.id;
  };
  const sweepAt = async (at: Date) =>
    (await dwell.sweep(db(), { only: [ORG], now: at })).filter((r) => r.organizationId === ORG);
  const days = (n: number) => new Date(Date.now() + n * 86_400_000);
  /** An unanswered estimate whose send is 20 days old, already chased once by the sweep. */
  async function oldAndChased(workflowId: string) {
    const { id } = await sentEstimate(plus(2));
    await raw`update public.estimate set sent_at = now() - interval '20 days' where id = ${id}`;
    const [first] = await sweepAt(new Date());
    expect(first!.runs).toHaveLength(1);
    return id;
  }

  it("counts its days from the day it was started again, and chases once more", async () => {
    const flow = await defineDwell(3);
    const id = await oldAndChased(flow);
    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "Holding.", restartFollowUp: true });

    // Two days on it is too soon; three days on it is chased again, once.
    expect((await sweepAt(days(2)))[0]!.matched).toBe(0);
    const [again] = await sweepAt(days(3.1));
    expect(again!.matched).toBe(1);
    expect(again!.runs).toHaveLength(1);
    expect((await sweepAt(days(3.2)))[0]!.runs).toHaveLength(0);
    expect(await raw`select id from public.task where organization_id = ${ORG}`).toHaveLength(2);
  });

  it("chases once for each time it is started again", async () => {
    const flow = await defineDwell(3);
    const id = await oldAndChased(flow);
    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "One.", restartFollowUp: true });
    expect((await sweepAt(days(4)))[0]!.runs).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expiry.extend(owner(), { id, expiresOn: plus(40), reason: "Two.", restartFollowUp: true });
    expect((await sweepAt(days(2)))[0]!.matched).toBe(0);
    expect((await sweepAt(days(4)))[0]!.runs).toHaveLength(1);
    expect(await raw`select id from public.task where organization_id = ${ORG}`).toHaveLength(3);
  });

  it("leaves it alone when the office said to, however long it waits", async () => {
    const flow = await defineDwell(3);
    const id = await oldAndChased(flow);
    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "Leave them be." });
    expect((await sweepAt(days(30)))[0]!.matched).toBe(0);
  });

  it("is left alone again when the date moves a second time without asking", async () => {
    const flow = await defineDwell(3);
    const id = await oldAndChased(flow);
    await expiry.extend(owner(), { id, expiresOn: plus(20), reason: "Restart.", restartFollowUp: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expiry.extend(owner(), { id, expiresOn: plus(40), reason: "Now leave them be." });
    expect((await sweepAt(days(30)))[0]!.matched).toBe(0);
  });
});
