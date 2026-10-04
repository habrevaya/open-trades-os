import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID } from "@opentradesos/core";
import { guardedRead, inTenant, type ServiceContext } from "./context";
import { sha256 } from "./files";
import { fileStorage, FileStorageNotConfiguredError, type FileBucket } from "../storage";

/**
 * MOVING FILES BETWEEN POSTGRES AND A BUCKET, ONE VERIFIED FILE AT A TIME
 *
 * A deployment that outgrows keeping photographs in Postgres sets
 * `FILE_STORAGE=s3`, and from then on new files go to the bucket. The files
 * already kept stay where they are until this moves them, which it does while
 * the product is in use:
 *
 *   EACH FILE IS ITS OWN TRANSACTION. Its row is locked, its bytes are copied,
 *   the copy is READ BACK and its SHA-256 checked against the row's, and only
 *   then does the row change to say where the bytes now are. Readers follow the
 *   row (`files.bytesOf`), so at every moment a file is readable from exactly
 *   one place, and a move that dies halfway leaves every file either moved and
 *   verified or not moved at all.
 *
 *   THE HASH IS CHECKED TWICE. Once on the bytes as they leave, against the
 *   checksum taken when they were first stored, which is the only check that
 *   would ever notice a file that rotted where it was; and once on the copy, so
 *   a bucket that stored something other than what it was sent is caught before
 *   the original is let go.
 *
 * And back again, for a deployment leaving a bucket: the same steps the other
 * way, with the object deleted only after the row says the bytes are home.
 */

const system = (db: Database, organizationId: string): ServiceContext => ({
  actor: { userId: SYSTEM_USER_ID, organizationId, roles: [] }, db,
});

export interface MoveResult {
  organizationId: string;
  /** Moved and verified. */
  moved: number;
  /** Bytes moved, for the command's running total. */
  bytes: number;
  /** Left where they were, each with the reason. */
  failed: { storageKey: string; reason: string }[];
  /** A bucket copy that could not be deleted after a move home. The file is safe; the bucket has a spare. */
  leftBehind: string[];
  /** The last file looked at, to carry on from. Null when there was nothing left to look at. */
  last: string | null;
}

function bucketOrThrow(): FileBucket {
  const bucket = fileStorage().bucket;
  if (!bucket) {
    throw new FileStorageNotConfiguredError(
      "There is no bucket configured. Set FILE_STORAGE_S3_ENDPOINT, FILE_STORAGE_S3_BUCKET, "
      + "FILE_STORAGE_S3_ACCESS_KEY_ID and FILE_STORAGE_S3_SECRET_ACCESS_KEY.",
    );
  }
  return bucket;
}

/**
 * How many files a company has in each place, and how many bytes, for the
 * export screen. Under `data:export`, the permission of the screen it is on.
 */
export async function census(ctx: ServiceContext): Promise<{
  postgres: { files: number; bytes: number }; object: { files: number; bytes: number };
}> {
  return guardedRead(ctx, "data:export", async (tx) => {
    const rows = await tx.select({
      storedIn: schema.storedFile.storedIn,
      files: sql<number>`count(*)::int`,
      bytes: sql<string>`coalesce(sum(${schema.storedFile.sizeBytes}), 0)::text`,
    }).from(schema.storedFile).where(isNull(schema.storedFile.deletedAt)).groupBy(schema.storedFile.storedIn);
    const of = (where: string) => {
      const row = rows.find((r) => r.storedIn === where);
      return { files: row?.files ?? 0, bytes: Number(row?.bytes ?? 0) };
    };
    return { postgres: of("postgres"), object: of("object") };
  });
}

/**
 * Move up to `limit` of one company's files to `to`.
 *
 * Returns what happened to each rather than stopping at the first failure,
 * because one photograph the bucket refuses should not hold up the other ten
 * thousand, and the command prints the failures at the end.
 */
