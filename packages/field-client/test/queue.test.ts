import { describe, it, expect, beforeEach } from "vitest";
import { FieldQueue, MemoryStorage, type Transport, type SyncResponse } from "../src/index";

/**
 * The queue on a phone that keeps dying.
 *
 * Every test here is a thing that actually happens to a technician: the app is
 * killed, the battery goes, the connection drops halfway through a response,
 * the phone is reinstalled. None of them need a device to reproduce, and all
 * of them are miserable to reproduce on one, which is why this logic is a
 * package rather than a screen.
 */

let storage: MemoryStorage;
let ids: number;

const newId = () => `client-${String(++ids).padStart(4, "0")}`;
const at = (iso: string) => new Date(iso);

const makeQueue = (over: Partial<ConstructorParameters<typeof FieldQueue>[0]> = {}) =>
  new FieldQueue({
    storage,
    deviceId: "device-1",
    newId,
    now: () => at("2026-04-02T09:00:00Z"),
    ...over,
  });

/** A transport that applies everything, so the happy path is the default. */
const applyAll = (): Transport => ({
  async send(input) {
    return {
      results: input.operations.map((o) => ({
        clientId: o.clientId,
        status: "applied" as const,
        conflict: null,
        rejection: null,
        occurredAt: o.occurredAt,
        clamped: null,
      })),
      awaiting: [],
      snapshotRevision: 7,
    };
  },
});

const respondWith = (results: SyncResponse["results"], awaiting: number[] = []): Transport => ({
  async send() {
    return { results, awaiting, snapshotRevision: 1 };
  },
});

const alwaysFails = (message = "Network request failed"): Transport => ({
  async send() {
    throw new Error(message);
  },
});

beforeEach(() => {
  storage = new MemoryStorage();
  ids = 0;
});

