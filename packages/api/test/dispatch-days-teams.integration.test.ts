import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as dispatchDays from "../src/services/dispatch-days";
import * as dispatchMap from "../src/services/dispatch-map";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A VISIT WITH SEVERAL PEOPLE ON IT, REBALANCED ACROSS DAYS
 *
 * Ray's Tuesday is four two hour jobs locked to him and a two hour job he
 * does with Dana, which together run past the overtime allowed. Dana's
 * Tuesday is that one job. Wednesday is empty for both, and the two person
 * job's customer agreed to either day. The rebalance should count that job
 * on both their days, move it to Wednesday with both of them, never split
 * them, never move it while it is under way, never to a day one of them is
 * off for its hours, and apply it with both still on it and both told.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("days-teams:org");
const USER = fixtureId("days-teams:user");
const ZONE = "America/Chicago";
const TUE = companyToday(3);
const WED = companyToday(4);
const at = (day: string, hour: number) => time.instantOfLocal(day, hour * 60, ZONE);

let raw: postgres.Sql;
const dispatcher = (idempotencyKey?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["dispatcher"] as Actor["roles"] }, db: testDb(url!),
  ...(idempotencyKey ? { idempotencyKey } : {}),
});

let ray = "";
let dana = "";
let pair = { visitId: "", jobId: "" };

async function technician(name: string, yardId: string) {
  const userId = fixtureId(`days-teams:tech:${name}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`days-teams-${name.split(" ")[0]!.toLowerCase()}@test.local`}) on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, home_location_id)
    values (${ORG}, ${m!.id}, ${name}, ${yardId}) returning id`;
  return t!.id;
}

async function visit(order: number, lng: number, people: string[], locked: boolean) {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', ${`Customer ${order}`}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, ${`${order} Main St`}, 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${c!.id}, ${p!.id})`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${order}, ${c!.id}, ${p!.id}, 'scheduled', 'Two hour job') returning id`;
  const [v] = await raw<{ id: string }[]>`insert into public.visit
      (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes, dispatch_locked)
    values (${ORG}, ${job!.id}, 'dispatched', ${at(TUE, 8)}, ${at(TUE, 17)}, ${order}, 120, ${locked}) returning id`;
  for (const [i, technicianId] of people.entries()) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
      values (${ORG}, ${v!.id}, ${technicianId}, ${i === 0})`;
  }
  return { visitId: v!.id, jobId: job!.id };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Two Hands Co", slug: "two-hands-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered) values (${ORG}, '+15125559945', 'main', true)`;
  const [l] = await raw<{ id: string }[]>`insert into public.location (organization_id, name, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.75)}, 'placed', 'manual') returning id`;
  ray = await technician("Ray Ortiz", l!.id);
  dana = await technician("Dana Lee", l!.id);
  /** Locked to Ray, so the only way off his overfull Tuesday is the job he shares. */
  for (const [i, lng] of [-97.73, -97.71, -97.69, -97.67].entries()) await visit(i + 1, lng, [ray], true);
  pair = await visit(5, -97.65, [ray, dana], false);
  await raw`update public.visit set movable_from = ${TUE}, movable_until = ${WED} where id = ${pair.visitId}`;
});
afterAll(async () => { if (raw) await raw.end(); });