export async function moveFiles(
  db: Database, organizationId: string,
  options: { to: "object" | "postgres"; limit?: number; after?: string | undefined },
): Promise<MoveResult> {
  const bucket = bucketOrThrow();
  const from = options.to === "object" ? "postgres" : "object";
  const ctx = system(db, organizationId);
  const result: MoveResult = { organizationId, moved: 0, bytes: 0, failed: [], leftBehind: [], last: null };

  /** In id order from `after`, so a batch of files that all fail does not hide the ones behind it. */
  const ids = await inTenant(ctx, (tx) => tx.select({ id: schema.storedFile.id }).from(schema.storedFile)
    .where(and(
      eq(schema.storedFile.storedIn, from), isNull(schema.storedFile.deletedAt),
      options.after ? gt(schema.storedFile.id, options.after) : undefined,
    ))
    .orderBy(asc(schema.storedFile.id))
    .limit(options.limit ?? 200));
  result.last = ids[ids.length - 1]?.id ?? null;

  for (const { id } of ids) {
    let leftInBucket: string | null = null;
    try {
      const outcome = await inTenant(ctx, async (tx) => {
        const [row] = await tx.select().from(schema.storedFile)
          .where(and(eq(schema.storedFile.id, id), eq(schema.storedFile.storedIn, from), isNull(schema.storedFile.deletedAt)))
          .limit(1).for("update");
        // Moved, deleted or revived by somebody else since the list was read: nothing to do.
        if (!row) return null;

        if (options.to === "object") {
          const bytes = row.bytes!;
          if (sha256(bytes) !== row.sha256) {
            return { failed: "The bytes in the database do not match the checksum taken when the file was stored, so the file was left where it is for somebody to look at." };
          }
          const objectKey = `${bucket.prefix}${row.storageKey}`;
          await bucket.client.put(objectKey, bytes, row.contentType);
          const copy = await bucket.client.get(objectKey);
          if (!copy || sha256(copy) !== row.sha256) {
            await bucket.client.delete(objectKey).catch(() => undefined);
            return { failed: "The copy read back from the bucket did not match the original, so the original was kept and the copy deleted." };
          }
          await tx.update(schema.storedFile).set({
            storedIn: "object", objectKey, bytes: null, updatedAt: new Date(),
          }).where(eq(schema.storedFile.id, row.id));
          return { moved: row.sizeBytes };
        }

        const held = await bucket.client.get(row.objectKey!);
        if (!held) return { failed: `The bucket has no object at ${row.objectKey}.` };
        if (sha256(held) !== row.sha256) {
          return { failed: "The object in the bucket does not match the checksum taken when the file was stored, so it was left where it is." };
        }
        await tx.update(schema.storedFile).set({
          storedIn: "postgres", objectKey: null, bytes: Buffer.from(held), updatedAt: new Date(),
        }).where(eq(schema.storedFile.id, row.id));
        leftInBucket = row.objectKey;
        return { moved: row.sizeBytes };
      });
      if (!outcome) continue;
      if ("failed" in outcome) {
        const [row] = await inTenant(ctx, (tx) => tx.select({ key: schema.storedFile.storageKey })
          .from(schema.storedFile).where(eq(schema.storedFile.id, id)).limit(1));
        result.failed.push({ storageKey: row?.key ?? id, reason: outcome.failed });
        continue;
      }
      result.moved += 1;
      result.bytes += outcome.moved;
      /**
       * The object goes only after the row saying the bytes are home has been
       * committed. Deleting it first would leave a window, however short, in
       * which the only copy was in an open transaction.
       */
      if (leftInBucket) {
        const key: string = leftInBucket;
        await bucket.client.delete(key).catch(() => { result.leftBehind.push(key); });
      }
    } catch (error) {
      result.failed.push({ storageKey: id, reason: (error as Error).message });
    }
  }
  return result;
}

/**
 * Delete from the bucket the objects of files that were removed.
 *
 * A retention purge or a deleted call recording empties the row at once and
 * leaves the object's key on it, because deleting an object inside a
 * transaction that might still roll back would lose a file the row still
 * names. This finishes the job, under the row's lock, re-checking that the
 * file is still deleted: the same bytes stored again in the meantime revive
 * the row and must keep their object.
 */
export async function sweepDeleted(db: Database, organizationId: string, limit = 100): Promise<number> {
  const bucket = fileStorage().bucket;
  if (!bucket) return 0;
  const ctx = system(db, organizationId);
  const ids = await inTenant(ctx, (tx) => tx.select({ id: schema.storedFile.id }).from(schema.storedFile)
    .where(and(eq(schema.storedFile.storedIn, "object"), isNotNull(schema.storedFile.deletedAt)))
    .limit(limit));
  let swept = 0;
  for (const { id } of ids) {
    await inTenant(ctx, async (tx) => {
      const [row] = await tx.select().from(schema.storedFile)
        .where(and(eq(schema.storedFile.id, id), eq(schema.storedFile.storedIn, "object"), isNotNull(schema.storedFile.deletedAt)))
        .limit(1).for("update");
      if (!row) return;
      await bucket.client.delete(row.objectKey!);
      await tx.update(schema.storedFile).set({
        storedIn: "postgres", objectKey: null, bytes: Buffer.alloc(0), updatedAt: new Date(),
      }).where(eq(schema.storedFile.id, row.id));
      swept += 1;
    });
  }
  return swept;
}

/** The worker's share: every company with removed files still in the bucket, a batch each. */
export async function sweepPass(db: Database): Promise<number> {
  if (!fileStorage().bucket) return 0;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.file_store_organizations('sweep', 50)`,
  );
  let swept = 0;
  for (const row of rows) swept += await sweepDeleted(db, row.organization_id);
  return swept;
}
