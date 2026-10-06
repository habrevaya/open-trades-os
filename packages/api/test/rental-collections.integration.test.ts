import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as rentals from "../src/services/rentals";
import * as rentalBilling from "../src/services/rental-billing";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as dispatchMap from "../src/services/dispatch-map";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * COLLECTIONS BOOKED ON A CLOCK, AT THE TIME AGREED
 *
 * The worker's pass finds this company because it has a hire coming due,
 * books the collection on the day the price runs out (or at the time the
 * customer agreed, early or late), never twice, and leaves a company that
 * turned it off alone. A time agreed after the collection is on the board
 * moves it: kept with its driver on the same day, back to the board on
 * another.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("rc:org");
const USER = fixtureId("rc:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
let propertyId = "";
const db = () => testDb(url!);
const as = (roles: string[], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);
/** Noon in Austin on a day, as an instant. */
const noon = (day: string) => time.instantOfLocal(day, 12 * 60, ZONE);
const hour = (day: string, h: number) => time.instantOfLocal(day, h * 60, ZONE).toISOString();

async function can(identifier: string) {
  return (await rentals.addAsset(owner(), { assetType: "roll_off_container", identifier, size: "20 yard" })).id;
}

const listed = async () => (await raw<{ organization_id: string }[]>`
  select organization_id from app.rental_collection_organizations(100000)`).map((r) => r.organization_id);

const collection = async (rentalId: string) => (await raw<{
  id: string; window_start: Date; window_end: Date; status: string;
}[]>`select v.id, v.window_start, v.window_end, v.status from public.rental r
     join public.visit v on v.id = r.collection_visit_id where r.id = ${rentalId}`)[0];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Clock Bins", slug: "clock-bins" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const customer = await customers.create(owner(), {
    type: "commercial", name: "Site Works", phone: "+15125550188",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  });
  propertyId = (await properties.create(owner(), {
    address: { line1: "9 Quarry Rd", city: "Austin", state: "TX", postalCode: "78702", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  })).id;
  await raw`insert into public.job_type (organization_id, name, code, capacity_model)
    values (${ORG}, 'Final pickup', 'pickup', 'asset_rental')`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("collections on a clock", () => {
  it("reads the defaults: on, a day ahead, one can a truck", async () => {
    expect(await rentalBilling.rentalDispatch(owner())).toEqual({
      automaticCollections: true, collectionLeadDays: 1, containersPerTruck: 1, yardMinutes: 20,
    });
    await expect(rentalBilling.setRentalDispatch(owner(), { containersPerTruck: 9 })).rejects.toThrow(/between one and four/);
    await expect(rentalBilling.setRentalDispatch(as(["dispatcher"]), { yardMinutes: 10 }))
      .rejects.toMatchObject({ name: "PermissionError" });
  });

  it("books the hire due tomorrow on its own, in the working day, and never twice", async () => {
    /** Delivered six days ago on a seven day hire: due tomorrow. */
    const due = await rentals.deliver(owner(), {
      assetId: await can("K-1"), propertyId, deliveredAt: noon(companyToday(-5)).toISOString(), includedDays: 7,
    });
    /** Due in a fortnight: not yet. */
    const later = await rentals.deliver(owner(), {
      assetId: await can("K-2"), propertyId, deliveredAt: noon(companyToday()).toISOString(), includedDays: 14,
    });
    expect(await listed()).toContain(ORG);

    const first = await rentalBilling.collectionsFor(db(), ORG);
    expect(first.error).toBeNull();
    expect(first.run!.scheduled.map((s) => s.rentalId)).toEqual([due.id]);
    expect(first.run!.scheduled[0]).toMatchObject({ collectOn: companyToday(1), agreed: false, daysLate: 0 });
    const stop = await collection(due.id);
    expect(stop!.window_start.toISOString()).toBe(hour(companyToday(1), 8));
    expect(stop!.window_end.toISOString()).toBe(hour(companyToday(1), 17));
    expect((await rentals.getRental(owner(), { id: later.id })).collectionVisitId).toBeNull();

    const second = await rentalBilling.collectionsFor(db(), ORG);
    expect(second.run!.scheduled).toEqual([]);
    const audit = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and action = 'rental.collection_scheduled'`;
    expect(audit).toHaveLength(1);
  });

  it("books a hire at the time the customer agreed, ahead of the end of its price", async () => {
    /** A fourteen day hire the customer finished early: collect tomorrow between one and three. */
    const early = await rentals.deliver(owner(), {
      assetId: await can("K-3"), propertyId, deliveredAt: noon(companyToday(-2)).toISOString(), includedDays: 14,
    });
    await expect(rentalBilling.setCollectionTime(owner(), {
      id: early.id, start: hour(companyToday(1), 15), end: hour(companyToday(1), 13),
    })).rejects.toThrow(/end after it starts/);
    const agreed = await rentalBilling.setCollectionTime(owner(), {
      id: early.id, start: hour(companyToday(1), 13), end: hour(companyToday(1), 15),
    });
    expect(agreed).toMatchObject({ collectionAgreedStart: hour(companyToday(1), 13), moved: null });

    const run_ = await rentalBilling.collectionsFor(db(), ORG);
    expect(run_.run!.scheduled).toEqual([expect.objectContaining({ rentalId: early.id, agreed: true, collectOn: companyToday(1) })]);
    const stop = await collection(early.id);
    expect(stop!.window_start.toISOString()).toBe(hour(companyToday(1), 13));
    expect(stop!.window_end.toISOString()).toBe(hour(companyToday(1), 15));

    /** Agreed again for later the same day: the stop moves and stays as it is otherwise. */
    const later = await rentalBilling.setCollectionTime(owner(), {
      id: early.id, start: hour(companyToday(1), 15), end: hour(companyToday(1), 17),
    });
    expect(later.moved).toBe("kept");
    expect((await collection(early.id))!.window_start.toISOString()).toBe(hour(companyToday(1), 15));

    /** And for another day: back to the board for the dispatcher. */
    await raw`update public.visit set status = 'dispatched' where id = ${stop!.id}`;
    const otherDay = await rentalBilling.setCollectionTime(owner(), {
      id: early.id, start: hour(companyToday(3), 9), end: hour(companyToday(3), 11),
    });
    expect(otherDay.moved).toBe("returned_to_board");
    const moved = await collection(early.id);
    expect(moved!.status).toBe("unassigned");
    expect(moved!.window_start.toISOString()).toBe(hour(companyToday(3), 9));
  });

  it("leaves a company that turned it off alone", async () => {
    await rentals.deliver(owner(), {
      assetId: await can("K-4"), propertyId, deliveredAt: noon(companyToday(-6)).toISOString(), includedDays: 7,
    });
    await rentalBilling.setRentalDispatch(owner(), { automaticCollections: false });
    expect(await listed()).not.toContain(ORG);
    const off = await rentalBilling.collectionsFor(db(), ORG);
    expect(off.run).toBeNull();
    /** The button still books it. */
    const button = await rentalBilling.scheduleCollections(owner(), {});
    expect(button.scheduled.map((s) => s.assetIdentifier)).toEqual(["K-4"]);
    await rentalBilling.setRentalDispatch(owner(), { automaticCollections: true });
  });
});

run("a driver's day, by what is on the truck", () => {
  it("orders drops before collections where that saves runs to the yard, and says each run", async () => {
    const day = companyToday(4);
    const [yard] = await raw<{ id: string }[]>`
      insert into public.location (organization_id, name, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
      values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.75)}, 'placed', 'manual')
      returning id`;
    const [m] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} limit 1`;
    const [driver] = await raw<{ id: string }[]>`
      insert into public.technician (organization_id, membership_id, display_name, home_location_id)
      values (${ORG}, ${m!.id}, 'Dee Driver', ${yard!.id}) returning id`;
    const [drop] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, code, capacity_model)
      values (${ORG}, 'Delivery', 'delivery', 'asset_rental') returning id`;
    const [pickup] = await raw<{ id: string }[]>`select id from public.job_type where organization_id = ${ORG} and code = 'pickup'`;
    const [customer] = await raw<{ id: string }[]>`select customer_id as id from public.customer_property where property_id = ${propertyId}`;

    const stop = async (jobTypeId: string, lng: number, order: number) => {
      const [p] = await raw<{ id: string }[]>`
        insert into public.property (organization_id, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
        values (${ORG}, ${`${lng} Site`}, 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test')
        returning id`;
      const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
      const [job] = await raw<{ id: string }[]>`
        insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
        values (${ORG}, ${n!.next}, ${customer!.id}, ${p!.id}, ${jobTypeId}, 'scheduled', 'Haul') returning id`;
      const [v] = await raw<{ id: string }[]>`
        insert into public.visit (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes)
        values (${ORG}, ${job!.id}, 'dispatched', ${time.instantOfLocal(day, 8 * 60, ZONE)}, ${time.instantOfLocal(day, 17 * 60, ZONE)}, ${order}, 20)
        returning id`;
      await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${v!.id}, ${driver!.id}, true)`;
      return v!.id;
    };
    /** As booked: collect, drop, collect, drop, each a few kilometres out. */
    const p1 = await stop(pickup!.id, -97.70, 1);
    const d1 = await stop(drop!.id, -97.69, 2);
    const p2 = await stop(pickup!.id, -97.66, 3);
    const d2 = await stop(drop!.id, -97.65, 4);

    const proposal = await dispatchMap.optimise(owner(), { date: day, technicianId: driver!.id });
    expect(proposal.truck).toMatchObject({ byTruck: true, containersPerTruck: 1, currentYardRuns: 2 });
    expect(proposal.improved).toBe(true);
    expect(proposal.proposed.driveMinutes).toBeLessThan(proposal.current.driveMinutes);
    const order = proposal.proposed.order;
    expect([...order].sort()).toEqual([p1, d1, p2, d2].sort());
    /** Every run to the yard sits between the stops the proposal says it does. */
    for (const run_ of proposal.truck!.yardRuns.filter((r) => r.beforeVisitId !== null)) {
      expect(proposal.proposed.order.indexOf(run_.beforeVisitId!)).toBe(proposal.proposed.order.indexOf(run_.afterVisitId!) + 1);
    }

    /** The rebalance across people leaves a driver's day with containers alone, and says why. */
    const rebalance = await dispatchMap.rebalance(owner(), { date: day });
    expect(rebalance.leftOut).toEqual([expect.objectContaining({ technicianId: driver!.id, reason: expect.stringMatching(/ordered by what is on the truck/) })]);
  });
});
