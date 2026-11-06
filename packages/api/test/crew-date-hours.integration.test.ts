import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as crews from "../src/services/crews";
import * as dispatch from "../src/services/dispatch";
import * as jobs from "../src/services/jobs";
import * as serviceRoutes from "../src/services/routes";
import * as businessHours from "../src/services/business-hours";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M09. A CREW'S HOURS ON ONE DATE, AND ITS DAYS OFF
 *
 * Datebook Fence Co keeps eight to four on weekdays. Its post crew never works
 * Sundays, is off on one Tuesday, and works a short day, six to eleven, on the
 * Wednesday after. The crew check, sending a visit to the crew, booking a
 * visit with it, the board's lane and a route's fit all read the crew's own
 * day: a day off is refused in words, and a date alone is measured against
 * the crew's own hours that date, not the company's.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("crew-date-hours:org");
const USER = fixtureId("crew-date-hours:user");
const ZONE = "America/Chicago";
/** A Tuesday at least a week out, the Wednesday after, and the Sunday before it. */
const TUE = (() => {
  let day = companyToday(7, ZONE);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 2) day = time.addDays(day, 1);
  return day;
})();
const WED = time.addDays(TUE, 1);
const SUN = time.addDays(TUE, 5);
const THU = time.addDays(TUE, 2);
const at = (date: string, hour: number) => time.instantOfLocal(date, hour * 60, ZONE);

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: string): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db() });
const owner = () => as("owner");

let posts = "";
let pat = "";
let customerId = "";
let propertyId = "";
let jobId = "";
let yard = "";

const week = (open: number[], opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek, opensAt: open.includes(dayOfWeek) ? opens : null, closesAt: open.includes(dayOfWeek) ? closes : null, closed: !open.includes(dayOfWeek),
}));

