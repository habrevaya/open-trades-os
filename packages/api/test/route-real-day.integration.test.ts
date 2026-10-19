import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as serviceRoutes from "../src/services/routes";
import * as businessHours from "../src/services/business-hours";
import * as crews from "../src/services/crews";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M09. A ROUTE'S FIT READS THE REAL DAY
 *
 * Real Day Co opens Monday to Friday, eight to four. Dana's Tuesday route is
 * ten twenty minute stops ten minutes apart: 290 minutes. Asked for a date, the
 * fit counts the visits already on Dana's day as they are now (a stop called
 * off is not, a service call added is), and reads Dana's own hours and leave:
 * an afternoon off leaves four hours, which the day no longer fits, and a whole
 * day off refuses it in words. A crew's day names who on it is off.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("route-real-day:org");
const USER = fixtureId("route-real-day:user");
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

let customerId = "";

const week = (open: number[], opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek, opensAt: open.includes(dayOfWeek) ? opens : null, closesAt: open.includes(dayOfWeek) ? closes : null, closed: !open.includes(dayOfWeek),
}));

async function technician(key: string): Promise<string> {
  const userId = fixtureId(`route-real-day:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`route-real-day-${key}@test.local`}) on conflict (id) do nothing`;
  await raw`delete from public.membership where organization_id = ${ORG} and user_id = ${userId}`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, ${key}) returning id`;
  return t!.id;
}

async function aRoute(servicer: { technicianId?: string; crewId?: string }) {
  const route = await serviceRoutes.create(owner(), {
    name: `Tuesday pools ${Math.random().toString(36).slice(2, 7)}`, dayOfWeek: 2, travelMinutesBetweenStops: 10, ...servicer,
  });
  for (let i = 0; i < 10; i += 1) {
    const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, ${`${i + 1} Real Lane`}, 'Austin', 'TX', '78701') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
    await serviceRoutes.addStop(owner(), { routeId: route.id, propertyId: p!.id, estimatedMinutes: 20 });
  }
  return route;
}

async function leave(technicianId: string, from: Date, to: Date) {
  await raw`insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved, reason)
    values (${ORG}, ${technicianId}, ${from}, ${to}, true, 'Leave')`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Real Day Co", slug: "route-real-day-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Pat Pool') returning id`;
  customerId = c!.id;
  await businessHours.setWeek(owner(), { days: week([1, 2, 3, 4, 5], "08:00", "16:00") });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.time_off where organization_id = ${ORG}`;
});

run("a route's fit on the real day", () => {
  it("fits an ordinary day against the hours kept that day, and leaves the template as it was", async () => {
    const dana = await technician("Dana");
    const route = await aRoute({ technicianId: dana });
    const dated = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    expect(dated).toMatchObject({
      totalMinutes: 290, madeVisits: 0, fits: true, refusedBecause: null,
      servicer: { name: "Dana", kind: "technician", hoursFrom: "company", startsAt: "08:00", endsAt: "16:00", availableMinutes: 480, leaveMinutes: 0, offAllDay: false },
    });
    expect(dated.explanation).toContain("It fits the 480 minutes Dana has that day (the hours you keep that day, 8:00 AM to 4:00 PM).");
    expect(await serviceRoutes.density(owner(), { id: route.id })).toMatchObject({ servicer: null, fits: null, refusedBecause: null, madeVisits: 0 });
  });

  it("counts the visits already on the day as they are now: a stop called off is not, a service call added is", async () => {
    const dana = await technician("Dana");
    const route = await aRoute({ technicianId: dana });
    const made = await serviceRoutes.materialise(owner(), { id: route.id, date: TUE });
    expect(made.created).toHaveLength(10);
    await raw`update public.visit set status = 'cancelled' where id = ${made.created[0]!.visitId}`;
    const [shop] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, '1 Pump St', 'Austin', 'TX', '78701') returning id`;
    const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 9100, ${customerId}, ${shop!.id}, 'scheduled', 'Pump will not prime') returning id`;
    const [call] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
      values (${ORG}, ${job!.id}, 'scheduled', ${at(13)}, ${at(14)}, 60) returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${call!.id}, ${dana})`;

    const dated = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    // Nine stops of twenty, an hour's call, and nine drives of ten.
    expect(dated).toMatchObject({ madeVisits: 10, stopCount: 10, serviceMinutes: 240, totalMinutes: 330, fits: true });
    expect(dated.explanation).toContain("Counted from the day as it is: 10 visits already on it and 0 stops still to make.");
  });

  it("reads the servicer's leave: an afternoon off leaves four hours, and a whole day off refuses it in words", async () => {
    const dana = await technician("Dana");
    const route = await aRoute({ technicianId: dana });
    await leave(dana, at(12), at(17));
    const afternoon = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    expect(afternoon).toMatchObject({ fits: false, servicer: { availableMinutes: 240, leaveMinutes: 240, offAllDay: false } });
    expect(afternoon.refusedBecause).toBe(
      "Dana has 240 minutes that day (the hours you keep that day, 8:00 AM to 4:00 PM less leave from 12:00 PM to 5:00 PM) and the day comes to 290, 50 minutes too many.",
    );
    // The overtime question is a different one, and its answer stands.
    expect(afternoon.runsIntoOvertime).toBe(false);

    await raw`delete from public.time_off where organization_id = ${ORG}`;
    await leave(dana, time.instantOfLocal(TUE, 0, ZONE), time.instantOfLocal(time.addDays(TUE, 1), 0, ZONE));
    const away = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    expect(away).toMatchObject({ fits: false, servicer: { offAllDay: true } });
    expect(away.refusedBecause).toBe(`Dana is on leave all of ${TUE}, so nothing on this route fits that day.`);
    // Leave on another day is no matter, and leave nobody approved is not leave.
    await raw`delete from public.time_off where organization_id = ${ORG}`;
    await leave(dana, at(-24 + 8), at(-24 + 16));
    await raw`insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved) values (${ORG}, ${dana}, ${at(8)}, ${at(16)}, false)`;
    expect(await serviceRoutes.density(owner(), { id: route.id, on: TUE })).toMatchObject({ fits: true, servicer: { leaveMinutes: 0 } });
  });

  it("reads the servicer's own hours, and counts a new stop against them", async () => {
    const dana = await technician("Dana");
    const route = await aRoute({ technicianId: dana });
    await raw`update public.technician set workday = ${raw.json({ startsAt: "06:00", endsAt: "11:00" })} where id = ${dana}`;
    const own = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    expect(own).toMatchObject({ fits: true, servicer: { hoursFrom: "own", startsAt: "06:00", endsAt: "11:00", availableMinutes: 300 } });
    const adding = await serviceRoutes.density(owner(), { id: route.id, on: TUE, addingStopOfMinutes: 30 });
    // Eleven stops: 230 minutes of work and ten drives of ten, 330 against her 300.
    expect(adding).toMatchObject({ stopCount: 11, totalMinutes: 330, fits: false });
    expect(adding.refusedBecause).toContain("Dana has 300 minutes that day (their own hours, 6:00 AM to 11:00 AM)");
    expect(adding.refusedBecause).toContain("30 minutes too many");
  });

  it("names a crew's members on leave, and refuses a day every one of them is off", async () => {
    const crew = await crews.create(owner(), { name: `Pool crew ${Math.random().toString(36).slice(2, 7)}` });
    const ana = await technician("Ana");
    const ben = await technician("Ben");
    for (const member of [ana, ben]) {
      await raw`insert into public.crew_member (organization_id, crew_id, technician_id) values (${ORG}, ${crew.id}, ${member})`;
    }
    const route = await aRoute({ crewId: crew.id });
    await leave(ana, at(8), at(16));
    const short = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    expect(short).toMatchObject({ fits: true, servicer: { kind: "crew", membersOff: ["Ana"], offAllDay: false } });
    expect(short.explanation).toContain("Ana is on leave that day, so the crew is short.");
    await leave(ben, at(7), at(17));
    const none = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    expect(none).toMatchObject({ fits: false, servicer: { offAllDay: true, membersOff: ["Ana", "Ben"] } });
    expect(none.refusedBecause).toMatch(/^Everybody on Pool crew \w+ is on leave all of /);
  });
});
