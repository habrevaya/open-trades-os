import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as fields from "../src/services/custom-fields";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import * as jobs from "../src/services/jobs";
import * as properties from "../src/services/properties";
import * as people from "../src/services/people";
import * as reports from "../src/services/reports";
import { NotFoundError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * CUSTOM FIELDS ON THE FIVE RECORDS THAT HAD NONE
 *
 * An invoice's purchase order number, an estimate's financing promo code, a
 * visit's arrival photo checklist answer, a unit's filter size, a
 * technician's shirt size: each was a note in a free text box or nowhere. A
 * definition on any of them now binds the write that saves its values, under
 * that record's own permission and scope, filters the lists that hold them,
 * and is a column in the report builder.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cfe5:org");
const USER = fixtureId("cfe5:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";
let jobId = "";
let technicianId = "";

async function refusal(write: Promise<unknown>) {
  const error = await write.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(UnprocessableError);
  return (error as UnprocessableError).issues;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Fields Co", slug: "fields-everywhere" });
  const [c] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Ada Field') returning id`;
  customerId = c!["id"];
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '5 Field Ln', 'Austin', 'TX', '78701') returning id`;
  propertyId = p!["id"];
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${propertyId})`;
  const job = await jobs.create(owner(), { customerId, propertyId, summary: "Tune up", tags: [], customFields: {} });
  jobId = job.id;
  const [m] = await raw`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!["id"]}, 'Ada') returning id`;
  technicianId = t!["id"];
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.custom_field_definition where organization_id = ${ORG}`;
});

async function anInvoice() {
  return billing.create(owner(), {
    customerId, jobId,
    lines: [{ name: "Service call", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: false }],
  });
}

async function anEstimate() {
  return estimates.create(owner(), {
    customerId, propertyId, jobId, taxRate: "0",
    options: [{ name: "Fix it", isRecommended: true, lines: [{
      name: "Repair", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false,
    }] }],
  });
}

run("each of the five", () => {
  it("can carry a field, and saving one is held to its definition", async () => {
    await fields.define(owner(), { entityType: "invoice", key: "po_number", label: "PO number", required: true });
    const invoice = await anInvoice();
    expect(await refusal(fields.setValues(owner(), { entityType: "invoice", id: invoice.id, values: { po_number: " " } })))
      .toEqual([{ path: "customFields.po_number", message: "PO number is required." }]);
    const saved = await fields.setValues(owner(), { entityType: "invoice", id: invoice.id, values: { po_number: "PO-55" } });
    expect(saved.customFields).toEqual({ po_number: "PO-55" });
    expect((await billing.get(owner(), { id: invoice.id })).customFields).toEqual({ po_number: "PO-55" });
  });

  it("checks types on every one of them, one sentence per field", async () => {
    await fields.define(owner(), { entityType: "estimate", key: "promo", label: "Promo", dataType: "select", options: ["spring"] });
    await fields.define(owner(), { entityType: "visit", key: "arrived_photo", label: "Arrival photo taken", dataType: "boolean" });
    await fields.define(owner(), { entityType: "equipment", key: "filter_size", label: "Filter size", dataType: "text" });
    await fields.define(owner(), { entityType: "technician", key: "shirt", label: "Shirt size", dataType: "select", options: ["M", "L"] });

    const estimate = await anEstimate();
    expect(await refusal(fields.setValues(owner(), { entityType: "estimate", id: estimate.id, values: { promo: "winter" } })))
      .toEqual([{ path: "customFields.promo", message: "Promo is not one of the options (spring)." }]);

    const [visit] = await raw`insert into public.visit (organization_id, job_id) values (${ORG}, ${jobId}) returning id`;
    expect(await refusal(fields.setValues(owner(), { entityType: "visit", id: visit!["id"], values: { arrived_photo: "yes" } })))
      .toEqual([{ path: "customFields.arrived_photo", message: "Arrival photo taken has to be true or false." }]);
    expect((await fields.setValues(owner(), { entityType: "visit", id: visit!["id"], values: { arrived_photo: true } })).customFields)
      .toEqual({ arrived_photo: true });

    const [unit] = await raw`insert into public.equipment (organization_id, property_id, category) values (${ORG}, ${propertyId}, 'furnace') returning id`;
    expect((await fields.setValues(owner(), { entityType: "equipment", id: unit!["id"], values: { filter_size: "16x25x1" } })).customFields)
      .toEqual({ filter_size: "16x25x1" });

    expect(await refusal(fields.setValues(owner(), { entityType: "technician", id: technicianId, values: { shirt: "XXL" } })))
      .toEqual([{ path: "customFields.shirt", message: "Shirt size is not one of the options (M, L)." }]);
  });

  it("is saved under the record's own permission and scope", async () => {
    await fields.define(owner(), { entityType: "invoice", key: "po_number", label: "PO number" });
    const invoice = await anInvoice();
    /** A technician reads invoices on their own work and changes none. */
    await expect(fields.setValues(as(["technician"]), { entityType: "invoice", id: invoice.id, values: { po_number: "x" } }))
      .rejects.toBeInstanceOf(PermissionError);
    /**
     * A technician granted visit:write still writes only on their own visits:
     * this one is nobody's, so it reads as not found rather than as refused.
     */
    const [visit] = await raw`insert into public.visit (organization_id, job_id) values (${ORG}, ${jobId}) returning id`;
    const narrowed = as(["technician"], { technicianId: fixtureId("cfe5:other"), grants: ["visit:write"] });
    await expect(fields.setValues(narrowed, { entityType: "visit", id: visit!["id"], values: {} }))
      .rejects.toBeInstanceOf(NotFoundError);
    await expect(fields.setValues(as(["dispatcher"]), { entityType: "visit", id: visit!["id"], values: {} }))
      .resolves.toMatchObject({ id: visit!["id"] });
    await expect(fields.setValues(owner(), { entityType: "invoice", id: fixtureId("cfe5:none"), values: {} }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not refuse a record for a field it never touched", async () => {
    const invoice = await anInvoice();
    await fields.define(owner(), { entityType: "invoice", key: "po_number", label: "PO number", required: true });
    await fields.define(owner(), { entityType: "invoice", key: "terms_code", label: "Terms code" });
    /** PO number was required after this invoice existed; filling in another field still saves. */
    const saved = await fields.setValues(owner(), { entityType: "invoice", id: invoice.id, values: { terms_code: "N30" } });
    expect(saved.customFields).toEqual({ terms_code: "N30" });
  });
});

run("filtering the lists that hold them", () => {
  it("narrows jobs, invoices, estimates, addresses and technicians, and refuses a key nobody declared", async () => {
    await fields.define(owner(), { entityType: "invoice", key: "po_number", label: "PO number" });
    await fields.define(owner(), { entityType: "estimate", key: "promo", label: "Promo", dataType: "select", options: ["spring"] });
    await fields.define(owner(), { entityType: "job", key: "permit_needed", label: "Permit needed", dataType: "boolean" });
    await fields.define(owner(), { entityType: "property", key: "gate", label: "Gate code" });
    await fields.define(owner(), { entityType: "technician", key: "shirt", label: "Shirt size", dataType: "select", options: ["M", "L"] });

    const tagged = await anInvoice();
    await anInvoice();
    await fields.setValues(owner(), { entityType: "invoice", id: tagged.id, values: { po_number: "PO-778" } });
    const invoices = await billing.list(owner(), { limit: 50, fieldKey: "po_number", fieldValue: "778" });
    expect(invoices.data.map((i) => i.id)).toEqual([tagged.id]);

    const promoted = await anEstimate();
    await anEstimate();
    await fields.setValues(owner(), { entityType: "estimate", id: promoted.id, values: { promo: "spring" } });
    expect((await estimates.list(owner(), { limit: 50, fieldKey: "promo", fieldValue: "spring" })).data.map((e) => e.id))
      .toEqual([promoted.id]);

    await jobs.update(owner(), { id: jobId, customFields: { permit_needed: true } });
    expect((await jobs.list(owner(), { limit: 50, fieldKey: "permit_needed", fieldValue: "yes" })).data.map((j) => j.id))
      .toEqual([jobId]);

    await properties.update(owner(), { id: propertyId, customFields: { gate: "4411" } });
    expect((await properties.list(owner(), { limit: 50, fieldKey: "gate", fieldValue: "4411" })).data.map((p) => p.id))
      .toEqual([propertyId]);

    await fields.setValues(owner(), { entityType: "technician", id: technicianId, values: { shirt: "L" } });
    expect((await people.listPeople(owner(), { fieldKey: "shirt", fieldValue: "L" })).map((p) => p.technicianId))
      .toEqual([technicianId]);
    expect(await people.listPeople(owner(), { fieldKey: "shirt", fieldValue: "M" })).toEqual([]);

    await expect(billing.list(owner(), { limit: 50, fieldKey: "nope", fieldValue: "x" }))
      .rejects.toThrow('There is no invoice field called "nope"');
    await expect(billing.list(owner(), { limit: 50, fieldKey: "po_number" })).rejects.toThrow("needs both");
  });
});

run("in the report builder", () => {
  it("groups invoices by their own field and reads the drill back to the same invoices", async () => {
    await fields.define(owner(), { entityType: "invoice", key: "po_number", label: "PO number" });
    const a = await anInvoice();
    await fields.setValues(owner(), { entityType: "invoice", id: a.id, values: { po_number: "PO-1" } });
    const definition = { dataset: "invoices", dimensions: ["cf_po_number"], measures: ["count"] };
    const result = await reports.run(owner(), definition);
    const byPo = Object.fromEntries(result.rows.map((r) => [String(r["cf_po_number"]), Number(r["count"])]));
    expect(byPo["PO-1"]).toBe(1);
    const drilled = await reports.drill(owner(), { definition, match: { cf_po_number: "PO-1" } });
    expect(drilled.rows.map((r) => r.id)).toEqual([a.id]);
  });

  it("saves a report built on a custom field, and refuses one on a field that does not exist", async () => {
    await fields.define(owner(), { entityType: "visit", key: "arrived_photo", label: "Arrival photo taken", dataType: "boolean" });
    const saved = await reports.save(owner(), {
      name: `Arrival photos ${Date.now()}`,
      definition: { dataset: "visits", dimensions: ["cf_arrived_photo"], measures: ["count"] },
    });
    expect(saved.id).toBeTruthy();
    await expect(reports.run(owner(), { dataset: "visits", dimensions: ["cf_nothing"], measures: ["count"] }))
      .rejects.toThrow("Not available on this dataset: dimension: cf_nothing");
  });
});
