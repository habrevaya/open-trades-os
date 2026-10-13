import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as crews from "../src/services/crews";
import * as dispatchMap from "../src/services/dispatch-map";
import * as dispatchDays from "../src/services/dispatch-days";
import { registerRouter } from "../src/routing/provider";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M17. PART OF A DAY OFF, IN THE CREW CHECK, THE MAP'S SUGGESTIONS AND THE
 * MULTI DAY REBALANCE.
 *
 * Booking and the board already read leave by the hour. These three used to
 * count any leave on a day as the whole of it. Now a person off from one to
 * five is offered the morning, a crew with somebody off in the afternoon can
 * take the morning's job, and a visit is refused only when its hours meet
 * theirs. A whole day off refuses everything, as it always did.
 *
 * Central time. Dates are a few days out so no window here has passed.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("pdl:org");
const USER = fixtureId("pdl:user");
const ZONE = "America/Chicago";
const D1 = companyToday(3);
const D2 = companyToday(4);
const at = (date: string, hour: number, minute = 0) => time.instantOfLocal(date, hour * 60 + minute, ZONE);

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const dispatcher = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["dispatcher"] as Actor["roles"] }, db: db() });

/** A routing service that answers from the straight line, so nothing here reaches a network. */
registerRouter("pdl-router", () => ({
  name: "pdl-router", keepForSeconds: 3600, maxPoints: 10,
  async matrix(request) {
    return {
      kind: "ok",
      minutes: request.sources.map((a) => request.destinations.map((b) =>
        a.lat === b.lat && a.lng === b.lng ? 0 : Math.max(1, Math.round(geo.haversineKm(a, b) * 3)))),
      meters: null,
    };
  },
}));

let customerId = "";
let yardId = "";
let ray = "";
let lee = "";
let haz = "";
let crewId = "";

async function technician(name: string, key: string, home: string | null = null): Promise<string> {
  const userId = fixtureId(`pdl:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`pdl-${key}@test.local`}) on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, home_location_id)
    values (${ORG}, ${m!.id}, ${name}, ${home}) returning id`;
  return t!.id;
}

async function place(lat: number, lng: number): Promise<string> {
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, ${`${lat},${lng}`}, 'Austin', 'TX', '78701', ${geo.formatCoordinate(lat)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
  return p!.id;
}

/** A job with one visit on a date, between these hours, optionally for somebody or for the crew. */
async function visit(date: string, from: number, to: number, o: { lng?: number; technicianId?: string; crew?: boolean; minutes?: number; order?: number } = {}) {
  const propertyId = await place(30.30, o.lng ?? -97.70);
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'Planned work') returning id`;
  const status = o.technicianId || o.crew ? "dispatched" : "unassigned";
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes, crew_id)
    values (${ORG}, ${job!.id}, ${status}::visit_status, ${at(date, from)}, ${at(date, to)}, ${o.order ?? null}, ${o.minutes ?? 60}, ${o.crew ? crewId : null}) returning id`;
  if (o.technicianId) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${v!.id}, ${o.technicianId}, true)`;
  }
  return { visitId: v!.id, jobId: job!.id };
}

/** Approved leave between two instants. */
const leave = (technicianId: string, from: Date, to: Date) => raw`
  insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
  values (${ORG}, ${technicianId}, ${from}, ${to}, true)`;
const clearLeave = () => raw`delete from public.time_off where organization_id = ${ORG}`;
/** The crew's two people are off both days, so what is asked of Ray is not answered by somebody else. */
async function crewAway(): Promise<void> {
  for (const date of [D1, D2]) {
    const d = wholeDay(date);
    await leave(lee, d.from, d.to);
    await leave(haz, d.from, d.to);
  }
}
const wholeDay = (date: string) => ({ from: time.startOfDayIn(date, ZONE), to: time.startOfDayIn(time.nextDay(date), ZONE) });

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Part Day Planning Co", slug: "part-day-planning-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Pat Planner') returning id`;
  customerId = c!.id;
  const [l] = await raw<{ id: string }[]>`insert into public.location (organization_id, name, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.75)}, 'placed', 'manual') returning id`;
  yardId = l!.id;
  ray = await technician("Ray Ortiz", "ray", yardId);
  lee = await technician("Lee Crew", "lee");
  haz = await technician("Haz Crew", "haz");
  const crew = await crews.create(owner(), { name: "Install crew" });
  crewId = crew.id;
  await crews.setMembers(owner(), { id: crewId, members: [{ technicianId: lee, isLead: true }, { technicianId: haz }] });
});
afterAll(async () => { if (raw) await raw.end(); });

