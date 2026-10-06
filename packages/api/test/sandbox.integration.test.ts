import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as sandbox from "../src/services/sandbox";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as fields from "../src/services/custom-fields";
import * as objects from "../src/services/custom-objects";
import * as workflows from "../src/services/workflows";
import * as templates from "../src/services/proposal-templates";
import { resolveSession } from "../src/services/session";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { resetOrg, seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A SANDBOX IS ANOTHER COMPANY, AND NOTHING CROSSES BUT WHAT IS CHOSEN
 *
 * The promise an owner relies on is that trying something in the sandbox
 * cannot touch a real customer, and that the only thing that ever comes back
 * is a setting they ticked. Every test below is one way that promise could
 * break: a real customer copied in, a practice customer leaking out, a
 * record read across by id, an automation running in the sandbox switched on
 * because it was on at home, a copy back that did more than was chosen, a
 * session moved somewhere that is not this company's own pair.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("sandbox29:org");
const USER = fixtureId("sandbox29:user");
const STRANGER_ORG = fixtureId("sandbox29:stranger");
const STRANGER = fixtureId("sandbox29:stranger-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], organizationId = ORG): ServiceContext => ({
  actor: { userId: USER, organizationId, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

/** Every sandbox this company ever made, thrown away for real between tests. */
async function clearSandboxes() {
  const rows = await raw<{ id: string }[]>`select id from public.organization where sandbox_of_organization_id = ${ORG}`;
  await raw`update public.organization set sandbox_organization_id = null where id = ${ORG}`;
  for (const row of rows) await resetOrg(raw, row.id);
}

async function realCustomer(name: string) {
  const customer = await customers.create(owner(), {
    type: "residential", name, email: `${name.toLowerCase().replace(/ /g, ".")}@real.test`, phone: "+15125551234",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "42 Real Road", city: "Round Rock", state: "TX", postalCode: "78664", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  const job = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: `Fix ${name}'s furnace`, tags: [], customFields: {},
  });
  return { customer, property, job };
}

const anInspectionFlow = {
  name: "Chase the permit",
  triggerKind: "event" as const,
  triggerEvents: ["record.created"],
  steps: [{ kind: "create_task", config: { title: "Call the inspector", queue: "office" } }],
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await clearSandboxes().catch(() => undefined);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Real Co", slug: "real-co-sbx" });
  await seedOrg(raw, { organizationId: STRANGER_ORG, userId: STRANGER, name: "Stranger Co", slug: "stranger-co-sbx" });
  await raw`insert into public.membership (organization_id, user_id, role) values (${STRANGER_ORG}, ${USER}, 'owner')`;
});

afterAll(async () => {
  if (!raw) return;
  await clearSandboxes();
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await clearSandboxes();
  for (const table of [
    "workflow_version", "workflow", "custom_object_record", "custom_object_type", "custom_field_definition",
    "proposal_template", "integration_event", "domain_event", "task",
  ]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
});

run("making one", () => {
  it("copies the configuration, switches every automation off, and copies no real customer", async () => {
    await realCustomer("Pat Real");
    await objects.defineKind(owner(), { key: "permit", label: "Permit", links: ["job"] });
    await fields.define(owner(), { entityType: "object:permit", key: "status", label: "Status" });
    await fields.define(owner(), { entityType: "job", key: "gate_code", label: "Gate code" });
    const flow = await workflows.create(owner(), anInspectionFlow);
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });
    await templates.save(owner(), {
      name: "Installs", isDefault: true,
      layout: { sections: [{ kind: "about", body: "Family owned." }, { kind: "options" }] },
    });

    const made = await sandbox.create(owner(), { sampleData: true });
    expect(made).toMatchObject({
      name: "Real Co (sandbox)",
      copied: { customFields: 2, kinds: 1, workflows: 1, proposalTemplates: 1 },
      sampleJobs: 1,
    });

    const inside = as(["owner"], made.sandboxOrganizationId);
    expect(await sandbox.current(inside)).toMatchObject({ isSandbox: true, production: { id: ORG, name: "Real Co" } });
    expect(await sandbox.current(owner())).toMatchObject({ isSandbox: false, sandbox: { id: made.sandboxOrganizationId } });

    const [copied] = await workflows.list(inside);
    expect(copied).toMatchObject({ name: "Chase the permit", enabled: false });
    expect((await objects.listKinds(inside)).map((k) => k.key)).toEqual(["permit"]);
    expect((await templates.list(inside)).map((t) => [t.name, t.isDefault])).toEqual([["Installs", true]]);

    /** The sample customer: the real town, and nothing else of the real person. */
    const sample = (await customers.list(inside, { limit: 50, includeInactive: false })).data;
    expect(sample.map((c) => [c.name, c.email, c.phone])).toEqual([["Sample customer 1", "sample1@example.com", "+15125550100"]]);
    const everything = JSON.stringify(await raw`
      select c.name, c.email, c.phone, p.address_line1, p.city, j.summary
      from public.customer c join public.property p on p.organization_id = c.organization_id
      join public.job j on j.organization_id = c.organization_id
      where c.organization_id = ${made.sandboxOrganizationId}`);
    expect(everything).not.toMatch(/Pat|Real Road|real\.test|5551234|furnace/);
    expect(everything).toContain("Round Rock");

    /** Nobody else from the real company is in it, and none of its integrations are. */
    const members = await raw`select user_id from public.membership where organization_id = ${made.sandboxOrganizationId}`;
    expect(members.map((m) => m["user_id"])).toEqual([USER]);
    const connections = await raw`select id from public.integration_connection where organization_id = ${made.sandboxOrganizationId}`;
    expect(connections).toHaveLength(0);
  });

  it("is made only from a real company, once at a time, by whoever may", async () => {
    await expect(sandbox.create(as(["technician"]))).rejects.toBeInstanceOf(PermissionError);
    await expect(sandbox.create(as(["office_manager"]))).rejects.toBeInstanceOf(PermissionError);
    const made = await sandbox.create(owner());
    await expect(sandbox.create(owner())).rejects.toThrow("already has a sandbox");
    await expect(sandbox.create(as(["owner"], made.sandboxOrganizationId))).rejects.toThrow("This is a sandbox already");
  });
});

run("kept apart from the real company", () => {
  it("cannot read a real record, even by its id, and what it makes stays in it", async () => {
    const real = await realCustomer("Lee Real");
    const made = await sandbox.create(owner());
    const inside = as(["owner"], made.sandboxOrganizationId);

    await expect(customers.get(inside, { id: real.customer.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(jobs.get(inside, { id: real.job.id })).rejects.toBeInstanceOf(NotFoundError);

    const practice = await customers.create(inside, {
      type: "residential", name: "Practice Person", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    const atHome = (await customers.list(owner(), { limit: 200, includeInactive: false })).data.map((c) => c.name);
    expect(atHome).toContain("Lee Real");
    expect(atHome).not.toContain("Practice Person");
    await expect(customers.get(owner(), { id: practice.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("runs an automation turned on inside it against its own records only", async () => {
    await objects.defineKind(owner(), { key: "permit", label: "Permit" });
    const home = await workflows.create(owner(), anInspectionFlow);
    await workflows.setEnabled(owner(), { id: home.id, enabled: true });
    const made = await sandbox.create(owner());
    const inside = as(["owner"], made.sandboxOrganizationId);
    const [copy] = await workflows.list(inside);
    await workflows.setEnabled(inside, { id: copy!.id, enabled: true });

    await objects.createRecord(inside, { type: "permit", title: "Practice permit" });
    const events = await raw`select organization_id from public.domain_event where name = 'record.created'
      and organization_id in (${ORG}, ${made.sandboxOrganizationId})`;
    expect(events.map((e) => e["organization_id"])).toEqual([made.sandboxOrganizationId]);
  });
});

run("copying settings back", () => {
  it("says what each would do, and copies only what was chosen, through the real company's own checks", async () => {
    await objects.defineKind(owner(), { key: "permit", label: "Permit" });
    await fields.define(owner(), { entityType: "job", key: "gate_code", label: "Gate code" });
    const made = await sandbox.create(owner());
    const inside = as(["owner"], made.sandboxOrganizationId);

    await objects.defineKind(inside, { key: "truck_inspection", label: "Truck inspection", pluralLabel: "Truck inspections" });
    await fields.define(inside, { entityType: "object:truck_inspection", key: "mileage", label: "Mileage", dataType: "number" });
    const [gate] = (await fields.list(inside, { entityType: "job" }));
    await fields.update(inside, { id: gate!.id, label: "Gate or door code" });
    await workflows.create(inside, { ...anInspectionFlow, name: "Tried in the sandbox" });
    await fields.define(inside, { entityType: "job", key: "not_this", label: "Not this one" });

    /** Asked from inside the sandbox, answered about the real company. */
    const plan = await sandbox.plan(inside);
    const action = Object.fromEntries(plan.available.map((item) => [item.id, item.action]));
    expect(action).toMatchObject({
      "custom_object:permit": "same",
      "custom_object:truck_inspection": "create",
      "custom_field:job:gate_code": "update",
      "custom_field:object:truck_inspection:mileage": "create",
      "custom_field:job:not_this": "create",
      "workflow:Tried in the sandbox": "create",
    });

    const chosen = [
      "custom_object:truck_inspection", "custom_field:object:truck_inspection:mileage",
      "custom_field:job:gate_code", "workflow:Tried in the sandbox",
    ];
    const done = await sandbox.copyBack(inside, { items: chosen });
    expect(done.applied.map((item) => [item.naturalKey, item.action])).toEqual([
      ["truck_inspection", "create"],
      ["object:truck_inspection:mileage", "create"],
      ["job:gate_code", "update"],
      ["Tried in the sandbox", "create"],
    ]);

    expect((await objects.listKinds(owner())).map((k) => k.key).sort()).toEqual(["permit", "truck_inspection"]);
    const homeFields = await fields.list(owner(), {});
    expect(homeFields.map((f) => [f.key, f.label])).toEqual(expect.arrayContaining([
      ["gate_code", "Gate or door code"], ["mileage", "Mileage"],
    ]));
    expect(homeFields.some((f) => f.key === "not_this")).toBe(false);
    const flow = (await workflows.list(owner())).find((w) => w.name === "Tried in the sandbox");
    expect(flow).toMatchObject({ enabled: false });
  });

  it("copies nothing at all when one chosen setting is refused", async () => {
    await fields.define(owner(), { entityType: "job", key: "units", label: "Units", dataType: "text" });
    const homeJob = await realCustomer("Kim Real");
    await jobs.update(owner(), { id: homeJob.job.id, customFields: { units: "a few" } });
    const made = await sandbox.create(owner());
    const inside = as(["owner"], made.sandboxOrganizationId);
    await objects.defineKind(inside, { key: "permit", label: "Permit" });
    const [units] = await fields.list(inside, { entityType: "job" });
    await fields.update(inside, { id: units!.id, dataType: "number" });

    /** "a few" at home is not a number, so the real company's own check refuses the change, and the kind goes back too. */
    await expect(sandbox.copyBack(inside, { items: ["custom_object:permit", "custom_field:job:units"] }))
      .rejects.toThrow("would not be valid as a number field");
    expect(await objects.listKinds(owner())).toEqual([]);
  });

  it("is refused to somebody who may not manage the sandbox in the real company", async () => {
    await sandbox.create(owner());
    await expect(sandbox.copyBack(as(["office_manager"]), { items: ["custom_object:x"] })).rejects.toBeInstanceOf(PermissionError);
  });
});

run("moving between them, and throwing one away", () => {
  async function session() {
    const hash = `sbx-${Date.now()}-${Math.random()}`;
    await raw`select app.create_session(${USER}::uuid, ${hash}, ${ORG}::uuid, ${new Date(Date.now() + 864e5).toISOString()}::timestamptz)`;
    return hash;
  }

  it("moves a session into this company's sandbox and back, and nowhere else", async () => {
    const made = await sandbox.create(owner());
    const hash = await session();
    expect(await sandbox.switchTo(db(), hash, STRANGER_ORG)).toBe(false);
    expect(await sandbox.switchTo(db(), hash, made.sandboxOrganizationId)).toBe(true);
    expect((await resolveSession(db(), hash))?.organizationName).toBe("Real Co (sandbox)");
    expect(await sandbox.switchTo(db(), hash, STRANGER_ORG)).toBe(false);
    expect(await sandbox.switchTo(db(), hash, ORG)).toBe(true);
    expect((await resolveSession(db(), hash))?.organizationName).toBe("Real Co");
  });

  it("signs everybody out of a thrown away sandbox and never opens it again", async () => {
    const made = await sandbox.create(owner());
    const hash = await session();
    await sandbox.switchTo(db(), hash, made.sandboxOrganizationId);
    expect(await sandbox.discard(owner())).toEqual({ sandboxOrganizationId: made.sandboxOrganizationId, discarded: true });
    expect(await resolveSession(db(), hash)).toBeNull();

    const other = await session();
    expect(await sandbox.switchTo(db(), other, made.sandboxOrganizationId)).toBe(false);
    expect(await sandbox.current(owner())).toMatchObject({ sandbox: null });
    /** And a new one can be made from today's settings. */
    expect((await sandbox.create(owner())).sandboxOrganizationId).not.toBe(made.sandboxOrganizationId);
  });
});
