import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as dispatchDays from "../src/services/dispatch-days";
import * as serviceRoutes from "../src/services/routes";
import { registerRouter } from "../src/routing/provider";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * SEVERAL DAYS REBALANCED, AND A ROUTE'S DENSITY BY ROAD
 *
 * Ray's Tuesday is five two hour jobs, which runs past the overtime the
 * company allows; his Wednesday is empty. One of those customers agreed to
 * either day, and another named Wednesday as a day that suits them but has
 * a job somebody else must do. The multi day rebalance should move the
 * agreed visit to Wednesday and nothing else, change nothing until a person
 * applies it, tell the customer through the visit change path when they do,
 * and refuse a move the customer did not agree to even when asked for it.
 *
 * And a route template with no declared drive time, whose density is asked
 * with a fake routing service connected: by road, said so.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("days:org");
const USER = fixtureId("days:user");
const ZONE = "America/Chicago";
const TUE = companyToday(3);
const WED = companyToday(4);
const at = (day: string, hour: number) => time.instantOfLocal(day, hour * 60, ZONE);
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], idempotencyKey?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(idempotencyKey ? { idempotencyKey } : {}),
});
const owner = (key?: string) => as(["owner"], key);
const dispatcher = (key?: string) => as(["dispatcher"], key);

/** A routing service that answers from the straight line at a fixed speed. */
registerRouter("days-router", () => ({
  name: "days-router",
  keepForSeconds: 3600,
  maxPoints: 10,
  async matrix(request) {
    return {
      kind: "ok",
      minutes: request.sources.map((a) => request.destinations.map((b) =>
        a.lat === b.lat && a.lng === b.lng ? 0 : Math.max(1, Math.round(geo.haversineKm(a, b) * 3)))),
      meters: null,
    };
  },
}));

let ray = "";
let yardId = "";

async function customer(name: string, preferredDays: number[] = []) {
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, preferred_days)
    values (${ORG}, 'residential', ${name}, ${raw.json(preferredDays as never)}) returning id`;
  return c!.id;
}

async function property(customerId: string, lat: number, lng: number) {
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code,
                                 latitude, longitude, location_precision, location_source)
    values (${ORG}, ${`${lat},${lng}`}, 'Austin', 'TX', '78701',
            ${geo.formatCoordinate(lat)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
  return p!.id;
}

async function visit(day: string, customerId: string, lng: number, order: number, technicianId: string | null = null) {
  const propertyId = await property(customerId, 30.30, lng);
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'Two hour job') returning id`;
  const [v] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes)
    values (${ORG}, ${job!.id}, ${technicianId ? "dispatched" : "unassigned"}::visit_status,
            ${at(day, 8)}, ${at(day, 17)}, ${order}, 120) returning id`;
  if (technicianId) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
              values (${ORG}, ${v!.id}, ${technicianId}, true)`;
  }
  return { visitId: v!.id, jobId: job!.id, propertyId };
}

