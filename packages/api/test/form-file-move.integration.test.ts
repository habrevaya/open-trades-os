import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as files from "../src/services/files";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * A FILE A LEAD SENT, MOVED ONTO THE CUSTOMER'S JOB
 *
 * What is tested is the rule that matters: the file moves and nothing about
 * who can see it changes. It keeps its kind, so it still cannot be shown to
 * the customer; it goes only onto that customer's own job; and it needs
 * `job:write` as well as `document:read`.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("form-file-move/org");
const USER = fixtureId("form-file-move/user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctxFor = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const office = () => ctxFor(["office_manager"]);

let customerId = "";
let otherCustomerId = "";
let jobId = "";
let otherJobId = "";
let n = 0;

async function job(customer: string) {
  const [property] = await raw<{ id: string }[]>`insert into public.property
    (organization_id, address_line1, city, state, postal_code) values (${ORG}, ${`${++n} Lead Lane`}, 'Austin', 'TX', '78704') returning id`;
  const [row] = await raw<{ id: string }[]>`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n}, ${customer}, ${property!.id}, 'scheduled', 'Leak under the sink') returning id`;
  return row!.id;
}

async function sentWithForm(entityType = "customer", entityId = customerId, kind = "form_file") {
  const key = `${ORG}/${crypto.randomUUID()}.jpg`;
  await raw`insert into public.stored_file (organization_id, storage_key, content_type, sha256, size_bytes, bytes, "references")
    values (${ORG}, ${key}, 'image/jpeg', ${crypto.randomUUID()}, 10, ${Buffer.from("0123456789")}, 1)`;
  const [row] = await raw<{ id: string }[]>`insert into public.attachment
    (organization_id, entity_type, entity_id, kind, storage_key, file_name, content_type, size_bytes)
    values (${ORG}, ${entityType}, ${entityId}, ${kind}, ${key}, 'leak.jpg', 'image/jpeg', 10) returning id`;
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Lead Files Co", slug: "lead-files-co" });
  const [c] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Lena Lead') returning id`;
  customerId = c!.id;
  const [o] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Otto Other') returning id`;
  otherCustomerId = o!.id;
  jobId = await job(customerId);
  otherJobId = await job(otherCustomerId);
});
afterAll(async () => { if (raw) await raw.end(); });

run("moving a file a lead sent onto a job", () => {
  it("moves it onto the customer's job, keeps it private, and audits where it was", async () => {
    const id = await sentWithForm();
    expect(await files.moveFormFileToJob(office(), { id, jobId })).toEqual({ id, entityType: "job", entityId: jobId });
    const onJob = await files.attachmentsFor(office(), { entityType: "job", entityId: jobId });
    expect(onJob.find((f) => f.id === id)).toMatchObject({ kind: "form_file", sharedWithCustomerAt: null });
    expect((await files.attachmentsFor(office(), { entityType: "customer", entityId: customerId })).map((f) => f.id)).not.toContain(id);
    // Still never shown to the customer, whoever asks.
    await expect(files.shareWithCustomer(ctxFor(["owner"]), { attachmentId: id, shared: true })).rejects.toThrow(ConflictError);
    const [audit] = await raw`select before, after from public.audit_log
      where organization_id = ${ORG} and action = 'attachment.moved' and entity_id = ${id}`;
    expect(audit!.before).toEqual({ entityType: "customer", entityId: customerId });
    expect(audit!.after).toEqual({ entityType: "job", entityId: jobId });
    // A second press changes nothing.
    expect(await files.moveFormFileToJob(office(), { id, jobId })).toEqual({ id, entityType: "job", entityId: jobId });
  });

  it("refuses another customer's job, a file that is not a lead's, and one already on a job", async () => {
    const id = await sentWithForm();
    await expect(files.moveFormFileToJob(office(), { id, jobId: otherJobId })).rejects.toThrow(/another customer's/);
    const photo = await sentWithForm("customer", customerId, "photo");
    await expect(files.moveFormFileToJob(office(), { id: photo, jobId })).rejects.toThrow(/lead form/);
    await files.moveFormFileToJob(office(), { id, jobId });
    const second = await job(customerId);
    await expect(files.moveFormFileToJob(office(), { id, jobId: second })).rejects.toThrow(/already on a job/);
  });

  it("needs job:write as well as document:read", async () => {
    const id = await sentWithForm();
    // The finance role reads documents and does not change jobs; read only reads neither.
    await expect(files.moveFormFileToJob(ctxFor(["accountant"]), { id, jobId })).rejects.toThrow(PermissionError);
    await expect(files.moveFormFileToJob(ctxFor(["readonly"]), { id, jobId })).rejects.toThrow(PermissionError);
    const [row] = await raw`select entity_type from public.attachment where id = ${id}`;
    expect(row!.entity_type).toBe("customer");
  });
});
