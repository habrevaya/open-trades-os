import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { PermissionError } from "@opentradesos/core";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { canTransition } from "../src/services/jobs";
import { NotFoundError, ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG_A = fixtureId("jobupdate:org-a");
const ORG_B = fixtureId("jobupdate:org-b");
const USER_A = fixtureId("jobupdate:user-a");
const USER_B = fixtureId("jobupdate:user-b");

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctxFor = (organizationId: string, userId: string, roles: Actor["roles"]): ServiceContext =>
  ({ actor: { userId, organizationId, roles }, db: db() });
const owner = () => ctxFor(ORG_A, USER_A, ["owner"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG_A, userId: USER_A, name: "Edit Co", slug: "edit-job" });
  await seedOrg(raw, { organizationId: ORG_B, userId: USER_B, name: "Other Edit", slug: "other-job" });
});
afterAll(async () => { if (raw) await raw.end(); });

async function aJob(summary = "A job") {
  const customer = await customers.create(owner(), {
    type: "residential", name: "Job Customer", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "1 Job St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  return jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary,
    tags: [], customFields: {},
  });
}

/**
 * The status graph, as a pure function.
 *
 * A permissive graph does not fail loudly. It succeeds, and a job that has
 * been invoiced quietly returns to "lead" while the ledger entries it
 * produced go on pointing at work the board now says has not started.
 */
describe("which transitions are allowed", () => {
  it("lets an ordinary job walk forward", () => {
    expect(canTransition("lead", "scheduled")).toBe(true);
    expect(canTransition("scheduled", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "completed")).toBe(true);
    expect(canTransition("completed", "invoiced")).toBe(true);
    expect(canTransition("invoiced", "paid")).toBe(true);
  });

  it("allows a no-op, because an update that does not change status must not fail", () => {
    for (const s of ["lead", "scheduled", "in_progress", "completed", "invoiced", "paid", "cancelled"]) {
      expect(canTransition(s, s), s).toBe(true);
    }
  });

  it("refuses to walk an invoiced job back to a lead", () => {
    expect(canTransition("invoiced", "lead")).toBe(false);
    expect(canTransition("invoiced", "scheduled")).toBe(false);
    expect(canTransition("paid", "in_progress")).toBe(false);
  });

  it("treats paid and cancelled as final", () => {
    for (const to of ["lead", "scheduled", "in_progress", "completed", "invoiced"]) {
      expect(canTransition("paid", to), `paid -> ${to}`).toBe(false);
      expect(canTransition("cancelled", to), `cancelled -> ${to}`).toBe(false);
    }
  });

  it("lets a completed job reopen, because technicians get called back", () => {
    expect(canTransition("completed", "in_progress")).toBe(true);
  });

  it("lets an invoiced job go back to completed, for a voided invoice", () => {
    expect(canTransition("invoiced", "completed")).toBe(true);
  });

  it("lets anything unfinished be cancelled", () => {
    for (const from of ["lead", "estimating", "scheduled", "in_progress", "on_hold", "completed"]) {
      expect(canTransition(from, "cancelled"), from).toBe(true);
    }
  });

  it("knows nothing about a status that does not exist", () => {
    expect(canTransition("invented", "scheduled")).toBe(false);
  });
});

run("updating a job", () => {
  it("edits the fields the office actually changes", async () => {
    const job = await aJob();
    const updated = await jobs.update(owner(), {
      id: job.id,
      summary: "No cooling, upstairs zone",
      customerComplaint: "Will not get below 80 upstairs. Downstairs is fine.",
      tags: ["callback"],
    });
    expect(updated.summary).toBe("No cooling, upstairs zone");
    expect(updated.customerComplaint).toMatch(/below 80/);
    expect(updated.tags).toEqual(["callback"]);
  });

  it("leaves untouched fields alone", async () => {
    const job = await aJob("Original summary");
    const updated = await jobs.update(owner(), { id: job.id, tags: ["tagged"] });
    expect(updated.summary).toBe("Original summary");
  });

  it("stamps completedAt when a job reaches completed", async () => {
    // A job that is "completed" with no timestamp is invisible to every
    // report that asks what was finished this week.
    const job = await aJob();
    await jobs.update(owner(), { id: job.id, status: "scheduled" });
    const done = await jobs.update(owner(), { id: job.id, status: "completed" });
    expect(done.completedAt).toBeTruthy();
  });

  it("does not move completedAt on a later edit", async () => {
    const job = await aJob();
    await jobs.update(owner(), { id: job.id, status: "scheduled" });
    const first = await jobs.update(owner(), { id: job.id, status: "completed" });
    const later = await jobs.update(owner(), { id: job.id, summary: "Edited after completion" });
    expect(String(later.completedAt)).toBe(String(first.completedAt));
  });

  it("stamps cancelledAt when a job is cancelled", async () => {
    const job = await aJob();
    const cancelled = await jobs.update(owner(), { id: job.id, status: "cancelled" });
    expect(cancelled.cancelledAt).toBeTruthy();
  });

  it("refuses to walk an invoiced job back to a lead", async () => {
    const job = await aJob();
    await jobs.update(owner(), { id: job.id, status: "scheduled" });
    await jobs.update(owner(), { id: job.id, status: "completed" });
    await jobs.update(owner(), { id: job.id, status: "invoiced" });

    await expect(jobs.update(owner(), { id: job.id, status: "lead" }))
      .rejects.toThrow(ConflictError);

    // And the job is unchanged, rather than half-updated.
    const after = await jobs.get(owner(), { id: job.id });
    expect(after.status).toBe("invoiced");
  });

  it("writes an audit row naming what changed", async () => {
    const job = await aJob();
    await jobs.update(owner(), { id: job.id, summary: "Audited change" });
    const rows = await raw`
      select action from public.audit_log
      where entity_type = 'job' and entity_id = ${job.id} and action = 'job.updated'`;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("refuses an update from a technician", async () => {
    const job = await aJob();
    await expect(jobs.update(ctxFor(ORG_A, USER_A, ["technician"]), { id: job.id, summary: "Nope" }))
      .rejects.toThrow(PermissionError);
  });

  it("reports another company's job as missing", async () => {
    const job = await aJob();
    await expect(jobs.update(ctxFor(ORG_B, USER_B, ["owner"]), { id: job.id, summary: "Theirs" }))
      .rejects.toThrow(NotFoundError);
  });
});
