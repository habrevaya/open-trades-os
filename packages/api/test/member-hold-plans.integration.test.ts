import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, type Actor } from "@opentradesos/core";
import * as booking from "../src/services/booking";
import * as crews from "../src/services/crews";
import * as dispatchMap from "../src/services/dispatch-map";
import * as dispatchDays from "../src/services/dispatch-days";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * THE SHARE KEPT FOR MEMBERS, ON A CREW'S LANE AND IN THE REBALANCES
 *
 * Four technicians and a four hour morning window of one hour jobs, a
 * quarter of each person's window held for members until two days before.
 * Ray works near the yard; Sam is based out east; Dana and Lee start
 * somewhere not on the map, so the rebalances leave them out, but they count
 * in the window as a whole. Ray and Sam are the North crew, Dana and Lee the
 * South crew. On each day under test Ray already has three strangers' visits
 * in the morning, so his last hour is the one kept for members.
 *
 * A stranger's visit dropped on the North crew is refused, naming Ray and the
 * South crew, until the dispatcher sends anyway. The single day rebalance
 * gives a stranger's waiting visit beside Ray to Sam instead, leaves it
 * waiting with the hold in words when Sam is off, and refuses a payload that
 * puts it on Ray. The several day rebalance does not move a stranger's visit
 * onto Ray's day for the same reason, and refuses a payload that does.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("mhp:org");
const USER = fixtureId("mhp:user");
const ZONE = "America/Chicago";
const NEAR = -97.74;

let raw: postgres.Sql;
const as = (roles: string[], idempotencyKey?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: testDb(url!),
  ...(idempotencyKey ? { idempotencyKey } : {}),
});
const dispatcher = (idempotencyKey?: string) => as(["dispatcher"], idempotencyKey);
const owner = () => as(["owner"]);

const tech: Record<string, string> = {};
let north = "";
let south = "";
let strangerId = "";
let memberId = "";

async function location(name: string, lng: number | null) {
  const [l] = await raw<{ id: string }[]>`insert into public.location (organization_id, name, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, ${name}, '1 Yard Rd', 'Austin', 'TX', '78701',
            ${lng === null ? null : geo.formatCoordinate(30.30)}, ${lng === null ? null : geo.formatCoordinate(lng)},
            ${lng === null ? null : "placed"}, ${lng === null ? null : "manual"}) returning id`;
  return l!.id;
}

async function visitFor(customerId: string, date: string, technicianId: string | null, lng = NEAR) {
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
    values (${ORG}, 'A house', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${p!.id}, 'scheduled', 'Tune up') returning id`;
  const [v] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${job!.id}, ${technicianId ? "dispatched" : "unassigned"}::visit_status,
            ${booking.windowStart(date, "08:00", ZONE)}, ${booking.windowStart(date, "12:00", ZONE)}, 60) returning id`;
  if (technicianId) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
              values (${ORG}, ${v!.id}, ${technicianId}, true)`;
  }
  return v!.id;
}

/** Ray's morning with three strangers on it, so his last hour is the one kept for members. */
async function rayAlmostFull(date: string) {
  for (let i = 0; i < 3; i += 1) await visitFor(strangerId, date, tech["Ray Ortiz"]!);
}

async function off(technicianId: string, date: string) {
  await raw`insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
    values (${ORG}, ${technicianId}, ${booking.windowStart(date, "00:00", ZONE)}, ${booking.windowStart(date, "23:59", ZONE)}, true)`;
}

const assignedTo = async (visitId: string) =>
  (await raw<{ technician_id: string }[]>`select technician_id from public.visit_assignment where visit_id = ${visitId}`)
    .map((r) => r.technician_id);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Member Plans Air", slug: "member-hold-plans" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const yard = await location("Yard", -97.75);
  const east = await location("East yard", -97.60);
  const nowhere = await location("Somewhere", null);
  for (const [name, home] of [["Ray Ortiz", yard], ["Sam Diaz", east], ["Dana Lee", nowhere], ["Lee Park", nowhere]] as const) {
    const userId = fixtureId(`mhp:tech:${name}`);
    await raw`insert into public."user" (id, email) values (${userId}, ${`mhp-${name.split(" ")[0]}@test.local`}) on conflict (id) do nothing`;
    const [m] = await raw<{ id: string }[]>`
      insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
    const [t] = await raw<{ id: string }[]>`
      insert into public.technician (organization_id, membership_id, display_name, home_location_id)
      values (${ORG}, ${m!.id}, ${name}, ${home}) returning id`;
    tech[name] = t!.id;
  }
  const crew = async (name: string, people: string[]) => {
    const [c] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name, home_location_id) values (${ORG}, ${name}, ${yard}) returning id`;
    for (const [i, p] of people.entries()) {
      await raw`insert into public.crew_member (organization_id, crew_id, technician_id, is_lead) values (${ORG}, ${c!.id}, ${p}, ${i === 0})`;
    }
    return c!.id;
  };
  north = await crew("North crew", [tech["Ray Ortiz"]!, tech["Sam Diaz"]!]);
  south = await crew("South crew", [tech["Dana Lee"]!, tech["Lee Park"]!]);
  for (let day = 0; day < 7; day += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at) values (${ORG}, ${day}, '07:00', '18:00')`;
  }
  await raw`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week)
    values (${ORG}, 'Morning', '08:00', '12:00', ${[0, 1, 2, 3, 4, 5, 6]})`;
  const [plan] = await raw<{ id: string }[]>`insert into public.agreement_plan (organization_id, name, price, priority_dispatch)
    values (${ORG}, 'Comfort Club', 180, true) returning id`;
  const [member] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Mel Member') returning id`;
  memberId = member!.id;
  await raw`insert into public.agreement (organization_id, plan_id, customer_id, status, started_on, price, billing_frequency)
    values (${ORG}, ${plan!.id}, ${memberId}, 'active', ${companyToday(-30)}, 180, 'annual')`;
  const [stranger] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Sid Stranger') returning id`;
  strangerId = stranger!.id;
  await booking.setMemberHold(owner(), { reservePercent: 25, releaseHours: 48 });
});

