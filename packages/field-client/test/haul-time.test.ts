import { describe, it, expect, beforeEach } from "vitest";
import { FieldQueue, MemoryStorage, describeOperation, haulClock, projectDay, recordHaulTime, visitOf, type FieldSnapshot } from "../src/index";

/**
 * WHEN A DRIVER PUT A CAN DOWN, AND WHEN THEY EMPTIED ONE
 *
 * Tapped on the stop, at the kerb or on the tipping floor, often with no
 * signal, so each is a queue operation like anything else the driver did:
 * kept on the phone, shown on the stop as waiting, sent when there is a
 * signal. Which moment is the field, so tapping the tip again replaces the
 * tip and leaves the drop alone.
 */
const DELIVERY = "4b1c2d3e-0a4d-4f39-9c7e-2b8a1d3e5f61";
const PICKUP = "5c2d3e4f-0a4d-4f39-9c7e-2b8a1d3e5f62";
const STOP = "6d3e4f5a-0a4d-4f39-9c7e-2b8a1d3e5f63";
const clock = new Date("2026-10-02T19:00:00Z");
let storage: MemoryStorage;
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const queue = () => new FieldQueue({ storage, deviceId: "device-1", newId, now: () => clock, random: () => 1 });

const snapshot = (): FieldSnapshot => ({
  revision: 1, unchanged: false, visits: [], priceBook: [], openTimeEntry: null,
  hauls: [
    { visitId: STOP, leg: "swap",
      drop: { rentalId: DELIVERY, container: "101 (20 yd)", deliveredAt: "2026-10-02T17:00:00.000Z", timeKnown: false },
      tip: { rentalId: PICKUP, container: "102 (30 yd)", tippedAt: null } },
  ],
});

beforeEach(() => {
  storage = new MemoryStorage();
  ids = 0;
});

describe("a time typed on the stop", () => {
  it("takes a clock time either way, empty for now, and refuses words and a time still to come", () => {
    const now = new Date(2026, 9, 2, 15, 0);
    expect(haulClock("", now)).toEqual({ ok: true, at: now });
    expect(haulClock("14:30", now)).toEqual({ ok: true, at: new Date(2026, 9, 2, 14, 30) });
    expect(haulClock("2:30 pm", now)).toEqual({ ok: true, at: new Date(2026, 9, 2, 14, 30) });
    expect(haulClock("12 am", now)).toEqual({ ok: true, at: new Date(2026, 9, 2, 0, 0) });
    expect(haulClock("after lunch", now)).toMatchObject({ ok: false });
    expect(haulClock("25:00", now)).toMatchObject({ ok: false });
    expect(haulClock("16:30", now)).toMatchObject({ ok: false, problem: expect.stringContaining("not come yet") });
  });
});

describe("timing a haul with no signal", () => {
  it("is queued with the moment as its field, shown on the stop as waiting, and is about the stop's job", async () => {
    const q = queue();
    const at = new Date("2026-10-02T18:40:00Z");
    const op = await recordHaulTime(q, { rentalId: PICKUP, visitId: STOP, moment: "tipped", at });
    expect(op).toMatchObject({ kind: "haul.time", subjectId: PICKUP, payload: { field: "tipped", at: at.toISOString(), visitId: STOP } });
    expect(visitOf(op)).toBe(STOP);
    expect(describeOperation({ ...op, status: "rejected", lastError: "That haul is not on one of your stops." }, () => "Builder Bob")?.detail)
      .toMatch(/dropped or emptied a container on Builder Bob's job/i);

    const day = projectDay({ snapshot: snapshot(), operations: await q.pending() });
    expect(day.hauls[0]!.tip).toEqual({ rentalId: PICKUP, container: "102 (30 yd)", tippedAt: at.toISOString(), waiting: true });
    /** The drop is left alone, still only a day. */
    expect(day.hauls[0]!.drop).toMatchObject({ timeKnown: false, waiting: false });
  });

  it("marks a drop as a known time when the driver taps it", async () => {
    const q = queue();
    const at = new Date("2026-10-02T16:05:00Z");
    await recordHaulTime(q, { rentalId: DELIVERY, visitId: STOP, moment: "placed", at });
    const day = projectDay({ snapshot: snapshot(), operations: await q.pending() });
    expect(day.hauls[0]!.drop).toEqual({ rentalId: DELIVERY, container: "101 (20 yd)", deliveredAt: at.toISOString(), timeKnown: true, waiting: true });
  });
});
