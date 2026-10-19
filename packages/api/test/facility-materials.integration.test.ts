import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as facilities from "../src/services/disposal-facilities";
import * as dispatchMap from "../src/services/dispatch-map";
import * as rentals from "../src/services/rentals";
import * as rentalBilling from "../src/services/rental-billing";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * WHAT A FACILITY TAKES AND WHAT IT CHARGES, AND WHERE A HAUL THEN GOES
 *
 * A facility lists the materials it takes, each with its own rate when it has
 * one. The day's plan leaves out a facility that does not take what the full
 * can holds, and weighs each one's fee beside the drive when the company has
 * said what an hour of the truck costs, saying in words what it chose and why.
 * The arithmetic is core's; this proves it through rows: the hire's material
 * and tonnage, the facility's list, the company's hour cost, and the answer.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("fm:org");
const USER = fixtureId("fm:user");
const DISPATCHER = fixtureId("fm:dispatcher");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => ({ ...as(USER, ["owner"]), idempotencyKey: `fm-${crypto.randomUUID()}` });

const day = companyToday(9);
let driverId = "";
let hireId = "";
const ids: Record<string, string> = {};

async function facility(name: string, longitude: number, extra: Partial<facilities.FacilityInput> = {}) {
  const made = await facilities.createFacility(owner(), { name, tipMinutes: 15, ...extra });
  await facilities.pinFacility(owner(), { id: made.id, latitude: 30.30, longitude });
  ids[name] = made.id;
  return made.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Green Haulers", slug: "facility-materials-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;

  const [yard] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
    values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.75)}, 'placed', 'manual')
    returning id`;
  const [m] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${USER} limit 1`;
  const [driver] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, home_location_id)
    values (${ORG}, ${m!.id}, 'Gus Driver', ${yard!.id}) returning id`;
  driverId = driver!.id;
  const [drop] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, code, capacity_model)
    values (${ORG}, 'Delivery', 'delivery', 'asset_rental') returning id`;
  const [pickup] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, code, capacity_model)
    values (${ORG}, 'Final pickup', 'pickup', 'asset_rental') returning id`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Garden Customer') returning id`;
  let n = 100;
  const stop = async (jobTypeId: string, lng: number, order: number) => {
    const [p] = await raw<{ id: string }[]>`
      insert into public.property (organization_id, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
      values (${ORG}, ${`${lng} Garden`}, 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test')
      returning id`;
    const [job] = await raw<{ id: string }[]>`
      insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
      values (${ORG}, ${n++}, ${customer!.id}, ${p!.id}, ${jobTypeId}, 'scheduled', 'Haul') returning id`;
    const [v] = await raw<{ id: string }[]>`
      insert into public.visit (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes)
      values (${ORG}, ${job!.id}, 'dispatched', ${time.instantOfLocal(day, 8 * 60, ZONE)}, ${time.instantOfLocal(day, 17 * 60, ZONE)}, ${order}, 20)
      returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${v!.id}, ${driverId}, true)`;
    return { visitId: v!.id, propertyId: p!.id };
  };
  const collect = await stop(pickup!.id, -97.70, 1);
  await stop(drop!.id, -97.69, 2);

  /** The can being collected: on site a week, holding yard waste, its price including three tons. */
  const [can] = await raw<{ id: string }[]>`
    insert into public.rentable_asset (organization_id, asset_type, identifier, size, status)
    values (${ORG}, 'roll_off_container', 'G-1', '20 yard', 'available') returning id`;
  const hire = await rentals.deliver(owner(), {
    assetId: can!.id, propertyId: collect.propertyId, deliveredOn: companyToday(-7), includedTons: "3", materialType: "Yard waste",
  });
  hireId = hire.id;
  await raw`update public.visit set rental_id = ${hireId}, rental_event = 'pickup' where id = ${collect.visitId}`;

  /** Nearest to the collection, then a bit farther, then a long way. */
  await facility("Near Transfer", -97.695, { feeBasis: "per_ton", feeAmount: "80.00" });
  await facility("Green Yard", -97.65, {
    feeBasis: "per_ton", feeAmount: "80.00", materials: [{ material: "Yard waste", feeBasis: "per_ton", feeAmount: "40.00" }],
  });
  await facility("Far Landfill", -97.55, { feeBasis: "per_load", feeAmount: "50.00" });
});

