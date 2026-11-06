import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as equipment from "../src/services/equipment";
import * as customFields from "../src/services/custom-fields";
import { type ServiceContext } from "../src/services/context";
import { dispatch } from "../src/http/dispatch";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M04, M29. THE WHOLE COMPANY'S REGISTER, FILTERED AND PAGED
 *
 * Wide Register Co keeps units at three addresses: two with Austin work, one
 * with Houston work. The list without an address is every unit the reader may
 * see, filtered by its kind, its age, how its warranty stands and the
 * company's own fields, a page at a time, each with its address and its
 * customer. A Houston branch manager sees the Houston address's units only.
 * One address asked for alone is still its nested register, as before.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("equipment-wide:org");
const USER = fixtureId("equipment-wide:user");
const ZONE = "America/Chicago";
const TODAY = companyToday(0, ZONE);
const yearsAgo = (n: number, days = 0) => {
  const d = new Date(`${String(Number(TODAY.slice(0, 4)) - n)}${TODAY.slice(4)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};
const ahead = (days: number) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

let raw: postgres.Sql;
const db = () => testDb(url!);
let houston = "";
let austin = "";
const as = (role: string, businessUnitId?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"], ...(businessUnitId ? { businessUnitId } : {}) }, db: db(),
});
const owner = () => as("owner");

const ids: Record<string, string> = {};

async function address(line1: string, customer: string, branchId: string): Promise<string> {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', ${customer}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, ${line1}, 'Austin', 'TX', '78701') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, is_primary) values (${ORG}, ${c!.id}, ${p!.id}, true)`;
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  await raw`insert into public.job (organization_id, number, customer_id, property_id, status, summary, business_unit_id)
    values (${ORG}, ${n!.next}, ${c!.id}, ${p!.id}, 'scheduled', 'Look at the units', ${branchId})`;
  return p!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Wide Register Co", slug: "equipment-company-list" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [a] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  const [h] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;
  austin = a!.id;
  houston = h!.id;
  await customFields.define(owner(), { entityType: "equipment", key: "refrigerant", label: "Refrigerant", dataType: "select", options: ["R-22", "R-410A"] });
  const one = await address("1 Wide Way", "Ann Austin", austin);
  const two = await address("2 Wide Way", "Abe Austin", austin);
  const three = await address("3 Wide Way", "Hal Houston", houston);
  const unit = async (key: string, propertyId: string, category: string, installedOn: string | null, parts: string | null, labour: string | null) => {
    const made = await equipment.register(owner(), {
      propertyId, category, ...(installedOn ? { installedOn } : {}),
      ...(parts ? { warrantyPartsExpiresOn: parts } : {}), ...(labour ? { warrantyLaborExpiresOn: labour } : {}),
    });
    ids[key] = made.id;
  };
  /** Twelve years old, warranty long gone. */
  await unit("oldFurnace", one, "Furnace", yearsAgo(12), yearsAgo(2), yearsAgo(7));
  /** Two years old, parts still covered. */
  await unit("newFurnace", two, "Furnace", yearsAgo(2), ahead(400), yearsAgo(1));
  /** Exactly five years old today, no warranty recorded. */
  await unit("heater", three, "Water heater", yearsAgo(5), null, null);
  /** No install date at all. */
  await unit("thermostat", one, "Thermostat", null, null, null);
  await customFields.setValues(owner(), { entityType: "equipment", id: ids.oldFurnace!, values: { refrigerant: "R-22" } });
  await customFields.setValues(owner(), { entityType: "equipment", id: ids.newFurnace!, values: { refrigerant: "R-410A" } });
  /** A retired unit is not on the list. */
  await unit("retired", two, "Furnace", yearsAgo(20), null, null);
  await equipment.retire(owner(), { id: ids.retired!, reason: "Replaced" });
});

afterAll(async () => { if (raw) await raw.end(); });

const listed = async (ctx: ServiceContext, input: Parameters<typeof equipment.unitList>[1] = {}) =>
  (await equipment.unitList(ctx, input)).data.map((u) => Object.entries(ids).find(([, id]) => id === u.id)?.[0] ?? u.id);

