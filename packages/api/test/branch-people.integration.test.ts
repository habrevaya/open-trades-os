import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as company from "../src/services/company";
import * as branches from "../src/services/branches";
import * as team from "../src/services/team";
import * as roleService from "../src/services/roles";
import * as dispatch from "../src/services/dispatch";
import * as dispatchMap from "../src/services/dispatch-map";
import * as dispatchDays from "../src/services/dispatch-days";
import * as crews from "../src/services/crews";
import * as serviceRoutes from "../src/services/routes";
import * as people from "../src/services/people";
import * as records from "../src/services/people-records";
import * as fieldDevices from "../src/services/field-devices";
import { memberActor } from "../src/services/session";
import { inTenant, ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A BRANCH MANAGER'S PEOPLE, CREWS AND ROUTES
 *
 * `branch-scope.integration.test.ts` asks whether a branch manager sees
 * another branch's work. This asks the same of who does the work: the
 * technicians screen, crews, routes, Team and People, and every place the
 * board, the map, the rebalance and "Suggest who" put a name in front of
 * them. The refusals come first, because this is the security half: another
 * branch's person, crew or route opened by its id reads as not found, and
 * changing one is refused the same way.
 *
 * Everyone is resolved the way a signed in session resolves them
 * (`memberActor`), holding the Branch manager PRESET, plus `user:write`
 * granted by name so the edits are refused by scope rather than by a missing
 * permission.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("branch-people:org");
const OWNER = fixtureId("branch-people:owner");
const HANA = fixtureId("branch-people:hana");
const RAY = fixtureId("branch-people:ray");
const SAM = fixtureId("branch-people:sam");
const GUS = fixtureId("branch-people:gus");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] }, db: db() });

let austin = "";
let houston = "";
let hanaMembership = "";
let rayMembership = "";
let samMembership = "";
let gusMembership = "";
let rayTech = "";
let samTech = "";
let houstonCrew = "";
let austinCrew = "";
let houstonRoute = "";
let austinRoute = "";
let austinStop = "";
let houstonJob = "";
let austinJob = "";
let houstonOpen = "";
let houstonVisitForSam = "";
let austinOpen = "";

async function resolve(userId: string): Promise<ServiceContext> {
  const actor = await inTenant(owner(), (tx) => memberActor(tx, ORG, userId));
  if (!actor) throw new Error("No active membership.");
  return { actor, db: db() };
}
const hana = () => resolve(HANA);

async function person(userId: string, email: string, name: string, role: string, branch: string | null): Promise<string> {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role, business_unit_id)
    values (${ORG}, ${userId}, ${role}::public.member_role, ${branch}) returning id`;
  return row!.id;
}

async function technician(membershipId: string, name: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membershipId}, ${name}) returning id`;
  return row!.id;
}