describe("recording work", () => {
  it("numbers operations from one", async () => {
    const q = makeQueue();
    const a = await q.enqueue({ kind: "timeclock.punch_in" });
    const b = await q.enqueue({ kind: "visit.arrive", subjectId: "v1" });

    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
  });

  it("gives every operation its own client id", async () => {
    const q = makeQueue();
    const a = await q.enqueue({ kind: "visit.note", payload: { text: "one" } });
    const b = await q.enqueue({ kind: "visit.note", payload: { text: "two" } });
    expect(a.clientId).not.toBe(b.clientId);
  });

  it("stamps the device's clock when none is given", async () => {
    const q = makeQueue();
    const op = await q.enqueue({ kind: "visit.arrive", subjectId: "v1" });
    expect(op.occurredAt).toBe("2026-04-02T09:00:00.000Z");
  });

  it("keeps an occurrence the caller supplies", async () => {
    // A punch recorded from a screen the technician opened ten minutes later
    // still happened ten minutes ago.
    const q = makeQueue();
    const op = await q.enqueue({
      kind: "timeclock.punch_in",
      occurredAt: at("2026-04-02T07:02:00Z"),
    });
    expect(op.occurredAt).toBe("2026-04-02T07:02:00.000Z");
  });

  it("returns them oldest first", async () => {
    const q = makeQueue();
    for (let i = 0; i < 5; i++) await q.enqueue({ kind: "visit.note", payload: { i } });
    const pending = await q.pending();
    expect(pending.map((o) => o.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps them in order past ten, where a string sort would not", async () => {
    // The storage keys are zero padded for exactly this. A backend that sorts
    // lexically would otherwise put 10 before 2.
    const q = makeQueue();
    for (let i = 0; i < 12; i++) await q.enqueue({ kind: "visit.note", payload: { i } });
    const pending = await q.pending();
    expect(pending.map((o) => o.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe("the app being killed", () => {
  it("still has the work after a restart", async () => {
    const q = makeQueue();
    await q.enqueue({ kind: "timeclock.punch_in" });
    await q.enqueue({ kind: "visit.arrive", subjectId: "v1" });

    // The OS kills the app. Everything in memory is gone; storage is not.
    const restarted = new FieldQueue({
      storage: MemoryStorage.from(storage.snapshot()),
      deviceId: "device-1",
    });

    expect((await restarted.pending()).map((o) => o.kind))
      .toEqual(["timeclock.punch_in", "visit.arrive"]);
  });

  it("does not hand out a sequence number twice across a restart", async () => {
    const q = makeQueue();
    await q.enqueue({ kind: "visit.note" });
    await q.enqueue({ kind: "visit.note" });

    const after = MemoryStorage.from(storage.snapshot());
    const restarted = new FieldQueue({ storage: after, deviceId: "device-1", newId });
    const next = await restarted.enqueue({ kind: "visit.note" });

    // A repeat is worse than a gap: the server treats it as a replay and
    // discards it with no error anywhere.
    expect(next.sequence).toBe(3);
  });

  it("does not reset the counter when the queue empties", async () => {
    /**
     * The failure this prevents: a technician finishes a day, everything
     * syncs, the queue is empty, and tomorrow's first punch reuses sequence
     * one. The server sees a replay of yesterday and drops it.
     */
    const q = makeQueue();
    await q.enqueue({ kind: "timeclock.punch_in" });
    await q.enqueue({ kind: "timeclock.punch_out" });
    await q.flush(applyAll());

    expect(await q.pending()).toHaveLength(0);

    const tomorrow = await q.enqueue({ kind: "timeclock.punch_in" });
    expect(tomorrow.sequence).toBe(3);
  });

  it("burns a sequence rather than reusing one when the operation write fails", async () => {
    /**
     * The counter is advanced and persisted BEFORE the operation is written,
     * so a crash between the two leaves a hole. That is the correct direction
     * to fail in: the server holds for a gap and resolves it on the next sync,
     * where a duplicate is silently discarded with no error anywhere.
     */
    const q = makeQueue();
    await q.enqueue({ kind: "visit.note" });

    storage.failWriteWhen = (key) => key.startsWith("otos.op.");
    await expect(q.enqueue({ kind: "visit.note" })).rejects.toThrow();

    const recovered = await q.enqueue({ kind: "visit.note" });
    expect(recovered.sequence).toBe(3);
    expect((await q.pending()).map((o) => o.sequence)).toEqual([1, 3]);
  });

  it("changes nothing when the counter write itself fails", async () => {
    // The harmless half of the same crash. Nothing was promised to the caller
    // and nothing was written, so the next operation takes the number the
    // failed one would have had.
    const q = makeQueue();
    await q.enqueue({ kind: "visit.note" });

    storage.failWriteWhen = (key) => key === "otos.sequence";
    await expect(q.enqueue({ kind: "visit.note" })).rejects.toThrow();

    const recovered = await q.enqueue({ kind: "visit.note" });
    expect(recovered.sequence).toBe(2);
    expect((await q.pending()).map((o) => o.sequence)).toEqual([1, 2]);
  });

  it("skips a record that was half written and keeps the rest", async () => {
    const q = makeQueue();
    await q.enqueue({ kind: "visit.note", payload: { text: "first" } });
    await q.enqueue({ kind: "visit.note", payload: { text: "second" } });

    const corrupted = storage.snapshot();
    const key = [...corrupted.keys()].find((k) => k.endsWith("000000000001"))!;
    corrupted.set(key, '{"clientId":"client-0001","seque');

    const restarted = new FieldQueue({
      storage: MemoryStorage.from(corrupted),
      deviceId: "device-1",
    });

    const pending = await restarted.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sequence).toBe(2);
  });
});

describe("sending", () => {
  it("removes what the server applied", async () => {
    const q = makeQueue();
    await q.enqueue({ kind: "timeclock.punch_in" });
    await q.enqueue({ kind: "visit.arrive", subjectId: "v1" });

    const result = await q.flush(applyAll());

    expect(result.applied).toBe(2);
    expect(result.snapshotRevision).toBe(7);
    expect(await q.pending()).toHaveLength(0);
  });

  it("does nothing, quietly, when there is nothing to send", async () => {
    const q = makeQueue();
    const result = await q.flush(applyAll());
    expect(result.sent).toBe(0);
    expect(result.error).toBeNull();
  });

  it("keeps everything when the connection drops", async () => {
    const q = makeQueue();
    await q.enqueue({ kind: "timeclock.punch_in" });
    await q.enqueue({ kind: "visit.arrive", subjectId: "v1" });

    const result = await q.flush(alwaysFails());

    expect(result.error).toMatch(/Network/);
    expect(result.applied).toBe(0);
    expect(await q.pending()).toHaveLength(2);
  });

  it("reuses the same client ids on a resend", async () => {
    /**
     * The property that makes retrying safe. A queue that regenerates the
     * client id turns one tap into as many rows as there were attempts, and
     * the technician sees four punches.
     */
    const q = makeQueue();
    await q.enqueue({ kind: "timeclock.punch_in" });

    await q.flush(alwaysFails());
    const first = (await q.pending())[0]!.clientId;

    await q.flush(alwaysFails());
    const second = (await q.pending())[0]!.clientId;

    expect(second).toBe(first);
  });

  it("sends in batches rather than a whole day at once", async () => {
    const q = makeQueue({ batchSize: 3 });
    for (let i = 0; i < 10; i++) await q.enqueue({ kind: "visit.note", payload: { i } });

    let batch = 0;
    const counting: Transport = {
      async send(input) {
        batch = input.operations.length;
        return {
          results: input.operations.map((o) => ({
            clientId: o.clientId, status: "applied" as const,
            conflict: null, rejection: null, occurredAt: o.occurredAt, clamped: null,
          })),
          awaiting: [], snapshotRevision: 1,
        };
      },
    };

    await q.flush(counting);
    expect(batch).toBe(3);
    expect(await q.pending()).toHaveLength(7);
  });

  it("sends the oldest first", async () => {
    const q = makeQueue({ batchSize: 2 });
    for (let i = 0; i < 5; i++) await q.enqueue({ kind: "visit.note", payload: { i } });

    let sent: number[] = [];
    const capture: Transport = {
      async send(input) {
        sent = input.operations.map((o) => o.sequence);
        return { results: [], awaiting: [], snapshotRevision: 1 };
      },
    };

    await q.flush(capture);
    expect(sent).toEqual([1, 2]);
  });
});

describe("what the server says", () => {
  it("holds an operation the server is waiting on", async () => {
    const q = makeQueue();
    const op = await q.enqueue({ kind: "visit.arrive", subjectId: "v1" });

    await q.flush(respondWith([{
      clientId: op.clientId, status: "held",
      conflict: null, rejection: null, occurredAt: op.occurredAt, clamped: null,
    }], [1]));

    const pending = await q.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("held");
  });

  it("keeps a conflict on the phone, with what the server said", async () => {
    const q = makeQueue();
    const op = await q.enqueue({ kind: "visit.complete", subjectId: "v1" });

    await q.flush(respondWith([{
      clientId: op.clientId, status: "conflicted",
      conflict: "Recorded, but the visit was cancelled by the time it reached us.",
      rejection: null, occurredAt: op.occurredAt, clamped: null,
    }]));

    const problems = await q.problems();
    expect(problems).toHaveLength(1);
    expect(problems[0]!.conflict).toMatch(/cancelled/);
  });

  it("keeps a rejection visible rather than dropping it", async () => {
    // A queue that quietly discards its own failures loses a day's work and
    // reports success.
    const q = makeQueue();
    const op = await q.enqueue({ kind: "service_report.submit", subjectId: "r1" });

    await q.flush(respondWith([{
      clientId: op.clientId, status: "rejected",
      conflict: null, rejection: "Cannot submit from submitted",
      occurredAt: op.occurredAt, clamped: null,
    }]));

    const problems = await q.problems();
    expect(problems[0]!.status).toBe("rejected");
    expect(problems[0]!.lastError).toMatch(/submitted/);
  });

  it("does not keep retrying something the server rejected", async () => {
    const q = makeQueue();
    const op = await q.enqueue({ kind: "service_report.submit", subjectId: "r1" });
    await q.flush(respondWith([{
      clientId: op.clientId, status: "rejected",
      conflict: null, rejection: "no", occurredAt: op.occurredAt, clamped: null,
    }]));

    let calls = 0;
    const counting: Transport = {
      async send() { calls += 1; return { results: [], awaiting: [], snapshotRevision: 1 }; },
    };
    await q.flush(counting);
    expect(calls).toBe(0);
  });

  it("removes a superseded operation, because a later one replaced it", async () => {
    const q = makeQueue();
    const op = await q.enqueue({ kind: "service_report.set_field", subjectId: "r1" });

    await q.flush(respondWith([{
      clientId: op.clientId, status: "superseded",
      conflict: null, rejection: null, occurredAt: op.occurredAt, clamped: null,
    }]));

    expect(await q.pending()).toHaveLength(0);
  });

  it("keeps an operation the response never mentioned", async () => {
    /**
     * A response truncated by a dropped connection looks exactly like a server
     * that ignored an operation. Leaving it queued is safe because the client
     * id makes the resend a replay, and dropping it is not.
     */
    const q = makeQueue();
    await q.enqueue({ kind: "visit.arrive", subjectId: "v1" });

    await q.flush(respondWith([]));

    const pending = await q.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.lastError).toMatch(/no result/);
  });

  it("stops retrying after enough failures and surfaces it", async () => {
    const q = makeQueue({ maxAttempts: 3 });
    await q.enqueue({ kind: "visit.arrive", subjectId: "v1" });

    for (let i = 0; i < 3; i++) await q.flush(alwaysFails());

    // Something is wrong that retrying will not fix, and a queue that retries
    // forever hides it.
    expect(await q.problems()).toHaveLength(1);

    let calls = 0;
    await q.flush({ async send() { calls += 1; return { results: [], awaiting: [], snapshotRevision: 1 }; } });
    expect(calls).toBe(0);
  });
});

describe("the technician deciding", () => {
  it("retries something that had given up", async () => {
    const q = makeQueue({ maxAttempts: 2 });
    const op = await q.enqueue({ kind: "visit.arrive", subjectId: "v1" });
    for (let i = 0; i < 2; i++) await q.flush(alwaysFails());
    expect(await q.problems()).toHaveLength(1);

    await q.retry(op.clientId);

    expect(await q.problems()).toHaveLength(0);
    const result = await q.flush(applyAll());
    expect(result.applied).toBe(1);
  });

  it("discards one, and only when asked", async () => {
    const q = makeQueue();
    const op = await q.enqueue({ kind: "visit.note", payload: { text: "wrong job" } });

    expect(await q.dismiss("not-a-real-id")).toBe(false);
    expect(await q.pending()).toHaveLength(1);

    expect(await q.dismiss(op.clientId)).toBe(true);
    expect(await q.pending()).toHaveLength(0);
  });
});

describe("a reinstall", () => {
  it("picks up the sequence the server has, not one", async () => {
    /**
     * The phone has no counter and the server does. Starting again at one
     * makes every operation a replay of a different one from the last install,
     * and the server discards them all without an error.
     */
    const q = makeQueue();
    await q.adoptSequence(47);

    const op = await q.enqueue({ kind: "timeclock.punch_in" });
    expect(op.sequence).toBe(48);
  });

  it("never moves the counter backwards", async () => {
    const q = makeQueue();
    await q.enqueue({ kind: "visit.note" });
    await q.enqueue({ kind: "visit.note" });

    // The server is behind because it has not seen these yet.
    await q.adoptSequence(1);

    const next = await q.enqueue({ kind: "visit.note" });
    expect(next.sequence).toBe(3);
  });
});

describe("a full offline day", () => {
  it("survives being killed twice and a connection that comes back", async () => {
    let snapshot = new Map<string, string>();

    // Morning. Punch in, drive, arrive. Then the OS kills the app.
    {
      const q = new FieldQueue({ storage, deviceId: "device-1", newId });
      await q.enqueue({ kind: "timeclock.punch_in", occurredAt: at("2026-04-02T07:02:00Z") });
      await q.enqueue({ kind: "visit.en_route", subjectId: "v1", occurredAt: at("2026-04-02T07:40:00Z") });
      await q.enqueue({ kind: "visit.arrive", subjectId: "v1", occurredAt: at("2026-04-02T08:05:00Z") });
      snapshot = storage.snapshot();
    }

    // The technician reopens it in the crawl space. Still no signal.
    {
      const s = MemoryStorage.from(snapshot);
      const q = new FieldQueue({ storage: s, deviceId: "device-1", newId });
      expect(await q.pending()).toHaveLength(3);

      await q.enqueue({ kind: "visit.note", subjectId: "v1", payload: { text: "Contactor pitted" } });
      const failed = await q.flush(alwaysFails());
      expect(failed.error).not.toBeNull();

      await q.enqueue({ kind: "visit.complete", subjectId: "v1", occurredAt: at("2026-04-02T09:36:00Z") });
      snapshot = s.snapshot();
    }

    // Battery dies. Charged in the van, and now there is signal.
    {
      const s = MemoryStorage.from(snapshot);
      const q = new FieldQueue({ storage: s, deviceId: "device-1", newId });
      await q.enqueue({ kind: "timeclock.punch_out", occurredAt: at("2026-04-02T16:20:00Z") });

      const pending = await q.pending();
      expect(pending.map((o) => o.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(pending.map((o) => o.clientId)).size).toBe(6);

      const result = await q.flush(applyAll());
      expect(result.applied).toBe(6);
      expect(await q.pending()).toHaveLength(0);
    }
  });

  it("sends a day in order even when it is submitted in several batches", async () => {
    const q = makeQueue({ batchSize: 2 });
    for (let i = 0; i < 6; i++) {
      await q.enqueue({ kind: "visit.note", payload: { i } });
    }

    const seen: number[] = [];
    const ordered: Transport = {
      async send(input) {
        seen.push(...input.operations.map((o) => o.sequence));
        return {
          results: input.operations.map((o) => ({
            clientId: o.clientId, status: "applied" as const,
            conflict: null, rejection: null, occurredAt: o.occurredAt, clamped: null,
          })),
          awaiting: [], snapshotRevision: 1,
        };
      },
    };

    while ((await q.pending()).length > 0) await q.flush(ordered);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