afterAll(async () => { if (raw) await raw.end(); });

run("a visit dropped on a crew's lane", () => {
  it("is refused when it would take one of the crew's people's time kept for members, naming the crew that could take it", async () => {
    const date = companyToday(5);
    await rayAlmostFull(date);
    const visitId = await visitFor(strangerId, date, null);
    await expect(crews.assign(dispatcher(), { id: visitId, crewId: north })).rejects.toMatchObject({ memberHoldRefused: true });
    await expect(crews.assign(dispatcher(), { id: visitId, crewId: north })).rejects.toThrow(
      `North crew would take Ray Ortiz's time in the Morning window on ${date}, which is kept for members, `
      + "and this customer is not a member there that day. South crew could take it instead. "
      + "Or send anyway to give them a member's place.",
    );
    const [still] = await raw<{ crew_id: string | null }[]>`select crew_id from public.visit where id = ${visitId}`;
    expect(still!.crew_id).toBeNull();

    /** The South crew takes it without being asked. */
    await crews.assign(dispatcher(), { id: visitId, crewId: south });
    const [moved] = await raw<{ crew_id: string }[]>`select crew_id from public.visit where id = ${visitId}`;
    expect(moved!.crew_id).toBe(south);
  });

  it("goes on when the dispatcher sends anyway, with each person whose share it took on the record", async () => {
    const date = companyToday(6);
    await rayAlmostFull(date);
    const visitId = await visitFor(strangerId, date, null);
    await crews.assign(dispatcher(), { id: visitId, crewId: north, intoMemberHold: true });
    const [moved] = await raw<{ crew_id: string }[]>`select crew_id from public.visit where id = ${visitId}`;
    expect(moved!.crew_id).toBe(north);
    const rows = await raw<{ actor_user_id: string; after: { technicianId: string; date: string; window: string; crewId: string } }[]>`
      select actor_user_id, after from public.audit_log
      where organization_id = ${ORG} and action = 'visit.assigned_into_member_hold' and entity_id = ${visitId}`;
    expect(rows).toEqual([{
      actor_user_id: USER, after: { technicianId: tech["Ray Ortiz"], date, window: "Morning", crewId: north },
    }]);
  });

  it("puts a member's visit on the crew without asking", async () => {
    const date = companyToday(7);
    await rayAlmostFull(date);
    const visitId = await visitFor(memberId, date, null);
    await crews.assign(dispatcher(), { id: visitId, crewId: north });
    const [moved] = await raw<{ crew_id: string }[]>`select crew_id from public.visit where id = ${visitId}`;
    expect(moved!.crew_id).toBe(north);
  });
});

