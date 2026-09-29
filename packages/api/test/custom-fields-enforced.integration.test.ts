import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as fields from "../src/services/custom-fields";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { type ServiceContext } from "../src/services/context";
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

    await expect(customerWith({ warranty_expires: "soon" }))
      .rejects.toThrow(/warranty_expires.*Warranty expires/is);
  });

  it("refuses a value that contradicts the type on update", async () => {
    const customer = await customerWith({});
    await fields.define(owner(), {
      entityType: "customer", key: "unit_count", label: "Units", dataType: "number",
    });

    await expect(customers.update(owner(), { id: customer.id, customFields: { unit_count: "six" } }))
      .rejects.toThrow(/unit_count/i);
  });

  it("refuses a select value that is not one of the options", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "tier", label: "Tier",
      dataType: "select", options: ["gold", "silver"],
    });

    await expect(customerWith({ tier: "bronze" })).rejects.toThrow(/tier/i);
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

    await expect(customerWith({})).rejects.toThrow(/account_ref.*required/is);
  });

  it("refuses a required field this write cleared", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "account_ref", label: "Account reference", required: true,
    });
    const customer = await customerWith({ account_ref: "A-1" });

    await expect(customers.update(owner(), { id: customer.id, customFields: {} }))
      .rejects.toThrow(/account_ref.*required/is);
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

    await expect(properties.create(owner(), {
      address: { line1: "1 Test St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: { roof_year: "recent" }, customerRole: "owner",
    })).rejects.toThrow(/roof_year/i);
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
