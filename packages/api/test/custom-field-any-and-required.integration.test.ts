import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as equipment from "../src/services/equipment";
import * as estimates from "../src/services/estimates";
import * as fields from "../src/services/custom-fields";
import * as jobs from "../src/services/jobs";
import * as reports from "../src/services/reports";
import { dispatch } from "../src/http/dispatch";
import { ConflictError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * "ANY OF THESE" ACROSS FIELDS, AND THE COMPANY'S REQUIRED FIELDS AT CREATE
 *
 * Two things the custom fields could not do. A list joined several fields by
 * AND and only AND, so "customers on the Annual plan or with pets" was two
 * lists and a spreadsheet. And an invoice, an estimate, a visit and a unit
 * could carry a required field that nothing asked for until somebody opened
 * the record afterwards and found it blank.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cf-any:org");
const OWNER = fixtureId("cf-any:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

const people: Record<"andy" | "bea" | "mo" | "cy", { customer: string; property: string; job: string }> = {
  andy: { customer: "", property: "", job: "" },
  bea: { customer: "", property: "", job: "" },
  mo: { customer: "", property: "", job: "" },
  cy: { customer: "", property: "", job: "" },
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Any Of These Co", slug: "cf-any-co" });
  const o = owner();
  await fields.define(o, { entityType: "customer", key: "plan", label: "Plan", dataType: "select", options: ["Annual", "Monthly"] });
  await fields.define(o, { entityType: "customer", key: "has_pets", label: "Pets", dataType: "boolean" });
  await fields.define(o, { entityType: "customer", key: "region", label: "Region", dataType: "select", options: ["North", "South"] });

  const household = async (name: string, values: Record<string, unknown>) => {
    const customer = (await customers.create(o, {
      type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: values,
    })).id;
    const [property] = await raw<{ id: string }[]>`
      insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, ${`${name} St`}, 'Austin', 'TX', '78701') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customer}, ${property!.id})`;
    const job = await jobs.create(o, { customerId: customer, propertyId: property!.id, summary: `${name} tune up`, tags: [], customFields: {} });
    return { customer, property: property!.id, job: job.id };
  };
  people.andy = await household("Andy", { plan: "Annual", has_pets: true, region: "North" });
  people.bea = await household("Bea", { plan: "Annual", has_pets: false, region: "North" });
  people.mo = await household("Mo", { plan: "Monthly", has_pets: true, region: "South" });
  people.cy = await household("Cy", { plan: "Monthly", has_pets: false, region: "South" });
});

afterAll(async () => { if (raw) await raw.end(); });

const names = async (input: { fields?: string[]; fieldMatch?: "all" | "any"; fieldKey?: string; fieldValue?: string }) =>
  (await customers.list(owner(), { limit: 100, includeInactive: false, ...input })).data.map((c) => c.name).sort();

run("any of these, across fields, on the customer list", () => {
  it("joins the fields by OR when asked, and by AND otherwise", async () => {
    expect(await names({ fields: ["plan:Annual", "has_pets:yes"] })).toEqual(["Andy"]);
    expect(await names({ fields: ["plan:Annual", "has_pets:yes"], fieldMatch: "all" })).toEqual(["Andy"]);
    expect(await names({ fields: ["plan:Annual", "has_pets:yes"], fieldMatch: "any" })).toEqual(["Andy", "Bea", "Mo"]);
    expect(await names({ fields: ["plan:Monthly", "region:North"], fieldMatch: "any" })).toEqual(["Andy", "Bea", "Cy", "Mo"]);
  });

  it("is the same list with one field, and with none", async () => {
    expect(await names({ fields: ["plan:Annual"], fieldMatch: "any" })).toEqual(["Andy", "Bea"]);
    expect(await names({ fieldMatch: "any" })).toEqual(["Andy", "Bea", "Cy", "Mo"]);
  });

  it("takes the old single field beside the new ones as one more of the alternatives", async () => {
    expect(await names({ fieldKey: "region", fieldValue: "South", fields: ["plan:Annual"], fieldMatch: "any" }))
      .toEqual(["Andy", "Bea", "Cy", "Mo"]);
    expect(await names({ fieldKey: "region", fieldValue: "South", fields: ["plan:Annual"] })).toEqual([]);
  });

  it("still refuses a field nobody declared, and a value its type cannot hold, in words", async () => {
    await expect(names({ fields: ["plan:Annual", "warranty:yes"], fieldMatch: "any" })).rejects.toThrow(/no customer field called "warranty"/);
    await expect(names({ fields: ["plan:Annual", "has_pets:maybe"], fieldMatch: "any" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("is read off the query string over HTTP, and refuses a word it does not know", async () => {
    const ask = (query: string) => dispatch(new Request(`http://x/v1/customers?${query}`), {
      db: db(), resolveSession: async () => owner(),
    });
    const response = await ask("fields=plan%3AAnnual&fields=has_pets%3Ayes&fieldMatch=any");
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { name: string }[] };
    expect(body.data.map((c) => c.name).sort()).toEqual(["Andy", "Bea", "Mo"]);
    expect((await ask("fields=plan%3AAnnual&fieldMatch=either")).status).toBe(422);
  });
});

run("any of these, across fields, in the report builder", () => {
  const count = async (filters: { dimension: string; value: string }[], fieldMatch?: "all" | "any", extra: { dimension: string; value: string }[] = []) => {
    const result = await reports.run(owner(), {
      dataset: "jobs", dimensions: [], measures: ["count"],
      filters: [...filters, ...extra].map((f) => ({ dimension: f.dimension, op: "eq" as const, value: f.value })),
      ...(fieldMatch ? { fieldMatch } : {}),
    });
    return Number(result.rows[0]?.["count"] ?? 0);
  };
  const both = [{ dimension: "customer_cf_plan", value: "Annual" }, { dimension: "customer_cf_region", value: "South" }];

  it("counts the jobs either field matches when asked, and the jobs both match otherwise", async () => {
    expect(await count(both)).toBe(0);
    expect(await count(both, "all")).toBe(0);
    expect(await count(both, "any")).toBe(4);
    expect(await count([{ dimension: "customer_cf_plan", value: "Annual" }], "any")).toBe(2);
  });

  it("leaves a filter that is not a field joined by AND, whatever the fields are joined by", async () => {
    expect(await count(both, "any", [{ dimension: "status", value: "no_such_status" }])).toBe(0);
  });

  it("opens the same records on the drill as the count", async () => {
    const definition = {
      dataset: "jobs", dimensions: [] as string[], measures: ["count"],
      filters: both.map((f) => ({ dimension: f.dimension, op: "eq" as const, value: f.value })),
      fieldMatch: "any" as const,
    };
    const drilled = await reports.drill(owner(), { definition, match: {} });
    expect(drilled.count).toBe(4);
    expect(drilled.rows).toHaveLength(4);
  });
});

run("a company's required fields, asked for when the record is made", () => {
  const ctxFor = (key: string): ServiceContext => ({ ...owner(), idempotencyKey: `cf-any-${key}-${Date.now()}-${Math.random()}` });

  beforeEach(async () => {
    if (!url) return;
    await raw`delete from public.custom_field_definition where organization_id = ${ORG} and entity_type in ('invoice', 'estimate', 'visit', 'equipment')`;
  });

  const invoiceInput = () => ({
    customerId: people.andy.customer, jobId: people.andy.job,
    lines: [{ name: "Service call", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: false }],
  });
  const estimateInput = () => ({
    customerId: people.andy.customer, propertyId: people.andy.property, taxRate: "0",
    options: [{ name: "Fix it", isRecommended: true, lines: [{
      name: "Repair", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false,
    }] }],
  });

  async function refusal(write: Promise<unknown>) {
    const error = await write.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableError);
    return (error as UnprocessableError).issues;
  }

  it("refuses an invoice without its required field, in words, and files it with one", async () => {
    await fields.define(owner(), { entityType: "invoice", key: "po_number", label: "PO number", required: true });
    expect(await refusal(billing.create(owner(), invoiceInput(), { requireFields: true })))
      .toEqual([{ path: "customFields.po_number", message: "PO number is required." }]);
    expect(await refusal(billing.create(owner(), { ...invoiceInput(), customFields: { po_number: "  " } }, { requireFields: true })))
      .toEqual([{ path: "customFields.po_number", message: "PO number is required." }]);
    const made = await billing.create(owner(), { ...invoiceInput(), customFields: { po_number: "PO-9" } }, { requireFields: true });
    expect((await billing.get(owner(), { id: made.id })).customFields).toEqual({ po_number: "PO-9" });
    const [{ n } = { n: -1 }] = await raw<{ n: number }[]>`select count(*)::int as n from public.invoice where organization_id = ${ORG} and custom_fields = '{}'::jsonb`;
    expect(n).toBe(0);
  });

  it("refuses an estimate, a visit and a unit the same way, every missing field at once", async () => {
    await fields.define(owner(), { entityType: "estimate", key: "promo", label: "Promo", dataType: "select", options: ["spring", "fall"], required: true });
    await fields.define(owner(), { entityType: "estimate", key: "lead", label: "Lead", required: true });
    expect(await refusal(estimates.create(owner(), estimateInput(), { requireFields: true })))
      .toEqual([
        { path: "customFields.lead", message: "Lead is required." },
        { path: "customFields.promo", message: "Promo is required." },
      ]);
    expect(await refusal(estimates.create(owner(), { ...estimateInput(), customFields: { promo: "winter", lead: "web" } }, { requireFields: true })))
      .toEqual([{ path: "customFields.promo", message: "Promo is not one of the options (spring, fall)." }]);
    const estimate = await estimates.create(owner(), { ...estimateInput(), customFields: { promo: "spring", lead: "web" } }, { requireFields: true });
    expect((await estimates.get(owner(), { id: estimate.id })).customFields).toEqual({ promo: "spring", lead: "web" });

    await fields.define(owner(), { entityType: "visit", key: "gate_code", label: "Gate code", required: true });
    expect(await refusal(jobs.addVisit(owner(), { id: people.bea.job, technicianIds: [], estimatedDurationMinutes: 60 }, { requireFields: true })))
      .toEqual([{ path: "customFields.gate_code", message: "Gate code is required." }]);
    const visit = await jobs.addVisit(owner(), {
      id: people.bea.job, technicianIds: [], estimatedDurationMinutes: 60, customFields: { gate_code: "4471" },
    }, { requireFields: true });
    const [stored] = await raw<{ custom_fields: unknown }[]>`select custom_fields from public.visit where id = ${visit.id}`;
    expect(stored!.custom_fields).toEqual({ gate_code: "4471" });

    await fields.define(owner(), { entityType: "equipment", key: "filter_size", label: "Filter size", required: true });
    const unit = { propertyId: people.mo.property, category: "furnace" };
    expect(await refusal(equipment.register(owner(), unit, { requireFields: true })))
      .toEqual([{ path: "customFields.filter_size", message: "Filter size is required." }]);
    const made = await equipment.register(owner(), { ...unit, customFields: { filter_size: "16x25x1" } }, { requireFields: true });
    const [unitRow] = await raw<{ custom_fields: unknown }[]>`select custom_fields from public.equipment where id = ${made.id}`;
    expect(unitRow!.custom_fields).toEqual({ filter_size: "16x25x1" });
  });

  it("is asked on the routes: a 422 naming each field, and a 201 once they are given", async () => {
    await fields.define(owner(), { entityType: "invoice", key: "po_number", label: "PO number", required: true });
    const post = (path: string, body: unknown, key: string) => dispatch(new Request(`http://x${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `cf-any-${key}-${Date.now()}-${Math.random()}` },
      body: JSON.stringify(body),
    }), { db: db(), resolveSession: async () => owner() });

    const refused = await post("/v1/invoices", invoiceInput(), "inv-1");
    expect(refused.status).toBe(422);
    const problem = await refused.json() as { issues?: { path: string; message: string }[]; errors?: { path: string; message: string }[] };
    expect(JSON.stringify(problem)).toContain("customFields.po_number");
    expect(JSON.stringify(problem)).toContain("PO number is required.");

    const accepted = await post("/v1/invoices", { ...invoiceInput(), customFields: { po_number: "PO-77" } }, "inv-2");
    expect(accepted.status).toBe(201);
    const invoice = await accepted.json() as { customFields: Record<string, unknown> };
    expect(invoice.customFields).toEqual({ po_number: "PO-77" });
  });

  it("leaves a record the product makes by itself with none, as it always did", async () => {
    await fields.define(owner(), { entityType: "invoice", key: "po_number", label: "PO number", required: true });
    await fields.define(owner(), { entityType: "estimate", key: "promo", label: "Promo", required: true });
    await fields.define(owner(), { entityType: "visit", key: "gate_code", label: "Gate code", required: true });
    await fields.define(owner(), { entityType: "equipment", key: "filter_size", label: "Filter size", required: true });

    // Called the way the product's own jobs call them: no one is filling in a form.
    const invoice = await billing.create(ctxFor("auto-inv"), invoiceInput());
    expect((await billing.get(owner(), { id: invoice.id })).customFields).toEqual({});
    const estimate = await estimates.create(ctxFor("auto-est"), estimateInput());
    expect((await estimates.get(owner(), { id: estimate.id })).customFields).toEqual({});
    const visit = await jobs.addVisit(ctxFor("auto-visit"), { id: people.cy.job, technicianIds: [], estimatedDurationMinutes: 60 });
    const [stored] = await raw<{ custom_fields: unknown }[]>`select custom_fields from public.visit where id = ${visit.id}`;
    expect(stored!.custom_fields).toEqual({});
    const unit = await equipment.register(owner(), { propertyId: people.cy.property, category: "boiler" });
    const [unitRow] = await raw<{ custom_fields: unknown }[]>`select custom_fields from public.equipment where id = ${unit.id}`;
    expect(unitRow!.custom_fields).toEqual({});

    // The first visit booked together with a new job is the job's, not a visit form: it starts with none.
    const booked = await jobs.create(owner(), {
      customerId: people.cy.customer, propertyId: people.cy.property, summary: "Booked with a visit", tags: [], customFields: {},
      visit: { windowStart: new Date(Date.now() + 86_400_000).toISOString(), windowEnd: new Date(Date.now() + 90_000_000).toISOString(), technicianIds: [], estimatedDurationMinutes: 60 },
    });
    expect(booked.visits).toHaveLength(1);
  });

  it("asks for nothing when the company declared nothing", async () => {
    const made = await billing.create(owner(), invoiceInput(), { requireFields: true });
    expect((await billing.get(owner(), { id: made.id })).customFields).toEqual({});
  });
});
