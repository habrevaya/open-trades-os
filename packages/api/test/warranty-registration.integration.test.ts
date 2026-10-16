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
import type { ServiceContext } from "../src/services/context";
import { createPriceBookItem, recordWarrantyRegistration, revisePriceBookItem } from "../src/contracts";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A MAKER'S REGISTRATION DEADLINE, FROM THE INSTALL TO THE DAY IT IS DONE
 *
 * The price book item says its maker asks for the unit to be registered within
 * so many days. Putting a serialised unit of that item on a job raises the
 * deadline `warranty.register_by` for the unit, counted from the company's day
 * of the install; recording the registration on the unit closes it with the
 * day it was done; and an item whose maker asks for nothing raises nothing.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("wreg:org");
const USER = fixtureId("wreg:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
let furnace = "";
let coil = "";
let plain = "";
let van = "";
let jobId = "";

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

/** A serial on the van, ready to go onto a job. */
async function stocked(itemId: string, serial: string): Promise<void> {
  await inventory.receive(owner(), { itemId, locationId: van, quantity: "1", totalCost: "500.00", units: [{ number: serial }] });
}

const open = () => raw<{ id: string; kind: string; entity_type: string; entity_id: string; state: string; due_at: Date; escalate_at: Date | null; consequence: string | null; satisfied_at: Date | null; satisfied_by_event: string | null }[]>`
  select * from public.obligation where organization_id = ${ORG} and kind = 'warranty.register_by' order by created_at`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Registration Co", slug: "registration-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  furnace = await item("FURN-80", "Furnace, 80 percent", 30);
  coil = await item("COIL-3T", "Evaporator coil, 3 ton", 60);
  plain = await item("BLOWER-1", "Blower, no registration", null);
  [{ id: van }] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name) values (${ORG}, 'Van 9') returning id` as unknown as [{ id: string }];
  const customer = await customers.create(owner(), {
    type: "residential", name: "Wren Lockhart", phone: "+15125550177",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "9 Cedar Row", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  jobId = (await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "Replace the furnace", tags: [], customFields: {},
  })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

const install = async (itemId: string, serial: string, key: string, installAs: { category: string; manufacturer?: string; model?: string }) => {
  await stocked(itemId, serial);
  await inventory.issue(owner(key), {
    itemId, locationId: van, quantity: "1", jobId, units: [{ number: serial, installAs }],
  });
  const [unit] = await raw<{ id: string }[]>`
    select id from public.equipment where organization_id = ${ORG} and serial_number = ${serial}`;
  return unit!.id;
};

run("the price book carries the term", () => {
  it("is empty for every item until somebody says, is set and cleared by a revision, and carries forward otherwise", async () => {
    expect(createPriceBookItem.input.safeParse({ kind: "equipment", code: "X", name: "X", price: "1.00", warrantyRegistrationDays: 0 }).success).toBe(false);
    expect(createPriceBookItem.input.safeParse({ kind: "equipment", code: "X", name: "X", price: "1.00", warrantyRegistrationDays: 366 }).success).toBe(false);

    const made = await priceBook.create(owner(), createPriceBookItem.input.parse({
      kind: "equipment", code: "HP-2T", name: "Heat pump, 2 ton", price: "4200.00", warrantyMonths: 120,
    }));
    expect(made.warrantyRegistrationDays).toBeNull();

    const set = await priceBook.revise(owner(), revisePriceBookItem.input.parse({ id: made.id, warrantyRegistrationDays: 45 }));
    expect(set).toMatchObject({ warrantyRegistrationDays: 45, warrantyMonths: 120 });
    // A revision of something else carries it forward, as the trade pack upgrade's does.
    const renamed = await priceBook.revise(owner(), revisePriceBookItem.input.parse({ id: made.id, price: "4300.00" }));
    expect(renamed.warrantyRegistrationDays).toBe(45);
    const cleared = await priceBook.revise(owner(), revisePriceBookItem.input.parse({ id: made.id, warrantyRegistrationDays: null }));
    expect(cleared.warrantyRegistrationDays).toBeNull();
  });
});

run("installing a unit raises the deadline", () => {
  it("raises one for the unit, counted from the company's day, due at the end of the last day, once whatever is retried", async () => {
    const unitId = await install(furnace, "FN-2001", "issue-fn-2001", { category: "Furnace", manufacturer: "Carrier", model: "59SC5" });
    // A retried issue is the first one: no second deadline.
    await inventory.issue(owner("issue-fn-2001"), {
      itemId: furnace, locationId: van, quantity: "1", jobId,
      units: [{ number: "FN-2001", installAs: { category: "Furnace", manufacturer: "Carrier", model: "59SC5" } }],
    });

    const rows = (await open()).filter((r) => r.entity_id === unitId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    const lastDay = companyToday(30);
    expect(row).toMatchObject({ entity_type: "equipment", state: "open" });
    expect(row!.due_at.toISOString()).toBe(time.startOfDayIn(time.nextDay(lastDay), ZONE).toISOString());
    // The reminder lands in the queue a week ahead.
    expect(row!.escalate_at!.toISOString()).toBe(time.startOfDayIn(companyToday(23), ZONE).toISOString());
    expect(row!.consequence).toMatch(new RegExp(
      `^Register the Furnace \\(59SC5, serial FN-2001\\) with Carrier by ${lastDay}\\. The warranty may not start until it is registered\\. It went in on job \\d+\\.$`));

    const seen = await equipment.get(owner(), { id: unitId });
    expect(seen.warrantyRegistration).toEqual({ registeredOn: null, reference: null, dueBy: lastDay, overdue: false });
    // It is in the deadlines everybody reads, soonest first, with the kind named.
    expect((await obligations.open(owner(), { kind: "warranty.register_by" })).map((o) => o.entityId)).toContain(unitId);
  });

  it("raises nothing for an item whose maker asks for nothing", async () => {
    const before = (await open()).length;
    await install(plain, "BL-1", "issue-bl-1", { category: "Blower" });
    expect(await open()).toHaveLength(before);
  });

  it("does not stack a second deadline on a unit that already has one open, when another part goes into it", async () => {
    const [unit] = await raw<{ id: string }[]>`select id from public.equipment where organization_id = ${ORG} and serial_number = 'FN-2001'`;
    await stocked(coil, "CL-3001");
    await inventory.issue(owner(), {
      itemId: coil, locationId: van, quantity: "1", jobId, units: [{ number: "CL-3001", equipmentId: unit!.id }],
    });
    expect((await open()).filter((r) => r.entity_id === unit!.id)).toHaveLength(1);
  });
});

run("recording the registration", () => {
  it("closes the deadline with the day it was done and the maker's reference, and shows it on the unit", async () => {
    const unitId = await install(furnace, "FN-2002", "issue-fn-2002", { category: "Furnace", manufacturer: "Carrier", model: "59SC5" });
    const done = await warranty.record(as(["technician"]), { id: unitId, reference: " CR-77120 " });
    expect(done).toEqual({ id: unitId, registeredOn: companyToday(), reference: "CR-77120", closed: 1 });

    const [row] = (await open()).filter((r) => r.entity_id === unitId);
    expect(row).toMatchObject({ state: "satisfied", satisfied_by_event: `Registered with the maker on ${companyToday()}, reference CR-77120` });
    // Closed deadlines leave the live list.
    expect((await obligations.open(owner(), { kind: "warranty.register_by" })).map((o) => o.entityId)).not.toContain(unitId);
    const seen = await equipment.get(owner(), { id: unitId });
    expect(seen.warrantyRegistration).toEqual({ registeredOn: companyToday(), reference: "CR-77120", dueBy: null, overdue: false });

    // Saying it again corrects the reference the unit shows and closes nothing more.
    const again = await warranty.record(owner(), { id: unitId, registeredOn: companyToday(), reference: null });
    expect(again).toMatchObject({ registeredOn: companyToday(), reference: null, closed: 0 });
    const [audit] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log where organization_id = ${ORG} and action = 'equipment.warranty_registered' and entity_id = ${unitId}`;
    expect(audit!.n).toBe(2);
  });

  it("meets a deadline late when the registration came after it, rather than hiding that", async () => {
    const unitId = await install(furnace, "FN-2003", "issue-fn-2003", { category: "Furnace" });
    await raw`update public.obligation set due_at = now() - interval '2 days'
      where organization_id = ${ORG} and entity_id = ${unitId} and kind = 'warranty.register_by'`;
    const seen = await equipment.get(owner(), { id: unitId });
    expect(seen.warrantyRegistration.overdue).toBe(true);

    await warranty.record(owner(), { id: unitId });
    const [row] = (await open()).filter((r) => r.entity_id === unitId);
    expect(row!.state).toBe("satisfied");
    expect(row!.satisfied_at!.getTime()).toBeGreaterThan(row!.due_at.getTime());
  });

  it("refuses a day that has not come, a day before the unit went in, a unit that is gone, and somebody who may not write the register", async () => {
    const unitId = await install(furnace, "FN-2004", "issue-fn-2004", { category: "Furnace" });
    await expect(warranty.record(owner(), { id: unitId, registeredOn: companyToday(1) }))
      .rejects.toThrow(/has not come yet/);
    await expect(warranty.record(owner(), { id: unitId, registeredOn: companyToday(-10) }))
      .rejects.toThrow(/before the unit went in/);
    await expect(warranty.record(as(["readonly"]), { id: unitId })).rejects.toThrow(PermissionError);
    expect(recordWarrantyRegistration.input.safeParse({ id: unitId, reference: "x".repeat(121) }).success).toBe(false);
    // Nothing was closed by the refusals.
    expect((await open()).find((r) => r.entity_id === unitId)!.state).toBe("open");

    await equipment.retire(owner(), { id: unitId, reason: "Replaced under warranty" });
    await expect(warranty.record(owner(), { id: unitId })).rejects.toThrow(/Equipment not found|not found/i);
  });
});

