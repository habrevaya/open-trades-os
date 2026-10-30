import { describe, it, expect } from "vitest";
import { payExtras as px } from "../src/index";

/** The order a claim in miles is priced in: the vehicle, the kind of work, the person, then the company. */
describe("a rate for a kind of work", () => {
  const company = [{ from: "2026-01-01", perMile: "0.700" }];
  const person = [{ from: "2026-01-01", perMile: "0.800" }];
  const work = [{ from: "2026-06-01", perMile: "0.900" }];
  const vehicle = [{ from: "2026-01-01", perMile: "0.500" }];

  it("comes after a vehicle named and before the person's own line", () => {
    expect(px.resolveMileageRate("2026-07-01", { vehicle, work, person, company }))
      .toEqual({ rate: vehicle[0], source: "vehicle" });
    expect(px.resolveMileageRate("2026-07-01", { work, person, company })).toEqual({ rate: work[0], source: "work" });
    expect(px.resolveMileageRate("2026-07-01", { work, company })).toEqual({ rate: work[0], source: "work" });
  });

  it("is passed over before its first day", () => {
    expect(px.resolveMileageRate("2026-05-31", { work, person, company })).toEqual({ rate: person[0], source: "person" });
    expect(px.resolveMileageRate("2026-05-31", { work, company })).toEqual({ rate: company[0], source: "company" });
  });
});
