import { describe, it, expect, beforeEach } from "vitest";
import { FieldQueue, MemoryStorage, checkGallons, describeOperation, projectDay, recordWater, visitOf, type FieldSnapshot } from "../src/index";

/**
 * THE FRESH WATER A TRUCK USED, READ BY ITS DRIVER
 *
 * Read off the tank at the end of the day, often in a yard with no signal, so
 * it is a queue operation like anything else the person did: kept on the
 * phone, shown on the day as waiting, and sent when there is a signal. The
 * day is the reading's field, so a second reading of the day replaces the
 * first and a reading of yesterday does not.
 */
const TRUCK = "6f1c2b9e-0a4d-4f39-9c7e-2b8a1d3e5f61";
const clock = new Date("2026-10-02T23:00:00Z");
let storage: MemoryStorage;
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const queue = () => new FieldQueue({ storage, deviceId: "device-1", newId, now: () => clock, random: () => 1 });

const snapshot = (): FieldSnapshot => ({
  revision: 1, unchanged: false, visits: [], priceBook: [], openTimeEntry: null,
  trucks: [{ assetId: TRUCK, label: "Truck 3", days: ["2026-10-01", "2026-10-02"], water: [{ onDay: "2026-10-01", gallons: "380.0000" }] }],
});

beforeEach(() => {
  storage = new MemoryStorage();
  ids = 0;
});

describe("checking the gallons as typed", () => {
  it("takes a number, with or without a comma, and refuses words and more than a truck uses", () => {
    expect(checkGallons(" 410 ")).toEqual({ ok: true, gallons: "410" });
    expect(checkGallons("1,250.5")).toEqual({ ok: true, gallons: "1250.5" });
    expect(checkGallons("about 400")).toMatchObject({ ok: false });
    expect(checkGallons("-3")).toMatchObject({ ok: false });
    expect(checkGallons("41000")).toMatchObject({ ok: false, problem: expect.stringContaining("more than a truck uses") });
  });
});

describe("recording a truck's water with no signal", () => {
  it("is queued with the day as its field, shown on the day as waiting, and is nobody's visit", async () => {
    const q = queue();
    const op = await recordWater(q, { assetId: TRUCK, onDay: "2026-10-02", gallons: "410" });
    expect(op).toMatchObject({ kind: "truck.water", subjectId: TRUCK, payload: { field: "2026-10-02", onDay: "2026-10-02", gallons: "410" } });
    expect(visitOf(op)).toBeUndefined();
    /** Refused, it is said to the driver as their truck's water, not as somebody's job. */
    expect(describeOperation({ ...op, status: "rejected", lastError: "That truck was not checked out to you on that day." })?.detail)
      .toMatch(/fresh water your truck used/i);

    const day = projectDay({ snapshot: snapshot(), operations: await q.pending() });
    expect(day.trucks[0]!.water).toEqual([
      { onDay: "2026-10-01", gallons: "380.0000", waiting: false },
      { onDay: "2026-10-02", gallons: "410", waiting: true },
    ]);
  });

  it("lays a second reading of a day over the first", async () => {
    const q = queue();
    await recordWater(q, { assetId: TRUCK, onDay: "2026-10-01", gallons: "390" });
    const day = projectDay({ snapshot: snapshot(), operations: await q.pending() });
    expect(day.trucks[0]!.water).toEqual([{ onDay: "2026-10-01", gallons: "390", waiting: true }]);
  });
});
