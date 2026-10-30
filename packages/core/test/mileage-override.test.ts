import { describe, it, expect } from "vitest";
import { payExtras as px } from "../src/index";

/**
 * A MILEAGE RATE OF ONE PERSON'S OR ONE VEHICLE'S OWN
 *
 * The rate for a claim is the vehicle's line in force on the day of the drive, else the person's, else the
 * company's. A person or vehicle whose lines have not started yet is passed over, not refused.
 */
describe("which rate a claim is worked out at", () => {
  const company = [{ from: "2025-01-01", perMile: "0.700" }];
  const person = [{ from: "2026-03-01", perMile: "0.800" }];
  const vehicle = [{ from: "2026-06-01", perMile: "0.450" }];

  it("is the company's when nobody has a line of their own", () => {
    expect(px.resolveMileageRate("2026-07-01", { company })).toEqual({ rate: company[0], source: "company" });
  });

  it("is the person's when they have one in force, and the vehicle's before both", () => {
    expect(px.resolveMileageRate("2026-04-01", { person, vehicle, company })?.source).toBe("person");
    expect(px.resolveMileageRate("2026-07-01", { person, vehicle, company })).toEqual({ rate: vehicle[0], source: "vehicle" });
  });

  it("passes over a line that starts after the day of the drive", () => {
    expect(px.resolveMileageRate("2026-02-01", { person, vehicle, company })?.source).toBe("company");
    expect(px.resolveMileageRate("2026-05-01", { person, vehicle, company })?.source).toBe("person");
  });

  it("is null when nothing has started, so the claim is refused rather than guessed", () => {
    expect(px.resolveMileageRate("2024-12-31", { person: [], vehicle: [], company })).toBeNull();
    expect(px.resolveMileageRate("2026-07-01", { company: [] })).toBeNull();
  });
});