afterAll(async () => { if (raw) await raw.end(); });

const optimise = () => dispatchMap.optimise(as(USER, ["owner"]), { date: day, technicianId: driverId });
const only = async () => {
  const answer = await optimise();
  expect(answer.truck!.facilityRuns).toHaveLength(1);
  return answer.truck!.facilityRuns[0]!;
};

run("what a facility takes", () => {
  it("is saved with each material's rate, said in words, and refused in words when it is wrong", async () => {
    const listed = (await facilities.listFacilities(owner())).facilities.find((f) => f.name === "Green Yard")!;
    expect(listed.materials).toEqual([{ material: "Yard waste", feeBasis: "per_ton", feeAmount: "40.0000" }]);
    expect(listed.materialsText).toBe("Takes Yard waste, 40.00 a ton");
    expect((await facilities.listFacilities(owner())).facilities.find((f) => f.name === "Near Transfer")!.materialsText)
      .toBe("What it takes is not recorded");
    await expect(facilities.updateFacility(owner(), {
      id: ids["Green Yard"]!, materials: [{ material: "Brush", feeBasis: null, feeAmount: null }, { material: " brush ", feeBasis: null, feeAmount: null }],
    })).rejects.toThrow(/brush is listed twice/);
    await expect(facilities.updateFacility(owner(), {
      id: ids["Green Yard"]!, materials: [{ material: "Brush", feeBasis: "per_ton", feeAmount: null }],
    })).rejects.toThrow(/Brush: a rate needs both/);
    // A change that does not mention the list keeps it.
    expect((await facilities.updateFacility(owner(), { id: ids["Green Yard"]!, notes: "Mulch pile at the back" })).materials).toHaveLength(1);
  });

  it("says what is in a can, by a person who may change the fleet, and keeps it through the collection", async () => {
    await expect(rentals.setMaterial(as(DISPATCHER, ["dispatcher"]), { id: hireId, materialType: "Concrete" }))
      .rejects.toMatchObject({ name: "PermissionError" });
    // Said the same way again is no change, and nothing is written.
    expect((await rentals.setMaterial(owner(), { id: hireId, materialType: "  Yard   waste " })).materialType).toBe("Yard waste");
    expect((await rentals.setMaterial(owner(), { id: hireId, materialType: "Brush" })).materialType).toBe("Brush");
    expect((await rentals.setMaterial(owner(), { id: hireId, materialType: "Yard waste" })).materialType).toBe("Yard waste");
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and entity_id = ${hireId} and action = 'rental.material_set'`;
    expect(audited.length).toBe(2);
  });
});

run("where a haul goes", () => {
  it("leaves out a nearer facility that does not take the can's material, and says so", async () => {
    await facilities.updateFacility(owner(), { id: ids["Near Transfer"]!, materials: [{ material: "Concrete", feeBasis: null, feeAmount: null }] });
    const hop = await only();
    expect(hop.facilityName).toBe("Green Yard");
    expect(hop.notTaken).toEqual([]);
    expect(hop.why).toContain("Green Yard is the nearest one open when the truck gets there");
    expect(hop.why).toContain("Near Transfer does not take Yard waste.");
  });

  it("refuses the run in words when no facility on the map takes the load", async () => {
    await rentals.setMaterial(owner(), { id: hireId, materialType: "Tyres" });
    await facilities.updateFacility(owner(), { id: ids["Far Landfill"]!, materials: [{ material: "Metal", feeBasis: null, feeAmount: null }] });
    const hop = await only();
    expect(hop.notTaken).toEqual(["Tyres"]);
    expect(hop.why).toContain("No facility on the map takes everything on the truck.");
    expect(hop.why).toContain("does not take Tyres, so the run is refused");
    await rentals.setMaterial(owner(), { id: hireId, materialType: "Yard waste" });
    await facilities.updateFacility(owner(), { id: ids["Near Transfer"]!, materials: [] });
    await facilities.updateFacility(owner(), { id: ids["Far Landfill"]!, materials: [] });
  });

  it("does not weigh the fee until the company says what an hour of the truck costs, and says so", async () => {
    const hop = await only();
    // Near Transfer is nearest and takes anything; without an hour cost time alone chooses.
    expect(hop.facilityName).toBe("Near Transfer");
    expect(hop.feeWeighed).toBe(false);
    expect(hop.why).toContain("Fees are not weighed, because what an hour of the truck costs is not set");
  });

  it("weighs each fee for the load beside the drive once it is set, and sends the can where it costs least all told", async () => {
    await expect(rentalBilling.setRentalDispatch(owner(), { truckHourCost: "lots" })).rejects.toThrow(/amount of money/);
    await expect(rentalBilling.setRentalDispatch(as(DISPATCHER, ["dispatcher"]), { truckHourCost: "90.00" }))
      .rejects.toMatchObject({ name: "PermissionError" });
    expect((await rentalBilling.setRentalDispatch(owner(), { truckHourCost: "90.00" })).truckHourCost).toBe("90.0000");
    const hop = await only();
    // Three tons of yard waste: 240.00 at Near Transfer, 120.00 at Green Yard's own rate, 50.00 a load at Far Landfill.
    expect(hop.facilityName).toBe("Far Landfill");
    expect(hop).toMatchObject({ fee: "50.0000", feeWeighed: true });
    expect(hop.why).toContain("Far Landfill costs the least all told, 50.00 to tip");
    expect(hop.why).toContain("Green Yard is");
    expect(hop.why).toContain("would charge 120.00");
    expect(hop.why).toContain("Near Transfer is");
    expect(hop.why).toContain("would charge 240.00");
    expect(hop.why).toContain("Fees are weighed beside time, at 90.00 an hour of the truck.");

    // A dear hour makes the drive the larger cost, and the nearer one wins again.
    await rentalBilling.setRentalDispatch(owner(), { truckHourCost: "9000.00" });
    expect((await only()).facilityName).toBe("Near Transfer");
    // Cleared, the fee is not weighed again.
    const cleared = await rentalBilling.setRentalDispatch(owner(), { truckHourCost: null });
    expect(cleared.truckHourCost).toBeUndefined();
    expect((await only()).feeWeighed).toBe(false);
  });

  it("does not weigh the fee when one facility cannot say what the load would cost, and names it", async () => {
    await rentalBilling.setRentalDispatch(owner(), { truckHourCost: "90.00" });
    await facilities.updateFacility(owner(), { id: ids["Far Landfill"]!, feeBasis: null, feeAmount: null });
    const hop = await only();
    expect(hop.feeWeighed).toBe(false);
    expect(hop.why).toContain("Fees are not weighed, because Far Landfill cannot say what this load would cost.");
    await facilities.updateFacility(owner(), { id: ids["Far Landfill"]!, feeBasis: "per_load", feeAmount: "50.00" });
    await rentalBilling.setRentalDispatch(owner(), { truckHourCost: null });
  });

  it("works out a haul's fee at its material's rate when the facility prices it on its own", async () => {
    const collected = await rentals.pickUp(owner(), {
      id: hireId, pickedUpAt: new Date().toISOString(), tons: "2.5", facilityId: ids["Green Yard"]!,
    });
    // The material said at delivery stands through a collection that does not mention it.
    expect(collected.materialType).toBe("Yard waste");
    const figure = await db().transaction((tx) => facilities.feeFigure(tx as never, owner(), {
      disposalFee: null, disposalFacilityId: ids["Green Yard"]!, disposalFacility: "Green Yard", weightTons: "2.5", materialType: "Yard waste",
    }));
    expect(figure).toMatchObject({ ok: true, figure: { amount: "100.0000", source: "worked_out" } });
  });
});
