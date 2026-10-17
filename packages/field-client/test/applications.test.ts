import { describe, it, expect } from "vitest";
import { applicationFromBook, checkApplied, chemicalsIn, searchChemicals, type PriceBookEntry } from "../src/index";

/**
 * A PRODUCT APPLIED, CHOSEN FROM THE BOOK
 *
 * The phone and "My day" offer the chemicals the company marks in its price
 * book, and the technician types only how much. What is sent names the item,
 * so the server can carry the book's name, EPA number and unit onto the record.
 */
const entry = (id: string, name: string, chemical: PriceBookEntry["chemical"], code: string | null = null): PriceBookEntry => ({
  id, versionId: `${id}-v`, code, name, unitPrice: "20.00", taxable: true, chemical,
});
const BOOK = [
  entry("a", "Bifen IT", { unit: "gal", epaRegistrationNumber: "279-3206" }, "BIFEN"),
  entry("b", "Rodent bait station", null),
  entry("c", "Advion gel", { unit: "oz", epaRegistrationNumber: null }),
  entry("d", "Service call", undefined),
];

describe("the chemicals a technician chooses from", () => {
  it("are the book's items marked as chemicals, by name, with their unit", () => {
    expect(chemicalsIn(BOOK).map((c) => [c.name, c.unit])).toEqual([["Advion gel", "oz"], ["Bifen IT", "gal"]]);
  });

  it("are found by any word of the name or the code, and all shown when nothing is typed", () => {
    const chemicals = chemicalsIn(BOOK);
    expect(searchChemicals(chemicals, "bif").map((c) => c.id)).toEqual(["a"]);
    expect(searchChemicals(chemicals, "BIFEN").map((c) => c.id)).toEqual(["a"]);
    expect(searchChemicals(chemicals, "").map((c) => c.id)).toEqual(["c", "a"]);
    expect(searchChemicals(chemicals, "station")).toEqual([]);
  });
});

describe("how much was applied", () => {
  it("is a positive number, checked before it is queued", () => {
    expect(checkApplied(" 1.5 ")).toEqual({ ok: true, quantity: "1.5" });
    expect(checkApplied("0")).toMatchObject({ ok: false });
    expect(checkApplied("two")).toMatchObject({ ok: false, problem: expect.stringMatching(/as a number/) });
    expect(checkApplied("2000000")).toMatchObject({ ok: false, problem: expect.stringMatching(/more than one visit/) });
  });
});

describe("the answer sent", () => {
  it("names the item, with the book's name, EPA number and unit for the screen", () => {
    const [advion, bifen] = chemicalsIn(BOOK);
    expect(applicationFromBook({ key: "product_applied", label: "Product applied" }, bifen!, "2")).toEqual({
      field: "product_applied", label: "Product applied", kind: "chemical", value: "Bifen IT",
      priceBookItemId: "a", productName: "Bifen IT", epaRegistrationNumber: "279-3206", quantityApplied: "2", applicationUnit: "gal",
    });
    expect(applicationFromBook({ key: "product_applied", label: "Product applied" }, advion!, "4")).not.toHaveProperty("epaRegistrationNumber");
  });
});
