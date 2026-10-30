import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, geo, time, type Actor } from "@opentradesos/core";
import * as crews from "../src/services/crews";
import * as dispatchMap from "../src/services/dispatch-map";
import * as dispatchDays from "../src/services/dispatch-days";
import * as serviceRoutes from "../src/services/routes";
import * as businessHours from "../src/services/business-hours";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M09. A CREW KEEPS HOURS OF ITS OWN
 *
 * Early Fence Co keeps eight to four. Its early crew works six to eleven, to beat the heat. The rebalance, one
 * day and several, plans the crew's day inside its own hours (it leaves at six, and work past eleven is
 * overtime), and a route's fit for a date measures the crew against them. A crew with no hours of its own works
 * the company's day, as before.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("crew-hours:org");
const USER = fixtureId("crew-hours:user");
const ZONE = "America/Chicago";
/** A Tuesday at least a week out. */
const TUE = (() => {
  let day = companyToday(7);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 2) day = time.addDays(day, 1);
  return day;
})();
const at = (hour: number) => time.instantOfLocal(TUE, hour * 60, ZONE);

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const as = (roles: string[]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db() });

let early = "";
let late = "";
let customerId = "";

const week = (open: number[], opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek, opensAt: open.includes(dayOfWeek) ? opens : null, closesAt: open.includes(dayOfWeek) ? closes : null, closed: !open.includes(dayOfWeek),
}));

async function technician(key: string, yardId: string): Promise<string> {
  const userId = fixtureId(`crew-hours:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`crew-hours-${key}@test.local`}) on conflict (id) do nothing`;
  await raw`delete from public.membership where organization_id = ${ORG} and user_id = ${userId}`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, home_location_id)
    values (${ORG}, ${m!.id}, ${key}, ${yardId}) returning id`;
  return t!.id;
}

async function crewOf(name: string, yardId: string, people: string[]): Promise<string> {
  const made = await crews.create(owner(), { name, homeLocationId: yardId });
  for (const [i, p] of people.entries()) {
    await raw`insert into public.crew_member (organization_id, crew_id, technician_id, is_lead) values (${ORG}, ${made.id}, ${p}, ${i === 0})`;
  }
  return made.id;
}

async function crewVisit(order: number, crewId: string) {
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, ${`${order} Post Rd`}, 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.70 + order / 1000)}, 'rooftop', 'test') returning id`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${9500 + order}, ${customerId}, ${p!.id}, 'scheduled', 'Fence section') returning id`;
  await raw`insert into public.visit
      (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes, crew_id)
    values (${ORG}, ${job!.id}, 'dispatched', ${at(6)}, ${at(18)}, ${order}, 180, ${crewId})`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Early Fence Co", slug: "crew-hours-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await businessHours.setWeek(owner(), { days: week([1, 2, 3, 4, 5], "08:00", "16:00") });
  const [l] = await raw<{ id: string }[]>`insert into public.location (organization_id, name, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.70)}, 'placed', 'manual') returning id`;
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Fran Fence') returning id`;
  customerId = c!.id;
  early = await crewOf("Early crew", l!.id, [await technician("Eli", l!.id), await technician("Edie", l!.id)]);
  late = await crewOf("Late crew", l!.id, [await technician("Lou", l!.id)]);
  await crewVisit(1, early);
  await crewVisit(2, early);
  await crewVisit(3, late);
  await crewVisit(4, late);
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`update public.crew set workday = null where organization_id = ${ORG}`;
});

