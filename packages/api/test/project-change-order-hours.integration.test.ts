import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as projects from "../src/services/projects";
import * as changeOrders from "../src/services/project-change-orders";
import * as jobs from "../src/services/jobs";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M12. A CHANGE ORDER'S CREW HOURS ACROSS SEVERAL JOBS.
 *
 * Hours are job by job: each a job of the project's own, once, with more than
 * nought hours. Approved, they come off each job's hours in the budgeted hour
 * variance. The page the customer signs lists them and the signature covers
 * the list. The one-job way of writing them still works, and a change order
 * made before the split still counts its one job's hours, once.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("co-hours:org");
const USER = fixtureId("co-hours:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});

let projectId = "";
let kitchen = "";
let bath = "";
let elsewhere = "";
let seq = 0;

async function job(summary: string, inProject: boolean): Promise<string> {
  seq += 1;
  const [customer] = await raw<{ id: string }[]>`select id from public.customer where organization_id = ${ORG} limit 1`;
  const [property] = await raw<{ id: string }[]>`select id from public.property where organization_id = ${ORG} limit 1`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${1000 + seq}, ${customer!.id}, ${property!.id}, 'scheduled', ${summary}) returning id`;
  if (inProject) await raw`insert into public.project_job (organization_id, project_id, job_id) values (${ORG}, ${projectId}, ${row!.id})`;
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Hours Co", slug: "co-hours-co" });
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, email) values (${ORG}, 'residential', 'Mia Hours', 'mia@hours.test') returning id`;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code) values (${ORG}, '2 Hours Way', 'Austin', 'TX', '78704') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customer!.id}, ${property!.id})`;
  const project = await projects.create(owner(), {
    customerId: customer!.id, propertyId: property!.id, name: "Two room remodel", contractValue: "50000", budgetCost: "30000",
  });
  projectId = project.id;
  kitchen = await job("Kitchen", true);
  bath = await job("Bath", true);
  elsewhere = await job("Someone else's", false);
});

const sentOrder = async (hours: { jobId: string; crewHours: string }[]) => {
  const made = await changeOrders.request(owner(), { projectId, title: "More circuits", hours });
  const [item] = await raw<{ id: string }[]>`insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'service', ${`C-${seq++}`}) returning id`;
  await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, effective_from)
    values (${ORG}, ${item!.id}, 1, 'Circuit', '450', '180', now() - interval '1 day')`;
  await changeOrders.addLine(owner(), { changeOrderId: made.id, priceBookItemId: item!.id, quantity: "2" });
  const sent = await changeOrders.send(owner(), { id: made.id, channel: "link" });
  return { id: made.id, token: sent.url!.split("/").pop()! };
};

