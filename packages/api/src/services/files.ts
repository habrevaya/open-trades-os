import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { files as f } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, NotFoundError, ConflictError,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * FILES, AND THE QUEUE NOBODY DRAINED
 *
 * Three tables described a working file subsystem and none of them had one.
 *
 * `attachment` carries `storage_key` as NOT NULL, so it could only ever have
 * been written by something that had put a file somewhere. No code wrote a
 * row, because there was nowhere to put a file.
 *
 * `field_upload` is worse, because it was written. A technician taking three
 * photographs on a job produced three rows, under a comment explaining that
 * "the record is written before the bytes arrive" so a report "should say so
 * the moment it syncs, with the images following behind". The images never
 * followed. `status` stayed at its `queued` default forever, `storage_key`,
 * `stored_at`, `attempts` and `last_error` were written by nothing, and the
 * retry index built for a queue indexed a queue nothing consumed. The
 * technician's phone had no endpoint to send a photograph to and no way to
 * learn that one was still owed, so the photographs stayed on the phone
 * until it was wiped.
 *
 * WHAT IS HERE, AND WHAT IS NOT
 *
 * `put` and `open` are the only two functions that touch bytes, so a
 * deployment that wants an object store has one pair of functions to
 * replace. That other implementation does not exist. Files live in Postgres,
 * which is the same decision the brand assets made and for the same reason:
 * a contractor self hosting this should not need a bucket policy before they
 * can attach a photograph to a job.
 *
 * CONTENT ADDRESSED, SO A RETRY IS FREE. The key comes from the SHA-256 of
 * the bytes. A phone retrying over a metered connection, and the same
 * photograph attached to a job and to the report about it, both land on a
 * key that already exists, and `put` recognises it and stores nothing.
 */

export interface StoredFileView {
  id: string;
  storageKey: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
}

const view = (row: typeof schema.storedFile.$inferSelect): StoredFileView => ({
  id: row.id,
  storageKey: row.storageKey,
  contentType: row.contentType,
  sha256: row.sha256,
  sizeBytes: row.sizeBytes,
});

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Keep some bytes, or recognise that they are already kept.
 *
 * Takes a transaction rather than a context because almost every caller is
 * in the middle of something else: draining an upload queue, attaching to a
 * report, saving a signature. A file written in its own transaction can
 * survive a rollback of the thing it belonged to, which leaves bytes nothing
 * references and nothing knows to delete.
 *
 * The type is decided from the bytes and the claimed one is used only to
 * make the refusal legible. See core's `files` module for why.
 */
export async function put(
  tx: Database,
  organizationId: string,
  input: {
    bytes: Uint8Array;
    claimedType?: string | undefined;
    uploadedByUserId?: string | null;
    maxBytes?: number | undefined;
  },
): Promise<{ file: StoredFileView; alreadyHeld: boolean }> {
  const verdict = f.checkFile(input.bytes, {
    ...(input.claimedType ? { claimedType: input.claimedType } : {}),
    ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}),
  });
  if (!verdict.ok) throw new ConflictError(verdict.reason);

  const hash = sha256(input.bytes);
  const key = f.storageKey({ organizationId, sha256: hash, extension: verdict.extension });

  const [existing] = await tx.select().from(schema.storedFile)
    .where(and(
      eq(schema.storedFile.organizationId, organizationId),
      eq(schema.storedFile.storageKey, key),
      isNull(schema.storedFile.deletedAt),
    )).limit(1);

  if (existing) {
    /**
     * The bytes are not written again, and this is the whole point of a
     * content addressed key. A technician in a car park whose phone retries
     * an upload four times sends four copies of a four megabyte photograph
     * over their data allowance; storing four copies of it would be this
     * end of the same waste.
     */
    return { file: view(existing), alreadyHeld: true };
  }

  const [row] = await tx.insert(schema.storedFile).values({
    organizationId,
    storageKey: key,
    contentType: verdict.contentType,
    sha256: hash,
    sizeBytes: verdict.sizeBytes,
    bytes: Buffer.from(input.bytes),
    uploadedByUserId: input.uploadedByUserId ?? null,
  }).returning();

  return { file: view(row!), alreadyHeld: false };
}

/**
 * The bytes back, with the type they actually are.
 *
 * The content type returned is the SNIFFED one from the moment it was
 * stored, never anything a request asked for. Serving a file under a type a
 * caller chose is the second half of the upload vulnerability the first half
 * already refused.
 */
