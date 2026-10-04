import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as files from "../src/services/files";
import * as fileStorage from "../src/services/file-storage";
import { inArray } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { inTenant } from "../src/services/context";
import { useFileStorage, fileStorageFromEnv, s3Client, FileStorageNotConfiguredError, type FileStorage } from "../src/storage";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";
import { fakeBucket, type FakeBucket } from "./s3-fake";

/**
 * FILES IN A BUCKET, AND THE MOVE BETWEEN THE TWO PLACES
 *
 * Against a bucket served in this process over real HTTP, which checks every
 * request's signature with its own implementation. What is under test is the
 * promise to a deployment that moves its photographs while the office is
 * working: a file is readable at every moment, from wherever its row says it
 * is; nothing moves until the copy has been read back and its hash checked; a
 * file removed for retention is removed from the bucket too; and Postgres is
 * still the default for a self hoster who never sets any of this.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("files30:org");
const USER = fixtureId("files30:user");

let raw: postgres.Sql;
let bucket: FakeBucket;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

/** A one pixel PNG, made different by a trailing chunk so each call is its own file. */
function png(n: number): Buffer {
  const base = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5b3f5d90000000049454e44ae426082", "hex");
  return Buffer.concat([base, Buffer.from(`#${n}`)]);
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function storage(writeTo: "postgres" | "object"): FileStorage {
  return {
    writeTo,
    bucket: {
      client: s3Client({
        endpoint: bucket.url, bucket: bucket.bucket, region: "us-east-1",
        accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey, pathStyle: true,
      }),
      prefix: "files/",
    },
  };
}

async function customerId(): Promise<string> {
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Pat', 0) returning id`;
  return customer!.id;
}

async function attach(n: number): Promise<{ storageKey: string; bytes: Buffer }> {
  const bytes = png(n);
  const made = await files.upload(owner(), {
    entityType: "customer", entityId: await customerId(), fileName: `${n}.png`, bytes: bytes.toString("base64"),
  });
  return { storageKey: made.storageKey, bytes };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  bucket = await fakeBucket();
});
afterAll(async () => {
  useFileStorage(null);
  if (bucket) await bucket.close();
  if (raw) {
    await resetOrg(raw, ORG);
    await raw.end();
  }
});
beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Files Co", slug: "files30-co" });
  bucket.objects.clear();
});
afterEach(() => useFileStorage(null));

run("choosing where files go", () => {
  it("keeps files in Postgres when nothing says otherwise", () => {
    expect(fileStorageFromEnv({}).writeTo).toBe("postgres");
    expect(fileStorageFromEnv({}).bucket).toBeNull();
  });

  it("refuses half a bucket's settings rather than quietly filling the database", () => {
    expect(() => fileStorageFromEnv({ FILE_STORAGE: "s3", FILE_STORAGE_S3_BUCKET: "b" }))
      .toThrow(FileStorageNotConfiguredError);
    expect(() => fileStorageFromEnv({ FILE_STORAGE: "gcs" })).toThrow(/postgres or s3/);
  });

  it("puts a new file in the bucket, keeps no bytes on the row, and reads it back", async () => {
    useFileStorage(storage("object"));
    const { storageKey, bytes } = await attach(1);
    const [row] = await raw<{ stored_in: string; object_key: string; bytes: Buffer | null }[]>`
      select stored_in, object_key, bytes from public.stored_file where storage_key = ${storageKey}`;
    expect(row).toMatchObject({ stored_in: "object", object_key: `files/${storageKey}`, bytes: null });
    expect(bucket.objects.get(`files/${storageKey}`)?.body).toEqual(bytes);
    expect((await files.open(owner(), storageKey)).bytes).toEqual(bytes);
  });

  it("refuses to read a file in a bucket when the deployment has none configured, and says which settings", async () => {
    useFileStorage(storage("object"));
    const { storageKey } = await attach(2);
    useFileStorage({ writeTo: "postgres", bucket: null });
    await expect(files.open(owner(), storageKey)).rejects.toThrow(/FILE_STORAGE_S3_/);
  });
});

