import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, rental as rt, time, type Actor } from "@opentradesos/core";
import * as rentals from "../src/services/rentals";
import * as facilities from "../src/services/disposal-facilities";
import * as geocoding from "../src/services/geocoding";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as dispatchMap from "../src/services/dispatch-map";
import type { GeocodingProvider, GeocodeRequest } from "../src/maps/provider";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday, holdWholePassLock, WHOLE_PASS_WAIT_MS } from "./helpers";

/**
 * DISPOSAL FACILITIES AS PLACES
 *
 * A facility has an address the worker puts on the map and a pin a person can
 * place, the week it takes loads, and a rate. A haul can name one, and a
 * driver's day runs through the default one: yard to customer to facility to
 * the next stop, with a facility that is shut at that hour refused in words.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("df:org");
const USER = fixtureId("df:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);

const weekdays = (open: string, close: string, days = [0, 1, 2, 3, 4, 5, 6]) => days.map((day) => ({ day, opens: open, closes: close }));

/**
 * This file connects a geocoder and runs the worker's pass, so it takes turns with
 * the other files that do (`holdWholePassLock`): their companies must not be
 * asked about by this one's fake, nor this one's by theirs.
 */
let releaseWholePass: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (url) releaseWholePass = await holdWholePassLock(url);
}, WHOLE_PASS_WAIT_MS);
afterAll(async () => { await releaseWholePass?.(); });

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Tip And Haul", slug: "disposal-facilities-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
});

afterAll(async () => {
  if (!raw) return;
  /** The geocoder connection would have other files' worker passes ask a fake about this company's addresses. */
  await raw`delete from public.integration_connection where organization_id = ${ORG}`;
  await raw.end();
});

