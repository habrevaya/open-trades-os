import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as equipment from "../src/services/equipment";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE EQUIPMENT AT AN ADDRESS
 *
 * `equipment` was in the first migrations and nine other tables point at it:
 * a job names the unit it is about, an entitlement the unit a warranty
 * covers, a deficiency the unit that failed, a service report the unit it
 * describes.
 *
 * Two things touched it. The field app could record a unit found on site,
 * and the property read could COUNT them. So the property screen said "12
 * units here" and there was no way in the product to see what they were, how
 * old they were, or whether any were still under warranty. The count was the
 * whole feature.
 *
 * For a service trade that is not a missing screen, it is the missing
 * product: what is at this address, how old is it, is it covered, and what
 * did we do to it last time are the four questions every call starts with.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("eq:org");
const USER = fixtureId("eq:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let customerId = "";
let houseId = "";
let rentalId = "";

/** A fixed "today", so a warranty test does not depend on the day it runs. */
const TODAY = "2026-06-15";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Asset Co", slug: "asset-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Rita Rental", phone: "+15125550701",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;

  const house = await properties.create(owner(), {
    address: { line1: "11 Furnace Ln", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  houseId = house.id;

  const rental = await properties.create(owner(), {
    address: { line1: "12 Second St", city: "Austin", state: "TX", postalCode: "78702", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  rentalId = rental.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.deficiency where organization_id = ${ORG}`;
  await raw`delete from public.visit_asset where organization_id = ${ORG}`;
  await raw`delete from public.equipment_move where organization_id = ${ORG}`;
  await raw`delete from public.visit where organization_id = ${ORG}`;
  await raw`update public.job set equipment_id = null where organization_id = ${ORG}`;
  await raw`delete from public.job where organization_id = ${ORG}`;
  await raw`delete from public.equipment where organization_id = ${ORG}`;
});

const FURNACE = {
  propertyId: "", category: "furnace", tag: "F-1",
  manufacturer: "Carrier", model: "59SC5A", serialNumber: "SN-0001",
  installedOn: "2018-03-01", installedByUs: true,
  warrantyPartsExpiresOn: "2028-03-01", warrantyLaborExpiresOn: "2019-03-01",
  location: "Attic",
};
const furnace = (over: Record<string, unknown> = {}) =>
  equipment.register(owner(), { ...FURNACE, propertyId: houseId, ...over });

run("the register", () => {
  it("shows what is at an address, which nothing could do", async () => {
    await furnace();
    const at = await equipment.atProperty(owner(), { propertyId: houseId, on: TODAY });
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ tag: "F-1", manufacturer: "Carrier", category: "furnace" });
  });

  it("refuses a second record for the same serial at the same property", async () => {
    await furnace();
    /**
     * The failure the table exists to avoid, and the one that happens most:
     * the office adds a unit the phone already recorded. Two records for one
     * furnace split ten years of history down the middle.
     */
    await expect(furnace({ tag: "F-2" })).rejects.toThrow(/already on file/i);
  });

  it("allows the same serial at a different address, since units move", async () => {
    await furnace();
    await expect(furnace({ propertyId: rentalId })).resolves.toBeTruthy();
  });

  it("refuses a unit with no category", async () => {
    await expect(furnace({ category: "   " })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a warranty that expires before the unit was installed", async () => {
    await expect(furnace({ warrantyPartsExpiresOn: "2017-01-01" }))
      .rejects.toThrow(/expires before/i);
  });

  it("refuses a role without equipment:write", async () => {
    /**
     * A technician DOES hold equipment:write, and should: the field app
     * records what it finds on site. The role without it is one that reads
     * the register and does not keep it.
     */
    await expect(equipment.register(as(["accountant"]), { ...FURNACE, propertyId: houseId }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("warranty", () => {
  it("is derived from the dates, and separately for parts and labour", async () => {
    const unit = await furnace();
    const view = await equipment.get(owner(), { id: unit.id, on: TODAY });

    /**
     * A single "under warranty" would make somebody quote a free repair
     * whose labour is not covered. That conversation is why the two columns
     * exist, and the flag is computed rather than stored because the only
     * question anybody asks of a warranty is about today.
     */
    expect(view.warranty).toMatchObject({ partsCovered: true, labourCovered: false });
  });

  it("changes answer as the day moves, with nothing written", async () => {
    const unit = await furnace();
    expect((await equipment.get(owner(), { id: unit.id, on: "2028-02-28" })).warranty.partsCovered)
      .toBe(true);
    expect((await equipment.get(owner(), { id: unit.id, on: "2028-03-02" })).warranty.partsCovered)
      .toBe(false);
  });

  it("reports age in whole years", async () => {
    const unit = await furnace();
    /** Installed 2018-03-01, read on 2026-06-15. Nobody says a furnace is eight and a bit. */
    expect((await equipment.get(owner(), { id: unit.id, on: TODAY })).ageYears).toBe(8);
    expect((await equipment.get(owner(), { id: unit.id, on: "2026-02-28" })).ageYears).toBe(7);
  });

  it("lists what lapses soon and what lapsed recently", async () => {
    await furnace({ serialNumber: "SN-SOON", tag: "SOON", warrantyPartsExpiresOn: "2026-07-01" });
    await furnace({ serialNumber: "SN-PAST", tag: "PAST", warrantyPartsExpiresOn: "2026-05-01" });
    await furnace({ serialNumber: "SN-FAR", tag: "FAR", warrantyPartsExpiresOn: "2031-01-01" });

    const watch = await equipment.warrantyWatch(owner(), { withinDays: 60, on: TODAY });
    const tags = watch.map((w) => w.tag);

    /**
     * The window looks BACK as well as forward. A warranty that lapsed last
     * month is the call worth making, and a report that only looks forward
     * silently stops mentioning anything the moment it expires.
     */
    expect(tags).toContain("SOON");
    expect(tags).toContain("PAST");
    expect(tags).not.toContain("FAR");
  });

  it("counts down and then negative, so one number sorts both ways", async () => {
    const soon = await furnace({ serialNumber: "SN-A", warrantyPartsExpiresOn: "2026-07-15" });
    const past = await furnace({ serialNumber: "SN-B", warrantyPartsExpiresOn: "2026-05-15" });

    expect((await equipment.get(owner(), { id: soon.id, on: TODAY })).warranty.daysUntilSoonest).toBe(30);
    expect((await equipment.get(owner(), { id: past.id, on: TODAY })).warranty.daysUntilSoonest).toBe(-31);
  });
});

run("units inside units", () => {
  it("nests a valve under its riser", async () => {
    const riser = await furnace({ category: "riser", tag: "R-1", serialNumber: "SN-RISER" });
    await furnace({
      category: "valve", tag: "V-1", serialNumber: "SN-VALVE", parentEquipmentId: riser.id,
    });

    const tree = await equipment.atProperty(owner(), { propertyId: houseId, on: TODAY });
    const found = tree.find((row) => row.id === riser.id);
    expect(tree).toHaveLength(1);
    expect(found?.children?.map((c) => c.tag)).toEqual(["V-1"]);
  });

  it("refuses a parent at a different address", async () => {
    const riser = await furnace({ category: "riser", tag: "R-1", serialNumber: "SN-R2" });
    await expect(furnace({
      propertyId: rentalId, serialNumber: "SN-V2", parentEquipmentId: riser.id,
    })).rejects.toThrow(/different property/i);
  });

  it("refuses a unit inside itself", async () => {
    const unit = await furnace();
    await expect(equipment.update(owner(), { id: unit.id, parentEquipmentId: unit.id }))
      .rejects.toThrow(/inside itself/i);
  });

  it("refuses swapping a parent and its child", async () => {
    const riser = await furnace({ category: "riser", tag: "R", serialNumber: "SN-R3" });
    const valve = await furnace({
      category: "valve", tag: "V", serialNumber: "SN-V3", parentEquipmentId: riser.id,
    });
    await expect(equipment.update(owner(), { id: riser.id, parentEquipmentId: valve.id }))
      .rejects.toThrow(/other way round/i);
  });

  it("shows a unit whose parent is a cycle rather than hiding it", async () => {
    const a = await furnace({ tag: "A", serialNumber: "SN-CA" });
    const b = await furnace({ tag: "B", serialNumber: "SN-CB", parentEquipmentId: a.id });
    /** Forced past the guards, because a cycle is possible in data however carefully writes are checked. */
    await raw`update public.equipment set parent_equipment_id = ${b.id} where id = ${a.id}`;

    /**
     * A unit nobody can see is worse than one shown in the wrong place, and
     * a recursive build over a cycle does not return at all.
     */
    const tree = await equipment.atProperty(owner(), { propertyId: houseId, on: TODAY });
    const flat = JSON.stringify(tree);
    expect(flat).toContain('"A"');
    expect(flat).toContain('"B"');
  });

  it("refuses to retire a unit with live children", async () => {
    const riser = await furnace({ category: "riser", tag: "R", serialNumber: "SN-R4" });
    await furnace({ category: "valve", tag: "V", serialNumber: "SN-V4", parentEquipmentId: riser.id });

    await expect(equipment.retire(owner(), { id: riser.id, reason: "Replaced the stack." }))
      .rejects.toThrow(/disappear from the register/i);
  });
});

run("a unit that moves", () => {
  it("keeps its row and records where it went", async () => {
    const unit = await furnace();

    const result = await equipment.move(owner(), {
      id: unit.id, reason: "relocated", toPropertyId: rentalId,
      movedOn: "2026-04-01", notes: "Landlord moved it to the other rental.",
    });
    expect(result.unitsMoved).toBe(1);

    /**
     * The row moves and the history stays. Every job, invoice and deficiency
     * still points at the same unit, and the move record is what explains
     * why a 2024 service call was at a different address.
     */
    const view = await equipment.get(owner(), { id: unit.id, on: TODAY });
    expect(view.propertyId).toBe(rentalId);
    expect(view.moves[0]).toMatchObject({
      reason: "relocated", fromPropertyId: houseId, toPropertyId: rentalId,
    });

    expect((await equipment.atProperty(owner(), { propertyId: rentalId, on: TODAY })).map((r) => r.id))
      .toContain(unit.id);
    expect((await equipment.atProperty(owner(), { propertyId: houseId, on: TODAY })).map((r) => r.id))
      .not.toContain(unit.id);
  });

  it("takes the children with it", async () => {
    const riser = await furnace({ category: "riser", tag: "R", serialNumber: "SN-R5" });
    const valve = await furnace({
      category: "valve", tag: "V", serialNumber: "SN-V5", parentEquipmentId: riser.id,
    });

    const result = await equipment.move(owner(), {
      id: riser.id, reason: "relocated", toPropertyId: rentalId, movedOn: "2026-04-01",
    });

    /**
     * A riser's valves do not stay at the old address when the riser leaves.
     * Leaving them puts a parent and its children at two properties, which
     * `assertParent` refuses to create and this would create anyway.
     */
    expect(result.unitsMoved).toBe(2);
    const [row] = await raw<{ property_id: string }[]>`
      select property_id from public.equipment where id = ${valve.id}`;
    expect(row!.property_id).toBe(rentalId);
  });

  it("takes a replaced unit off the register and leaves the record", async () => {
    const unit = await furnace();
    await equipment.move(owner(), { id: unit.id, reason: "replaced", movedOn: "2026-04-01" });

    expect((await equipment.atProperty(owner(), { propertyId: houseId, on: TODAY }))).toHaveLength(0);

    /** Still readable, because invoices and deficiencies name it. */
    const view = await equipment.get(owner(), { id: unit.id, on: TODAY });
    expect(view.retired).toBe(true);
    expect(view.moves[0]).toMatchObject({ reason: "replaced" });
  });

  it("leaves a relocated unit live, because it is still ours", async () => {
    const unit = await furnace();
    await equipment.move(owner(), {
      id: unit.id, reason: "relocated", toPropertyId: rentalId, movedOn: "2026-04-01",
    });
    expect((await equipment.get(owner(), { id: unit.id, on: TODAY })).retired).toBe(false);
  });

  it("refuses a move that went somewhere without saying where", async () => {
    const unit = await furnace();
    await expect(equipment.move(owner(), { id: unit.id, reason: "relocated" }))
      .rejects.toThrow(/Name the property/i);
  });

  it("refuses a move to where it already is", async () => {
    const unit = await furnace();
    await expect(equipment.move(owner(), {
      id: unit.id, reason: "relocated", toPropertyId: houseId,
    })).rejects.toThrow(/already is/i);
  });

  it("refuses a reason it does not know", async () => {
    const unit = await furnace();
    await expect(equipment.move(owner(), { id: unit.id, reason: "vanished" as never }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to change the property on a patch", async () => {
    const unit = await furnace();
    /**
     * Letting an edit quietly change the address means an invoice from 2024
     * describes a job at an address the unit has never been to.
     */
    await expect(equipment.update(owner(), { id: unit.id, propertyId: rentalId }))
      .rejects.toThrow(/Record a move instead/i);
  });
});

run("what we did to it", () => {
  it("gathers the jobs, the readings and the faults", async () => {
    const unit = await furnace();

    const [job] = await raw<{ id: string }[]>`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary, equipment_id)
      values (${ORG}, 4101, ${customerId}, ${houseId}, 'completed', 'No heat', ${unit.id})
      returning id`;
    const [visit] = await raw<{ id: string }[]>`insert into public.visit
      (organization_id, job_id, status) values (${ORG}, ${job!.id}, 'completed') returning id`;
    await raw`insert into public.visit_asset
      (organization_id, visit_id, equipment_id, outcome, notes, completed_at)
      values (${ORG}, ${visit!.id}, ${unit.id}, 'fail', 'Cracked heat exchanger', now())`;
    await raw`insert into public.deficiency
      (organization_id, property_id, customer_id, equipment_id, severity, code, description)
      values (${ORG}, ${houseId}, ${customerId}, ${unit.id}, 'critical', 'HX-CRACK',
              'Cracked heat exchanger, unit red tagged')`;

    /**
     * All of this already existed, scattered across three tables that each
     * carry the equipment id and that nothing had ever joined. The question
     * a technician asks in front of a furnace is "what happened last time".
     */
    const past = await equipment.history(owner(), { id: unit.id });
    expect(past.jobs.map((j) => j.number)).toEqual([4101]);
    expect(past.inspected[0]).toMatchObject({ outcome: "fail" });
    expect(past.deficiencies[0]).toMatchObject({ severity: "critical", code: "HX-CRACK" });
  });

  it("still answers for a retired unit", async () => {
    const unit = await furnace();
    await equipment.move(owner(), { id: unit.id, reason: "replaced", movedOn: "2026-04-01" });
    await expect(equipment.history(owner(), { id: unit.id })).resolves.toBeTruthy();
  });

  it("refuses a unit that is not ours", async () => {
    await expect(equipment.history(owner(), { id: fixtureId("eq:missing") }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});
