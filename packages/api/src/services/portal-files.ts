import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { files as f, work } from "@opentradesos/core";
import { audit, ConflictError, NotFoundError, TooManyRequestsError, type RequestMeta } from "./context";
import { attach, decode, put, release, sha256 } from "./files";
import { inGrant } from "./portal";
import { sessionFor } from "./portal-sign-in";
import { afterOpened, noticeUpload } from "./customer-uploads";

/**
 * A CUSTOMER ADDING A PHOTOGRAPH OR A PDF TO THEIR OWN JOB
 *
 * A picture of the broken unit before the visit, the warranty card, the
 * letter from the insurer. The technician sees it on the visit before they
 * get out of the van, and the office sees it on the job.
 *
 * FROM A SIGN IN ONLY. An account link can be forwarded, and whoever it was
 * forwarded to should not be able to put files on somebody else's job. The
 * job and the visit come from the request and are checked against the
 * customer the sign in names, inside the company's row level security, so a
 * job of another customer and a job of another company are the same not
 * found as a job that does not exist.
 *
 * HELD TO THE RULES A REPLY BY EMAIL IS HELD TO (`files.checkCustomerUpload`):
 * never a program, by its name, its claimed type or its bytes; a photograph
 * or a PDF by its bytes; caps on one file, on the count and on the total for
 * one job; and twenty an hour per customer, counted before anything is
 * looked at, so a refused file counts too.
 *
 * Kept through `files.put` like every other file, under its own kind
 * (`customer_file`), with the customer (and the contact, when a contact
 * signed in as them) on the row. It is private to the company: a customer
 * file is never shown on the job link or the account's gallery, because
 * the customer already has it and nobody else on the account asked to see
 * it.
 *
 * NOTICED. Keeping a new file raises one office task a day for the job and
 * tells the job's technicians (`customer-uploads.ts`); sending the same bytes
 * again is the file already kept, and raises nothing.
 *
 * TAKING IT BACK. The customer may remove a file they added until somebody in
 * the company has opened it (`attachment.seen_at`). After that it is the
 * company's record of what it was sent, and stays. A file the office added
 * is never theirs to remove, whatever it is.
 */

export const CUSTOMER_FILE_KIND = "customer_file";

/** Visits a customer may still add to: the ones not yet done or called off. */
const OPEN_VISIT = ["unassigned", "scheduled", "dispatched", "en_route", "working"] as const;
/** Visits nothing can be added to: called off, or the customer was not there. */
const CLOSED_VISIT = ["cancelled", "no_show"] as const;

export interface PortalFileTarget {
  jobId: string;
  /** Null for the job as a whole. */
  visitId: string | null;
  label: string;
}

export interface PortalFileView {
  id: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  addedAt: string;
  jobId: string;
  jobLabel: string;
  /** Somebody in the company has opened it, so it stays. */
  seen: boolean;
  removable: boolean;
}

export interface PortalFiles {
  targets: PortalFileTarget[];
  files: PortalFileView[];
  limits: { maxFileMegabytes: number; maxFilesPerJob: number };
}

const jobLabel = (job: { number: number; numberPrefix: string | null; summary: string }) =>
  `Job #${work.documentNumber(job.numberPrefix, job.number)}: ${job.summary}`;

function dayIn(when: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" })
    .format(when);
}

/**
 * Counted per customer, outside the transaction that keeps the file, so a
 * refusal that rolls the file back does not roll the count back with it.
 * One count for every way a customer sends a file (a job's, and a picture in
 * the chat), so twenty an hour is twenty in all.
 */
export async function countUpload(db: Database, organizationId: string, customerId: string): Promise<void> {
  const [row] = await db.execute<{ hits: number }>(
    sql`select app.count_public_hit(${`portal-file:${organizationId}:${customerId}`}, 3600) as hits`,
  );
  if (Number(row?.hits ?? 0) > f.CUSTOMER_UPLOADS.perHour) throw new TooManyRequestsError(3600);
}

