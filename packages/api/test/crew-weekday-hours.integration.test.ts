import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as crews from "../src/services/crews";
import * as dispatch from "../src/services/dispatch";
import * as dispatchMap from "../src/services/dispatch-map";
import * as dispatchDays from "../src/services/dispatch-days";
import * as serviceRoutes from "../src/services/routes";
import * as businessHours from "../src/services/business-hours";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M09. A CREW'S HOURS BY WEEKDAY, AND A LANE THAT IS ALWAYS THERE
 *
 * Weekday Fence Co keeps eight to four. Its post crew works six to four, but
 * only six to eleven on Tuesdays. The rebalance, one day and several, and a
 * route's fit read the Tuesday hours on a Tuesday and the usual hours on
 * other days; with neither the crew works the company's day. On the board
 * every active crew has a lane, work or not, drawn to its hours that day,
 * with a card outside them marked; a branch manager's board shows their own
 * branch's crews.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("crew-weekday-hours:org");
const USER = fixtureId("crew-weekday-hours:user");
const ZONE = "America/Chicago";
/** A Tuesday at least a week out, and the Wednesday after. */
const TUE = (() => {
  let day = companyToday(7, ZONE);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 2) day = time.addDays(day, 1);
  return day;
})();
const WED = time.addDays(TUE, 1);
const at = (date: string, hour: number) => time.instantOfLocal(date, hour * 60, ZONE);

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
let austin = "";
let houston = "";
const manager = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["branch_manager"] as Actor["roles"], businessUnitId: austin }, db: db(),
});

let posts = "";
let idle = "";
let elsewhere = "";
let customerId = "";
let yard = "";

const week = (open: number[], opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek, opensAt: open.includes(dayOfWeek) ? opens : null, closesAt: open.includes(dayOfWeek) ? closes : null, closed: !open.includes(dayOfWeek),
}));

async function technician(key: string): Promise<string> {
  const userId = fixtureId(`crew-weekday-hours:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`crew-weekday-hours-${key}@test.local`}) on conflict (id) do nothing`;
  await raw`delete from public.membership where organization_id = ${ORG} and user_id = ${userId}`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, home_location_id)
    values (${ORG}, ${m!.id}, ${key}, ${yard}) returning id`;
  return t!.id;
}

async function crewOf(name: string, branchId: string, people: string[]): Promise<string> {
  const made = await crews.create(owner(), { name, homeLocationId: yard, businessUnitId: branchId });
  for (const [i, p] of people.entries()) {
    await raw`insert into public.crew_member (organization_id, crew_id, technician_id, is_lead) values (${ORG}, ${made.id}, ${p}, ${i === 0})`;
  }
  return made.id;
}

/** A crew's visit on a date, from six to six, three hours long, in Austin. */
async function crewVisit(order: number, crewId: string, date: string, from = 6, until = 18) {
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, ${`${order} Post Rd`}, 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.70 + order / 1000)}, 'rooftop', 'test') returning id`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary, business_unit_id)
    values (${ORG}, ${9700 + order}, ${customerId}, ${p!.id}, 'scheduled', 'Fence section', ${austin}) returning id`;
  await raw`insert into public.visit
      (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes, crew_id)
    values (${ORG}, ${job!.id}, 'dispatched', ${at(date, from)}, ${at(date, until)}, ${order}, 180, ${crewId})`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Weekday Fence Co", slug: "crew-weekday-hours-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await businessHours.setWeek(owner(), { days: week([1, 2, 3, 4, 5], "08:00", "16:00") });
  const [l] = await raw<{ id: string }[]>`insert into public.location (organization_id, name, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.70)}, 'placed', 'manual') returning id`;
  yard = l!.id;
  const [a] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  const [h] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;
  austin = a!.id;
  houston = h!.id;
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Wes Weekday') returning id`;
  customerId = c!.id;
  posts = await crewOf("Post crew", austin, [await technician("Pat"), await technician("Pia")]);
  idle = await crewOf("Idle crew", austin, [await technician("Ida")]);
  elsewhere = await crewOf("Houston crew", houston, [await technician("Hank")]);
  await crewVisit(1, posts, TUE);
  await crewVisit(2, posts, TUE);
  await crewVisit(3, posts, WED);
  await crewVisit(4, posts, WED);
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`update public.crew set workday = '{"startsAt": "06:00", "endsAt": "16:00"}', weekday_hours = '[]' where id = ${posts}`;
  await raw`update public.crew set workday = null, weekday_hours = '[]' where id in (${idle}, ${elsewhere})`;
});

