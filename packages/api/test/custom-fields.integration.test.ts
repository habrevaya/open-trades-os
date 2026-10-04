import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as fields from "../src/services/custom-fields";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE FIELDS A COMPANY ADDED, WHICH NOTHING COULD DECLARE
 *
 * `custom_field_definition` was in the first migrations and no service ever
 * touched it. `customfield:write` was in the permission catalogue and nothing
 * asserted it. Meanwhile customer, property and job each carry a
 * `custom_fields` jsonb column that every service reads and writes freely.
 *
 * So a company could store anything under any key on any row, and nothing
 * said what the keys were, what they were called, or what shape a value was
 * meant to be. The symptom is not an error: it is a settings screen with no
 * custom fields on it above a database full of them, and two offices writing
 * "yes", true and "Y" into the same field for a year.
 *
 * The rules below are all one rule seen from different sides. The value lives
 * at `custom_fields -> 'key'` on another table, matched by string, with no
 * foreign key under it. The definition and the data agree because this
 * service refuses to let them disagree, or they do not agree at all.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cf29:org");
const USER = fixtureId("cf29:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let made = 0;

/** A customer carrying custom values, created through the service that really writes them. */
async function customerWith(customFields: Record<string, unknown>) {
  made += 1;
  return customers.create(owner(), {
    type: "residential", name: `Customer ${made}`,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields,
  });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Custom Field Co", slug: "custom-field-co" });
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

run("what a definition has to be", () => {
  it("refuses a type this product cannot draw or check", async () => {
    /**
     * The closed vocabulary. An open one is the same as no type at all: the
     * screen falls back to a text box for anything it does not recognise,
     * which is a text box for everything.
     */
    await expect(fields.define(owner(), {
      entityType: "customer", key: "furnace_brand", label: "Furnace brand", dataType: "currency",
    })).rejects.toThrow(/not a type this product can draw or check/i);
  });

  it("refuses a select with nothing to select", async () => {
    /**
     * Not a strict field, an impossible one: every value fails the "one of"
     * check, so the field can never be filled in and a required one blocks
     * the save of the whole record.
     */
    await expect(fields.define(owner(), {
      entityType: "customer", key: "plan", label: "Plan", dataType: "select", options: [],
    })).rejects.toThrow(/needs at least one option/i);
  });

  it("refuses a field with no label", async () => {
    /**
     * The key is what the value is stored under and the label is what the
     * person filling it in reads. A field with no label is a blank box.
     */
    await expect(fields.define(owner(), {
      entityType: "customer", key: "gate", label: "   ",
    })).rejects.toThrow(/needs a label/i);
  });

  it("refuses two options that are the same", async () => {
    /**
     * A duplicate makes one of them unselectable and neither of them
     * identifiable in a report.
     */
    await expect(fields.define(owner(), {
      entityType: "customer", key: "plan", label: "Plan", dataType: "select",
      options: ["gold", "gold"],
    })).rejects.toThrow(/are the same/i);
  });

  it("refuses a key that is not safe as a JSON key", async () => {
    for (const key of ["Warranty", "warranty expires", "warranty.expires", "2nd_visit", ""]) {
      await expect(fields.define(owner(), {
        entityType: "customer", key, label: "Warranty",
      })).rejects.toThrow(/not a usable key/i);
    }
  });

  it("refuses a field on something with nowhere to store a value", async () => {
    /**
     * The worst failure available here. `payment` has no `custom_fields`
     * column (an invoice grew one, a payment has not), so the field would
     * render, somebody would type into it, the save would succeed because the
     * save never looked, and the value would be gone. Nobody reports that as
     * a bug.
     */
    await expect(fields.define(owner(), {
      entityType: "payment", key: "po_number", label: "PO number",
    })).rejects.toThrow(/not something this product can hold a custom field on/i);
  });

  it("refuses a second definition for the same key", async () => {
    await fields.define(owner(), { entityType: "customer", key: "gate", label: "Gate code" });

    /**
     * There is no unique index behind this. Two definitions over one stored
     * value means the label, the type and whether it is required are decided
     * by whichever row a query read first: required on Tuesday, optional on
     * Wednesday, with no edit in between.
     */
    await expect(fields.define(owner(), {
      entityType: "customer", key: "gate", label: "Gate", dataType: "number",
    })).rejects.toThrow(/already defined on customer/i);
  });

  it("lets the same key be defined on a different entity", async () => {
    await fields.define(owner(), { entityType: "customer", key: "gate", label: "Gate code" });
    const onProperty = await fields.define(owner(), {
      entityType: "property", key: "gate", label: "Gate code",
    });
    expect(onProperty.entityType).toBe("property");
  });

  it("lets a removed key be defined again", async () => {
    const first = await fields.define(owner(), { entityType: "customer", key: "gate", label: "Gate" });
    await fields.remove(owner(), { id: first.id });
    const second = await fields.define(owner(), {
      entityType: "customer", key: "gate", label: "Gate code", dataType: "number",
    });
    expect(second.id).not.toBe(first.id);
    expect((await fields.list(owner(), { entityType: "customer" })).map((f) => f.id)).toEqual([second.id]);
  });

  it("refuses a definition from a role that cannot define fields", async () => {
    /**
     * `customfield:write` was declared in the catalogue and asserted by
     * nothing, which means an owner reading an office manager's role list
     * believed they had withheld something they had not.
     */
    await expect(fields.define(as(["office_manager"]), {
      entityType: "customer", key: "gate", label: "Gate",
    })).rejects.toBeInstanceOf(PermissionError);
  });

  it("refuses the list to a role that cannot read settings", async () => {
    await expect(fields.list(as(["technician"]), {})).rejects.toBeInstanceOf(PermissionError);
  });
});

run("the key does not change", () => {
  it("refuses a rename, because every stored value points at the old string", async () => {
    const field = await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty",
    });
    await customerWith({ warranty: "2029" });

    /**
     * The deliberate decision this whole file is shaped around. There is no
     * foreign key and no cascade: renaming the key updates one row and
     * touches none of the rows holding a value, so every value is orphaned
     * at once. Not lost, which is what makes it bad. Still in the jsonb
     * under the old key, invisible to the new definition, blank on every
     * screen, and the company concludes the data was deleted.
     */
    await expect(fields.update(owner(), { id: field.id, key: "warranty_expires" }))
      .rejects.toThrow(/key cannot be changed/i);

    const [row] = await raw<{ key: string }[]>`
      select key from public.custom_field_definition where id = ${field.id}`;
    expect(row!.key).toBe("warranty");
  });

  it("renames the label freely, which is what people actually want", async () => {
    const field = await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty",
    });
    await customerWith({ warranty: "2029" });

    const after = await fields.update(owner(), { id: field.id, label: "Warranty expires" });
    expect(after.label).toBe("Warranty expires");
    expect(after.key).toBe("warranty");
    /** Lossless: the value is still found, because the key never moved. */
    expect(after.rowsWithValue).toBe(1);
  });

  it("keeps the options when the patch only names the label", async () => {
    /**
     * The patch is validated against the row it produces, not against
     * itself. A guard reading only the patch sees no options, calls the
     * field an impossible select, and refuses a rename.
     */
    const field = await fields.define(owner(), {
      entityType: "customer", key: "plan", label: "Plan", dataType: "select",
      options: ["bronze", "gold"],
    });
    const after = await fields.update(owner(), { id: field.id, label: "Service plan" });
    expect(after).toMatchObject({ label: "Service plan", dataType: "select", options: ["bronze", "gold"] });
  });

  it("refuses moving a field to another entity", async () => {
    const field = await fields.define(owner(), {
      entityType: "customer", key: "gate", label: "Gate",
    });
    await expect(fields.update(owner(), { id: field.id, entityType: "property" }))
      .rejects.toThrow(/cannot be moved from customer to property/i);
  });

  it("refuses to edit one that has been removed", async () => {
    const field = await fields.define(owner(), { entityType: "customer", key: "gate", label: "Gate" });
    await fields.remove(owner(), { id: field.id });
    await expect(fields.update(owner(), { id: field.id, label: "Gate code" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

run("a definition that contradicts what is already stored", () => {
  it("refuses to retype a field that holds values the new type rejects", async () => {
    const field = await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty", dataType: "text",
    });
    await customerWith({ warranty: "12 months" });

    /**
     * Every string under the field is invalid from that moment, all at once,
     * and there is no honest conversion: "12 months" is not a number and
     * guessing 12 is inventing data.
     */
    await expect(fields.update(owner(), { id: field.id, dataType: "number" }))
      .rejects.toThrow(/would not be valid as a number field/i);
  });

  it("retypes a field nobody has filled in", async () => {
    const field = await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty", dataType: "text",
    });
    await customerWith({});

    const after = await fields.update(owner(), { id: field.id, dataType: "number" });
    expect(after.dataType).toBe("number");
  });

  it("refuses to remove an option somebody has already selected", async () => {
    const field = await fields.define(owner(), {
      entityType: "customer", key: "plan", label: "Plan", dataType: "select",
      options: ["bronze", "silver", "gold"],
    });
    await customerWith({ plan: "gold" });

    await expect(fields.update(owner(), { id: field.id, options: ["bronze", "silver"] }))
      .rejects.toThrow(/already stored under "plan"/i);
  });

  it("removes an option nobody picked", async () => {
    const field = await fields.define(owner(), {
      entityType: "customer", key: "plan", label: "Plan", dataType: "select",
      options: ["bronze", "silver", "gold"],
    });
    await customerWith({ plan: "bronze" });

    const after = await fields.update(owner(), { id: field.id, options: ["bronze", "silver"] });
    expect(after.options).toEqual(["bronze", "silver"]);
  });

  it("refuses to adopt a key whose existing values do not fit the type", async () => {
    /**
     * The state this whole module was written for. Values sat under keys
     * with no definition for as long as this table had no service, so the
     * first definition of a key is usually an adoption rather than a fresh
     * field, and it has to answer for what is already there.
     */
    await customerWith({ warranty: "ask Dave" });

    await expect(fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty", dataType: "date",
    })).rejects.toThrow(/would not be valid as a date field/i);
  });

  it("adopts a key whose existing values do fit", async () => {
    await customerWith({ warranty: "2029-03-01" });
    const field = await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty", dataType: "date",
    });
    expect(field.rowsWithValue).toBe(1);
  });
});

