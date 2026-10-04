import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, time, type Actor } from "@opentradesos/core";
import * as dispatchMap from "../src/services/dispatch-map";
import * as dispatch from "../src/services/dispatch";
import { travelMatrix } from "../src/services/travel-times";
import { registerRouter, type MatrixRequest } from "../src/routing/provider";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE DAY REBALANCED, AND DRIVE TIMES BY ROAD
 *
 * Two yards forty kilometres apart, a technician in each, and a day booked
 * the way days get booked: Ray in the west with a call on the east side. The
 * rebalance should hand that call to Dana, place the unassigned visit, leave
 * locked and qualified work alone, change nothing until a person applies it,
 * and refuse to apply a proposal about a board that has since moved.
 *
 * Drive times come from a fake routing service registered here, so nothing
 * reaches a network, and the file checks both what the optimiser does with a
 * road network and what it does without one: the straight line, said so.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("rebal:org");
const USER = fixtureId("rebal:user");
const ZONE = "America/Chicago";
const DAY = time.dateIn(new Date(Date.now() + 3 * 864e5), ZONE);
const at = (hour: number) => time.instantOfLocal(DAY, hour * 60, ZONE);

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], idempotencyKey?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(idempotencyKey ? { idempotencyKey } : {}),
});
const owner = (key?: string) => as(["owner"], key);
const dispatcher = (key?: string) => as(["dispatcher"], key);

/** A routing service that answers from the straight line at a fixed speed, counting what it was asked. */
const asked: MatrixRequest[] = [];
let failing = false;
registerRouter("test-router", () => ({
  name: "test-router",
  keepForSeconds: 3600,
  maxPoints: 6,
  async matrix(request) {
    asked.push(request);
    if (failing) return { kind: "failed", retryable: true, reason: "The test router is down." };
    return {
      kind: "ok",
      minutes: request.sources.map((a) => request.destinations.map((b) =>
        a.lat === b.lat && a.lng === b.lng ? 0 : Math.max(1, Math.round(geo.haversineKm(a, b) * 2)))),
      meters: null,
    };
  },
}));

let customerId = "";
let ray = "";
let dana = "";
let gasType = "";

async function technician(key: string, name: string, homeLocationId: string, skills: string[] = []) {
  const userId = fixtureId(`rebal:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`rebal-${key}@test.local`}) on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, skills, home_location_id)
    values (${ORG}, ${m!.id}, ${name}, ${raw.json(skills as never)}, ${homeLocationId}) returning id`;
  return t!.id;
}

async function yard(name: string, lat: number, lng: number) {
  const [l] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, address_line1, city, state, postal_code,
                                 latitude, longitude, location_precision, location_source)
    values (${ORG}, ${name}, '1 Yard Rd', 'Austin', 'TX', '78701',
            ${geo.formatCoordinate(lat)}, ${geo.formatCoordinate(lng)}, 'placed', 'manual') returning id`;
  return l!.id;
}

async function visit(lat: number, lng: number, options: {
  technicianId?: string; order?: number; from?: number; to?: number; jobTypeId?: string;
} = {}) {
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code,
                                 latitude, longitude, location_precision, location_source)
    values (${ORG}, ${`${lat},${lng}`}, 'Austin', 'TX', '78701',
            ${geo.formatCoordinate(lat)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${p!.id}, ${options.jobTypeId ?? null}, 'scheduled', 'Rebalance work') returning id`;
  const [v] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes)
    values (${ORG}, ${job!.id}, ${options.technicianId ? "dispatched" : "unassigned"}::visit_status,
            ${at(options.from ?? 8)}, ${at(options.to ?? 17)}, ${options.order ?? null}, 45) returning id`;
  if (options.technicianId) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
              values (${ORG}, ${v!.id}, ${options.technicianId}, true)`;
  }
  return v!.id;
}

const ownerOf = async (visitId: string) => (await raw<{ technician_id: string }[]>`
  select technician_id from public.visit_assignment where visit_id = ${visitId}`).map((r) => r.technician_id);