run("the crew check, by the hour", () => {
  it("says who has part of the day off and does not refuse the day, when the question is about a date alone", async () => {
    await clearLeave();
    await leave(lee, at(D1, 13), at(D1, 17));
    const { jobId } = await visit(D2, 9, 10);
    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: D1 });
    expect(verdict.canTake).toBe(true);
    expect(verdict.headcount).toEqual({ onCrew: 2, availableOn: 2, offOn: 0 });
    expect(verdict.partDayOff).toEqual([{ technicianId: lee, name: "Lee Crew", hours: "1:00 PM to 5:00 PM" }]);
  });

  it("still refuses a day when everybody's leave covers the whole of the working day, even written to 23:59", async () => {
    await clearLeave();
    const d = wholeDay(D1);
    await leave(lee, d.from, d.to);
    await leave(haz, d.from, new Date(d.to.getTime() - 60_000));
    const { jobId } = await visit(D2, 9, 10);
    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: D1 });
    expect(verdict.canTake).toBe(false);
    expect(verdict.blockers.map((b) => b.code)).toContain("everybody_off");
    expect(verdict.headcount.availableOn).toBe(0);
  });

  it("reads leave from the first thing to the end of the working day as the day off", async () => {
    await clearLeave();
    await leave(lee, at(D1, 7), at(D1, 17, 30));
    await leave(haz, at(D1, 7), at(D1, 17, 30));
    const { jobId } = await visit(D2, 9, 10);
    expect((await crews.canTake(owner(), { id: crewId, jobId, on: D1 })).blockers.map((b) => b.code)).toContain("everybody_off");
  });

  it("asks about the job's own visit hours when it has one that day: the morning is theirs, the afternoon is not", async () => {
    await clearLeave();
    await leave(lee, at(D1, 13), at(D1, 17));
    await leave(haz, at(D1, 13), at(D1, 17));
    const morning = await visit(D1, 9, 11);
    const afternoon = await visit(D1, 14, 16);

    expect((await crews.canTake(owner(), { id: crewId, jobId: morning.jobId, on: D1 })).canTake).toBe(true);
    const late = await crews.canTake(owner(), { id: crewId, jobId: afternoon.jobId, on: D1 });
    expect(late.canTake).toBe(false);
    expect(late.blockers.map((b) => b.explanation).join(" "))
      .toMatch(new RegExp(`Everybody on Install crew is on approved time off on ${D1}, when that visit is\\.`));
    const list = await crews.crewsFor(owner(), { jobId: afternoon.jobId, on: D1 });
    expect(list.crews[0]!.canTake).toBe(false);

    // Assigning is the same check at the visit's own hours.
    await expect(crews.assign(owner(), { id: afternoon.visitId, crewId })).rejects.toThrow(/approved time off on .*, when that visit is/);
    await expect(crews.assign(owner(), { id: morning.visitId, crewId })).resolves.toMatchObject({ crewId });
  });

  it("refuses when only the lead is off at the visit's hours, and not when the lead is off at another time", async () => {
    await clearLeave();
    await leave(lee, at(D1, 13), at(D1, 17));
    const morning = await visit(D1, 9, 11);
    const afternoon = await visit(D1, 14, 16);
    expect((await crews.canTake(owner(), { id: crewId, jobId: morning.jobId, on: D1 })).canTake).toBe(true);
    const late = await crews.canTake(owner(), { id: crewId, jobId: afternoon.jobId, on: D1 });
    expect(late.blockers.map((b) => b.code)).toEqual(["lead_off"]);
    expect(late.headcount).toEqual({ onCrew: 2, availableOn: 1, offOn: 1 });
  });

  it("is not thrown by leave that only touches the day", async () => {
    await clearLeave();
    await leave(lee, at(D1, 0), time.startOfDayIn(D1, ZONE));
    const { jobId } = await visit(D1, 9, 11);
    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: D1 });
    expect(verdict.canTake).toBe(true);
    expect(verdict.partDayOff).toEqual([]);
  });
});