let flex = { visitId: "", jobId: "", propertyId: "" };
let flexCustomer = "";
let fixedIds: string[] = [];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Days Co", slug: "days-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [l] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, address_line1, city, state, postal_code,
                                 latitude, longitude, location_precision, location_source)
    values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701',
            ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.75)}, 'placed', 'manual') returning id`;
  yardId = l!.id;
  const userId = fixtureId("days:tech:ray");
  await raw`insert into public."user" (id, email) values (${userId}, 'days-ray@test.local') on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, home_location_id)
    values (${ORG}, ${m!.id}, 'Ray Ortiz', ${yardId}) returning id`;
  ray = t!.id;

  /** Four customers who agreed to nothing, and one who will agree to Tuesday or Wednesday. */
  fixedIds = [];
  for (const [i, lng] of [-97.73, -97.71, -97.69, -97.67].entries()) {
    fixedIds.push((await visit(TUE, await customer(`Fixed ${i}`), lng, i + 1, ray)).visitId);
  }
  flexCustomer = await customer("Flexible Pat");
  flex = await visit(TUE, flexCustomer, -97.65, 5, ray);
  await raw`insert into public.visit_change_request (organization_id, visit_id, job_id, customer_id, kind, reason)
            values (${ORG}, ${flex.visitId}, ${flex.jobId}, ${flexCustomer}, 'cancel', 'Might be away')`;
});
afterAll(async () => { if (raw) await raw.end(); });

run("several days rebalanced", () => {
  it("moves nothing to another day when nobody agreed to one", async () => {
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    expect(proposal.movable).toEqual([]);
    expect(proposal.dayMoves).toEqual([]);
    const tuesday = proposal.perDay.find((d) => d.date === TUE)!;
    expect(tuesday.technicians[0]!.before.overLimitMinutes).toBeGreaterThan(0);
  });

  it("records what the customer agreed to, with the permissions that own each", async () => {
    await expect(dispatchDays.setVisitMovable(as(["technician"]), { id: flex.visitId, from: TUE, until: WED }))
      .rejects.toMatchObject({ name: "PermissionError" });
    await expect(dispatchDays.setVisitMovable(dispatcher(), { id: flex.visitId, from: WED, until: TUE }))
      .rejects.toThrow(/on or after the first/);
    expect(await dispatchDays.setVisitMovable(dispatcher(), { id: flex.visitId, from: TUE, until: WED }))
      .toEqual({ id: flex.visitId, movableFrom: TUE, movableUntil: WED });
    await expect(dispatchDays.setPreferredDays(owner(), { id: flexCustomer, days: [7] })).rejects.toThrow(/0 for Sunday/);
    expect((await dispatchDays.setPreferredDays(owner(), { id: flexCustomer, days: [weekday(WED), weekday(TUE), weekday(WED)] })).preferredDays)
      .toEqual([weekday(TUE), weekday(WED)].sort((a, b) => a - b));
  });

  it("proposes the agreed visit on the other day, each day before and after, and changes nothing", async () => {
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    expect(proposal.movable.map((m) => m.visitId)).toEqual([flex.visitId]);
    expect(proposal.dayMoves).toEqual([expect.objectContaining({
      visitId: flex.visitId, fromDate: TUE, toDate: WED, toTechnicianId: ray, toName: "Ray Ortiz", because: "range",
      windowStart: at(WED, 8).toISOString(), windowEnd: at(WED, 17).toISOString(),
    })]);
    const tuesday = proposal.perDay.find((d) => d.date === TUE)!;
    const wednesday = proposal.perDay.find((d) => d.date === WED)!;
    expect([tuesday.visitsBefore, tuesday.visitsAfter]).toEqual([5, 4]);
    expect([wednesday.visitsBefore, wednesday.visitsAfter]).toEqual([0, 1]);
    expect(tuesday.technicians[0]!.after.overLimitMinutes).toBe(0);
    expect(wednesday.technicians[0]!.after.order).toEqual([flex.visitId]);

    const [still] = await raw<{ window_start: Date }[]>`select window_start from public.visit where id = ${flex.visitId}`;
    expect(still!.window_start.toISOString()).toBe(at(TUE, 8).toISOString());
  });

  it("refuses a move the customer did not agree to, even when the payload asks for it", async () => {
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    await expect(dispatchDays.applyRebalanceDays(dispatcher("days-apply-sneaky"), {
      from: TUE, days: 2, basis: proposal.basis,
      dayMoves: [{ visitId: fixedIds[0]!, toDate: WED, technicianId: ray }], moves: [], orders: [],
    })).rejects.toThrow(/has not agreed to that day/);
  });

  it("applies it: the visit on its new day, its customer told, and their waiting request overtaken", async () => {
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: TUE, days: 2 });
    const result = await dispatchDays.applyRebalanceDays(dispatcher("days-apply-1"), {
      from: TUE, days: 2, basis: proposal.basis, ...proposal.apply,
    });
    expect(result.movedDays).toBe(1);
    expect(result.told.map((t) => t.visitId)).toEqual([flex.visitId]);
    expect(typeof result.told[0]!.notified).toBe("string");

    const [moved] = await raw<{ window_start: Date; window_end: Date; status: string }[]>`
      select window_start, window_end, status from public.visit where id = ${flex.visitId}`;
    expect(moved!.window_start.toISOString()).toBe(at(WED, 8).toISOString());
    expect(moved!.window_end.toISOString()).toBe(at(WED, 17).toISOString());
    expect(moved!.status).toBe("dispatched");
    const [assigned] = await raw<{ technician_id: string }[]>`select technician_id from public.visit_assignment where visit_id = ${flex.visitId}`;
    expect(assigned!.technician_id).toBe(ray);

    const events = await raw<{ kind: string; headline: string }[]>`
      select kind, headline from public.portal_event where job_id = ${flex.jobId}`;
    expect(events).toEqual([expect.objectContaining({ kind: "rescheduled", headline: "Visit moved" })]);
    const [request] = await raw<{ status: string }[]>`select status from public.visit_change_request where visit_id = ${flex.visitId}`;
    expect(request!.status).toBe("superseded");
    /** Ray keeps it, so he hears that it moved. */
    const [notice] = await raw<{ name: string }[]>`
      select name from public.domain_event where organization_id = ${ORG} and entity_id = ${flex.visitId} and name = 'visit.rescheduled'`;
    expect(notice?.name).toBe("visit.rescheduled");

    /** A replay is the same answer; the same proposal as a new request is about days that have moved. */
    expect(await dispatchDays.applyRebalanceDays(dispatcher("days-apply-1"), {
      from: TUE, days: 2, basis: proposal.basis, ...proposal.apply,
    })).toEqual(result);
    await expect(dispatchDays.applyRebalanceDays(dispatcher("days-apply-2"), {
      from: TUE, days: 2, basis: proposal.basis, ...proposal.apply,
    })).rejects.toThrow(/board has changed/);
  });

  it("never moves a visit onto today or off it", async () => {
    const today = companyToday();
    const v = await visit(today, await customer("Today Lee"), -97.74, 9, ray);
    await dispatchDays.setVisitMovable(dispatcher(), { id: v.visitId, from: today, until: TUE });
    const proposal = await dispatchDays.rebalanceDays(dispatcher(), { from: today, days: 4 });
    expect(proposal.movable.map((m) => m.visitId)).not.toContain(v.visitId);
    await raw`update public.visit set status = 'cancelled' where id = ${v.visitId}`;
  });
});

run("a route's density by road", () => {
  it("counts the drive by road when a routing service is connected, and says so", async () => {
    const owner_ = owner();
    const route = await serviceRoutes.create(owner_, { name: "Tuesday pools", dayOfWeek: weekday(TUE), technicianId: ray });
    const stopCustomer = await customer("Pool Owner");
    for (const lng of [-97.74, -97.73]) {
      const p = await property(stopCustomer, 30.30, lng);
      await serviceRoutes.addStop(owner_, { routeId: route.id, propertyId: p, estimatedMinutes: 30 });
    }
    const without = await serviceRoutes.density(owner_, { id: route.id });
    expect(without.travelSource).toBe("none");
    expect(without.travelMinutes).toBeNull();
    expect(without.travelComplete).toBe(false);

    await raw`insert into public.integration_connection (organization_id, capability, provider, status)
              values (${ORG}, 'routing', 'days-router', 'connected')`;
    const byRoad = await serviceRoutes.density(owner_, { id: route.id });
    expect(byRoad.travelSource).toBe("road");
    expect(byRoad.travelComplete).toBe(true);
    /** Out from the yard, between the two stops, and home: about 1 km, 1 km and 2 km at three minutes a kilometre. */
    expect(byRoad.travelMinutes).toBeGreaterThan(8);
    expect(byRoad.totalMinutes).toBe(60 + byRoad.travelMinutes!);
    expect(byRoad.travelNote).toMatch(/^By road between the stops in their order, and out from where the day starts and back/);

    /** An extra stop with no address makes the figure a floor again. */
    const adding = await serviceRoutes.density(owner_, { id: route.id, addingStopOfMinutes: 30 });
    expect(adding.travelComplete).toBe(false);
    expect(adding.travelNote).toMatch(/extra stop has no address/);

    /** The operator's own figure still beats the road. */
    await raw`update public.route set travel_minutes_between_stops = 7 where id = ${route.id}`;
    const declared = await serviceRoutes.density(owner_, { id: route.id });
    expect(declared.travelSource).toBe("declared");
    expect(declared.travelMinutes).toBe(7);
    await raw`delete from public.integration_connection where organization_id = ${ORG} and capability = 'routing'`;
  });
});

