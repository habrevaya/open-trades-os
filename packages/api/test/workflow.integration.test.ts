import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as events from "../src/services/events";
import { handleEvent, runnerActor } from "../src/services/workflow-runner";
import { render } from "../src/services/workflow-steps";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * The whole path, against a real database: a job is completed, an event is
 * written in the same transaction, a workflow matches it, and the consent
 * decision decides whether a message is queued.
 *
 * This is the first test that proves the three pieces compose. Each had unit
 * tests and none of them had ever been run together.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("wf:org");
const USER = fixtureId("wf:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";
const NUMBER_ID = fixtureId("wf:number");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Flow Co", slug: "flow-wf" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Wanda Flow", phone: "+15125550100",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;

  const property = await properties.create(owner(), {
    address: { line1: "1 Flow St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;

  // A number that is actually cleared to send. Without one every send is
  // refused, which would make the tests below pass for the wrong reason.
  await raw`insert into public.phone_number (id, organization_id, e164, purpose, sms_registered)
            values (${NUMBER_ID}, ${ORG}, '+15125559999', 'main', true)`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  // Each test defines its own workflow and asserts on its own messages.
  await raw`delete from public.workflow_step_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_version where organization_id = ${ORG}`;
  await raw`delete from public.workflow where organization_id = ${ORG}`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
  await raw`delete from public.communication_consent where organization_id = ${ORG}`;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
});

async function defineWorkflow(opts: {
  events?: string[];
  conditions?: Record<string, unknown>;
  steps?: Record<string, unknown>[];
  permissions?: string[];
  enabled?: boolean;
}) {
  const workflowId = fixtureId(`wf:w:${Math.random()}`);
  const versionId = fixtureId(`wf:v:${Math.random()}`);
  /**
   * `raw.json(...)`, not `JSON.stringify(...)::jsonb`, and the difference is
   * not stylistic.
   *
   * postgres.js asks the server to describe the statement, sees the parameter
   * typed jsonb because of the cast, and then serialises the value with its
   * own json encoder. Hand it a string that is already JSON and it encodes
   * that string, so `["job.completed"]` is stored as the jsonb STRING
   * "[\"job.completed\"]" rather than as an array.
   *
   * Nothing complains. The insert succeeds, the column looks right in a
   * `select`, and only `@>` disagrees: containment against a string is false,
   * so every workflow silently stopped matching its own trigger and ten tests
   * failed with an empty result and no error to read.
   *
   * Drizzle does not have this behaviour (it sends parameters as text), which
   * is why the runner's query was correct all along and only the fixture was
   * wrong. That asymmetry is the trap: production code and test setup sit on
   * the same driver and encode differently.
   */
  await raw`insert into public.workflow (id, organization_id, name, enabled, trigger_kind, trigger_events)
            values (${workflowId}, ${ORG}, 'Test flow', ${opts.enabled ?? true}, 'event',
                    ${json(opts.events ?? ["job.completed"])})`;
  await raw`insert into public.workflow_version
              (id, organization_id, workflow_id, version, conditions, steps, required_permissions, published_at)
            values (${versionId}, ${ORG}, ${workflowId}, 1,
                    ${json(opts.conditions ?? {})},
                    ${json(opts.steps ?? [{ kind: "send_message", config: { channel: "sms", body: "Job {{ job.number }} is done." } }])},
                    ${json(opts.permissions ?? ["message:send"])}, now())`;
  await raw`update public.workflow set active_version_id = ${versionId} where id = ${workflowId}`;

  /**
   * And then check it, because the failure above was invisible. A fixture that
   * stores the wrong shape makes every assertion in this file meaningless in
   * a way that reads as a product bug.
   */
  const [stored] = await raw<{ t: string }[]>`
    select jsonb_typeof(trigger_events) as t from public.workflow where id = ${workflowId}`;
  if (stored?.t !== "array") {
    throw new Error(`fixture stored trigger_events as ${stored?.t}, not an array`);
  }
  return { workflowId, versionId };
}

async function completeAJob() {
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "Flow job", tags: [], customFields: {},
  });
  await jobs.update(owner(), { id: job.id, status: "scheduled" });
  await jobs.update(owner(), { id: job.id, status: "completed" });
  return job;
}

async function latestEventNamed(name: string) {
  const rows = await raw<{ id: string }[]>`
    select id from public.domain_event
    where organization_id = ${ORG} and name = ${name}
    order by sequence desc limit 1`;
  return rows[0]?.id ?? null;
}

