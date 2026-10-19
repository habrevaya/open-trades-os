import { describe, expect, it } from "vitest";
import { reporting } from "../src/index";

/**
 * Pest control's chemical cost per stop: each product applied, chosen from the
 * price book, at its cost per unit on the stop's day, over completed stops. A
 * stop with a product that cannot be valued so is left out of both halves.
 */
const book = (quantity: number | null, costPerUnit: number | null, unit = "gal", itemUnit: string | null = "gal") => ({
  quantity, unit, itemId: "item", itemUnit, costPerUnit,
});
const typed = (quantity: number) => ({ quantity, unit: "gal", itemId: null, itemUnit: null, costPerUnit: null });

describe("a stop's chemical cost", () => {
  it("is each product's quantity at its cost per unit", () => {
    expect(reporting.chemicalCostOf([book(2, 3.1), book(0.5, 40)])).toEqual({ counted: true, cost: 26.2 });
  });

  it("is nothing on a stop where nothing was applied, which still counts", () => {
    expect(reporting.chemicalCostOf([])).toEqual({ counted: true, cost: 0 });
  });

  it("passes over an answer that says no amount", () => {
    expect(reporting.chemicalCostOf([book(null, null), book(1, 5)])).toEqual({ counted: true, cost: 5 });
  });

  it("leaves the stop out when a product was typed by name, never valuing the name", () => {
    expect(reporting.chemicalCostOf([book(1, 5), typed(1)])).toEqual({ counted: false });
  });

  it("leaves the stop out when the item had no cost that day, or its cost is per another unit now", () => {
    expect(reporting.chemicalCostOf([book(1, null)])).toEqual({ counted: false });
    expect(reporting.chemicalCostOf([book(1, 5, "gal", "oz")])).toEqual({ counted: false });
    expect(reporting.chemicalCostOf([book(1, 5, "gal", null)])).toEqual({ counted: false });
  });
});

describe("the company's chemical cost per stop", () => {
  it("adds the stops counted and counts the rest beside", () => {
    expect(reporting.chemicalCostPerStop([[book(2, 3)], [], [typed(1)], [book(1, 4)]]))
      .toEqual({ cost: 10, stops: 3, notValued: 1 });
  });
});

describe("a product bought by the gallon and applied by the ounce", () => {
  const gallon = { buy: "gal", use: "oz", usePerBuy: 128 };
  const applied = (quantity: number, unit: string, units: typeof gallon | null = gallon) => ({
    quantity, unit, itemId: "item", itemUnit: "oz", costPerUnit: 40, units,
  });

  it("values an application in the buy unit at the cost, and in the use unit at the cost over the ratio", () => {
    expect(reporting.chemicalCostOf([applied(1, "gal")])).toEqual({ counted: true, cost: 40 });
    expect(reporting.chemicalCostOf([applied(16, "oz")])).toEqual({ counted: true, cost: 5 });
    expect(reporting.chemicalCostOf([applied(16, "OZ "), applied(0.5, "gal")])).toEqual({ counted: true, cost: 25 });
  });

  it("leaves the stop out for a third unit, and values a version with no units exactly as before", () => {
    expect(reporting.chemicalCostOf([applied(1, "quart")])).toEqual({ counted: false });
    expect(reporting.chemicalCostOf([applied(2, "oz", null)])).toEqual({ counted: true, cost: 80 });
    expect(reporting.chemicalCostOf([applied(2, "gal", null)])).toEqual({ counted: false });
  });
});