run("recording a facility", () => {
  it("records the address, the week and the rate, and the first one becomes the default", async () => {
    const first = await facilities.createFacility(owner("df-1"), {
      name: "Austin Transfer Station", addressLine1: "9 Landfill Rd", city: "Austin", state: "TX", postalCode: "78744",
      hours: [...weekdays("07:00", "16:30", [1, 2, 3, 4, 5]), { day: 6, opens: "08:00", closes: "12:00" }],
      feeBasis: "per_ton", feeAmount: "62.5", minimumFee: "40",
    });
    expect(first).toMatchObject({
      name: "Austin Transfer Station", address: "9 Landfill Rd, Austin, TX 78744", isDefault: true, active: true,
      hoursText: "Mon to Fri 7:00 AM to 4:30 PM, Sat 8:00 AM to 12:00 PM", feeText: "62.50 a ton, at least 40.00",
      feeAmount: "62.5000", onTheMap: false, tipMinutes: 20,
    });
    const replay = await facilities.createFacility(owner("df-1"), { name: "Austin Transfer Station" });
    expect(replay.id).toBe(first.id);
    expect((await facilities.listFacilities(owner())).facilities).toHaveLength(1);
  });

  it("refuses what cannot be right, in words", async () => {
    await expect(facilities.createFacility(owner(), { name: " " })).rejects.toThrow(/name/);
    await expect(facilities.createFacility(owner(), { name: "X", hours: [{ day: 2, opens: "17:00", closes: "08:00" }] }))
      .rejects.toThrow(/Tuesday: it has to close after it opens/);
    await expect(facilities.createFacility(owner(), { name: "X", feeBasis: "per_ton" })).rejects.toThrow(/both what it is charged by/);
    await expect(facilities.createFacility(owner(), { name: "X", feeBasis: "per_ton", feeAmount: "sixty" })).rejects.toThrow(/amount of money/);
    await expect(facilities.createFacility(owner(), { name: "X", minimumFee: "10" })).rejects.toThrow(/Give the rate first/);
    await expect(facilities.createFacility(owner(), { name: "X", tipMinutes: 500 })).rejects.toThrow(/none and three hours/);
  });

  it("lets the office read and only fleet writers change", async () => {
    await expect(facilities.listFacilities(as(["dispatcher"]))).resolves.toBeDefined();
    await expect(facilities.createFacility(as(["dispatcher"]), { name: "Nope" })).rejects.toMatchObject({ name: "PermissionError" });
    await expect(facilities.listFacilities(as(["csr"]))).rejects.toMatchObject({ name: "PermissionError" });
  });

  it("keeps one default: making another the default takes it from the first", async () => {
    const second = await facilities.createFacility(owner(), { name: "County Landfill", feeBasis: "per_load", feeAmount: "185" });
    expect(second.isDefault).toBe(false);
    const promoted = await facilities.updateFacility(owner(), { id: second.id, isDefault: true });
    expect(promoted.isDefault).toBe(true);
    const list = (await facilities.listFacilities(owner())).facilities;
    expect(list.filter((f) => f.isDefault).map((f) => f.name)).toEqual(["County Landfill"]);
    const [first] = list.filter((f) => f.name === "Austin Transfer Station");
    await facilities.updateFacility(owner(), { id: first!.id, isDefault: true });
    expect((await facilities.listFacilities(owner())).facilities.filter((f) => f.isDefault).map((f) => f.name)).toEqual(["Austin Transfer Station"]);
  });

  it("closes a facility without deleting it, and a closed one is never the default", async () => {
    const old = await facilities.createFacility(owner(), { name: "Old Pit" });
    await expect(facilities.updateFacility(owner(), { id: old.id, active: false, isDefault: true })).rejects.toThrow(/closed facility cannot be the default/);
    await facilities.closeFacility(owner(), { id: old.id });
    expect((await facilities.listFacilities(owner())).facilities.map((f) => f.name)).not.toContain("Old Pit");
    const all = (await facilities.listFacilities(owner(), { includeClosed: true })).facilities;
    expect(all.find((f) => f.id === old.id)).toMatchObject({ active: false, isDefault: false });
  });

  it("is put on the map by the worker, and a pin placed by hand is never moved", async () => {
    await raw`insert into public.integration_connection (organization_id, capability, provider, status)
              values (${ORG}, 'maps', 'test-geocoder', 'connected')
              on conflict (organization_id, capability, provider) do update set status = 'connected'`;
    const provider: GeocodingProvider = {
      name: "test-geocoder",
      async geocode(request: GeocodeRequest) {
        return request.address.addressLine1 === "9 Landfill Rd"
          ? { kind: "found", lat: 30.2, lng: -97.7, precision: "rooftop", label: null }
          : { kind: "not_found", reason: "No such place in the test map." };
      },
    };
    const deps = { providerFor: () => provider };
    await geocoding.geocodePending(db(), { deps, limit: 100000, only: [ORG] });
    const placed = (await facilities.listFacilities(owner())).facilities.find((f) => f.name === "Austin Transfer Station")!;
    expect(placed).toMatchObject({ onTheMap: true, locationSource: "test-geocoder", locationPrecision: "rooftop" });
    expect(Number(placed.latitude)).toBeCloseTo(30.2, 3);

    const moved = await facilities.pinFacility(owner(), { id: placed.id, latitude: 30.25, longitude: -97.72 });
    expect(moved).toMatchObject({ locationSource: "manual", locationPrecision: "placed" });
    await facilities.updateFacility(owner(), { id: placed.id, addressLine1: "11 Landfill Rd" });
    await geocoding.geocodePending(db(), { deps, limit: 100000, only: [ORG] });
    const after = (await facilities.listFacilities(owner())).facilities.find((f) => f.id === placed.id)!;
    expect(after.locationSource).toBe("manual");
    expect(Number(after.latitude)).toBeCloseTo(30.25, 3);
    await expect(facilities.pinFacility(owner(), { id: placed.id, latitude: 0, longitude: 0 })).rejects.toThrow(/not a place on the map/);
    await expect(facilities.pinFacility(as(["dispatcher"]), { id: placed.id, latitude: 30.1, longitude: -97.7 }))
      .rejects.toMatchObject({ name: "PermissionError" });
  });

  it("says whether it is open at a time, in the company's clock, and in words when it is not", async () => {
    const [f] = (await facilities.listFacilities(owner())).facilities.filter((x) => x.name === "Austin Transfer Station");
    const tuesday = "2026-06-02";
    const at = (hhmm: string) => time.instantOfLocal(tuesday, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), ZONE).toISOString();
    expect(await facilities.openAt(owner(), { id: f!.id, at: at("10:00") })).toMatchObject({ open: true, why: null, hoursKnown: true });
    const late = await facilities.openAt(owner(), { id: f!.id, at: at("17:40") });
    expect(late.open).toBe(false);
    expect(late.why).toContain("Austin Transfer Station is closed at 5:40 PM on Tuesday");
    expect((await facilities.openAt(owner(), { id: f!.id, at: at("04:00") })).open).toBe(false);
    /** Sunday it keeps no hours. */
    expect((await facilities.openAt(owner(), { id: f!.id, at: time.instantOfLocal("2026-06-07", 600, ZONE).toISOString() })).why).toMatch(/closed on Sundays/);
    const unknown = await facilities.createFacility(owner(), { name: "Hours Unknown" });
    expect(await facilities.openAt(owner(), { id: unknown.id, at: at("03:00") })).toMatchObject({ open: true, hoursKnown: false });
  });
});

