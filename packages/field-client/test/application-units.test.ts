import { describe, it, expect } from "vitest";
import { applicationFromBook, applicationUnitOf, applicationUnits, chemicalsIn, type PriceBookEntry } from "../src/index";

/**
 * EITHER UNIT FOR A CHEMICAL BOUGHT IN ONE AND USED IN ANOTHER
 *
 * The office could record a concentrate bought by the gallon in ounces or in
 * gallons; the phone could not. The phone and /my-day now offer the units the
 * book says, and send the one picked, decided exactly as the server decides
 * it: the buy or the use unit, spelt as the book spells it, otherwise the
 * chemical's own. The amount is never converted on the phone.
 */
const entry = (id: string, name: string, chemical: PriceBookEntry["chemical"]): PriceBookEntry => ({
  id, versionId: `${id}-v`, code: null, name, unitPrice: "20.00", taxable: true, chemical,
});
const BOOK = [
  entry("c", "Concentrate", { unit: "oz", epaRegistrationNumber: "100-1", units: { buy: "gal", use: "oz" } }),
  entry("g", "Advion gel", { unit: "oz", epaRegistrationNumber: null }),
  entry("b", "Bifen IT", { unit: "qt", epaRegistrationNumber: null, units: { buy: "gal", use: "oz" } }),
];
const chemicals = chemicalsIn(BOOK);
const bifen = chemicals.find((c) => c.id === "b");
const concentrate = chemicals.find((c) => c.id === "c");
const gel = chemicals.find((c) => c.id === "g");
const question = { key: "product_applied", label: "Product applied" };

describe("the units an application can be in", () => {
  it("carries the book's two units, and none for a chemical with one", () => {
    expect(concentrate!.units).toEqual({ buy: "gal", use: "oz" });
    expect(gel!.units).toBeNull();
  });

  it("offers the chemical's own unit first, then the use and buy unit, each once", () => {
    expect(applicationUnits(concentrate!)).toEqual(["oz", "gal"]);
    expect(applicationUnits(gel!)).toEqual(["oz"]);
    expect(applicationUnits(bifen!)).toEqual(["qt", "oz", "gal"]);
  });

  it("decides the unit as the server does: the buy or use unit as the book spells it, else the chemical's own", () => {
    expect(applicationUnitOf(concentrate!, "GAL ")).toBe("gal");
    expect(applicationUnitOf(concentrate!, "oz")).toBe("oz");
    expect(applicationUnitOf(concentrate!, "quart")).toBe("oz");
    expect(applicationUnitOf(concentrate!)).toBe("oz");
    expect(applicationUnitOf(gel!, "gal")).toBe("oz");
  });

  it("sends the amount as typed in the unit picked, never converted", () => {
    expect(applicationFromBook(question, concentrate!, "0.5", "gal")).toMatchObject({
      priceBookItemId: "c", quantityApplied: "0.5", applicationUnit: "gal",
    });
    expect(applicationFromBook(question, concentrate!, "16")).toMatchObject({ quantityApplied: "16", applicationUnit: "oz" });
  });
});
