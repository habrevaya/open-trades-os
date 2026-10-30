import { describe, it, expect } from "vitest";
import { field, work } from "@opentradesos/core";
import {
  CALL_OFF_CHOICES, FieldQueue, MemoryStorage, callOffLabel, canCallOff, checkCallOff, describeOperation, projectDay,
  recordCallOff, type FieldSnapshot,
} from "../src/index";
import { FakeServer } from "./fake-server";

/**
 * CALLING A VISIT OFF FROM THE DOOR
 *
 * What the phone offers and what it sends, without a phone: only today's
 * visits nobody has started, who asked chosen and never assumed, the
 * company's reasons exactly the office's, and the visit off the day the
 * moment it is pressed, with no signal.
 */
const zone = "America/Chicago";
/** Mid afternoon in Texas on October 2nd. */
const now = new Date("2026-10-02T20:00:00Z");

describe("which visits the phone offers to call off", () => {
  it("offers today's visits nobody has started, on the way and at the door included", () => {
    const today = "2026-10-02T15:00:00Z";
    expect(canCallOff({ stage: "upcoming", windowStart: today }, zone, now)).toBe(true);
    expect(canCallOff({ stage: "en_route", windowStart: today }, zone, now)).toBe(true);
    expect(canCallOff({ stage: "arrived", windowStart: today }, zone, now)).toBe(true);
  });

  it("does not offer one being worked, done or closed, one on another day, or one with no time", () => {
    const today = "2026-10-02T15:00:00Z";
    expect(canCallOff({ stage: "working", windowStart: today }, zone, now)).toBe(false);
    expect(canCallOff({ stage: "completed", windowStart: today }, zone, now)).toBe(false);
    expect(canCallOff({ stage: "closed", windowStart: today }, zone, now)).toBe(false);
    expect(canCallOff({ stage: "upcoming", windowStart: "2026-10-03T15:00:00Z" }, zone, now)).toBe(false);
    expect(canCallOff({ stage: "upcoming", windowStart: null }, zone, now)).toBe(false);
  });

  it("reads today as the company's day, not the phone's or the world's", () => {
    /** Eleven at night in Texas is already tomorrow in UTC: the visit at nine that morning is still today's. */
    const late = new Date("2026-10-03T04:00:00Z");
    expect(canCallOff({ stage: "upcoming", windowStart: "2026-10-02T14:00:00Z" }, zone, late)).toBe(true);
  });
});

describe("who called it off, and why", () => {
  it("offers the company's reasons exactly as the office does, and the customer turning the team away", () => {
    const company = CALL_OFF_CHOICES.filter((c) => c.by === "company").map((c) => ({ value: c.value, label: c.label }));
    expect(company).toEqual(work.CANCEL_REASONS);
    expect(CALL_OFF_CHOICES.filter((c) => c.by === "customer").map((c) => c.value)).toEqual(["turned_away"]);
    expect(callOffLabel("turned_away")).toBe("The customer turned us away");
    expect(callOffLabel("weather")).toBe("We called it off: rain or weather");
  });

  it("asks who, and never assumes it", () => {
    expect(checkCallOff("", "")).toMatchObject({ ok: false, problem: expect.stringContaining("Say who called it off") });
    expect(checkCallOff(null, "rain")).toMatchObject({ ok: false });
  });

  it("sends the customer's with no reason, keeping what they said as words", () => {
    expect(checkCallOff("turned_away", "")).toEqual({ ok: true, payload: { by: "customer" } });
    expect(checkCallOff("turned_away", "  Said they fixed it themselves ")).toEqual({
      ok: true, payload: { by: "customer", note: "Said they fixed it themselves" },
    });
  });

  it("sends the company's with its reason code, and asks for words for something else", () => {
    expect(checkCallOff("weather", "")).toEqual({ ok: true, payload: { by: "company", reason: { code: "weather" } } });
    expect(checkCallOff("crew_short", "Two out sick")).toEqual({
      ok: true, payload: { by: "company", reason: { code: "crew_short", note: "Two out sick" } },
    });
    expect(checkCallOff("other", " ")).toMatchObject({ ok: false, problem: "Say what the reason was, in a few words." });
    /** The same refusal the server gives, word for word. */
    expect(work.cancelReasonProblem("company", { code: "other", note: "" })).toBe("Say what the reason was, in a few words.");
  });
});

describe("calling it off with no signal", () => {
  it("queues a call off that takes the visit off the day straight away, as the server will", async () => {
    const queue = new FieldQueue({ storage: new MemoryStorage(), deviceId: "d1", now: () => now, random: () => 1 });
    const server = new FakeServer();
    server.addVisit("v1", { status: "en_route", windowStart: "2026-10-02T15:00:00Z" });
    const snapshot: FieldSnapshot = { revision: 1, unchanged: false, openTimeEntry: null, priceBook: [], visits: [...server.visits.values()] };

    const checked = checkCallOff("turned_away", "Not home after all");
    if (!checked.ok) throw new Error(checked.problem);
    const queued = await recordCallOff(queue, { visitId: "v1", payload: checked.payload });
    expect(queued).toMatchObject({ kind: "visit.call_off", subjectId: "v1", payload: { by: "customer", note: "Not home after all" } });
    expect(queued.occurredAt).toBe(now.toISOString());

    const day = projectDay({ snapshot, operations: await queue.pending() });
    expect(day.visits[0]).toMatchObject({ status: "cancelled", stage: "closed", waiting: 1 });
    /** The same state the server moves it to, from every state, so the two cannot drift. */
    for (const state of field.VISIT_STATES) {
      expect(field.stateAfter("visit.call_off", state === "cancelled" ? state : undefined) ?? null)
        .toBe(state === "cancelled" ? null : "cancelled");
    }
  });

  it("says a refusal in words about the visit, not the state machine's", () => {
    const refused = describeOperation({
      clientId: "c1", sequence: 1, kind: "visit.call_off", subjectId: "v1", occurredAt: now.toISOString(),
      payload: { by: "customer" }, status: "rejected", attempts: 1, lastError: "Cannot visit.call_off from cancelled",
    }, () => "Nina Patel");
    expect(refused).toMatchObject({ title: "Not recorded", action: "retry_or_discard" });
    expect(refused!.detail).toBe("Calling off your visit to Nina Patel's job was not accepted. The office had cancelled it.");

    const elsewhere = describeOperation({
      clientId: "c2", sequence: 2, kind: "visit.call_off", subjectId: "v1", occurredAt: now.toISOString(),
      payload: { by: "customer" }, status: "rejected", attempts: 1,
      lastError: "That visit is not on your day today, so it cannot be called off from your phone. Ring the office.",
    }, () => "Nina Patel");
    expect(elsewhere!.detail).toContain("Ring the office.");
  });
});
