import { describe, it, expect } from "vitest";
import { FieldQueue, MemoryStorage, projectDay, recordHaulTime, haulTipChoices, type FieldSnapshot } from "../src/index";

/**
 * A CAN THAT CAME BACK EMPTY, SAID FROM THE CAB
 *
 * The office could mark a collected can as having come back empty; the
 * driver, who is the one who knows, could not. Now it is a third moment on
 * the same `haul.time` operation, its own field so it never overwrites the
 * tip or the drop, shown on the stop as waiting until it is sent. A stop
 * offers the tip or the empty mark, never both, because the server refuses
 * one with the other.
 */
const PICKUP = "5c2d3e4f-0a4d-4f39-9c7e-2b8a1d3e5f62";
const STOP = "6d3e4f5a-0a4d-4f39-9c7e-2b8a1d3e5f63";
const clock = new Date("2026-10-02T19:00:00Z");

const snapshot = (tip: { tippedAt: string | null; cameBackEmptyAt?: string }): FieldSnapshot => ({
  revision: 1, unchanged: false, visits: [], priceBook: [], openTimeEntry: null,
  hauls: [{ visitId: STOP, leg: "pickup", drop: null, tip: { rentalId: PICKUP, container: "102 (30 yd)", ...tip } }],
});

describe("came back empty", () => {
  it("is queued as the empty moment and shown on the stop as waiting, leaving the tip alone", async () => {
    let ids = 0;
    const q = new FieldQueue({
      storage: new MemoryStorage(), deviceId: "device-1", now: () => clock, random: () => 1,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    });
    const at = new Date("2026-10-02T15:10:00Z");
    const op = await recordHaulTime(q, { rentalId: PICKUP, visitId: STOP, moment: "empty", at });
    expect(op).toMatchObject({ kind: "haul.time", subjectId: PICKUP, payload: { field: "empty", at: at.toISOString(), visitId: STOP } });

    const day = projectDay({ snapshot: snapshot({ tippedAt: null }), operations: await q.pending() });
    expect(day.hauls[0]!.tip).toEqual({
      rentalId: PICKUP, container: "102 (30 yd)", tippedAt: null, cameBackEmptyAt: at.toISOString(), waiting: true,
    });
  });

  it("offers the tip or the empty mark, never both, and neither once it is marked", () => {
    expect(haulTipChoices({ tippedAt: null })).toEqual({ emptyAt: null, offerTip: true, offerEmpty: true });
    expect(haulTipChoices({ tippedAt: "2026-10-02T16:00:00Z" })).toEqual({ emptyAt: null, offerTip: true, offerEmpty: false });
    expect(haulTipChoices({ tippedAt: null, cameBackEmptyAt: "2026-10-02T15:10:00Z" }))
      .toEqual({ emptyAt: "2026-10-02T15:10:00Z", offerTip: false, offerEmpty: false });
  });

  it("shows the office's mark from the server", () => {
    const day = projectDay({ snapshot: snapshot({ tippedAt: null, cameBackEmptyAt: "2026-10-02T15:10:00.000Z" }), operations: [] });
    expect(haulTipChoices(day.hauls[0]!.tip!).emptyAt).toBe("2026-10-02T15:10:00.000Z");
  });
});
