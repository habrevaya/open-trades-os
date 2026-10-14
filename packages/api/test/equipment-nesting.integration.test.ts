import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as equipment from "../src/services/equipment";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * WHAT A UNIT IS INSIDE, AND ITS OTHER DETAILS, EDITED ON ITS PAGE
 *
 * `PATCH /v1/equipment/{id}` takes a parent and free form attributes. The page
 * offers both, so the loops it must refuse are pinned here, in words and however
 * many steps down: a unit put inside itself, inside what it already holds, or
 * (the case the old check missed) inside something three steps below it. Taking a
 * unit out of what it was in, and replacing its details, work and are audited.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("equipment-nesting:org");
const USER = fixtureId("equipment-nesting:user");
let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const accountant = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["accountant"] as Actor["roles"] }, db: db() });

let houseId = "";
let rentalId = "";
let serial = 0;
const unit = (over: Partial<Parameters<typeof equipment.register>[1]> = {}) => equipment.register(owner(), {
  propertyId: houseId, category: "air_handler", serialNumber: `NEST-${++serial}`, ...over,
} as Parameters<typeof equipment.register>[1]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Nesting Co", slug: "equipment-nesting-co" });
  const [a] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Main St', 'Austin', 'TX', '78701') returning id`;
  const [b] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '2 Main St', 'Austin', 'TX', '78701') returning id`;
  houseId = a!.id;
  rentalId = b!.id;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("putting a unit inside another", () => {
  it("refuses a loop however many steps down, in words", async () => {
    const a = await unit({ tag: "A" });
    const b = await unit({ tag: "B", parentEquipmentId: a.id });
    const c = await unit({ tag: "C", parentEquipmentId: b.id });
    const d = await unit({ tag: "D", parentEquipmentId: c.id });

    await expect(equipment.update(owner(), { id: a.id, parentEquipmentId: a.id })).rejects.toThrow("A unit cannot be inside itself.");
    await expect(equipment.update(owner(), { id: a.id, parentEquipmentId: b.id })).rejects.toThrow(/other way round/);
    await expect(equipment.update(owner(), { id: a.id, parentEquipmentId: c.id }))
      .rejects.toThrow("That unit is already inside this one, a few steps down, so putting this one inside it would make a loop.");
    await expect(equipment.update(owner(), { id: a.id, parentEquipmentId: d.id })).rejects.toBeInstanceOf(ConflictError);

    // Nothing moved.
    const [row] = await raw<{ parent_equipment_id: string | null }[]>`select parent_equipment_id from public.equipment where id = ${a.id}`;
    expect(row!.parent_equipment_id).toBeNull();
  });

  it("allows a move that is not a loop, up the chain or to a sibling, and takes a unit out", async () => {
    const a = await unit({ tag: "A2" });
    const b = await unit({ tag: "B2", parentEquipmentId: a.id });
    const c = await unit({ tag: "C2", parentEquipmentId: b.id });
    const sibling = await unit({ tag: "S2", parentEquipmentId: a.id });

    await equipment.update(owner(), { id: c.id, parentEquipmentId: a.id });
    await equipment.update(owner(), { id: c.id, parentEquipmentId: sibling.id });
    const tree = await equipment.atProperty(owner(), { propertyId: houseId });
    const top = tree.find((n) => n.id === a.id)!;
    expect(top.children?.find((n) => n.id === sibling.id)?.children?.map((n) => n.tag)).toEqual(["C2"]);

    await equipment.update(owner(), { id: c.id, parentEquipmentId: null });
    const [row] = await raw<{ parent_equipment_id: string | null }[]>`select parent_equipment_id from public.equipment where id = ${c.id}`;
    expect(row!.parent_equipment_id).toBeNull();
  });

  it("is not stopped, or sent round in circles, by a loop an older edit already made elsewhere", async () => {
    const x = await unit({ tag: "X" });
    const y = await unit({ tag: "Y", parentEquipmentId: x.id });
    await raw`update public.equipment set parent_equipment_id = ${y.id} where id = ${x.id}`;
    const free = await unit({ tag: "F" });
    await equipment.update(owner(), { id: free.id, parentEquipmentId: x.id });
    const [row] = await raw<{ parent_equipment_id: string | null }[]>`select parent_equipment_id from public.equipment where id = ${free.id}`;
    expect(row!.parent_equipment_id).toBe(x.id);
  });

  it("still refuses another address and a unit taken off the register", async () => {
    const a = await unit({ tag: "A3" });
    const away = await unit({ tag: "Away", propertyId: rentalId });
    await expect(equipment.update(owner(), { id: a.id, parentEquipmentId: away.id })).rejects.toThrow(/different property/);
    const gone = await unit({ tag: "Gone" });
    await equipment.retire(owner(), { id: gone.id, reason: "Replaced" });
    await expect(equipment.update(owner(), { id: a.id, parentEquipmentId: gone.id })).rejects.toThrow(/not found/i);
  });

  it("is for whoever may write the register", async () => {
    const a = await unit({ tag: "A4" });
    const b = await unit({ tag: "B4" });
    await expect(equipment.update(accountant(), { id: b.id, parentEquipmentId: a.id })).rejects.toThrow();
  });
});

run("a unit's other details", () => {
  it("are replaced whole by what is sent, and the change is in the audit log", async () => {
    const a = await unit({ tag: "Details", attributes: { refrigerant: "R-22", amps: 14 } });
    await equipment.update(owner(), { id: a.id, attributes: { refrigerant: "R-410A", filter: "16x25x1" } });
    const [row] = await raw<{ attributes: Record<string, unknown> }[]>`select attributes from public.equipment where id = ${a.id}`;
    expect(row!.attributes).toEqual({ refrigerant: "R-410A", filter: "16x25x1" });
    const [audited] = await raw<{ n: number }[]>`select count(*)::int as n from public.audit_log
      where entity_id = ${a.id} and action = 'equipment.updated'`;
    expect(audited!.n).toBe(1);
  });

  it("are left alone by an edit that does not send them", async () => {
    const a = await unit({ tag: "Kept", attributes: { refrigerant: "R-22" } });
    await equipment.update(owner(), { id: a.id, tag: "Kept 2" });
    const [row] = await raw<{ attributes: Record<string, unknown> }[]>`select attributes from public.equipment where id = ${a.id}`;
    expect(row!.attributes).toEqual({ refrigerant: "R-22" });
  });
});