run("moving files while they are in use", () => {
  it("moves each file into the bucket only after the copy has been read back and checked", async () => {
    const a = await attach(3);
    const b = await attach(4);
    useFileStorage(storage("object"));
    const result = await fileStorage.moveFiles(db(), ORG, { to: "object" });
    expect(result.moved).toBe(2);
    expect(result.failed).toEqual([]);
    for (const file of [a, b]) {
      const [row] = await raw<{ stored_in: string; bytes: Buffer | null }[]>`
        select stored_in, bytes from public.stored_file where storage_key = ${file.storageKey}`;
      expect(row).toMatchObject({ stored_in: "object", bytes: null });
      expect((await files.open(owner(), file.storageKey)).bytes).toEqual(file.bytes);
    }
  });

  it("reads every file from wherever it is while the move is halfway", async () => {
    const a = await attach(5);
    const b = await attach(6);
    useFileStorage(storage("object"));
    await fileStorage.moveFiles(db(), ORG, { to: "object", limit: 1 });
    const places = await raw<{ stored_in: string }[]>`select stored_in from public.stored_file where organization_id = ${ORG} order by stored_in`;
    expect(places.map((p) => p.stored_in)).toEqual(["object", "postgres"]);
    expect((await files.open(owner(), a.storageKey)).bytes).toEqual(a.bytes);
    expect((await files.open(owner(), b.storageKey)).bytes).toEqual(b.bytes);
  });

  it("leaves a file where it is when the bucket keeps something other than what it was sent", async () => {
    const a = await attach(7);
    useFileStorage(storage("object"));
    bucket.corruptWrites = true;
    try {
      const result = await fileStorage.moveFiles(db(), ORG, { to: "object" });
      expect(result.moved).toBe(0);
      expect(result.failed[0]!.reason).toMatch(/did not match the original/);
    } finally {
      bucket.corruptWrites = false;
    }
    const [row] = await raw<{ stored_in: string }[]>`select stored_in from public.stored_file where storage_key = ${a.storageKey}`;
    expect(row!.stored_in).toBe("postgres");
    expect(bucket.objects.has(`files/${a.storageKey}`)).toBe(false);
    expect((await files.open(owner(), a.storageKey)).bytes).toEqual(a.bytes);
  });

  it("leaves a file that has rotted in the database where it is, for somebody to look at", async () => {
    const a = await attach(8);
    await raw`update public.stored_file set bytes = '\\x00'::bytea where storage_key = ${a.storageKey}`;
    useFileStorage(storage("object"));
    const result = await fileStorage.moveFiles(db(), ORG, { to: "object" });
    expect(result.failed[0]!.reason).toMatch(/do not match the checksum/);
    expect(bucket.objects.size).toBe(0);
  });

  it("moves files home again, and only then deletes the bucket's copy", async () => {
    useFileStorage(storage("object"));
    const a = await attach(9);
    useFileStorage(storage("postgres"));
    const result = await fileStorage.moveFiles(db(), ORG, { to: "postgres" });
    expect(result.moved).toBe(1);
    const [row] = await raw<{ stored_in: string; object_key: string | null; bytes: Buffer }[]>`
      select stored_in, object_key, bytes from public.stored_file where storage_key = ${a.storageKey}`;
    expect(row).toMatchObject({ stored_in: "postgres", object_key: null });
    expect(sha(row!.bytes)).toBe(sha(a.bytes));
    expect(bucket.objects.size).toBe(0);
  });

  it("carries on past a batch of files that all fail, rather than stopping at them", async () => {
    await attach(10);
    await attach(11);
    const [first] = await raw<{ id: string; storage_key: string }[]>`
      select id, storage_key from public.stored_file where organization_id = ${ORG} order by id limit 1`;
    await raw`update public.stored_file set bytes = '\\x00'::bytea where id = ${first!.id}`;
    useFileStorage(storage("object"));
    const one = await fileStorage.moveFiles(db(), ORG, { to: "object", limit: 1 });
    expect(one.moved).toBe(0);
    const two = await fileStorage.moveFiles(db(), ORG, { to: "object", limit: 1, after: one.last! });
    expect(two.moved).toBe(1);
  });
});

run("removing a file that is in a bucket", () => {
  it("empties the row at once and deletes the object on the worker's sweep", async () => {
    useFileStorage(storage("object"));
    const { storageKey } = await attach(12);
    await raw`update public.stored_file set ${raw({ deleted_at: new Date() })} where storage_key = ${storageKey}`;
    expect(await fileStorage.sweepDeleted(db(), ORG)).toBe(1);
    expect(bucket.objects.size).toBe(0);
    const [row] = await raw<{ stored_in: string; object_key: string | null }[]>`
      select stored_in, object_key from public.stored_file where storage_key = ${storageKey}`;
    expect(row).toEqual({ stored_in: "postgres", object_key: null });
  });

  it("keeps the object of a file stored again before the sweep reached it", async () => {
    useFileStorage(storage("object"));
    const { storageKey, bytes } = await attach(13);
    await raw`update public.stored_file set deleted_at = now(), bytes = null where storage_key = ${storageKey}`;
    // The same bytes arrive again: the row is revived, and the sweep must leave it alone.
    await attach(13);
    expect(await fileStorage.sweepDeleted(db(), ORG)).toBe(0);
    expect((await files.open(owner(), storageKey)).bytes).toEqual(bytes);
  });

  it("empties a removed file's row the same way whichever place its bytes are in", async () => {
    /**
     * `emptied` is what a retention purge and a deleted call recording write.
     * A row in Postgres loses its bytes there and then; a row in the bucket
     * keeps its object key for the sweep, which is the only safe order.
     */
    const kept = await attach(15);
    useFileStorage(storage("object"));
    const away = await attach(16);
    await inTenant(owner(), (tx) => tx.update(schema.storedFile).set(files.emptied())
      .where(inArray(schema.storedFile.storageKey, [kept.storageKey, away.storageKey])));
    const rows = await raw<{ storage_key: string; stored_in: string; object_key: string | null; size: number | null }[]>`
      select storage_key, stored_in, object_key, octet_length(bytes) as size from public.stored_file
      where organization_id = ${ORG} and deleted_at is not null`;
    expect(rows.find((r) => r.storage_key === kept.storageKey)).toMatchObject({ stored_in: "postgres", object_key: null, size: 0 });
    expect(rows.find((r) => r.storage_key === away.storageKey)).toMatchObject({ stored_in: "object", size: null });
    expect(await fileStorage.sweepDeleted(db(), ORG)).toBe(1);
    expect(bucket.objects.size).toBe(0);
  });
});
