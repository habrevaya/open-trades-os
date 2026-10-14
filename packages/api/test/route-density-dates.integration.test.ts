import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as serviceRoutes from "../src/services/routes";
import * as businessHours from "../src/services/business-hours";
import * as holidays from "../src/services/holidays";
import * as crews from "../src/services/crews";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M09. A ROUTE'S FIT, ASKED FOR A DATE
 *
 * Density Dates Co opens Monday to Friday, eight to four. Its Tuesday pool
 * route fits a normal Tuesday; on Christmas week's Tuesday, a holiday, it has
 * no day to fit into; on a short day it is measured against that day's hours.
 * The same route run by somebody in its Houston branch, which keeps Tuesdays
 * closed, has no Tuesday at all, and Houston's own day off closes only
 * Houston's routes. A fortnightly stop serviced last week is left out of next
 * Tuesday's figure.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("density-dates:org");
const USER = fixtureId("density-dates:user");

/** Tuesdays, and a Wednesday, in January 2027. */
const TUE = "2027-01-05";
const TUE2 = "2027-01-12";
const TUE3 = "2027-01-19";
const WED = "2027-01-06";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const keyed = (key: string): ServiceContext => ({ ...owner(), idempotencyKey: `${key}-${Math.random().toString(36).slice(2)}` });

let customerId = "";
let houston = "";
let austinTech = "";
let houstonTech = "";

const week = (open: number[], opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek, opensAt: open.includes(dayOfWeek) ? opens : null, closesAt: open.includes(dayOfWeek) ? closes : null, closed: !open.includes(dayOfWeek),
}));

async function technician(key: string, branchId: string | null): Promise<string> {
  const userId = fixtureId(`density-dates:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`density-dates-${key}@test.local`}) on conflict (id) do nothing`;
  await raw`delete from public.membership where organization_id = ${ORG} and user_id = ${userId}`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role, business_unit_id)
    values (${ORG}, ${userId}, 'technician', ${branchId}) returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, ${key}) returning id`;
  return t!.id;
}

/** A Tuesday route with ten twenty minute stops, ten minutes apart: 290 minutes. */
async function aRoute(servicer: { technicianId?: string; crewId?: string }) {
  const route = await serviceRoutes.create(owner(), {
    name: `Tuesday pools ${Math.random().toString(36).slice(2, 7)}`, dayOfWeek: 2, travelMinutesBetweenStops: 10, ...servicer,
  });
  const stops: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, ${`${i + 1} Pool Lane`}, 'Austin', 'TX', '78701') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
    stops.push((await serviceRoutes.addStop(owner(), { routeId: route.id, propertyId: p!.id, estimatedMinutes: 20 })).id);
  }
  return { route, stops };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Density Dates Co", slug: "density-dates-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Pat Pool') returning id`;
  customerId = c!.id;
  const [h] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;
  houston = h!.id;
  austinTech = await technician("dana", null);
  houstonTech = await technician("hal", houston);
  await businessHours.setWeek(owner(), { days: week([1, 2, 3, 4, 5], "08:00", "16:00") });
  /** Houston keeps Tuesdays closed, and opens Wednesday to Saturday. */
  await businessHours.setWeek(owner(), { days: week([3, 4, 5, 6], "07:00", "15:00"), businessUnitId: houston });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  for (const table of ["company_holiday", "overtime_policy"]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
});