run("a visit with several people on it, across days", () => {
  it("counts it on every one of their days, and on the single day leaves it with both", async () => {
    const day = await dispatchMap.rebalance(dispatcher(), { date: TUE });
    const of = (id: string) => day.technicians.find((t) => t.technicianId === id)!;
    expect(of(dana).before.order).toEqual([pair.visitId]);
    expect(of(ray).before.order).toContain(pair.visitId);
    expect(day.moves.map((m) => m.visitId)).not.toContain(pair.visitId);
    expect(day.untouched).not.toContain(pair.visitId);
  });

  it("moves it to Wednesday with both of them, never one", async () => {
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    expect(proposal.dayMoves).toEqual([expect.objectContaining({
      visitId: pair.visitId, fromDate: TUE, toDate: WED,
      toTechnicianId: ray, toTechnicianIds: [ray, dana], toName: "Ray Ortiz and Dana Lee", fromName: "Ray Ortiz and Dana Lee",
    })]);
    expect(proposal.apply.dayMoves).toEqual([{ visitId: pair.visitId, toDate: WED, technicianIds: [ray, dana] }]);
    expect(proposal.visits.find((v) => v.visitId === pair.visitId)!.team).toEqual([ray, dana]);
    const tuesday = proposal.perDay.find((d) => d.date === TUE)!;
    const wednesday = proposal.perDay.find((d) => d.date === WED)!;
    const on = (d: typeof tuesday, id: string) => d.technicians.find((t) => t.technicianId === id)!;
    expect(on(tuesday, dana).before.order).toEqual([pair.visitId]);
    expect(on(tuesday, dana).after.order).toEqual([]);
    expect(on(tuesday, ray).before.overLimitMinutes).toBeGreaterThan(0);
    expect(on(tuesday, ray).after.overLimitMinutes).toBe(0);
    expect(on(wednesday, ray).after.order).toEqual([pair.visitId]);
    expect(on(wednesday, dana).after.order).toEqual([pair.visitId]);
    /** One visit on Wednesday, though it is on two days. */
    expect([wednesday.visitsBefore, wednesday.visitsAfter]).toEqual([0, 1]);
  });

  it("leaves it where it is while it is under way", async () => {
    await raw`update public.visit set status = 'working', arrived_at = ${at(TUE, 9)} where id = ${pair.visitId}`;
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    expect(proposal.dayMoves).toEqual([]);
    expect(proposal.movable.map((m) => m.visitId)).not.toContain(pair.visitId);
    await raw`update public.visit set status = 'dispatched', arrived_at = null where id = ${pair.visitId}`;
  });

  it("does not move it to a day one of them is off for its hours", async () => {
    const [leave] = await raw<{ id: string }[]>`insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
      values (${ORG}, ${dana}, ${at(WED, 8)}, ${at(WED, 12)}, true) returning id`;
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    expect(proposal.dayMoves).toEqual([]);
    await raw`delete from public.time_off where id = ${leave!.id}`;
  });

  it("refuses an apply that would split them, or that a leave approved since has made wrong", async () => {
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    await expect(dispatchDays.applyRebalanceDays(dispatcher("teams-split"), {
      from: TUE, days: 2, basis: proposal.basis, ...proposal.apply,
      dayMoves: [{ visitId: pair.visitId, toDate: WED, technicianId: ray }],
    })).rejects.toThrow(/only with the people already on it/);
    await expect(dispatchDays.applyRebalanceDays(dispatcher("teams-swap"), {
      from: TUE, days: 2, basis: proposal.basis, ...proposal.apply,
      dayMoves: [{ visitId: pair.visitId, toDate: WED, technicianIds: [dana, ray] }],
    })).rejects.toThrow(/only with the people already on it/);

    const [leave] = await raw<{ id: string }[]>`insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
      values (${ORG}, ${dana}, ${at(WED, 13)}, ${at(WED, 15)}, true) returning id`;
    await expect(dispatchDays.applyRebalanceDays(dispatcher("teams-leave"), {
      from: TUE, days: 2, basis: proposal.basis, ...proposal.apply,
    })).rejects.toThrow(/Dana Lee is on approved time off/);
    await raw`delete from public.time_off where id = ${leave!.id}`;
    const [still] = await raw<{ window_start: Date }[]>`select window_start from public.visit where id = ${pair.visitId}`;
    expect(still!.window_start.toISOString()).toBe(at(TUE, 8).toISOString());
  });

  it("applies it with both still on it, Ray leading, and tells both and the customer", async () => {
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    const result = await dispatchDays.applyRebalanceDays(dispatcher("teams-apply"), {
      from: TUE, days: 2, basis: proposal.basis, ...proposal.apply,
    });
    expect(result.movedDays).toBe(1);
    const [moved] = await raw<{ window_start: Date }[]>`select window_start from public.visit where id = ${pair.visitId}`;
    expect(moved!.window_start.toISOString()).toBe(at(WED, 8).toISOString());
    const people = await raw<{ technician_id: string; is_lead: boolean }[]>`
      select technician_id, is_lead from public.visit_assignment where visit_id = ${pair.visitId} order by is_lead desc`;
    expect(people.map((p) => [p.technician_id, p.is_lead])).toEqual([[ray, true], [dana, false]]);
    const [notice] = await raw<{ payload: { technicianIds: string[] } }[]>`select payload from public.domain_event
      where organization_id = ${ORG} and entity_id = ${pair.visitId} and name = 'visit.rescheduled'`;
    expect(new Set(notice!.payload.technicianIds)).toEqual(new Set([ray, dana]));
    const [event] = await raw<{ kind: string }[]>`select kind from public.portal_event where job_id = ${pair.jobId}`;
    expect(event!.kind).toBe("rescheduled");
  });
});
