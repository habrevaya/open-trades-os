import { describe, it, expect, beforeEach } from "vitest";
import { FieldQueue, MemoryStorage, UploadQueue, type UploadFiles } from "../src/index";
import { FakeServer, sha256Base64 } from "./fake-server";

/**
 * Photographs and signatures, from the shutter to the server.
 *
 * Each test is a thing that happens to a file on a phone: the record lands
 * and the bytes do not, the answer to an upload is lost, the app dies between
 * writing the record and queueing it, the file is deleted from under it, the
 * bytes are corrupted on the way. The server is a fake that checks the hash
 * the way the real route does.
 */

const PHOTO = Buffer.from("not really a jpeg, but bytes all the same").toString("base64");

let storage: MemoryStorage;
let disk: Map<string, string>;
let server: FakeServer;
let ids: number;

const files: UploadFiles = {
  async read(uri) {
    const bytes = disk.get(uri);
    if (bytes === undefined) throw new Error("ENOENT");
    return bytes;
  },
  async remove(uri) { disk.delete(uri); },
};

const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const queue = () => new FieldQueue({ storage, deviceId: "device-1", newId });
const uploads = (q = queue()) => new UploadQueue({ storage, queue: q, files });

async function takePhoto(u: UploadQueue, uploadId = newId(), visitId = "v1") {
  const uri = `file:///uploads/${uploadId}.jpg`;
  disk.set(uri, PHOTO);
  return u.add({
    uploadId, visitId, kind: "photo", contentType: "image/jpeg",
    byteSize: Buffer.from(PHOTO, "base64").length, contentHash: sha256Base64(PHOTO), localUri: uri,
  });
}

beforeEach(() => {
  storage = new MemoryStorage();
  disk = new Map();
  server = new FakeServer();
  server.addVisit("v1");
  ids = 0;
});

describe("taking a photo", () => {
  it("queues the record of it, with the hash the server will check", async () => {
    const q = queue();
    const record = await takePhoto(uploads(q));
    const [op] = await q.pending();

    expect(op!.kind).toBe("attachment.attach");
    expect(op!.subjectId).toBe("v1");
    expect(op!.payload).toMatchObject({
      uploadId: record.uploadId, contentType: "image/jpeg", contentHash: record.contentHash,
    });
    expect(record.queued).toBe(true);
  });

  it("queues a signature as a signature", async () => {
    const q = queue();
    const u = uploads(q);
    disk.set("file:///sig.png", PHOTO);
    await u.add({
      uploadId: newId(), visitId: "v1", kind: "signature", contentType: "image/png",
      byteSize: 10, contentHash: sha256Base64(PHOTO), localUri: "file:///sig.png", caption: "Signed by Nina Patel",
    });
    const [op] = await q.pending();
    expect(op!.kind).toBe("signature.capture");
    expect(op!.payload["caption"]).toBe("Signed by Nina Patel");
  });
});

describe("sending the bytes", () => {
  it("waits until the server has the record, then sends, then deletes the file", async () => {
    const q = queue();
    const u = uploads(q);
    const record = await takePhoto(u);

    // The record has not been sent, so the server is owed nothing yet.
    let drained = await u.drain(server.uploads());
    expect(drained).toMatchObject({ sent: 0, waiting: 1 });
    expect(server.calls.store).toBe(0);

    await q.flush(server.transport());
    drained = await u.drain(server.uploads());
    expect(drained).toMatchObject({ sent: 1, waiting: 0 });
    expect(server.stored.has(record.uploadId)).toBe(true);
    expect(disk.has(record.localUri)).toBe(false);
  });

  it("stops at no signal without counting it against the file", async () => {
    const q = queue();
    const u = uploads(q);
    await takePhoto(u);
    await q.flush(server.transport());

    server.offline = true;
    const drained = await u.drain(server.uploads());
    expect(drained.offline).toBe(true);
    expect((await u.list())[0]).toMatchObject({ status: "waiting", attempts: 0 });
  });

  it("treats a file the server already has, and whose answer was lost, as sent", async () => {
    const q = queue();
    const u = uploads(q);
    const record = await takePhoto(u);
    await q.flush(server.transport());

    // It arrived, and the answer did not.
    const flaky = server.uploads();
    await flaky.store(record.uploadId, PHOTO);

    const drained = await u.drain(server.uploads());
    expect(drained.sent).toBe(1);
    expect((await u.list())[0]!.status).toBe("sent");
    expect(server.calls.store).toBe(1);
  });

  it("sends the bytes again when the server says they arrived corrupted", async () => {
    const q = queue();
    const u = uploads(q);
    const record = await takePhoto(u);
    await q.flush(server.transport());

    disk.set(record.localUri, Buffer.from("damaged on the way").toString("base64"));
    let drained = await u.drain(server.uploads());
    expect(drained.sent).toBe(0);
    expect((await u.list())[0]).toMatchObject({ status: "waiting", lastError: "The bytes do not match the hash." });

    disk.set(record.localUri, PHOTO);
    drained = await u.drain(server.uploads());
    expect(drained.sent).toBe(1);
  });

  it("tells the server, and the technician, when the file has gone from the phone", async () => {
    const q = queue();
    const u = uploads(q);
    const record = await takePhoto(u);
    await q.flush(server.transport());

    disk.delete(record.localUri);
    const drained = await u.drain(server.uploads());
    expect(drained.failed).toBe(1);
    expect(server.owed.has(record.uploadId)).toBe(false);
    expect((await u.list())[0]).toMatchObject({ status: "failed" });
  });

  it("does not ask the server anything when there is nothing to send", async () => {
    await uploads().drain(server.uploads());
    expect(server.calls.owed).toBe(0);
  });
});