run("the reminder and the retired unit", () => {
  it("puts a task about the unit in the queue when the reminder day comes, and takes it out when the unit is registered", async () => {
    const unitId = await install(furnace, "FN-2005", "issue-fn-2005", { category: "Furnace", manufacturer: "Carrier", model: "59SC5" });
    await raw`update public.obligation set escalate_at = now() - interval '1 hour'
      where organization_id = ${ORG} and entity_id = ${unitId} and kind = 'warranty.register_by'`;
    expect((await obligations.sweep(owner())).escalated).toBeGreaterThanOrEqual(1);

    const tasks = await raw<{ id: string; title: string; status: string; priority: string }[]>`
      select id, title, status, priority from public.task
      where organization_id = ${ORG} and entity_type = 'equipment' and entity_id = ${unitId}`;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: `Register the Furnace (59SC5, serial FN-2005) with Carrier by ${companyToday(30)}`, status: "open", priority: "high",
    });
    // The sweep is once: a second pass raises nothing more.
    await obligations.sweep(owner());
    expect(await raw`select id from public.task where organization_id = ${ORG} and entity_id = ${unitId}`).toHaveLength(1);

    await warranty.record(owner(), { id: unitId });
    const [after] = await raw<{ status: string; outcome: string | null }[]>`
      select status, outcome from public.task where id = ${tasks[0]!.id}`;
    expect(after).toMatchObject({ status: "done", outcome: `Registered with the maker on ${companyToday()}.` });
  });

  it("cancels the deadline and its reminder when the unit is taken off the register, and does not count it as met", async () => {
    const unitId = await install(furnace, "FN-2006", "issue-fn-2006", { category: "Furnace" });
    await raw`update public.obligation set escalate_at = now() - interval '1 hour'
      where organization_id = ${ORG} and entity_id = ${unitId} and kind = 'warranty.register_by'`;
    await obligations.sweep(owner());

    await equipment.retire(owner(), { id: unitId, reason: "Swapped for a new one" });
    expect((await open()).find((r) => r.entity_id === unitId)!.state).toBe("cancelled");
    const [task] = await raw<{ status: string }[]>`
      select status from public.task where organization_id = ${ORG} and entity_type = 'equipment' and entity_id = ${unitId}`;
    expect(task!.status).toBe("done");
  });
});