run("a route's fit on a date", () => {
  it("fits an ordinary Tuesday as the weekday's template does, and says which date it was asked for", async () => {
    const { route } = await aRoute({ technicianId: austinTech });
    const template = await serviceRoutes.density(owner(), { id: route.id });
    expect(template).toMatchObject({ on: null, dayBasis: "business_hours", overtimeAfterMinutes: 480, runsIntoOvertime: false });
    const dated = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    expect(dated).toMatchObject({ on: TUE, holiday: null, closedOn: null, dayBasis: "business_hours", overtimeAfterMinutes: 480, totalMinutes: 290, runsIntoOvertime: false });
    expect(dated.explanation).toMatch(/the hours you keep that day/);
  });

  it("has no working day on a closed holiday, and gives no overtime verdict", async () => {
    const { route } = await aRoute({ technicianId: austinTech });
    await holidays.create(keyed("closed"), { name: "Founders Day", date: TUE, closed: true });
    const answer = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    expect(answer).toMatchObject({
      dayBasis: "closed", holiday: "Founders Day", overtimeAfterMinutes: null, runsIntoOvertime: null, minutesOverThreshold: null,
    });
    expect(answer.closedOn).toBe(`You are closed on ${TUE} for Founders Day.`);
    expect(answer.explanation).toMatch(/no working day to fit into/);
    /** The template does not know about one date. */
    expect((await serviceRoutes.density(owner(), { id: route.id })).dayBasis).toBe("business_hours");
  });

  it("measures a short day against its own hours, and says it beside an overtime policy", async () => {
    const { route } = await aRoute({ technicianId: austinTech });
    await holidays.create(keyed("short"), { name: "Half day", date: TUE2, closed: false, opensAt: "08:00", closesAt: "12:00" });
    const short = await serviceRoutes.density(owner(), { id: route.id, on: TUE2 });
    expect(short).toMatchObject({ dayBasis: "business_hours", overtimeAfterMinutes: 240, openMinutes: 240, holiday: "Half day", runsIntoOvertime: true });
    await raw`insert into public.overtime_policy (organization_id, label, time_zone, week_starts_on, day_attribution,
        daily_threshold_minutes, overtime_multiplier, double_time_multiplier, on_call_treatment, note)
      values (${ORG}, 'Policy', 'America/Chicago', 0, 'shift_start', 480, '1.5', '2', 'separate_rate_not_hours_worked', 'A fixture.')`;
    const policy = await serviceRoutes.density(owner(), { id: route.id, on: TUE2 });
    expect(policy).toMatchObject({ dayBasis: "overtime_policy", overtimeAfterMinutes: 480, runsIntoOvertime: false, openMinutes: 240 });
    expect(policy.explanation).toMatch(/You keep 240 minutes of hours that day, which this day runs 50 minutes past/);
  });

  it("refuses a date on another weekday than the route's", async () => {
    const { route } = await aRoute({ technicianId: austinTech });
    await expect(serviceRoutes.density(owner(), { id: route.id, on: WED })).rejects.toBeInstanceOf(ConflictError);
    await expect(serviceRoutes.density(owner(), { id: route.id, on: WED })).rejects.toThrow(/runs on Tuesday/);
  });

  it("reads the week of the branch whoever runs it is in: Houston keeps Tuesdays closed", async () => {
    const byPerson = await aRoute({ technicianId: houstonTech });
    expect((await serviceRoutes.density(owner(), { id: byPerson.route.id })).dayBasis).toBe("unknown");
    const dated = await serviceRoutes.density(owner(), { id: byPerson.route.id, on: TUE });
    expect(dated).toMatchObject({ dayBasis: "closed", closedOn: `You are closed on Tuesdays, so ${TUE} is not a working day.` });

    const crew = await crews.create(owner(), { name: `Houston crew ${Math.random().toString(36).slice(2, 7)}`, businessUnitId: houston });
    const byCrew = await aRoute({ crewId: crew.id });
    expect((await serviceRoutes.density(owner(), { id: byCrew.route.id, on: TUE })).dayBasis).toBe("closed");
  });

  it("closes only Houston's routes on Houston's own day off", async () => {
    await businessHours.setWeek(owner(), { days: week([2, 3, 4, 5, 6], "07:00", "15:00"), businessUnitId: houston });
    try {
      const inHouston = await aRoute({ technicianId: houstonTech });
      const inAustin = await aRoute({ technicianId: austinTech });
      await holidays.create(keyed("rodeo"), { name: "Rodeo", date: TUE3, closed: true, businessUnitId: houston });
      expect((await serviceRoutes.density(owner(), { id: inHouston.route.id, on: TUE3 })).dayBasis).toBe("closed");
      expect(await serviceRoutes.density(owner(), { id: inHouston.route.id, on: TUE })).toMatchObject({ dayBasis: "business_hours", overtimeAfterMinutes: 480 });
      expect((await serviceRoutes.density(owner(), { id: inAustin.route.id, on: TUE3 })).dayBasis).toBe("business_hours");
    } finally {
      await businessHours.setWeek(owner(), { days: week([3, 4, 5, 6], "07:00", "15:00"), businessUnitId: houston });
    }
  });

  it("leaves out a stop whose own cadence does not fall on the date", async () => {
    const { route, stops } = await aRoute({ technicianId: austinTech });
    await raw`update public.route_stop set interval_days = 14, last_serviced_on = ${TUE} where id = ${stops[0]!}`;
    const next = await serviceRoutes.density(owner(), { id: route.id, on: TUE2 });
    expect(next).toMatchObject({ stopCount: 9, notDueCount: 1, serviceMinutes: 180 });
    expect(await serviceRoutes.density(owner(), { id: route.id, on: TUE3 })).toMatchObject({ stopCount: 10, notDueCount: 0 });
    expect(await serviceRoutes.density(owner(), { id: route.id })).toMatchObject({ stopCount: 10, notDueCount: 0 });
  });
});
