import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as routeDays from "../src/services/route-days";
import * as liveLocation from "../src/services/location";
import * as kpis from "../src/services/kpis";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * ROUTE DENSITY, FROM A MONTH OF MILES THE POSITIONS DO NOT OUTLIVE
 *
 * The phone's positions are deleted after a few days by design. The worker
 * sums each finished day before they go into a person's route day (stops,
 * and miles driven between them), and route density reads those. Checked
 * here against days worked out by hand: the way out and the way home left
 * out, a crew member's day counted as their own, a day with a gap left out
 * and counted beside, a day of one stop no route at all.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("route-days:org");
const USER = fixtureId("route-days:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});

let seq = 0;
let customerId = "";
let propertyId = "";
let jobId = "";

async function person(name: string): Promise<{ technicianId: string; deviceId: string }> {
  seq += 1;
  const [user] = await raw<{ id: string }[]>`
    insert into public."user" (email, name) values (${`route-${seq}-${Date.now()}@route-days.test`}, ${name}) returning id`;
  const [membership] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${user!.id}, 'technician') returning id`;
  const [tech] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, active, share_location)
    values (${ORG}, ${membership!.id}, ${name}, true, true) returning id`;
  const [device] = await raw<{ id: string }[]>`
    insert into public.device (organization_id, technician_id, installation_id)
    values (${ORG}, ${tech!.id}, ${`install-${seq}-${Date.now()}`}) returning id`;
  return { technicianId: tech!.id, deviceId: device!.id };
}

/** A local wall clock time in Austin on a day, as an instant. */
const local = (day: string, clock: string) => `('${day} ${clock}'::timestamp at time zone '${ZONE}')`;

/** Positions due north along one meridian: a hundredth of a degree of latitude is 0.691 miles. */
async function drove(who: { technicianId: string; deviceId: string }, day: string, fixes: Array<[string, number]>, receivedAt?: string) {
  for (const [clock, lat] of fixes) {
    await raw.unsafe(`
      insert into public.technician_position (organization_id, technician_id, device_id, recorded_at, received_at, latitude, longitude, reason)
      values ($1, $2, $3, ${local(day, clock)}, coalesce($4::timestamptz, ${local(day, clock)}), $5, -97.7, 'on_the_clock')`,
    [ORG, who.technicianId, who.deviceId, receivedAt ?? null, lat]);
  }
}

