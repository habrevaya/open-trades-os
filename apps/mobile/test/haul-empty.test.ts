import { describe, it, expect } from "vitest";
import { projectDay, haulTipChoices, type FieldSnapshot, type QueuedOperation } from "@opentradesos/field-client";

/**
 * "IT CAME BACK EMPTY" ON THE PHONE
 *
 * The day screen shows the tip or the empty mark from what the phone holds:
 * a tap kept in the queue and not yet sent is shown at once, and once a can
 * is marked empty neither the tip nor the mark is offered again, because
 * taking it off is the office's.
 */
const PICKUP = "5c2d3e4f-0a4d-4f39-9c7e-2b8a1d3e5f62";
const STOP = "6d3e4f5a-0a4d-4f39-9c7e-2b8a1d3e5f63";

const snapshot: FieldSnapshot = {
  revision: 1, unchanged: false, visits: [], priceBook: [], openTimeEntry: null,
  hauls: [{ visitId: STOP, leg: "pickup", drop: null, tip: { rentalId: PICKUP, container: "102 (30 yd)", tippedAt: null } }],
};

describe("a collected can on the day screen", () => {
  it("offers both until one is chosen, and neither once the driver has said it came back empty", () => {
    const before = projectDay({ snapshot, operations: [] });
    expect(haulTipChoices(before.hauls[0]!.tip!)).toMatchObject({ offerTip: true, offerEmpty: true });

    const tapped = {
      clientId: "00000000-0000-4000-8000-000000000001", sequence: 1, kind: "haul.time", subjectId: PICKUP,
      occurredAt: "2026-10-02T15:10:00.000Z", status: "pending", attempts: 0,
      payload: { field: "empty", at: "2026-10-02T15:10:00.000Z", visitId: STOP },
    } as unknown as QueuedOperation;
    const after = projectDay({ snapshot, operations: [tapped] });
    expect(after.hauls[0]!.tip).toMatchObject({ cameBackEmptyAt: "2026-10-02T15:10:00.000Z", waiting: true });
    expect(haulTipChoices(after.hauls[0]!.tip!)).toEqual({
      emptyAt: "2026-10-02T15:10:00.000Z", offerTip: false, offerEmpty: false,
    });
  });
});