/** The jobs (and the visits still to come on them) this customer can add a file to. */
async function targetsFor(tx: Database, organizationId: string, customerId: string): Promise<PortalFileTarget[]> {
  const jobs = await tx.select({
    id: schema.job.id, number: schema.job.number, numberPrefix: schema.job.numberPrefix, summary: schema.job.summary,
  }).from(schema.job)
    .where(and(
      eq(schema.job.customerId, customerId),
      isNull(schema.job.deletedAt),
      ne(schema.job.status, "cancelled"),
    ))
    .orderBy(desc(schema.job.createdAt))
    .limit(20);
  if (jobs.length === 0) return [];
  const [org] = await tx.select({ timezone: schema.organization.timezone })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const timezone = org?.timezone ?? "America/Chicago";
  const visits = await tx.select({
    id: schema.visit.id, jobId: schema.visit.jobId, windowStart: schema.visit.windowStart,
  }).from(schema.visit)
    .where(and(inArray(schema.visit.jobId, jobs.map((j) => j.id)), inArray(schema.visit.status, [...OPEN_VISIT])))
    .orderBy(schema.visit.windowStart);
  const out: PortalFileTarget[] = [];
  for (const job of jobs) {
    out.push({ jobId: job.id, visitId: null, label: jobLabel(job) });
    for (const visit of visits.filter((v) => v.jobId === job.id && v.windowStart)) {
      out.push({
        jobId: job.id, visitId: visit.id,
        label: `The visit on ${dayIn(visit.windowStart!, timezone)} (job #${work.documentNumber(job.numberPrefix, job.number)})`,
      });
    }
  }
  return out;
}

/** The files this customer added, newest first, with whether each can still be taken back. */
async function addedBy(tx: Database, customerId: string): Promise<PortalFileView[]> {
  const rows = await tx.select().from(schema.attachment)
    .where(and(
      eq(schema.attachment.kind, CUSTOMER_FILE_KIND),
      eq(schema.attachment.uploadedByCustomerId, customerId),
      isNull(schema.attachment.deletedAt),
    ))
    .orderBy(desc(schema.attachment.createdAt))
    .limit(100);
  if (rows.length === 0) return [];
  const visitIds = rows.filter((r) => r.entityType === "visit").map((r) => r.entityId);
  const visits = visitIds.length > 0
    ? await tx.select({ id: schema.visit.id, jobId: schema.visit.jobId }).from(schema.visit)
      .where(inArray(schema.visit.id, visitIds))
    : [];
  const jobOf = (row: typeof rows[number]) =>
    row.entityType === "job" ? row.entityId : visits.find((v) => v.id === row.entityId)?.jobId ?? null;
  const jobIds = [...new Set(rows.map(jobOf).filter((id): id is string => id !== null))];
  const jobs = jobIds.length > 0
    ? await tx.select({
      id: schema.job.id, number: schema.job.number, numberPrefix: schema.job.numberPrefix, summary: schema.job.summary,
    }).from(schema.job).where(inArray(schema.job.id, jobIds))
    : [];
  return rows.flatMap((row) => {
    const job = jobs.find((j) => j.id === jobOf(row));
    if (!job) return [];
    return [{
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      addedAt: row.createdAt.toISOString(),
      jobId: job.id,
      jobLabel: jobLabel(job),
      seen: row.seenAt !== null,
      removable: row.seenAt === null,
    }];
  });
}

export async function list(db: Database, input: { token: string }): Promise<PortalFiles> {
  const session = await sessionFor(db, input.token);
  return inGrant(db, session.grant, async (tx) => ({
    targets: await targetsFor(tx, session.grant.organizationId, session.customerId),
    files: await addedBy(tx, session.customerId),
    limits: {
      maxFileMegabytes: Math.round(f.CUSTOMER_UPLOADS.maxFileBytes / (1024 * 1024)),
      maxFilesPerJob: f.CUSTOMER_UPLOADS.maxFilesPerJob,
    },
  }));
}

export interface AddFileInput {
  token: string;
  jobId: string;
  visitId?: string | undefined;
  fileName: string;
  contentType?: string | undefined;
  /** Base64, as every other upload in the product takes it. */
  bytes: string;
}

/**
 * Add one file. The same bytes added to the same job or visit twice are one
 * file, so a retry after a lost answer adds nothing.
 */
