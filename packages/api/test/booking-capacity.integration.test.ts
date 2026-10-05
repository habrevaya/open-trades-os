import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import type { Actor } from "@opentradesos/core";
import * as booking from "../src/services/booking";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * WHO IS FREE TO TAKE ONLINE WORK, COUNTING EVERY KIND OF DAY
 *
 * Two technicians, Ray and Dana, and a four hour morning and afternoon
 * that hold four one hour jobs each per person. Online booking used to
 * read only work assigned to one person, so a crew's Tuesday or a pool
 * route left both looking free, and it asked whether somebody was
 * qualified only for the first day it showed. These hold the three
 * corrections: a crew's visit is on every member's day, a route's stops
 * take the time they really take in route order, and a licence lapsing
 * mid calendar stops offering its holder from the day after.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("bcap:org");
const USER = fixtureId("bcap:user");
const ZONE = "America/Chicago";
const DAY = companyToday(5);

let raw: postgres.Sql;
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: testDb(url!),
});

let rayId = "";
let danaId = "";
let jobTypeId = "";
let serviceId = "";
let morning = "";
let afternoon = "";
let customerId = "";
let propertyId = "";

async function left(date: string, windowId: string): Promise<number> {
  const [service] = await inTenant(owner(), (tx) =>
    tx.select().from(schema.bookableService).where(eq(schema.bookableService.id, serviceId)));
  const slots = await booking.openSlots(testDb(url!), { organizationId: ORG, timezone: ZONE, service: service!, from: date, days: 1 });
  return slots.find((s) => s.arrivalWindowId === windowId)?.remaining ?? 0;
}

async function job(): Promise<string> {
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [row] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'Work') returning id`;
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Capacity Co", slug: "capacity-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const ids: string[] = [];
  for (const name of ["Ray Ortiz", "Dana Lee"]) {
    const userId = fixtureId(`bcap:tech:${name}`);
    await raw`insert into public."user" (id, email) values (${userId}, ${`bcap-${name.split(" ")[0]}@test.local`}) on conflict (id) do nothing`;
    const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
    const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
      values (${ORG}, ${m!.id}, ${name}) returning id`;
    ids.push(t!.id);
  }
  [rayId, danaId] = ids as [string, string];
  for (let day = 0; day < 7; day += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at) values (${ORG}, ${day}, '07:00', '18:00')`;
  }
  const [m] = await raw<{ id: string }[]>`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week, sort_order)
    values (${ORG}, 'Morning', '08:00', '12:00', ${[0, 1, 2, 3, 4, 5, 6]}, 1) returning id`;
  const [a] = await raw<{ id: string }[]>`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week, sort_order)
    values (${ORG}, 'Afternoon', '12:00', '16:00', ${[0, 1, 2, 3, 4, 5, 6]}, 2) returning id`;
  morning = m!.id;
  afternoon = a!.id;
  const [t] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, default_duration_minutes)
    values (${ORG}, 'Service call', 60) returning id`;
  jobTypeId = t!.id;
  const [s] = await raw<{ id: string }[]>`insert into public.bookable_service (organization_id, job_type_id, public_name, max_per_window, min_notice_hours, max_advance_days)
    values (${ORG}, ${jobTypeId}, 'Service call', 50, 24, 60) returning id`;
  serviceId = s!.id;
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Pat Pool') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Pool Ln', 'Austin', 'TX', '78701') returning id`;
  propertyId = p!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.visit where organization_id = ${ORG}`;
  await raw`delete from public.job where organization_id = ${ORG}`;
  await raw`delete from public.route where organization_id = ${ORG}`;
  await raw`delete from public.crew where organization_id = ${ORG}`;
  await raw`delete from public.person_certification where organization_id = ${ORG}`;
  await raw`delete from public.certification_type where organization_id = ${ORG}`;
  await raw`update public.job_type set required_skills = '[]'::jsonb where id = ${jobTypeId}`;
});

run("work that is not one person's", () => {
  it("counts a crew's visit against every member of the crew", async () => {
    expect(await left(DAY, morning)).toBe(8);
    const [crew] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name) values (${ORG}, 'Install crew') returning id`;
    await raw`insert into public.crew_member (organization_id, crew_id, technician_id, is_lead)
      values (${ORG}, ${crew!.id}, ${rayId}, true), (${ORG}, ${crew!.id}, ${danaId}, false)`;
    await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes, crew_id)
      values (${ORG}, ${await job()}, 'dispatched', ${booking.windowStart(DAY, "08:00", ZONE)}, ${booking.windowStart(DAY, "12:00", ZONE)}, 240, ${crew!.id})`;
    expect(await left(DAY, morning)).toBe(0);
    expect(await left(DAY, afternoon)).toBe(8);
  });

  it("lays a route's stops end to end, so a long route reaches into the afternoon", async () => {
    const [route] = await raw<{ id: string }[]>`insert into public.route (organization_id, name, technician_id, travel_minutes_between_stops)
      values (${ORG}, 'Tuesday pools', ${rayId}, 10) returning id`;
    /** Ten stops of thirty minutes, ten minutes apart: eight until half past two. */
    for (let i = 1; i <= 10; i += 1) {
      const [v] = await raw<{ id: string }[]>`insert into public.visit
        (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes, route_id, route_order)
        values (${ORG}, ${await job()}, 'scheduled', ${booking.windowStart(DAY, "08:00", ZONE)}, ${booking.windowStart(DAY, "17:00", ZONE)}, 30, ${route!.id}, ${i})
        returning id`;
      await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${v!.id}, ${rayId}, true)`;
    }
    /** Ray's morning is gone, and so is the first two and a half hours of his afternoon; Dana is free. */
    expect(await left(DAY, morning)).toBe(4);
    expect(await left(DAY, afternoon)).toBe(5);
  });

  it("counts a container drop nobody drives yet as work waiting for somebody", async () => {
    const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes, rental_event)
      values (${ORG}, ${await job()}, 'unassigned', ${booking.windowStart(DAY, "09:00", ZONE)}, ${booking.windowStart(DAY, "11:00", ZONE)}, 120, 'delivery') returning id`;
    expect(v).toBeTruthy();
    expect(await left(DAY, morning)).toBe(6);
  });
});

run("qualified on each day shown", () => {
  it("stops offering somebody from the day after their licence expires", async () => {
    await raw`update public.job_type set required_skills = '["gas"]'::jsonb where id = ${jobTypeId}`;
    const [type] = await raw<{ id: string }[]>`insert into public.certification_type (organization_id, code, name, grants_skills)
      values (${ORG}, 'GAS', 'Gas licence', '["gas"]'::jsonb) returning id`;
    await raw`insert into public.person_certification (organization_id, technician_id, certification_type_id, expires_on)
      values (${ORG}, ${rayId}, ${type!.id}, ${companyToday(6)})`;
    const [service] = await inTenant(owner(), (tx) =>
      tx.select().from(schema.bookableService).where(eq(schema.bookableService.id, serviceId)));
    const slots = await booking.openSlots(testDb(url!), { organizationId: ORG, timezone: ZONE, service: service!, from: DAY, days: 3 });
    const mornings = (date: string) => slots.find((s) => s.date === date && s.arrivalWindowId === morning)?.remaining ?? 0;
    /** Only Ray holds it. Good on the day it expires, gone the day after. */
    expect(mornings(companyToday(5))).toBe(4);
    expect(mornings(companyToday(6))).toBe(4);
    expect(mornings(companyToday(7))).toBe(0);
  });
});