run("the map's suggestions, by the hour", () => {
  it("offers a person with the afternoon off the morning's visit, and says why not the afternoon's", async () => {
    await clearLeave();
    await crewAway();
    await raw`delete from public.visit where organization_id = ${ORG}`;
    await leave(ray, at(D1, 13), at(D1, 17));
    const morning = await visit(D1, 9, 10, { lng: -97.70 });
    const afternoon = await visit(D1, 14, 15, { lng: -97.69 });
    const result = await dispatchMap.suggestions(dispatcher(), { date: D1 });

    const first = result.suggestions.find((s) => s.visitId === morning.visitId)!;
    expect(first.technicianId).toBe(ray);
    const second = result.suggestions.find((s) => s.visitId === afternoon.visitId)!;
    expect(second.technicianId).toBeNull();
    expect(second.considered.find((c) => c.technicianId === ray)!.refused)
      .toBe(`Ray Ortiz is on approved time off from 1:00 PM to 5:00 PM on ${D1}, when that visit is.`);
  });

  it("refuses every visit to a person off the whole day, as before", async () => {
    await clearLeave();
    await crewAway();
    await raw`delete from public.visit where organization_id = ${ORG}`;
    const d = wholeDay(D1);
    await leave(ray, d.from, d.to);
    const morning = await visit(D1, 9, 10);
    const result = await dispatchMap.suggestions(dispatcher(), { date: D1 });
    const only = result.suggestions.find((s) => s.visitId === morning.visitId)!;
    expect(only.technicianId).toBeNull();
    expect(only.considered.find((c) => c.technicianId === ray)!.refused).toBe(`Ray Ortiz is on approved time off on ${D1}.`);
  });

  it("is not refused by leave that only touches the day", async () => {
    await clearLeave();
    await crewAway();
    await raw`delete from public.visit where organization_id = ${ORG}`;
    await leave(ray, at(D1, 0), time.startOfDayIn(D1, ZONE));
    const morning = await visit(D1, 9, 10);
    const result = await dispatchMap.suggestions(dispatcher(), { date: D1 });
    expect(result.suggestions.find((s) => s.visitId === morning.visitId)!.technicianId).toBe(ray);
  });
});

run("the multi day rebalance, by the hour", () => {
  /** Ray's day is five two hour jobs, which runs past the overtime allowed; one of them may be on either day. */
  async function overloaded(flexFrom: number, flexTo: number) {
    await clearLeave();
    await crewAway();
    await raw`delete from public.visit where organization_id = ${ORG}`;
    for (const [i, lng] of [-97.73, -97.71, -97.69, -97.67].entries()) {
      await visit(D1, 8, 17, { lng, technicianId: ray, minutes: 120, order: i + 1 });
    }
    const flex = await visit(D1, flexFrom, flexTo, { lng: -97.65, technicianId: ray, minutes: 120, order: 5 });
    await raw`update public.visit set movable_from = ${D1}, movable_until = ${D2} where id = ${flex.visitId}`;
    return flex;
  }
  const propose = () => dispatchDays.rebalanceDays(dispatcher(), { from: D1, days: 2 });

  it("moves a morning visit to a day the person has the afternoon off", async () => {
    const flex = await overloaded(9, 11);
    await leave(ray, at(D2, 13), at(D2, 17));
    const proposal = await propose();
    expect(proposal.dayMoves).toEqual([expect.objectContaining({ visitId: flex.visitId, fromDate: D1, toDate: D2, toTechnicianId: ray })]);
    const second = proposal.perDay.find((d) => d.date === D2)!;
    expect(second.technicians.find((t) => t.technicianId === ray)).toMatchObject({
      timeOff: true, timeOffWholeDay: false,
      timeOffHours: [{ startsAt: at(D2, 13).toISOString(), endsAt: at(D2, 17).toISOString() }],
    });
  });

  it("does not move it to a day the person is off at that hour, and says so", async () => {
    const flex = await overloaded(9, 11);
    await leave(ray, at(D2, 8), at(D2, 12));
    const proposal = await propose();
    expect(proposal.dayMoves).toEqual([]);
    expect(proposal.movable.map((m) => m.visitId)).toEqual([flex.visitId]);
  });

  it("does not move it to a day the person is off all day, as before", async () => {
    await overloaded(9, 11);
    const d = wholeDay(D2);
    await leave(ray, d.from, d.to);
    const proposal = await propose();
    expect(proposal.dayMoves).toEqual([]);
  });
});
