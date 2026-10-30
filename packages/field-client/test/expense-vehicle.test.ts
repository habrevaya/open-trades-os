import { describe, it, expect } from "vitest";
import {
  FieldQueue, MemoryStorage, UploadQueue, checkExpenseDraft, milesOffered, recordExpense, vehicleChoices, type UploadFiles,
} from "../src/index";

/**
 * A VEHICLE ON A CLAIM IN MILES, FROM THE PHONE AND `/my-day`
 *
 * The phone is given the company vehicles that have a rate for a mile of their own. A claim in miles may name
 * one; the phone sends the vehicle with the miles and nothing about the money, and the server works the claim
 * out at that vehicle's rate on the day of the drive. A vehicle never goes with an amount paid.
 */
const today = "2026-10-05";
const VAN = "00000000-0000-4000-8000-0000000000aa";
const draft = { amount: "", miles: "10", spentOn: "2026-10-04", description: "Drive to the job", jobId: null, vehicleId: VAN };

describe("the vehicle on a claim", () => {
  it("is kept with the miles", () => {
    expect(checkExpenseDraft(draft, today)).toEqual({
      ok: true, miles: "10.0", vehicleId: VAN, spentOn: "2026-10-04", description: "Drive to the job", jobId: null,
    });
  });

  it("is left off for the person's own vehicle", () => {
    const own = checkExpenseDraft({ ...draft, vehicleId: "" }, today);
    expect(own).toEqual({ ok: true, miles: "10.0", spentOn: "2026-10-04", description: "Drive to the job", jobId: null });
    expect(checkExpenseDraft({ ...draft, vehicleId: null }, today)).toEqual(own);
  });

  it("is refused with an amount paid, in words", () => {
    expect(checkExpenseDraft({ ...draft, miles: "", amount: "12.00" }, today)).toEqual({
      ok: false, reason: "A vehicle goes with the miles you drove, not with what you paid. Fill in the miles.",
    });
  });
});

describe("the choices the screen offers", () => {
  const vehicles = [{ id: VAN, label: "Van 14", rateToday: "0.450" }, { id: "x", label: "Truck 2", rateToday: null }];

  it("lists each vehicle with what it pays today, after the person's own", () => {
    expect(vehicleChoices({ mileageRate: "0.700", mileageVehicles: vehicles })).toEqual([
      { value: "", label: "My own vehicle" },
      { value: VAN, label: "Van 14, $0.450 a mile" },
      { value: "x", label: "Truck 2" },
    ]);
    expect(vehicleChoices({ mileageRate: null, mileageVehicles: vehicles })[0]).toEqual({ value: "", label: "Pick one" });
  });

  it("offers no picker without a vehicle of its own, and miles only with some rate", () => {
    expect(vehicleChoices({ mileageRate: "0.700" })).toEqual([]);
    expect(vehicleChoices({ mileageRate: "0.700", mileageVehicles: [] })).toEqual([]);
    expect(milesOffered({ mileageRate: null, mileageVehicles: [] })).toBe(false);
    expect(milesOffered({ mileageRate: null, mileageVehicles: vehicles })).toBe(true);
    expect(milesOffered({ mileageRate: "0.700" })).toBe(true);
    expect(milesOffered({})).toBe(false);
  });
});

describe("sent to the server", () => {
  let n = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const files: UploadFiles = { async read() { return ""; }, async remove() {} };

  it("goes in the queue as miles and the vehicle, with no amount", async () => {
    const storage = new MemoryStorage();
    const now = new Date("2026-10-05T15:00:00Z");
    const queue = new FieldQueue({ storage, deviceId: "device-1", newId, now: () => now, random: () => 1 });
    const uploads = new UploadQueue({ storage, queue, files, now: () => now });
    const claim = checkExpenseDraft(draft, today);
    if (!claim.ok) throw new Error(claim.reason);
    await recordExpense({ queue, uploads }, { expenseId: newId(), expense: claim });
    const [op] = await queue.pending();
    expect(op!.payload).toEqual({ miles: "10.0", vehicleId: VAN, spentOn: "2026-10-04", description: "Drive to the job" });
  });
});