const tuesdayShort = [{ dayOfWeek: 2, startsAt: "06:00", endsAt: "11:00" }];

run("a crew's hours by weekday", () => {
  it("are set on the crew, checked in words, listed and audited, kept when left out and cleared by an empty list", async () => {
    await expect(crews.update(owner(), { id: posts, weekdayHours: [...tuesdayShort, { dayOfWeek: 2, startsAt: "07:00", endsAt: "12:00" }] }))
      .rejects.toThrow("Tuesday is given twice. Give each day its hours once.");
    await expect(crews.update(owner(), { id: posts, weekdayHours: [{ dayOfWeek: 6, startsAt: "11:00", endsAt: "07:00" }] }))
      .rejects.toThrow("Saturday's working day has to end after it starts.");

    await crews.update(owner(), { id: posts, weekdayHours: [{ dayOfWeek: 6, startsAt: "07:00", endsAt: "11:00" }, ...tuesdayShort] });
    const listed = (await crews.list(owner())).find((c) => c.id === posts)!;
    expect(listed.weekdayHours).toEqual([...tuesdayShort, { dayOfWeek: 6, startsAt: "07:00", endsAt: "11:00" }]);
    expect(listed.workday).toEqual({ startsAt: "06:00", endsAt: "16:00" });
    await crews.update(owner(), { id: posts, name: "Post crew" });
    expect((await crews.list(owner())).find((c) => c.id === posts)!.weekdayHours).toHaveLength(2);
    const [line] = await raw<{ after: { weekdayHours: unknown } }[]>`select "after" from public.audit_log
      where organization_id = ${ORG} and action = 'crew.updated' and entity_id = ${posts} order by created_at desc limit 1`;
    expect(line!.after.weekdayHours).toHaveLength(2);

    await crews.update(owner(), { id: posts, weekdayHours: [] });
    expect((await crews.list(owner())).find((c) => c.id === posts)!.weekdayHours).toEqual([]);
  });

  it("are the day the single day rebalance plans the crew in on that weekday, and the usual hours on another", async () => {
    const usual = await dispatchMap.rebalance(owner(), { date: TUE });
    expect(usual.crews.find((c) => c.crewId === posts)!.before.overtimeMinutes).toBe(0);

    await crews.update(owner(), { id: posts, weekdayHours: tuesdayShort });
    const tuesday = await dispatchMap.rebalance(owner(), { date: TUE });
    expect(tuesday.crews.find((c) => c.crewId === posts)!.before.overtimeMinutes).toBeGreaterThan(0);
    const wednesday = await dispatchMap.rebalance(owner(), { date: WED });
    expect(wednesday.crews.find((c) => c.crewId === posts)!.before.overtimeMinutes).toBe(0);
  });

  it("are read day by day in the several day rebalance", async () => {
    await crews.update(owner(), { id: posts, weekdayHours: tuesdayShort });
    const proposal = await dispatchDays.rebalanceDays(owner(), { from: TUE, days: 2 });
    const crewOn = (date: string) => proposal.perDay.find((d) => d.date === date)!.crews.find((c) => c.crewId === posts)!;
    expect(crewOn(TUE).before.overtimeMinutes).toBeGreaterThan(0);
    expect(crewOn(WED).before.overtimeMinutes).toBe(0);
  });

  it("are what a route's fit for a date measures the crew against, falling back to the company's day", async () => {
    const route = await serviceRoutes.create(owner(), {
      name: `Tuesday posts ${Math.random().toString(36).slice(2, 7)}`, dayOfWeek: 2, travelMinutesBetweenStops: 10, crewId: posts,
    });
    const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, '1 Route Lane', 'Austin', 'TX', '78701') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
    await serviceRoutes.addStop(owner(), { routeId: route.id, propertyId: p!.id, estimatedMinutes: 20 });

    expect(await serviceRoutes.density(owner(), { id: route.id, on: TUE }))
      .toMatchObject({ servicer: { kind: "crew", hoursFrom: "own", startsAt: "06:00", endsAt: "16:00" } });
    await crews.update(owner(), { id: posts, weekdayHours: tuesdayShort });
    expect(await serviceRoutes.density(owner(), { id: route.id, on: TUE }))
      .toMatchObject({ servicer: { kind: "crew", hoursFrom: "own", startsAt: "06:00", endsAt: "11:00" } });
    await crews.update(owner(), { id: posts, workday: null, weekdayHours: [{ dayOfWeek: 3, startsAt: "06:00", endsAt: "11:00" }] });
    expect(await serviceRoutes.density(owner(), { id: route.id, on: TUE }))
      .toMatchObject({ servicer: { kind: "crew", hoursFrom: "company", startsAt: "08:00", endsAt: "16:00" } });
  });
});

