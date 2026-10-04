import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as company from "../src/services/company";
import * as roleService from "../src/services/roles";
import * as branches from "../src/services/branches";
import * as team from "../src/services/team";
import * as dispatch from "../src/services/dispatch";
import * as dispatchMap from "../src/services/dispatch-map";
import * as serviceReports from "../src/services/service-reports";
import * as labor from "../src/services/labor";
import * as laborSettings from "../src/services/labor-settings";
import * as timeOff from "../src/services/time-off";
import { memberActor } from "../src/services/session";
import { inTenant, ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A BRANCH MANAGER'S DAY, AND NOTHING FROM THE OTHER BRANCH
 *
 * `branches.integration.test.ts` asks whether a branch scoped person can see
 * another branch's jobs, customers, invoices and reports. This asks the same
 * question of the screens a branch manager actually runs a day from: the
 * dispatch board, the map, service reports, timesheets and the time off
 * queue, which were declared scopable and read the whole company.
 *
 * Every assertion is made as somebody resolved the way a signed in person is
 * (`memberActor`), holding the Branch manager PRESET, so what is tested is the
 * preset the product ships rather than a role a test built.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("branch-scope:org");
const OWNER = fixtureId("branch-scope:owner");
const HANA = fixtureId("branch-scope:hana");
const RAY = fixtureId("branch-scope:ray");
const SAM = fixtureId("branch-scope:sam");
const LOU = fixtureId("branch-scope:lou");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] }, db: db() });

let austin = "";
let houston = "";
let north = "";
let hanaMembership = "";
let louMembership = "";
let rayTech = "";
let samTech = "";
let austinVisit = "";
let houstonVisit = "";
let houstonVisitForSam = "";
let austinReport = "";
let houstonReport = "";
let rayEntry = "";
let samEntry = "";
let rayLeave = "";
let samLeave = "";

/** Somebody as a signed in session would resolve them, today. */
async function resolve(userId: string): Promise<ServiceContext> {
  const actor = await inTenant(owner(), (tx) => memberActor(tx, ORG, userId));
  if (!actor) throw new Error("No active membership.");
  return { actor, db: db() };
}