describe("the app dying in the middle", () => {
  it("finishes queueing a record whose operation was never written", async () => {
    const q = queue();
    const u = uploads(q);
    const uploadId = newId();
    const uri = `file:///uploads/${uploadId}.jpg`;
    disk.set(uri, PHOTO);

    // The record is saved and the operation write fails: the phone died.
    storage.failWriteWhen = (key) => key.startsWith("otos.op.");
    await expect(u.add({
      uploadId, visitId: "v1", kind: "photo", contentType: "image/jpeg",
      byteSize: 10, contentHash: sha256Base64(PHOTO), localUri: uri,
    })).rejects.toThrow();
    expect(await q.pending()).toHaveLength(0);

    // Next launch.
    const restarted = new FieldQueue({ storage, deviceId: "device-1", newId });
    const u2 = new UploadQueue({ storage, queue: restarted, files });
    await u2.drain(server.uploads());
    expect((await restarted.pending()).map((o) => o.payload["uploadId"])).toEqual([uploadId]);

    /**
     * The crash burned sequence one, so the record is number two and the
     * server holds it, waiting. The first send learns that one is lost, the
     * second declares it, and the record lands.
     */
    const first = await restarted.flush(server.transport());
    expect(first.held).toBe(1);
    expect(first.skipping).toBe(1);
    await restarted.flush(server.transport());
    expect((await u2.drain(server.uploads())).sent).toBe(1);
  });

  it("keeps a photo taken offline across a restart", async () => {
    const q = queue();
    await takePhoto(uploads(q));
    const restarted = MemoryStorage.from(storage.snapshot());
    const u = new UploadQueue({
      storage: restarted,
      queue: new FieldQueue({ storage: restarted, deviceId: "device-1", newId }),
      files,
    });
    expect(await u.list()).toHaveLength(1);
  });
});

describe("a refused record", () => {
  it("marks the file failed rather than waiting for ever", async () => {
    const q = queue();
    const u = uploads(q);
    await takePhoto(u);
    await q.flush({
      async send(input) {
        return {
          results: input.operations.map((o) => ({
            clientId: o.clientId, status: "rejected" as const, conflict: null,
            rejection: "That visit is not here.", occurredAt: o.occurredAt, clamped: null,
          })),
          awaiting: [], snapshotRevision: 1,
        };
      },
    });

    const drained = await u.drain(server.uploads());
    expect(drained.failed).toBe(1);
    expect((await u.list())[0]!.lastError).toBe("That visit is not here.");
  });
});

describe("tidying up", () => {
  it("forgets sent files after a week, and keeps them until then", async () => {
    let clock = new Date("2026-10-02T12:00:00Z");
    const q = queue();
    const u = new UploadQueue({ storage, queue: q, files, now: () => clock });
    await takePhoto(u);
    await q.flush(server.transport());
    await u.drain(server.uploads());

    expect(await u.prune()).toBe(0);
    clock = new Date("2026-10-10T12:00:00Z");
    expect(await u.prune()).toBe(1);
    expect(await u.list()).toHaveLength(0);
  });

  it("dismisses a failed file and its bytes", async () => {
    const u = uploads();
    const record = await takePhoto(u);
    expect(await u.dismiss(record.uploadId)).toBe(true);
    expect(disk.has(record.localUri)).toBe(false);
    expect(await u.list()).toHaveLength(0);
  });

  it("does not need the network to dismiss", async () => {
    server.offline = true;
    const u = uploads();
    const record = await takePhoto(u);
    await expect(u.dismiss(record.uploadId)).resolves.toBe(true);
  });
});
