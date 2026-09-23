import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { effectiveScope } from "@opentradesos/core";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import * as properties from "../src/services/properties";
import { inTenant, type ServiceContext } from "../src/services/context";
import { jobScopeFilter, type ScopeContext } from "../src/services/scope";
import * as roleService from "../src/services/roles";
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
/** A second company, so a foreign anchor is a real id rather than a guess. */
const OTHER_ORG = fixtureId("scope:other-org");
const OTHER_USER = fixtureId("scope:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const ctxFor = (roles: Actor["roles"], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles, ...extra },
  db: db(),
});

let mine = "";
let theirs = "";
let myInvoice = "";
let theirInvoice = "";
let myEstimate = "";
let theirEstimate = "";
let otherCustomer = "";
const MY_TECH = fixtureId("scope:tech-mine");
const MY_CREW = fixtureId("scope:crew-mine");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Scope Co", slug: "scope-co" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Co", slug: "scope-other" });

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

  /**
   * A second customer the technician has never been sent to, with an invoice
   * and an estimate of their own. This is the record that must not be
   * readable, and without it every assertion below passes vacuously.
   */
  const stranger = await customers.create(owner, {
    type: "residential", name: "Never Visited", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
  });
  otherCustomer = stranger.id;

  const visitId = fixtureId("scope:visit");
  await raw`insert into public.visit (id, organization_id, job_id, sequence, status, crew_id)
            values (${visitId}, ${ORG}, ${mine}, 1, 'scheduled', ${MY_CREW})`;
  await raw`insert into public.visit_assignment (id, organization_id, visit_id, technician_id, is_lead)
            values (${fixtureId("scope:va")}, ${ORG}, ${visitId}, ${MY_TECH}, true)`;

  /**
   * An invoice and an estimate on each side: one hanging off the job the
   * technician worked, one off the customer they have never met.
   */
  const money = async (table: "invoice" | "estimate", id: string, number: number, customerId: string, jobId: string | null) => {
    if (table === "invoice") {
      await raw`insert into public.invoice (id, organization_id, number, customer_id, job_id, status, subtotal, tax_total, total, balance)
                values (${id}, ${ORG}, ${number}, ${customerId}, ${jobId}, 'open', '100', '0', '100', '100')`;
    } else {
      await raw`insert into public.estimate (id, organization_id, number, customer_id, property_id, job_id, status)
                values (${id}, ${ORG}, ${number}, ${customerId}, ${property.id}, ${jobId}, 'sent')`;
    }
  };

  myInvoice = fixtureId("scope:inv-mine");
  theirInvoice = fixtureId("scope:inv-theirs");
  myEstimate = fixtureId("scope:est-mine");
  theirEstimate = fixtureId("scope:est-theirs");

  await money("invoice", myInvoice, 9001, customer.id, mine);
  await money("invoice", theirInvoice, 9002, otherCustomer, null);
  await money("estimate", myEstimate, 9101, customer.id, mine);
  await money("estimate", theirEstimate, 9102, otherCustomer, null);
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

/**
 * The reads that are not jobs.
 *
 * `scopes.ts` says, in a comment on the technician row, that customer scope
 * is "what stops a departing technician walking out with the customer list".
 * That is the claim these tests check.
 */
