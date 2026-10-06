import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as company from "../src/services/company";
import * as dispatch from "../src/services/dispatch";
import * as crews from "../src/services/crews";
import * as serviceRoutes from "../src/services/routes";
import * as visits from "../src/services/visits";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A VISIT'S SHOP, WRITTEN WHEN IT IS GIVEN TO SOMEBODY
 *
 * `visit.location_id` was read by the shop scope and written by nothing, so
 * the shop a visit went out from was worked out each time from whoever was on
 * it now. This asks that booking with somebody, assigning, sending a crew and
 * running a route each write the shop of whoever has it, that the visit
 * shows it, and that the shop scope reads it once it is written while a
 * visit that carries none is still read through its people.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("visit-shop:org");
const OWNER = fixtureId("visit-shop:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] }, db: db() });

let north = "";
let south = "";
let nia = "";
let sol = "";
let southCrew = "";
let customerId = "";
let propertyId = "";

/** Somebody limited to one shop's work, as a role made on the roles screen resolves. */
const shopOffice = (locationId: string): ServiceContext => ({
  actor: {
    userId: fixtureId(`visit-shop:office:${locationId}`), organizationId: ORG, roles: [] as Actor["roles"],
    grants: ["job:read", "visit:read"], scopes: { job: "location", visit: "location" }, locationId,
  },
  db: db(),
});

async function technician(key: string, name: string, membershipLocation: string | null, home: string | null): Promise<string> {
  const userId = fixtureId(`visit-shop:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`visit-shop-${key}@test.local`}) on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role, location_id)
    values (${ORG}, ${userId}, 'technician', ${membershipLocation}) returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, home_location_id)
    values (${ORG}, ${m!.id}, ${name}, ${home}) returning id`;
  return t!.id;
}

const shopOf = async (visitId: string) =>
  (await raw<{ location_id: string | null }[]>`select location_id from public.visit where id = ${visitId}`)[0]!.location_id;

const tomorrow = (hour: number) => new Date(Date.now() + 86_400_000 + hour * 3600_000).toISOString();

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Two Shops", slug: "visit-shop-two-shops" });
  north = (await company.createLocation(owner(), { name: "North yard" })).id;
  south = (await company.createLocation(owner(), { name: "South yard" })).id;
  /** Nia's day starts at North; Sol has no start of his own and his membership says South. */
  nia = await technician("nia", "Nia North", null, north);
  sol = await technician("sol", "Sol South", south, null);
  southCrew = (await crews.create(owner(), { name: "South crew" })).id;
  await crews.update(owner(), { id: southCrew, homeLocationId: south });
  await crews.setMembers(owner(), { id: southCrew, members: [{ technicianId: sol, isLead: true }] });
  customerId = (await customers.create(owner(), {
    type: "residential", name: "Shop Customer", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  propertyId = (await properties.create(owner(), {
    address: { line1: "9 Yard Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id as string;
});

afterAll(async () => { if (raw) await raw.end(); });

run("a visit's shop", () => {
  it("is written from the lead's start when a job is booked with somebody, and shown on the visit", async () => {
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Booked with Nia", tags: [], customFields: {},
      visit: { windowStart: tomorrow(1), windowEnd: tomorrow(3), estimatedDurationMinutes: 60, technicianIds: [nia] },
    });
    const visitId = (await jobs.get(owner(), { id: job.id as string })).visits[0]!.id;
    expect(await shopOf(visitId)).toBe(north);
    expect((await jobs.get(owner(), { id: job.id as string })).visits[0]!.locationName).toBe("North yard");
    expect((await visits.get(owner(), { id: visitId })).shop).toBe("North yard");
  });

  it("follows the people when it is assigned again, from the membership when there is no start", async () => {
    const job = await jobs.create(owner(), { customerId, propertyId, summary: "Moved to Sol", tags: [], customFields: {} });
    const visit = await jobs.addVisit(owner(), {
      id: job.id as string, windowStart: tomorrow(4), windowEnd: tomorrow(6), estimatedDurationMinutes: 60, technicianIds: [nia],
    });
    expect(await shopOf(visit.id)).toBe(north);
    await dispatch.assign(owner(), { id: visit.id, technicianIds: [sol] });
    expect(await shopOf(visit.id)).toBe(south);

    // The shop scope reads the visit's own shop once written: North no longer sees it, South does.
    await expect(jobs.get(shopOffice(north), { id: job.id as string })).rejects.toThrow(/not found/);
    expect((await jobs.get(shopOffice(south), { id: job.id as string })).id).toBe(job.id);
  });

  it("is the crew's base when a crew is sent, or booked", async () => {
    const job = await jobs.create(owner(), { customerId, propertyId, summary: "Crew work", tags: [], customFields: {} });
    const booked = await jobs.addVisit(owner(), {
      id: job.id as string, windowStart: tomorrow(7), windowEnd: tomorrow(9), estimatedDurationMinutes: 60,
      technicianIds: [], crewId: southCrew,
    });
    expect(await shopOf(booked.id)).toBe(south);
    const open = await jobs.addVisit(owner(), {
      id: job.id as string, windowStart: tomorrow(10), windowEnd: tomorrow(12), estimatedDurationMinutes: 60, technicianIds: [],
    });
    expect(await shopOf(open.id)).toBeNull();
    await crews.assign(owner(), { id: open.id, crewId: southCrew });
    expect(await shopOf(open.id)).toBe(south);
  });

  it("is the route runner's when a route is run", async () => {
    const route = await serviceRoutes.create(owner(), { name: "Nia's Tuesday", dayOfWeek: 2, technicianId: nia });
    await serviceRoutes.addStop(owner(), { routeId: route.id, propertyId });
    const result = await serviceRoutes.materialise(owner(), { id: route.id, date: "2026-06-02" });
    expect(await shopOf(result.created[0]!.visitId)).toBe(north);
  });

  it("is not filled in for a visit made before it was written, which the shop scope reads through its people", async () => {
    const job = await jobs.create(owner(), { customerId, propertyId, summary: "From before", tags: [], customFields: {} });
    const [visit] = await raw<{ id: string }[]>`
      insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end)
      values (${ORG}, ${job.id as string}, 1, 'dispatched', ${tomorrow(13)}, ${tomorrow(14)}) returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
              values (${ORG}, ${visit!.id}, ${nia}, true)`;
    expect(await shopOf(visit!.id)).toBeNull();
    expect((await jobs.get(shopOffice(north), { id: job.id as string })).id).toBe(job.id);
    await expect(jobs.get(shopOffice(south), { id: job.id as string })).rejects.toThrow(/not found/);
  });
});
