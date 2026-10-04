import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as fields from "../src/services/custom-fields";
import * as jobs from "../src/services/jobs";
import * as objects from "../src/services/custom-objects";
import * as reports from "../src/services/reports";
import { dispatch } from "../src/http/dispatch";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * SEVERAL FIELDS AT ONCE, ON THE LISTS AND IN THE REPORT BUILDER
 *
 * One field holding one value was the whole of what a list could be narrowed
 * by. "Customers on the Annual plan who have pets" is two, and both have to
 * hold. The report builder had the fields of the record a dataset is a row
 * of, and the customer's on three datasets; a visit could not be counted by
 * its customer's plan, nor a job by its address's gate type, nor a call by
 * anything at all. Every dataset whose rows hang off a record with fields now
 * filters by them.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cf-multi:org");
const OWNER = fixtureId("cf-multi:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

/** Three households: Annual with pets, Annual without, Monthly with. */
const people: Record<"andy" | "bea" | "mo", { customer: string; property: string; job: string }> = {
  andy: { customer: "", property: "", job: "" },
  bea: { customer: "", property: "", job: "" },
  mo: { customer: "", property: "", job: "" },
};
let visitId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Multi Filter Co", slug: "cf-multi-co" });
  const o = owner();
  await fields.define(o, { entityType: "customer", key: "plan", label: "Plan", dataType: "select", options: ["Annual", "Monthly"] });
  await fields.define(o, { entityType: "customer", key: "has_pets", label: "Pets", dataType: "boolean" });
  await fields.define(o, { entityType: "customer", key: "gate_note", label: "Gate note", dataType: "text" });
  await fields.define(o, { entityType: "property", key: "gate_type", label: "Gate type", dataType: "select", options: ["Code", "Key"] });
  await fields.define(o, { entityType: "job", key: "permit", label: "Permit", dataType: "select", options: ["Submitted", "Approved"] });
  await fields.define(o, { entityType: "job", key: "zone", label: "Zone", dataType: "text" });
  await fields.define(o, { entityType: "technician", key: "shirt", label: "Shirt", dataType: "select", options: ["M", "L"] });
  await fields.define(o, { entityType: "equipment", key: "filter_size", label: "Filter size", dataType: "text" });

  const household = async (name: string, values: Record<string, unknown>, gate: string, permit: string, zone: string) => {
    const customer = (await customers.create(o, {
      type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: values,
    })).id;
    const [property] = await raw<{ id: string }[]>`
      insert into public.property (organization_id, address_line1, city, state, postal_code, custom_fields)
      values (${ORG}, ${`${name} St`}, 'Austin', 'TX', '78701', ${raw.json({ gate_type: gate })}) returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customer}, ${property!.id})`;
    const job = await jobs.create(o, { customerId: customer, propertyId: property!.id, summary: `${name} tune up`, tags: [], customFields: { permit, zone } });
    return { customer, property: property!.id, job: job.id };
  };
  people.andy = await household("Andy", { plan: "Annual", has_pets: true, gate_note: "Gate: 4471" }, "Code", "Submitted", "North");
  people.bea = await household("Bea", { plan: "Annual", has_pets: false }, "Key", "Approved", "North");
  people.mo = await household("Mo", { plan: "Monthly", has_pets: true }, "Key", "Submitted", "South");

  // A visit on Andy's job led by a technician in a large shirt, and a call from Andy about it.
  const [membership] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${OWNER}`;
  const [technician] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, custom_fields)
    values (${ORG}, ${membership!.id}, 'Lee', ${raw.json({ shirt: "L" })}) returning id`;
  const [visit] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, window_start)
    values (${ORG}, ${people.andy.job}, now()) returning id`;
  visitId = visit!.id;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
    values (${ORG}, ${visitId}, ${technician!.id}, true)`;
  await raw`insert into public.visit (organization_id, job_id, window_start) values (${ORG}, ${people.mo.job}, now())`;
  await raw`insert into public.call (organization_id, direction, from_e164, to_e164, status, customer_id, job_id, started_at)
    values (${ORG}, 'inbound', '+15125550111', '+15125550199', 'completed', ${people.andy.customer}, ${people.andy.job}, now())`;
  await raw`insert into public.call (organization_id, direction, from_e164, to_e164, status, customer_id, started_at)
    values (${ORG}, 'inbound', '+15125550112', '+15125550199', 'completed', ${people.mo.customer}, now())`;

  // A kind of record that points at all four things a record can.
  await objects.defineKind(o, {
    key: "permit", label: "Permit", pluralLabel: "Permits", titleLabel: "Permit number",
    links: ["customer", "property", "job", "equipment"],
  });
  await fields.define(o, { entityType: "object:permit", key: "status", label: "Status", dataType: "select", options: ["applied", "approved"] });
  await fields.define(o, { entityType: "object:permit", key: "inspector", label: "Inspector", dataType: "text" });
  const [unit] = await raw<{ id: string }[]>`insert into public.equipment (organization_id, property_id, category, custom_fields)
    values (${ORG}, ${people.andy.property}, 'furnace', ${raw.json({ filter_size: "16x25x1" })}) returning id`;
  await objects.createRecord(o, {
    type: "permit", title: "BP-1", customerId: people.andy.customer, propertyId: people.andy.property,
    jobId: people.andy.job, equipmentId: unit!.id, customFields: { status: "applied", inspector: "Ruiz" },
  });
  await objects.createRecord(o, {
    type: "permit", title: "BP-2", customerId: people.mo.customer, customFields: { status: "applied", inspector: "Kim" },
  });
});