run("a crew's lane on the board", () => {
  it("is there for every active crew, work or not, drawn to its hours that day", async () => {
    await crews.update(owner(), { id: posts, weekdayHours: tuesdayShort });
    const board = await dispatch.board(owner(), { date: TUE });
    const lane = (id: string) => board.crews.find((c) => c.id === id)!;
    expect(board.crews.map((c) => c.name)).toEqual(["Houston crew", "Idle crew", "Post crew"]);
    expect(lane(idle)).toMatchObject({ visits: [], inScope: true, hours: { startsAt: "08:00", endsAt: "17:00", from: "company" }, branchClosed: null });
    expect(lane(posts).hours).toEqual({ startsAt: "06:00", endsAt: "11:00", from: "weekday" });
    /** Six to six runs past eleven. */
    expect(lane(posts).visits.map((v) => v.outsideHours)).toEqual([true, true]);

    const wednesday = await dispatch.board(owner(), { date: WED });
    expect(wednesday.crews.find((c) => c.id === posts)!.hours).toEqual({ startsAt: "06:00", endsAt: "16:00", from: "own" });

    /** A Saturday the company keeps closed says so on the lane. */
    const saturday = time.addDays(TUE, 4);
    expect((await dispatch.board(owner(), { date: saturday })).crews.find((c) => c.id === idle)!.branchClosed).toBe("Closed on Saturdays.");
  });

  it("marks a card inside the crew's hours as inside them", async () => {
    await crews.update(owner(), { id: idle, workday: { startsAt: "06:00", endsAt: "18:00" } });
    await crewVisit(9, idle, TUE, 7, 10);
    try {
      const lane = (await dispatch.board(owner(), { date: TUE })).crews.find((c) => c.id === idle)!;
      expect(lane.visits.map((v) => v.outsideHours)).toEqual([false]);
    } finally {
      await raw`delete from public.visit where crew_id = ${idle}`;
    }
  });

  it("shows a branch manager their own branch's crews, and the board filtered to a branch that branch's", async () => {
    const theirs = await dispatch.board(manager(), { date: TUE });
    expect(theirs.crews.map((c) => c.name)).toEqual(["Idle crew", "Post crew"]);
    expect(theirs.crews.every((c) => c.inScope)).toBe(true);
    const filtered = await dispatch.board(owner(), { date: TUE, businessUnitId: houston });
    expect(filtered.crews.map((c) => c.name)).toEqual(["Houston crew"]);
  });

  it("takes a crew's first visit of the day dropped on its empty lane", async () => {
    const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code,
        latitude, longitude, location_precision, location_source)
      values (${ORG}, '20 Post Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.68)}, 'rooftop', 'test') returning id`;
    const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary, business_unit_id)
      values (${ORG}, 9790, ${customerId}, ${p!.id}, 'scheduled', 'Gate', ${austin}) returning id`;
    const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
      values (${ORG}, ${job!.id}, 'unassigned', ${at(TUE, 9)}, ${at(TUE, 11)}, 60) returning id`;
    try {
      await crews.assign(owner(), { id: v!.id, crewId: idle });
      const lane = (await dispatch.board(owner(), { date: TUE })).crews.find((c) => c.id === idle)!;
      expect(lane.visits.map((x) => x.id)).toEqual([v!.id]);
    } finally {
      await raw`delete from public.visit where id = ${v!.id}`;
      await raw`delete from public.job where id = ${job!.id}`;
    }
  });
});
