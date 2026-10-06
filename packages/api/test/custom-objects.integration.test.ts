import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as fields from "../src/services/custom-fields";
import * as objects from "../src/services/custom-objects";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as reports from "../src/services/reports";
import * as workflows from "../src/services/workflows";
import * as dataExport from "../src/services/export";
import { handleEvent } from "../src/services/workflow-runner";
import { NotFoundError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A COMPANY'S OWN KIND OF RECORD, END TO END
 *
 * A permit is the example all the way through, because it is the one every
 * trade has and nothing in the product held: a number, a status, a date it
 * was inspected, the job it is for. Each block is one promise the brief
 * makes about a kind of record, against a real database: it is made and
 * changed like any other record and checked like any other field, it is held
 * to who may see it, it reads out and back in as a spreadsheet, a report can
 * count it, an automation can start on it, and it leaves with the company's
 * data.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cobj29:org");
const USER = fixtureId("cobj29:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});
const owner = () => as(["owner"]);

async function refusal(write: Promise<unknown>) {
  const error = await write.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(UnprocessableError);
  return (error as UnprocessableError).issues;
}

let made = 0;
async function aJob() {
  made += 1;
  const customer = await customers.create(owner(), {
    type: "residential", name: `Permit customer ${made}`, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: `${made} Elm St`, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  const job = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "Panel upgrade", tags: [], customFields: {},
  });
  return { customer, property, job };
}

/** A permit: what each one is called, what it points at, and three fields. */
async function definePermits(options: { readPermission?: string } = {}) {
  const kind = await objects.defineKind(owner(), {
    key: "permit", label: "Permit", pluralLabel: "Permits", titleLabel: "Permit number",
    links: ["customer", "property", "job"], ...options,
  });
  await fields.define(owner(), {
    entityType: "object:permit", key: "status", label: "Status", dataType: "select",
    options: ["applied", "approved", "failed"], required: true,
  });
  await fields.define(owner(), { entityType: "object:permit", key: "inspected_on", label: "Inspected on", dataType: "date" });
  await fields.define(owner(), { entityType: "object:permit", key: "fee", label: "Fee", dataType: "number" });
  return kind;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Permit Co", slug: "permit-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  for (const table of [
    "workflow_step_run", "workflow_run", "workflow_version", "workflow", "domain_event", "task",
    "custom_object_record", "custom_object_type", "custom_field_definition", "integration_event",
  ]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
});

run("defining a kind of record", () => {
  it("is defined once per key, with its fields on object:<key>", async () => {
    await definePermits();
    const [kind] = await objects.listKinds(owner());
    expect(kind).toMatchObject({ key: "permit", label: "Permit", titleLabel: "Permit number", canWrite: true });
    expect(kind!.fields.map((f) => f.key)).toEqual(["fee", "inspected_on", "status"]);
    await expect(objects.defineKind(owner(), { key: "permit", label: "Permit again" }))
      .rejects.toThrow('There is already a kind of record called "permit"');
  });

  it("refuses a definition in words, every problem at once", async () => {
    const issues = await refusal(objects.defineKind(owner(), { key: "Permit!", label: "", links: ["invoice"] }));
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('"Permit!" is not a usable key'),
      "Say what one of these is called, like Permit.",
      expect.stringContaining('"invoice" is not something a record can point at'),
    ]);
  });

  it("will not let its key be changed, and refuses a field on a kind nobody defined", async () => {
    const kind = await definePermits();
    await expect(objects.updateKind(owner(), { id: kind.id, key: "permits" })).rejects.toThrow("key cannot be changed");
    await expect(fields.define(owner(), { entityType: "object:nothing", key: "x", label: "X" }))
      .rejects.toThrow('There is no kind of record called "nothing"');
  });

  it("is defined by whoever may define fields, and nobody else", async () => {
    await expect(objects.defineKind(as(["office_manager"]), { key: "permit", label: "Permit" }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("a record of it", () => {
  it("put on a job, points at that job's customer and address too", async () => {
    await definePermits();
    const { customer, property, job } = await aJob();
    const permit = await objects.createRecord(owner(), {
      type: "permit", title: "BP-2026-114", jobId: job.id,
      customFields: { status: "applied", fee: 125 },
    });
    expect(permit).toMatchObject({
      type: "permit", title: "BP-2026-114",
      job: { id: job.id }, customer: { id: customer.id, name: customer.name }, property: { id: property.id },
      customFields: { status: "applied", fee: 125 },
    });
    const onJob = await objects.recordsFor(owner(), { link: "job", id: job.id });
    expect(onJob).toHaveLength(1);
    expect(onJob[0]!.records.map((r) => r.title)).toEqual(["BP-2026-114"]);
    const onCustomer = await objects.recordsFor(owner(), { link: "customer", id: customer.id });
    expect(onCustomer[0]!.records).toHaveLength(1);
  });

  it("is checked against its fields like any other record, every refusal at once", async () => {
    await definePermits();
    const issues = await refusal(objects.createRecord(owner(), {
      type: "permit", title: " ", customFields: { inspected_on: "soon", fee: "lots" },
    }));
    expect(issues).toEqual([
      { path: "title", message: "Permit number is required." },
      { path: "customFields.fee", message: "Fee has to be a number." },
      { path: "customFields.inspected_on", message: "Inspected on has to be a date like 2026-03-01." },
      { path: "customFields.status", message: "Status is required." },
    ]);
  });

  it("refuses a link its kind does not offer", async () => {
    await objects.defineKind(owner(), { key: "truck_inspection", label: "Truck inspection" });
    const { job } = await aJob();
    expect(await refusal(objects.createRecord(owner(), { type: "truck_inspection", title: "Van 3", jobId: job.id })))
      .toEqual([{ path: "jobId", message: "A truck inspection does not point at a job." }]);
  });

  it("changes, checking only what the change touched, and is searched and filtered", async () => {
    await definePermits();
    const a = await objects.createRecord(owner(), { type: "permit", title: "BP-1", customFields: { status: "applied" } });
    await objects.createRecord(owner(), { type: "permit", title: "BP-2", customFields: { status: "approved", inspected_on: "2026-03-01" } });
    // Status became required after this one was stored without it: an unrelated edit still saves.
    await raw`update public.custom_object_record set custom_fields = '{}'::jsonb where id = ${a.id}`;
    const renamed = await objects.updateRecord(owner(), { id: a.id, title: "BP-1A" });
    expect(renamed.title).toBe("BP-1A");

    expect((await objects.listRecords(owner(), { type: "permit", q: "bp-2" })).data.map((r) => r.title)).toEqual(["BP-2"]);
    expect((await objects.listRecords(owner(), { type: "permit", q: "2026-03" })).data.map((r) => r.title)).toEqual(["BP-2"]);
    expect((await objects.listRecords(owner(), { type: "permit", fieldKey: "status", fieldValue: "approved" }))
      .data.map((r) => r.title)).toEqual(["BP-2"]);

    await objects.removeRecord(owner(), { id: a.id });
    await expect(objects.getRecord(owner(), { id: a.id })).rejects.toBeInstanceOf(NotFoundError);
  });
});

run("who may see and change one", () => {
  it("passes the gate: a technician reads and does not add, the office adds", async () => {
    await definePermits();
    await expect(objects.createRecord(as(["technician"]), { type: "permit", title: "T-1", customFields: { status: "applied" } }))
      .rejects.toMatchObject({ name: "PermissionError", permission: "record:write" });
    const made = await objects.createRecord(as(["csr"]), { type: "permit", title: "C-1", customFields: { status: "applied" } });
    expect(made.title).toBe("C-1");
  });

  it("narrows further when the kind names a permission of its own", async () => {
    await definePermits({ readPermission: "job.cost:read" });
    await objects.createRecord(owner(), { type: "permit", title: "Secret", customFields: { status: "applied" } });
    await expect(objects.listRecords(as(["dispatcher"]), { type: "permit" }))
      .rejects.toMatchObject({ name: "PermissionError", permission: "job.cost:read" });
    expect(await objects.listKinds(as(["dispatcher"]))).toEqual([]);
    expect((await objects.listRecords(as(["office_manager"]), { type: "permit" })).data).toHaveLength(1);
  });

  it("shows somebody whose customers are narrowed only what is on their work, unlinked, or theirs", async () => {
    await definePermits();
    const { job } = await aJob();
    await objects.createRecord(owner(), { type: "permit", title: "On a job", jobId: job.id, customFields: { status: "applied" } });
    await objects.createRecord(owner(), { type: "permit", title: "On nothing", customFields: { status: "applied" } });
    const technician = as(["technician"], { userId: fixtureId("cobj29:tech"), technicianId: fixtureId("cobj29:tech-row") });
    const seen = (await objects.listRecords(technician, { type: "permit" })).data.map((r) => r.title);
    expect(seen).toEqual(["On nothing"]);
  });
});

run("as a spreadsheet", () => {
  it("exports every field and link by name and id, and reads back as the same records", async () => {
    await definePermits();
    const { job } = await aJob();
    await objects.createRecord(owner(), {
      type: "permit", title: "=BP-9", jobId: job.id, customFields: { status: "approved", inspected_on: "2026-04-02", fee: 80.5 },
    });
    const file = await objects.exportCsv(owner(), { type: "permit" });
    expect(file.rows).toBe(1);
    const [header, row] = file.csv.trim().split("\r\n");
    expect(header).toBe("Permit number,Fee,Inspected on,Status,Customer,customer id,Address,property id,Job,job id,Added");
    // A name a spreadsheet would read as a formula is written as text.
    expect(row!.startsWith("'=BP-9,80.5,2026-04-02,approved,")).toBe(true);

    await raw`delete from public.custom_object_record where organization_id = ${ORG}`;
    const loaded = await objects.importCsv(owner(), { type: "permit", csv: file.csv });
    expect(loaded).toEqual({ created: 1, ignoredColumns: ["Customer", "Address", "Job", "Added"] });
    const [back] = (await objects.listRecords(owner(), { type: "permit" })).data;
    expect(back).toMatchObject({ title: "=BP-9", job: { id: job.id }, customFields: { status: "approved", inspected_on: "2026-04-02", fee: 80.5 } });
  });

  it("loads all of a file or none of it, and says what is wrong with each row", async () => {
    await definePermits();
    const csv = "Permit number,Status,Inspected on,Job number\nBP-1,approved,2026-01-02,\nBP-2,maybe,soon,\nBP-3,approved,,99999\n";
    const issues = await refusal(objects.importCsv(owner(), { type: "permit", csv }));
    expect(issues.map((i) => i.message)).toEqual([
      "Row 3: Inspected on has to be a date like 2026-03-01.",
      "Row 3: Status is not one of the options (applied, approved, failed).",
      "Row 4: there is no job 99999.",
    ]);
    expect((await objects.listRecords(owner(), { type: "permit" })).data).toHaveLength(0);
  });
});

run("in the report builder", () => {
  it("is a dataset of its own, counted by a field and totalled by a number field, and the drill adds up", async () => {
    await definePermits();
    for (const [title, status, fee] of [["A", "approved", 100], ["B", "approved", 50], ["C", "failed", 25]] as const) {
      await objects.createRecord(owner(), { type: "permit", title, customFields: { status, fee } });
    }
    const definition = { dataset: "object_permit", dimensions: ["status"], measures: ["count", "cf_fee_sum"] };
    const result = await reports.run(owner(), definition);
    const byStatus = Object.fromEntries(result.rows.map((r) => [r["status"], [Number(r["count"]), Number(r["cf_fee_sum"])]]));
    expect(byStatus).toEqual({ approved: [2, 150], failed: [1, 25] });

    const drilled = await reports.drill(owner(), { definition, match: { status: "approved" } });
    expect(drilled.rows.map((r) => r.label).sort()).toEqual(["A", "B"]);
    expect(drilled.rows[0]!.href).toMatch(/^\/records\/permit\//);
    expect(Number(drilled.totals["cf_fee_sum"])).toBe(150);
  });

  it("is refused to a reader who may not see the kind, naming the permission", async () => {
    await definePermits({ readPermission: "job.cost:read" });
    await expect(reports.run(as(["dispatcher"]), { dataset: "object_permit", dimensions: [], measures: ["count"] }))
      .rejects.toThrow("job.cost:read");
  });

  it("offers a job's custom fields as columns, groupings and filters, and a customer's on the jobs", async () => {
    await fields.define(owner(), { entityType: "job", key: "permit_needed", label: "Permit needed", dataType: "boolean" });
    await fields.define(owner(), { entityType: "customer", key: "tier", label: "Tier", dataType: "select", options: ["gold", "silver"] });
    const first = await aJob();
    await jobs.update(owner(), { id: first.job.id, customFields: { permit_needed: true } });
    await customers.update(owner(), { id: first.customer.id, customFields: { tier: "gold" } });
    await aJob();

    const datasets = await reports.available(owner());
    const jobsDataset = datasets.find((d) => d.key === "jobs")!;
    expect(jobsDataset.dimensions.map((d) => d.label)).toEqual(expect.arrayContaining(["Permit needed", "Customer: Tier"]));

    const grouped = await reports.run(owner(), { dataset: "jobs", dimensions: ["cf_permit_needed"], measures: ["count"] });
    expect(Object.fromEntries(grouped.rows.map((r) => [String(r["cf_permit_needed"]), Number(r["count"])])))
      .toMatchObject({ Yes: 1 });
    const filtered = await reports.run(owner(), {
      dataset: "jobs", dimensions: [], measures: ["count"], filters: [{ dimension: "customer_cf_tier", op: "eq", value: "gold" }],
    });
    expect(Number(filtered.rows[0]!["count"])).toBe(1);
  });
});

run("as an automation's trigger and condition", () => {
  it("starts a workflow on a new permit, and its condition reads the kind and its fields", async () => {
    await definePermits();
    await objects.defineKind(owner(), { key: "truck_inspection", label: "Truck inspection" });
    const flow = await workflows.create(owner(), {
      name: "Book the inspection",
      triggerKind: "event",
      triggerEvents: ["record.created"],
      conditions: { all: [{ path: "record.type", op: "eq", value: "permit" }, { path: "record.fields.status", op: "eq", value: "approved" }] },
      steps: [{ kind: "create_task", config: { title: "Book the inspection for {{record.title}}", queue: "office" } }],
    });
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });

    const permit = await objects.createRecord(owner(), { type: "permit", title: "BP-7", customFields: { status: "approved" } });
    const [event] = await raw<{ id: string; payload: { record: Record<string, unknown> } }[]>`
      select id, payload from public.domain_event
      where organization_id = ${ORG} and name = 'record.created' and entity_id = ${permit.id}`;
    expect(event!.payload.record).toMatchObject({ type: "permit", title: "BP-7", fields: { status: "approved" } });
    expect(await handleEvent(owner(), event!.id)).toEqual([expect.objectContaining({ status: "succeeded" })]);
    const tasks = await raw<{ title: string }[]>`select title from public.task where organization_id = ${ORG}`;
    expect(tasks.map((t) => t.title)).toEqual(["Book the inspection for BP-7"]);

    await objects.createRecord(owner(), { type: "truck_inspection", title: "Van 3" });
    const [other] = await raw<{ id: string }[]>`
      select id from public.domain_event where organization_id = ${ORG} and name = 'record.created'
      order by sequence desc limit 1`;
    expect(await handleEvent(owner(), other!.id)).toEqual([expect.objectContaining({ status: "skipped", reason: "conditions_unmet" })]);
  });

  it("emits the values before and after a change, so a condition can wait for a status to become something", async () => {
    await definePermits();
    const permit = await objects.createRecord(owner(), { type: "permit", title: "BP-8", customFields: { status: "applied" } });
    await objects.updateRecord(owner(), { id: permit.id, customFields: { status: "approved" } });
    const [event] = await raw<{ payload: { record: { fields: Record<string, unknown> }; previous: { record: { fields: Record<string, unknown> } } } }[]>`
      select payload from public.domain_event where organization_id = ${ORG} and name = 'record.updated'`;
    expect(event!.payload.record.fields).toEqual({ status: "approved" });
    expect(event!.payload.previous.record.fields).toEqual({ status: "applied" });
  });
});

run("in the company's data export", () => {
  it("is in the manifest with its rows counted", async () => {
    await definePermits();
    await objects.createRecord(owner(), { type: "permit", title: "BP-X", customFields: { status: "applied" } });
    const manifest = await dataExport.manifest(owner());
    expect(manifest.tables.find((t) => t.table === "custom_object_record")?.rows).toBe(1);
    expect(manifest.tables.find((t) => t.table === "custom_object_type")?.rows).toBe(1);
  });
});
