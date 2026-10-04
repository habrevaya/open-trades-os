import { describe, it, expect } from "vitest";
import {
  FieldQueue, MemoryStorage, describeOperation, equipmentPayload, recordEquipment, sameSerial, visitOf,
  type QueuedOperation,
} from "../src/index";

/**
 * A UNIT RECORDED ON SITE, AND WHAT THE PHONE SAYS WHEN THE SERIAL IS
 * ALREADY ON FILE SOMEWHERE ELSE
 *
 * The match itself is the server's, against the whole company's register;
 * the decision is core's and tested there and in the sync's integration
 * test. Here: what the phone sends, and what it tells the technician.
 */

describe("what a unit on site is sent as", () => {
  it("is trimmed, with nothing empty in it, and names the visit and the address", () => {
    expect(equipmentPayload({
      visitId: "v1", propertyId: "p1", category: " furnace ", manufacturer: "Carrier ", model: "",
      serialNumber: " ab-1234 x ", location: undefined,
    })).toEqual({ visitId: "v1", propertyId: "p1", category: "furnace", manufacturer: "Carrier", serialNumber: "ab-1234 x" });
  });

  it("carries the technician's word that it is a different unit only with a serial to be different about", () => {
    expect(equipmentPayload({ visitId: "v1", propertyId: "p1", category: "furnace", serialNumber: "X1", differentUnit: true }))
      .toMatchObject({ serialElsewhereConfirmed: true });
    expect(equipmentPayload({ visitId: "v1", propertyId: "p1", category: "furnace", differentUnit: true }))
      .not.toHaveProperty("serialElsewhereConfirmed");
  });

  it("refuses a unit with no category, in words", () => {
    expect(() => equipmentPayload({ visitId: "v1", propertyId: "p1", category: "  " })).toThrow(/Say what the unit is/);
  });

  it("goes into the queue against the visit it was recorded on", async () => {
    let n = 0;
    const queue = new FieldQueue({ storage: new MemoryStorage(), deviceId: "d1", newId: () => `id-${++n}` });
    const op = await recordEquipment(queue, { visitId: "v1", propertyId: "p1", category: "condenser", serialNumber: "E-77" });
    expect(op.kind).toBe("equipment.record");
    expect(visitOf(op)).toBe("v1");
    expect((await queue.pending()).map((o) => o.kind)).toEqual(["equipment.record"]);
  });
});

describe("a serial as the server matches it", () => {
  it("is the same plate whatever the spacing, case and punctuation", () => {
    expect(sameSerial("ab-1234 x", "AB1234X")).toBe(true);
    expect(sameSerial("AB1234X", "AB1234Y")).toBe(false);
    expect(sameSerial("--", "--")).toBe(false);
    expect(sameSerial(null, "AB")).toBe(false);
  });
});

describe("what the technician is told", () => {
  const held = (over: Partial<QueuedOperation>): QueuedOperation => ({
    clientId: "op-1", sequence: 1, kind: "equipment.record", occurredAt: "2026-10-02T15:00:00.000Z",
    payload: { visitId: "v1", propertyId: "p1", category: "furnace", serialNumber: "SN-1" },
    status: "conflicted", attempts: 0, ...over,
  });

  it("says a unit on file elsewhere was held for the office, not added, and asks nothing of them", () => {
    const problem = describeOperation(held({
      conflict: "Not added from the phone. Serial SN-1 is already on file: furnace at 12 Elm St, Austin.",
    }), (id) => (id === "v1" ? "Nina Patel" : undefined))!;
    expect(problem.title).toBe("Held for the office");
    expect(problem.detail).toMatch(/^Equipment recorded at Nina Patel's job was not added yet/);
    expect(problem.detail).not.toMatch(/on the record/);
    expect(problem.action).toBe("acknowledge");
    expect(problem.visitId).toBe("v1");
  });
});