run("rebalancing one day", () => {
  it("gives a stranger's waiting visit to somebody with room outside the hold, not to the person nearest it", async () => {
    const date = companyToday(8);
    await rayAlmostFull(date);
    const visitId = await visitFor(strangerId, date, null);

    /** With nothing held, Ray is nearest and takes it. */
    await booking.setMemberHold(owner(), { reservePercent: 0, releaseHours: 48 });
    const free = await dispatchMap.rebalance(dispatcher(), { date });
    expect(free.moves.find((m) => m.visitId === visitId)?.toTechnicianId).toBe(tech["Ray Ortiz"]);

    await booking.setMemberHold(owner(), { reservePercent: 25, releaseHours: 48 });
    const held = await dispatchMap.rebalance(dispatcher(), { date });
    expect(held.moves.find((m) => m.visitId === visitId)).toMatchObject({ toTechnicianId: tech["Sam Diaz"], toName: "Sam Diaz" });

    /** A payload that puts it on Ray anyway is refused whole, in words, and nothing moves. */
    await expect(dispatchMap.applyRebalance(dispatcher(`mhp-ray-${date}`), {
      date, basis: held.basis, moves: [{ visitId, technicianId: tech["Ray Ortiz"]! }], orders: [],
    })).rejects.toThrow(
      `Ray Ortiz's time in the Morning window on ${date} is kept for members, and Sid Stranger is not a member there that day. Propose it again.`,
    );
    expect(await assignedTo(visitId)).toEqual([]);

    /** What the proposal said goes through. */
    await dispatchMap.applyRebalance(dispatcher(`mhp-apply-${date}`), {
      date, basis: held.basis, moves: held.moveAssignments, orders: held.apply, crewOrders: held.crewOrders,
    });
    expect(await assignedTo(visitId)).toEqual([tech["Sam Diaz"]]);
  });

  it("leaves it waiting, with the hold in words, when nobody else can take it", async () => {
    const date = companyToday(9);
    await rayAlmostFull(date);
    await off(tech["Sam Diaz"]!, date);
    const visitId = await visitFor(strangerId, date, null);
    const proposal = await dispatchMap.rebalance(dispatcher(), { date });
    expect(proposal.moves.find((m) => m.visitId === visitId)).toBeUndefined();
    expect(proposal.unplaced.find((u) => u.visitId === visitId)?.reason).toBe(
      `Ray Ortiz's time in the Morning window on ${date} is kept for members, and Sid Stranger is not a member there that day.`,
    );

    /** A member's visit in the same place goes to Ray. */
    const theirs = await visitFor(memberId, date, null);
    const again = await dispatchMap.rebalance(dispatcher(), { date });
    expect(again.moves.find((m) => m.visitId === theirs)?.toTechnicianId).toBe(tech["Ray Ortiz"]);
  });
});

run("rebalancing several days", () => {
  it("does not move a stranger's visit onto a day where the person's time is kept for members, and refuses a payload that does", async () => {
    /**
     * The visit is Sam's on the first day, and Sam is off both days, so it has
     * to go somewhere; Ray is off the first day, and his second day's last
     * hour is kept for members.
     */
    const first = companyToday(11);
    const second = companyToday(12);
    const visitId = await visitFor(strangerId, first, tech["Sam Diaz"]!);
    await raw`update public.visit set movable_from = ${first}, movable_until = ${second} where id = ${visitId}`;
    await off(tech["Sam Diaz"]!, first);
    await off(tech["Sam Diaz"]!, second);
    await off(tech["Ray Ortiz"]!, first);
    await rayAlmostFull(second);

    await booking.setMemberHold(owner(), { reservePercent: 0, releaseHours: 48 });
    const free = await dispatchDays.rebalanceDays(dispatcher(), { from: first, days: 2 });
    expect(free.dayMoves.map((m) => [m.visitId, m.toDate, m.toTechnicianId])).toEqual([[visitId, second, tech["Ray Ortiz"]]]);

    await booking.setMemberHold(owner(), { reservePercent: 25, releaseHours: 48 });
    const held = await dispatchDays.rebalanceDays(dispatcher(), { from: first, days: 2 });
    expect(held.dayMoves).toEqual([]);

    await expect(dispatchDays.applyRebalanceDays(dispatcher(`mhp-days-${first}`), {
      from: first, days: 2, basis: free.basis, ...free.apply,
    })).rejects.toThrow(
      `Ray Ortiz's time in the Morning window on ${second} is kept for members, and Sid Stranger is not a member there that day. Propose it again.`,
    );
    expect(await assignedTo(visitId)).toEqual([tech["Sam Diaz"]]);
  });
});
