import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as properties from "../src/services/properties";
import * as company from "../src/services/company";
import * as dispatch from "../src/services/dispatch";
import * as jobs from "../src/services/jobs";
import * as dispatchMap from "../src/services/dispatch-map";
import * as geocoding from "../src/services/geocoding";
import { QualificationRefusedError } from "../src/services/qualification";
import { runPass } from "../src/services/workflow-worker";
import type { GeocodingProvider, GeocodeRequest } from "../src/maps/provider";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, holdWholePassLock, WHOLE_PASS_WAIT_MS } from "./helpers";

/**
 * WHERE THINGS ARE, AND WHO GOES WHERE
 *
 * Four properties this file holds the product to:
 *
 *   An address is put on the map by the worker and never by the request that
 *   saved it, and a pin a person placed is never moved by it.
 *   The map lists a visit with no coordinates rather than dropping it.
 *   The optimiser proposes and never reorders, keeps windows before drive
 *   time, and says which window it cannot keep.
 *   Nobody is sent on their own to work they are not qualified for without a
 *   permission, a reason, and an audit line saying both.
 *
 * NOTHING HERE REACHES A NETWORK. The geocoder is a fake handed in through
 * the worker's dependencies, and the connection it stands behind is named
 * for a provider nothing registers, so even a worker pass started by another
 * test file finds a geocoder it cannot build and leaves these rows alone.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("dmap:org");
const USER = fixtureId("dmap:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);
const dispatcher = () => as(["dispatcher"]);
const officeManager = () => as(["office_manager"]);

/** Three days out, so no window in this file has already ended. */
const DAY = time.dateIn(new Date(Date.now() + 3 * 864e5), ZONE);
const at = (hour: number, minute = 0) => time.instantOfLocal(DAY, hour * 60 + minute, ZONE);

/** A geocoder that answers from a table and counts what it was asked. */
function fakeGeocoder(answers: Record<string, { lat: number; lng: number } | "missing" | "down">) {
  const asked: string[] = [];
  const provider: GeocodingProvider = {
    name: "test-geocoder",
    async geocode(request: GeocodeRequest) {
      asked.push(request.address.addressLine1 ?? "");
      const answer = answers[request.address.addressLine1 ?? ""];
      if (answer === "missing" || answer === undefined) return { kind: "not_found", reason: "No such place in the test map." };
      if (answer === "down") return { kind: "failed", retryable: true, reason: "The test geocoder is having a day." };
      return { kind: "found", lat: answer.lat, lng: answer.lng, precision: "rooftop", label: null };
    },
  };
  return { provider, asked, deps: { providerFor: () => provider } };
}

let customerId = "";
let yardId = "";
let ray = "";
let sam = "";
let gasType = "";
let diagType = "";