run("taking a field off", () => {
  it("refuses while rows still carry a value, and says how many", async () => {
    const field = await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty",
    });
    await customerWith({ warranty: "2029-03-01" });
    await customerWith({ warranty: "2030-01-01" });

    /**
     * Removing the definition does not remove the data. The values stay in
     * the jsonb, the screen stops drawing the field, and the validator
     * starts calling them unknown keys, so the company finds out when an
     * unrelated edit to a customer is refused.
     */
    await expect(fields.remove(owner(), { id: field.id }))
      .rejects.toThrow(/2 customer rows still hold a value/i);
  });

  it("removes one nothing uses and says nothing was orphaned", async () => {
    const field = await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty",
    });
    const gone = await fields.remove(owner(), { id: field.id });
    expect(gone).toMatchObject({ removed: true, orphanedValues: 0 });
    expect(await fields.list(owner(), { entityType: "customer" })).toEqual([]);
  });

  it("removes one anyway when told to, reporting what it orphaned", async () => {
    const field = await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty",
    });
    await customerWith({ warranty: "2029-03-01" });

    /**
     * Allowed rather than withheld. A company retiring a field they filled
     * in for two years is entitled to retire it; what they must not be able
     * to do is retire it without being told.
     */
    const gone = await fields.remove(owner(), { id: field.id, force: true });
    expect(gone.orphanedValues).toBe(1);
  });

  it("refuses a removal from a role that cannot define fields", async () => {
    const field = await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty",
    });
    await expect(fields.remove(as(["office_manager"]), { id: field.id }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("checking a record against the definitions", () => {
  const check = (values: Record<string, unknown>) =>
    fields.validate(owner(), "customer", values);

  it("accepts a record that matches", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty", dataType: "date",
    });
    await fields.define(owner(), {
      entityType: "customer", key: "plan", label: "Plan", dataType: "select",
      options: ["bronze", "gold"],
    });

    const result = await check({ warranty: "2029-03-01", plan: "gold" });
    expect(result).toEqual({ valid: true, problems: [] });
  });

  it("reports a key nothing defines", async () => {
    /**
     * Stored, never shown, never exported. Accepting it quietly is how a
     * company spends a year filling in a field that does not exist.
     */
    const result = await check({ wty_exp_2: "2029" });
    expect(result.valid).toBe(false);
    expect(result.problems).toEqual([
      { key: "wty_exp_2", problem: expect.stringMatching(/is not a custom field defined on customer/i) },
    ]);
  });

  it("reports a required field nobody filled in", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "po_number", label: "PO number", required: true,
    });
    const result = await check({});
    expect(result.problems).toEqual([
      { key: "po_number", problem: expect.stringMatching(/PO number is required/) },
    ]);

    /** An empty string is not an answer to a required question. */
    expect((await check({ po_number: "   " })).problems).toHaveLength(1);
  });

  it("leaves an optional field alone when it is empty", async () => {
    await fields.define(owner(), { entityType: "customer", key: "po_number", label: "PO number" });
    expect(await check({})).toEqual({ valid: true, problems: [] });
    expect(await check({ po_number: null })).toEqual({ valid: true, problems: [] });
  });

  it("reports a value of the wrong shape", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "units", label: "Units", dataType: "number",
    });
    expect((await check({ units: "four" })).problems[0]!.problem).toMatch(/has to be a number/i);

    await fields.define(owner(), {
      entityType: "customer", key: "on_contract", label: "On contract", dataType: "boolean",
    });
    expect((await check({ units: 4, on_contract: "yes" })).problems[0]!.problem)
      .toMatch(/has to be true or false/i);
  });

  it("refuses a date that matches the pattern and is not a day", async () => {
    /**
     * `2026-02-31` passes a regular expression and is never the day anybody
     * meant. A date nobody can reach is worse than a rejected one: it sorts,
     * it exports, and it is wrong silently.
     */
    await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty", dataType: "date",
    });
    expect((await check({ warranty: "2026-02-31" })).problems[0]!.problem).toMatch(/not a real date/i);
    expect((await check({ warranty: "2026-03-01T00:00:00Z" })).problems[0]!.problem)
      .toMatch(/has to be a date like/i);
    expect(await check({ warranty: "2026-02-28" })).toEqual({ valid: true, problems: [] });
  });

  it("reports a select value that is not one of the options", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "plan", label: "Plan", dataType: "select",
      options: ["bronze", "gold"],
    });
    expect((await check({ plan: "platinum" })).problems[0]!.problem)
      .toMatch(/is not one of the options \(bronze, gold\)/i);
  });

  it("reports a multiselect holding something off the list", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "services", label: "Services", dataType: "multiselect",
      options: ["hvac", "plumbing"],
    });
    expect(await check({ services: ["hvac"] })).toEqual({ valid: true, problems: [] });
    expect((await check({ services: ["hvac", "roofing"] })).problems[0]!.problem)
      .toMatch(/not an option/i);
    expect((await check({ services: "hvac" })).problems[0]!.problem).toMatch(/has to be a list/i);
  });

  it("reports every problem at once rather than the first", async () => {
    /**
     * A form with three bad fields corrected one at a time is three round
     * trips, and the third is where somebody gives up and types whatever
     * gets past it.
     */
    await fields.define(owner(), {
      entityType: "customer", key: "units", label: "Units", dataType: "number",
    });
    await fields.define(owner(), {
      entityType: "customer", key: "po_number", label: "PO number", required: true,
    });

    const result = await check({ units: "four", stray: 1 });
    expect(result.problems.map((p) => p.key)).toEqual(["po_number", "stray", "units"]);
  });

  it("only reads the definitions for the entity it was asked about", async () => {
    await fields.define(owner(), {
      entityType: "property", key: "gate", label: "Gate code", required: true,
    });
    /** A required field on property must not refuse a customer that has no gate. */
    expect(await check({})).toEqual({ valid: true, problems: [] });
  });

  it("refuses to check against an entity with no custom fields at all", async () => {
    await expect(fields.validate(owner(), "payment", {})).rejects.toBeInstanceOf(ConflictError);
  });
});

