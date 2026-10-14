import { describe, it, expect, beforeEach } from "vitest";
import { FieldQueue, MemoryStorage, SyncEngine, UploadQueue, describeOperation, projectDay, type QueuedOperation } from "../src/index";
import { FakeServer } from "./fake-server";

/**
 * A NOTICE OPENED ON THE PHONE, MARKED READ FOR THE BELL
 *
 * Tapping a notice opens what it is about from what the phone already holds,
 * often where there is no signal, so the mark that it was read is a queue
 * operation like any other thing the person did: kept on the phone, sent when
 * the van finds a signal, once however many times it is retried. It changes
 * nothing on the day, because the bell is the office's.
 */
const NOTICE = "6f1c2b9e-0a4d-4f39-9c7e-2b8a1d3e5f60";

let storage: MemoryStorage;
let server: FakeServer;
let ids: number;
const clock = new Date("2026-10-02T15:00:00Z");
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

function phone() {
  const queue = new FieldQueue({ storage, deviceId: "device-1", newId, now: () => clock, random: () => 1 });
  const uploads = new UploadQueue({ storage, queue, files: { read: async () => "", remove: async () => undefined }, now: () => clock });
  const engine = new SyncEngine({
    queue, uploads, storage,
    transport: server.transport(), uploadTransport: server.uploads(),
    snapshot: (input) => server.snapshot(input), timezone: "America/Chicago", now: () => clock,
  });
  return { queue, engine };
}

beforeEach(() => {
  storage = new MemoryStorage();
  server = new FakeServer();
  server.addVisit("v1");
  ids = 0;
});

describe("opening a notice with no signal", () => {
  it("is kept on the phone, changes nothing on the day, and goes when there is a signal", async () => {
    const { queue, engine } = phone();
    await engine.run({ force: true });
    server.offline = true;
    await queue.enqueue({ kind: "notice.read", subjectId: NOTICE });

    await engine.run({ force: true });
    let view = await engine.view();
    expect(view.waiting).toBe(1);
    expect(view.problems).toEqual([]);
    expect(view.day.visits[0]!.waiting).toBe(0);

    server.offline = false;
    expect(await engine.run({ force: true })).toMatchObject({ applied: 1, offline: false, error: null });
    view = await engine.view();
    expect(view.waiting).toBe(0);
    expect(server.applied.size).toBe(1);
  });

  it("survives the phone being restarted before the signal comes back", async () => {
    server.offline = true;
    await phone().queue.enqueue({ kind: "notice.read", subjectId: NOTICE });
    const after = phone();
    expect((await after.queue.pending()).map((o) => [o.kind, o.subjectId])).toEqual([["notice.read", NOTICE]]);
  });
});

describe("the words for it", () => {
  const op = (over: Partial<QueuedOperation>): QueuedOperation => ({
    clientId: "op-1", sequence: 1, kind: "notice.read", subjectId: NOTICE, occurredAt: "2026-10-02T15:00:00Z",
    payload: {}, status: "pending", attempts: 0, ...over,
  });

  it("names it as a notice, not as a job, when the server refused it", () => {
    const problem = describeOperation(op({ status: "rejected", lastError: "Your account may not do that. Ask the office." }), () => "Nina Patel");
    expect(problem!.detail).toBe("Marking a notice as read was not accepted. Your account may not do that. Ask the office.");
    expect(problem!.visitId).toBeUndefined();
  });

  it("leaves the day as the server drew it", () => {
    const day = projectDay({ snapshot: null, operations: [op({})] });
    expect(day.visits).toEqual([]);
    expect(day.tasks).toEqual([]);
  });
});
