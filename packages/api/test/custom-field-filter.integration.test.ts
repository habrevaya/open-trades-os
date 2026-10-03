import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as fields from "../src/services/custom-fields";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE CUSTOMER LIST, FILTERED BY A FIELD THE COMPANY DECLARED
 *
 * A custom field nobody can find customers by is a box people fill in for
 * nothing. Each type matches the way its value is stored, and a field the
 * company never declared is refused in words rather than matching nobody.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cf-filter:org");
const OWNER = fixtureId("cf-filter:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles }, db: db() });

let annual = "";
let monthly = "";
let blank = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Filter Co", slug: "cf-filter-co" });
  const owner = as(["owner"]);
  await fields.define(owner, { entityType: "customer", key: "plan", label: "Plan", dataType: "select", options: ["Annual", "Monthly"] });
  await fields.define(owner, { entityType: "customer", key: "gate_code", label: "Gate code", dataType: "text" });
  await fields.define(owner, { entityType: "customer", key: "has_pets", label: "Pets", dataType: "boolean" });
  await fields.define(owner, { entityType: "customer", key: "units", label: "Units", dataType: "number" });
  await fields.define(owner, { entityType: "customer", key: "tags_extra", label: "Interests", dataType: "multiselect", options: ["Solar", "Pool"] });

  const make = async (name: string, customFields: Record<string, unknown>) => (await customers.create(owner, {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields,
  })).id;
  annual = await make("Annual Andy", { plan: "Annual", gate_code: "Gate 4471", has_pets: true, units: 2, tags_extra: ["Solar", "Pool"] });
  monthly = await make("Monthly Mo", { plan: "Monthly", has_pets: false, units: 2.0, tags_extra: ["Pool"] });
  blank = await make("Blank Bea", {});
});

afterAll(async () => { if (raw) await raw.end(); });

const ids = async (fieldKey: string, fieldValue: string) =>
  (await customers.list(as(["owner"]), { limit: 100, includeInactive: false, fieldKey, fieldValue })).data.map((c) => c.id).sort();

run("filtering customers by a custom field", () => {
  it("matches a choice exactly", async () => {
    expect(await ids("plan", "Annual")).toEqual([annual]);
    expect(await ids("plan", "annual")).toEqual([]);
  });

  it("matches free text anywhere in the value, ignoring case, with no wildcards of its own", async () => {
    expect(await ids("gate_code", "4471")).toEqual([annual]);
    expect(await ids("gate_code", "gate")).toEqual([annual]);
    expect(await ids("gate_code", "%")).toEqual([]);
  });

  it("matches yes and no as stored, so the string \"true\" is not mistaken for it", async () => {
    expect(await ids("has_pets", "yes")).toEqual([annual]);
    expect(await ids("has_pets", "false")).toEqual([monthly]);
  });

  it("matches a number as a number", async () => {
    expect(await ids("units", "2")).toEqual([annual, monthly].sort());
  });

  it("matches one choice among several", async () => {
    expect(await ids("tags_extra", "Pool")).toEqual([annual, monthly].sort());
    expect(await ids("tags_extra", "Solar")).toEqual([annual]);
  });

  it("refuses a field the company never declared, a bad value, and half a filter", async () => {
    await expect(ids("warranty", "x")).rejects.toThrow(/no customer field called "warranty"/);
    await expect(ids("has_pets", "maybe")).rejects.toThrow(/yes or no/);
    await expect(ids("units", "two")).rejects.toThrow(/number/);
    await expect(customers.list(as(["owner"]), { limit: 10, includeInactive: false, fieldKey: "plan" }))
      .rejects.toThrow(ConflictError);
  });

  it("never matches the customer with nothing filled in", async () => {
    for (const [key, value] of [["plan", "Annual"], ["has_pets", "no"], ["units", "0"]] as const) {
      expect(await ids(key, value)).not.toContain(blank);
    }
  });

  it("stops matching a field once it is retired", async () => {
    const definitions = await fields.list(as(["owner"]), { entityType: "customer" });
    const units = definitions.find((d) => d.key === "units")!;
    await fields.remove(as(["owner"]), { id: units.id, force: true });
    await expect(ids("units", "2")).rejects.toThrow(/no customer field/);
  });
});