run("what is defined and what is used", () => {
  it("counts the rows that actually carry a value", async () => {
    await fields.define(owner(), {
      entityType: "customer", key: "warranty", label: "Warranty",
    });
    await fields.define(owner(), {
      entityType: "customer", key: "gate", label: "Gate code",
    });
    await customerWith({ warranty: "2029-03-01" });
    await customerWith({ warranty: "2030-01-01" });
    await customerWith({});

    const [report] = await fields.usage(owner(), { entityType: "customer" });
    expect(report!.rows).toBe(3);
    expect(report!.defined.map((d) => [d.key, d.rowsWithValue])).toEqual([
      ["gate", 0],
      ["warranty", 2],
    ]);
  });

  it("does not count a key present and null as a value", async () => {
    await fields.define(owner(), { entityType: "customer", key: "warranty", label: "Warranty" });
    await customerWith({ warranty: null });

    const [report] = await fields.usage(owner(), { entityType: "customer" });
    expect(report!.defined[0]!.rowsWithValue).toBe(0);
  });

  it("surfaces a key in the data that nothing defines", async () => {
    /**
     * The more serious half. Values sat under keys with no label and no type
     * for as long as this table had no service, and an import can put one
     * there tomorrow. Real data that no screen shows and no export names.
     */
    await customerWith({ wty_exp_2: "2029", gate: "1234" });
    await customerWith({ wty_exp_2: "2030" });

    const [report] = await fields.usage(owner(), { entityType: "customer" });
    expect(report!.undefinedKeys).toEqual([
      { key: "wty_exp_2", rowsWithValue: 2 },
      { key: "gate", rowsWithValue: 1 },
    ]);
  });

  it("stops calling a key undefined once it is defined", async () => {
    await customerWith({ gate: "1234" });
    await fields.define(owner(), { entityType: "customer", key: "gate", label: "Gate code" });

    const [report] = await fields.usage(owner(), { entityType: "customer" });
    expect(report!.undefinedKeys).toEqual([]);
    expect(report!.defined[0]!.rowsWithValue).toBe(1);
  });

  it("says how many records a newly required field is missing", async () => {
    /**
     * Turning a field on does not reach back and fill it in. A company with
     * history has a backlog from that moment, which is usually fine and
     * occasionally exactly what they meant. What is not fine is not being
     * told, so this is reported rather than refused.
     */
    await customerWith({ po_number: "PO-1" });
    await customerWith({});
    await customerWith({});

    const field = await fields.define(owner(), {
      entityType: "customer", key: "po_number", label: "PO number", required: true,
    });
    expect(field.rowsMissingValue).toBe(2);

    const [report] = await fields.usage(owner(), { entityType: "customer" });
    expect(report!.defined[0]).toMatchObject({ rowsWithValue: 1, rowsMissingValue: 2 });
  });

  it("keeps one entity's fields out of another's", async () => {
    const customer = await customerWith({ gate: "1234" });
    await properties.create(owner(), {
      address: { line1: "9 Gate Way", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
      hasDog: false, customFields: { gate: "5678" }, customerId: customer.id, customerRole: "owner",
    });

    const report = await fields.usage(owner(), {});
    const byEntity = Object.fromEntries(report.map((r) => [r.entityType, r]));
    expect(byEntity.customer!.undefinedKeys).toEqual([{ key: "gate", rowsWithValue: 1 }]);
    expect(byEntity.property!.undefinedKeys).toEqual([{ key: "gate", rowsWithValue: 1 }]);
    expect(byEntity.job!.rows).toBe(0);
  });

  it("refuses the report to a role that cannot read settings", async () => {
    await expect(fields.usage(as(["dispatcher"]), {})).rejects.toBeInstanceOf(PermissionError);
  });
});