/** A completed stop for somebody by name, or for a crew. */
async function stop(day: string, arrived: string, completed: string, to: { technicianId?: string; crewId?: string }) {
  seq += 1;
  const [visit] = await raw.unsafe<{ id: string }[]>(`
    insert into public.visit (organization_id, job_id, sequence, status, crew_id, arrived_at, completed_at)
    values ($1, $2, $3, 'completed', $4, ${local(day, arrived)}, ${local(day, completed)}) returning id`,
  [ORG, jobId, seq, to.crewId ?? null]);
  if (to.technicianId) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${visit!.id}, ${to.technicianId})`;
  }
}

const NOW = new Date("2026-06-13T15:00:00Z");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where email like '%@route-days.test'`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Route Co", slug: "route-days-co" });
  await raw`
    update public.organization
       set primary_trade = 'pest-control', timezone = ${ZONE},
           settings = coalesce(settings, '{}'::jsonb) || '{"locationSharing": {"enabled": true, "retentionDays": 3, "intervalSeconds": 60}}'::jsonb
     where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days) values (${ORG}, 'residential', 'Homeowner', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Route Rd', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, 'Quarterly', 'qtr', 'route', 'recurring'::job_revenue_class) returning id`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, 1, ${customerId}, ${propertyId}, ${type!.id}, 'in_progress', 'Route') returning id`;
  jobId = job!.id;
});

/**
 * Worked by hand, for June 2026, in Austin.
 *
 *   Ana, Jun 10. Yard at 29.90, stops at 30.00, 30.02 and 30.03, home at 30.10.
 *     The way out (0.10 degrees) and home (0.07) are left out; between stops
 *     0.02 + 0.01 = 0.03 degrees = 2.073 miles over 3 stops.
 *   Ben, Jun 10, on a crew. Two of the crew's stops at 30.20 and 30.22:
 *     0.02 degrees = 1.382 miles over 2 stops.
 *   Ana, Jun 11. Two stops with 35 minutes and no position between them:
 *     a gap, not counted, counted beside.
 *   Cy, Jun 10. One stop: no route.
 *
 * Stops 3 + 2 = 5 over 2.073 + 1.382 = 3.455 miles: 1.45 stops a mile.
 */
async function june(): Promise<{ ana: { technicianId: string; deviceId: string } }> {
  const ana = await person("Ana");
  await stop("2026-06-10", "08:00", "08:30", { technicianId: ana.technicianId });
  await stop("2026-06-10", "08:40", "09:00", { technicianId: ana.technicianId });
  await stop("2026-06-10", "09:05", "09:30", { technicianId: ana.technicianId });
  await drove(ana, "2026-06-10", [
    ["07:30", 29.9], ["07:45", 29.95], ["08:00", 30.0], ["08:15", 30.0], ["08:30", 30.0], ["08:35", 30.01],
    ["08:40", 30.02], ["08:50", 30.02], ["09:00", 30.02], ["09:05", 30.03], ["09:20", 30.03], ["09:30", 30.03],
    ["09:40", 30.06], ["09:50", 30.1],
  ]);

  const ben = await person("Ben");
  const [crew] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name) values (${ORG}, 'Crew B') returning id`;
  await raw`insert into public.crew_member (organization_id, crew_id, technician_id) values (${ORG}, ${crew!.id}, ${ben.technicianId})`;
  await stop("2026-06-10", "10:00", "10:30", { crewId: crew!.id });
  await stop("2026-06-10", "10:45", "11:15", { crewId: crew!.id });
  await drove(ben, "2026-06-10", [["10:20", 30.2], ["10:30", 30.2], ["10:35", 30.21], ["10:45", 30.22], ["11:00", 30.22]]);

  await stop("2026-06-11", "08:00", "08:30", { technicianId: ana.technicianId });
  await stop("2026-06-11", "09:10", "09:30", { technicianId: ana.technicianId });
  await drove(ana, "2026-06-11", [["08:25", 30.0], ["08:30", 30.0], ["09:05", 30.2], ["09:10", 30.2]]);

  const cy = await person("Cy");
  await stop("2026-06-10", "13:00", "13:30", { technicianId: cy.technicianId });
  await drove(cy, "2026-06-10", [["12:30", 30.5], ["13:00", 30.6], ["13:30", 30.6]]);
  return { ana };
}

