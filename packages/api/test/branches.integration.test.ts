import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import * as company from "../src/services/company";
import * as roleService from "../src/services/roles";
import * as branches from "../src/services/branches";
import * as reports from "../src/services/reports";
import { memberActor } from "../src/services/session";
import { inTenant, ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A COMPANY WITH TWO BRANCHES, AND A MANAGER WHO MAY SEE ONE
 *
 * The question this file exists to answer is the one an owner asks before
 * they divide the company up: can the Houston manager see Austin's work? So
 * every assertion here is made as somebody resolved the way a signed in
 * person is (a custom role with a branch scope, assigned to a membership with
 * a branch, read back through `memberActor`), and every read that could leak
 * is tried: the list, the job by id, the customers, the invoices, the
 * estimates, a report, the records behind a report, and a branch filter
 * pointed at the other branch.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("branches:org");
const OWNER = fixtureId("branches:owner");
const MANAGER = fixtureId("branches:houston-manager");
const OTHER_ORG = fixtureId("branches:other-org");
const OTHER_OWNER = fixtureId("branches:other-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] }, db: db() });

let austin = "";
let houston = "";
let retired = "";
let managerMembership = "";
let manager: ServiceContext;

let austinJob = "";
let houstonJob = "";
let nowhereJob = "";
let austinCustomer = "";
let houstonCustomer = "";
let austinInvoice = "";
let houstonInvoice = "";
let austinEstimate = "";
let houstonEstimate = "";

/** The manager as a signed in session would resolve them, today. */
async function resolveManager(): Promise<ServiceContext> {
  const actor = await inTenant(owner(), (tx) => memberActor(tx, ORG, MANAGER));
  if (!actor) throw new Error("The manager has no active membership.");
  return { actor, db: db() };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Two Shops", slug: "branches-two-shops" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_OWNER, name: "Elsewhere", slug: "branches-elsewhere" });

  austin = (await company.createBusinessUnit(owner(), { name: "Austin" })).id;
  houston = (await company.createBusinessUnit(owner(), { name: "Houston" })).id;
  retired = (await company.createBusinessUnit(owner(), { name: "Waco" })).id;
  await company.updateBusinessUnit(owner(), { id: retired, active: false });

  await raw`delete from public."user" where id = ${MANAGER} or email = 'branches-manager@test.local'`;
  await raw`insert into public."user" (id, email, name) values (${MANAGER}, 'branches-manager@test.local', 'Hana Houston')`;
  const [membership] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${MANAGER}, 'office_manager') returning id`;
  managerMembership = membership!.id;

  /**
   * The role an owner builds for a branch manager: the office manager's
   * permissions, every scoped resource limited to their branch.
   */
  const role = await roleService.create(owner(), {
    name: "Branch manager",
    basedOn: "office_manager",
    permissions: ["customer:read", "property:read", "job:read", "job:write", "invoice:read", "estimate:read",
      "report:read", "report.financial:read", "visit:read"],
    scopes: {
      job: "business_unit", customer: "business_unit", invoice: "business_unit", estimate: "business_unit",
      visit: "business_unit", conversation: "business_unit", timesheet: "business_unit", servicereport: "business_unit",
    },
  });
  await branches.setMemberBranch(owner(), { membershipId: managerMembership, businessUnitId: houston });
  await roleService.assign(owner(), { membershipId: managerMembership, roleId: role.id });
  manager = await resolveManager();

  const customer = async (name: string) => (await customers.create(owner(), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id;
  const property = async (customerId: string, line1: string) => (await properties.create(owner(), {
    address: { line1, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id;

  austinCustomer = await customer("Austin Customer");
  houstonCustomer = await customer("Houston Customer");
  const austinProperty = await property(austinCustomer, "1 Congress Ave");
  const houstonProperty = await property(houstonCustomer, "1 Main St");

  const job = async (customerId: string, propertyId: string, summary: string, businessUnitId?: string) =>
    (await jobs.create(owner(), {
      customerId, propertyId, summary, tags: [], customFields: {},
      ...(businessUnitId ? { businessUnitId } : {}),
    })).id;
  austinJob = await job(austinCustomer, austinProperty, "Austin furnace", austin);
  houstonJob = await job(houstonCustomer, houstonProperty, "Houston condenser", houston);
  nowhereJob = await job(austinCustomer, austinProperty, "Booked before branches");

  let number = 7100;
  const invoice = async (customerId: string, jobId: string) => {
    const id = fixtureId(`branches:invoice:${jobId}`);
    await raw`insert into public.invoice (id, organization_id, number, customer_id, job_id, status, subtotal, tax_total, total, balance, issued_on)
              values (${id}, ${ORG}, ${number++}, ${customerId}, ${jobId}, 'open', '100', '0', '100', '100', now()::date)`;
    return id;
  };
  const estimate = async (customerId: string, propertyId: string, jobId: string) => {
    const id = fixtureId(`branches:estimate:${jobId}`);
    await raw`insert into public.estimate (id, organization_id, number, customer_id, property_id, job_id, status)
              values (${id}, ${ORG}, ${number++}, ${customerId}, ${propertyId}, ${jobId}, 'sent')`;
    return id;
  };
  austinInvoice = await invoice(austinCustomer, austinJob);
  houstonInvoice = await invoice(houstonCustomer, houstonJob);
  austinEstimate = await estimate(austinCustomer, austinProperty, austinJob);
  houstonEstimate = await estimate(houstonCustomer, houstonProperty, houstonJob);
});

afterAll(async () => { if (raw) await raw.end(); });

run("a branch scoped manager cannot see another branch's work", () => {
  it("resolves to a branch scope anchored on their branch, the way a session does", () => {
    expect(manager.actor.businessUnitId).toBe(houston);
    expect(manager.actor.scopes?.job).toBe("business_unit");
  });

  it("lists Houston's jobs and not Austin's, nor the ones in no branch", async () => {
    const ids = (await jobs.list(manager, { limit: 100 })).data.map((j) => j.id);
    expect(ids).toContain(houstonJob);
    expect(ids).not.toContain(austinJob);
    expect(ids).not.toContain(nowhereJob);
  });

  it("cannot open an Austin job by its id, and is told it does not exist", async () => {
    await expect(jobs.get(manager, { id: austinJob })).rejects.toThrow(NotFoundError);
    await expect(jobs.get(manager, { id: nowhereJob })).rejects.toThrow(NotFoundError);
    expect((await jobs.get(manager, { id: houstonJob })).id).toBe(houstonJob);
  });

  it("cannot edit an Austin job by its id either", async () => {
    await expect(jobs.update(manager, { id: austinJob, summary: "Mine now" })).rejects.toThrow(NotFoundError);
    const [row] = await raw`select summary from public.job where id = ${austinJob}`;
    expect(row!.summary).toBe("Austin furnace");
  });

  it("sees only the customers Houston has worked for", async () => {
    const ids = (await customers.list(manager, { limit: 100, includeInactive: false })).data.map((c) => c.id);
    expect(ids).toContain(houstonCustomer);
    expect(ids).not.toContain(austinCustomer);
  });

  it("sees only Houston's invoices and estimates", async () => {
    const invoices = (await billing.list(manager, { limit: 100 })).data.map((i) => i.id);
    expect(invoices).toEqual([houstonInvoice]);
    const quoted = (await estimates.list(manager, { limit: 100 })).data.map((e) => e.id);
    expect(quoted).toEqual([houstonEstimate]);
  });

  it("cannot get Austin back by filtering to Austin: a filter narrows, it never widens", async () => {
    expect((await jobs.list(manager, { limit: 100, businessUnitId: austin })).data).toEqual([]);
    expect((await customers.list(manager, { limit: 100, includeInactive: false, businessUnitId: austin })).data).toEqual([]);
    expect((await billing.list(manager, { limit: 100, businessUnitId: austin })).data).toEqual([]);
    expect((await estimates.list(manager, { limit: 100, businessUnitId: austin })).data).toEqual([]);
    expect((await jobs.list(manager, { limit: 100, businessUnitId: "none" })).data).toEqual([]);
  });

  it("counts only Houston in a report, even grouped by branch", async () => {
    const result = await reports.run(manager, { dataset: "jobs", dimensions: ["branch"], measures: ["count"] });
    expect(result.rows).toEqual([{ branch: "Houston", count: 1 }]);
    const money = await reports.run(manager, { dataset: "invoices", dimensions: ["branch"], measures: ["total"] });
    expect(money.rows.map((r) => r.branch)).toEqual(["Houston"]);
  });

  it("opens only Houston's records behind a number", async () => {
    const drilled = await reports.drill(manager, {
      definition: { dataset: "jobs", dimensions: [], measures: ["count"] },
      match: {},
    });
    expect(drilled.rows.map((r) => r.id)).toEqual([houstonJob]);
  });

  it("gets nothing from a report narrowed to Austin", async () => {
    const result = await reports.run(manager, { dataset: "jobs", dimensions: [], measures: ["count"], branchId: austin });
    expect(result.rows).toEqual([{ count: 0 }]);
  });

  it("counts visits through the job, rather than seeing none for want of a technician record", async () => {
    await raw`insert into public.visit (id, organization_id, job_id, sequence, status)
              values (${fixtureId("branches:visit-h")}, ${ORG}, ${houstonJob}, 1, 'scheduled'),
                     (${fixtureId("branches:visit-a")}, ${ORG}, ${austinJob}, 1, 'scheduled')
              on conflict (id) do nothing`;
    const result = await reports.run(manager, { dataset: "visits", dimensions: [], measures: ["count"] });
    expect(result.rows).toEqual([{ count: 1 }]);
  });

  it("only offers the filter to somebody who sees the whole company", async () => {
    const mine = await branches.options(manager);
    expect(mine.narrowed).toBe(true);
    expect(mine.yours).toBe(houston);
    const theirs = await branches.options(owner());
    expect(theirs.narrowed).toBe(false);
    expect(theirs.branches.map((b) => b.name)).toEqual(["Austin", "Houston"]);
  });
});

run("where a new job's branch comes from", () => {
  const book = async (ctx: ServiceContext, extra: { businessUnitId?: string } = {}) => {
    const [cp] = await raw<{ customer_id: string; property_id: string }[]>`
      select customer_id, property_id from public.job where id = ${houstonJob}`;
    return jobs.create(ctx, {
      customerId: cp!.customer_id, propertyId: cp!.property_id, summary: "New work", tags: [], customFields: {},
      ...extra,
    });
  };

  it("lands a job a branch manager books in their own branch, so it does not vanish from their list", async () => {
    const created = await book(manager);
    const [row] = await raw`select business_unit_id from public.job where id = ${created.id}`;
    expect(row!.business_unit_id).toBe(houston);
    expect((await jobs.list(manager, { limit: 100 })).data.map((j) => j.id)).toContain(created.id);
  });

  it("refuses a branch manager putting a job in another branch, which they could not then see", async () => {
    await expect(book(manager, { businessUnitId: austin })).rejects.toThrow(/only put work in your own branch/);
  });

  it("lets somebody who sees the whole company choose, and refuses a retired branch", async () => {
    const created = await book(owner(), { businessUnitId: austin });
    expect(created.businessUnitId).toBe(austin);
    await expect(book(owner(), { businessUnitId: retired })).rejects.toThrow(/retired/);
  });

  it("takes the job type's branch when the person booking has none", async () => {
    const [type] = await raw<{ id: string }[]>`
      insert into public.job_type (organization_id, name, code, business_unit_id)
      values (${ORG}, 'Austin installs', 'austin-install', ${austin}) returning id`;
    const [cp] = await raw<{ customer_id: string; property_id: string }[]>`
      select customer_id, property_id from public.job where id = ${austinJob}`;
    const created = await jobs.create(owner(), {
      customerId: cp!.customer_id, propertyId: cp!.property_id, summary: "Install", tags: [], customFields: {},
      jobTypeId: type!.id,
    });
    expect(created.businessUnitId).toBe(austin);
  });

  it("leaves a job in no branch when nothing says which", async () => {
    const created = await book(owner());
    expect(created.businessUnitId ?? null).toBeNull();
  });

  it("refuses a branch from another company as a branch that does not exist", async () => {
    const foreign = (await company.createBusinessUnit(
      { actor: { userId: OTHER_OWNER, organizationId: OTHER_ORG, roles: ["owner"] }, db: db() },
      { name: "Their branch" },
    )).id;
    await expect(book(owner(), { businessUnitId: foreign })).rejects.toThrow(NotFoundError);
  });
});

run("sorting work and people into branches", () => {
  it("moves jobs in bulk, audits each one, and reports how many moved", async () => {
    const result = await branches.assignJobs(owner(), { jobIds: [nowhereJob], businessUnitId: austin });
    expect(result.moved).toBe(1);
    const again = await branches.assignJobs(owner(), { jobIds: [nowhereJob], businessUnitId: austin });
    expect(again.moved).toBe(0);
    const [audit] = await raw`select after from public.audit_log
      where organization_id = ${ORG} and action = 'job.branch_changed' and entity_id = ${nowhereJob}`;
    expect((audit!.after as { businessUnitId: string }).businessUnitId).toBe(austin);
    // Back where it started, for the counts below.
    await branches.assignJobs(owner(), { jobIds: [nowhereJob], businessUnitId: null });
  });

  it("does not let a branch manager move work between branches", async () => {
    await expect(branches.assignJobs(manager, { jobIds: [houstonJob], businessUnitId: austin }))
      .rejects.toThrow(/sees the whole company/);
  });

  it("counts people and work per branch, and the work in none", async () => {
    const view = await branches.overview(owner());
    const byName = new Map(view.branches.map((b) => [b.name, b]));
    expect(byName.get("Houston")!.people).toBe(1);
    expect(byName.get("Waco")!.active).toBe(false);
    expect(view.unassigned.jobs).toBeGreaterThanOrEqual(1);
  });

  it("refuses to take the branch away from somebody whose role shows them only their branch", async () => {
    await expect(branches.setMemberBranch(owner(), { membershipId: managerMembership, businessUnitId: null }))
      .rejects.toThrow(ConflictError);
    await expect(branches.setMemberBranch(owner(), { membershipId: managerMembership, businessUnitId: retired }))
      .rejects.toThrow(/retired/);
  });

  it("moves a person to another branch, and their view moves with them", async () => {
    await branches.setMemberBranch(owner(), { membershipId: managerMembership, businessUnitId: austin });
    const moved = await resolveManager();
    const ids = (await jobs.list(moved, { limit: 100 })).data.map((j) => j.id);
    expect(ids).toContain(austinJob);
    expect(ids).not.toContain(houstonJob);
    await branches.setMemberBranch(owner(), { membershipId: managerMembership, businessUnitId: houston });
  });
});

run("a branch chosen on a list or a report, by somebody who sees everything", () => {
  it("narrows each main list to the branch", async () => {
    expect((await jobs.list(owner(), { limit: 100, businessUnitId: austin })).data.map((j) => j.id)).toContain(austinJob);
    expect((await jobs.list(owner(), { limit: 100, businessUnitId: austin })).data.map((j) => j.id)).not.toContain(houstonJob);
    expect((await jobs.list(owner(), { limit: 100, businessUnitId: "none" })).data.map((j) => j.id)).toContain(nowhereJob);
    expect((await customers.list(owner(), { limit: 100, includeInactive: false, businessUnitId: houston })).data.map((c) => c.id))
      .toEqual([houstonCustomer]);
    expect((await billing.list(owner(), { limit: 100, businessUnitId: austin })).data.map((i) => i.id)).toEqual([austinInvoice]);
    expect((await estimates.list(owner(), { limit: 100, businessUnitId: austin })).data.map((e) => e.id)).toEqual([austinEstimate]);
  });

  it("narrows a report to the branch, and the drill with it", async () => {
    const definition = { dataset: "invoices", dimensions: [], measures: ["total"], branchId: austin };
    const result = await reports.run(owner(), definition);
    expect(result.rows[0]!.total).toBe("100.0000");
    const drilled = await reports.drill(owner(), { definition, match: {} });
    expect(drilled.rows.map((r) => r.id)).toEqual([austinInvoice]);
  });

  it("groups by branch, with the work in no branch as its own group", async () => {
    const result = await reports.run(owner(), { dataset: "jobs", dimensions: ["branch"], measures: ["count"] });
    const names = result.rows.map((r) => r.branch);
    expect(names).toContain("Austin");
    expect(names).toContain("Houston");
    expect(names).toContain("No branch");
  });

  it("refuses to narrow a report whose records do not belong to branches, rather than ignoring the branch", async () => {
    await expect(reports.run(owner(), { dataset: "tasks", dimensions: [], measures: ["count"], branchId: austin }))
      .rejects.toThrow(/do not belong to branches/);
  });
});

run("everybody without a branch scope is unchanged", () => {
  it("still shows an owner every job, whatever branch they are in", async () => {
    const ids = (await jobs.list(owner(), { limit: 100 })).data.map((j) => j.id);
    expect(ids).toEqual(expect.arrayContaining([austinJob, houstonJob, nowhereJob]));
  });

  it("still shows an office manager on the preset every job", async () => {
    const preset: Actor = { userId: OWNER, organizationId: ORG, roles: ["office_manager"], businessUnitId: houston };
    const ids = (await jobs.list({ actor: preset, db: db() }, { limit: 100 })).data.map((j) => j.id);
    expect(ids).toEqual(expect.arrayContaining([austinJob, houstonJob, nowhereJob]));
  });
});