run("a crew's own hours", () => {
  it("are set on the crew, checked, listed and audited, and cleared back to the company's day", async () => {
    await expect(crews.update(owner(), { id: early, workday: { startsAt: "6am", endsAt: "11:00" } })).rejects.toThrow(/HH:MM/);
    await expect(crews.update(owner(), { id: early, workday: { startsAt: "11:00", endsAt: "06:00" } })).rejects.toThrow(/end after it starts/);
    await expect(crews.update(as(["technician"]), { id: early, workday: { startsAt: "06:00", endsAt: "11:00" } })).rejects.toThrow(PermissionError);

    await crews.update(owner(), { id: early, workday: { startsAt: "06:00", endsAt: "11:00" } });
    const listed = (await crews.list(owner())).find((c) => c.id === early)!;
    expect(listed.workday).toEqual({ startsAt: "06:00", endsAt: "11:00" });
    expect((await crews.list(owner())).find((c) => c.id === late)!.workday).toBeNull();
    /** Left out keeps them. */
    await crews.update(owner(), { id: early, name: "Early crew" });
    expect((await crews.list(owner())).find((c) => c.id === early)!.workday).toEqual({ startsAt: "06:00", endsAt: "11:00" });

    const [line] = await raw<{ after: { workday: unknown } }[]>`select "after" from public.audit_log
      where organization_id = ${ORG} and action = 'crew.updated' and entity_id = ${early} order by created_at desc limit 1`;
    expect(line!.after.workday).toEqual({ startsAt: "06:00", endsAt: "11:00" });
  });

  it("are the day the single day rebalance plans the crew in, and a crew without them works the company's", async () => {
    await crews.update(owner(), { id: early, workday: { startsAt: "06:00", endsAt: "11:00" } });
    const proposal = await dispatchMap.rebalance(owner(), { date: TUE });
    const of = (id: string) => proposal.crews.find((c) => c.crewId === id)!;
    /** Six hours of work from six: past eleven is overtime. */
    expect(of(early).before.overtimeMinutes).toBeGreaterThan(0);
    expect(new Date(of(early).before.finishAt).getTime()).toBeLessThan(at(13).getTime());
    /** The late crew leaves at the company's start and has no overtime by five. */
    expect(of(late).before.overtimeMinutes).toBe(0);
    expect(new Date(of(late).before.finishAt).getTime()).toBeGreaterThan(new Date(of(early).before.finishAt).getTime());

    await crews.update(owner(), { id: early, workday: null });
    const back = await dispatchMap.rebalance(owner(), { date: TUE });
    expect(back.crews.find((c) => c.crewId === early)!.before.overtimeMinutes).toBe(0);
  });

  it("are the day the several day rebalance plans the crew in", async () => {
    await crews.update(owner(), { id: early, workday: { startsAt: "06:00", endsAt: "11:00" } });
    const proposal = await dispatchDays.rebalanceDays(owner(), { from: TUE, days: 2 });
    const day = proposal.perDay.find((d) => d.date === TUE)!;
    expect(day.crews.find((c) => c.crewId === early)!.before.overtimeMinutes).toBeGreaterThan(0);
    expect(day.crews.find((c) => c.crewId === late)!.before.overtimeMinutes).toBe(0);
    await crews.update(owner(), { id: early, workday: null });
  });

  it("are what a route's fit for a date measures the crew against", async () => {
    const route = await serviceRoutes.create(owner(), {
      name: `Early posts ${Math.random().toString(36).slice(2, 7)}`, dayOfWeek: 2, travelMinutesBetweenStops: 10, crewId: early,
    });
    for (let i = 0; i < 10; i += 1) {
      const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
        values (${ORG}, ${`${i + 1} Route Lane`}, 'Austin', 'TX', '78701') returning id`;
      await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
      await serviceRoutes.addStop(owner(), { routeId: route.id, propertyId: p!.id, estimatedMinutes: 20 });
    }
    /** The company's day: eight to four. */
    const companyDay = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    expect(companyDay).toMatchObject({ servicer: { kind: "crew", hoursFrom: "company", startsAt: "08:00", endsAt: "16:00" } });

    await crews.update(owner(), { id: early, workday: { startsAt: "06:00", endsAt: "09:00" } });
    const own = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    expect(own).toMatchObject({
      fits: false, servicer: { kind: "crew", hoursFrom: "own", startsAt: "06:00", endsAt: "09:00", availableMinutes: 180 },
    });
    expect(own.refusedBecause).toContain("Early crew has 180 minutes that day (its hours, 6:00 AM to 9:00 AM)");
    await crews.update(owner(), { id: early, workday: null });
  });
});