run("the whole company's register", () => {
  it("lists every unit in the order of its kind, retired ones left out, each with its address and customer", async () => {
    expect(await listed(owner())).toEqual(["oldFurnace", "newFurnace", "thermostat", "heater"].sort((x, y) => {
      const kind = (k: string) => ({ oldFurnace: "Furnace", newFurnace: "Furnace", thermostat: "Thermostat", heater: "Water heater" } as Record<string, string>)[k]!;
      return kind(x).localeCompare(kind(y)) || ids[x]!.localeCompare(ids[y]!);
    }));
    const page = await equipment.unitList(owner(), { kind: "Water heater" });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ address: "3 Wide Way, Austin", customer: { name: "Hal Houston" }, category: "Water heater", ageYears: 5 });
  });

  it("filters by kind, by age, by warranty and by the company's own fields", async () => {
    expect((await listed(owner(), { kind: "Furnace" })).sort()).toEqual(["newFurnace", "oldFurnace"]);
    expect((await listed(owner(), { minAgeYears: 5 })).sort()).toEqual(["heater", "oldFurnace"]);
    expect(await listed(owner(), { maxAgeYears: 4 })).toEqual(["newFurnace"]);
    expect(await listed(owner(), { minAgeYears: 5, maxAgeYears: 5 })).toEqual(["heater"]);
    expect(await listed(owner(), { warranty: "covered" })).toEqual(["newFurnace"]);
    expect(await listed(owner(), { warranty: "lapsed" })).toEqual(["oldFurnace"]);
    expect((await listed(owner(), { warranty: "none" })).sort()).toEqual(["heater", "thermostat"]);
    expect(await listed(owner(), { fields: ["refrigerant:R-22"] })).toEqual(["oldFurnace"]);
    expect((await listed(owner(), { fields: ["refrigerant:R-22", "refrigerant:R-410A"], fieldMatch: "any" })).sort())
      .toEqual(["newFurnace", "oldFurnace"]);
    await expect(equipment.unitList(owner(), { fields: ["colour:red"] })).rejects.toThrow();
    await expect(equipment.unitList(owner(), { minAgeYears: 9, maxAgeYears: 3 })).rejects.toThrow("Swap them.");
  });

  it("is paged by a cursor, a page the same rows however it is walked", async () => {
    const first = await equipment.unitList(owner(), { limit: 3 });
    expect(first.data).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    const second = await equipment.unitList(owner(), { limit: 3, cursor: first.nextCursor! });
    expect(second.data).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.data, ...second.data].map((u) => u.id)).size).toBe(4);
  });

  it("shows a branch manager the units at their branch's addresses, and refuses somebody who may not read units", async () => {
    expect(await listed(as("branch_manager", houston))).toEqual(["heater"]);
    expect((await listed(as("branch_manager", austin))).sort()).toEqual(["newFurnace", "oldFurnace", "thermostat"]);
    await expect(equipment.unitList(as("accountant"), {})).rejects.toThrow();
  });

  it("is GET /v1/equipment without an address, and one address alone is still its nested register", async () => {
    const call = async (path: string, ctx: ServiceContext = owner()) => {
      const response = await dispatch(new Request(`http://x${path}`, { method: "GET" }), { db: db(), resolveSession: async () => ctx });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const wide = await call("/v1/equipment?kind=Furnace&limit=1");
    expect(wide.status).toBe(200);
    expect(wide.body["equipment"]).toHaveLength(1);
    expect(wide.body["hasMore"]).toBe(true);
    expect(typeof wide.body["nextCursor"]).toBe("string");
    const filtered = await call("/v1/equipment?warranty=covered&minAgeYears=1");
    expect((filtered.body["equipment"] as { id: string }[]).map((u) => u.id)).toEqual([ids.newFurnace]);
    const unitsAt = await equipment.handlers.listEquipment(owner(), { propertyId: (await equipment.get(owner(), { id: ids.thermostat! })).propertyId });
    expect(unitsAt.hasMore).toBe(false);
    expect(unitsAt.equipment.map((u) => u.id).sort()).toEqual([ids.oldFurnace, ids.thermostat].sort());
    const refused = await call("/v1/equipment", as("accountant"));
    expect(refused.status).toBe(403);
  });
});
