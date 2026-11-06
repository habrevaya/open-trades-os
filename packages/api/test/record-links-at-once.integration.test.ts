import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as objects from "../src/services/custom-objects";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M29. SEVERAL OF A RECORD'S LINKS CHANGED AT ONCE
 *
 * The form that changes several of a record's links sends them in one change.
 * Moving a permit to another customer, address and job together moves all
 * three and leaves one line in the audit log; a change where one of them is
 * wrong (a job of another company) moves none of them, so a record is never
 * left half moved; and somebody who may not change permits is refused.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("record-links-at-once:org");
const USER = fixtureId("record-links-at-once:user");
const OTHER = fixtureId("record-links-at-once:other");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], organizationId = ORG): ServiceContext => ({
  actor: { userId: USER, organizationId, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let made = 0;
async function aJob(ctx: ServiceContext = owner()) {
  made += 1;
  const customer = await customers.create(ctx, {
    type: "residential", name: `Link customer ${made}`, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(ctx, {
    address: { line1: `${made} Link Ln`, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  const job = await jobs.create(ctx, { customerId: customer.id, propertyId: property.id, summary: "Panel", tags: [], customFields: {} });
  return { customer: customer.id as string, property: property.id as string, job: job.id as string };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Many Links Co", slug: "record-links-at-once-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: USER, name: "Other Links Co", slug: "record-links-at-once-other" });
  await objects.defineKind(owner(), {
    key: "permit", label: "Permit", pluralLabel: "Permits", titleLabel: "Permit number", links: ["customer", "property", "job"],
  });
});

afterAll(async () => { if (raw) await raw.end(); });

run("several of a record's links at once", () => {
  it("moves every link sent together, in one change with one audit line", async () => {
    const first = await aJob();
    const second = await aJob();
    const permit = await objects.createRecord(owner(), {
      type: "permit", title: "BP-10", customerId: first.customer, propertyId: first.property, jobId: first.job,
    });
    await objects.updateRecord(owner(), { id: permit.id, customerId: second.customer, propertyId: second.property, jobId: second.job });
    const moved = await objects.getRecord(owner(), { id: permit.id });
    expect([moved.customer?.id, moved.property?.id, moved.job?.id]).toEqual([second.customer, second.property, second.job]);
    const [counted] = await raw<{ count: string }[]>`select count(*)::text as count from public.audit_log
      where organization_id = ${ORG} and entity_id = ${permit.id} and action like '%updated'`;
    expect(counted!.count).toBe("1");

    /** Two taken off and one kept. */
    await objects.updateRecord(owner(), { id: permit.id, customerId: null, jobId: null });
    const cleared = await objects.getRecord(owner(), { id: permit.id });
    expect([cleared.customer, cleared.property?.id, cleared.job]).toEqual([null, second.property, null]);
  });

  it("moves none of them when one is wrong", async () => {
    const first = await aJob();
    const second = await aJob();
    const elsewhere = await aJob(as(["owner"], OTHER));
    const permit = await objects.createRecord(owner(), { type: "permit", title: "BP-11", customerId: first.customer, jobId: first.job });
    const error = await objects.updateRecord(owner(), { id: permit.id, customerId: second.customer, jobId: elsewhere.job })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableError);
    const still = await objects.getRecord(owner(), { id: permit.id });
    expect([still.customer?.id, still.job?.id]).toEqual([first.customer, first.job]);
  });

  it("is refused to somebody who may not change the kind", async () => {
    const first = await aJob();
    const permit = await objects.createRecord(owner(), { type: "permit", title: "BP-12" });
    await expect(objects.updateRecord(as(["technician"]), { id: permit.id, customerId: first.customer, jobId: first.job })).rejects.toThrow();
  });
});
