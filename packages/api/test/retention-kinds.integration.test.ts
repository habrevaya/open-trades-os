import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as retention from "../src/services/retention";
import * as files from "../src/services/files";
import * as fileStorage from "../src/services/file-storage";
import { s3Client, useFileStorage, type FileStorage } from "../src/storage";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";
import { fakeBucket, type FakeBucket } from "./s3-fake";

/**
 * THE PURGE ON A JOB'S PHOTOGRAPHS AND ON LEAD FORM SUBMISSIONS
 *
 * Two kinds of record added to the four the purge already acted on. The
 * refusals come first, because the failure that matters here is a record
 * removed that should not have been: a held one, a signature somebody signed
 * an estimate with, a job still open, a job whose invoice is still owed, a
 * submission a booking draft is waiting on, a file an invoice still shows.
 * Then the removal itself, with the files going from Postgres and from a
 * bucket through the file store, and the audit line naming the rule.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("retkinds:org");
const USER = fixtureId("retkinds:user");

let raw: postgres.Sql;
let bucket: FakeBucket;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";
let jobTypeId = "";
let counter = 0;

/** A small PNG made different per call, so each is its own stored file. */
function png(): string {
  counter += 1;
  const base = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5b3f5d90000000049454e44ae426082", "hex");
  return Buffer.concat([base, Buffer.from(`#${counter}:${Date.now()}`)]).toString("base64");
}

async function rule(over: { name: string; entityType: string; entityKind?: string | null; months: number; purge: boolean; clock?: string }) {
  const [row] = await raw<{ id: string }[]>`
    insert into public.retention_policy (organization_id, name, entity_type, entity_kind, clock_start, retain_months, purge_allowed)
    values (${ORG}, ${over.name}, ${over.entityType}, ${over.entityKind ?? null}, ${over.clock ?? "work_completed"}, ${over.months}, ${over.purge})
    returning id`;
  return row!.id;
}