/** A visit on the company's today, at a place on the map, with somebody on it or nobody. */
async function visit(jobId: string, sequence: number, technicianId: string | null, hours: number): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${jobId}, ${sequence}, ${technicianId ? "dispatched" : "unassigned"}::public.visit_status,
            ${new Date(Date.now() + hours * 3600_000)}, ${new Date(Date.now() + (hours + 2) * 3600_000)}, 30)
    returning id`;
  if (technicianId) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
      values (${ORG}, ${row!.id}, ${technicianId}, true)`;
  }
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Two Branches, Their People", slug: "branch-people" });
  await raw`delete from public."user" where email like ${"branch-people-%@test.local"} and id <> ${OWNER}`;

  austin = (await company.createBusinessUnit(owner(), { name: "Austin", code: "AUS" })).id;
  houston = (await company.createBusinessUnit(owner(), { name: "Houston", code: "HOU" })).id;
  /** The yard every day starts from, on the map, so the suggestions measure a drive. */
  const yard = (await company.createLocation(owner(), { name: "Main yard" })).id;
  await raw`update public.location set latitude = ${geo.formatCoordinate(30.27)}, longitude = ${geo.formatCoordinate(-97.74)},
            location_precision = 'rooftop', location_source = 'test-geocoder' where id = ${yard}`;

  hanaMembership = await person(HANA, "branch-people-hana@test.local", "Hana Houston", "office_manager", houston);
  rayMembership = await person(RAY, "branch-people-ray@test.local", "Ray Houston", "technician", houston);
  samMembership = await person(SAM, "branch-people-sam@test.local", "Sam Austin", "technician", austin);
  gusMembership = await person(GUS, "branch-people-gus@test.local", "Gus Austin", "csr", austin);
  rayTech = await technician(rayMembership, "Ray Houston");
  samTech = await technician(samMembership, "Sam Austin");
  await team.setRole(owner(), { membershipId: hanaMembership, role: "branch_manager" });
  /** Allowed to edit people at all, so what refuses her below is the branch. */
  await raw`update public.membership set grants = '["user:write"]'::jsonb where id = ${hanaMembership}`;

  houstonCrew = (await crews.create(owner(), { name: "Houston crew", businessUnitId: houston })).id;
  austinCrew = (await crews.create(owner(), { name: "Austin crew", businessUnitId: austin })).id;
  await crews.setMembers(owner(), { id: houstonCrew, members: [{ technicianId: rayTech, isLead: true }] });
  await crews.setMembers(owner(), { id: austinCrew, members: [{ technicianId: samTech, isLead: true }] });

  const customerId = (await customers.create(owner(), {
    type: "residential", name: "Branch People Customer", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  const place = async (line1: string, lat: number, lng: number) => {
    const [row] = await raw<{ id: string }[]>`
      insert into public.property (organization_id, address_line1, city, state, postal_code,
                                   latitude, longitude, location_precision, location_source)
      values (${ORG}, ${line1}, 'Austin', 'TX', '78701', ${geo.formatCoordinate(lat)}, ${geo.formatCoordinate(lng)},
              'rooftop', 'test-geocoder') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id, role, is_primary)
              values (${ORG}, ${customerId}, ${row!.id}, 'owner', true)`;
    return row!.id;
  };
  const houstonPlace = await place("1 Main St", 30.28, -97.73);
  const austinPlace = await place("1 Congress Ave", 30.26, -97.75);
  houstonJob = (await jobs.create(owner(), {
    customerId, propertyId: houstonPlace, summary: "Houston condenser", tags: [], customFields: {}, businessUnitId: houston,
  })).id as string;
  austinJob = (await jobs.create(owner(), {
    customerId, propertyId: austinPlace, summary: "Austin furnace", tags: [], customFields: {}, businessUnitId: austin,
  })).id as string;
  await visit(houstonJob, 1, rayTech, 1);
  /** Sam, from Austin, covering one Houston visit: on Houston's board for that visit only. */
  houstonVisitForSam = await visit(houstonJob, 2, samTech, 2);
  houstonOpen = await visit(houstonJob, 3, null, 3);
  austinOpen = await visit(austinJob, 1, null, 3);

  houstonRoute = (await serviceRoutes.create(owner(), { name: "Houston Tuesday", dayOfWeek: 2, technicianId: rayTech })).id;
  austinRoute = (await serviceRoutes.create(owner(), { name: "Austin Tuesday", dayOfWeek: 2, crewId: austinCrew })).id;
  austinStop = (await serviceRoutes.addStop(owner(), { routeId: austinRoute, propertyId: austinPlace })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

/* --------------------------------------------------------------- refusals */

run("another branch's technician, by id", () => {
  it("cannot be changed, given a photo, a mobile number or a skill, and reads as not found", async () => {
    const ctx = await hana();
    await expect(dispatchMap.updateTechnician(ctx, { id: samTech, color: "#000000" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(dispatchMap.setTechnicianPhoto(ctx, { id: samTech, bytes: null })).rejects.toBeInstanceOf(NotFoundError);
    await expect(fieldDevices.setMobile(ctx, { id: samTech, mobilePhone: "+15125550100" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(records.skills(ctx, { technicianId: samTech })).rejects.toBeInstanceOf(NotFoundError);
    await expect(records.recordSkill(ctx, { technicianId: samTech, skill: "gas", since: "2026-01-05", evidence: "Licence seen" })).rejects.toBeInstanceOf(NotFoundError);
    const [still] = await raw<{ color: string | null }[]>`select color from public.technician where id = ${samTech}`;
    expect(still!.color).toBeNull();
  });

  it("cannot be put on one of their visits, or have their day reordered", async () => {
    const ctx = await hana();
    /** Refused in the words an id that is not there gets, so the refusal does not say Sam exists. */
    await expect(dispatch.assign(ctx, { id: houstonOpen, technicianIds: [samTech] })).rejects.toThrow(/not active in this company/);
    await expect(dispatch.reorder(ctx, { technicianId: samTech, date: companyToday(), visitIds: [houstonVisitForSam] }))
      .rejects.toBeInstanceOf(NotFoundError);
    await expect(dispatchMap.optimise(ctx, { date: companyToday(), technicianId: samTech })).rejects.toBeInstanceOf(NotFoundError);
  });
});

run("another branch's crew, by id", () => {
  it("cannot be changed, staffed, asked about or sent anywhere, and reads as not found", async () => {
    const ctx = await hana();
    await expect(crews.update(ctx, { id: austinCrew, name: "Mine now" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(crews.setMembers(ctx, { id: austinCrew, members: [] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(crews.canTake(ctx, { id: austinCrew, jobId: houstonJob })).rejects.toBeInstanceOf(NotFoundError);
    await expect(crews.assign(ctx, { id: houstonOpen, crewId: austinCrew })).rejects.toBeInstanceOf(NotFoundError);
    const [still] = await raw<{ name: string }[]>`select name from public.crew where id = ${austinCrew}`;
    expect(still!.name).toBe("Austin crew");
  });

  it("cannot take somebody from another branch onto their own crew, or be sent to another branch's visit", async () => {
    const ctx = await hana();
    await expect(crews.setMembers(ctx, { id: houstonCrew, members: [{ technicianId: samTech }] }))
      .rejects.toThrow(/not active in this company/);
    await expect(crews.assign(ctx, { id: austinOpen, crewId: houstonCrew })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cannot be made in another branch, or in none", async () => {
    const ctx = await hana();
    await expect(crews.create(ctx, { name: "Austin night crew", businessUnitId: austin })).rejects.toBeInstanceOf(ConflictError);
    await expect(crews.create(ctx, { name: "Nobody's crew", businessUnitId: null })).rejects.toBeInstanceOf(ConflictError);
  });
});

run("another branch's route, by id", () => {
  it("cannot be read, added to, run or paused, and reads as not found", async () => {
    const ctx = await hana();
    await expect(serviceRoutes.stops(ctx, { id: austinRoute })).rejects.toBeInstanceOf(NotFoundError);
    await expect(serviceRoutes.density(ctx, { id: austinRoute })).rejects.toBeInstanceOf(NotFoundError);
    await expect(serviceRoutes.materialise(ctx, { id: austinRoute, date: "2026-06-02" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(serviceRoutes.reorder(ctx, { id: austinRoute, stopIds: [austinStop] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(serviceRoutes.setStopActive(ctx, { id: austinStop, active: false })).rejects.toBeInstanceOf(NotFoundError);
    await expect(serviceRoutes.recordServiced(ctx, { id: austinStop, servicedOn: "2026-06-02" })).rejects.toBeInstanceOf(NotFoundError);
    const [stop] = await raw<{ active: boolean }[]>`select active from public.route_stop where id = ${austinStop}`;
    expect(stop!.active).toBe(true);
  });

  it("cannot be made for somebody in another branch", async () => {
    const ctx = await hana();
    await expect(serviceRoutes.create(ctx, { name: "Sam's Thursday", dayOfWeek: 4, technicianId: samTech }))
      .rejects.toThrow(/not active in this company/);
    await expect(serviceRoutes.create(ctx, { name: "Austin crew Thursday", dayOfWeek: 4, crewId: austinCrew }))
      .rejects.toThrow(/not active in this company/);
  });
});

run("another branch's person, by id", () => {
  it("cannot be opened, turned off, given a role, moved, or sent a new invite, and reads as not found", async () => {
    const ctx = await hana();
    await expect(records.person(ctx, { membershipId: samMembership })).rejects.toBeInstanceOf(NotFoundError);
    await expect(records.person(ctx, { membershipId: gusMembership })).rejects.toBeInstanceOf(NotFoundError);
    await expect(roleService.setMembershipActive(ctx, { membershipId: gusMembership, active: false })).rejects.toBeInstanceOf(NotFoundError);
    await expect(team.setRole(ctx, { membershipId: gusMembership, role: "branch_manager" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(team.resendInvite(ctx, { membershipId: gusMembership })).rejects.toBeInstanceOf(NotFoundError);
    await expect(branches.setMemberBranch(ctx, { membershipId: gusMembership, businessUnitId: houston })).rejects.toBeInstanceOf(NotFoundError);
    await expect(branches.setMemberLocation(ctx, { membershipId: gusMembership, locationId: null })).rejects.toBeInstanceOf(NotFoundError);
    await expect(records.addEmergencyContact(ctx, { membershipId: gusMembership, name: "Someone", phone: "+15125550101" }))
      .rejects.toBeInstanceOf(NotFoundError);
    await expect(records.setEmployment(ctx, {
      membershipId: gusMembership, startedOn: "2026-01-05", employmentType: "full_time", payType: "hourly",
    })).rejects.toBeInstanceOf(NotFoundError);
    await expect(records.startOnboarding(ctx, { membershipId: gusMembership })).rejects.toBeInstanceOf(NotFoundError);
    await expect(roleService.assign(ctx, { membershipId: gusMembership, roleId: null })).rejects.toBeInstanceOf(NotFoundError);
    const [gus] = await raw<{ active: boolean; business_unit_id: string }[]>`
      select active, business_unit_id from public.membership where id = ${gusMembership}`;
    expect(gus).toEqual({ active: true, business_unit_id: austin });
  });

  it("cannot move their own people between branches either, which is for the whole company", async () => {
    const ctx = await hana();
    await expect(branches.setMemberBranch(ctx, { membershipId: rayMembership, businessUnitId: austin }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});

/* -------------------------------------------------------------- the lists */

run("a branch manager's lists of people, crews and routes are their branch's", () => {
  it("lists Houston's technicians on the technicians screen, and the owner sees everybody", async () => {
    const mine = await dispatchMap.technicians(await hana());
    expect(mine.technicians.map((t) => t.id)).toEqual([rayTech]);
    const all = await dispatchMap.technicians(owner());
    expect(all.technicians.map((t) => t.id).sort()).toEqual([rayTech, samTech].sort());
  });

  it("lists Houston's crews and routes only", async () => {
    const ctx = await hana();
    expect((await crews.list(ctx)).map((c) => c.id)).toEqual([houstonCrew]);
    expect((await crews.crewsFor(ctx, { jobId: houstonJob })).crews.map((c) => c.crewId)).toEqual([houstonCrew]);
    expect((await serviceRoutes.list(ctx)).map((r) => r.id)).toEqual([houstonRoute]);
    expect((await crews.list(owner())).map((c) => c.id).sort()).toEqual([austinCrew, houstonCrew].sort());
    expect((await serviceRoutes.list(owner())).map((r) => r.id).sort()).toEqual([austinRoute, houstonRoute].sort());
  });

  it("lists Houston's people on Team, People and the phones screen", async () => {
    const ctx = await hana();
    const houstonPeople = [hanaMembership, rayMembership].sort();
    expect((await team.roster(ctx)).map((p) => p.membershipId).sort()).toEqual(houstonPeople);
    expect((await records.roster(ctx)).map((p) => p.membershipId).sort()).toEqual(houstonPeople);
    expect((await people.listPeople(ctx)).map((p) => p.membershipId).sort()).toEqual(houstonPeople);
    expect((await people.members(ctx)).map((p) => p.membership.id).sort()).toEqual(houstonPeople);
    expect((await fieldDevices.people(ctx, {})).technicians.map((t) => t.id)).toEqual([rayTech]);
    expect((await records.person(ctx, { membershipId: rayMembership })).membershipId).toBe(rayMembership);

    const everybody = (await team.roster(owner())).map((p) => p.membershipId);
    expect(everybody).toEqual(expect.arrayContaining([hanaMembership, rayMembership, samMembership, gusMembership]));
  });
});

run("the board, the map, the rebalance and Suggest who offer only their branch's people", () => {
  it("draws Sam on the board for the Houston visit he covers, marked as not one of theirs", async () => {
    const board = await dispatch.board(await hana(), { date: companyToday() });
    const sam = board.technicians.find((t) => t.id === samTech)!;
    expect(sam.visits.map((v) => v.id)).toEqual([houstonVisitForSam]);
    expect(sam.inScope).toBe(false);
    expect(board.technicians.find((t) => t.id === rayTech)!.inScope).toBe(true);
  });

  it("marks him the same way on the map", async () => {
    const map = await dispatchMap.map(await hana(), { date: companyToday() });
    expect(map.technicians.find((t) => t.id === samTech)!.inScope).toBe(false);
    expect(map.technicians.find((t) => t.id === rayTech)!.inScope).toBe(true);
  });

  it("suggests and considers only Houston's people for Houston's open visit", async () => {
    const result = await dispatchMap.suggestions(await hana(), { date: companyToday() });
    const open = result.suggestions.find((s) => s.visitId === houstonOpen)!;
    expect(open.considered.map((c) => c.technicianId)).toEqual([rayTech]);
    expect(open.technicianId === null || open.technicianId === rayTech).toBe(true);
    expect(result.suggestions.map((s) => s.visitId)).not.toContain(austinOpen);
  });

  it("plans only Houston's people in a rebalance, one day or several", async () => {
    const ctx = await hana();
    const day = await dispatchMap.rebalance(ctx, { date: companyToday() });
    expect(day.technicians.map((t) => t.technicianId)).toEqual([rayTech]);
    expect(day.moves.map((m) => m.toTechnicianId)).not.toContain(samTech);
    expect(day.visits.map((v) => v.visitId)).not.toContain(houstonVisitForSam);

    const days = await dispatchDays.rebalanceDays(ctx, { from: companyToday(), days: 2 });
    const planned = days.perDay.flatMap((d) => d.technicians.map((t) => t.technicianId));
    expect(planned).not.toContain(samTech);
    expect(days.perDay.flatMap((d) => d.crews.map((c) => c.crewId))).not.toContain(austinCrew);
    expect(days.moves.map((m) => m.toTechnicianId)).not.toContain(samTech);
  });
});

run("an actor that states its scopes and names none for people", () => {
  const stated = (scopes: Record<string, string>, extra: Record<string, unknown> = {}): ServiceContext => ({
    actor: {
      userId: fixtureId("branch-people:app"), organizationId: ORG, roles: [], grants: ["user:read", "visit:read"],
      scopes: scopes as never, ...extra,
    },
    db: db(),
  });

  it("reads people at the narrowest scope it states, so a migration app granted the whole company's work sees everybody", async () => {
    const everybody = (await people.listPeople(stated({ customer: "all", job: "all" }))).map((p) => p.membershipId);
    expect(everybody).toEqual(expect.arrayContaining([hanaMembership, rayMembership, samMembership, gusMembership]));
  });

  it("and an app limited to Houston's work sees Houston's people and technicians only", async () => {
    const houstonOnly = stated({ job: "business_unit", customer: "all" }, { businessUnitId: houston });
    expect((await people.listPeople(houstonOnly)).map((p) => p.membershipId).sort()).toEqual([hanaMembership, rayMembership].sort());
    expect((await dispatchMap.technicians(houstonOnly)).technicians.map((t) => t.id)).toEqual([rayTech]);
  });

  it("sees nobody when it states no scope at all, the narrowest default", async () => {
    expect(await people.listPeople(stated({}))).toEqual([]);
  });
});
