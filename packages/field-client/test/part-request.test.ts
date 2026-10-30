import { describe, it, expect } from "vitest";
import { field } from "@opentradesos/core";
import {
  FieldQueue, MemoryStorage, checkPartRequest, describeOperation, projectDay, recordPartRequest, visitOf,
  type FieldSnapshot,
} from "../src/index";
import { FakeServer } from "./fake-server";

/**
 * ASKING THE OFFICE FOR A PART FROM THE PHONE
 *
 * The part in words, checked as the server checks it, queued with an id made
 * on the phone, shown on the visit as asked and waiting until it is sent, and
 * never a hold: the hold is the office's, against the order.
 */
const now = new Date("2026-10-02T20:00:00Z");
const REQUEST = "5b0d7c1e-9a64-4c1f-8e2a-3f4b6c7d8e90";

describe("checking what was typed", () => {
  it("takes the part and an optional note, trimmed", () => {
    expect(checkPartRequest("  Condenser fan motor, 1/4 hp ", "")).toEqual({ ok: true, part: "Condenser fan motor, 1/4 hp", note: null });
    expect(checkPartRequest("Capacitor 45/5", " Model on the plate is 24ACC6 ")).toEqual({
      ok: true, part: "Capacitor 45/5", note: "Model on the plate is 24ACC6",
    });
  });

  it("asks for the part, and keeps it short enough for the queue's task title", () => {
    expect(checkPartRequest("   ", "anything")).toMatchObject({ ok: false, problem: "Say what part you need, in a few words." });
    expect(checkPartRequest("x".repeat(301), "")).toMatchObject({ ok: false, problem: expect.stringContaining("300 characters") });
    expect(checkPartRequest("Motor", "y".repeat(1001))).toMatchObject({ ok: false });
  });
});

describe("asking with no signal", () => {
  it("queues an append the server never refuses for the office having moved on, and shows it on the visit", async () => {
    expect(field.CONFLICT_RULES["part.request"]).toBe("append");
    const queue = new FieldQueue({ storage: new MemoryStorage(), deviceId: "d1", now: () => now, random: () => 1 });
    const server = new FakeServer();
    server.addVisit("v1", { status: "working", windowStart: "2026-10-02T15:00:00Z" });
    const snapshot: FieldSnapshot = { revision: 1, unchanged: false, openTimeEntry: null, priceBook: [], visits: [...server.visits.values()] };

    const queued = await recordPartRequest(queue, { visitId: "v1", requestId: REQUEST, part: "Condenser fan motor", note: null });
    expect(queued).toMatchObject({ kind: "part.request", subjectId: REQUEST, payload: { visitId: "v1", part: "Condenser fan motor" } });
    expect(queued.payload).not.toHaveProperty("note");
    expect(visitOf(queued)).toBe("v1");

    const day = projectDay({ snapshot, operations: await queue.pending() });
    expect(day.visits[0]!.partsAsked).toEqual([
      { id: REQUEST, part: "Condenser fan motor", note: null, requestedAt: now.toISOString(), held: false, waiting: true },
    ]);
    /** Asking for a part does not move the visit. */
    expect(day.visits[0]!.status).toBe("working");
  });

  it("shows the server's copy once the day carries it, with whether the office has held the job for it", async () => {
    const queue = new FieldQueue({ storage: new MemoryStorage(), deviceId: "d1", now: () => now, random: () => 1 });
    const server = new FakeServer();
    server.addVisit("v1", { status: "working" });
    const visit = { ...server.visits.get("v1")!, partsAsked: [
      { id: REQUEST, part: "Condenser fan motor", note: null, requestedAt: now.toISOString(), held: true },
    ] };
    const snapshot: FieldSnapshot = { revision: 2, unchanged: false, openTimeEntry: null, priceBook: [], visits: [visit] };
    const op = await recordPartRequest(queue, { visitId: "v1", requestId: REQUEST, part: "Condenser fan motor", note: null });
    const day = projectDay({ snapshot, operations: [], applied: [op] });
    expect(day.visits[0]!.partsAsked).toEqual([
      { id: REQUEST, part: "Condenser fan motor", note: null, requestedAt: now.toISOString(), held: true, waiting: false },
    ]);
  });

  it("says a refusal about the job, in the server's words", () => {
    const refused = describeOperation({
      clientId: "c1", sequence: 1, kind: "part.request", subjectId: REQUEST, occurredAt: now.toISOString(),
      payload: { visitId: "v1", part: "Motor" }, status: "rejected", attempts: 1,
      lastError: "That job was cancelled, so no part is needed for it. Ring the office if it is.",
    }, () => "Nina Patel");
    expect(refused!.detail).toBe(
      "The part you asked the office for on Nina Patel's job was not accepted. That job was cancelled, so no part is needed for it. Ring the office if it is.",
    );
  });
});
