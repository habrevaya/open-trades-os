import { describe, it, expect } from "vitest";
import { rental as rt } from "../src/index";

/** A markup set for one facility or one material, falling back to the company's. */
describe("which markup a haul's fee takes", () => {
  it("is the company's when neither the facility nor the material has one", () => {
    expect(rt.disposalMarkupFor({ company: "0.15" })).toEqual({ markup: "0.15", from: "company" });
    expect(rt.disposalMarkupFor({ company: null, facility: null, material: null })).toEqual({ markup: null, from: "company" });
  });

  it("is the facility's or the material's when only one is set, even when it is 0", () => {
    expect(rt.disposalMarkupFor({ company: "0.15", facility: "0.25" })).toEqual({ markup: "0.25", from: "facility" });
    expect(rt.disposalMarkupFor({ company: "0.15", material: "0" })).toEqual({ markup: "0", from: "material" });
    expect(rt.passedOnFee({ cost: "100", markup: "0" })).toEqual({ amount: "100.0000", words: "at cost" });
  });

  it("is the smaller when both are set, and the facility's on a tie", () => {
    expect(rt.disposalMarkupFor({ company: "0.15", facility: "0.25", material: "0.1" })).toEqual({ markup: "0.1", from: "material" });
    expect(rt.disposalMarkupFor({ company: "0.15", facility: "0.05", material: "0.1" })).toEqual({ markup: "0.05", from: "facility" });
    expect(rt.disposalMarkupFor({ company: null, facility: "0.1", material: "0.10" })).toEqual({ markup: "0.1", from: "facility" });
  });
});
