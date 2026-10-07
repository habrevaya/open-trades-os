import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as rentals from "../src/services/rentals";
import * as trucks from "../src/services/trucks";
import * as assets from "../src/services/assets";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as dispatchMap from "../src/services/dispatch-map";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * EACH TRUCK ITS OWN KIND
 *
 * A driver's day is planned on the truck the driver has: its kind says how
 * many containers it carries, which sizes it lifts and how long the yard
 * takes it, the company's figures are the default for a driver with no
 * truck of a kind, and the proposal says which it used.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("tk:org");
const USER = fixtureId("tk:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Hook And Roll", slug: "truck-kinds-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
});

afterAll(async () => { if (raw) await raw.end(); });

const kind = (name: string, extra: Partial<trucks.TruckKindInput> = {}) =>
  trucks.createKind(owner(), { name, containersCarried: 1, yardMinutes: 20, ...extra });

run("kinds of truck", () => {
  it("records a kind, replays a retry, and refuses a second with the same name", async () => {
    const first = await trucks.createKind(owner("tk-1"), { name: "Roll off", containersCarried: 1, containerSizes: [30, 20, 20], yardMinutes: 25 });
    expect(first).toMatchObject({ name: "Roll off", containersCarried: 1, containerSizes: [20, 30], yardMinutes: 25, trucks: [] });
    const again = await trucks.createKind(owner("tk-1"), { name: "Roll off", containersCarried: 1, containerSizes: [30, 20, 20], yardMinutes: 25 });
    expect(again.id).toBe(first.id);
    await expect(kind("Roll off")).rejects.toThrow(/already on the list/);
    expect((await trucks.listKinds(owner())).kinds.map((k) => k.name)).toEqual(["Roll off"]);
  });

  it("refuses figures the planner cannot reason about, in words", async () => {
    await expect(kind("  ")).rejects.toThrow(/name/);
    await expect(kind("Big", { containersCarried: 5 })).rejects.toThrow(/between one and four/);
    await expect(kind("Slow", { yardMinutes: 200 })).rejects.toThrow(/none and two hours/);
    await expect(kind("Odd", { containerSizes: [12.5] })).rejects.toThrow(/whole cubic yards/);
  });

  it("lets the office read them and only the people who write the fleet change them", async () => {
    await expect(trucks.listKinds(as(["dispatcher"]))).resolves.toBeDefined();
    await expect(trucks.createKind(as(["dispatcher"]), { name: "Nope", containersCarried: 1, yardMinutes: 10 }))
      .rejects.toMatchObject({ name: "PermissionError" });
    await expect(trucks.listKinds(as(["csr"]))).rejects.toMatchObject({ name: "PermissionError" });
  });

  it("changes a kind and keeps a name unique when it is changed", async () => {
    const hook = await kind("Hook lift", { containersCarried: 2 });
    const changed = await trucks.updateKind(owner(), { id: hook.id, yardMinutes: 40, containerSizes: [10, 20] });
    expect(changed).toMatchObject({ containersCarried: 2, yardMinutes: 40, containerSizes: [10, 20] });
    await expect(trucks.updateKind(owner(), { id: hook.id, name: "Roll off" })).rejects.toThrow(/already on the list/);
    await expect(trucks.updateKind(owner(), { id: hook.id, containersCarried: 0 })).rejects.toThrow(/between one and four/);
  });

  it("gives a kind only to a vehicle, and refuses to retire one a truck still has", async () => {
    const roll = (await trucks.listKinds(owner())).kinds.find((k) => k.name === "Roll off")!;
    const chipper = await assets.registerAsset(owner(), { kind: "powered_tool", label: "Chipper 2" });
    await expect(trucks.setTruckKind(owner(), { assetId: chipper.id, truckKindId: roll.id }))
      .rejects.toThrow(/not a vehicle/);
    const van = await assets.registerAsset(owner(), { kind: "vehicle", label: "Truck 3" });
    await expect(trucks.setTruckKind(owner(), { assetId: van.id, truckKindId: fixtureId("tk:nobody") }))
      .rejects.toThrow(/Kind of truck/);
    await trucks.setTruckKind(owner(), { assetId: van.id, truckKindId: roll.id });
    expect((await trucks.listKinds(owner())).kinds.find((k) => k.id === roll.id)!.trucks).toEqual([{ id: van.id, label: "Truck 3" }]);
    await expect(trucks.retireKind(owner(), { id: roll.id })).rejects.toThrow(/Truck 3 is still a Roll off/);
    await trucks.setTruckKind(owner(), { assetId: van.id, truckKindId: null });
    await trucks.retireKind(owner(), { id: roll.id });
    expect((await trucks.listKinds(owner())).kinds.map((k) => k.name)).not.toContain("Roll off");
    /** The name is free again. */
    await expect(kind("Roll off")).resolves.toMatchObject({ name: "Roll off" });
  });
});

