import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as dispatchMap from "../src/services/dispatch-map";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * "REBALANCE THE DAY" PLANS CREWS BESIDE PEOPLE
 *
 * The west crew is based in the west yard and has been given a fence job on
 * the far east side, beside the east crew's yard; the east crew has nothing
 * today. Ray, one person, is free and based east too. The single day
 * rebalance should hand the east job to the east crew (never to Ray, who is
 * one person and not a crew), refuse it to the east crew when its people are
 * off at those hours, and apply it through the crew's own assignment with the
 * crew's day in its new order.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("rebalance-crews:org");
const USER = fixtureId("rebalance-crews:user");
const ZONE = "America/Chicago";
const DAY = companyToday(5);
const at = (day: string, hour: number) => time.instantOfLocal(day, hour * 60, ZONE);

let raw: postgres.Sql;
const dispatcher = (idempotencyKey?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["dispatcher"] as Actor["roles"] }, db: testDb(url!),
  ...(idempotencyKey ? { idempotencyKey } : {}),
});

let west = "";
let east = "";
let ray = "";
const eastPeople: string[] = [];
let near = { visitId: "", jobId: "" };
let far = { visitId: "", jobId: "" };

async function yard(name: string, lng: number) {
  const [l] = await raw<{ id: string }[]>`insert into public.location (organization_id, name, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, ${name}, '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(lng)}, 'placed', 'manual') returning id`;
  return l!.id;
}

async function technician(name: string, yardId: string) {
  const userId = fixtureId(`rebalance-crews:tech:${name}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`rebalance-crews-${name}@test.local`}) on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, home_location_id)
    values (${ORG}, ${m!.id}, ${name}, ${yardId}) returning id`;
  return t!.id;
}

async function crew(name: string, yardId: string, people: string[]) {
  const [c] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name, home_location_id) values (${ORG}, ${name}, ${yardId}) returning id`;
  for (const [i, p] of people.entries()) {
    await raw`insert into public.crew_member (organization_id, crew_id, technician_id, is_lead) values (${ORG}, ${c!.id}, ${p}, ${i === 0})`;
  }
  return c!.id;
}

async function crewVisit(order: number, lng: number, crewId: string) {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', ${`Fence ${order}`}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, ${`${order} Fence Rd`}, 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${c!.id}, ${p!.id})`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${order}, ${c!.id}, ${p!.id}, 'scheduled', 'Fence section') returning id`;
  const [v] = await raw<{ id: string }[]>`insert into public.visit
      (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes, crew_id)
    values (${ORG}, ${job!.id}, 'dispatched', ${at(DAY, 8)}, ${at(DAY, 17)}, ${order}, 120, ${crewId}) returning id`;
  return { visitId: v!.id, jobId: job!.id };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Two Yards Fencing", slug: "two-yards-fencing" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered) values (${ORG}, '+15125559946', 'main', true)`;
  const westYard = await yard("West yard", -97.95);
  const eastYard = await yard("East yard", -97.55);
  ray = await technician("Ray", eastYard);
  const westPeople = [await technician("Wes", westYard), await technician("Wynn", westYard)];
  eastPeople.push(await technician("Eve", eastYard), await technician("Ezra", eastYard));
  west = await crew("West crew", westYard, westPeople);
  east = await crew("East crew", eastYard, eastPeople);
  near = await crewVisit(1, -97.94, west);
  far = await crewVisit(2, -97.56, west);
});
afterAll(async () => { if (raw) await raw.end(); });

run("the single day rebalance, with crews", () => {
  it("hands the far job to the crew based beside it, never to one person", async () => {
    const proposal = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    expect(proposal.moves).toEqual([expect.objectContaining({
      visitId: far.visitId, fromCrewId: west, fromTechnicianId: null, toCrewId: east, toTechnicianId: null,
      fromName: "West crew", toName: "East crew",
    })]);
    expect(proposal.moveAssignments).toEqual([{ visitId: far.visitId, crewId: east }]);
    const of = (id: string) => proposal.crews.find((c) => c.crewId === id)!;
    expect(of(west).before.order).toEqual([near.visitId, far.visitId]);
    expect(of(west).after.order).toEqual([near.visitId]);
    expect(of(east).after.order).toEqual([far.visitId]);
    expect(proposal.driveAfterMinutes).toBeLessThan(proposal.driveBeforeMinutes);
    expect(proposal.technicians.find((t) => t.technicianId === ray)!.after.order).toEqual([]);
    expect(proposal.untouched).toEqual([]);
  });

  it("does not hand it to a crew whose people are all off at those hours", async () => {
    const leave = await raw<{ id: string }[]>`insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
      values (${ORG}, ${eastPeople[0]!}, ${at(DAY, 7)}, ${at(DAY, 18)}, true),
             (${ORG}, ${eastPeople[1]!}, ${at(DAY, 7)}, ${at(DAY, 18)}, true) returning id`;
    const proposal = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    expect(proposal.moves).toEqual([]);
    await raw`delete from public.time_off where id in ${raw(leave.map((l) => l.id))}`;
  });

  it("refuses to move a crew's work to a person and a crew at once", async () => {
    const proposal = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    await expect(dispatchMap.applyRebalance(dispatcher("crews-both"), {
      date: DAY, basis: proposal.basis, moves: [{ visitId: far.visitId, technicianId: ray, crewId: east }], orders: [],
    })).rejects.toThrow(/one person or one crew/);
  });

  it("applies it through the crew's own assignment, with each crew's day in order", async () => {
    const proposal = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    const result = await dispatchMap.applyRebalance(dispatcher("crews-apply"), {
      date: DAY, basis: proposal.basis, moves: proposal.moveAssignments, orders: proposal.apply, crewOrders: proposal.crewOrders,
    });
    expect(result.moved).toBe(1);
    const [moved] = await raw<{ crew_id: string; route_order: number }[]>`select crew_id, route_order from public.visit where id = ${far.visitId}`;
    expect(moved).toEqual({ crew_id: east, route_order: 1 });
    expect(await raw`select id from public.visit_assignment where visit_id = ${far.visitId}`).toHaveLength(0);
    /** The east crew's people hear it is theirs. */
    const [notice] = await raw<{ payload: { technicianIds: string[] } }[]>`select payload from public.domain_event
      where organization_id = ${ORG} and entity_id = ${far.visitId} and name = 'visit.assigned'`;
    expect(new Set(notice!.payload.technicianIds)).toEqual(new Set(eastPeople));
    const again = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    expect(again.changed).toBe(false);
  });
});