let w1 = ""; let e1 = ""; let gas = ""; let open = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Rebalance Co", slug: "rebalance-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Pat Rebalance') returning id`;
  customerId = c!.id;
  const west = await yard("West yard", 30.30, -97.90);
  const east = await yard("East yard", 30.30, -97.50);
  ray = await technician("ray", "Ray Ortiz", west, ["gas-fitting"]);
  dana = await technician("dana", "Dana Lee", east);
  const [g] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, required_skills)
    values (${ORG}, 'Gas repair', ${raw.json(["gas-fitting"] as never)}) returning id`;
  gasType = g!.id;

  w1 = await visit(30.30, -97.88, { technicianId: ray, order: 1 });
  e1 = await visit(30.30, -97.52, { technicianId: ray, order: 2 });
  gas = await visit(30.30, -97.86, { technicianId: ray, order: 3, jobTypeId: gasType });
  /** Dana is already out east, which is what makes the east side call hers. */
  await visit(30.30, -97.51, { technicianId: dana, order: 1 });
  open = await visit(30.31, -97.52, { from: 9, to: 12 });
});
afterAll(async () => { if (raw) await raw.end(); });

run("rebalancing a day across people", () => {
  it("proposes the east side call for Dana and places the unassigned visit, and changes nothing", async () => {
    const proposal = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    expect(proposal.changed).toBe(true);
    const moves = new Map(proposal.moves.map((m) => [m.visitId, m]));
    expect(moves.get(e1)).toMatchObject({ fromTechnicianId: ray, toTechnicianId: dana, toName: "Dana Lee" });
    expect(moves.get(open)).toMatchObject({ fromTechnicianId: null, toTechnicianId: dana });
    expect(proposal.newlyAssigned).toBe(1);
    expect(proposal.driveSavedMinutes).toBeGreaterThan(30);
    expect(proposal.driveSource).toBe("estimate");
    expect(proposal.driveNote).toMatch(/straight line/);
    expect(moves.has(gas)).toBe(false);

    expect(await ownerOf(e1)).toEqual([ray]);
    expect(await ownerOf(open)).toEqual([]);
  });

  it("leaves a locked visit with whoever has it", async () => {
    await dispatchMap.lockVisit(dispatcher(), { id: e1, locked: true });
    const locked = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    expect(locked.moves.map((m) => m.visitId)).not.toContain(e1);
    await dispatchMap.lockVisit(dispatcher(), { id: e1, locked: false });
  });

  it("refuses a technician applying a rebalance", async () => {
    const proposal = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    await expect(dispatchMap.applyRebalance(as(["technician"]), {
      date: DAY, basis: proposal.basis, moves: proposal.moveAssignments, orders: proposal.apply,
    })).rejects.toMatchObject({ name: "PermissionError" });
  });

  it("applies what the person saw, through the same assignment and reorder a drag uses", async () => {
    const proposal = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    const result = await dispatchMap.applyRebalance(dispatcher("rebalance-apply-1"), {
      date: DAY, basis: proposal.basis, moves: proposal.moveAssignments, orders: proposal.apply,
    });
    expect(result.moved).toBe(proposal.moves.length);
    expect(await ownerOf(e1)).toEqual([dana]);
    expect(await ownerOf(open)).toEqual([dana]);
    expect(await ownerOf(gas)).toEqual([ray]);

    const danaDay = proposal.apply.find((a) => a.technicianId === dana)!.visitIds;
    const orders = await raw<{ id: string; route_order: number }[]>`
      select id, route_order from public.visit where id in ${raw(danaDay)} order by route_order`;
    expect(orders.map((o) => o.id)).toEqual(danaDay);

    /** A replay of the same request is the same answer, not a second application. */
    const replay = await dispatchMap.applyRebalance(dispatcher("rebalance-apply-1"), {
      date: DAY, basis: proposal.basis, moves: proposal.moveAssignments, orders: proposal.apply,
    });
    expect(replay).toEqual(result);

    /** The same proposal again, as a new request, is about a board that has moved. */
    await expect(dispatchMap.applyRebalance(dispatcher("rebalance-apply-2"), {
      date: DAY, basis: proposal.basis, moves: proposal.moveAssignments, orders: proposal.apply,
    })).rejects.toThrow(/board has changed/);

    const audit = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and action = 'dispatch.rebalanced'`;
    expect(audit).toHaveLength(1);
  });

  it("finds nothing more to move once the day is balanced", async () => {
    const again = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    expect(again.moves).toEqual([]);
  });

  it("never gives gas work to somebody not recorded as doing it, however near they are", async () => {
    const eastGas = await visit(30.31, -97.505, { jobTypeId: gasType });
    const proposal = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    const move = proposal.moves.find((m) => m.visitId === eastGas);
    expect(move?.toTechnicianId).toBe(ray);
    await raw`update public.visit set status = 'cancelled' where id = ${eastGas}`;
  });
});