run("a driver's day on the truck the driver has", () => {
  const day = companyToday(6);
  let driverId = "";
  const stops: { id: string; jobId: string }[] = [];
  let truckId = "";

  beforeAll(async () => {
    const [yard] = await raw<{ id: string }[]>`
      insert into public.location (organization_id, name, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
      values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.75)}, 'placed', 'manual')
      returning id`;
    const [m] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} limit 1`;
    const [driver] = await raw<{ id: string }[]>`
      insert into public.technician (organization_id, membership_id, display_name, home_location_id)
      values (${ORG}, ${m!.id}, 'Rae Driver', ${yard!.id}) returning id`;
    driverId = driver!.id;
    const [drop] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, code, capacity_model)
      values (${ORG}, 'Delivery', 'delivery', 'asset_rental') returning id`;
    const customer = await customers.create(owner(), {
      type: "commercial", name: "Site Works", phone: "+15125550177",
      paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
    });
    /** Two drops of 20 yard cans, each a few kilometres out. */
    for (const [i, lng] of [-97.70, -97.66].entries()) {
      const property = await properties.create(owner(), {
        address: { line1: `${i + 1} Quarry Rd`, city: "Austin", state: "TX", postalCode: "78702", country: "US" },
        hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
      });
      await raw`update public.property set latitude = ${geo.formatCoordinate(30.30)}, longitude = ${geo.formatCoordinate(lng)},
        location_precision = 'rooftop', location_source = 'test' where id = ${property.id}`;
      const [job] = await raw<{ id: string }[]>`
        insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
        values (${ORG}, ${i + 1}, ${customer.id}, ${property.id}, ${drop!.id}, 'scheduled', 'Drop') returning id`;
      const [v] = await raw<{ id: string }[]>`
        insert into public.visit (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes)
        values (${ORG}, ${job!.id}, 'dispatched', ${time.instantOfLocal(day, 8 * 60, ZONE)}, ${time.instantOfLocal(day, 17 * 60, ZONE)}, ${i + 1}, 20)
        returning id`;
      await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${v!.id}, ${driverId}, true)`;
      const can = await rentals.addAsset(owner(), { assetType: "roll_off_container", identifier: `T-${i + 1}`, size: "20 yard" });
      await rentals.deliver(owner(), { assetId: can.id, propertyId: property.id, jobId: job!.id, deliveredAt: time.instantOfLocal(day, 9 * 60, ZONE).toISOString() });
      stops.push({ id: v!.id, jobId: job!.id });
    }
    truckId = (await assets.registerAsset(owner(), { kind: "vehicle", label: "Truck 7" })).id;
  });

  const optimise = () => dispatchMap.optimise(owner(), { date: day, technicianId: driverId });

  it("plans a driver with no truck of a kind on the company's figures, and says so", async () => {
    const proposal = await optimise();
    expect(proposal.truck).toMatchObject({
      byTruck: true, source: "company", containersPerTruck: 1, yardMinutes: 20,
      truckLabel: null, kindName: null, sizes: [], notCarried: [], currentYardRuns: 1,
    });
  });

  it("plans the same day on the truck the driver holds that day", async () => {
    const hook = await kind("Hook lift two", { containersCarried: 2, containerSizes: [10, 20], yardMinutes: 35 });
    await trucks.setTruckKind(owner(), { assetId: truckId, truckKindId: hook.id });
    /** Having a kind is not enough: nobody is driving it yet. */
    expect((await optimise()).truck).toMatchObject({ source: "company", containersPerTruck: 1 });

    await assets.checkOut(owner(), { assetId: truckId, custodianKind: "technician", custodianId: driverId, on: companyToday(-1) });
    const proposal = await optimise();
    expect(proposal.truck).toMatchObject({
      byTruck: true, source: "truck", containersPerTruck: 2, yardMinutes: 35,
      truckLabel: "Truck 7", kindName: "Hook lift two", sizes: [10, 20], notCarried: [], currentYardRuns: 0,
    });
    expect(proposal.truck!.yardRuns.filter((r) => r.beforeVisitId !== null)).toEqual([]);
    expect(proposal.truck!.note).toMatch(/Truck 7 \(Hook lift two\): 2 containers at a time, 35 minutes/);
    /** Two cans on the truck at the start, so two drops need no yard run between them. */
    expect(proposal.truck!.startLoad).toEqual({ empties: 2, fulls: 0 });
  });

  it("names the stops for a container the truck does not lift, and does not plan a can for them", async () => {
    const big = await kind("Roll off thirty", { containersCarried: 1, containerSizes: [30, 40], yardMinutes: 15 });
    await trucks.setTruckKind(owner(), { assetId: truckId, truckKindId: big.id });
    const proposal = await optimise();
    expect(proposal.truck).toMatchObject({ source: "truck", containersPerTruck: 1, yardMinutes: 15, kindName: "Roll off thirty" });
    expect([...proposal.truck!.notCarried].sort()).toEqual(stops.map((s) => s.id).sort());
    expect(proposal.truck!.note).toMatch(/2 stops are for a container this truck does not lift/);
    expect(proposal.truck!.yardRuns).toEqual([]);
  });

  it("goes back to the company's figures the day after the truck is handed back", async () => {
    await assets.checkIn(owner(), { assetId: truckId, on: day });
    /** Half open: on the day it is handed back it is the next driver's. */
    expect((await optimise()).truck).toMatchObject({ source: "company" });
    await assets.checkOut(owner(), { assetId: truckId, custodianKind: "technician", custodianId: driverId, on: day });
    expect((await optimise()).truck).toMatchObject({ source: "truck", truckLabel: "Truck 7" });
  });

  it("falls back to the company's figures for a truck that has been retired", async () => {
    await assets.checkIn(owner(), { assetId: truckId, on: day });
    await assets.retireAsset(owner(), { id: truckId, retiredOn: companyToday(-1) });
    expect((await optimise()).truck).toMatchObject({ source: "company", truckLabel: null });
  });
});