afterAll(async () => { if (raw) await raw.end(); });

const customerNames = async (input: { fields?: string[]; fieldKey?: string; fieldValue?: string }) =>
  (await customers.list(owner(), { limit: 100, includeInactive: false, ...input })).data.map((c) => c.name).sort();

run("filtering a list by several fields", () => {
  it("narrows customers to the ones every field holds for", async () => {
    expect(await customerNames({ fields: ["plan:Annual"] })).toEqual(["Andy", "Bea"]);
    expect(await customerNames({ fields: ["plan:Annual", "has_pets:yes"] })).toEqual(["Andy"]);
    expect(await customerNames({ fields: ["plan:Monthly", "has_pets:no"] })).toEqual([]);
  });

  it("takes the old single field beside the new ones, and a value with a colon in it", async () => {
    expect(await customerNames({ fieldKey: "has_pets", fieldValue: "yes", fields: ["plan:Annual"] })).toEqual(["Andy"]);
    expect(await customerNames({ fields: ["gate_note:Gate: 44"] })).toEqual(["Andy"]);
  });

  it("refuses a filter that is not key:value, a field nobody declared, and more than ten, naming the problem", async () => {
    await expect(customerNames({ fields: ["plan"] })).rejects.toThrow(/key, a colon, and the value/);
    await expect(customerNames({ fields: [":Annual"] })).rejects.toBeInstanceOf(ConflictError);
    await expect(customerNames({ fields: ["plan:Annual", "warranty:yes"] })).rejects.toThrow(/no customer field called "warranty"/);
    await expect(customerNames({ fields: Array.from({ length: 11 }, () => "plan:Annual") })).rejects.toThrow(/10 fields at once/);
  });

  it("reads repeated fields off the query string over HTTP", async () => {
    const response = await dispatch(new Request("http://x/v1/customers?fields=plan%3AAnnual&fields=has_pets%3Ayes"), {
      db: db(), resolveSession: async () => owner(),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { name: string }[] };
    expect(body.data.map((c) => c.name)).toEqual(["Andy"]);
  });

  it("works the same on the other lists: jobs, and a kind of record", async () => {
    const jobSummaries = (await jobs.list(owner(), { limit: 100, fields: ["permit:Submitted", "zone:north"] })).data
      .map((j) => j.summary);
    expect(jobSummaries).toEqual(["Andy tune up"]);
    const permits = (await objects.listRecords(owner(), { type: "permit", fields: ["status:applied", "inspector:kim"] })).data
      .map((r) => r.title);
    expect(permits).toEqual(["BP-2"]);
  });
});

run("the report builder, on every dataset with fields to filter by", () => {
  const count = async (dataset: string, filters: { dimension: string; value: string }[]) => {
    const result = await reports.run(owner(), {
      dataset, dimensions: [], measures: ["count"],
      filters: filters.map((f) => ({ dimension: f.dimension, op: "eq" as const, value: f.value })),
    });
    return Number(result.rows[0]?.["count"] ?? 0);
  };

  it("offers the fields of every record a row hangs off, named for the record", async () => {
    const catalogue = await reports.available(owner());
    const keysOf = (dataset: string) => new Set(catalogue.find((d) => d.key === dataset)!.dimensions.map((d) => d.key));
    const expected: Record<string, string[]> = {
      jobs: ["cf_permit", "customer_cf_plan", "address_cf_gate_type"],
      profitability: ["cf_permit", "customer_cf_plan", "address_cf_gate_type"],
      invoices: ["customer_cf_plan", "address_cf_gate_type", "job_cf_permit"],
      estimates: ["customer_cf_plan", "address_cf_gate_type", "job_cf_permit"],
      visits: ["job_cf_permit", "customer_cf_plan", "address_cf_gate_type", "technician_cf_shirt"],
      calls: ["customer_cf_plan", "job_cf_permit"],
      object_permit: ["status", "customer_cf_plan", "address_cf_gate_type", "job_cf_permit", "unit_cf_filter_size"],
    };
    for (const [dataset, keys] of Object.entries(expected)) {
      const offered = keysOf(dataset);
      for (const key of keys) expect(offered.has(key), `${dataset} offers ${key}`).toBe(true);
    }
    const label = catalogue.find((d) => d.key === "visits")!.dimensions.find((d) => d.key === "technician_cf_shirt")!.label;
    expect(label).toBe("Technician: Shirt");
  });

  it("counts by them, two at once, on each dataset", async () => {
    expect(await count("jobs", [{ dimension: "customer_cf_plan", value: "Annual" }])).toBe(2);
    expect(await count("jobs", [
      { dimension: "customer_cf_plan", value: "Annual" }, { dimension: "address_cf_gate_type", value: "Key" },
    ])).toBe(1);
    expect(await count("profitability", [{ dimension: "address_cf_gate_type", value: "Key" }])).toBe(2);
    expect(await count("visits", [{ dimension: "customer_cf_plan", value: "Annual" }])).toBe(1);
    expect(await count("visits", [
      { dimension: "job_cf_permit", value: "Submitted" }, { dimension: "technician_cf_shirt", value: "L" },
    ])).toBe(1);
    expect(await count("calls", [{ dimension: "customer_cf_plan", value: "Monthly" }])).toBe(1);
    expect(await count("calls", [{ dimension: "job_cf_permit", value: "Submitted" }])).toBe(1);
    expect(await count("object_permit", [
      { dimension: "status", value: "applied" }, { dimension: "unit_cf_filter_size", value: "16x25x1" },
    ])).toBe(1);
    expect(await count("object_permit", [{ dimension: "address_cf_gate_type", value: "Code" }])).toBe(1);
    // Nothing on the books for these yet, and the query still has to be a good one.
    expect(await count("invoices", [{ dimension: "job_cf_permit", value: "Submitted" }])).toBe(0);
    expect(await count("estimates", [{ dimension: "address_cf_gate_type", value: "Code" }])).toBe(0);
  });

  it("holds a filter to the permission of the record it reads, as a grouping is", async () => {
    // A dispatcher reads visits and not the staff file, so a technician's fields are not theirs to count by.
    await expect(reports.run(as(["dispatcher"]), {
      dataset: "visits", dimensions: [], measures: ["count"],
      filters: [{ dimension: "technician_cf_shirt", op: "eq", value: "L" }],
    })).rejects.toThrow(/user:read/);
  });
});
