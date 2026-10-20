import { describe, it, expect } from "vitest";
import { routing, rental } from "../src/index";

/**
 * WHAT A FACILITY TAKES AND WHAT IT CHARGES, IN THE CHOICE OF WHERE A HAUL GOES
 *
 * The same line of places as the facility choice tests: the drive between two
 * is the distance between them in minutes, the yard at 0, a collection at 20,
 * a drop at 25 and the facilities further along.
 */

const line: Record<string, number> = { yard: 0, p1: 20, d1: 25, near: 30, mid: 45, far: 90 };
const drive: routing.Travel = (from, to) => Math.abs(line[from]! - line[to]!);
const yardWaste: routing.Cargo = { material: "Yard waste", tons: "2" };
const stop = (id: string, work: routing.TruckWork, load?: routing.Cargo): routing.TruckStop =>
  ({ id, work, serviceMinutes: 15, windowStart: null, windowEnd: null, ...(load ? { load } : {}) });
const fac = (key: string, extra: Partial<routing.TruckFacility> = {}): routing.TruckFacility =>
  ({ key, name: key, minutes: 15, hours: null, ...extra });
/** A facility that charges a flat amount a can, in cents. */
const flat = (cents: number) => (cargo: readonly routing.Cargo[]) => cargo.length * cents;
const day = (facilities: routing.TruckFacility[], extra: Partial<routing.TruckPlan> = {}): routing.TruckPlan => ({
  start: "yard", end: "yard", yard: "yard", departAt: 0, travel: drive, capacity: 1, yardMinutes: 10, load: null,
  stops: [stop("p1", "pickup", yardWaste), stop("d1", "drop")], facilities, ...extra,
});
const runOf = (plan: routing.TruckPlan) => routing.evaluateTruck(plan, ["p1", "d1"]).facilityRuns[0]!;

describe("a facility that does not take the load", () => {
  it("is left out, even when it is nearer, and the choice says what it does not take", () => {
    const run = runOf(day([fac("near", { takes: ["concrete"] }), fac("mid", { takes: ["yard waste"] })]));
    expect(run.facilityKey).toBe("mid");
    expect(run.notTaken).toBeUndefined();
    expect(run.choice!.others).toEqual([expect.objectContaining({ key: "near", standing: "does_not_take", refuses: ["Yard waste"] })]);
  });

  it("never turns away a load of no known material, or a facility whose list nobody recorded", () => {
    const unknown = day([fac("near", { takes: ["concrete"] }), fac("mid")], { stops: [stop("p1", "pickup"), stop("d1", "drop")] });
    expect(runOf(unknown).facilityKey).toBe("near");
    expect(runOf(day([fac("near", { takes: [] }), fac("mid", { takes: ["yard waste"] })])).facilityKey).toBe("near");
  });

  it("refuses the run, naming the nearest, when no facility takes it all", () => {
    const plan = day([fac("near", { takes: ["concrete"] }), fac("mid", { takes: ["metal"] })]);
    const run = runOf(plan);
    expect(run).toMatchObject({ facilityKey: "near", notTaken: ["Yard waste"] });
    expect(routing.optimiseTruck(plan, ["p1", "d1"]).facilityRefused).toHaveLength(1);
    const words = rental.chosenWords("Near Transfer", run.choice!, (key) => ({ name: key === "mid" ? "Metal Yard" : "Near Transfer", shutWhy: null }));
    expect(words).toContain("No facility on the map takes everything on the truck. Near Transfer is the nearest, 10 min by road, and does not take Yard waste, so the run is refused.");
  });
});

