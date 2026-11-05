import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, time, type Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as stockUnits from "../src/services/stock-units";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as equipment from "../src/services/equipment";
import * as obligations from "../src/services/obligations";
import * as priceBook from "../src/services/pricebook";
import * as warranty from "../src/services/warranty-registration";
import * as makers from "../src/services/warranty-makers";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { createWarrantyMaker, correctWarrantyRegistration } from "../src/contracts";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * MAKERS WITH THEIR OWN REGISTRATION DAYS, AND TAKING A REGISTRATION BACK
 *
 * A maker is written down once with the days it gives, and a price book item
 * names the maker it comes from. The maker's days win when it has some; an item
 * with no maker, or a maker with no days, falls back to the item's own number as
 * it always did. A registration recorded by mistake is taken back by someone who
 * may write the queue, for a reason, and its deadline comes back with its
 * original last day.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("wmaker:org");
const USER = fixtureId("wmaker:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
let van = "";
let jobId = "";
let carrier = "";

const db = () => testDb(url!);
const as = (roles: string[], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);

async function item(code: string, name: string, days: number | null): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'equipment', ${code}) returning id`;
  await raw`
    insert into public.price_book_item_version (organization_id, item_id, version, name, price, warranty_registration_days, effective_from)
    values (${ORG}, ${row!.id}, 1, ${name}, '100.00', ${days}, now() - interval '1 day')`;
  await stockUnits.setTracking(owner(), { itemId: row!.id, mode: "serial" });
  return row!.id;
}

async function install(itemId: string, serial: string, key: string) {
  await inventory.receive(owner(), { itemId, locationId: van, quantity: "1", totalCost: "500.00", units: [{ number: serial }] });
  await inventory.issue(owner(key), {
    itemId, locationId: van, quantity: "1", jobId,
    units: [{ number: serial, installAs: { category: "Furnace", manufacturer: "Carrier", model: "59SC5" } }],
  });
  const [unit] = await raw<{ id: string }[]>`select id from public.equipment where organization_id = ${ORG} and serial_number = ${serial}`;
  return unit!.id;
}

const deadline = async (unitId: string) => {
  const [row] = await raw<{ id: string; state: string; due_at: Date; consequence: string | null; satisfied_at: Date | null; satisfied_by_event: string | null; escalated_at: Date | null }[]>`
    select id, state, due_at, consequence, satisfied_at, satisfied_by_event, escalated_at from public.obligation
    where organization_id = ${ORG} and kind = 'warranty.register_by' and entity_id = ${unitId} order by created_at desc limit 1`;
  return row;
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Maker Co", slug: "maker-co-reg" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  [{ id: van }] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name) values (${ORG}, 'Van 4') returning id` as unknown as [{ id: string }];
  const customer = await customers.create(owner(), {
    type: "residential", name: "Wren Maker", phone: "+15125550188",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "4 Maker Row", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  jobId = (await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "Replace the furnace", tags: [], customFields: {},
  })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("the list of makers", () => {
  it("adds a maker with its days, refuses a name already used without regard to case and days out of range, and audits", async () => {
    expect(createWarrantyMaker.input.safeParse({ name: "X", registrationDays: 0 }).success).toBe(false);
    expect(createWarrantyMaker.input.safeParse({ name: "X", registrationDays: 366 }).success).toBe(false);

    const made = await makers.create(owner("maker-create-1"), { name: " Carrier Corporation ", registrationDays: 90, notes: "carrier.example/register" });
    carrier = made.id;
    expect(made).toEqual({ id: carrier, name: "Carrier Corporation", registrationDays: 90, notes: "carrier.example/register", items: 0 });
    // A retried create is the first answer, not a second maker.
    expect((await makers.create(owner("maker-create-1"), { name: "Carrier Corporation", registrationDays: 90 })).id).toBe(carrier);
    await expect(makers.create(owner(), { name: "carrier corporation" }))
      .rejects.toThrow('There is already a maker called "carrier corporation".');
    await expect(makers.create(owner(), { name: "Bad", registrationDays: 0 })).rejects.toThrow(/whole number from 1 to 365/);
    await expect(makers.create(owner(), { name: "  " })).rejects.toThrow(/needs a name/);

    const [audit] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log where organization_id = ${ORG} and action = 'warranty_maker.created' and entity_id = ${carrier}`;
    expect(audit!.n).toBe(1);
    expect((await makers.list(owner())).makers.map((m) => m.name)).toEqual(["Carrier Corporation"]);
  });

  it("is read with pricebook:read and written with pricebook:write only", async () => {
    await expect(makers.list(as(["technician"]))).resolves.toBeTruthy();
    await expect(makers.create(as(["office_manager"]), { name: "Nope" })).rejects.toThrow(PermissionError);
    await expect(makers.update(as(["technician"]), { id: carrier, name: "Nope" })).rejects.toThrow(PermissionError);
    await expect(makers.retire(as(["dispatcher"]), { id: carrier })).rejects.toThrow(PermissionError);
  });

  it("renames and changes days, audited, and is another company's to find nothing of", async () => {
    const changed = await makers.update(owner(), { id: carrier, registrationDays: 60 });
    expect(changed.registrationDays).toBe(60);
    const [audit] = await raw<{ before: { registrationDays: number }; after: { registrationDays: number } }[]>`
      select before, after from public.audit_log where organization_id = ${ORG} and action = 'warranty_maker.updated' and entity_id = ${carrier}`;
    expect([audit!.before.registrationDays, audit!.after.registrationDays]).toEqual([90, 60]);
    await makers.update(owner(), { id: carrier, registrationDays: 90 });
    await expect(makers.update(owner(), { id: crypto.randomUUID(), name: "Ghost" })).rejects.toThrow(NotFoundError);
  });
});

run("an item names its maker", () => {
  it("is set and taken off on the item, refuses a maker that does not exist, and a maker cannot be retired while it is named", async () => {
    const furnace = await item("MK-FURN", "Furnace", 30);
    await expect(priceBook.updateItem(owner(), { id: furnace, warrantyMakerId: crypto.randomUUID() })).rejects.toThrow(NotFoundError);
    const set = await priceBook.updateItem(owner(), { id: furnace, warrantyMakerId: carrier });
    expect(set).toMatchObject({ warrantyMakerId: carrier, warrantyRegistrationDays: 30 });
    expect((await makers.list(owner())).makers[0]).toMatchObject({ id: carrier, items: 1 });
    await expect(makers.retire(owner(), { id: carrier })).rejects.toThrow(/One item still comes from Carrier Corporation/);

    const off = await priceBook.updateItem(owner(), { id: furnace, warrantyMakerId: null });
    expect(off?.warrantyMakerId).toBeNull();
    await priceBook.updateItem(owner(), { id: furnace, warrantyMakerId: carrier });
  });
});

run("which days a unit is registered within", () => {
  it("uses the maker's days over the item's own, and names the maker in the deadline", async () => {
    const furnace = await item("MK-FURN-2", "Furnace 2", 30);
    await priceBook.updateItem(owner(), { id: furnace, warrantyMakerId: carrier });
    const unitId = await install(furnace, "MK-1001", "mk-issue-1001");
    const row = await deadline(unitId);
    const lastDay = companyToday(90);
    expect(row!.due_at.toISOString()).toBe(time.startOfDayIn(time.nextDay(lastDay), ZONE).toISOString());
    // The maker's name, not the make typed on the unit.
    expect(row!.consequence).toMatch(new RegExp(`^Register the Furnace \\(59SC5, serial MK-1001\\) with Carrier Corporation by ${lastDay}\\.`));
  });

  it("falls back to the item's own days for a maker with none, and for an item with no maker", async () => {
    const quiet = await makers.create(owner(), { name: "Quiet Maker" });
    const withQuiet = await item("MK-FURN-3", "Furnace 3", 45);
    await priceBook.updateItem(owner(), { id: withQuiet, warrantyMakerId: quiet.id });
    const unitA = await install(withQuiet, "MK-2001", "mk-issue-2001");
    expect((await deadline(unitA))!.due_at.toISOString()).toBe(time.startOfDayIn(time.nextDay(companyToday(45)), ZONE).toISOString());

    const nobody = await item("MK-FURN-4", "Furnace 4", 20);
    const unitB = await install(nobody, "MK-2002", "mk-issue-2002");
    expect((await deadline(unitB))!.due_at.toISOString()).toBe(time.startOfDayIn(time.nextDay(companyToday(20)), ZONE).toISOString());
  });

  it("raises nothing for a maker with no days on an item with no days either", async () => {
    const quiet = (await makers.list(owner())).makers.find((m) => m.name === "Quiet Maker")!;
    const none = await item("MK-FURN-5", "Furnace 5", null);
    await priceBook.updateItem(owner(), { id: none, warrantyMakerId: quiet.id });
    const unit = await install(none, "MK-3001", "mk-issue-3001");
    expect(await deadline(unit)).toBeUndefined();
  });

  it("moves no deadline that is already open when the maker's days change, and counts the next install from the new days", async () => {
    const furnace = await item("MK-FURN-6", "Furnace 6", null);
    const shifting = await makers.create(owner(), { name: "Shifting Maker", registrationDays: 10 });
    await priceBook.updateItem(owner(), { id: furnace, warrantyMakerId: shifting.id });
    const first = await install(furnace, "MK-4001", "mk-issue-4001");
    const before = await deadline(first);
    await makers.update(owner(), { id: shifting.id, registrationDays: 100 });
    expect((await deadline(first))!.due_at.toISOString()).toBe(before!.due_at.toISOString());
    const second = await install(furnace, "MK-4002", "mk-issue-4002");
    expect((await deadline(second))!.due_at.toISOString()).toBe(time.startOfDayIn(time.nextDay(companyToday(100)), ZONE).toISOString());
  });
});

run("taking a registration back", () => {
  it("clears the unit and reopens the deadline with its last day, audited with the reason", async () => {
    const furnace = await item("MK-FURN-7", "Furnace 7", 30);
    const unitId = await install(furnace, "MK-5001", "mk-issue-5001");
    const original = await deadline(unitId);
    await warranty.record(owner(), { id: unitId, reference: "WRONG-1" });
    expect((await deadline(unitId))!.state).toBe("satisfied");

    const done = await warranty.correct(owner("mk-correct-5001"), { id: unitId, reason: "  Wrong unit, it was the one next door  " });
    expect(done).toEqual({
      id: unitId, wasRegisteredOn: companyToday(), wasReference: "WRONG-1", reopened: true, dueBy: companyToday(30),
    });
    const reopened = await deadline(unitId);
    expect(reopened).toMatchObject({ state: "open", satisfied_at: null, satisfied_by_event: null, escalated_at: null });
    expect(reopened!.id).toBe(original!.id);
    expect(reopened!.due_at.toISOString()).toBe(original!.due_at.toISOString());
    const seen = await equipment.get(owner(), { id: unitId });
    expect(seen.warrantyRegistration).toEqual({ registeredOn: null, reference: null, dueBy: companyToday(30), overdue: false });
    expect((await obligations.open(owner(), { kind: "warranty.register_by" })).map((o) => o.entityId)).toContain(unitId);

    const [audit] = await raw<{ before: { registeredOn: string; reference: string }; after: { reason: string; reopened: boolean } }[]>`
      select before, after from public.audit_log
      where organization_id = ${ORG} and action = 'equipment.warranty_registration_corrected' and entity_id = ${unitId}`;
    expect(audit!.before).toEqual({ registeredOn: companyToday(), reference: "WRONG-1" });
    expect(audit!.after).toMatchObject({ reason: "Wrong unit, it was the one next door", reopened: true });

    // A retry with the same key is the first answer, not a second correction.
    expect(await warranty.correct(owner("mk-correct-5001"), { id: unitId, reason: "again" })).toEqual(done);
    // And it can be recorded again, closing the same deadline.
    expect(await warranty.record(owner(), { id: unitId })).toMatchObject({ closed: 1 });
  });

  it("brings a deadline that has passed back past due", async () => {
    const furnace = await item("MK-FURN-8", "Furnace 8", 30);
    const unitId = await install(furnace, "MK-5002", "mk-issue-5002");
    await raw`update public.obligation set due_at = now() - interval '3 days'
      where organization_id = ${ORG} and entity_id = ${unitId} and kind = 'warranty.register_by'`;
    await warranty.record(owner(), { id: unitId });
    await warranty.correct(owner(), { id: unitId, reason: "Not done" });
    expect((await equipment.get(owner(), { id: unitId })).warrantyRegistration.overdue).toBe(true);
  });

  it("refuses without a reason, with nothing recorded, and to somebody who may not write the queue", async () => {
    const furnace = await item("MK-FURN-9", "Furnace 9", 30);
    const unitId = await install(furnace, "MK-5003", "mk-issue-5003");
    await expect(warranty.correct(owner(), { id: unitId, reason: "Oops" })).rejects.toThrow(/nothing to correct/);
    await warranty.record(as(["technician"]), { id: unitId });
    await expect(warranty.correct(owner(), { id: unitId, reason: "   " })).rejects.toThrow(ConflictError);
    // A technician records it; putting the deadline back in the queue is the office's.
    await expect(warranty.correct(as(["technician"]), { id: unitId, reason: "Oops" })).rejects.toThrow(PermissionError);
    expect(correctWarrantyRegistration.permissions).toEqual(["equipment:write", "task:write"]);
    await expect(warranty.correct(owner(), { id: crypto.randomUUID(), reason: "Oops" })).rejects.toThrow(NotFoundError);
    expect((await equipment.get(owner(), { id: unitId })).warrantyRegistration.registeredOn).toBe(companyToday());
  });

  it("reopens nothing for a unit that never had a deadline, and says so; and nothing a waiver or cancellation closed", async () => {
    const none = await item("MK-FURN-10", "Furnace 10", null);
    const unitId = await install(none, "MK-5004", "mk-issue-5004");
    await warranty.record(owner(), { id: unitId });
    expect(await warranty.correct(owner(), { id: unitId, reason: "Mistake" })).toMatchObject({ reopened: false, dueBy: null });

    const withDays = await item("MK-FURN-11", "Furnace 11", 30);
    const waived = await install(withDays, "MK-5005", "mk-issue-5005");
    await raw`update public.obligation set state = 'waived', updated_at = now()
      where organization_id = ${ORG} and entity_id = ${waived} and kind = 'warranty.register_by'`;
    await warranty.record(owner(), { id: waived });
    expect(await warranty.correct(owner(), { id: waived, reason: "Mistake" })).toMatchObject({ reopened: false });
    expect((await deadline(waived))!.state).toBe("waived");
  });
});