async function technician(key: string, name: string, skills: string[] = []): Promise<string> {
  const userId = fixtureId(`dmap:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`dmap-${key}@test.local`})
            on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, skills, color)
    values (${ORG}, ${m!.id}, ${name}, ${raw.json(skills as never)}, '#1D4ED8') returning id`;
  return t!.id;
}

/** A property already on the map, as if the geocoder had answered. */
async function placedProperty(line1: string, lat: number | null, lng: number | null): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code,
                                 latitude, longitude, location_precision, location_source)
    values (${ORG}, ${line1}, 'Austin', 'TX', '78701',
            ${lat === null ? null : geo.formatCoordinate(lat)}, ${lng === null ? null : geo.formatCoordinate(lng)},
            ${lat === null ? null : "rooftop"}, ${lat === null ? null : "test-geocoder"})
    returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, role, is_primary)
            values (${ORG}, ${customerId}, ${row!.id}, 'owner', true)`;
  return row!.id;
}

/** A visit on DAY, with its window, optionally on somebody's day at a position. */
async function visitAt(
  propertyId: string, from: Date, to: Date,
  options: { jobTypeId?: string | null; technicianId?: string; order?: number; status?: string; routeId?: string; minutes?: number } = {},
): Promise<string> {
  const [n] = await raw<{ next: number }[]>`
    select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, ${options.jobTypeId ?? null}, 'scheduled', 'Map work')
    returning id`;
  const status = options.status ?? (options.technicianId ? "dispatched" : "unassigned");
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end,
                              route_order, route_id, estimated_duration_minutes)
    values (${ORG}, ${job!.id}, 1, ${status}::visit_status, ${from}, ${to},
            ${options.order ?? null}, ${options.routeId ?? null}, ${options.minutes ?? 30})
    returning id`;
  if (options.technicianId) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
              values (${ORG}, ${visit!.id}, ${options.technicianId}, true)`;
  }
  return visit!.id;
}

async function connectTestGeocoder(): Promise<void> {
  await raw`insert into public.integration_connection (organization_id, capability, provider, status)
            values (${ORG}, 'maps', 'test-geocoder', 'connected')
            on conflict (organization_id, capability, provider) do update set status = 'connected'`;
}

/** This file runs the worker's pass over every company: see `holdWholePassLock`. */
let releaseWholePass: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (url) releaseWholePass = await holdWholePassLock(url);
}, WHOLE_PASS_WAIT_MS);
afterAll(async () => { await releaseWholePass?.(); });

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Map Co", slug: "dispatch-map" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Pat Map') returning id`;
  customerId = c!.id;
  ray = await technician("ray", "Ray Ortiz", ["gas-fitting"]);
  sam = await technician("sam", "Sam Reyes");
  const [g] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, required_skills)
    values (${ORG}, 'Gas repair', ${raw.json(["gas-fitting"] as never)}) returning id`;
  gasType = g!.id;
  const [d] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, required_skills)
    values (${ORG}, 'Diagnostic', ${raw.json(["hvac-service"] as never)}) returning id`;
  diagType = d!.id;
});
afterAll(async () => { if (raw) await raw.end(); });

