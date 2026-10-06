import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as dispatchDays from "../src/services/dispatch-days";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * CREWS ACROSS SEVERAL DAYS, AND ONLINE BOOKING'S CEILING
 *
 * The install crew's Tuesday is five two hour jobs, which runs past the
 * overtime allowed; its Wednesday is empty. One customer agreed to either
 * day. The multi day rebalance should plan the crew like a person: move
 * that visit to the crew's Wednesday, never to Ray (who is free but is one
 * person, not the crew), and apply it through the crew's own assignment,
 * telling the crew. And when Wednesday's window is already full of online
 * bookings for that work, it should not move it at all.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("days-crews:org");
const USER = fixtureId("days-crews:user");
const ZONE = "America/Chicago";
const TUE = companyToday(3);
const WED = companyToday(4);
const at = (day: string, hour: number) => time.instantOfLocal(day, hour * 60, ZONE);

let raw: postgres.Sql;
const dispatcher = (idempotencyKey?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["dispatcher"] as Actor["roles"] }, db: testDb(url!),
  ...(idempotencyKey ? { idempotencyKey } : {}),
});

let crewId = "";
let ray = "";
let jobTypeId = "";
let windowId = "";
let flex = { visitId: "", jobId: "" };
const members: string[] = [];

async function technician(name: string, yardId: string) {
  const userId = fixtureId(`days-crews:tech:${name}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`days-crews-${name}@test.local`}) on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, home_location_id)
    values (${ORG}, ${m!.id}, ${name}, ${yardId}) returning id`;
  return t!.id;
}

async function crewVisit(lng: number, order: number) {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', ${`Customer ${order}`}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, ${`${order} Fence Rd`}, 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${c!.id}, ${p!.id})`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${order}, ${c!.id}, ${p!.id}, ${jobTypeId}, 'scheduled', 'Fence section') returning id`;
  const [v] = await raw<{ id: string }[]>`insert into public.visit
      (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes, crew_id)
    values (${ORG}, ${job!.id}, 'dispatched', ${at(TUE, 8)}, ${at(TUE, 17)}, ${order}, 120, ${crewId}) returning id`;
  return { visitId: v!.id, jobId: job!.id };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Fence Crew Co", slug: "fence-crew-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered) values (${ORG}, '+15125559944', 'main', true)`;
  const [l] = await raw<{ id: string }[]>`insert into public.location (organization_id, name, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.75)}, 'placed', 'manual') returning id`;
  ray = await technician("Ray", l!.id);
  members.push(await technician("Sam", l!.id), await technician("Lee", l!.id));
  const [crew] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name, home_location_id) values (${ORG}, 'Install crew', ${l!.id}) returning id`;
  crewId = crew!.id;
  await raw`insert into public.crew_member (organization_id, crew_id, technician_id, is_lead)
    values (${ORG}, ${crewId}, ${members[0]!}, true), (${ORG}, ${crewId}, ${members[1]!}, false)`;
  const [t] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, default_duration_minutes) values (${ORG}, 'Fence section', 120) returning id`;
  jobTypeId = t!.id;
  const [w] = await raw<{ id: string }[]>`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week)
    values (${ORG}, 'All day', '08:00', '17:00', ${[0, 1, 2, 3, 4, 5, 6]}) returning id`;
  windowId = w!.id;

  for (const [i, lng] of [-97.73, -97.71, -97.69, -97.67].entries()) await crewVisit(lng, i + 1);
  flex = await crewVisit(-97.65, 5);
  await raw`update public.visit set movable_from = ${TUE}, movable_until = ${WED} where id = ${flex.visitId}`;
});
afterAll(async () => { if (raw) await raw.end(); });

run("a crew rebalanced across days", () => {
  it("leaves the visit where it is when the window it would move into is full online", async () => {
    const [service] = await raw<{ id: string }[]>`insert into public.bookable_service
        (organization_id, job_type_id, public_name, max_per_window, min_notice_hours, max_advance_days)
      values (${ORG}, ${jobTypeId}, 'Fence section', 1, 24, 60) returning id`;
    const [booked] = await raw<{ id: string }[]>`insert into public.booking_request
        (organization_id, bookable_service_id, status, contact_name, requested_date, arrival_window_id)
      values (${ORG}, ${service!.id}, 'confirmed', 'Somebody online', ${WED}, ${windowId}) returning id`;
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    expect(proposal.movable.map((m) => m.visitId)).toEqual([flex.visitId]);
    expect(proposal.dayMoves).toEqual([]);

    /** Room for one more, and it moves. */
    await raw`delete from public.booking_request where id = ${booked!.id}`;
    const roomy = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    expect(roomy.dayMoves.map((m) => m.visitId)).toEqual([flex.visitId]);

    /** And an apply made after the window filled again is refused rather than overfilling it. */
    await raw`insert into public.booking_request (organization_id, bookable_service_id, status, contact_name, requested_date, arrival_window_id)
      values (${ORG}, ${service!.id}, 'pending', 'Somebody else online', ${WED}, ${windowId})`;
    await expect(dispatchDays.applyRebalanceDays(dispatcher("crew-days-full"), {
      from: TUE, days: 2, basis: roomy.basis, ...roomy.apply,
    })).rejects.toThrow(/past what you take online/);
    await raw`delete from public.booking_request where organization_id = ${ORG}`;
    await raw`delete from public.bookable_service where organization_id = ${ORG}`;
  });

  it("plans the crew like a person, moves its work only to a crew, and shows its days", async () => {
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    expect(proposal.dayMoves).toEqual([expect.objectContaining({
      visitId: flex.visitId, fromDate: TUE, toDate: WED,
      fromCrewId: crewId, fromTechnicianId: null, toCrewId: crewId, toTechnicianId: null, toName: "Install crew",
    })]);
    expect(proposal.apply.dayMoves).toEqual([{ visitId: flex.visitId, toDate: WED, crewId }]);
    /** Ray is free all week and still takes none of it: crew work goes to a crew. */
    expect(proposal.moves.every((m) => m.toCrewId === crewId)).toBe(true);
    const tuesday = proposal.perDay.find((d) => d.date === TUE)!;
    const crewTuesday = tuesday.crews.find((c) => c.crewId === crewId)!;
    expect(crewTuesday.before.overLimitMinutes).toBeGreaterThan(0);
    expect(crewTuesday.after.order).not.toContain(flex.visitId);
    expect(tuesday.technicians.find((t) => t.technicianId === ray)!.after.order).toEqual([]);
  });

  it("applies it through the crew's assignment and tells the crew and the customer", async () => {
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    const result = await dispatchDays.applyRebalanceDays(dispatcher("crew-days-apply"), {
      from: TUE, days: 2, basis: proposal.basis, ...proposal.apply,
    });
    expect(result.movedDays).toBe(1);
    const [moved] = await raw<{ window_start: Date; crew_id: string }[]>`select window_start, crew_id from public.visit where id = ${flex.visitId}`;
    expect(moved!.window_start.toISOString()).toBe(at(WED, 8).toISOString());
    expect(moved!.crew_id).toBe(crewId);
    expect(await raw`select id from public.visit_assignment where visit_id = ${flex.visitId}`).toHaveLength(0);
    const [notice] = await raw<{ payload: { technicianIds: string[] } }[]>`select payload from public.domain_event
      where organization_id = ${ORG} and entity_id = ${flex.visitId} and name = 'visit.rescheduled'`;
    expect(new Set(notice!.payload.technicianIds)).toEqual(new Set(members));
    const [event] = await raw`select kind from public.portal_event where job_id = ${flex.jobId}`;
    expect(event!.kind).toBe("rescheduled");
  });

  it("refuses to hand crew work to one person through the plan", async () => {
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    await expect(dispatchDays.applyRebalanceDays(dispatcher("crew-days-both"), {
      from: TUE, days: 2, basis: proposal.basis,
      dayMoves: [], moves: [{ visitId: flex.visitId, technicianId: ray, crewId }], orders: [],
    })).rejects.toThrow(/one person or one crew/);
  });
});