/** A job finished `yearsAgo` years back, with one visit. */
async function oldJob(yearsAgo: number, status = "completed"): Promise<{ jobId: string; visitId: string }> {
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`insert into public.job
    (organization_id, number, customer_id, property_id, job_type_id, status, summary, created_at, completed_at)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, ${jobTypeId}, ${status}::job_status, 'Drain cleared',
            now() - make_interval(years => ${yearsAgo}),
            ${status === "completed" ? raw`now() - make_interval(years => ${yearsAgo})` : null})
    returning id`;
  const [visit] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, estimated_duration_minutes)
    values (${ORG}, ${job!.id}, 'completed', 60) returning id`;
  return { jobId: job!.id, visitId: visit!.id };
}

async function photoOn(entityType: "job" | "visit", entityId: string, kind?: string) {
  return files.upload(owner(), { entityType, entityId, fileName: "p.png", bytes: png(), ...(kind ? { kind } : {}) });
}

const liveAttachments = async (entityIds: string[]) => raw<{ entity_id: string; kind: string; storage_key: string }[]>`
  select entity_id, kind, storage_key from public.attachment
  where organization_id = ${ORG} and entity_id = any(${entityIds}) and deleted_at is null`;

const fileRow = async (storageKey: string) => (await raw<{ size_bytes: number; deleted_at: Date | null; stored_in: string; object_key: string | null }[]>`
  select size_bytes, deleted_at, stored_in, object_key from public.stored_file where organization_id = ${ORG} and storage_key = ${storageKey}`)[0]!;

function bucketStorage(): FileStorage {
  return {
    writeTo: "object",
    bucket: {
      client: s3Client({
        endpoint: bucket.url, bucket: bucket.bucket, region: "us-east-1",
        accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey, pathStyle: true,
      }),
      prefix: "files/",
    },
  };
}

async function submission(yearsAgo: number, slug = "quote"): Promise<string> {
  const [form] = await raw<{ id: string }[]>`
    insert into public.web_form (organization_id, slug, title, definition) values (${ORG}, ${slug}, ${slug}, '{}'::jsonb)
    on conflict do nothing returning id`;
  const formId = form?.id ?? (await raw<{ id: string }[]>`
    select id from public.web_form where organization_id = ${ORG} and slug = ${slug}`)[0]!.id;
  const [row] = await raw<{ id: string }[]>`insert into public.form_submission (organization_id, form_id, raw, created_at)
    values (${ORG}, ${formId}, ${raw.json({ name: "Pat", phone: "5125550100" })}, now() - make_interval(years => ${yearsAgo})) returning id`;
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  bucket = await fakeBucket();
});

afterAll(async () => {
  useFileStorage(null);
  if (bucket) await bucket.close();
  if (raw) await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Kinds Co", slug: "retention-kinds-co" });
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Pat Drain') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '2 Pipe St', 'Austin', 'TX', '78701') returning id`;
  propertyId = p!.id;
  const [t] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, code) values (${ORG}, 'Drain', 'drain') returning id`;
  jobTypeId = t!.id;
  bucket.objects.clear();
});

afterEach(() => useFileStorage(null));

run("a job's photographs: what keeps them", () => {
  it("a hold on the job's photographs, placed from the job, until it is lifted", async () => {
    await rule({ name: "Drain photos", entityType: "photo", entityKind: "drain", months: 36, purge: true });
    const { jobId, visitId } = await oldJob(5);
    const photo = await photoOn("visit", visitId);
    const hold = await retention.placeHold(owner(), { entityType: "photo", entityId: jobId, reason: "The Ruiz claim" });
    expect((await retention.holdOn(owner(), { entityType: "photo", entityId: jobId }))?.id).toBe(hold.id);

    const ran = await retention.runNow(owner());
    expect(ran).toMatchObject({ purged: 0, held: 1 });
    expect(await liveAttachments([visitId])).toHaveLength(1);
    expect((await fileRow(photo.storageKey)).deleted_at).toBeNull();

    await retention.releaseHold(owner(), { id: hold.id, note: "Settled" });
    expect(await retention.holdOn(owner(), { entityType: "photo", entityId: jobId })).toBeNull();
    expect((await retention.runNow(owner())).purged).toBe(1);
    expect(await liveAttachments([visitId])).toEqual([]);
  });

  it("a job not finished yet, whatever the clock says", async () => {
    await rule({ name: "All photos", entityType: "photo", months: 1, purge: true, clock: "record_created" });
    const { visitId } = await oldJob(5, "in_progress");
    await photoOn("visit", visitId);
    const [row] = await retention.preview(owner());
    expect(row!.counts).toMatchObject({ due: 0, kept: 1 });
    expect(row!.records[0]!.why).toMatch(/not finished/);
    expect((await retention.runNow(owner())).purged).toBe(0);
    expect(await liveAttachments([visitId])).toHaveLength(1);
  });

  it("a job with an invoice still owed", async () => {
    await rule({ name: "Drain photos", entityType: "photo", months: 12, purge: true });
    const { jobId, visitId } = await oldJob(5);
    await photoOn("visit", visitId);
    await raw`insert into public.invoice (organization_id, number, customer_id, job_id, status, subtotal, total, balance)
      values (${ORG}, 9001, ${customerId}, ${jobId}, 'open', '100', '100', '100')`;
    const [row] = await retention.preview(owner());
    expect(row!.records[0]).toMatchObject({ state: "kept", why: expect.stringMatching(/still owed/) });
    expect((await retention.runNow(owner())).purged).toBe(0);
    await raw`delete from public.invoice where organization_id = ${ORG}`;
  });

  it("purging off for the rule, and a longer rule over the same photographs", async () => {
    const short = await rule({ name: "Short", entityType: "photo", months: 12, purge: false });
    const { visitId } = await oldJob(5);
    await photoOn("visit", visitId);
    expect((await retention.runNow(owner())).purged).toBe(0);
    await retention.updatePolicy(owner(), { id: short, purgeAllowed: true });
    await rule({ name: "Long", entityType: "photo", months: 120, purge: true });
    expect((await retention.runNow(owner())).purged).toBe(0);
    expect(await liveAttachments([visitId])).toHaveLength(1);
  });

  it("refuses a hold from somebody who may not change compliance records, and a hold on a job that is not here", async () => {
    const { jobId } = await oldJob(1);
    await expect(retention.placeHold(as(["office_manager"]), { entityType: "photo", entityId: jobId, reason: "x" }))
      .rejects.toThrow(PermissionError);
    await expect(retention.placeHold(owner(), { entityType: "photo", entityId: fixtureId("no such job"), reason: "x" }))
      .rejects.toThrow(/not found/i);
  });
});

run("a job's photographs: what goes, and what never does", () => {
  it("removes the job's and its visits' photographs and their files, and keeps the job, its visits and their signatures", async () => {
    await rule({ name: "Drain photos", entityType: "photo", entityKind: "drain", months: 36, purge: true });
    const { jobId, visitId } = await oldJob(5);
    const onJob = await photoOn("job", jobId);
    const onVisit = await photoOn("visit", visitId);
    const signature = await photoOn("visit", visitId, "signature");
    const recent = await oldJob(0);
    const kept = await photoOn("visit", recent.visitId);

    const [preview] = await retention.preview(owner());
    expect(preview!.counts).toMatchObject({ due: 1, notYet: 1 });
    expect(preview!.records.find((r) => r.id === jobId)).toMatchObject({ state: "due", entityType: "photo" });

    const ran = await retention.runNow(owner());
    expect(ran).toMatchObject({ purged: 1, failed: 0 });
    expect((await liveAttachments([jobId, visitId])).map((a) => a.kind)).toEqual(["signature"]);
    for (const gone of [onJob, onVisit]) {
      expect(await fileRow(gone.storageKey)).toMatchObject({ size_bytes: 0 });
      expect((await fileRow(gone.storageKey)).deleted_at).not.toBeNull();
    }
    expect((await fileRow(signature.storageKey)).deleted_at).toBeNull();
    expect((await fileRow(kept.storageKey)).deleted_at).toBeNull();
    const [job] = await raw`select id from public.job where id = ${jobId}`;
    const [visit] = await raw`select id from public.visit where id = ${visitId}`;
    expect(job).toBeTruthy();
    expect(visit).toBeTruthy();

    const [line] = await raw<{ after: { policy: string; runId: string }; before: { photos: number } }[]>`
      select before, after from public.audit_log where organization_id = ${ORG} and action = 'retention.purged' and entity_id = ${jobId}`;
    expect(line).toMatchObject({ after: { policy: "Drain photos", runId: ran.id }, before: { photos: 2 } });
  });

  it("keeps the file when an invoice still points at the same photograph, and removes only the job's copy", async () => {
    await rule({ name: "Drain photos", entityType: "photo", months: 12, purge: true });
    const { jobId, visitId } = await oldJob(5);
    const bytes = png();
    const onVisit = await files.upload(owner(), { entityType: "visit", entityId: visitId, fileName: "p.png", bytes });
    const [invoice] = await raw<{ id: string }[]>`insert into public.invoice (organization_id, number, customer_id, job_id, status, subtotal, total, balance)
      values (${ORG}, 9002, ${customerId}, ${jobId}, 'paid', '100', '100', '0') returning id`;
    const onInvoice = await files.upload(owner(), { entityType: "invoice", entityId: invoice!.id, fileName: "p.png", bytes });
    expect(onInvoice.storageKey).toBe(onVisit.storageKey);

    expect((await retention.runNow(owner())).purged).toBe(1);
    expect(await liveAttachments([visitId])).toEqual([]);
    expect(await liveAttachments([invoice!.id])).toHaveLength(1);
    expect((await fileRow(onVisit.storageKey)).deleted_at).toBeNull();
    const [still] = await raw`select id from public.invoice where id = ${invoice!.id}`;
    expect(still).toBeTruthy();
    await raw`delete from public.invoice where organization_id = ${ORG}`;
  });

  it("deletes a photograph kept in a bucket from the bucket, through the file store's sweep", async () => {
    useFileStorage(bucketStorage());
    await rule({ name: "Drain photos", entityType: "photo", months: 12, purge: true });
    const { visitId } = await oldJob(5);
    const photo = await photoOn("visit", visitId);
    const row = await fileRow(photo.storageKey);
    expect(row.stored_in).toBe("object");
    expect(bucket.objects.has(row.object_key!)).toBe(true);

    expect((await retention.runNow(owner())).purged).toBe(1);
    expect((await fileRow(photo.storageKey)).deleted_at).not.toBeNull();
    expect(await fileStorage.sweepDeleted(db(), ORG)).toBeGreaterThanOrEqual(1);
    expect(bucket.objects.has(row.object_key!)).toBe(false);
  });
});

run("lead form submissions", () => {
  it("keeps a held submission and removes an unheld one, with an audit line", async () => {
    await rule({ name: "Old leads", entityType: "form_submission", entityKind: "quote", months: 24, purge: true, clock: "record_created" });
    const held = await submission(5);
    const loose = await submission(5);
    const recent = await submission(0);
    await retention.placeHold(owner(), { entityType: "form_submission", entityId: held, reason: "Asked for by their lawyer" });

    const ran = await retention.runNow(owner());
    expect(ran).toMatchObject({ purged: 1, held: 1 });
    const left = await raw<{ id: string }[]>`select id from public.form_submission where organization_id = ${ORG}`;
    expect(new Set(left.map((r) => r.id))).toEqual(new Set([held, recent]));
    const [line] = await raw`select entity_id from public.audit_log where organization_id = ${ORG} and action = 'retention.purged'`;
    expect(line!.entity_id).toBe(loose);
  });

  it("keeps a submission a booking draft is still waiting on", async () => {
    await rule({ name: "Old leads", entityType: "form_submission", months: 12, purge: true, clock: "record_created" });
    const waiting = await submission(3);
    await raw`insert into public.ai_agent_proposal (organization_id, agent, action, source_kind, source_id, summary, status)
      values (${ORG}, 'intake', 'book', 'form_submission', ${waiting}, 'Book Pat', 'proposed')`;
    const [row] = await retention.preview(owner());
    expect(row!.records[0]).toMatchObject({ state: "kept", why: expect.stringMatching(/booking draft/) });
    expect((await retention.runNow(owner())).purged).toBe(0);
  });
});

run("writing a rule on the screen", () => {
  it("writes one with purging off, reads it back as a sentence, and lets the preview show it first", async () => {
    const made = await retention.createPolicy(owner(), {
      name: "Our drain photos", entityType: "photo", entityKind: "drain", clockStart: "work_completed", retainMonths: 36,
      basis: "Our insurer asks for three years.",
    });
    expect(made).toMatchObject({ purgeAllowed: false, active: true, actsOn: true, sentence: "Kept 3 years from when the work was finished." });
    const audit = await raw`select action from public.audit_log where organization_id = ${ORG} and entity_id = ${made.id}`;
    expect(audit.map((a) => a.action)).toEqual(["retention.policy_created"]);
  });

  it("refuses a rule about records the purge cannot act on, a clock it does not know, and a period out of range", async () => {
    await expect(retention.createPolicy(owner(), {
      name: "Scale tickets", entityType: "disposal_ticket", clockStart: "work_completed", retainMonths: 36,
    })).rejects.toThrow(ConflictError);
    await expect(retention.createPolicy(owner(), {
      name: "x", entityType: "photo", clockStart: "whenever", retainMonths: 36,
    })).rejects.toThrow(ConflictError);
    await expect(retention.createPolicy(owner(), {
      name: "x", entityType: "photo", clockStart: "record_created", retainMonths: 0,
    })).rejects.toThrow();
  });

  it("is written only by somebody who may change compliance records", async () => {
    await expect(retention.createPolicy(as(["office_manager"]), {
      name: "x", entityType: "photo", clockStart: "record_created", retainMonths: 12,
    })).rejects.toThrow(PermissionError);
  });
});
