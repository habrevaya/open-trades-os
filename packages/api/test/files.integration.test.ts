import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as files from "../src/services/files";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { inTenant, ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * THE PHOTOGRAPHS THAT STAYED ON THE PHONE
 *
 * `field_upload` was written by one place and advanced by nothing. A
 * technician taking three photographs on a job produced three rows under a
 * comment explaining that "the record is written before the bytes arrive" so
 * a report "should say so the moment it syncs, with the images following
 * behind". The images never followed: `status` sat at its `queued` default
 * forever, `storage_key`, `stored_at`, `attempts` and `last_error` were
 * written by nothing, and the index built for a retry queue indexed a queue
 * nothing consumed.
 *
 * There was nowhere for the bytes to go either. `attachment.storage_key` is
 * NOT NULL and no code wrote a row, because the product had no store.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("files:org");
const USER = fixtureId("files:user");

let raw: postgres.Sql;
let deviceId = "";
let visitId = "";
let jobId = "";

const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** A real PNG header, so the sniffer has something true to find. */
const png = (marker: number) =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, marker]);
const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const queue = (over: Record<string, unknown> = {}) => raw<{ id: string; client_id: string }[]>`
  insert into public.field_upload
    (organization_id, device_id, client_id, subject_type, subject_id, content_type, content_hash, status, attempts)
  values (${ORG}, ${deviceId},
          ${(over["clientId"] as string) ?? `upload-${Math.random().toString(36).slice(2)}`},
          ${(over["subjectType"] as string) ?? "visit"},
          ${(over["subjectId"] as string | null) ?? visitId},
          'image/jpeg',
          ${(over["contentHash"] as string | null) ?? null},
          ${(over["status"] as string) ?? "queued"},
          ${(over["attempts"] as number) ?? 0})
  returning id, client_id`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Photo Co", slug: "photo-co" });

  const [membership] = await raw<{ id: string }[]>`select id from public.membership
    where organization_id = ${ORG} and user_id = ${USER}`;
  const [technician] = await raw<{ id: string }[]>`insert into public.technician
    (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Sam Ortiz') returning id`;
  const [device] = await raw<{ id: string }[]>`insert into public.device
    (organization_id, technician_id, installation_id, platform)
    values (${ORG}, ${technician!.id}, 'install-1', 'ios') returning id`;
  deviceId = device!.id;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Photo Customer", phone: "+15125550166",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "4 Photo Pl", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  const job = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "Photo job", tags: [], customFields: {},
  });
  jobId = job.id;
  const visit = await jobs.addVisit(owner(), {
    id: job.id,
    windowStart: new Date(Date.now() + 86_400_000).toISOString(),
    windowEnd: new Date(Date.now() + 90_000_000).toISOString(),
    estimatedDurationMinutes: 60,
    technicianIds: [],
  });
  visitId = visit.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.field_upload where organization_id = ${ORG}`;
  await raw`delete from public.attachment where organization_id = ${ORG}`;
  await raw`delete from public.stored_file where organization_id = ${ORG}`;
});

run("keeping bytes", () => {
  it("stores a file and gives it a content addressed key", async () => {
    const bytes = png(1);
    const stored = await inTenant(owner(), (tx) => files.put(tx, ORG, { bytes }));

    expect(stored.alreadyHeld).toBe(false);
    expect(stored.file.contentType).toBe("image/png");
    expect(stored.file.storageKey).toContain(hashOf(bytes));
    expect(stored.file.storageKey.startsWith(`${ORG}/`)).toBe(true);
  });

  it("recognises the same bytes rather than storing them twice", async () => {
    const bytes = png(2);
    const first = await inTenant(owner(), (tx) => files.put(tx, ORG, { bytes }));
    const second = await inTenant(owner(), (tx) => files.put(tx, ORG, { bytes }));

    expect(second.alreadyHeld).toBe(true);
    expect(second.file.storageKey).toBe(first.file.storageKey);

    const [count] = await raw<{ n: string }[]>`
      select count(*) as n from public.stored_file where organization_id = ${ORG}`;
    expect(Number(count!.n)).toBe(1);
  });

  it("decides the type from the bytes and ignores what it was told", async () => {
    const stored = await inTenant(owner(), (tx) =>
      files.put(tx, ORG, { bytes: png(3), claimedType: "application/pdf" }));
    expect(stored.file.contentType).toBe("image/png");
  });

  it("refuses something that is not a file this product renders", async () => {
    const svg = new TextEncoder().encode("<svg><script/></svg>");
    await expect(inTenant(owner(), (tx) => files.put(tx, ORG, { bytes: svg })))
      .rejects.toThrow(ConflictError);
  });

  it("gives the bytes back with the type they actually are", async () => {
    const bytes = png(4);
    const stored = await inTenant(owner(), (tx) =>
      files.put(tx, ORG, { bytes, claimedType: "text/html" }));

    const opened = await files.open(owner(), stored.file.storageKey);
    /**
     * Never the claimed type. Serving a file under a type the caller chose
     * is the second half of the upload vulnerability the first half refused.
     */
    expect(opened.contentType).toBe("image/png");
    expect(Uint8Array.from(opened.bytes)).toEqual(bytes);
  });

  it("will not hand a file to another company", async () => {
    const stored = await inTenant(owner(), (tx) => files.put(tx, ORG, { bytes: png(5) }));
    const stranger: ServiceContext = {
      actor: { userId: USER, organizationId: fixtureId("files:other"), roles: ["owner"] as Actor["roles"] },
      db: db(),
    };
    await expect(files.open(stranger, stored.file.storageKey)).rejects.toThrow(NotFoundError);
  });
});

run("the queue a device can finally drain", () => {
  it("tells a device what is still owed", async () => {
    const [row] = await queue();
    const pending = await files.pendingFor(owner(), deviceId);
    expect(pending.map((p) => p.clientId)).toEqual([row!.client_id]);
  });

  it("does not hand back what has already arrived", async () => {
    await queue({ status: "stored" });
    await queue({ clientId: "still-owed" });

    const pending = await files.pendingFor(owner(), deviceId);
    expect(pending.map((p) => p.clientId)).toEqual(["still-owed"]);
  });

  it("stops offering work a phone has failed to the cap", async () => {
    /**
     * A queue with no cap spends a technician's battery and data allowance
     * re-sending a photograph the server has already refused five times.
     */
    await queue({ clientId: "hopeless", status: "failed", attempts: 5 });
    await queue({ clientId: "worth-another-go", status: "failed", attempts: 4 });

    const pending = await files.pendingFor(owner(), deviceId);
    expect(pending.map((p) => p.clientId)).toEqual(["worth-another-go"]);
  });
});

run("the bytes arriving at last", () => {
  it("stores them, stamps the row, and puts the photo on the visit", async () => {
    const bytes = png(10);
    const [row] = await queue({ clientId: "arrives", contentHash: hashOf(bytes) });

    const result = await files.storeUpload(owner(), { clientId: "arrives", bytes, caption: "Before" });
    expect(result.alreadyStored).toBe(false);

    const [stamped] = await raw<{
      status: string; storage_key: string; stored_at: Date; attempts: number; last_error: string | null;
    }[]>`select status, storage_key, stored_at, attempts, last_error
         from public.field_upload where id = ${row!.id}`;
    /** Every column the schema promised and nothing wrote. */
    expect(stamped!.status).toBe("stored");
    expect(stamped!.storage_key).toBe(result.storageKey);
    expect(stamped!.stored_at).not.toBeNull();
    expect(stamped!.attempts).toBe(1);
    expect(stamped!.last_error).toBeNull();

    /**
     * And onto the record it was taken for, in the same transaction. An
     * upload that reached storage and not the visit is a photograph nobody
     * will ever find.
     */
    const attached = await files.attachmentsFor(owner(), { entityType: "visit", entityId: visitId });
    expect(attached).toHaveLength(1);
    expect(attached[0]!.storageKey).toBe(result.storageKey);
    expect(attached[0]!.contentType).toBe("image/png");
  });

  it("refuses bytes that do not match the hash the device declared", async () => {
    /**
     * The column's comment says the hash "lets a retry be recognised as the
     * same image rather than uploaded twice", which only holds if a mismatch
     * is noticed. Accepting one stores a corrupted photograph under a name
     * saying it is fine.
     */
    const [row] = await queue({ clientId: "corrupt", contentHash: hashOf(png(20)) });

    const outcome = await files.storeUpload(owner(), { clientId: "corrupt", bytes: png(21) });
    expect(outcome.stored).toBe(false);
    expect(outcome.reason).toContain("do not match the hash");
    expect(outcome.willRetry).toBe(true);

    /**
     * The count SURVIVED the refusal, which is the whole reason this comes
     * back as an outcome rather than a thrown error. The first version threw
     * after writing these columns; the throw rolled the transaction back and
     * the row stayed queued with zero attempts, so the phone could resend
     * the same corrupted file forever.
     */
    const [after] = await raw<{ status: string; attempts: number; last_error: string; storage_key: string | null }[]>`
      select status, attempts, last_error, storage_key from public.field_upload where id = ${row!.id}`;
    expect(after!.status).toBe("failed");
    expect(after!.attempts).toBe(1);
    expect(after!.last_error).toContain("hash");
    expect(after!.storage_key).toBeNull();

    const [count] = await raw<{ n: string }[]>`
      select count(*) as n from public.stored_file where organization_id = ${ORG}`;
    expect(Number(count!.n), "nothing was stored").toBe(0);
  });

  it("treats a lost response as the ordinary weather it is", async () => {
    const bytes = png(11);
    await queue({ clientId: "twice", contentHash: hashOf(bytes) });

    const first = await files.storeUpload(owner(), { clientId: "twice", bytes });
    const second = await files.storeUpload(owner(), { clientId: "twice", bytes });

    expect(second.alreadyStored).toBe(true);
    expect(second.storageKey).toBe(first.storageKey);

    /** And not a second copy on the visit. */
    const attached = await files.attachmentsFor(owner(), { entityType: "visit", entityId: visitId });
    expect(attached).toHaveLength(1);
  });

  it("accepts an upload whose device declared no hash", async () => {
    await queue({ clientId: "no-hash", contentHash: null });
    const result = await files.storeUpload(owner(), { clientId: "no-hash", bytes: png(12) });
    expect(result.alreadyStored).toBe(false);

    const [stored] = await raw<{ content_hash: string }[]>`
      select content_hash from public.field_upload where client_id = 'no-hash'`;
    /** And the hash is recorded now, so a later retry can be recognised. */
    expect(stored!.content_hash).toBe(hashOf(png(12)));
  });

  it("refuses an upload nothing queued", async () => {
    await expect(files.storeUpload(owner(), { clientId: "never-announced", bytes: png(13) }))
      .rejects.toThrow(NotFoundError);
  });
});

run("when a phone cannot send", () => {
  it("counts the attempt and keeps the error", async () => {
    await queue({ clientId: "flaky" });
    const result = await files.failUpload(owner(), { clientId: "flaky", error: "No signal in the crawlspace." });

    expect(result).toEqual({ status: "failed", attempts: 1, willRetry: true });

    const [row] = await raw<{ last_error: string }[]>`
      select last_error from public.field_upload where client_id = 'flaky'`;
    expect(row!.last_error).toContain("crawlspace");
  });

  it("gives up at the cap rather than circling forever", async () => {
    await queue({ clientId: "doomed", status: "failed", attempts: 4 });
    const result = await files.failUpload(owner(), { clientId: "doomed", error: "Still nothing." });

    expect(result.status).toBe("abandoned");
    expect(result.willRetry).toBe(false);

    /**
     * Abandoned is still a row somebody can read the error off, which is the
     * difference between a photograph that failed and one nobody knew about.
     */
    const [row] = await raw<{ last_error: string }[]>`
      select last_error from public.field_upload where client_id = 'doomed'`;
    expect(row!.last_error).toBe("Still nothing.");
  });

  it("refuses a failure report about something that already arrived", async () => {
    const bytes = png(14);
    await queue({ clientId: "arrived", contentHash: hashOf(bytes) });
    await files.storeUpload(owner(), { clientId: "arrived", bytes });

    await expect(files.failUpload(owner(), { clientId: "arrived", error: "timeout" }))
      .rejects.toThrow(ConflictError);
  });
});

run("what a screen can finally say", () => {
  it("separates what is coming from what is never coming", async () => {
    const bytes = png(15);
    await queue({ clientId: "done", contentHash: hashOf(bytes) });
    await files.storeUpload(owner(), { clientId: "done", bytes });

    await queue({ clientId: "coming" });
    await queue({ clientId: "gone", status: "abandoned", attempts: 5 });

    const status = await files.outstandingFor(owner(), { subjectType: "visit", subjectId: visitId });
    expect(status).toEqual({ stored: 1, pending: 1, abandoned: 1 });
  });

  it("counts a failed upload that has run out of attempts as never coming", async () => {
    /**
     * Its status is still `failed`, not `abandoned`, because it ran out
     * without anybody reporting the last one. A count that read the status
     * alone would promise a photograph that no device will ever send.
     */
    await queue({ clientId: "out-of-road", status: "failed", attempts: 5 });

    const status = await files.outstandingFor(owner(), { subjectType: "visit", subjectId: visitId });
    expect(status).toEqual({ stored: 0, pending: 0, abandoned: 1 });
  });
});