run("the working day it plans inside", () => {
  it("reads the defaults and refuses nonsense", async () => {
    expect(await dispatchMap.workdaySettings(dispatcher())).toEqual({
      dayEndsAt: "17:00", lunchMinutes: 30, lunchEarliest: "11:00", lunchLatest: "13:30", maxOvertimeMinutes: 60,
    });
    await expect(dispatchMap.setWorkdaySettings(owner(), { dayEndsAt: "07:00" })).rejects.toThrow(/end after it starts/);
    await expect(dispatchMap.setWorkdaySettings(owner(), { lunchEarliest: "14:00" })).rejects.toThrow(/before the latest/);
    await expect(dispatchMap.setWorkdaySettings(dispatcher(), { maxOvertimeMinutes: 0 }))
      .rejects.toMatchObject({ name: "PermissionError" });
  });

  it("will not plan past the overtime limit to empty the pile, and says so", async () => {
    await dispatchMap.setWorkdaySettings(owner(), { dayEndsAt: "08:30", maxOvertimeMinutes: 0 });
    const late = await visit(30.29, -97.89, { from: 8, to: 17 });
    const proposal = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    const unplaced = proposal.unplaced.find((u) => u.visitId === late);
    expect(unplaced?.reason).toMatch(/past the overtime allowed/);
    await dispatchMap.setWorkdaySettings(owner(), { dayEndsAt: "17:00", maxOvertimeMinutes: 60 });
    await raw`update public.visit set status = 'cancelled' where id = ${late}`;
  });

  it("keeps a technician's own hours instead of the company's", async () => {
    const updated = await dispatchMap.updateTechnician(owner(), { id: dana, workday: { startsAt: "07:00", endsAt: "15:30" } });
    expect(updated.workday).toEqual({ startsAt: "07:00", endsAt: "15:30" });
    await expect(dispatchMap.updateTechnician(owner(), { id: dana, workday: { startsAt: "15:00", endsAt: "07:00" } }))
      .rejects.toThrow(/end after it starts/);
  });
});

run("drive times by road", () => {
  const points = new Map([["a", { lat: 30.30, lng: -97.90 }], ["b", { lat: 30.30, lng: -97.50 }], ["c", null]]);
  const assumptions = geo.DEFAULT_DRIVE;

  it("falls back to the straight line, and says so, with no routing service connected", async () => {
    const matrix = await travelMatrix(owner(), points, { assumptions });
    expect(matrix.source).toBe("estimate");
    expect(matrix.provider).toBeNull();
    expect(matrix.travel("a", "b")).toBe(geo.driveMinutes({ lat: 30.3, lng: -97.9 }, { lat: 30.3, lng: -97.5 }));
    expect(matrix.travel("a", "c")).toBe(0);
  });

  it("asks the connected service, keeps what it said, and does not ask again", async () => {
    await raw`insert into public.integration_connection (organization_id, capability, provider, status)
              values (${ORG}, 'routing', 'test-router', 'connected')`;
    asked.length = 0;
    const first = await travelMatrix(owner(), points, { assumptions });
    expect(first.source).toBe("road");
    expect(first.provider).toBe("test-router");
    expect(first.travel("a", "b")).toBe(Math.round(geo.haversineKm({ lat: 30.3, lng: -97.9 }, { lat: 30.3, lng: -97.5 }) * 2));
    expect(asked).toHaveLength(1);

    const second = await travelMatrix(owner(), points, { assumptions });
    expect(second.source).toBe("road");
    expect(asked).toHaveLength(1);
    const cached = await raw`select 1 from public.travel_time where organization_id = ${ORG} and provider = 'test-router'`;
    expect(cached.length).toBe(2);

    const events = await raw`select 1 from public.integration_event
      where organization_id = ${ORG} and event_type = 'travel_matrix' and status = 'succeeded'`;
    expect(events.length).toBe(1);
  });

  it("uses road times in the rebalance and the route proposal, and says so", async () => {
    const proposal = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    expect(proposal.driveSource).toBe("road");
    expect(proposal.driveNote).toMatch(/by road/);
    const route = await dispatchMap.optimise(dispatcher(), { date: DAY, technicianId: ray });
    expect(route.driveSource).toBe("road");
  });

  it("falls back to the straight line when the service fails, says why, and marks the connection", async () => {
    failing = true;
    const elsewhere = new Map([["x", { lat: 30.1, lng: -97.6 }], ["y", { lat: 30.2, lng: -97.7 }]]);
    const matrix = await travelMatrix(owner(), elsewhere, { assumptions });
    expect(matrix.source).toBe("estimate");
    expect(matrix.failure).toMatch(/test router is down/);
    expect(matrix.travel("x", "y")).toBe(geo.driveMinutes({ lat: 30.1, lng: -97.6 }, { lat: 30.2, lng: -97.7 }));
    const [connection] = await raw<{ last_error: string | null }[]>`
      select last_error from public.integration_connection where organization_id = ${ORG} and capability = 'routing'`;
    expect(connection!.last_error).toMatch(/down/);

    failing = false;
    await travelMatrix(owner(), elsewhere, { assumptions });
    const [cleared] = await raw<{ last_error: string | null }[]>`
      select last_error from public.integration_connection where organization_id = ${ORG} and capability = 'routing'`;
    expect(cleared!.last_error).toBeNull();
  });
});

