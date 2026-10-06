import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as fields from "../src/services/custom-fields";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHAT THE SAVE PATH ACTUALLY REFUSES
 *
 * `custom-fields.integration.test.ts` next door proves the definitions are
 * right. This file proves they BIND: that declaring a field is not a note in
 * a settings table but a rule the customer, property and job writes enforce.
 *
 * A definition nothing checks is documentation. The screen draws a date
 * picker because the type says date, the API accepts "soon" into the same
 * field forever, and a year later the report that was the whole reason for
 * declaring it finds three date formats and the word "soon".
 *
 * THE HARD PART IS NOT REFUSING. It is refusing without breaking every
 * company in the product on the day it ships. These columns have been
 * writable with no definitions since the first migration, so every existing
 * record is full of keys nothing defines and values nothing has ever checked.
 * The rule is therefore narrower than the settings screen's:
 *
 *   REFUSED   a value contradicting a definition, when THIS WRITE set it.
 *   REFUSED   a required field this write left empty.
 *   ALLOWED   a key nothing defines, anywhere, always.
 *   ALLOWED   anything at all, for a company that has declared nothing.
 *
 * Every test below is one of those four, and the last two are the ones worth
 * having: they are the difference between a feature and an outage.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cfe29:org");
const USER = fixtureId("cfe29:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let made = 0;
async function customerWith(customFields: Record<string, unknown>) {
  made += 1;
  return customers.create(owner(), {
    type: "residential", name: `Customer ${made}`,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields,
  });
}

/** Put a value in the column the way the world did before definitions existed. */
async function storeBehindTheService(customerId: string, customFields: Record<string, unknown>) {
  await raw`
    update public.customer set custom_fields = ${raw.json(customFields as never)}
    where id = ${customerId} and organization_id = ${ORG}`;
}

/**
 * What a refused save says, field by field.
 *
 * Each problem is its own sentence at `customFields.<key>`, starting with the
 * field's label, so an API client can put it beside the box it is about and a
 * form can say all of them at once.
 */
async function refusal(write: Promise<unknown>) {
  const error = await write.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(UnprocessableError);
  return (error as UnprocessableError).issues;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, {
    organizationId: ORG, userId: USER, name: "Enforcement Co", slug: "enforcement-co",
  });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.job where organization_id = ${ORG}`;
  await raw`delete from public.customer_property where organization_id = ${ORG}`;
  await raw`delete from public.property where organization_id = ${ORG}`;
  await raw`delete from public.customer where organization_id = ${ORG}`;
  await raw`delete from public.custom_field_definition where organization_id = ${ORG}`;
});

run("a declared field binds the save", () => {
  it("refuses a value that contradicts the type on create", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "warranty_expires",
      label: "Warranty expires", dataType: "date",
    });

    expect(await refusal(customerWith({ warranty_expires: "soon" }))).toEqual([{
      path: "customFields.warranty_expires", message: "Warranty expires has to be a date like 2026-03-01.",
    }]);
  });

  it("refuses a value that contradicts the type on update", async () => {
    const customer = await customerWith({});
    await fields.define(owner(), {
      entityType: "customer", key: "unit_count", label: "Units", dataType: "number",
    });

    expect(await refusal(customers.update(owner(), { id: customer.id, customFields: { unit_count: "six" } })))
      .toEqual([{ path: "customFields.unit_count", message: "Units has to be a number." }]);
  });

  it("refuses a select value that is not one of the options", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "tier", label: "Tier",
      dataType: "select", options: ["gold", "silver"],
    });

    expect(await refusal(customerWith({ tier: "bronze" }))).toEqual([{
      path: "customFields.tier", message: "Tier is not one of the options (gold, silver).",
    }]);
    const fine = await customerWith({ tier: "gold" });
    expect(fine.id).toBeTruthy();
  });

  it("refuses a required field left empty on create", async () => {
    /**
     * On a create every key is new, so required means required. The company
     * turned it on deliberately and a record made after that moment is a
     * record it applies to.
     */
    await fields.define(owner(), {
      entityType: "customer", key: "account_ref", label: "Account reference", required: true,
    });

    expect(await refusal(customerWith({})))
      .toEqual([{ path: "customFields.account_ref", message: "Account reference is required." }]);
  });

  it("refuses a required field this write cleared", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "account_ref", label: "Account reference", required: true,
    });
    const customer = await customerWith({ account_ref: "A-1" });

    expect(await refusal(customers.update(owner(), { id: customer.id, customFields: {} })))
      .toEqual([{ path: "customFields.account_ref", message: "Account reference is required." }]);
  });

  it("binds on properties as well as customers", async () => {
    /**
     * Asserted rather than assumed. Three services write a `custom_fields`
     * column and each one is its own call site: a rule wired into one of them
     * is a rule two thirds of this product does not have, and nothing about
     * reading `customers.ts` would tell you which third.
     */
    await fields.define(owner(), {
      entityType: "property", key: "roof_year", label: "Roof year", dataType: "number",
    });

    expect(await refusal(properties.create(owner(), {
      address: { line1: "1 Test St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: { roof_year: "recent" }, customerRole: "owner",
    }))).toEqual([{ path: "customFields.roof_year", message: "Roof year has to be a number." }]);
  });

  it("says every field that is wrong at once, one sentence each", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "account_ref", label: "Account reference", required: true,
    });
    await fields.define(owner(), {
      entityType: "customer", key: "unit_count", label: "Units", dataType: "number",
    });
    expect(await refusal(customerWith({ unit_count: "six" }))).toEqual([
      { path: "customFields.account_ref", message: "Account reference is required." },
      { path: "customFields.unit_count", message: "Units has to be a number." },
    ]);
  });

  it("binds an address created with its customer, which used to skip the property rules", async () => {
    await fields.define(owner(), {
      entityType: "property", key: "gate_code", label: "Gate code", required: true,
    });
    const address = { line1: "4 Gate St", city: "Austin", state: "TX", postalCode: "78701", country: "US" };
    const create = (customFields?: Record<string, unknown>) => customers.create(owner(), {
      type: "residential", name: `Gated ${made += 1}`, paymentTermsDays: 0, taxExempt: false, tags: [],
      customFields: {}, property: { address, ...(customFields ? { customFields } : {}) },
    });

    expect(await refusal(create()))
      .toEqual([{ path: "property.customFields.gate_code", message: "Gate code is required." }]);
    const fine = await create({ gate_code: "1234" });
    const [stored] = await raw<{ custom_fields: Record<string, unknown> }[]>`
      select p.custom_fields from public.property p
      join public.customer_property cp on cp.property_id = p.id
      where cp.customer_id = ${fine.id}`;
    expect(stored!.custom_fields).toEqual({ gate_code: "1234" });
  });

  it("binds on jobs, on create and on update", async () => {
    await fields.define(owner(), {
      entityType: "job", key: "permit_no", label: "Permit number", required: true,
    });
    const customer = await customerWith({});
    const property = await properties.create(owner(), {
      address: { line1: "2 Job St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
    });
    const job = (fieldsFor: Record<string, unknown>) => jobs.create(owner(), {
      customerId: customer.id, propertyId: property.id, summary: "Panel swap", tags: [], customFields: fieldsFor,
    });

    expect(await refusal(job({})))
      .toEqual([{ path: "customFields.permit_no", message: "Permit number is required." }]);
    const made = await job({ permit_no: "P-77" });
    expect(await refusal(jobs.update(owner(), { id: made.id, customFields: { permit_no: "" } })))
      .toEqual([{ path: "customFields.permit_no", message: "Permit number is required." }]);
  });

  it("does not refuse a job from before the field became required", async () => {
    const customer = await customerWith({});
    const property = await properties.create(owner(), {
      address: { line1: "3 Job St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
    });
    const made = await jobs.create(owner(), {
      customerId: customer.id, propertyId: property.id, summary: "Old job", tags: [], customFields: { note: "x" },
    });
    await fields.define(owner(), {
      entityType: "job", key: "permit_no", label: "Permit number", required: true,
    });
    const after = await jobs.update(owner(), { id: made.id, summary: "Old job, renamed", customFields: { note: "y" } });
    expect(after.summary).toBe("Old job, renamed");
  });

  it("does not check a customer's field against a property's definition", async () => {
    /** Same key, different entity, and the definitions are separate registers. */
    await fields.define(owner(), {
      entityType: "property", key: "roof_year", label: "Roof year", dataType: "number",
    });

    const customer = await customerWith({ roof_year: "not a number at all" });
    expect(customer.id).toBeTruthy();
  });
});

run("what it must never refuse", () => {
  it("leaves a company that has declared nothing exactly as it was", async () => {
    /**
     * THE OUTAGE THIS AVOIDS. Every organization in the product has been
     * writing arbitrary keys into these columns since the first migration.
     * If enforcement applied to them, the first save of an untouched record
     * would have been refused for data that was legal when it was written.
     *
     * No definitions means no rule, which is not a special case bolted on:
     * it is the statement that nothing changes for anybody until they declare
     * a field.
     */
    const customer = await customerWith({ anything: "at all", nested: { deep: [1, 2, 3] } });
    expect(customer.id).toBeTruthy();
  });

  it("allows a key nothing defines, even beside a key something does", async () => {
    /**
     * Reported by `usage`, never refused by a save. A company finds its
     * undefined keys on a screen built to show them and clears them at a time
     * it chooses, rather than one refused save at a time on a Tuesday.
     */
    await fields.define(owner(), {
      entityType: "customer", key: "tier", label: "Tier",
      dataType: "select", options: ["gold"],
    });

    const customer = await customerWith({ tier: "gold", wty_exp_2: "whatever this was" });
    expect(customer.customFields).toMatchObject({ wty_exp_2: "whatever this was" });
  });

  it("does not refuse a legacy value this write did not touch", async () => {
    /**
     * THE ONE THAT MAKES THIS SHIPPABLE.
     *
     * A customer holds `unit_count: "six"` in a field declared as a number.
     * Somebody opens that customer today to change the name, and the form
     * posts the whole bag back unchanged. Refusing that save teaches the
     * office that the software is broken, about data they did not enter, in a
     * record they were not editing.
     *
     * Unchanged is untouched. Typing a new bad value into the same field is a
     * different act, and the test above refuses it.
     */
    const customer = await customerWith({});
    await fields.define(owner(), {
      entityType: "customer", key: "unit_count", label: "Units", dataType: "number",
    });

    /**
     * Written past the service, which is the only way such a value exists:
     * `define` refuses a type that contradicts data already stored, so the
     * contradiction always arrives afterwards, from an import, a script, a
     * migration, or a build that predates this rule. All four are real and
     * none of them is the fault of whoever opens the record next.
     */
    await storeBehindTheService(customer.id, { unit_count: "six" });

    const after = await customers.update(owner(), {
      id: customer.id, name: "Renamed", customFields: { unit_count: "six" },
    });
    expect(after.name).toBe("Renamed");
  });

  it("does not refuse a required field that was already empty", async () => {
    /**
     * Making a field required does not reach back and fill it in. The backlog
     * is reported by `define` as `rowsMissingValue` and worked through on
     * purpose; it does not lock the records until somebody does.
     */
    const customer = await customerWith({});
    await fields.define(owner(), {
      entityType: "customer", key: "account_ref", label: "Account reference", required: true,
    });

    const after = await customers.update(owner(), { id: customer.id, customFields: {} });
    expect(after.id).toBe(customer.id);
  });

  it("does not treat an equal array or object as a change", async () => {
    /**
     * These arrive parsed out of jsonb, so two equal arrays are never the
     * same reference. Comparing by identity would call every multiselect on
     * every save a change and check it, which puts the legacy value back in
     * front of the refusal the test above exists to prevent.
     */
    const customer = await customerWith({});
    await fields.define(owner(), {
      entityType: "customer", key: "zones", label: "Zones",
      dataType: "multiselect", options: ["upstairs", "downstairs"],
    });
    await storeBehindTheService(customer.id, { zones: ["attic", "crawlspace"] });

    const after = await customers.update(owner(), {
      id: customer.id, customFields: { zones: ["attic", "crawlspace"] },
    });
    expect(after.id).toBe(customer.id);
  });

  it("leaves a write that names no custom fields alone", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "account_ref", label: "Account reference", required: true,
    });
    const customer = await customers.create(owner(), {
      type: "residential", name: "Has one", paymentTermsDays: 0,
      taxExempt: false, tags: [], customFields: { account_ref: "A-9" },
    });

    /** A patch that does not mention custom fields does not rewrite them. */
    const after = await customers.update(owner(), { id: customer.id, name: "Still has one" });
    expect(after.customFields).toMatchObject({ account_ref: "A-9" });
  });
});