export async function open(
  ctx: ServiceContext,
  storageKey: string,
): Promise<{ bytes: Buffer; contentType: string; sizeBytes: number }> {
  return guardedRead(ctx, "document:read", async (tx) => {
    const [row] = await tx.select().from(schema.storedFile)
      .where(and(
        eq(schema.storedFile.organizationId, ctx.actor.organizationId),
        eq(schema.storedFile.storageKey, storageKey),
        isNull(schema.storedFile.deletedAt),
      )).limit(1);
    if (!row) throw new NotFoundError("File");
    return { bytes: row.bytes, contentType: row.contentType, sizeBytes: row.sizeBytes };
  });
}

/* ----------------------------------------------------------- attachments */

/**
 * Point something at a file.
 *
 * `attachment` is the reference and `stored_file` is the bytes, which is why
 * there are two tables: one photograph belongs to a job, to the report about
 * it and to the invoice that quotes it, and each of those is a separate
 * decision somebody can undo without destroying the image.
 */
export async function attach(
  tx: Database,
  organizationId: string,
  input: {
    entityType: string;
    entityId: string;
    storageKey: string;
    kind?: string | undefined;
    fileName?: string | null;
    contentType: string;
    sizeBytes: number;
    phase?: string | null;
    uploadedByUserId?: string | null;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(schema.attachment).values({
    organizationId,
    entityType: input.entityType,
    entityId: input.entityId,
    kind: input.kind ?? "photo",
    storageKey: input.storageKey,
    fileName: input.fileName ?? null,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    phase: input.phase ?? null,
    uploadedByUserId: input.uploadedByUserId ?? null,
  }).returning({ id: schema.attachment.id });

  await tx.update(schema.storedFile)
    .set({ references: sql`${schema.storedFile.references} + 1`, updatedAt: new Date() })
    .where(and(
      eq(schema.storedFile.organizationId, organizationId),
      eq(schema.storedFile.storageKey, input.storageKey),
    ));

  return { id: row!.id };
}

/** What is attached to one record. */
export async function attachmentsFor(
  ctx: ServiceContext,
  input: { entityType: string; entityId: string },
) {
  return guardedRead(ctx, "document:read", async (tx) => {
    const rows = await tx.select().from(schema.attachment)
      .where(and(
        eq(schema.attachment.organizationId, ctx.actor.organizationId),
        eq(schema.attachment.entityType, input.entityType),
        eq(schema.attachment.entityId, input.entityId),
        isNull(schema.attachment.deletedAt),
      ))
      .orderBy(desc(schema.attachment.createdAt));

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      storageKey: row.storageKey,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      phase: row.phase,
      createdAt: row.createdAt,
    }));
  });
}

/* -------------------------------------------------- the field upload queue */

export interface PendingUpload {
  id: string;
  clientId: string;
  subjectType: string;
  subjectId: string | null;
  contentType: string;
  byteSize: number | null;
  contentHash: string | null;
  attempts: number;
  lastError: string | null;
  capturedAt: Date | null;
}

/**
 * What the server is still waiting for from this device.
 *
 * The answer a phone needs when it comes back on a signal, and the thing
 * that did not exist: a device had no way to ask what was still owed, so a
 * photograph taken in a basement stayed in the camera roll.
 *
 * Abandoned rows are excluded and so are the ones that have run out of
 * attempts, because handing a phone work it has already failed five times is
 * how a queue spends a battery.
 */
export async function pendingFor(ctx: ServiceContext, deviceId: string): Promise<PendingUpload[]> {
  return guardedRead(ctx, "field:sync", async (tx) => {
    const rows = await tx.select().from(schema.fieldUpload)
      .where(and(
        eq(schema.fieldUpload.organizationId, ctx.actor.organizationId),
        eq(schema.fieldUpload.deviceId, deviceId),
        inArray(schema.fieldUpload.status, ["queued", "uploading", "failed"]),
      ))
      .orderBy(schema.fieldUpload.attempts, schema.fieldUpload.createdAt);

    return rows
      .filter((row) => f.shouldRetry(row.attempts))
      .map((row) => ({
        id: row.id,
        clientId: row.clientId,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        contentType: row.contentType,
        byteSize: row.byteSize,
        contentHash: row.contentHash,
        attempts: row.attempts,
        lastError: row.lastError,
        capturedAt: row.capturedAt,
      }));
  });
}

/**
 * The bytes for a queued upload, at last.
 *
 * Everything the row promised is written here in one transaction: the
 * storage key, the stored timestamp, the status, and the attachment that
 * makes the photograph appear on the record it was taken for. A version that
 * wrote the file and left the row queued would be the same defect one layer
 * further in.
 *
 * The device's declared `contentHash` is CHECKED rather than trusted. The
 * column's own comment says it "lets a retry be recognised as the same image
 * rather than uploaded twice", which only holds if a mismatch is noticed: a
 * phone whose hash disagrees with its bytes has sent a corrupted file, and
 * accepting it stores a photograph of nothing under a name that says
 * otherwise.
 */