run("crews, routes and the rota on the board", () => {
  it("puts crew work in the crew's lane and on its own line, not in the unassigned pile", async () => {
    const [crew] = await raw<{ id: string }[]>`
      insert into public.crew (organization_id, name, color) values (${ORG}, 'Install crew', '#7C3AED') returning id`;
    await raw`insert into public.crew_member (organization_id, crew_id, technician_id, is_lead)
              values (${ORG}, ${crew!.id}, ${dana}, true), (${ORG}, ${crew!.id}, ${ray}, false)`;
    const crewVisit = await visit(30.32, -97.6);
    await raw`update public.visit set crew_id = ${crew!.id}, status = 'dispatched' where id = ${crewVisit}`;

    const board = await dispatch.board(dispatcher(), { date: DAY });
    expect(board.unassigned.map((v) => v.id)).not.toContain(crewVisit);
    const lane = board.crews.find((c) => c.id === crew!.id)!;
    expect(lane).toMatchObject({ name: "Install crew", leadName: "Dana Lee" });
    expect(lane.memberNames).toEqual(["Dana Lee", "Ray Ortiz"]);
    expect(lane.visits.map((v) => v.id)).toEqual([crewVisit]);

    const map = await dispatchMap.map(dispatcher(), { date: DAY });
    expect(map.crews.find((c) => c.id === crew!.id)?.route).toEqual([crewVisit]);
    expect(map.visits.find((v) => v.id === crewVisit)?.crewId).toBe(crew!.id);

    /** And the rebalance leaves it to the crew. */
    const proposal = await dispatchMap.rebalance(dispatcher(), { date: DAY });
    expect(proposal.moves.map((m) => m.visitId)).not.toContain(crewVisit);
    expect(proposal.untouched).toContain(crewVisit);
  });

  it("says who is on call, and says so when nobody is", async () => {
    expect((await dispatch.board(dispatcher(), { date: DAY })).onCall).toEqual([]);
    await raw`insert into public.on_call_rotation (organization_id, technician_id, starts_at, ends_at)
              values (${ORG}, ${ray}, ${at(17)}, ${new Date(at(17).getTime() + 15 * 3_600_000)})`;
    const board = await dispatch.board(dispatcher(), { date: DAY });
    expect(board.onCall).toEqual([expect.objectContaining({ technicianName: "Ray Ortiz" })]);
  });

  it("lists the routes running today with how far through them the day is", async () => {
    const [route] = await raw<{ id: string }[]>`
      insert into public.route (organization_id, name, technician_id) values (${ORG}, 'Tuesday pools', ${ray}) returning id`;
    await raw`update public.visit set route_id = ${route!.id} where id = ${w1}`;
    const board = await dispatch.board(dispatcher(), { date: DAY });
    expect(board.routes).toEqual([{ id: route!.id, name: "Tuesday pools", stops: 1, done: 0, runBy: "Ray Ortiz" }]);
    const card = board.technicians.flatMap((t) => t.visits).find((v) => v.id === w1);
    expect(card?.routeName).toBe("Tuesday pools");
  });
});