run("a haul that went to a facility", () => {
  let propertyId = "";
  const can = async (n: string) => (await rentals.addAsset(owner(), { assetType: "roll_off_container", identifier: n, size: "20 yard" })).id;

  beforeAll(async () => {
    const customer = await customers.create(owner(), {
      type: "commercial", name: "Quarry Co", phone: "+15125550166", paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
    });
    propertyId = (await properties.create(owner(), {
      address: { line1: "3 Pit Rd", city: "Austin", state: "TX", postalCode: "78702", country: "US" },
      hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
    })).id;
  });

  it("records the facility and writes its name as the haul's facility", async () => {
    const [f] = (await facilities.listFacilities(owner())).facilities.filter((x) => x.name === "County Landfill");
    const hire = await rentals.deliver(owner(), { assetId: await can("F-1"), propertyId, deliveredAt: new Date(Date.now() - 864e5).toISOString() });
    const done = await rentals.pickUp(owner(), { id: hire.id, tons: "2.0000", ticketNumber: "W-77", facility: "typed words", facilityId: f!.id });
    expect(done).toMatchObject({ disposalFacilityId: f!.id, disposalFacility: "County Landfill", disposalTicketNumber: "W-77" });
  });

  it("refuses a facility that has been closed, naming it", async () => {
    const gone = await facilities.createFacility(owner(), { name: "Shut Pit" });
    await facilities.closeFacility(owner(), { id: gone.id });
    const hire = await rentals.deliver(owner(), { assetId: await can("F-2"), propertyId, deliveredAt: new Date().toISOString() });
    await expect(rentals.pickUp(owner(), { id: hire.id, facilityId: gone.id })).rejects.toThrow(/Shut Pit has been closed/);
    await expect(rentals.pickUp(owner(), { id: hire.id, facilityId: fixtureId("df:nobody") })).rejects.toThrow(/Disposal facility/);
    /** The refusal wrote nothing: it is still out. */
    expect((await rentals.getRental(owner(), { id: hire.id })).open).toBe(true);
  });

  it("fills the facility from a ticket file only when the name is exactly a recorded one", async () => {
    const hire = await rentals.deliver(owner(), { assetId: await can("F-3"), propertyId, deliveredAt: new Date(Date.now() - 2 * 864e5).toISOString() });
    const day = companyToday();
    await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: time.instantOfLocal(day, 12 * 60, ZONE).toISOString() });
    const { rentalBilling } = await import("../src/services/index");
    const file = `Ticket,Date,Container,Net Tons,Facility\nT-900,${day},F-3,3.2,austin transfer station\n`;
    const applied = await rentalBilling.applyTickets(owner(), { csv: file });
    expect(applied.attached).toBe(1);
    const after = await rentals.getRental(owner(), { id: hire.id });
    expect(after.disposalFacilityId).not.toBeNull();
    expect(after.disposalFacility).toBe("austin transfer station");
  });
});