export interface StoreOutcome {
  stored: boolean;
  /** Null when the bytes were refused. */
  storageKey: string | null;
  /** Null when they were kept. */
  reason: string | null;
  alreadyStored: boolean;
  attempts: number;
  willRetry: boolean;
}

export async function storeUpload(
  ctx: ServiceContext,
  input: { clientId: string; bytes: Uint8Array; caption?: string | undefined },
): Promise<StoreOutcome> {
  return guardedWrite(ctx, "field:sync", async (tx) => {
    const [row] = await tx.select().from(schema.fieldUpload)
      .where(and(
        eq(schema.fieldUpload.organizationId, ctx.actor.organizationId),
        eq(schema.fieldUpload.clientId, input.clientId),
      )).limit(1);
    if (!row) throw new NotFoundError("Upload");

    if (row.status === "stored" && row.storageKey) {
      /**
       * Already done. Absorbing rather than an error, because the case that
       * produces it is a phone that uploaded successfully and lost the
       * response, which is the ordinary weather this queue exists for.
       */
      return {
        stored: true, storageKey: row.storageKey, reason: null,
        alreadyStored: true, attempts: row.attempts, willRetry: false,
      };
    }

    /**
     * A REFUSAL IS RETURNED, NOT THROWN, AND THIS IS NOT A STYLE CHOICE.
     *
     * The first version threw a ConflictError after writing the attempt
     * count and the error onto the row. The throw rolled the transaction
     * back, taking the bookkeeping with it, so a phone could send the same
     * corrupted file forever: every attempt refused, every attempt
     * forgotten, the row still reading `queued` with zero attempts.
     *
     * Corruption on the way out of a van is ordinary weather for this
     * endpoint, not an exceptional condition, so it comes back as an outcome
     * the caller can act on and the count survives.
     */
    const actual = sha256(input.bytes);
    if (row.contentHash && row.contentHash.toLowerCase() !== actual) {
      const attempts = row.attempts + 1;
      const willRetry = f.shouldRetry(attempts);
      const reason = "The bytes do not match the hash the device declared for them, so the file arrived corrupted. Nothing was stored.";

      await tx.update(schema.fieldUpload).set({
        status: willRetry ? "failed" : "abandoned",
        attempts,
        lastError: reason,
        updatedAt: new Date(),
      }).where(eq(schema.fieldUpload.id, row.id));

      return { stored: false, storageKey: null, reason, alreadyStored: false, attempts, willRetry };
    }

    const stored = await put(tx, ctx.actor.organizationId, {
      bytes: input.bytes,
      claimedType: row.contentType,
      uploadedByUserId: ctx.actor.userId,
    });

    await tx.update(schema.fieldUpload).set({
      status: "stored",
      storageKey: stored.file.storageKey,
      storedAt: new Date(),
      byteSize: stored.file.sizeBytes,
      contentHash: actual,
      contentType: stored.file.contentType,
      caption: input.caption ?? row.caption,
      attempts: row.attempts + 1,
      lastError: null,
      updatedAt: new Date(),
    }).where(eq(schema.fieldUpload.id, row.id));

    /**
     * And onto the record it was taken for, which is the only reason any of
     * this happened. An upload that reached storage and never reached the
     * job is a photograph nobody will ever find.
     */
    if (row.subjectId) {
      await attach(tx, ctx.actor.organizationId, {
        entityType: row.subjectType === "signature" ? "visit" : row.subjectType,
        entityId: row.subjectId,
        storageKey: stored.file.storageKey,
        kind: row.subjectType === "signature" ? "signature" : "photo",
        contentType: stored.file.contentType,
        sizeBytes: stored.file.sizeBytes,
        fileName: input.caption ?? row.caption,
        uploadedByUserId: ctx.actor.userId,
      });
    }

    await audit(tx, ctx, "field_upload.stored", "field_upload", row.id, null, {
      storageKey: stored.file.storageKey,
      alreadyHeld: stored.alreadyHeld,
    });

    return {
      stored: true,
      storageKey: stored.file.storageKey,
      reason: null,
      alreadyStored: false,
      attempts: row.attempts + 1,
      willRetry: false,
    };
  });
}

/**
 * The device could not send it.
 *
 * Counted, because a queue with no attempt count retries forever, and after
 * the cap the row is abandoned rather than left to circle. An abandoned
 * upload is still a row somebody can look at and see what the error was,
 * which is the difference between a photograph that failed and one nobody
 * knew about.
 */
