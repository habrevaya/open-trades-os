import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as equipment from "../src/services/equipment";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { type ServiceContext } from "../src/services/context";
import { dispatch } from "../src/http/dispatch";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHERE A UNIT CAME FROM, READ BACK AND FOUND AGAIN
 *
 * `POST /v1/equipment` has taken `externalRef` and refused a second unit for
 * it, and nothing read it back: a migration could not ask which unit a record
 * of its old system became, or whether it had loaded it at all. Every read of
 * the register now returns it, and `GET /v1/equipment` finds units by it,
 * across addresses, retired ones included.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("equipment-ext:org");
const USER = fixtureId("equipment-ext:user");
const OTHER_ORG = fixtureId("equipment-ext:other-org");
const OTHER_USER = fixtureId("equipment-ext:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], org = ORG, user = USER): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let house = "";
let rental = "";
let stranger = "";

async function place(ctx: ServiceContext, name: string, line1: string) {
  const customer = await customers.create(ctx, {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  return (await properties.create(ctx, {
    address: { line1, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  })).id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Register Co", slug: "equipment-external-ref" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Register Co", slug: "equipment-external-ref-other" });
  house = await place(owner(), "Hal House", "1 Unit Way");
  rental = await place(owner(), "Rita Rental", "2 Unit Way");
  stranger = await place(as(["owner"], OTHER_ORG, OTHER_USER), "Other Owner", "3 Unit Way");
});

afterAll(async () => { if (raw) await raw.end(); });

run("a unit's external reference", () => {
  it("is returned by every read and found by source and id, across addresses, retired ones included", async () => {
    const furnace = await equipment.register(owner(), {
      propertyId: house, category: "furnace", serialNumber: "EXT-F-1", externalRef: { source: "jobber", id: "eq-1" },
    });
    const heater = await equipment.register(owner(), {
      propertyId: rental, category: "water_heater", serialNumber: "EXT-W-1", externalRef: { source: "jobber", id: "eq-2" },
    });
    const typed = await equipment.register(owner(), { propertyId: house, category: "thermostat" });
    await equipment.register(as(["owner"], OTHER_ORG, OTHER_USER), {
      propertyId: stranger, category: "furnace", externalRef: { source: "jobber", id: "eq-1" },
    });

    expect((await equipment.get(owner(), { id: furnace.id })).externalRef).toEqual({ source: "jobber", id: "eq-1" });
    const atHouse = await equipment.handlers.listEquipment(owner(), { propertyId: house });
    expect(atHouse.equipment.find((u) => u.id === typed.id)!.externalRef).toBeNull();
    expect(atHouse.equipment.find((u) => u.id === furnace.id)!.externalRef).toEqual({ source: "jobber", id: "eq-1" });

    const fromJobber = await equipment.handlers.listEquipment(owner(), { externalSource: "jobber" });
    expect(fromJobber.equipment.map((u) => u.id).sort()).toEqual([furnace.id, heater.id].sort());
    const one = await equipment.handlers.listEquipment(owner(), { externalSource: "jobber", externalId: "eq-1" });
    expect(one.equipment.map((u) => u.id)).toEqual([furnace.id]);
    const atRental = await equipment.handlers.listEquipment(owner(), { externalSource: "jobber", propertyId: rental });
    expect(atRental.equipment.map((u) => u.id)).toEqual([heater.id]);

    await equipment.retire(owner(), { id: heater.id, reason: "Replaced." });
    const still = await equipment.handlers.listEquipment(owner(), { externalSource: "jobber", externalId: "eq-2" });
    expect(still.equipment).toMatchObject([{ id: heater.id, retired: true }]);

    // A technician sent to neither address finds neither.
    const tech = await equipment.handlers.listEquipment(as(["technician"]), { externalSource: "jobber" });
    expect(tech.equipment).toEqual([]);
  });

  it("is the API's, which asks for an address or a reference", async () => {
    const call = async (path: string) => {
      const response = await dispatch(new Request(`http://x${path}`, { method: "GET" }), {
        db: db(), resolveSession: async () => owner(),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const found = await call("/v1/equipment?externalSource=jobber&externalId=eq-1");
    expect(found.status).toBe(200);
    expect((found.body["equipment"] as { externalRef: unknown }[])).toMatchObject([{ externalRef: { source: "jobber", id: "eq-1" } }]);
    const neither = await call("/v1/equipment");
    expect(neither.status).toBe(422);
  });
});