run("a driver's day through the facility", () => {
  const day = companyToday(9);
  let driverId = "";
  let facilityId = "";
  const stops: Record<string, string> = {};

  beforeAll(async () => {
    const [yard] = await raw<{ id: string }[]>`
      insert into public.location (organization_id, name, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
      values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.75)}, 'placed', 'manual')
      returning id`;
    const [m] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} limit 1`;
    const [driver] = await raw<{ id: string }[]>`
      insert into public.technician (organization_id, membership_id, display_name, home_location_id)
      values (${ORG}, ${m!.id}, 'Tia Driver', ${yard!.id}) returning id`;
    driverId = driver!.id;
    const [drop] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, code, capacity_model)
      values (${ORG}, 'Delivery', 'delivery', 'asset_rental') returning id`;
    const [pickup] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, code, capacity_model)
      values (${ORG}, 'Final pickup', 'pickup', 'asset_rental') returning id`;
    const [customer] = await raw<{ id: string }[]>`select id from public.customer where organization_id = ${ORG} limit 1`;
    let n = 100;
    const stop = async (name: string, jobTypeId: string, lng: number, order: number) => {
      const [p] = await raw<{ id: string }[]>`
        insert into public.property (organization_id, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
        values (${ORG}, ${`${lng} Site`}, 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test')
        returning id`;
      const [job] = await raw<{ id: string }[]>`
        insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
        values (${ORG}, ${n++}, ${customer!.id}, ${p!.id}, ${jobTypeId}, 'scheduled', 'Haul') returning id`;
      const [v] = await raw<{ id: string }[]>`
        insert into public.visit (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes)
        values (${ORG}, ${job!.id}, 'dispatched', ${time.instantOfLocal(day, 8 * 60, ZONE)}, ${time.instantOfLocal(day, 17 * 60, ZONE)}, ${order}, 20)
        returning id`;
      await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${v!.id}, ${driverId}, true)`;
      stops[name] = v!.id;
    };
    await stop("pickup", pickup!.id, -97.70, 1);
    await stop("drop", drop!.id, -97.69, 2);
    /** A facility a few kilometres past the collection, on the way to the drop. */
    const made = await facilities.createFacility(owner(), { name: "Day Plan Landfill", addressLine1: "5 Tip Rd", city: "Austin", state: "TX", postalCode: "78701", tipMinutes: 15 });
    facilityId = made.id;
    await facilities.pinFacility(owner(), { id: facilityId, latitude: 30.30, longitude: -97.695 });
  });

  const optimise = (extra: { facilityId?: string } = {}) => dispatchMap.optimise(owner(), { date: day, technicianId: driverId, ...extra });

  it("plans the tip at the facility when it is the default, and the yard when no facility is", async () => {
    /**
     * No facility to tip at: every one closed. (A day is now planned among every
     * active facility on the map, default or not, so having no default no longer
     * means the yard tips.)
     */
    await raw`update public.disposal_facility set is_default = false, active = false where organization_id = ${ORG}`;
    const without = await optimise();
    expect(without.truck).toMatchObject({ facility: null, facilityRuns: [], currentYardRuns: 1 });

    await raw`update public.disposal_facility set active = true where id = ${facilityId}`;
    await facilities.updateFacility(owner(), { id: facilityId, isDefault: true });
    const through = await optimise();
    expect(through.truck!.facility).toMatchObject({ id: facilityId, name: "Day Plan Landfill", used: true, tipMinutes: 15 });
    expect(through.truck!.facilityRuns).toHaveLength(1);
    expect(through.truck!.facilityRuns[0]).toMatchObject({ afterVisitId: stops["pickup"], beforeVisitId: stops["drop"], tipped: 1, closed: null });
    /** The empty it leaves with goes straight to the drop: no run to the yard in the middle of the day. */
    expect(through.truck!.yardRuns.filter((r) => r.beforeVisitId !== null)).toEqual([]);
    expect(through.proposed.driveMinutes).toBeLessThanOrEqual(without.proposed.driveMinutes);
    expect(through.truck!.note).toContain("Day Plan Landfill");
  });

  it("plans through the facility asked for, whatever the default is", async () => {
    const other = await facilities.createFacility(owner(), { name: "Asked For Pit" });
    await facilities.pinFacility(owner(), { id: other.id, latitude: 30.31, longitude: -97.80 });
    const asked = await optimise({ facilityId: other.id });
    expect(asked.truck!.facility).toMatchObject({ id: other.id, name: "Asked For Pit", used: true });
    await expect(optimise({ facilityId: fixtureId("df:missing") })).rejects.toThrow(/Disposal facility/);
    /** Stopped using, so the days that follow are planned around the default alone again. */
    await facilities.closeFacility(owner(), { id: other.id });
  });

  it("refuses a run that reaches the facility after it has closed, in words", async () => {
    const weekday = rt.weekdayOf(day);
    /** Open only early in the morning, before any truck could have reached it. */
    await facilities.updateFacility(owner(), { id: facilityId, hours: [{ day: weekday, opens: "04:00", closes: "05:00" }] });
    const shut = await optimise();
    const run_ = shut.truck!.facilityRuns[0]!;
    expect(run_.closed).toMatch(/Day Plan Landfill is closed at .* it is open 4:00 AM to 5:00 AM that day/);

    /** And a day it keeps no hours at all. */
    await facilities.updateFacility(owner(), { id: facilityId, hours: [{ day: (weekday + 1) % 7, opens: "07:00", closes: "16:00" }] });
    expect((await optimise()).truck!.facilityRuns[0]!.closed).toMatch(/closed on/);

    /** Open all day: no refusal. */
    await facilities.updateFacility(owner(), { id: facilityId, hours: [{ day: weekday, opens: "06:00", closes: "23:00" }] });
    expect((await optimise()).truck!.facilityRuns[0]!.closed).toBeNull();
  });

  it("says so, and plans with the yard, when the facility is not on the map", async () => {
    await facilities.unpinFacility(owner(), { id: facilityId });
    const answer = await optimise();
    expect(answer.truck!.facility).toMatchObject({ used: false });
    expect(answer.truck!.facility!.note).toMatch(/not on the map yet/);
    expect(answer.truck!.facilityRuns).toEqual([]);
  });
});