run("a person's route day, kept after the positions", () => {
  it("sums each finished day into stops and miles between them, and leaves today alone", async () => {
    const { ana } = await june();
    /** Today in Austin is the 13th: a position taken today is not a finished day. */
    await drove(ana, "2026-06-13", [["08:00", 30.0]]);

    expect(await routeDays.summariseFor(db(), ORG, NOW)).toBe(4);
    const days = await raw<{ name: string; day: string; stops: number; drives: number; miles: string; status: string; note: string | null }[]>`
      select t.display_name as name, rd.day::text as day, rd.stops, rd.drives, rd.miles::text as miles, rd.status::text as status, rd.note
      from public.route_day rd join public.technician t on t.id = rd.technician_id
      where rd.organization_id = ${ORG} order by rd.day, t.display_name`;
    expect(days).toEqual([
      { name: "Ana", day: "2026-06-10", stops: 3, drives: 2, miles: "2.073", status: "counted", note: null },
      { name: "Ben", day: "2026-06-10", stops: 2, drives: 1, miles: "1.382", status: "counted", note: null },
      { name: "Cy", day: "2026-06-10", stops: 1, drives: 0, miles: "0.000", status: "no_route", note: "Fewer than two stops, so no drive between stops." },
      { name: "Ana", day: "2026-06-11", stops: 2, drives: 1, miles: "0.000", status: "gap", note: "No position between 08:30 and 09:05 on a drive between stops." },
    ]);

    /** Nothing new: a second pass reads nothing again. */
    expect(await routeDays.summariseFor(db(), ORG, NOW)).toBe(0);
  });

  it("reads a day again when the phone synced late, and never from fewer positions", async () => {
    const { ana } = await june();
    await routeDays.summariseFor(db(), ORG, NOW);
    /** The missing stretch of Ana's 11th arrives a day late: the day is read again and now counts. */
    await drove(ana, "2026-06-11", [["08:45", 30.07], ["08:55", 30.14]], "2026-06-13T15:30:00Z");
    expect(await routeDays.summariseFor(db(), ORG, new Date("2026-06-13T16:00:00Z"))).toBe(1);
    const [eleventh] = await raw<{ status: string; miles: string }[]>`
      select status::text as status, miles::text as miles from public.route_day where technician_id = ${ana.technicianId} and day = '2026-06-11'`;
    /** 0.20 degrees between the two stops: 13.819 miles. */
    expect(eleventh).toEqual({ status: "counted", miles: "13.819" });

    /** The purge takes the morning of the 10th away; a late position after that does not shrink the day. */
    await raw`delete from public.technician_position where technician_id = ${ana.technicianId} and recorded_at < ${"2026-06-10T13:35:00Z"}::timestamptz`;
    await drove(ana, "2026-06-10", [["16:00", 30.03]], "2026-06-13T17:00:00Z");
    expect(await routeDays.summariseFor(db(), ORG, new Date("2026-06-13T18:00:00Z"))).toBe(0);
    const [tenth] = await raw<{ miles: string }[]>`
      select miles::text as miles from public.route_day where technician_id = ${ana.technicianId} and day = '2026-06-10'`;
    expect(tenth!.miles).toBe("2.073");
  });

  it("deletes a person's route days with their positions when sharing is turned off", async () => {
    await june();
    await routeDays.summariseFor(db(), ORG, NOW);
    await liveLocation.setSharing(owner(), { enabled: false });
    const [left] = await raw<{ n: number }[]>`select count(*)::int as n from public.route_day where organization_id = ${ORG}`;
    expect(left!.n).toBe(0);
  });
});

run("route density", () => {
  it("divides stops by the miles between them on the days seen whole, and counts the rest beside", async () => {
    await june();
    await routeDays.summariseFor(db(), ORG, NOW);
    const card = await kpis.scorecard(owner(), WINDOW);
    const density = card.computed.find((k) => k.key === "route_density")!;
    expect(density.numerator).toBe("5");
    expect(Number(density.denominator)).toBeCloseTo(3.455, 6);
    expect(density.value).toBe("1.45");
    expect(density.besides).toEqual([expect.objectContaining({ key: "excluded", count: "1" })]);

    /** The records behind each half add up to it, one row a person's day. */
    const stops = await kpis.drill(owner(), { key: "route_density", half: "numerator", ...WINDOW });
    expect(stops.records.map((r) => [r.label, r.value]).sort()).toEqual([
      ["Ana, Jun 10: 3 stops, 2.073 miles between them", "3"],
      ["Ben, Jun 10: 2 stops, 1.382 miles between them", "2"],
    ]);
    const miles = await kpis.drill(owner(), { key: "route_density", half: "denominator", ...WINDOW });
    expect(Number(miles.total)).toBeCloseTo(3.455, 6);
    expect(miles.records.every((r) => r.href === "/timesheets?week=2026-06-10")).toBe(true);
    const gaps = await kpis.drill(owner(), { key: "route_density", half: "excluded", ...WINDOW });
    expect(gaps.records).toEqual([expect.objectContaining({
      label: "Ana, Jun 11: 2 stops, not counted: No position between 08:30 and 09:05 on a drive between stops.", value: "1",
    })]);
  });

  it("is nothing rather than a density when no day was seen whole", async () => {
    const card = await kpis.scorecard(owner(), WINDOW);
    expect(card.computed.find((k) => k.key === "route_density")!.value).toBeNull();
  });

  it("lists a person's days only to somebody who may see where people are", async () => {
    await june();
    await routeDays.summariseFor(db(), ORG, NOW);
    const refused = await kpis.drill(as("csr"), { key: "route_density", half: "numerator", ...WINDOW }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as Error).message).toMatch(/route days, made from where they drove, and reading them needs visit:dispatch/);
    const dispatcher = await kpis.drill(as("dispatcher"), { key: "route_density", half: "numerator", ...WINDOW });
    expect(dispatcher.count).toBe(2);
  });
});
