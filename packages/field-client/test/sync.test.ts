import { describe, it, expect, beforeEach } from "vitest";
import {
  FieldQueue, MemoryStorage, SyncEngine, UploadQueue, type UploadFiles,
} from "../src/index";
import { FakeServer, sha256Base64 } from "./fake-server";

/**
 * One pass of sending and fetching, against a server that behaves like ours.
 *
 * These are the scenarios the phone app is for: a day recorded in a basement
 * and sent from the van, a sign in that ends with work still on the phone, a
 * restart halfway, a tap during a pass. The engine is what the app's timer,
 * its taps and its background task all call, so this is the app's sync,
 * tested without the app.
 */

const PHOTO = Buffer.from("a photograph of a pitted contactor").toString("base64");

let storage: MemoryStorage;
let server: FakeServer;
let disk: Map<string, string>;
let clock: Date;
let ids: number;

const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const files: UploadFiles = {
  async read(uri) { const b = disk.get(uri); if (b === undefined) throw new Error("ENOENT"); return b; },
  async remove(uri) { disk.delete(uri); },
};

function phone(store = storage) {
  const queue = new FieldQueue({ storage: store, deviceId: "device-1", newId, now: () => clock, random: () => 1 });
  const uploads = new UploadQueue({ storage: store, queue, files, now: () => clock });
  const engine = new SyncEngine({
    queue, uploads, storage: store,
    transport: server.transport(),
    uploadTransport: server.uploads(),
    snapshot: (input) => server.snapshot(input),
    timezone: "America/Chicago",
    now: () => clock,
  });
  return { queue, uploads, engine };
}

beforeEach(() => {
  storage = new MemoryStorage();
  server = new FakeServer();
  server.addVisit("v1", { customer: { id: "c1", name: "Nina Patel", phone: null } });
  disk = new Map();
  clock = new Date("2026-10-02T15:00:00Z");
  ids = 0;
});

describe("a day in the basement", () => {
  it("shows the day from the phone with no signal, and sends it all from the van", async () => {
    const { queue, uploads, engine } = phone();
    await engine.run({ force: true });
    expect((await engine.view()).day.visits).toHaveLength(1);

    server.offline = true;
    await queue.enqueue({ kind: "timeclock.punch_in" });
    await queue.enqueue({ kind: "visit.en_route", subjectId: "v1" });
    await queue.enqueue({ kind: "visit.arrive", subjectId: "v1" });
    disk.set("file:///p1.jpg", PHOTO);
    await uploads.add({
      uploadId: newId(), visitId: "v1", kind: "photo", contentType: "image/jpeg", byteSize: 10,
      contentHash: sha256Base64(PHOTO), localUri: "file:///p1.jpg",
    });

    const offline = await engine.run({ force: true });
    expect(offline).toMatchObject({ offline: true, error: null, applied: 0 });

    let view = await engine.view();
    expect(view.waiting).toBe(4);
    expect(view.uploadsWaiting).toBe(1);
    expect(view.day.visits[0]!.stage).toBe("arrived");
    expect(view.day.clock.open).toBe(true);
    expect(view.problems).toEqual([]);

    server.offline = false;
    const back = await engine.run({ force: true });
    expect(back).toMatchObject({ applied: 4, uploadsSent: 1, offline: false, error: null });

    view = await engine.view();
    expect(view.waiting).toBe(0);
    expect(view.uploadsWaiting).toBe(0);
    expect(view.day.visits[0]!.stage).toBe("arrived");
    expect(view.day.clock.open).toBe(true);
    expect(server.stored.size).toBe(1);
  });

  it("does not let the timer hammer a server it cannot reach", async () => {
    const { queue, engine } = phone();
    await queue.enqueue({ kind: "visit.en_route", subjectId: "v1" });
    server.offline = true;

    await engine.run({ force: true });
    const before = server.calls.sync;
    const timer = await engine.run();
    expect(timer.ran).toBe(false);
    expect(server.calls.sync).toBe(before);

    // A person tapping always tries.
    await engine.run({ force: true });
    expect(server.calls.sync).toBe(before + 1);
  });
});

describe("the sign in ending", () => {
  it("says so, and keeps every piece of work on the phone", async () => {
    const { queue, engine } = phone();
    await queue.enqueue({ kind: "timeclock.punch_in" });
    server.signedOut = true;

    const report = await engine.run({ force: true });
    expect(report.signedOut).toBe(true);
    expect((await queue.pending())[0]!.attempts).toBe(0);

    server.signedOut = false;
    expect((await engine.run({ force: true })).applied).toBe(1);
  });
});

describe("the office changed something", () => {
  it("records the work, and tells the technician in plain words", async () => {
    const { queue, engine } = phone();
    await engine.run({ force: true });
    server.visits.get("v1")!.status = "cancelled";

    await queue.enqueue({ kind: "visit.arrive", subjectId: "v1" });
    await engine.run({ force: true });

    const view = await engine.view();
    expect(view.waiting).toBe(0);
    expect(view.problems).toHaveLength(1);
    expect(view.problems[0]!.detail).toMatch(/You arrived at Nina Patel's job is on the record, but the office had cancelled it/);

    await queue.dismiss(view.problems[0]!.id);
    expect((await engine.view()).problems).toHaveLength(0);
  });
});

describe("two things at once", () => {
  it("runs one pass at a time, and a tap during a pass gets its own pass after", async () => {
    const { queue, engine } = phone();
    await queue.enqueue({ kind: "visit.en_route", subjectId: "v1" });

    const first = engine.run({ force: true });
    await queue.enqueue({ kind: "visit.arrive", subjectId: "v1" });
    const second = engine.run({ force: true });
    expect(second).toBe(first);
    await first;

    // The pass queued by the tap runs after the first finishes.
    await new Promise((r) => setTimeout(r, 20));
    expect(await queue.pending()).toHaveLength(0);
    expect(server.visits.get("v1")!.arrivedAt).not.toBeNull();
  });
});

describe("restarting", () => {
  it("opens on the day it last saw", async () => {
    const { engine } = phone();
    await engine.run({ force: true });

    server.offline = true;
    const reopened = phone(MemoryStorage.from(storage.snapshot()));
    const view = await reopened.engine.view();
    expect(view.day.visits.map((v) => v.customer.name)).toEqual(["Nina Patel"]);
    expect(view.lastSyncedAt).toBe("2026-10-02T15:00:00.000Z");
  });

  it("does not step backwards when the signal drops between the send and the fetch", async () => {
    const { queue, engine } = phone();
    await engine.run({ force: true });
    await queue.enqueue({ kind: "visit.en_route", subjectId: "v1" });

    // The send lands and the fetch after it does not.
    const real = server.snapshot;
    server.snapshot = async () => { throw Object.assign(new Error("Network request failed"), { offline: true }); };
    await engine.run({ force: true });
    expect(await queue.pending()).toHaveLength(0);
    expect((await engine.view()).day.visits[0]!.stage).toBe("en_route");

    server.snapshot = real;
    await engine.run({ force: true });
    expect((await engine.view()).day.visits[0]!.stage).toBe("en_route");
  });

  it("fetches the whole day again after a punch, because the revision does not cover the clock", async () => {
    const { queue, engine } = phone();
    await engine.run({ force: true });
    await queue.enqueue({ kind: "timeclock.punch_in" });
    await engine.run({ force: true });
    expect((await engine.view()).day.clock.open).toBe(true);
  });
});