async function technician(key: string): Promise<string> {
  const userId = fixtureId(`crew-date-hours:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`crew-date-hours-${key}@test.local`}) on conflict (id) do nothing`;
  await raw`delete from public.membership where organization_id = ${ORG} and user_id = ${userId}`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, home_location_id)
    values (${ORG}, ${m!.id}, ${key}, ${yard}) returning id`;
  return t!.id;
}

/** An unassigned visit on the job on a date, nine to eleven. */
async function visitOn(date: string): Promise<string> {
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${jobId}, 'unassigned', ${at(date, 9)}, ${at(date, 11)}, 60) returning id`;
  return v!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Datebook Fence Co", slug: "crew-date-hours-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await businessHours.setWeek(owner(), { days: week([0, 1, 2, 3, 4, 5, 6], "08:00", "16:00") });
  const [l] = await raw<{ id: string }[]>`insert into public.location (organization_id, name, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.70)}, 'placed', 'manual') returning id`;
  yard = l!.id;
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Dora Datebook') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, '5 Post Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.31)}, ${geo.formatCoordinate(-97.71)}, 'rooftop', 'test') returning id`;
  propertyId = p!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${propertyId})`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, 9801, ${customerId}, ${propertyId}, 'scheduled', 'Fence posts') returning id`;
  jobId = job!.id;
  pat = await technician("Pat");
  const pia = await technician("Pia");
  const made = await crews.create(owner(), { name: "Post crew", homeLocationId: yard });
  posts = made.id;
  await crews.setMembers(owner(), { id: posts, members: [{ technicianId: pat, isLead: true }, { technicianId: pia }] });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`update public.crew set workday = null, weekday_hours = '[]', date_hours = '[]', days_off = '[]' where id = ${posts}`;
  await raw`delete from public.time_off where organization_id = ${ORG}`;
});

const ownDays = {
  daysOff: [0],
  dateHours: [{ date: TUE, off: true }, { date: WED, startsAt: "06:00", endsAt: "11:00" }],
};

run("a crew's dates and days off, kept on the crew", () => {
  it("are checked in words, listed, audited, kept when left out and cleared by an empty list", async () => {
    await expect(crews.update(owner(), { id: posts, dateHours: [{ date: WED, startsAt: "11:00", endsAt: "06:00" }] }))
      .rejects.toThrow(`The working day on ${WED} has to end after it starts.`);
    await expect(crews.update(owner(), { id: posts, dateHours: [{ date: WED, off: true }, { date: WED, off: true }] }))
      .rejects.toThrow(`${WED} is given twice.`);
    await expect(crews.update(owner(), { id: posts, daysOff: [0, 1, 2, 3, 4, 5, 6] }))
      .rejects.toThrow("A crew has to work at least one day of the week. Retire the crew instead.");

    await crews.update(owner(), { id: posts, ...ownDays });
    const listed = (await crews.list(owner())).find((c) => c.id === posts)!;
    expect(listed.daysOff).toEqual([0]);
    expect(listed.dateHours).toEqual([
      { date: TUE, off: true, startsAt: null, endsAt: null },
      { date: WED, off: false, startsAt: "06:00", endsAt: "11:00" },
    ]);
    const [line] = await raw<{ after: { daysOff: unknown; dateHours: unknown[] } }[]>`select "after" from public.audit_log
      where organization_id = ${ORG} and action = 'crew.updated' and entity_id = ${posts} order by created_at desc limit 1`;
    expect(line!.after.daysOff).toEqual([0]);
    expect(line!.after.dateHours).toHaveLength(2);

    await crews.update(owner(), { id: posts, name: "Post crew" });
    expect((await crews.list(owner())).find((c) => c.id === posts)!.dateHours).toHaveLength(2);

    /** A Sunday off and hours on Sundays cannot both stand. */
    await expect(crews.update(owner(), { id: posts, weekdayHours: [{ dayOfWeek: 0, startsAt: "07:00", endsAt: "11:00" }] }))
      .rejects.toThrow("Sunday is a day off and has hours of its own. Clear one of them.");

    await crews.update(owner(), { id: posts, daysOff: [], dateHours: [] });
    const cleared = (await crews.list(owner())).find((c) => c.id === posts)!;
    expect(cleared.daysOff).toEqual([]);
    expect(cleared.dateHours).toEqual([]);
  });

  it("are changed only by somebody who dispatches", async () => {
    await expect(crews.update(as("technician"), { id: posts, daysOff: [6] })).rejects.toThrow();
    await expect(crews.update(as("csr"), { id: posts, dateHours: [{ date: TUE, off: true }] })).rejects.toThrow();
    expect((await crews.list(owner())).find((c) => c.id === posts)!.daysOff).toEqual([]);
  });
});

run("the crew check reads the crew's own day", () => {
  it("refuses a date the crew is off and a weekday it does not work, in words", async () => {
    await crews.update(owner(), { id: posts, ...ownDays });
    const tuesday = await crews.canTake(owner(), { id: posts, jobId, on: TUE });
    expect(tuesday.canTake).toBe(false);
    expect(tuesday.blockers.map((b) => b.code)).toEqual(["crew_day_off"]);
    expect(tuesday.blockers[0]!.explanation).toContain(`Post crew is off on ${TUE}.`);
    expect(tuesday.hours).toBeNull();

    const sunday = await crews.canTake(owner(), { id: posts, jobId, on: SUN });
    expect(sunday.blockers[0]!.explanation).toContain("Post crew does not work on Sundays.");
    expect((await crews.crewsFor(owner(), { jobId, on: SUN })).crews.find((c) => c.crewId === posts)!.canTake).toBe(false);
  });

  it("puts the crew to work on a weekday it has off when that date has hours", async () => {
    await crews.update(owner(), { id: posts, daysOff: [0], dateHours: [{ date: SUN, startsAt: "07:00", endsAt: "12:00" }] });
    const sunday = await crews.canTake(owner(), { id: posts, jobId, on: SUN });
    expect(sunday.canTake).toBe(true);
    expect(sunday).toMatchObject({ hoursFrom: "date", hours: { startsAt: "07:00", endsAt: "12:00" } });
  });

  it("asked about a date alone, counts a member off whose leave covers the crew's own hours that date", async () => {
    /** Pat is off from five until noon on the Wednesday: all of the crew's short day, but not the company's. */
    await raw`insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved, reason)
      values (${ORG}, ${pat}, ${at(WED, 5)}, ${at(WED, 12)}, true, 'Dentist')`;
    const companyDay = await crews.canTake(owner(), { id: posts, jobId, on: WED });
    expect(companyDay.hoursFrom).toBe("company");
    expect(companyDay.headcount.offOn).toBe(0);
    expect(companyDay.partDayOff.map((p) => p.name)).toEqual(["Pat"]);

    await crews.update(owner(), { id: posts, ...ownDays });
    const ownDay = await crews.canTake(owner(), { id: posts, jobId, on: WED });
    expect(ownDay.hoursFrom).toBe("date");
    expect(ownDay.headcount.offOn).toBe(1);
    expect(ownDay.blockers.map((b) => b.code)).toEqual(["lead_off"]);
  });
});

run("sending and booking work onto a crew's day off", () => {
  it("refuses sending a visit to the crew on a day it is off, and takes one on a day it works", async () => {
    await crews.update(owner(), { id: posts, ...ownDays });
    const tuesday = await visitOn(TUE);
    const thursday = await visitOn(THU);
    try {
      await expect(crews.assign(owner(), { id: tuesday, crewId: posts })).rejects.toThrow(`Post crew is off on ${TUE}.`);
      await expect(crews.assign(owner(), { id: thursday, crewId: posts })).resolves.toMatchObject({ crewId: posts });
    } finally {
      await raw`delete from public.visit where id in (${tuesday}, ${thursday})`;
    }
  });

  it("refuses booking a visit with the crew on a day it does not work", async () => {
    await crews.update(owner(), { id: posts, ...ownDays });
    await expect(jobs.addVisit(owner(), {
      id: jobId, windowStart: at(SUN, 9).toISOString(), windowEnd: at(SUN, 11).toISOString(),
      estimatedDurationMinutes: 60, technicianIds: [], crewId: posts,
    })).rejects.toThrow("Post crew does not work on Sundays. Book it on a day the crew works");
    const booked = await jobs.addVisit(owner(), {
      id: jobId, windowStart: at(THU, 9).toISOString(), windowEnd: at(THU, 11).toISOString(),
      estimatedDurationMinutes: 60, technicianIds: [], crewId: posts,
    });
    await raw`delete from public.visit where id = ${booked.id}`;
  });
});

run("the board and a route's fit read the crew's own day", () => {
  it("says on the lane that the crew is off, marks its cards, and draws a date's own hours", async () => {
    await crews.update(owner(), { id: posts, ...ownDays });
    const v = await visitOn(TUE);
    await raw`update public.visit set crew_id = ${posts}, status = 'dispatched' where id = ${v}`;
    try {
      const tuesday = (await dispatch.board(owner(), { date: TUE })).crews.find((c) => c.id === posts)!;
      expect(tuesday.dayOff).toBe(`Post crew is off on ${TUE}.`);
      expect(tuesday.visits.map((x) => x.outsideHours)).toEqual([true]);
      const wednesday = (await dispatch.board(owner(), { date: WED })).crews.find((c) => c.id === posts)!;
      expect(wednesday).toMatchObject({ dayOff: null, hours: { startsAt: "06:00", endsAt: "11:00", from: "date" } });
      const sunday = (await dispatch.board(owner(), { date: SUN })).crews.find((c) => c.id === posts)!;
      expect(sunday.dayOff).toBe("Post crew does not work on Sundays.");
    } finally {
      await raw`delete from public.visit where id = ${v}`;
    }
  });

  it("refuses a route's date when the crew is off, and measures a date's own hours", async () => {
    const route = await serviceRoutes.create(owner(), {
      name: `Tuesday posts ${Math.random().toString(36).slice(2, 7)}`, dayOfWeek: 2, travelMinutesBetweenStops: 10, crewId: posts,
    });
    await serviceRoutes.addStop(owner(), { routeId: route.id, propertyId, estimatedMinutes: 20 });
    await crews.update(owner(), { id: posts, ...ownDays });
    const off = await serviceRoutes.density(owner(), { id: route.id, on: TUE });
    expect(off.fits).toBe(false);
    expect(off.refusedBecause).toBe(`Post crew is off on ${TUE}. Nothing on this route fits that day.`);
    expect(off.servicer).toMatchObject({ kind: "crew", offAllDay: true, dayOff: `Post crew is off on ${TUE}.` });

    await crews.update(owner(), { id: posts, dateHours: [{ date: TUE, startsAt: "06:00", endsAt: "09:00" }] });
    expect(await serviceRoutes.density(owner(), { id: route.id, on: TUE }))
      .toMatchObject({ fits: true, servicer: { hoursFrom: "own", startsAt: "06:00", endsAt: "09:00", dayOff: null } });
  });
});
