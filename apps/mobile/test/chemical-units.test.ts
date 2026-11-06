import { describe, it, expect } from "vitest";
import { applicationFromBook, applicationUnits, chemicalsIn, type PriceBookEntry } from "@opentradesos/field-client";

/**
 * THE PHONE PICKS EITHER UNIT FOR A CONCENTRATE
 *
 * The visit's product picker offers a choice of unit only when the book says
 * the chemical is bought in one and used in another, and what it saves names
 * the unit picked, which the server keeps as the office's page would.
 */
const book: PriceBookEntry[] = [
  { id: "c", versionId: "c-v", code: "CONC", name: "Concentrate", unitPrice: "1.50", taxable: false,
    chemical: { unit: "oz", epaRegistrationNumber: "100-1", units: { buy: "gal", use: "oz" } } },
  { id: "g", versionId: "g-v", code: "GEL", name: "Advion gel", unitPrice: "20", taxable: true,
    chemical: { unit: "oz", epaRegistrationNumber: null } },
];

describe("a product chosen on the phone", () => {
  it("offers a unit to pick only for a chemical with two, and saves the one picked", () => {
    const chemicals = chemicalsIn(book);
    const concentrate = chemicals.find((c) => c.id === "c")!;
    const gel = chemicals.find((c) => c.id === "g")!;
    expect(applicationUnits(concentrate)).toEqual(["oz", "gal"]);
    expect(applicationUnits(gel)).toHaveLength(1);
    expect(applicationFromBook({ key: "product_applied", label: "Product applied" }, concentrate, "0.25", "gal"))
      .toMatchObject({ quantityApplied: "0.25", applicationUnit: "gal" });
  });
});
