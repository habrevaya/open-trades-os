import { describe, it, expect } from "vitest";
import {
  MemoryStorage, OfflineError, PositionBuffer, projectDay, sharingFor,
  type FieldSnapshot, type PositionFix, type QueuedOperation, type SyncResponse, type Transport,
} from "../src/index";
import { FakeServer } from "./fake-server";

/**
 * WHERE THE PHONE WAS, WITHOUT A PHONE
 *
 * When the phone should be taking fixes, decided from the day it holds, and
 * what happens to the fixes between being taken and reaching the server:
 * thinned while the van is parked, kept through no signal, capped, sent with
 * the sync, and thrown away when sharing stops.
 */

const sharingOn = { companyEnabled: true, personEnabled: true, intervalSeconds: 60, retentionDays: 3 };

function snapshot(over: Partial<FieldSnapshot> = {}): FieldSnapshot {
  const server = new FakeServer();
  server.addVisit("v1", { customer: { id: "c1", name: "Nina Patel", phone: null } });
  return { revision: 1, unchanged: false, openTimeEntry: null, priceBook: [], visits: [...server.visits.values()], ...over };
}

let seq = 0;
const op = (over: Partial<QueuedOperation>): QueuedOperation => ({
  clientId: `op-${++seq}`, sequence: seq, kind: "visit.note", occurredAt: "2026-10-02T15:00:00.000Z",
  payload: {}, status: "pending", attempts: 0, ...over,
});

describe("whether the phone shares", () => {
  it("shares nothing off the clock and off a visit, even with sharing on", () => {
    const day = projectDay({ snapshot: snapshot(), operations: [] });
    expect(sharingFor(day, sharingOn).state).toEqual({ sharing: false, reason: "off_the_clock" });
  });

  it("shares while on the way, naming who can see them, the moment the tap is queued", () => {
    const day = projectDay({ snapshot: snapshot(), operations: [op({ kind: "visit.en_route", subjectId: "v1" })] });
    const sharing = sharingFor(day, sharingOn);
    expect(sharing.state).toEqual({ sharing: true, reason: "on_the_way", visitId: "v1" });
    expect(sharing.sentence).toContain("Nina Patel can see you");
  });

  it("shares on the clock, and nothing at all when the server has not said sharing is on", () => {
    const clocked = projectDay({
      snapshot: snapshot({ openTimeEntry: { id: "t1", kind: "on_site", startedAt: "2026-10-02T13:00:00Z" } }),
      operations: [],
    });
    expect(sharingFor(clocked, sharingOn).state).toMatchObject({ sharing: true, reason: "on_the_clock" });
    expect(sharingFor(clocked, undefined).state).toEqual({ sharing: false, reason: "company_off" });
    expect(sharingFor(clocked, { ...sharingOn, personEnabled: false }).state).toEqual({ sharing: false, reason: "person_off" });
  });
});

function fakeTransport() {
  const sent: PositionFix[][] = [];
  let offline = false;
  const transport: Transport = {
    send: async (input) => {
      if (offline) throw new OfflineError("Network request failed");
      sent.push(input.positions ?? []);
      expect(input.operations).toEqual([]);
      return { results: [], awaiting: [], snapshotRevision: 1, positions: { stored: input.positions?.length ?? 0, dropped: {} } } satisfies SyncResponse;
    },
  };
  return { transport, sent, setOffline: (v: boolean) => { offline = v; } };
}

const at = (minute: number, lat = 30.27) => ({
  latitude: lat, longitude: -97.74, accuracyMeters: 10,
  recordedAt: new Date(Date.UTC(2026, 9, 2, 15, minute)).toISOString(),
});

describe("the fixes waiting to send", () => {
  it("keeps one every few minutes from a parked van, and every one from a moving one", async () => {
    const buffer = new PositionBuffer({ storage: new MemoryStorage(), deviceId: "d1" });
    expect(await buffer.record(at(0))).toBe(true);
    expect(await buffer.record(at(1))).toBe(false);
    expect(await buffer.record(at(2, 30.28))).toBe(true);
    expect(await buffer.record(at(6, 30.28))).toBe(true);
    expect((await buffer.pending()).map((f) => f.recordedAt.slice(11, 16))).toEqual(["15:00", "15:02", "15:06"]);
  });

  it("keeps the newest when a day without signal fills it", async () => {
    const buffer = new PositionBuffer({ storage: new MemoryStorage(), deviceId: "d1", maxFixes: 2, minSeconds: 0 });
    for (const minute of [0, 1, 2, 3]) await buffer.record(at(minute));
    expect((await buffer.pending()).map((f) => f.recordedAt.slice(14, 16))).toEqual(["02", "03"]);
  });

  it("sends with the sync and forgets what was sent; keeps everything with no signal", async () => {
    const buffer = new PositionBuffer({ storage: new MemoryStorage(), deviceId: "d1", minSeconds: 0, batchSize: 2 });
    for (const minute of [0, 1, 2]) await buffer.record(at(minute));
    const server = fakeTransport();

    server.setOffline(true);
    expect(await buffer.flush(server.transport)).toMatchObject({ sent: 0, offline: true });
    expect(await buffer.pending()).toHaveLength(3);

    server.setOffline(false);
    expect(await buffer.flush(server.transport)).toMatchObject({ sent: 3, stored: 3, offline: false });
    expect(server.sent.map((b) => b.length)).toEqual([2, 1]);
    expect(await buffer.pending()).toEqual([]);
  });

  it("throws away what has not gone when sharing stops", async () => {
    const buffer = new PositionBuffer({ storage: new MemoryStorage(), deviceId: "d1" });
    await buffer.record(at(0));
    await buffer.clear();
    expect(await buffer.pending()).toEqual([]);
  });

  it("keeps two fixes taken in the same instant from overwriting each other", async () => {
    const buffer = new PositionBuffer({ storage: new MemoryStorage(), deviceId: "d1", minSeconds: 0 });
    await Promise.all([buffer.record(at(0)), buffer.record(at(1)), buffer.record(at(2))]);
    expect(await buffer.pending()).toHaveLength(3);
  });
});
