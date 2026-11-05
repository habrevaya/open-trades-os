import { describe, it, expect } from "vitest";
import { FieldQueue, MemoryStorage, UploadQueue, checkExpenseDraft, recordExpense, vehicleChoices, type UploadFiles } from "../src/index";

/**
 * THE VEHICLE CHECKED OUT THAT DAY, ON A CLAIM IN MILES
 *
 * A server that defaults a claim to the vehicle the person had checked out that
 * day says so by sending `mileageCheckedOut` (null when they have none today).
 * The picker then leads with that default and offers "My own vehicle" as a
 * choice of its own, which goes to the server as `ownVehicle`. An older server
 * sends nothing, and the picker is as it was.
 */
const today = "2026-10-05";
const VAN = "00000000-0000-4000-8000-0000000000aa";
const vehicles = [{ id: VAN, label: "Van 14", rateToday: "0.450" }, { id: "x", label: "Truck 2", rateToday: null }];

describe("the choices when the server defaults to the vehicle checked out", () => {
  it("leads with the vehicle checked out that day, then the person's own, then each vehicle", () => {
    expect(vehicleChoices({ mileageRate: "0.700", mileageVehicles: vehicles, mileageCheckedOut: { id: VAN, label: "Van 14" } })).toEqual([
      { value: "", label: "The vehicle checked out to me that day (Van 14 today)" },
      { value: "own", label: "My own vehicle" },
      { value: VAN, label: "Van 14, $0.450 a mile" },
      { value: "x", label: "Truck 2" },
    ]);
  });

  it("says what happens with none out today, and offers no own vehicle when nothing would pay for it", () => {
    expect(vehicleChoices({ mileageRate: "0.700", mileageVehicles: vehicles, mileageCheckedOut: null }).slice(0, 2)).toEqual([
      { value: "", label: "The vehicle checked out to me that day, or my own" },
      { value: "own", label: "My own vehicle" },
    ]);
    expect(vehicleChoices({ mileageRate: null, mileageVehicles: vehicles, mileageCheckedOut: null }).map((c) => c.value))
      .toEqual(["", VAN, "x"]);
  });

  it("is unchanged for an older server that sends nothing about it", () => {
    expect(vehicleChoices({ mileageRate: "0.700", mileageVehicles: vehicles })[0]).toEqual({ value: "", label: "My own vehicle" });
  });
});

describe("saying it was their own vehicle", () => {
  const draft = { amount: "", miles: "10", spentOn: "2026-10-04", description: "Drive to the job", jobId: null, vehicleId: "own" };

  it("is kept with the miles as their own, never as a vehicle", () => {
    expect(checkExpenseDraft(draft, today)).toEqual({
      ok: true, miles: "10.0", ownVehicle: true, spentOn: "2026-10-04", description: "Drive to the job", jobId: null,
    });
  });

  it("is refused with an amount paid, in words", () => {
    expect(checkExpenseDraft({ ...draft, miles: "", amount: "12.00" }, today)).toMatchObject({ ok: false });
  });

  it("goes in the queue as ownVehicle with the miles", async () => {
    let n = 0;
    const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const files: UploadFiles = { async read() { return ""; }, async remove() {} };
    const storage = new MemoryStorage();
    const now = new Date("2026-10-05T15:00:00Z");
    const queue = new FieldQueue({ storage, deviceId: "device-1", newId, now: () => now, random: () => 1 });
    const uploads = new UploadQueue({ storage, queue, files, now: () => now });
    const claim = checkExpenseDraft(draft, today);
    if (!claim.ok) throw new Error(claim.reason);
    await recordExpense({ queue, uploads }, { expenseId: newId(), expense: claim });
    const [op] = await queue.pending();
    expect(op!.payload).toEqual({ miles: "10.0", ownVehicle: true, spentOn: "2026-10-04", description: "Drive to the job" });
  });
});
