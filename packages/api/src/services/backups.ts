import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, isSystem, portability, SYSTEM_USER_ID, time, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { withSnapshot } from "./export";
import { readSecretFromEnv, type SecretReader } from "./worker-hooks";
import { restore, type RestoreResult } from "./restore";
import { remember, replayed } from "./once";
import { s3Client, S3Error, type S3Client } from "../storage";
import { writeArchive } from "../portability/archive";

/**
 * A COPY ON A CLOCK, IN A BUCKET THE COMPANY OWNS
 *
 * The download on Take a copy is a promise a company can keep if it remembers
 * to. This keeps it without anybody remembering: the whole company, as the zip
 * of spreadsheets, written to an S3 compatible bucket of the owner's choosing
 * every night or every week, the last N kept and the older ones deleted, each
 * attempt recorded with what happened.
 *
 * THE COMPANY'S BUCKET, NOT THE DEPLOYMENT'S. A copy that lives on the same
 * deployment as the company protects against a mistake and not against the
 * deployment going away, which for a company on somebody else's hosting is the
 * thing worth protecting against. So the owner names the bucket and its keys,
 * in the same way as every other connection: the key id in the clear, the
 * secret key by the name it is kept under.
 *
 * ONLY OUR OWN COPIES ARE EVER DELETED. Keeping N is done from this company's
 * own record of what it wrote, never from a listing of the bucket, so a bucket
 * shared with anything else loses nothing it did not get from here.
 *
 * And the bucket is where a restore can read from too (`restoreFromBucket`),
 * which is what makes the copy useful on the day it is needed: a new company on
 * another deployment names the same bucket and picks a copy.
 */

/** The deployment's secret reader. Replaceable, for a deployment whose secrets are not environment variables. */
let readSecret: SecretReader = readSecretFromEnv;
export function useSecretReader(reader: SecretReader | null): void {
  readSecret = reader ?? readSecretFromEnv;
}

export interface Bucket {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  secretKeyRef: string;
  pathStyle: boolean;
}

/** The secret behind a name, said in words when it is not there. */
async function clientFor(bucket: Bucket): Promise<S3Client> {
  let secret: string;
  try {
    secret = await readSecret(bucket.secretKeyRef);
  } catch {
    throw new ConflictError(
      `This deployment has no secret named ${bucket.secretKeyRef}. Whoever runs it adds the bucket's secret key under that name.`,
    );
  }
  return s3Client({
    endpoint: bucket.endpoint, bucket: bucket.bucket, region: bucket.region,
    accessKeyId: bucket.accessKeyId, secretAccessKey: secret, pathStyle: bucket.pathStyle,
  });
}

/**
 * Whether the bucket takes a copy: a small object written, read back and
 * deleted. Done when a destination is saved, so a wrong key shows on the
 * screen that moment rather than as a failed copy at two in the morning.
 */