run("putting addresses on the map", () => {
  it("keys an address in the database exactly as core does", async () => {
    const [row] = await raw<{ id: string; address_key: string }[]>`
      insert into public.property (organization_id, address_line1, address_line2, city, state, postal_code, country)
      values (${ORG}, ${"  9  Odd   Spacing Rd "}, ${"Unit\t4"}, 'AUSTIN', 'tx', '78701', 'US')
      returning id, address_key`;
    expect(row!.address_key).toBe(geo.addressKey({
      addressLine1: "  9  Odd   Spacing Rd ", addressLine2: "Unit\t4",
      city: "AUSTIN", state: "tx", postalCode: "78701", country: "US",
    }));
    await raw`delete from public.property where id = ${row!.id}`;
  });

  it("does not look an address up while it is being saved", async () => {
    const created = await properties.create(owner(), {
      address: { line1: "100 Congress Ave", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId, customerRole: "owner",
    });
    expect(created.latitude).toBeNull();
    expect(created.locationPrecision).toBeNull();
  });

  it("finds nothing to do for a company that has not connected a geocoder", async () => {
    const fake = fakeGeocoder({ "100 Congress Ave": { lat: 30.2650, lng: -97.7440 } });
    await geocoding.geocodePending(db(), { deps: fake.deps, limit: 200 });
    expect(fake.asked).toEqual([]);
  });

  it("geocodes it from the worker once a geocoder is connected, with its precision and source", async () => {
    await connectTestGeocoder();
    const fake = fakeGeocoder({ "100 Congress Ave": { lat: 30.2650, lng: -97.7440 } });
    const pass = await geocoding.geocodePending(db(), { deps: fake.deps, limit: 200 });
    expect(fake.asked).toContain("100 Congress Ave");
    expect(pass.found).toBeGreaterThan(0);

    const [row] = await raw<{ latitude: string; longitude: string; location_precision: string; location_source: string }[]>`
      select latitude, longitude, location_precision, location_source from public.property
      where organization_id = ${ORG} and address_line1 = '100 Congress Ave'`;
    expect(row).toEqual({
      latitude: "30.265000", longitude: "-97.744000", location_precision: "rooftop", location_source: "test-geocoder",
    });

    /** Every lookup writes its integration event before it goes out, as the rules require. */
    const events = await raw<{ status: string }[]>`
      select status from public.integration_event
      where organization_id = ${ORG} and event_type = 'geocode' and provider = 'test-geocoder'`;
    expect(events.map((e) => e.status)).toContain("succeeded");
  });

  it("does not ask about an address it has already answered", async () => {
    const fake = fakeGeocoder({ "100 Congress Ave": { lat: 1, lng: 1 } });
    await geocoding.geocodePending(db(), { deps: fake.deps, limit: 200 });
    expect(fake.asked).not.toContain("100 Congress Ave");
  });

  it("asks again when the address changes, and does it from the worker pass itself", async () => {
    await raw`update public.property set address_line1 = '200 Congress Ave'
              where organization_id = ${ORG} and address_line1 = '100 Congress Ave'`;
    const fake = fakeGeocoder({ "200 Congress Ave": { lat: 30.2660, lng: -97.7430 } });
    /**
     * Through `runPass`, the way the worker process and the serverless tick
     * both reach it, rather than by calling the function directly.
     */
    await runPass({ db: db(), schedules: false, geocoding: { deps: fake.deps }, push: false });
    expect(fake.asked).toEqual(["200 Congress Ave"]);
    const [row] = await raw<{ latitude: string }[]>`
      select latitude from public.property where organization_id = ${ORG} and address_line1 = '200 Congress Ave'`;
    expect(row!.latitude).toBe("30.266000");
  });

  it("does not ask twice about an address the geocoder cannot find, and lists it for a pin", async () => {
    const created = await properties.create(owner(), {
      address: { line1: "1 Nowhere Ln", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId, customerRole: "owner",
    });
    const first = fakeGeocoder({ "1 Nowhere Ln": "missing" });
    await geocoding.geocodePending(db(), { deps: first.deps, limit: 200 });
    expect(first.asked).toContain("1 Nowhere Ln");

    const second = fakeGeocoder({ "1 Nowhere Ln": "missing" });
    await geocoding.geocodePending(db(), { deps: second.deps, limit: 200 });
    expect(second.asked).not.toContain("1 Nowhere Ln");

    const status = await geocoding.status(owner());
    expect(status.geocoder).toBe("test-geocoder");
    expect(status.notFound.map((n) => n.propertyId)).toContain(created.id);
  });

  it("tries a failure that might clear again after its back off, and not before", async () => {
    await properties.create(owner(), {
      address: { line1: "2 Flaky St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId, customerRole: "owner",
    });
    const down = fakeGeocoder({ "2 Flaky St": "down" });
    await geocoding.geocodePending(db(), { deps: down.deps, limit: 200 });
    expect(down.asked).toContain("2 Flaky St");

    const tooSoon = fakeGeocoder({ "2 Flaky St": { lat: 30.27, lng: -97.75 } });
    await geocoding.geocodePending(db(), { deps: tooSoon.deps, limit: 200 });
    expect(tooSoon.asked).not.toContain("2 Flaky St");

    await raw`update public.property set geocode_retry_at = now() - interval '1 minute'
              where organization_id = ${ORG} and address_line1 = '2 Flaky St'`;
    const later = fakeGeocoder({ "2 Flaky St": { lat: 30.27, lng: -97.75 } });
    await geocoding.geocodePending(db(), { deps: later.deps, limit: 200 });
    expect(later.asked).toContain("2 Flaky St");
  });

  it("takes a previous address's pin off when the new address cannot be found", async () => {
    /**
     * A pin on the house they moved out of is worse than no pin: no pin is
     * listed as not on the map, and a wrong pin is driven to.
     */
    await raw`update public.property set address_line1 = '3 Vanished Ct'
              where organization_id = ${ORG} and address_line1 = '200 Congress Ave'`;
    const fake = fakeGeocoder({});
    await geocoding.geocodePending(db(), { deps: fake.deps, limit: 200 });
    const [row] = await raw<{ latitude: string | null; location_precision: string | null }[]>`
      select latitude, location_precision from public.property
      where organization_id = ${ORG} and address_line1 = '3 Vanished Ct'`;
    expect(row).toEqual({ latitude: null, location_precision: null });
  });

  it("lets the office drop a pin that the geocoder never moves, and hands it back on request", async () => {
    const [target] = await raw<{ id: string }[]>`
      select id from public.property where organization_id = ${ORG} and address_line1 = '1 Nowhere Ln'`;
    const pinned = await geocoding.placePin(owner(), {
      entity: "property", id: target!.id, latitude: 30.2801, longitude: -97.7312,
    });
    expect(pinned).toMatchObject({ latitude: "30.280100", locationPrecision: "placed", locationSource: "manual" });

    // Even with the address edited, the geocoder leaves a placed pin alone.
    await raw`update public.property set address_line1 = '1 Somewhere Ln' where id = ${target!.id}`;
    const fake = fakeGeocoder({ "1 Somewhere Ln": { lat: 10, lng: 10 } });
    await geocoding.geocodePending(db(), { deps: fake.deps, limit: 200 });
    expect(fake.asked).not.toContain("1 Somewhere Ln");
    const [still] = await raw<{ latitude: string }[]>`select latitude from public.property where id = ${target!.id}`;
    expect(still!.latitude).toBe("30.280100");

    const audited = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and entity_id = ${target!.id}`;
    expect(audited.map((a) => a.action)).toContain("property.pinned");

    await geocoding.clearPin(owner(), { entity: "property", id: target!.id });
    const back = fakeGeocoder({ "1 Somewhere Ln": { lat: 30.29, lng: -97.72 } });
    await geocoding.geocodePending(db(), { deps: back.deps, limit: 200 });
    expect(back.asked).toContain("1 Somewhere Ln");
  });

  it("refuses a pin in the sea, and a pin from somebody who may not edit properties", async () => {
    const [target] = await raw<{ id: string }[]>`
      select id from public.property where organization_id = ${ORG} and address_line1 = '1 Somewhere Ln'`;
    await expect(geocoding.placePin(owner(), { entity: "property", id: target!.id, latitude: 0, longitude: 0 }))
      .rejects.toThrow(/not a place on the map/);
    await expect(geocoding.placePin(as(["technician"]), {
      entity: "property", id: target!.id, latitude: 30.2, longitude: -97.7,
    })).rejects.toMatchObject({ name: "PermissionError" });
  });

  it("geocodes a location too, which is where technicians' days start", async () => {
    const yard = await company.createLocation(owner(), {
      name: "Yard", addressLine1: "2400 Cullen Ave", city: "Austin", state: "TX", postalCode: "78757",
    });
    yardId = yard.id;
    const fake = fakeGeocoder({ "2400 Cullen Ave": { lat: 30.3300, lng: -97.7200 } });
    await geocoding.geocodePending(db(), { deps: fake.deps, limit: 200 });
    expect(fake.asked).toContain("2400 Cullen Ave");
    const [row] = await raw<{ latitude: string }[]>`select latitude from public.location where id = ${yardId}`;
    expect(row!.latitude).toBe("30.330000");
  });
});

run("qualified for the work, one person at a time", () => {
  let visit = "";

  it("passes a skill nobody in the company is recorded as doing, and says it could not check", async () => {
    const p = await placedProperty("10 Unknown Way", 30.31, -97.71);
    visit = await visitAt(p, at(9), at(11), { jobTypeId: diagType });
    const result = await dispatch.assign(owner(), { id: visit, technicianIds: [sam] });
    expect(result.overridden).toBe(false);
    expect(result.unknownSkills).toEqual(["hvac-service"]);
  });

  it("refuses somebody not recorded with a skill others in the company are, in one sentence", async () => {
    const p = await placedProperty("11 Gas Way", 30.32, -97.70);
    visit = await visitAt(p, at(13), at(15), { jobTypeId: gasType });
    const refused = await dispatch.assign(owner(), { id: visit, technicianIds: [sam] }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(QualificationRefusedError);
    expect((refused as Error).message).toContain(
      "Sam Reyes cannot be sent: this work needs gas-fitting. Sam Reyes is not recorded as doing gas-fitting, and others in the company are.",
    );
    // And the person who does it is sent without a word.
    await expect(dispatch.assign(owner(), { id: visit, technicianIds: [ray] })).resolves.toMatchObject({ overridden: false });
  });

  it("refuses an override from somebody without the permission for it", async () => {
    await expect(dispatch.assign(dispatcher(), {
      id: visit, technicianIds: [sam], overrideQualification: { reason: "Nobody else is free today." },
    })).rejects.toMatchObject({ name: "PermissionError", permission: "visit:assign_unqualified" });
  });

  it("sends them anyway for somebody holding it, and the audit log keeps the reason beside the refusal", async () => {
    const result = await dispatch.assign(officeManager(), {
      id: visit, technicianIds: [sam], overrideQualification: { reason: "Nobody else is free today." },
    });
    expect(result.overridden).toBe(true);
    const [line] = await raw<{ before: { refusals: { refusal: string }[] }; after: { reason: string } }[]>`
      select before, after from public.audit_log
      where organization_id = ${ORG} and entity_id = ${visit} and action = 'visit.assigned_unqualified'`;
    expect(line!.after.reason).toBe("Nobody else is free today.");
    expect(line!.before.refusals[0]!.refusal).toMatch(/not recorded as doing gas-fitting/);
  });

  it("prefers a lapsed certification's sentence to the profile, even when the profile lists the skill", async () => {
    const [type] = await raw<{ id: string }[]>`
      insert into public.certification_type (organization_id, code, name, grants_skills)
      values (${ORG}, 'GAS', 'Gas Safe', ${raw.json(["gas-fitting"] as never)}) returning id`;
    await raw`insert into public.person_certification (organization_id, technician_id, certification_type_id, expires_on, status)
              values (${ORG}, ${ray}, ${type!.id}, '2020-01-31', 'active'::certification_status)`;
    const refused = await dispatch.assign(owner(), { id: visit, technicianIds: [ray] }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(QualificationRefusedError);
    expect((refused as Error).message).toContain("Ray Ortiz's Gas Safe expired on 2020-01-31");

    // A live one clears him again.
    await raw`insert into public.person_certification (organization_id, technician_id, certification_type_id, expires_on, status)
              values (${ORG}, ${ray}, ${type!.id}, '2099-01-31', 'active'::certification_status)`;
    await expect(dispatch.assign(owner(), { id: visit, technicianIds: [ray] })).resolves.toMatchObject({ overridden: false });
  });

  it("refuses the same person when a job is booked with them named", async () => {
    const p = await placedProperty("12 Booked Way", 30.33, -97.69);
    await expect(jobs.create(owner(), {
      customerId, propertyId: p, jobTypeId: gasType, summary: "Booked straight onto Sam",
      tags: [], customFields: {},
      visit: {
        windowStart: at(14).toISOString(), windowEnd: at(16).toISOString(),
        estimatedDurationMinutes: 60, technicianIds: [sam],
      },
    })).rejects.toBeInstanceOf(QualificationRefusedError);
  });

  it("does not refuse history: a window that has already ended is a record", async () => {
    const p = await placedProperty("13 Yesterday Way", 30.34, -97.68);
    const past = await visitAt(p, new Date(Date.now() - 50 * 3_600_000), new Date(Date.now() - 48 * 3_600_000),
      { jobTypeId: gasType });
    await expect(dispatch.assign(owner(), { id: past, technicianIds: [sam] })).resolves.toMatchObject({ overridden: false });
  });
});

run("the map and the optimiser", () => {
  let a = ""; let b = ""; let c = ""; let lost = ""; let tight = "";

  beforeAll(async () => {
    if (!url) return;
    await raw`delete from public.visit_assignment where organization_id = ${ORG}`;
    await raw`delete from public.visit where organization_id = ${ORG}`;
    await geocoding.placePin(owner(), { entity: "location", id: yardId, latitude: 30.30, longitude: -97.70 });
    await dispatchMap.updateTechnician(owner(), { id: ray, homeLocationId: yardId });
    /**
     * Three stops east of the yard in a line, booked in the order the phone
     * rang: the far one first. Its window opens at one, so of the two ways
     * along the line only near-to-far finishes the day first. And one with no
     * coordinates at all.
     */
    const near = await placedProperty("20 Near St", 30.30, -97.68);
    const mid = await placedProperty("21 Mid St", 30.30, -97.66);
    const far = await placedProperty("22 Far St", 30.30, -97.64);
    const nowhere = await placedProperty("23 Unplaced St", null, null);
    a = await visitAt(far, at(13), at(17), { technicianId: ray, order: 1, jobTypeId: diagType });
    b = await visitAt(near, at(8), at(17), { technicianId: ray, order: 2, jobTypeId: diagType });
    c = await visitAt(mid, at(8), at(17), { technicianId: ray, order: 3, jobTypeId: diagType });
    lost = await visitAt(nowhere, at(8), at(17), { technicianId: ray, order: 4, jobTypeId: diagType });
  });

  it("draws every visit with its position, and lists the one with none rather than dropping it", async () => {
    const day = await dispatchMap.map(owner(), { date: DAY });
    const ids = day.visits.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining([a, b, c, lost]));
    expect(day.unplaced).toEqual([lost]);
    expect(day.visits.find((v) => v.id === lost)!.position).toBeNull();
    expect(day.visits.find((v) => v.id === a)!.position).toMatchObject({ lat: 30.3, lng: -97.64, precision: "rooftop" });

    const rayOnMap = day.technicians.find((t) => t.id === ray)!;
    expect(rayOnMap.route).toEqual([a, b, c, lost]);
    expect(rayOnMap.start).toMatchObject({ locationId: yardId, position: { lat: 30.3, lng: -97.7, precision: "placed" } });
    expect(rayOnMap.startIsCompanyDefault).toBe(false);
    // Sam has no start of his own, so his day starts at the company's first location, and says so.
    expect(day.technicians.find((t) => t.id === sam)!.startIsCompanyDefault).toBe(true);
    expect(day.geocoder).toBe("test-geocoder");
  });

  it("proposes the order that drives least, and does not move anything", async () => {
    const proposal = await dispatchMap.optimise(owner(), { date: DAY, technicianId: ray });
    expect(proposal.startKnown).toBe(true);
    expect(proposal.improved).toBe(true);
    expect(proposal.proposed.order).toEqual([b, c, a]);
    expect(proposal.proposed.driveMinutes).toBeLessThan(proposal.current.driveMinutes);
    expect(proposal.unplaced).toEqual([lost]);
    expect(proposal.applyOrder).toEqual([b, c, a, lost]);
    expect(proposal.missed).toEqual([]);

    // A suggestion: nothing on the day has moved.
    const rows = await raw<{ id: string; route_order: number }[]>`
      select id, route_order from public.visit where id in ${raw([a, b, c])} order by route_order`;
    expect(rows.map((r) => r.id)).toEqual([a, b, c]);
  });

  it("applies through the same reorder a drag uses", async () => {
    const proposal = await dispatchMap.optimise(owner(), { date: DAY, technicianId: ray });
    await dispatch.reorder(owner(), { technicianId: ray, date: DAY, visitIds: proposal.applyOrder });
    const again = await dispatchMap.optimise(owner(), { date: DAY, technicianId: ray });
    expect(again.improved).toBe(false);
    expect(again.current.order).toEqual([b, c, a]);
  });

  it("keeps a window before it saves a drive, and names the window it cannot keep", async () => {
    /**
     * Promised between eight and ten past eight at a house half an hour from
     * the yard: nobody can keep that, in any order, and the proposal says so
     * rather than presenting a plan as though it worked.
     */
    const far = await placedProperty("24 Promised St", 30.30, -97.50);
    tight = await visitAt(far, at(8), at(8, 10), { technicianId: ray, order: 5, jobTypeId: diagType });
    const proposal = await dispatchMap.optimise(owner(), { date: DAY, technicianId: ray });
    expect(proposal.proposed.order[0]).toBe(tight);
    const missed = proposal.missed.find((m) => m.visitId === tight);
    expect(missed).toMatchObject({ unreachable: true, customerName: "Pat Map" });
    expect(missed!.lateByMinutes).toBeGreaterThan(0);
    await raw`delete from public.visit_assignment where visit_id = ${tight}`;
    await raw`update public.visit set status = 'cancelled' where id = ${tight}`;
  });

  it("leaves work already under way where it is, and plans the rest from there", async () => {
    await raw`update public.visit set status = 'working', arrived_at = ${at(8, 30)} where id = ${a}`;
    const proposal = await dispatchMap.optimise(owner(), { date: DAY, technicianId: ray });
    expect(proposal.locked).toEqual([a]);
    expect(proposal.applyOrder[0]).toBe(a);
    expect(proposal.startLabel).toMatch(/where the work under way is/);
    // From the far house the way back west is mid then near.
    expect(proposal.proposed.order).toEqual([c, b]);
    await raw`update public.visit set status = 'dispatched', arrived_at = null where id = ${a}`;
  });

  it("uses the company's declared drive time between two stops on the same route", async () => {
    const [route] = await raw<{ id: string }[]>`
      insert into public.route (organization_id, name, day_of_week, technician_id, travel_minutes_between_stops)
      values (${ORG}, 'Map route', 1, ${sam}, 4) returning id`;
    const p1 = await placedProperty("30 Route St", 30.20, -97.80);
    const p2 = await placedProperty("31 Route St", 30.25, -97.75);
    await visitAt(p1, at(9), at(12), { technicianId: sam, order: 1, routeId: route!.id });
    await visitAt(p2, at(9), at(12), { technicianId: sam, order: 2, routeId: route!.id });
    const proposal = await dispatchMap.optimise(owner(), { date: DAY, technicianId: sam });
    expect(proposal.declaredLegs).toBeGreaterThan(0);
  });

  it("suggests the qualified technician nearest the work, and says why the other was ruled out", async () => {
    const p = await placedProperty("40 Open St", 30.30, -97.65);
    const open = await visitAt(p, at(9), at(17), { jobTypeId: gasType });
    const result = await dispatchMap.suggestions(owner(), { date: DAY });
    const suggestion = result.suggestions.find((s) => s.visitId === open)!;
    expect(suggestion.technicianId).toBe(ray);
    expect(suggestion.technicianName).toBe("Ray Ortiz");
    expect(suggestion.addedDriveMinutes).not.toBeNull();
    const samConsidered = suggestion.considered.find((x) => x.technicianId === sam)!;
    expect(samConsidered.refused).toMatch(/Sam Reyes cannot be sent/);

    // Accepting it is the ordinary assignment, with its ordinary check.
    await expect(dispatch.assign(owner(), { id: open, technicianIds: [suggestion.technicianId!] }))
      .resolves.toMatchObject({ ok: true });
  });

  it("lists an unassigned visit that is not on the map rather than suggesting for it", async () => {
    const p = await placedProperty("41 Unplaced Open St", null, null);
    const open = await visitAt(p, at(9), at(17));
    const result = await dispatchMap.suggestions(owner(), { date: DAY });
    expect(result.unplaced).toContain(open);
    expect(result.suggestions.map((s) => s.visitId)).not.toContain(open);
  });

  it("refuses a proposal for somebody who is not a technician here", async () => {
    await expect(dispatchMap.optimise(owner(), { date: DAY, technicianId: fixtureId("dmap:nobody") }))
      .rejects.toThrow(/not found/);
  });
});

run("the settings the estimates are made from", () => {
  it("reads the defaults, and lets settings change them", async () => {
    expect(await dispatchMap.travelSettings(owner())).toEqual({ averageKmh: 40, roadFactor: 1.3, dayStartsAt: "08:00" });
    const set = await dispatchMap.setTravelSettings(owner(), { averageKmh: 55, dayStartsAt: "07:30" });
    expect(set).toEqual({ averageKmh: 55, roadFactor: 1.3, dayStartsAt: "07:30" });
    expect(await dispatchMap.travelSettings(dispatcher())).toEqual(set);
  });

  it("refuses a dispatcher changing them, and nonsense from anybody", async () => {
    await expect(dispatchMap.setTravelSettings(dispatcher(), { averageKmh: 60 }))
      .rejects.toMatchObject({ name: "PermissionError" });
    await expect(dispatchMap.setTravelSettings(owner(), { roadFactor: 0.5 })).rejects.toThrow(/straight line/);
  });

  it("records a technician's skills tidily, and refuses a location from nowhere", async () => {
    const updated = await dispatchMap.updateTechnician(owner(), { id: sam, skills: [" gas-fitting ", "gas-fitting", ""] });
    expect(updated.skills).toEqual(["gas-fitting"]);
    await expect(dispatchMap.updateTechnician(owner(), { id: sam, homeLocationId: fixtureId("dmap:nowhere") }))
      .rejects.toThrow(/Location not found/);
    await expect(dispatchMap.updateTechnician(dispatcher(), { id: sam, skills: [] }))
      .rejects.toMatchObject({ name: "PermissionError" });
    const audited = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and entity_id = ${sam}`;
    expect(audited.map((x) => x.action)).toContain("technician.profile_set");
  });
});