/**
 * postgres.js types `json()` as accepting its own `JSONValue`, which a plain
 * `Record<string, unknown>` does not satisfy even though the values here are
 * JSON by construction. One narrowing, in one place, rather than a cast at
 * each of the four call sites.
 */
const json = (value: unknown) => raw.json(value as Parameters<postgres.Sql["json"]>[0]);

const messages = () => raw<{ body: string; status: string; automation_ref: string | null }[]>`
  select body, status, automation_ref from public.message where organization_id = ${ORG}`;

run("events are written with the change", () => {
  it("emits a status event in the same transaction as the update", async () => {
    await completeAJob();
    expect(await latestEventNamed("job.completed")).not.toBeNull();
    expect(await latestEventNamed("job.updated")).not.toBeNull();
  });

  it("numbers events without gaps or repeats", async () => {
    await completeAJob();
    const rows = await raw<{ sequence: number }[]>`
      select sequence from public.domain_event where organization_id = ${ORG} order by sequence`;
    const seqs = rows.map((r) => r.sequence);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("carries the previous values so a transition can be detected", async () => {
    await completeAJob();
    const id = await latestEventNamed("job.completed");
    const [row] = await raw<{ payload: Record<string, unknown> }[]>`
      select payload from public.domain_event where id = ${id}`;
    const previous = row!.payload["previous"] as { job: { status: string } };
    expect(previous.job.status).toBe("scheduled");
  });
});

run("a workflow runs once, and acts", () => {
  it("queues a message when a job completes", async () => {
    await defineWorkflow({});
    const job = await completeAJob();
    const summaries = await handleEvent(owner(), (await latestEventNamed("job.completed"))!);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ status: "succeeded", steps: 1 });

    const sent = await messages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe(`Job ${job.number} is done.`);
    // Queued, not sent. Claiming to have sent something only written to a
    // table would make the whole log untrustworthy.
    expect(sent[0]!.status).toBe("queued");

    // And it names the run that sent it, so "why did I get this text" is a
    // lookup rather than an investigation.
    expect(sent[0]!.automation_ref).toBe(`run:${summaries[0]!.runId}`);
  });

  it("does not run twice for the same event", async () => {
    await defineWorkflow({});
    await completeAJob();
    const eventId = (await latestEventNamed("job.completed"))!;

    await handleEvent(owner(), eventId);
    const second = await handleEvent(owner(), eventId);

    expect(second[0]).toMatchObject({ status: "skipped", reason: "already_run" });
    expect(await messages()).toHaveLength(1);
  });

  it("ignores an event it does not subscribe to", async () => {
    await defineWorkflow({ events: ["invoice.paid"] });
    await completeAJob();
    const summaries = await handleEvent(owner(), (await latestEventNamed("job.completed"))!);
    expect(summaries).toEqual([]);
  });

  it("does not run when disabled", async () => {
    await defineWorkflow({ enabled: false });
    await completeAJob();
    expect(await handleEvent(owner(), (await latestEventNamed("job.completed"))!)).toEqual([]);
  });

  it("respects a condition on the payload", async () => {
    await defineWorkflow({
      conditions: { all: [{ path: "job.summary", op: "eq", value: "something else" }] },
    });
    await completeAJob();
    const summaries = await handleEvent(owner(), (await latestEventNamed("job.completed"))!);
    expect(summaries[0]).toMatchObject({ status: "skipped", reason: "conditions_unmet" });
    expect(await messages()).toHaveLength(0);
  });

  it("records a step run so a failure can be traced", async () => {
    await defineWorkflow({});
    await completeAJob();
    await handleEvent(owner(), (await latestEventNamed("job.completed"))!);

    const steps = await raw<{ step_kind: string; status: string }[]>`
      select step_kind, status from public.workflow_step_run where organization_id = ${ORG}`;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step_kind: "send_message", status: "succeeded" });
  });
});