async function check(bucket: Bucket): Promise<string | null> {
  try {
    const client = await clientFor(bucket);
    const key = `${normalise(bucket.prefix)}.opentradesos-check-${randomUUID()}`;
    const body = Buffer.from(`Written by OpenTradesOS to check it can keep copies here. Safe to delete.\n`);
    await client.put(key, body, "text/plain");
    const back = await client.get(key);
    await client.delete(key);
    if (!back || Buffer.compare(Buffer.from(back), body) !== 0) return "The bucket did not give back what was written to it.";
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

const normalise = (prefix: string) => (prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`);

/* ---------------------------------------------------------- the settings */

export interface DestinationView extends Omit<Bucket, never> {
  id: string;
  frequency: portability.BackupFrequency;
  hour: number;
  weekday: number | null;
  keep: number;
  nextRunAt: Date | null;
  lastCheckedAt: Date | null;
  lastCheckError: string | null;
}

const destinationView = (row: typeof schema.backupDestination.$inferSelect): DestinationView => ({
  id: row.id, endpoint: row.endpoint, bucket: row.bucket, region: row.region, prefix: row.prefix,
  accessKeyId: row.accessKeyId, secretKeyRef: row.secretKeyRef, pathStyle: row.pathStyle,
  frequency: row.frequency as portability.BackupFrequency, hour: row.hour, weekday: row.weekday, keep: row.keep,
  nextRunAt: row.nextRunAt, lastCheckedAt: row.lastCheckedAt, lastCheckError: row.lastCheckError,
});

export interface RunView {
  id: string;
  trigger: string;
  status: string;
  bucket: string;
  objectKey: string;
  startedAt: Date;
  finishedAt: Date | null;
  sizeBytes: number | null;
  rows: number | null;
  files: number | null;
  error: string | null;
  prunedAt: Date | null;
}

const runView = (row: typeof schema.backupRun.$inferSelect): RunView => ({
  id: row.id, trigger: row.trigger, status: row.status, bucket: row.bucket, objectKey: row.objectKey,
  startedAt: row.startedAt, finishedAt: row.finishedAt, sizeBytes: row.sizeBytes, rows: row.rows,
  files: row.files, error: row.error, prunedAt: row.prunedAt,
});

/** The destination, if there is one. Under `data:export`, like everything about where copies go. */
export async function destination(ctx: ServiceContext): Promise<DestinationView | null> {
  return guardedRead(ctx, "data:export", async (tx) => {
    const [row] = await tx.select().from(schema.backupDestination).limit(1);
    return row ? destinationView(row) : null;
  });
}

export async function runs(ctx: ServiceContext, input: { limit?: number | undefined } = {}): Promise<RunView[]> {
  return guardedRead(ctx, "data:export", async (tx) => {
    const rows = await tx.select().from(schema.backupRun)
      .orderBy(desc(schema.backupRun.startedAt)).limit(Math.min(Math.max(input.limit ?? 30, 1), 200));
    return rows.map(runView);
  });
}

async function nextAt(tx: Database, organizationId: string, d: {
  frequency: portability.BackupFrequency; hour: number; weekday: number | null;
}, after: Date): Promise<Date | null> {
  const zone = await timezoneOf(tx, organizationId);
  return portability.nextBackupAt({
    ...d, after,
    dateIn: (instant) => time.dateIn(instant, zone),
    instantOf: (date, minutes) => time.instantOfLocal(date, minutes, zone),
  });
}

export type DestinationInput = portability.DestinationInput & { pathStyle?: boolean | undefined };

/**
 * Set where copies go and when, and check the bucket takes one.
 *
 * Saved even when the check fails, with the failure on the row and in the
 * answer: the owner may be setting the bucket up in another tab, and refusing
 * to save would make them type it all again. A failing check is said on the
 * screen until it passes, and a scheduled copy into a bucket that refuses is a
 * failed run with the reason, not a silent one.
 */
export async function saveDestination(ctx: ServiceContext, input: DestinationInput) {
  const problems = portability.checkDestination(input);
  if (problems.length > 0) throw new ConflictError(problems.join(" "));
  const bucket: Bucket = {
    endpoint: input.endpoint.replace(/\/+$/, ""), bucket: input.bucket, region: input.region,
    prefix: input.prefix, accessKeyId: input.accessKeyId, secretKeyRef: input.secretKeyRef,
    pathStyle: input.pathStyle ?? true,
  };
  const failure = await check(bucket);
  return guardedWrite(ctx, "data:export", async (tx) => {
    const nextRunAt = await nextAt(tx, ctx.actor.organizationId, input, new Date());
    const [before] = await tx.select().from(schema.backupDestination).limit(1);
    const values = {
      ...bucket,
      frequency: input.frequency, hour: input.hour, weekday: input.frequency === "weekly" ? input.weekday : null,
      keep: input.keep, nextRunAt, lastCheckedAt: new Date(), lastCheckError: failure,
      updatedByUserId: isSystem(ctx.actor) ? null : ctx.actor.userId, updatedAt: new Date(),
    };
    const [row] = before
      ? await tx.update(schema.backupDestination).set(values).where(eq(schema.backupDestination.id, before.id)).returning()
      : await tx.insert(schema.backupDestination).values({ organizationId: ctx.actor.organizationId, ...values }).returning();
    await audit(tx, ctx, before ? "backup.destination_changed" : "backup.destination_set", "backup_destination", row!.id,
      before ? { ...destinationView(before) } : null, { ...destinationView(row!) });
    return { destination: destinationView(row!), check: failure ? { ok: false, error: failure } : { ok: true, error: null } };
  });
}

/** Stop taking copies and forget the bucket. The copies already in it stay; this product deletes none of them now. */
export async function removeDestination(ctx: ServiceContext) {
  return guardedWrite(ctx, "data:export", async (tx) => {
    const [row] = await tx.select().from(schema.backupDestination).limit(1);
    if (!row) throw new NotFoundError("Backup destination");
    await tx.delete(schema.backupDestination).where(eq(schema.backupDestination.id, row.id));
    await audit(tx, ctx, "backup.destination_removed", "backup_destination", row.id, { ...destinationView(row) }, null);
    return { removed: true };
  });
}

/**
 * Take a copy now. The worker takes it on its next pass, a few seconds away,
 * rather than this request holding the line open for as long as a company
 * takes to write out.
 */
export async function backUpNow(ctx: ServiceContext): Promise<{ queued: boolean; nextRunAt: string }> {
  return guardedWrite(ctx, "data:export", async (tx) => {
    /** A second press of the button, or a retry with a lost answer, asks for one copy, not two. */
    const seen = await replayed<{ queued: boolean; nextRunAt: string }>(tx, ctx, "backup_request");
    if (seen) return seen;
    const [row] = await tx.select().from(schema.backupDestination).limit(1);
    if (!row) throw new ConflictError("Set where copies go first.");
    const now = new Date();
    await tx.update(schema.backupDestination).set({ nextRunAt: now, updatedAt: now })
      .where(eq(schema.backupDestination.id, row.id));
    await audit(tx, ctx, "backup.requested", "backup_destination", row.id, null, { at: now.toISOString() });
    const answer = { queued: true, nextRunAt: now.toISOString() };
    await remember(tx, ctx, "backup_request", row.id, answer);
    return answer;
  });
}

/* ------------------------------------------------------------ the copy */

const exporter = (db: Database, organizationId: string, userId?: string | null): ServiceContext => ({
  /**
   * The worker's own actor, holding `data:export` and nothing else, so the
   * copy goes through the same permission check, the same redactions and the
   * same audit lines as a download by the owner.
   */
  actor: { userId: userId ?? SYSTEM_USER_ID, organizationId, roles: [], grants: ["data:export"] } as Actor,
  db,
});

/**
 * Write one copy of one company to its bucket, keep the newest `keep`, and
 * record what happened.
 *
 * Streamed straight into a multipart upload, eight megabytes at a time, so the
 * company is never in memory or on this server's disk. If anything fails the
 * upload is abandoned, which leaves nothing in the bucket, and the run says
 * why.
 */
export async function runBackup(
  db: Database, organizationId: string, trigger: "schedule" | "person" = "schedule",
): Promise<RunView | null> {
  const ctx = exporter(db, organizationId);
  const found = await inTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(schema.backupDestination).limit(1);
    const [org] = await tx.select({ slug: schema.organization.slug }).from(schema.organization)
      .where(eq(schema.organization.id, organizationId)).limit(1);
    return row ? { destination: row, slug: org?.slug ?? organizationId } : null;
  });
  if (!found) return null;
  const { destination: dest, slug } = found;
  const objectKey = portability.backupObjectKey(dest.prefix, slug, new Date());

  const [run] = await inTenant(ctx, (tx) => tx.insert(schema.backupRun).values({
    organizationId, destinationId: dest.id, trigger, status: "running", bucket: dest.bucket, objectKey,
  }).returning());

  let finished: typeof schema.backupRun.$inferSelect | undefined;
  try {
    const client = await clientFor(dest);
    const upload = client.upload(objectKey, "application/zip");
    let written: { rows: number; files: number; size: number };
    try {
      written = await withSnapshot(ctx, "backup", (source) => writeArchive(source, (chunk) => upload.write(chunk)));
      await upload.done();
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw error;
    }
    [finished] = await inTenant(ctx, (tx) => tx.update(schema.backupRun).set({
      status: "succeeded", finishedAt: new Date(), sizeBytes: written.size, rows: written.rows, files: written.files,
      updatedAt: new Date(),
    }).where(eq(schema.backupRun.id, run!.id)).returning());
    await prune(db, organizationId, client, dest);
  } catch (error) {
    const message = error instanceof S3Error || error instanceof ConflictError
      ? error.message : `The copy stopped: ${(error as Error).message}`;
    finished = await inTenant(ctx, async (tx) => {
      const [failed] = await tx.update(schema.backupRun).set({
        status: "failed", finishedAt: new Date(), error: message.slice(0, 2000), updatedAt: new Date(),
      }).where(eq(schema.backupRun.id, run!.id)).returning();
      await tellTheOffice(tx, organizationId, failed!);
      return [failed];
    }).then(([row]) => row);
  }

  /**
   * The next copy. A failed one is tried again in an hour, or at its usual
   * time if that comes sooner, so a bucket that was down for a minute does not
   * cost a whole night's copy, and one that is down for a week does not take a
   * copy a minute.
   */
  await inTenant(ctx, async (tx) => {
    const now = new Date();
    const scheduled = await nextAt(tx, organizationId, {
      frequency: dest.frequency as portability.BackupFrequency, hour: dest.hour, weekday: dest.weekday,
    }, now);
    const retry = finished?.status === "failed" ? new Date(now.getTime() + 60 * 60_000) : null;
    const next = retry && (!scheduled || retry < scheduled) ? retry : scheduled;
    await tx.update(schema.backupDestination).set({ nextRunAt: next, updatedAt: now })
      .where(eq(schema.backupDestination.id, dest.id));
  });
  return finished ? runView(finished) : null;
}

/**
 * A failed copy, put in the office's queue the first time it fails, so it is
 * somebody's job. Not again on every retry: a queue with forty identical tasks
 * in it is a queue people stop reading.
 */
async function tellTheOffice(tx: Database, organizationId: string, failed: typeof schema.backupRun.$inferSelect): Promise<void> {
  const [previous] = await tx.select({ status: schema.backupRun.status }).from(schema.backupRun)
    .where(and(sql`${schema.backupRun.id} <> ${failed.id}`, sql`${schema.backupRun.status} <> 'running'`))
    .orderBy(desc(schema.backupRun.startedAt)).limit(1);
  if (previous?.status === "failed") return;
  await tx.insert(schema.task).values({
    organizationId,
    title: "The nightly copy of the company did not reach its bucket",
    body: `${failed.error ?? "No reason was given."} It is tried again within the hour. Settings, Backups shows every attempt.`,
    priority: "high",
    entityType: "backup_run",
    entityId: failed.id,
  });
}

/** Delete the copies past `keep`, from this company's own record of what it wrote, in the bucket it wrote them to. */
async function prune(
  db: Database, organizationId: string, client: S3Client, dest: typeof schema.backupDestination.$inferSelect,
): Promise<void> {
  const ctx = exporter(db, organizationId);
  const rows = await inTenant(ctx, (tx) => tx.select().from(schema.backupRun)
    .where(and(eq(schema.backupRun.bucket, dest.bucket), isNull(schema.backupRun.prunedAt))));
  const gone = portability.copiesToPrune(rows, dest.keep);
  for (const id of gone) {
    const row = rows.find((r) => r.id === id)!;
    try {
      await client.delete(row.objectKey);
      await inTenant(ctx, (tx) => tx.update(schema.backupRun).set({ prunedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.backupRun.id, id)));
    } catch (error) {
      console.warn(`[backups] could not delete an old copy for ${organizationId}:`, (error as Error).message);
    }
  }
}

/** The worker's share: every company with a copy due, one at a time. */
export async function backupPass(
  db: Database, options: { shouldStop?: () => boolean; limit?: number } = {},
): Promise<RunView[]> {
  const due = await db.execute<{ organization_id: string; destination_id: string }>(
    sql`select organization_id, destination_id from app.due_backups(${options.limit ?? 5})`,
  );
  const done: RunView[] = [];
  for (const row of due) {
    if (options.shouldStop?.()) break;
    /**
     * Claimed before it runs: the next run time moves an hour on, so a second
     * worker running the same pass does not take the same copy twice. The run
     * sets the real next time when it finishes.
     */
    const claimed = await inTenant(exporter(db, row.organization_id), async (tx) => {
      const moved = await tx.update(schema.backupDestination)
        .set({ nextRunAt: new Date(Date.now() + 60 * 60_000), updatedAt: new Date() })
        .where(and(eq(schema.backupDestination.id, row.destination_id), sql`${schema.backupDestination.nextRunAt} <= now()`))
        .returning({ id: schema.backupDestination.id });
      return moved.length > 0;
    });
    if (!claimed) continue;
    const run = await runBackup(db, row.organization_id, "schedule");
    if (run) done.push(run);
  }
  return done;
}

let inFlight: Promise<void> | null = null;

/**
 * Start the copies that are due, unless a batch is already being written.
 *
 * Not awaited by the worker's pass: a large company takes minutes to write
 * out, and the texts and webhooks behind it in the pass must not wait for it.
 * One batch at a time per process, so a slow bucket cannot pile copies up.
 */
export function startBackups(db: Database): void {
  if (inFlight) return;
  inFlight = backupPass(db)
    .then(() => undefined)
    .catch((error: unknown) => { console.error("[worker] backups:", (error as Error).message); })
    .finally(() => { inFlight = null; });
}

/** Wait for a copy being written, so a worker shutting down finishes it rather than abandoning it. */
export async function settle(): Promise<void> {
  await inFlight;
}

/* ------------------------------------------------------- reading it back */

/** The copies in a bucket, newest first, for choosing one to restore. Only zips; anything else there is not ours. */
export async function copiesIn(ctx: ServiceContext, bucket: Bucket) {
  assertCan(ctx.actor, "data:import");
  const problems = portability.checkDestination({ ...bucket, frequency: "off", hour: 0, weekday: null, keep: 1 });
  if (problems.length > 0) throw new ConflictError(problems.join(" "));
  const client = await clientFor(bucket);
  const listed = await client.list(normalise(bucket.prefix));
  return listed
    .filter((object) => object.key.endsWith(".zip"))
    .sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0) || b.key.localeCompare(a.key))
    .map((object) => ({ key: object.key, sizeBytes: object.size, lastModified: object.lastModified }));
}

/**
 * Restore a copy straight from a bucket.
 *
 * The object is spooled to this server's temporary folder and read from
 * there, because a restore reads the copy table by table in load order rather
 * than front to back, and deleted afterwards whatever happened. This is also
 * the way to restore a company too large to upload through a browser: put the
 * zip in a bucket and restore it from there.
 */
export async function restoreFromBucket(
  ctx: ServiceContext, input: { bucket: Bucket; key: string; dryRun: boolean; keepSending?: boolean | undefined },
): Promise<RestoreResult> {
  assertCan(ctx.actor, "data:import");
  const client = await clientFor(input.bucket);
  const object = await client.stream(input.key);
  if (!object) throw new NotFoundError("Copy");
  const folder = await mkdtemp(join(tmpdir(), "opentradesos-restore-"));
  const path = join(folder, "copy");
  try {
    await pipeline(Readable.fromWeb(object.body as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(path) as Writable);
    return await restore(ctx, {
      path, source: "bucket", sourceName: `${input.bucket.bucket}/${input.key}`,
      dryRun: input.dryRun, keepSending: input.keepSending,
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------- handlers */

type BucketInput = Omit<Bucket, "pathStyle"> & { pathStyle?: boolean | undefined };

const bucketOf = (input: BucketInput): Bucket => ({
  endpoint: input.endpoint.replace(/\/+$/, ""), bucket: input.bucket, region: input.region, prefix: input.prefix ?? "",
  accessKeyId: input.accessKeyId, secretKeyRef: input.secretKeyRef, pathStyle: input.pathStyle ?? true,
});

export const handlers = {
  getBackupDestination: async (ctx: ServiceContext) => ({ destination: await destination(ctx) }),
  putBackupDestination: (ctx: ServiceContext, input: DestinationInput) => saveDestination(ctx, input),
  deleteBackupDestination: (ctx: ServiceContext) => removeDestination(ctx),
  listBackups: async (ctx: ServiceContext, input: { limit?: number | undefined }) => ({ backups: await runs(ctx, input) }),
  startBackup: (ctx: ServiceContext) => backUpNow(ctx),
  listRestorableCopies: async (ctx: ServiceContext, input: BucketInput) =>
    ({ copies: await copiesIn(ctx, bucketOf(input)) }),
  restoreCopy: (ctx: ServiceContext, input: {
    bucket: BucketInput; key: string; dryRun: boolean; keepSending?: boolean | undefined;
  }) => restoreFromBucket(ctx, { ...input, bucket: bucketOf(input.bucket) }),
} as const;