describe("the fee beside the time", () => {
  it("sends the can farther when the fee saved is worth more than the minutes, at the company's hour cost", () => {
    // Near is 10 minutes from the collection and charges 300.00; mid is 25 minutes and charges 100.00.
    const facilities = [fac("near", { fee: flat(30000) }), fac("mid", { fee: flat(10000) })];
    // At 60.00 an hour, 15 extra minutes cost 15.00, far less than the 200.00 saved.
    const run = runOf(day(facilities, { minuteCost: 100 }));
    expect(run.facilityKey).toBe("mid");
    expect(run.choice).toMatchObject({ basis: "cheapest_open", feeCents: 10000, fees: { weighed: true, hourCents: 6000 } });
    const names: Record<string, string> = { near: "Near Transfer", mid: "Middle Landfill" };
    expect(rental.chosenWords("Middle Landfill", run.choice!, (key) => ({ name: names[key]!, shutWhy: null }))).toBe(
      "Middle Landfill costs the least all told, 100.00 to tip, 25 min by road. "
      + "Near Transfer is 10 min by road and would charge 300.00. "
      + "Fees are weighed beside time, at 60.00 an hour of the truck.");
  });

  it("keeps the nearer one when the minutes cost more than the fee saved", () => {
    // At 6,000.00 an hour (100 a minute), 15 minutes cost 1,500.00, more than the 200.00 saved.
    const run = runOf(day([fac("near", { fee: flat(30000) }), fac("mid", { fee: flat(10000) })], { minuteCost: 10000 }));
    expect(run.facilityKey).toBe("near");
    expect(run.choice).toMatchObject({ basis: "nearest_open", feeCents: 30000, fees: { weighed: true } });
  });

  it("does not weigh the fee without an hour cost, or when one facility cannot say what it charges, and says so", () => {
    const noCost = runOf(day([fac("near", { fee: flat(30000) }), fac("mid", { fee: flat(10000) })]));
    expect(noCost.facilityKey).toBe("near");
    expect(noCost.choice!.fees).toEqual({ weighed: false, why: "no_hour_cost" });
    const describe_ = (key: string) => ({ name: key, shutWhy: null });
    expect(rental.chosenWords("near", noCost.choice!, describe_)).toContain("Fees are not weighed, because what an hour of the truck costs is not set");

    const unknown = runOf(day([fac("near", { fee: () => null }), fac("mid", { fee: flat(10000) })], { minuteCost: 100 }));
    expect(unknown.facilityKey).toBe("near");
    expect(unknown.choice!.fees).toEqual({ weighed: false, why: "fee_unknown", unknown: ["near"] });
    expect(rental.chosenWords("near", unknown.choice!, describe_)).toContain("Fees are not weighed, because near cannot say what this load would cost.");
  });

  it("weighs only the ones open: a cheap one that is closed is still skipped", () => {
    const run = runOf(day([fac("near", { fee: flat(30000) }), fac("mid", { fee: flat(100), hours: "closed" })], { minuteCost: 100 }));
    expect(run.facilityKey).toBe("near");
    expect(run.choice!.fees).toBeUndefined();
  });

  it("is a day planned exactly as before when no facility says what it takes or charges", () => {
    const before = routing.evaluateTruck(day([fac("near"), fac("mid")]), ["p1", "d1"]);
    expect(before.facilityRuns[0]).toMatchObject({ facilityKey: "near", choice: { basis: "nearest_open" } });
    expect(before.facilityRuns[0]!.choice!.fees).toBeUndefined();
  });
});

describe("the materials a facility lists", () => {
  it("reads the list as typed, one a line, and refuses a line it cannot read", () => {
    expect(rental.parseMaterialLines("Yard waste, 38.00 a ton\nConcrete: $120 per load\n  Metal  \n")).toEqual({
      ok: true,
      materials: [
        { material: "Yard waste", feeBasis: "per_ton", feeAmount: "38.0000" },
        { material: "Concrete", feeBasis: "per_load", feeAmount: "120.0000" },
        { material: "Metal", feeBasis: null, feeAmount: null },
      ],
    });
    expect(rental.parseMaterialLines("Yard waste, cheap")).toMatchObject({ ok: true });
    expect(rental.parseMaterialLines("Tyres, 4 each")).toMatchObject({ ok: false, message: expect.stringContaining("Write it as Yard waste, 38.00 a ton") });
    expect(rental.parseMaterialLines("Metal\nmetal")).toEqual({ ok: false, message: "metal is listed twice." });
    expect(rental.parseMaterialLines("")).toEqual({ ok: true, materials: [] });
  });

  it("takes a material by name with case and spacing ignored, and anything when nothing is listed", () => {
    const list: rental.FacilityMaterial[] = [{ material: "Yard waste", feeBasis: null, feeAmount: null }];
    expect(rental.takesMaterial(list, "yard  WASTE")).toBe(true);
    expect(rental.takesMaterial(list, "Brush")).toBe(false);
    expect(rental.takesMaterial(list, null)).toBe(true);
    expect(rental.takesMaterial([], "Brush")).toBe(true);
  });

  it("charges a material its own rate, the facility's otherwise, with the facility's minimum either way", () => {
    const list: rental.FacilityMaterial[] = [{ material: "Concrete", feeBasis: "per_load", feeAmount: "120.00" }];
    const general: rental.FacilityRate = { basis: "per_ton", amount: "50.00", minimum: "40.00" };
    expect(rental.feeForLoads(list, general, [{ material: "Concrete", tons: null }, { material: "Mixed", tons: "2" }]))
      .toEqual({ ok: true, cents: 22000 });
    expect(rental.feeForLoads(list, general, [{ material: "Mixed", tons: "0.5" }])).toEqual({ ok: true, cents: 4000 });
    expect(rental.feeForLoads(list, general, [{ material: "Mixed", tons: null }])).toMatchObject({ ok: false });
    expect(rental.feeForLoads([], null, [{ material: null, tons: "1" }])).toMatchObject({ ok: false });
    expect(rental.centsWords(123456)).toBe("1,234.56");
  });
});
