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
 * A KIND OF TRUCK THAT CARRIES A DIFFERENT NUMBER OF EACH SIZE
 *
 * A hook lift that takes two 10 yard cans or one 20 yard. Rae's day is two
 * drops of 20 yard cans: on that truck she goes back to the yard between
 * them, because a second 20 does not fit beside the first; on a truck that
 * takes two 20 yard cans she does not. A kind with one figure plans as it
 * always did.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("truck-sizes:org");
const USER = fixtureId("truck-sizes:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Mixed Decks", slug: "truck-sizes-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("keeping how many of each size a kind carries", () => {
  it("records two 10 yard or one 20 yard, and counts those sizes among the ones it lifts", async () => {
    const hook = await trucks.createKind(owner("ts-1"), {
      name: "Small hook", containersCarried: 1, yardMinutes: 20,
      capacityBySize: [{ size: 20, carried: 1 }, { size: 10, carried: 2 }],
    });
    expect(hook).toMatchObject({
      containerSizes: [10, 20], capacityBySize: [{ size: 10, carried: 2 }, { size: 20, carried: 1 }],
    });
    const changed = await trucks.updateKind(owner(), { id: hook.id, capacityBySize: [] });
    expect(changed.capacityBySize).toEqual([]);
    /** Clearing how many of each leaves the sizes it lifts as they were. */
    expect(changed.containerSizes).toEqual([10, 20]);
  });

  it("refuses a figure the planner cannot reason about, and a size said twice, in words", async () => {
    await expect(trucks.createKind(owner(), {
      name: "Too many", containersCarried: 1, yardMinutes: 20, capacityBySize: [{ size: 10, carried: 5 }],
    })).rejects.toThrow(/between one and four 10 yard containers/);
    await expect(trucks.createKind(owner(), {
      name: "Twice", containersCarried: 1, yardMinutes: 20, capacityBySize: [{ size: 10, carried: 2 }, { size: 10, carried: 1 }],
    })).rejects.toThrow(/how many of each size once/);
  });
});

run("a driver's day checked by size", () => {
  const day = companyToday(6);
  let driverId = "";
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
      type: "commercial", name: "Site Works", phone: "+15125550178",
      paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
    });
    for (const [i, lng] of [-97.70, -97.66].entries()) {
      const property = await properties.create(owner(), {
        address: { line1: `${i + 1} Gravel Rd`, city: "Austin", state: "TX", postalCode: "78702", country: "US" },
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
      const can = await rentals.addAsset(owner(), { assetType: "roll_off_container", identifier: `S-${i + 1}`, size: "20 yard" });
      await rentals.deliver(owner(), { assetId: can.id, propertyId: property.id, jobId: job!.id, deliveredAt: time.instantOfLocal(day, 9 * 60, ZONE).toISOString() });
    }
    truckId = (await assets.registerAsset(owner(), { kind: "vehicle", label: "Truck 9" })).id;
    await assets.checkOut(owner(), { assetId: truckId, custodianKind: "technician", custodianId: driverId, on: companyToday(-1) });
  });

  const optimise = () => dispatchMap.optimise(owner(), { date: day, technicianId: driverId });

  it("goes back to the yard between two 20 yard drops on a truck that takes one 20 yard", async () => {
    const hook = await trucks.createKind(owner(), {
      name: "Two tens", containersCarried: 2, yardMinutes: 25,
      capacityBySize: [{ size: 10, carried: 2 }, { size: 20, carried: 1 }],
    });
    await trucks.setTruckKind(owner(), { assetId: truckId, truckKindId: hook.id });
    const proposal = await optimise();
    expect(proposal.truck).toMatchObject({
      source: "truck", kindName: "Two tens", containersPerTruck: 2, sizes: [10, 20],
      capacityBySize: [{ size: 10, carried: 2 }, { size: 20, carried: 1 }], notCarried: [],
    });
    expect(proposal.truck!.startLoad).toEqual({ empties: 1, fulls: 0 });
    expect(proposal.truck!.yardRuns.filter((r) => r.beforeVisitId !== null)).toHaveLength(1);
    expect(proposal.truck!.note).toMatch(/two 10 yard or one 20 yard at a time/);
  });

  it("drives both in one trip on a truck that takes two 20 yard cans", async () => {
    const big = await trucks.createKind(owner(), {
      name: "Two twenties", containersCarried: 1, yardMinutes: 25, capacityBySize: [{ size: 20, carried: 2 }],
    });
    await trucks.setTruckKind(owner(), { assetId: truckId, truckKindId: big.id });
    const proposal = await optimise();
    expect(proposal.truck!.startLoad).toEqual({ empties: 2, fulls: 0 });
    expect(proposal.truck!.yardRuns.filter((r) => r.beforeVisitId !== null)).toEqual([]);
  });

  it("plans a kind with one figure as it always did", async () => {
    const plain = await trucks.createKind(owner(), { name: "Plain two", containersCarried: 2, yardMinutes: 25 });
    await trucks.setTruckKind(owner(), { assetId: truckId, truckKindId: plain.id });
    const proposal = await optimise();
    expect(proposal.truck).toMatchObject({ capacityBySize: [], containersPerTruck: 2 });
    expect(proposal.truck!.startLoad).toEqual({ empties: 2, fulls: 0 });
    expect(proposal.truck!.note).toMatch(/2 containers at a time/);
  });
});