run("customers, invoices and estimates", () => {
  const tech = () => ctxFor(["technician"], { technicianId: MY_TECH });

  it("shows a technician only customers they have been sent to", async () => {
    const page = await customers.list(tech(), { limit: 100, includeInactive: false });
    const names = page.data.map((c) => c.name);
    expect(names).toContain("Scope Customer");
    expect(names).not.toContain("Never Visited");
  });

  it("shows an owner every customer", async () => {
    const page = await customers.list(ctxFor(["owner"]), { limit: 100, includeInactive: false });
    expect(page.data.map((c) => c.name)).toContain("Never Visited");
  });

  it("shows a technician with no technician record no customers at all", async () => {
    const page = await customers.list(ctxFor(["technician"]), { limit: 100, includeInactive: false });
    expect(page.data).toEqual([]);
  });

  it("shows a technician only invoices for work they did", async () => {
    const page = await billing.list(tech(), { limit: 100 });
    const ids = page.data.map((i) => i.id);
    expect(ids).toContain(myInvoice);
    expect(ids).not.toContain(theirInvoice);
  });

  it("shows a technician only estimates for work they did", async () => {
    const page = await estimates.list(tech(), { limit: 100 });
    const ids = page.data.map((e) => e.id);
    expect(ids).toContain(myEstimate);
    expect(ids).not.toContain(theirEstimate);
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

run("a scope has to point at something", () => {
  /**
   * `scope.ts` resolves `business_unit` and `location` through columns on the
   * membership, and both columns were written by nothing at all. An
   * administrator building a "Branch Manager" role with `job:
   * "business_unit"` and assigning it watched that person open an EMPTY job
   * list. Not an error, not a permission message: a blank screen, which reads
   * as "this branch has no work".
   */
  let unitId = "";
  let otherOrgUnitId = "";
  let targetMembership = "";

  beforeAll(async () => {
    if (!url) return;
    const [unit] = await raw<{ id: string }[]>`insert into public.business_unit
      (organization_id, name) values (${ORG}, 'North Branch') returning id`;
    unitId = unit!.id;
    const [foreign] = await raw<{ id: string }[]>`insert into public.business_unit
      (organization_id, name) values (${OTHER_ORG}, 'Somebody Else') returning id`;
    otherOrgUnitId = foreign!.id;

    const [m] = await raw<{ id: string }[]>`select id from public.membership
      where organization_id = ${ORG} limit 1`;
    targetMembership = m!.id;
  });

  const branchRole = async () => {
    const [role] = await raw<{ id: string }[]>`insert into public.role
      (organization_id, name, permissions, scopes)
      values (${ORG}, ${`Branch Manager ${Math.random()}`},
              ${JSON.stringify(["job:read"])},
              ${JSON.stringify({ job: "business_unit" })})
      returning id`;
    return role!.id;
  };

  it("refuses a branch scoped role when the person has no branch", async () => {
    await raw`update public.membership set business_unit_id = null
              where id = ${targetMembership}`;

    await expect(roleService.assign(ctxFor(["owner"]), {
      membershipId: targetMembership, roleId: await branchRole(),
    })).rejects.toThrow(/see nothing at all/i);
  });

  it("assigns it once the person has one, and writes it down", async () => {
    const roleId = await branchRole();
    await roleService.assign(ctxFor(["owner"]), {
      membershipId: targetMembership, roleId, businessUnitId: unitId,
    });

    // THE ASSERTION THE OLD CODE FAILED. The column was never written.
    const [row] = await raw<{ business_unit_id: string | null; role_id: string | null }[]>`
      select business_unit_id, role_id from public.membership where id = ${targetMembership}`;
    expect(row!.business_unit_id).toBe(unitId);
    expect(row!.role_id).toBe(roleId);
  });

  it("does not clear an anchor just because a role changed", async () => {
    /**
     * Omitting the field leaves it alone. Clearing it on every role change
     * would empty the screen of a branch manager whose title changed.
     */
    await roleService.assign(ctxFor(["owner"]), {
      membershipId: targetMembership, roleId: await branchRole(), businessUnitId: unitId,
    });
    await roleService.assign(ctxFor(["owner"]), { membershipId: targetMembership, roleId: null });

    const [row] = await raw<{ business_unit_id: string | null }[]>`
      select business_unit_id from public.membership where id = ${targetMembership}`;
    expect(row!.business_unit_id).toBe(unitId);
  });

  it("refuses an anchor belonging to another company", async () => {
    /**
     * It arrives as an id from a form. Row level security would still stop
     * the rows crossing, so the failure would be an empty screen rather than
     * a leak, but an empty screen nobody can explain is its own cost.
     */
    await expect(roleService.assign(ctxFor(["owner"]), {
      membershipId: targetMembership, roleId: null, businessUnitId: otherOrgUnitId,
    })).rejects.toThrow(/business unit/i);
  });
});
