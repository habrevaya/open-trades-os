import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { drainOrganization, drainAll, runWorker, advanceCursor } from "../src/services/workflow-worker";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * NOTHING WAS READING THE LOG
 *
 * `handleEvent` existed, was tested, and was called by nothing outside its own
 * test file. Events were written on every job update and sat there. This file
 * is the proof that a job completed by a person, with nobody calling the
 * runner by hand, results in a message.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("wk:org");
const USER = fixtureId("wk:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";

const json = (value: unknown) => raw.json(value as Parameters<postgres.Sql["json"]>[0]);

async function defineWorkflow(events: string[] = ["job.completed"]) {
  const workflowId = fixtureId(`wk:w:${Math.random()}`);
  const versionId = fixtureId(`wk:v:${Math.random()}`);
  await raw`insert into public.workflow (id, organization_id, name, enabled, trigger_kind, trigger_events)
            values (${workflowId}, ${ORG}, 'Drain flow', true, 'event', ${json(events)})`;
  await raw`insert into public.workflow_version
              (id, organization_id, workflow_id, version, conditions, steps, required_permissions, published_at)
            values (${versionId}, ${ORG}, ${workflowId}, 1, ${json({})},
                    ${json([{ kind: "send_message", config: { channel: "sms", body: "Done." } }])},
                    ${json(["message:send"])}, now())`;
  await raw`update public.workflow set active_version_id = ${versionId} where id = ${workflowId}`;
  return workflowId;
}

const messages = () => raw<{ body: string }[]>`
  select body from public.message where organization_id = ${ORG}`;

const cursor = async () => {
  const rows = await raw<{ last_sequence: number }[]>`
    select last_sequence from public.event_cursor
    where organization_id = ${ORG} and consumer = 'workflow'`;
  return rows[0]?.last_sequence ?? null;
};

async function completeAJob() {
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "Drain job", tags: [], customFields: {},
  });
  await jobs.update(owner(), { id: job.id, status: "scheduled" });
  await jobs.update(owner(), { id: job.id, status: "completed" });
  return job;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Worker Co", slug: "worker-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Wes Worker", phone: "+15125550180",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "4 Worker Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;

  await raw`insert into public.phone_number (id, organization_id, e164, purpose, sms_registered)
            values (${fixtureId("wk:number")}, ${ORG}, '+15125559998', 'main', true)`;
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
  await raw`delete from public.domain_event where organization_id = ${ORG}`;
  await raw`delete from public.event_cursor where organization_id = ${ORG}`;
});

run("draining the log", () => {
  it("runs a workflow for an event nobody handed it", async () => {
    await defineWorkflow();
    await completeAJob();

    const result = await drainOrganization(db(), ORG);

    expect(result.events).toBeGreaterThan(0);
    expect((await messages())).toHaveLength(1);
  });

  it("records how far it read, so the next pass starts after it", async () => {
    await defineWorkflow();
    await completeAJob();

    const first = await drainOrganization(db(), ORG);
    expect(await cursor()).toBe(first.cursor);

    // Nothing new. The second pass must find nothing rather than replay.
    const second = await drainOrganization(db(), ORG);
    expect(second.events).toBe(0);
    expect(await messages()).toHaveLength(1);
  });

  it("does not send twice when the same events are drained again", async () => {
    // Belt and braces: even if the cursor were lost entirely, the run's
    // idempotency key is what stops a customer getting the text twice.
    await defineWorkflow();
    await completeAJob();

    await drainOrganization(db(), ORG);
    await raw`delete from public.event_cursor where organization_id = ${ORG}`;
    await drainOrganization(db(), ORG);

    expect(await messages()).toHaveLength(1);
  });

  it("keeps moving past an event whose handling throws", async () => {
    /**
     * A step that merely fails is already handled: the run records it and the
     * loop carries on. What this covers is the other kind, where handling
     * THROWS, and the first version of this test did not: it used an unknown
     * step kind, which `execute` turns into a recorded failure and returns
     * normally, so the assertion passed with the catch deleted.
     *
     * `steps` as an object rather than an array throws where nothing is
     * expecting it, which is what an unhandled error actually looks like.
     */
    await defineWorkflow(["job.updated"]);
    await raw`update public.workflow_version set steps = ${json({ not: "an array" })}
              where organization_id = ${ORG}`;
    await completeAJob();

    const result = await drainOrganization(db(), ORG);
    expect(result.events).toBeGreaterThan(1);
    expect(result.runs.some((r) => r.status === "failed")).toBe(true);
    // The cursor reached the end despite the throw. A wedged cursor holds up
    // every later event, including ones belonging to workflows that work.
    expect(await cursor()).toBe(result.cursor);
  });

  it("never lets the cursor go backwards", async () => {
    /**
     * Two workers finishing out of order. The slower one's result is older,
     * and assigning it would hand every event between the two positions out
     * again, forever.
     *
     * Tested directly rather than by racing two drains, because a race that
     * usually goes the right way is a test that usually passes.
     */
    const ctx = { actor: owner().actor, db: db() };
    await advanceCursor(ctx, ORG, 40);
    await advanceCursor(ctx, ORG, 12);
    expect(await cursor()).toBe(40);
  });

  it("takes at most the batch it was given", async () => {
    await defineWorkflow();
    await completeAJob();
    await completeAJob();

    const result = await drainOrganization(db(), ORG, 1);
    expect(result.events).toBe(1);
    // And the next pass continues rather than starting over.
    const next = await drainOrganization(db(), ORG, 1);
    expect(next.cursor).toBeGreaterThan(result.cursor);
  });

  it("finds the organization without being told which one", async () => {
    // The part that needs a privilege no request holds: a worker has to
    // discover which tenants have work before it can enter any of them.
    await defineWorkflow();
    await completeAJob();

    const results = await drainAll(db());
    expect(results.some((r) => r.organizationId === ORG)).toBe(true);
    expect(await messages()).toHaveLength(1);
  });
});

run("the loop", () => {
  it("stops when it is asked to", async () => {
    const controller = new AbortController();
    const finished = runWorker({ db: db(), intervalMs: 20, signal: controller.signal });
    controller.abort();
    // A worker that ignores its abort signal is a deployment that never
    // finishes rolling.
    await expect(finished).resolves.toBeUndefined();
  });
});