async function person(userId: string, email: string, name: string, role: string): Promise<string> {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, ${role}::public.member_role) returning id`;
  return row!.id;
}

const today = () => companyToday();

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Two Shops Again", slug: "branch-scope-two-shops" });
  /**
   * The people this file invites are accounts, which are not the company's
   * and outlive its reset; a second run would find each address taken.
   */
  await raw`delete from public."user" where email like ${"branch-scope-%@test.local"} and id <> ${OWNER}`;

  austin = (await company.createBusinessUnit(owner(), { name: "Austin", code: "AUS" })).id;
  houston = (await company.createBusinessUnit(owner(), { name: "Houston", code: "HOU" })).id;
  north = (await company.createLocation(owner(), { name: "North yard" })).id;

  hanaMembership = await person(HANA, "branch-scope-hana@test.local", "Hana Houston", "office_manager");
  const rayMembership = await person(RAY, "branch-scope-ray@test.local", "Ray Houston", "technician");
  const samMembership = await person(SAM, "branch-scope-sam@test.local", "Sam Austin", "technician");
  louMembership = await person(LOU, "branch-scope-lou@test.local", "Lou North", "office_manager");
  await raw`update public.membership set business_unit_id = ${houston} where id = ${rayMembership}`;
  await raw`update public.membership set business_unit_id = ${austin} where id = ${samMembership}`;

  const [ray] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${rayMembership}, 'Ray Houston') returning id`;
  const [sam] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${samMembership}, 'Sam Austin') returning id`;
  rayTech = ray!.id;
  samTech = sam!.id;

  const customer = async (name: string) => (await customers.create(owner(), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  const property = async (customerId: string, line1: string) => (await properties.create(owner(), {
    address: { line1, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id as string;
  const austinCustomer = await customer("Austin Furnace Owner");
  const houstonCustomer = await customer("Houston Condenser Owner");
  const austinProperty = await property(austinCustomer, "1 Congress Ave");
  const houstonProperty = await property(houstonCustomer, "1 Main St");
  const austinJob = (await jobs.create(owner(), {
    customerId: austinCustomer, propertyId: austinProperty, summary: "Austin furnace", tags: [], customFields: {}, businessUnitId: austin,
  })).id as string;
  const houstonJob = (await jobs.create(owner(), {
    customerId: houstonCustomer, propertyId: houstonProperty, summary: "Houston condenser", tags: [], customFields: {}, businessUnitId: houston,
  })).id as string;

  /** A visit an hour from now, on the company's today, with somebody on it. */
  const visit = async (jobId: string, technicianId: string, sequence: number) => {
    const [row] = await raw<{ id: string }[]>`
      insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end)
      values (${ORG}, ${jobId}, ${sequence}, 'dispatched', ${new Date(Date.now() + 3600_000)}, ${new Date(Date.now() + 7200_000)})
      returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
      values (${ORG}, ${row!.id}, ${technicianId}, true)`;
    return row!.id;
  };
  austinVisit = await visit(austinJob, samTech, 1);
  houstonVisit = await visit(houstonJob, rayTech, 1);
  /** Sam, from Austin, covering a Houston job: on Houston's board for that visit only. */
  houstonVisitForSam = await visit(houstonJob, samTech, 2);
  await raw`update public.visit set location_id = ${north} where id = ${austinVisit}`;

  const report = async (visitId: string, jobId: string, customerId: string, propertyId: string) => {
    const [row] = await raw<{ id: string }[]>`
      insert into public.service_report (organization_id, visit_id, job_id, customer_id, property_id, summary)
      values (${ORG}, ${visitId}, ${jobId}, ${customerId}, ${propertyId}, 'Checked it over') returning id`;
    return row!.id;
  };
  austinReport = await report(austinVisit, austinJob, austinCustomer, austinProperty);
  houstonReport = await report(houstonVisit, houstonJob, houstonCustomer, houstonProperty);

  await laborSettings.setPolicy(owner(), {
    label: "Federal", timeZone: "America/Chicago", weekStartsOn: 1,
    dayAttribution: "shift_start", weeklyThresholdMinutes: 2400,
    overtimeMultiplier: "1.5", doubleTimeMultiplier: "2",
    onCallTreatment: "separate_rate_not_hours_worked",
    note: "Forty hours a week.",
  });
  /** An hour each, finished, an hour ago. Sam's was on the Houston job. */
  const entry = async (technicianId: string, jobId: string) => {
    const [row] = await raw<{ id: string }[]>`
      insert into public.timeclock_entry (organization_id, technician_id, job_id, started_at, ended_at, minutes)
      values (${ORG}, ${technicianId}, ${jobId}, ${new Date(Date.now() - 7200_000)}, ${new Date(Date.now() - 3600_000)}, 60)
      returning id`;
    return row!.id;
  };
  rayEntry = await entry(rayTech, houstonJob);
  samEntry = await entry(samTech, houstonJob);

  const leave = async (userId: string, technicianDay: number) => (await timeOff.request(
    { actor: { userId, organizationId: ORG, roles: ["technician"] }, db: db() },
    {
      startsAt: new Date(Date.now() + technicianDay * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + (technicianDay + 1) * 86_400_000).toISOString(),
      reason: "Family wedding",
    },
  )).id;
  rayLeave = await leave(RAY, 10);
  samLeave = await leave(SAM, 12);
});

afterAll(async () => { if (raw) await raw.end(); });

run("the Branch manager preset needs a branch", () => {
  it("is refused to somebody in no branch, and to an invite that names none", async () => {
    await expect(team.setRole(owner(), { membershipId: hanaMembership, role: "branch_manager" }))
      .rejects.toThrow(/in no branch/);
    await expect(team.invite(owner(), {
      email: "branch-scope-nobranch@test.local", name: "Nobody's Manager", role: "branch_manager",
    })).rejects.toThrow(/choose their branch/);
  });

  it("is given to somebody once they are in one, and their branch cannot then be taken away", async () => {
    await branches.setMemberBranch(owner(), { membershipId: hanaMembership, businessUnitId: houston });
    const row = await team.setRole(owner(), { membershipId: hanaMembership, role: "branch_manager" });
    expect(row.role).toBe("branch_manager");
    await expect(branches.setMemberBranch(owner(), { membershipId: hanaMembership, businessUnitId: null }))
      .rejects.toThrow(/Branch manager, shows them their branch's work only/);
  });

  it("resolves, signed in, to the office manager's permissions limited to Houston", async () => {
    const hana = await resolve(HANA);
    expect(hana.actor.roles).toEqual(["branch_manager"]);
    expect(hana.actor.businessUnitId).toBe(houston);
  });
});

run("a branch manager's board and map are their branch's", () => {
  it("shows Houston's visits, Houston's people, and Sam only for the Houston visit he covers", async () => {
    const hana = await resolve(HANA);
    const board = await dispatch.board(hana, { date: today() });
    const visits = board.technicians.flatMap((t) => t.visits.map((v) => v.id));
    expect(visits.sort()).toEqual([houstonVisit, houstonVisitForSam].sort());
    expect(board.technicians.map((t) => t.displayName).sort()).toEqual(["Ray Houston", "Sam Austin"]);
    const sam = board.technicians.find((t) => t.id === samTech)!;
    expect(sam.visits.map((v) => v.id)).toEqual([houstonVisitForSam]);

    // The owner sees the whole company, Austin's visit included.
    const all = await dispatch.board(owner(), { date: today() });
    expect(all.technicians.flatMap((t) => t.visits.map((v) => v.id))).toContain(austinVisit);
  });

  it("draws the same day on the map", async () => {
    const hana = await resolve(HANA);
    const map = await dispatchMap.map(hana, { date: today() });
    expect(map.visits.map((v) => v.id).sort()).toEqual([houstonVisit, houstonVisitForSam].sort());
    expect(map.technicians.map((t) => t.id).sort()).toEqual([rayTech, samTech].sort());
  });

  it("cannot put somebody on Austin's visit, which is not there for them", async () => {
    const hana = await resolve(HANA);
    await expect(dispatch.assign(hana, { id: austinVisit, technicianIds: [rayTech] })).rejects.toBeInstanceOf(NotFoundError);
  });
});

run("a branch manager's service reports are their branch's", () => {
  it("lists Houston's report and not Austin's, and Austin's opened by its id is not found", async () => {
    const hana = await resolve(HANA);
    const listed = await serviceReports.list(hana, {});
    expect(listed.reports.map((r) => r.id)).toEqual([houstonReport]);
    await expect(serviceReports.get(hana, { id: austinReport })).rejects.toBeInstanceOf(NotFoundError);
    await expect(serviceReports.publish(hana, { id: austinReport })).rejects.toBeInstanceOf(NotFoundError);
    expect((await serviceReports.get(hana, { id: houstonReport })).id).toBe(houstonReport);
  });
});

run("a branch manager's timesheets and time off are their branch's people", () => {
  it("shows Ray's week and not Sam's, even for the hour Sam worked on a Houston job", async () => {
    const hana = await resolve(HANA);
    const week = await labor.week(hana, { weekOf: today() });
    expect(week.rows.map((r) => r.technicianId)).toEqual([rayTech]);
    await expect(labor.entriesFor(hana, { technicianId: samTech, weekOf: today() })).rejects.toBeInstanceOf(NotFoundError);
    const all = await labor.week(owner(), { weekOf: today() });
    expect(all.rows.map((r) => r.technicianId).sort()).toEqual([rayTech, samTech].sort());
  });

  it("approves nothing without the approval permission, which the office manager preset does not carry", async () => {
    const hana = await resolve(HANA);
    await expect(labor.approve(hana, { entryIds: [rayEntry] })).rejects.toBeInstanceOf(PermissionError);
  });

  it("given approval by name, approves Houston's hours and Houston's leave, and not Austin's", async () => {
    await raw`update public.membership set grants = '["timesheet:approve"]'::jsonb where id = ${hanaMembership}`;
    const hana = await resolve(HANA);
    await expect(labor.approve(hana, { entryIds: [rayEntry, samEntry] })).rejects.toBeInstanceOf(NotFoundError);
    expect(await labor.approve(hana, { entryIds: [rayEntry] })).toEqual({ approved: 1 });

    const queue = await timeOff.pending(hana);
    expect(queue.map((r) => r.id)).toEqual([rayLeave]);
    await expect(timeOff.approve(hana, { id: samLeave })).rejects.toBeInstanceOf(NotFoundError);
    await expect(timeOff.list(hana, { technicianId: samTech })).rejects.toBeInstanceOf(NotFoundError);
    expect((await timeOff.approve(hana, { id: rayLeave })).standing).toBe("approved");
    expect((await timeOff.upcoming(hana)).map((r) => r.id)).toEqual([rayLeave]);
    expect((await timeOff.pending(owner())).map((r) => r.id)).toEqual([samLeave]);
  });
});

run("a branch manager hands out no more than they see", () => {
  it("cannot invite an office manager, who sees the whole company", async () => {
    const hana = await resolve(HANA);
    await expect(team.invite(hana, {
      email: "branch-scope-om@test.local", name: "Whole Company", role: "office_manager",
    })).rejects.toThrow(/sees more of the company than you do/);
  });

  it("cannot invite a preset that sees the whole company, however small its permissions", async () => {
    const hana = await resolve(HANA);
    await expect(team.invite(hana, {
      email: "branch-scope-csr@test.local", name: "Houston Csr", role: "csr",
    })).rejects.toThrow(/sees more of the company than you do/);
  });

  it("invites into their own branch, and not into another", async () => {
    const hana = await resolve(HANA);
    await expect(team.invite(hana, {
      email: "branch-scope-bm-austin@test.local", name: "Austin Deputy", role: "branch_manager", businessUnitId: austin,
    })).rejects.toThrow(/your own branch/);
    const sent = await team.invite(hana, { email: "branch-scope-bm@test.local", name: "Houston Deputy", role: "branch_manager" });
    const [row] = await raw<{ business_unit_id: string }[]>`
      select business_unit_id from public.membership where id = ${sent.membershipId}`;
    expect(row!.business_unit_id).toBe(houston);
  });
});

run("a shop scope, reachable on the roles screen", () => {
  it("needs a shop, and then shows the jobs with a visit from it", async () => {
    const role = await roleService.create(owner(), {
      name: "North yard office", basedOn: "office_manager",
      permissions: ["job:read", "visit:read", "servicereport:read", "timesheet:read"],
      scopes: { job: "location", visit: "location", servicereport: "location", timesheet: "location" },
    });
    await expect(roleService.assign(owner(), { membershipId: louMembership, roleId: role.id }))
      .rejects.toThrow(/location/);
    await branches.setMemberLocation(owner(), { membershipId: louMembership, locationId: north });
    await roleService.assign(owner(), { membershipId: louMembership, roleId: role.id });
    await expect(branches.setMemberLocation(owner(), { membershipId: louMembership, locationId: null }))
      .rejects.toBeInstanceOf(ConflictError);

    const lou = await resolve(LOU);
    expect(lou.actor.locationId).toBe(north);
    const board = await dispatch.board(lou, { date: today() });
    expect(board.technicians.flatMap((t) => t.visits.map((v) => v.id))).toEqual([austinVisit]);
    expect((await serviceReports.list(lou, {})).reports.map((r) => r.id)).toEqual([austinReport]);
  });

  it("sees the work of the people based at the shop, whose day starts there", async () => {
    await raw`update public.technician set home_location_id = ${north} where id = ${rayTech}`;
    try {
      const lou = await resolve(LOU);
      const board = await dispatch.board(lou, { date: today() });
      expect(board.technicians.flatMap((t) => t.visits.map((v) => v.id)).sort())
        .toEqual([austinVisit, houstonVisit, houstonVisitForSam].sort());
      expect(board.technicians.map((t) => t.id)).toContain(rayTech);
    } finally {
      await raw`update public.technician set home_location_id = null where id = ${rayTech}`;
    }
  });
});

run("a technician's board, at their own scope", () => {
  it("is the jobs they are on, and no column for anybody who is not on one of them", async () => {
    const ray: ServiceContext = {
      actor: { userId: RAY, organizationId: ORG, roles: ["technician"] as Actor["roles"], technicianId: rayTech }, db: db(),
    };
    const board = await dispatch.board(ray, { date: today() });
    const visits = board.technicians.flatMap((t) => t.visits.map((v) => v.id));
    expect(visits).not.toContain(austinVisit);
    expect(visits).toContain(houstonVisit);
    expect(board.technicians.find((t) => t.id === samTech)?.visits.map((v) => v.id) ?? []).not.toContain(austinVisit);
  });
});
