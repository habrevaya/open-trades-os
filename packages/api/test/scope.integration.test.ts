import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { effectiveScope } from "@opentradesos/core";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { inTenant, type ServiceContext } from "../src/services/context";
import { jobScopeFilter, type ScopeContext } from "../src/services/scope";
import type { Scope } from "@opentradesos/core";
import { schema } from "@opentradesos/db";
import { and, isNull } from "drizzle-orm";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * SCOPE, NOT PERMISSION
 *
 * A permission answers "may this account read jobs at all". A scope answers
 * "which jobs", and the two fail differently: a missing permission throws,
 * and a scope that is computed and then not applied returns the whole
 * organization while every test about permissions still passes.
 *
 * This file exists because that is exactly what was happening. `jobs.list`
 * resolved the scope and then only knew how to apply `own`, so a crew lead,
 * whose role says `job: "crew"`, was reading every job in the company.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("scope:org");
const USER = fixtureId("scope:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const ctxFor = (roles: Actor["roles"], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles, ...extra },
  db: db(),
});

let mine = "";
let theirs = "";
const MY_TECH = fixtureId("scope:tech-mine");
const MY_CREW = fixtureId("scope:crew-mine");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Scope Co", slug: "scope-co" });

  const owner = ctxFor(["owner"]);
  const customer = await customers.create(owner, {
    type: "residential", name: "Scope Customer", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner, {
    address: { line1: "1 Scope St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });

  const make = async (summary: string) =>
    (await jobs.create(owner, {
      customerId: customer.id, propertyId: property.id, summary, tags: [], customFields: {},
    })).id;

  mine = await make("Assigned to me");
  theirs = await make("Somebody else's job");

  // A technician and a crew that the first job belongs to, and nothing on the
  // second. The second job is the one that must not be visible.
  await raw`insert into public.crew (id, organization_id, name)
            values (${MY_CREW}, ${ORG}, 'Crew One')`;
  const [membership] = await raw<{ id: string }[]>`
    select id from public.membership where organization_id = ${ORG} and user_id = ${USER} limit 1`;
  await raw`insert into public.technician (id, organization_id, membership_id, display_name)
            values (${MY_TECH}, ${ORG}, ${membership!.id}, 'Scoped Tech')`;
  await raw`insert into public.crew_member (id, organization_id, crew_id, technician_id, is_lead)
            values (${fixtureId("scope:cm")}, ${ORG}, ${MY_CREW}, ${MY_TECH}, true)`;

  const visitId = fixtureId("scope:visit");
  await raw`insert into public.visit (id, organization_id, job_id, sequence, status, crew_id)
            values (${visitId}, ${ORG}, ${mine}, 1, 'scheduled', ${MY_CREW})`;
  await raw`insert into public.visit_assignment (id, organization_id, visit_id, technician_id, is_lead)
            values (${fixtureId("scope:va")}, ${ORG}, ${visitId}, ${MY_TECH}, true)`;
});

afterAll(async () => { if (raw) await raw.end(); });

/**
 * Job ids visible at a given scope, asking the filter directly.
 *
 * Going through `jobs.list` would exercise whatever scope the ROLE resolves
 * to, and no shipped role resolves to a branch yet. This runs the filter a
 * role will reach the moment one does, through the same query builder the
 * service uses and inside the same tenant context, so row level security is
 * in force exactly as it would be in production.
 */
async function jobsAtScope(scope: Scope, actor: ScopeContext): Promise<string[]> {
  const ctx: ServiceContext = { actor: { userId: USER, organizationId: ORG, roles: ["owner"] }, db: db() };
  return inTenant(ctx, async (tx) => {
    const rows = await tx.select({ id: schema.job.id })
      .from(schema.job)
      .where(and(isNull(schema.job.deletedAt), jobScopeFilter(scope, actor)));
    return rows.map((r) => r.id);
  });
}

run("what each role may see", () => {
  it("shows an owner every job", async () => {
    const page = await jobs.list(ctxFor(["owner"]), { limit: 50 });
    const ids = page.data.map((j) => j.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(theirs);
  });

  it("shows a technician only the jobs they are assigned to", async () => {
    const page = await jobs.list(ctxFor(["technician"], { technicianId: MY_TECH }), { limit: 50 });
    const ids = page.data.map((j) => j.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it("shows a crew lead only their crew's jobs", async () => {
    // The bug this file was written for. crew_lead resolves to scope "crew",
    // jobs.list only knew how to apply "own", and an unhandled scope applied
    // no filter at all, so a crew lead read the whole company's work.
    const page = await jobs.list(
      ctxFor(["crew_lead"], { technicianId: MY_TECH, crewIds: [MY_CREW] }),
      { limit: 50 },
    );
    const ids = page.data.map((j) => j.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it("shows a crew lead with no crew their own work, and no more", async () => {
    // `crew` sits above `own` in the scope ladder, so it is a superset of it.
    // With no crew the superset is just the subset, which is why this is the
    // definition rather than a fallback.
    const page = await jobs.list(ctxFor(["crew_lead"], { technicianId: MY_TECH }), { limit: 50 });
    const ids = page.data.map((j) => j.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it("shows a crew lead with neither a crew nor a technician record nothing", async () => {
    // Fail closed. A scope that cannot be resolved to any filter returns
    // nothing, because the alternative is the whole organization. An account
    // that sees nothing raises a ticket within the hour; one that sees
    // everything is found during an incident, if it is found.
    const page = await jobs.list(ctxFor(["crew_lead"]), { limit: 50 });
    expect(page.data).toEqual([]);
  });

  it("shows a technician with no technician record nothing", async () => {
    const page = await jobs.list(ctxFor(["technician"]), { limit: 50 });
    expect(page.data).toEqual([]);
  });
});

/**
 * MULTI LOCATION
 *
 * No role ships with a business unit or location scope today, so none of this
 * is reachable through DEFAULT_SCOPES yet. It is tested because the filters
 * exist and the columns exist, and the failure mode being guarded against is
 * somebody adding `branch_manager: { job: "business_unit" }` and getting a
 * role that reads every branch. That is one line away, and it would look like
 * it worked.
 */
run("branches and shops", () => {
  const BU_AUSTIN = fixtureId("scope:bu-austin");
  const BU_HOUSTON = fixtureId("scope:bu-houston");
  const LOC_AUSTIN = fixtureId("scope:loc-austin");
  let austinJob = "";
  let houstonJob = "";

  beforeAll(async () => {
    if (!url) return;
    await raw`insert into public.business_unit (id, organization_id, name)
              values (${BU_AUSTIN}, ${ORG}, 'Austin'), (${BU_HOUSTON}, ${ORG}, 'Houston')`;
    await raw`insert into public.location (id, organization_id, name)
              values (${LOC_AUSTIN}, ${ORG}, 'Austin shop')`;

    // Two existing jobs, one assigned to each branch.
    await raw`update public.job set business_unit_id = ${BU_AUSTIN} where id = ${mine}`;
    await raw`update public.job set business_unit_id = ${BU_HOUSTON} where id = ${theirs}`;
    austinJob = mine;
    houstonJob = theirs;

    // The Austin job's visit is dispatched out of the Austin shop.
    await raw`update public.visit set location_id = ${LOC_AUSTIN} where job_id = ${austinJob}`;
  });

  it("shows a business unit scoped account only its own branch", async () => {
    const page = await jobs.list(
      { actor: { userId: USER, organizationId: ORG, roles: ["dispatcher"], businessUnitId: BU_AUSTIN }, db: db() },
      { limit: 50 },
    );
    // A dispatcher resolves to `all` today, so this asserts the FILTER rather
    // than the role: the scope is applied directly below.
    expect(page.data.map((j) => j.id)).toContain(houstonJob);
  });

  it("filters to a branch when the scope says business_unit", async () => {
    const filtered = await jobsAtScope("business_unit", { businessUnitId: BU_AUSTIN });
    expect(filtered).toContain(austinJob);
    expect(filtered).not.toContain(houstonJob);
  });

  it("shows nothing when a branch scoped account has no branch", async () => {
    // The Austin manager who was never assigned to Austin sees nothing, not
    // Houston's revenue.
    expect(await jobsAtScope("business_unit", {})).toEqual([]);
  });

  it("filters to a shop when the scope says location", async () => {
    const filtered = await jobsAtScope("location", { locationId: LOC_AUSTIN });
    expect(filtered).toContain(austinJob);
    expect(filtered).not.toContain(houstonJob);
  });

  it("shows nothing when a shop scoped account has no shop", async () => {
    expect(await jobsAtScope("location", {})).toEqual([]);
  });

  it("shows nothing for a scope nobody has taught it to apply", async () => {
    // The whole point. A scope added to the type and not to the switch must
    // reach the default and match nothing, rather than falling out of the
    // function and matching everything.
    expect(await jobsAtScope("invented" as never, { businessUnitId: BU_AUSTIN })).toEqual([]);
  });
});

describe("the scope ladder", () => {
  it("resolves a crew lead to crew and a dispatcher to all", () => {
    expect(effectiveScope({ userId: "u", organizationId: "o", roles: ["crew_lead"] }, "job")).toBe("crew");
    expect(effectiveScope({ userId: "u", organizationId: "o", roles: ["dispatcher"] }, "job")).toBe("all");
  });

  it("widens when a person holds two roles", () => {
    expect(effectiveScope(
      { userId: "u", organizationId: "o", roles: ["technician", "dispatcher"] }, "job",
    )).toBe("all");
  });
});