export async function add(db: Database, input: AddFileInput, _meta?: RequestMeta): Promise<PortalFileView> {
  const session = await sessionFor(db, input.token);
  const organizationId = session.grant.organizationId;
  await countUpload(db, organizationId, session.customerId);
  const bytes = decode(input.bytes);

  return inGrant(db, session.grant, async (tx, ctx) => {
    /**
     * Locked, so two files sent at the same moment are counted one after the
     * other: the limit on one job is ten, not ten each.
     */
    const [job] = await tx.select().from(schema.job)
      .where(and(eq(schema.job.id, input.jobId), eq(schema.job.customerId, session.customerId), isNull(schema.job.deletedAt)))
      .limit(1).for("update");
    if (!job) throw new NotFoundError("Job");
    if (job.status === "cancelled") {
      throw new ConflictError("That job was cancelled, so nothing can be added to it. Call us if the work is still needed.");
    }
    let entity: { type: "job" | "visit"; id: string } = { type: "job", id: job.id };
    if (input.visitId) {
      const [visit] = await tx.select({ id: schema.visit.id, status: schema.visit.status }).from(schema.visit)
        .where(and(eq(schema.visit.id, input.visitId), eq(schema.visit.jobId, job.id))).limit(1);
      if (!visit) throw new NotFoundError("Visit");
      if ((CLOSED_VISIT as readonly string[]).includes(visit.status)) {
        throw new ConflictError("That visit was called off, so nothing can be added to it. Add the file to the job instead.");
      }
      entity = { type: "visit", id: visit.id };
    }

    /**
     * What this customer already added to the job, on the job itself and on
     * every visit of it, which is what the count and the total are of.
     */
    const visitIds = (await tx.select({ id: schema.visit.id }).from(schema.visit)
      .where(eq(schema.visit.jobId, job.id))).map((v) => v.id);
    const already = await tx.select({
      id: schema.attachment.id, entityType: schema.attachment.entityType, entityId: schema.attachment.entityId,
      storageKey: schema.attachment.storageKey, sizeBytes: schema.attachment.sizeBytes,
    }).from(schema.attachment)
      .where(and(
        eq(schema.attachment.kind, CUSTOMER_FILE_KIND),
        eq(schema.attachment.uploadedByCustomerId, session.customerId),
        isNull(schema.attachment.deletedAt),
        inArray(schema.attachment.entityId, [job.id, ...visitIds]),
      ));

    /** Content addressed: the key's last part is the hash of the bytes. */
    const hash = sha256(bytes);
    const same = already.find((a) => a.entityType === entity.type && a.entityId === entity.id
      && (a.storageKey.split("/").pop() ?? "").startsWith(`${hash}.`));
    if (same) {
      const views = await addedBy(tx, session.customerId);
      const view = views.find((v) => v.id === same.id);
      if (view) return view;
    }

    const verdict = f.checkCustomerUpload(
      { fileName: input.fileName, contentType: input.contentType, bytes },
      {
        filesAlreadyAdded: already.length,
        bytesAlreadyAdded: already.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0),
      },
    );
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const { file } = await put(tx, organizationId, {
      bytes, claimedType: input.contentType, maxBytes: f.CUSTOMER_UPLOADS.maxFileBytes,
    });
    const { id } = await attach(tx, organizationId, {
      entityType: entity.type,
      entityId: entity.id,
      storageKey: file.storageKey,
      kind: CUSTOMER_FILE_KIND,
      fileName: f.downloadName(input.fileName, verdict.extension),
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      uploadedByUserId: null,
      uploadedByCustomerId: session.customerId,
      uploadedByContactId: session.contact?.id ?? null,
    });
    await audit(tx, ctx, "attachment.customer_added", "attachment", id, null, {
      entityType: entity.type, entityId: entity.id, jobId: job.id, storageKey: file.storageKey,
      contentType: file.contentType, sizeBytes: file.sizeBytes, customerId: session.customerId,
    });
    /** One office task a day for the job, and the job's technicians told, in the same transaction as the file. */
    await noticeUpload(tx, ctx, { job, entity, attachmentId: id });
    const view = (await addedBy(tx, session.customerId)).find((v) => v.id === id);
    if (!view) throw new NotFoundError("File");
    return view;
  });
}

/**
 * Take back a file the customer added, until somebody in the company has
 * opened it. A file the office added, another customer's file and a made up
 * id are all the same not found. Removing one already removed changes
 * nothing.
 */
export async function remove(db: Database, input: { token: string; id: string }): Promise<{ id: string; removed: boolean }> {
  const session = await sessionFor(db, input.token);
  return inGrant(db, session.grant, async (tx, ctx) => {
    const [row] = await tx.select().from(schema.attachment)
      .where(and(
        eq(schema.attachment.id, input.id),
        eq(schema.attachment.kind, CUSTOMER_FILE_KIND),
        eq(schema.attachment.uploadedByCustomerId, session.customerId),
      )).limit(1);
    if (!row) throw new NotFoundError("File");
    if (row.deletedAt) return { id: row.id, removed: true };
    if (row.seenAt) {
      throw new ConflictError("We have already opened that file, so it stays with the job. Call us if it should not be there.");
    }
    await release(tx, session.grant.organizationId, row.id);
    await audit(tx, ctx, "attachment.customer_removed", "attachment", row.id, { deletedAt: null }, { removedBy: "customer" });
    /** A task about a file nobody needs to open any more is finished too. */
    await afterOpened(tx, ctx, row, "The customer took back what they sent, and nothing else is waiting to be opened.");
    return { id: row.id, removed: true };
  });
}

export const handlers = {
  listPortalFiles: (db: Database, input: { token: string }) => list(db, input),
  addPortalFile: (db: Database, input: AddFileInput, meta?: RequestMeta) => add(db, input, meta),
  removePortalFile: (db: Database, input: { token: string; id: string }) => remove(db, input),
} as const;