export async function failUpload(
  ctx: ServiceContext,
  input: { clientId: string; error: string },
) {
  return guardedWrite(ctx, "field:sync", async (tx) => {
    const [row] = await tx.select().from(schema.fieldUpload)
      .where(and(
        eq(schema.fieldUpload.organizationId, ctx.actor.organizationId),
        eq(schema.fieldUpload.clientId, input.clientId),
      )).limit(1);
    if (!row) throw new NotFoundError("Upload");

    if (row.status === "stored") {
      throw new ConflictError("That upload already arrived. A later failure report is about a retry of something that worked.");
    }

    const attempts = row.attempts + 1;
    const [updated] = await tx.update(schema.fieldUpload).set({
      status: f.shouldRetry(attempts) ? "failed" : "abandoned",
      attempts,
      lastError: input.error.slice(0, 500),
      updatedAt: new Date(),
    }).where(eq(schema.fieldUpload.id, row.id)).returning();

    return {
      status: updated!.status,
      attempts,
      willRetry: f.shouldRetry(attempts),
    };
  });
}

/**
 * How many photographs a record is still waiting for.
 *
 * The number that makes the original comment true. A service report that
 * mentions three photographs says so the moment it syncs; this is what lets
 * the screen add "one still uploading" rather than showing two and implying
 * that is all there were.
 */
export async function outstandingFor(
  ctx: ServiceContext,
  input: { subjectType: string; subjectId: string },
) {
  return guardedRead(ctx, "document:read", async (tx) => {
    const rows = await tx.select({
      status: schema.fieldUpload.status,
      attempts: schema.fieldUpload.attempts,
    }).from(schema.fieldUpload)
      .where(and(
        eq(schema.fieldUpload.organizationId, ctx.actor.organizationId),
        eq(schema.fieldUpload.subjectType, input.subjectType),
        eq(schema.fieldUpload.subjectId, input.subjectId),
      ));

    return {
      stored: rows.filter((r) => r.status === "stored").length,
      /** Still coming: queued, uploading, or failed with attempts left. */
      pending: rows.filter((r) =>
        r.status !== "stored" && r.status !== "abandoned" && f.shouldRetry(r.attempts)).length,
      /** Given up on. Named separately, because "still coming" and "never coming" are different things to tell somebody. */
      abandoned: rows.filter((r) =>
        r.status === "abandoned" || (r.status !== "stored" && !f.shouldRetry(r.attempts))).length,
    };
  });
}

/* --------------------------------------------------------------- handlers */

/**
 * Base64 in, base64 never out.
 *
 * The bytes go IN through a JSON field because that is the one request shape
 * every client can make, including an MCP tool call. They do not come back
 * the same way: a file is fetched from its own route, which sets the sniffed
 * content type and lets a browser cache it, rather than being inlined into a
 * JSON body that no image tag can point at.
 */
export const handlers = {
  listAttachments: async (ctx: ServiceContext, input: { entityType: string; entityId: string }) => ({
    attachments: await attachmentsFor(ctx, input),
  }),

  listPendingUploads: async (ctx: ServiceContext, input: { deviceId: string }) => ({
    uploads: await pendingFor(ctx, input.deviceId),
  }),

  storeUpload: (ctx: ServiceContext, input: {
    clientId: string; bytes: string; caption?: string | undefined;
  }) => storeUpload(ctx, {
    clientId: input.clientId,
    bytes: decode(input.bytes),
    ...(input.caption ? { caption: input.caption } : {}),
  }),

  failUpload: (ctx: ServiceContext, input: { clientId: string; error: string }): Promise<{
    status: string; attempts: number; willRetry: boolean;
  }> => failUpload(ctx, input),

  getUploadStatus: (ctx: ServiceContext, input: { subjectType: string; subjectId: string }) =>
    outstandingFor(ctx, input),
} as const;

/**
 * Base64 to bytes, refusing rather than producing garbage.
 *
 * Node's decoder ignores everything it does not recognise, so a truncated or
 * corrupted string comes back as a shorter buffer rather than an error. That
 * is the wrong failure: the shorter buffer then fails the signature check
 * with "that is not a PNG", which sends whoever is debugging it to look at
 * the camera rather than at the transport.
 */
function decode(encoded: string): Uint8Array {
  const cleaned = encoded.includes(",") ? encoded.slice(encoded.indexOf(",") + 1) : encoded;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new ConflictError("That is not base64. The file did not survive the trip here.");
  }
  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length === 0) throw new ConflictError("That file is empty.");
  return bytes;
}