run("a change order's crew hours across jobs", () => {
  it("splits the hours across the project's jobs, in the order of the jobs' numbers, with the total and no single job", async () => {
    const made = await changeOrders.request(owner(), {
      projectId, title: "More circuits", hours: [{ jobId: bath, crewHours: "4" }, { jobId: kitchen, crewHours: "6.5" }],
    });
    expect(made.crewHours).toBe("10.5000");
    expect(made.jobId).toBeNull();
    expect(made.hours.map((h) => [h.jobLabel, h.crewHours])).toEqual([["Job 1001", "6.5000"], ["Job 1002", "4.0000"]]);

    // Replaced whole, and an empty list clears them.
    const changed = await changeOrders.update(owner(), { id: made.id, hours: [{ jobId: bath, crewHours: "3" }] });
    expect(changed).toMatchObject({ crewHours: "3.0000", jobId: bath });
    const cleared = await changeOrders.update(owner(), { id: made.id, hours: [] });
    expect(cleared).toMatchObject({ crewHours: null, jobId: null, hours: [] });
  });

  it("refuses a job twice, a job of another project, no hours, a mix of the two ways, and one figure on a split order", async () => {
    await expect(changeOrders.request(owner(), { projectId, title: "x", hours: [{ jobId: bath, crewHours: "1" }, { jobId: bath, crewHours: "2" }] }))
      .rejects.toThrow(/named twice/);
    await expect(changeOrders.request(owner(), { projectId, title: "x", hours: [{ jobId: elsewhere, crewHours: "1" }] }))
      .rejects.toThrow(/not part of this project/);
    await expect(changeOrders.request(owner(), { projectId, title: "x", hours: [{ jobId: bath, crewHours: "0" }] }))
      .rejects.toThrow(/more than nought/);
    await expect(changeOrders.request(owner(), { projectId, title: "x", crewHours: "2", jobId: bath, hours: [{ jobId: kitchen, crewHours: "1" }] }))
      .rejects.toThrow(/not both/);
    const split = await changeOrders.request(owner(), { projectId, title: "x", hours: [{ jobId: bath, crewHours: "1" }, { jobId: kitchen, crewHours: "2" }] });
    await expect(changeOrders.update(owner(), { id: split.id, crewHours: "5" })).rejects.toThrow(ConflictError);
    await expect(changeOrders.update(owner(), { id: split.id, crewHours: "5" })).rejects.toThrow(/split across several jobs/);
  });

  it("still takes the one-job way, as a list of one, and changes that figure alone", async () => {
    const made = await changeOrders.request(owner(), { projectId, title: "x", crewHours: "6", jobId: bath });
    expect(made).toMatchObject({ crewHours: "6.0000", jobId: bath });
    expect(made.hours).toHaveLength(1);
    const moved = await changeOrders.update(owner(), { id: made.id, crewHours: "8" });
    expect(moved).toMatchObject({ crewHours: "8.0000", jobId: bath });
    await expect(changeOrders.request(owner(), { projectId, title: "x", crewHours: "2" })).rejects.toThrow(/Give both, or neither/);
  });

  it("takes each job's approved hours off that job, and counts a change order from before the split once", async () => {
    const { id, token } = await sentOrder([{ jobId: kitchen, crewHours: "6" }, { jobId: bath, crewHours: "2.5" }]);
    const before = async (jobId: string) => (await jobs.hoursAgainstBudget(owner(), { id: jobId })).approvedChangeHours;
    expect([await before(kitchen), await before(bath)]).toEqual(["0.00", "0.00"]);
    await changeOrders.approveForCustomer(db(), { token, signerName: "Mia Hours", acceptedTerms: true });
    expect([await before(kitchen), await before(bath)]).toEqual(["6.00", "2.50"]);
    expect((await changeOrders.get(owner(), { id })).status).toBe("approved");

    // Made before the split: the one job's hours live on the change order itself.
    seq += 1;
    await raw`insert into public.project_change_order (organization_id, project_id, number, title, status, crew_hours, job_id)
      values (${ORG}, ${projectId}, 90, 'Old way', 'approved', '3', ${kitchen})`;
    expect(await before(kitchen)).toBe("9.00");
    const [old] = await raw<{ id: string }[]>`select id from public.project_change_order where number = 90 and project_id = ${projectId}`;
    expect(await changeOrders.get(owner(), { id: old!.id })).toMatchObject({ crewHours: "3.0000", jobId: kitchen });
  });

  it("empties the old columns when a change order from before the split is edited, so nothing counts twice", async () => {
    await raw`insert into public.project_change_order (organization_id, project_id, number, title, status, crew_hours, job_id)
      values (${ORG}, ${projectId}, 91, 'Old way', 'requested', '3', ${kitchen})`;
    const [old] = await raw<{ id: string }[]>`select id from public.project_change_order where number = 91 and project_id = ${projectId}`;
    const edited = await changeOrders.update(owner(), { id: old!.id, hours: [{ jobId: kitchen, crewHours: "3" }, { jobId: bath, crewHours: "1" }] });
    expect(edited.crewHours).toBe("4.0000");
    const [columns] = await raw<{ crew_hours: string | null; job_id: string | null }[]>`
      select crew_hours, job_id from public.project_change_order where id = ${old!.id}`;
    expect(columns).toEqual({ crew_hours: null, job_id: null });
    await raw`update public.project_change_order set status = 'approved' where id = ${old!.id}`;
    expect((await jobs.hoursAgainstBudget(owner(), { id: kitchen })).approvedChangeHours).toBe("3.00");
  });

  it("lists the hours on the page the customer signs, signs them with it, and refuses them changing after it is sent", async () => {
    const { id, token } = await sentOrder([{ jobId: kitchen, crewHours: "6" }, { jobId: bath, crewHours: "1" }]);
    const seen = await changeOrders.viewForCustomer(db(), { token });
    expect(seen.crewHours).toEqual([{ jobLabel: "Job 1001", hours: "6.0000" }, { jobLabel: "Job 1002", hours: "1.0000" }]);

    await expect(changeOrders.update(owner(), { id, hours: [{ jobId: kitchen, crewHours: "60" }] })).rejects.toThrow(/cannot be changed/);
    const signed = await changeOrders.approveForCustomer(db(), { token, signerName: "Mia Hours", acceptedTerms: true });
    expect(signed.status).toBe("approved");
    expect(signed.crewHours).toHaveLength(2);

    // The printed copy reads the same, and the signature's hash is the one the page was signed against.
    const printed = await changeOrders.documentFor(owner(), { id });
    expect(printed.crewHoursListed).toEqual(signed.crewHours);
    const [signature] = await raw<{ document_hash: string }[]>`
      select document_hash from public.document_signature where subject = 'change_order' and subject_id = ${id}`;
    expect(signature!.document_hash).toBe(printed.documentHash);
  });

  it("lists no hours on a change order that adds none, and signs it as it always was", async () => {
    const { token } = await sentOrder([]);
    expect((await changeOrders.viewForCustomer(db(), { token })).crewHours).toEqual([]);
    expect((await changeOrders.approveForCustomer(db(), { token, signerName: "Mia Hours", acceptedTerms: true })).status).toBe("approved");
  });
});