run("consent decides at send time", () => {
  it("refuses a marketing message with no consent, and does not fail the run", async () => {
    // A refusal is the workflow working. Failing the run would make a
    // correctly suppressed customer look like a broken automation, and an
    // operator would go and turn the guard off.
    await defineWorkflow({
      steps: [{ kind: "send_message", config: { channel: "sms", purpose: "marketing", body: "Spring offer" } }],
    });
    await completeAJob();
    const summaries = await handleEvent(owner(), (await latestEventNamed("job.completed"))!);

    expect(summaries[0]).toMatchObject({ status: "succeeded" });
    expect(await messages()).toHaveLength(0);

    const [step] = await raw<{ output: Record<string, unknown> }[]>`
      select output from public.workflow_step_run where organization_id = ${ORG}`;
    expect(step!.output["refused"]).toBe("no_consent");
  });

  it("sends the marketing message once consent is granted", async () => {
    await raw`insert into public.communication_consent
                (id, organization_id, customer_id, address, channel, purpose, state, method)
              values (${fixtureId("wf:consent")}, ${ORG}, ${customerId}, '+15125550100',
                      'sms', 'marketing', 'granted', 'web_form')`;
    await defineWorkflow({
      steps: [{ kind: "send_message", config: { channel: "sms", purpose: "marketing", body: "Spring offer" } }],
    });
    await completeAJob();
    await handleEvent(owner(), (await latestEventNamed("job.completed"))!);
    expect(await messages()).toHaveLength(1);
  });

  it("honours a STOP even for a transactional message", async () => {
    // The customer said stop. A workflow written in March cannot know that.
    await raw`insert into public.suppression (id, organization_id, address, channel, reason)
              values (${fixtureId("wf:supp")}, ${ORG}, '+15125550100', 'sms', 'replied STOP')`;
    await defineWorkflow({});
    await completeAJob();
    await handleEvent(owner(), (await latestEventNamed("job.completed"))!);

    expect(await messages()).toHaveLength(0);
    const [step] = await raw<{ output: Record<string, unknown> }[]>`
      select output from public.workflow_step_run where organization_id = ${ORG}`;
    expect(step!.output["refused"]).toBe("suppressed");
  });
});

run("a run acts with only what its version declared", () => {
  it("refuses a step the version was not granted", async () => {
    // The version declares no permissions, so the run has none. Publishing
    // checks the author; this checks the run, and both have to hold.
    await defineWorkflow({ permissions: [] });
    await completeAJob();
    const summaries = await handleEvent(owner(), (await latestEventNamed("job.completed"))!);

    expect(summaries[0]).toMatchObject({ status: "failed" });
    expect(summaries[0]!.reason).toMatch(/message:send/);
    expect(await messages()).toHaveLength(0);
  });

  it("does not inherit anything from whoever triggered it", () => {
    // The owner completed the job. The run must not act as the owner.
    const actor = runnerActor(ORG, ["message:send"]);
    expect(actor.roles).toEqual([]);
    expect(actor.grants).toEqual(["message:send"]);
    expect(actor.technicianId).toBeUndefined();
  });
});

run("the loop guard", () => {
  it("does not let a workflow respond to its own output", async () => {
    const { workflowId } = await defineWorkflow({ events: ["job.updated"] });
    await completeAJob();

    const eventId = (await latestEventNamed("job.updated"))!;
    const first = await handleEvent(owner(), eventId);
    const runId = first[0]!.runId!;

    // An event this workflow's own run produced.
    const followUp = await inTenant(owner(), async (tx) =>
      events.emit(tx, owner(), {
        name: "job.updated", entityType: "job",
        payload: { job: { customerId } }, causedByRunId: runId, causationDepth: 1,
      }));

    const second = await handleEvent(owner(), followUp.id);
    expect(second[0]).toMatchObject({ workflowId, status: "skipped", reason: "self_triggered" });
  });

  it("stops a chain that has gone too deep", async () => {
    await defineWorkflow({ events: ["job.updated"] });
    const deep = await inTenant(owner(), async (tx) =>
      events.emit(tx, owner(), {
        name: "job.updated", entityType: "job",
        payload: { job: { customerId } }, causationDepth: 5,
      }));
    const summaries = await handleEvent(owner(), deep.id);
    expect(summaries[0]).toMatchObject({ status: "skipped", reason: "depth_exceeded" });
  });
});

describe("rendering a template", () => {
  it("substitutes from the payload", () => {
    expect(render("Job {{ job.number }} done", { job: { number: 1042 } })).toBe("Job 1042 done");
  });

  it("leaves an unresolved placeholder empty rather than literal", () => {
    // "Hi {{ customer.name }}" reaching a customer is worse than "Hi ".
    expect(render("Hi {{ customer.name }}", {})).toBe("Hi ");
  });

  it("does not resolve a prototype path", () => {
    expect(render("{{ __proto__ }}", {})).toBe("");
    expect(render("{{ constructor }}", {})).toBe("");
  });

  it("substitutes only, with nothing evaluated", () => {
    // A template language that executes is arbitrary code execution wearing
    // a friendly name.
    expect(render("{{ 1 + 1 }}", {})).toBe("{{ 1 + 1 }}");
  });
});
