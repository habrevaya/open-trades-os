import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as backups from "../src/services/backups";
import { openCopy } from "../src/portability/reader";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";
import { fakeBucket, type FakeBucket } from "./s3-fake";

/**
 * A COPY ON A CLOCK, IN THE COMPANY'S OWN BUCKET
 *
 * Against a bucket served in this process, which checks every signature. The
 * promise under test: the owner names a bucket and a schedule; the worker
 * writes the whole company there as the zip of spreadsheets, without holding it
 * in memory; the newest N are kept and only copies this company wrote are ever
 * deleted; a failure is recorded with the bucket's own words and put in the
 * office's queue once; and the same bucket is where a restore reads a copy from.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("backups30:org");
const USER = fixtureId("backups30:user");
const EMPTY = fixtureId("backups30:empty");
const EMPTY_USER = fixtureId("backups30:empty-user");
const SECRET_NAME = "BACKUPS30_SECRET_KEY";

let raw: postgres.Sql;
let bucket: FakeBucket;
let folder: string;
const db = () => testDb(url!);
const as = (organizationId: string, userId: string, roles: string[] = ["owner"]): ServiceContext => ({
  actor: { userId, organizationId, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(ORG, USER);

const destination = (overrides: Partial<backups.DestinationInput> = {}): backups.DestinationInput => ({
  endpoint: bucket.url, bucket: bucket.bucket, region: "us-east-1", prefix: "copies/",
  accessKeyId: bucket.accessKeyId, secretKeyRef: SECRET_NAME,
  frequency: "daily", hour: 2, weekday: null, keep: 2, pathStyle: true,
  ...overrides,
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  bucket = await fakeBucket();
  process.env[SECRET_NAME] = bucket.secretAccessKey;
  folder = await mkdtemp(join(tmpdir(), "ots-backups-"));
});
afterAll(async () => {
  delete process.env[SECRET_NAME];
  if (bucket) await bucket.close();
  if (folder) await rm(folder, { recursive: true, force: true });
  if (raw) {
    await resetOrg(raw, ORG);
    await resetOrg(raw, EMPTY);
    await raw.end();
  }
});
beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Backed Up Co", slug: "backups30-co" });
  await raw`insert into public.customer (organization_id, type, name, payment_terms_days)
            values (${ORG}, 'residential', 'Dana', 0), (${ORG}, 'commercial', 'Acme Plumbing Supply', 30)`;
  bucket.objects.clear();
});

run("where copies go", () => {
  it("saves the bucket and the schedule, checks the bucket takes a copy, and leaves nothing behind from the check", async () => {
    const saved = await backups.saveDestination(owner(), destination());
    expect(saved.check).toEqual({ ok: true, error: null });
    expect(saved.destination.nextRunAt).not.toBeNull();
    expect(bucket.objects.size).toBe(0);
  });

  it("saves a destination whose secret this deployment does not have, and says so", async () => {
    const saved = await backups.saveDestination(owner(), destination({ secretKeyRef: "NOT_SET_ANYWHERE" }));
    expect(saved.check.ok).toBe(false);
    expect(saved.check.error).toMatch(/no secret named NOT_SET_ANYWHERE/);
    expect((await backups.destination(owner()))!.lastCheckError).toMatch(/NOT_SET_ANYWHERE/);
  });

  it("refuses the secret key itself typed where its name goes", async () => {
    await expect(backups.saveDestination(owner(), destination({ secretKeyRef: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY1" })))
      .rejects.toThrow(/looks like the secret key itself/);
  });

  it("is the owner's, under data:export", async () => {
    await expect(backups.saveDestination(as(ORG, USER, ["admin"]), destination())).rejects.toThrow(/permission/);
    await expect(backups.runs(as(ORG, USER, ["office_manager"]))).rejects.toThrow(/permission/);
  });
});

run("taking a copy", () => {
  it("writes the whole company to the bucket as an archive a restore can read", async () => {
    await backups.saveDestination(owner(), destination());
    const done = await backups.runBackup(db(), ORG, "person");
    expect(done).toMatchObject({ status: "succeeded", error: null, rows: expect.any(Number) });
    const object = bucket.objects.get(done!.objectKey);
    expect(object).toBeDefined();
    expect(done!.objectKey).toMatch(/^copies\/backups30-co\/opentradesos-backups30-co-\d{8}T\d{6}Z\.zip$/);
    expect(done!.sizeBytes).toBe(object!.body.length);

    const path = join(folder, "fetched.zip");
    await writeFile(path, object!.body);
    const copy = await openCopy(path);
    try {
      expect(copy.complete).not.toBeNull();
      const names: unknown[] = [];
      for await (const batch of copy.rows("customer")) names.push(...batch.rows.map((r) => r["name"]));
      expect(names.sort()).toEqual(["Acme Plumbing Supply", "Dana"]);
    } finally {
      await copy.close();
    }
  });

  it("writes a company too large for one request a part at a time", async () => {
    // Nine megabytes of a file, which puts the archive past the eight megabyte part size.
    const big = randomBytes(9 * 1024 * 1024);
    await raw`insert into public.stored_file (organization_id, storage_key, content_type, sha256, size_bytes, bytes)
              values (${ORG}, ${`${ORG}/zz/zz/big.pdf`}, 'application/pdf', ${"0".repeat(64)}, ${big.length}, ${big})`;
    await backups.saveDestination(owner(), destination());
    const done = await backups.runBackup(db(), ORG, "person");
    expect(done!.status).toBe("succeeded");
    expect(bucket.requests.some((r) => r.query.includes("partNumber=2"))).toBe(true);
    expect(bucket.objects.get(done!.objectKey)!.body.length).toBeGreaterThan(9 * 1024 * 1024);
  });

  it("keeps the newest copies and deletes only older ones this company wrote", async () => {
    bucket.objects.set("copies/somebody-elses.zip", { body: Buffer.from("theirs"), contentType: "application/zip", modified: new Date(0) });
    await backups.saveDestination(owner(), destination({ keep: 2 }));
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const done = await backups.runBackup(db(), ORG, "person");
      made.push(done!.objectKey);
      // Copies are named to the second.
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    expect(bucket.objects.has(made[0]!)).toBe(false);
    expect(bucket.objects.has(made[1]!)).toBe(true);
    expect(bucket.objects.has(made[2]!)).toBe(true);
    expect(bucket.objects.has("copies/somebody-elses.zip")).toBe(true);
    const runs = await backups.runs(owner());
    expect(runs.filter((r) => r.prunedAt !== null)).toHaveLength(1);
  });

  it("records a copy the bucket refused, with its words, and tells the office once", async () => {
    await backups.saveDestination(owner(), destination());
    bucket.failNext((method) => method === "PUT", 403, "AccessDenied");
    const failed = await backups.runBackup(db(), ORG, "schedule");
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toMatch(/AccessDenied.*permission/);
    bucket.failNext((method) => method === "PUT", 403, "AccessDenied");
    await backups.runBackup(db(), ORG, "schedule");
    const tasks = await raw<{ title: string }[]>`select title from public.task where organization_id = ${ORG} and entity_type = 'backup_run'`;
    expect(tasks).toHaveLength(1);
    const [row] = await raw<{ next_run_at: Date }[]>`select next_run_at from public.backup_destination where organization_id = ${ORG}`;
    expect(row!.next_run_at.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000 + 5_000);
  });

  it("takes a copy that is due on the worker's pass, once, however many workers ask", async () => {
    await backups.saveDestination(owner(), destination());
    await raw`update public.backup_destination set next_run_at = now() - interval '1 minute' where organization_id = ${ORG}`;
    const [first, second] = await Promise.all([backups.backupPass(db()), backups.backupPass(db())]);
    const mine = [...first!, ...second!];
    expect(mine.filter((r) => r.status === "succeeded")).toHaveLength(1);
    const [row] = await raw<{ next_run_at: Date }[]>`select next_run_at from public.backup_destination where organization_id = ${ORG}`;
    expect(row!.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("queues a copy now, and a retry of the same request queues one copy", async () => {
    await backups.saveDestination(owner(), destination());
    const ctx = { ...owner(), idempotencyKey: "backups30-now" };
    const first = await backups.backUpNow(ctx);
    const again = await backups.backUpNow(ctx);
    expect(again).toEqual(first);
    const audits = await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'backup.requested'`;
    expect(audits).toHaveLength(1);
  });
});

run("reading a copy back from the bucket", () => {
  it("lists the copies in a bucket and checks one into an empty company", async () => {
    await backups.saveDestination(owner(), destination());
    const done = await backups.runBackup(db(), ORG, "person");
    await seedOrg(raw, { organizationId: EMPTY, userId: EMPTY_USER, name: "Somewhere New", slug: "backups30-new" });
    const where = {
      endpoint: bucket.url, bucket: bucket.bucket, region: "us-east-1", prefix: "copies/",
      accessKeyId: bucket.accessKeyId, secretKeyRef: SECRET_NAME, pathStyle: true,
    };
    const copies = await backups.copiesIn(as(EMPTY, EMPTY_USER), where);
    expect(copies.map((c) => c.key)).toEqual([done!.objectKey]);

    // Backed Up Co is not on this deployment from the new company's point of view: it is somebody else's.
    await resetOrg(raw, ORG);
    await raw`delete from public."user" where id = ${USER}`;
    const checked = await backups.restoreFromBucket(as(EMPTY, EMPTY_USER), { bucket: where, key: done!.objectKey, dryRun: true });
    expect(checked.report.refusals).toEqual([]);
    expect(checked.report.outcome).toBe("checked");
    expect(checked.report.tables.find((t) => t.table === "customer")).toMatchObject({ inCopy: 2, restored: 2 });
  });

  it("needs data:import to look in a bucket for a copy to restore", async () => {
    await seedOrg(raw, { organizationId: EMPTY, userId: EMPTY_USER, name: "Somewhere New", slug: "backups30-new" });
    await expect(backups.copiesIn(as(EMPTY, EMPTY_USER, ["admin"]), {
      endpoint: bucket.url, bucket: bucket.bucket, region: "us-east-1", prefix: "",
      accessKeyId: bucket.accessKeyId, secretKeyRef: SECRET_NAME, pathStyle: true,
    })).rejects.toThrow(/permission/);
  });
});
