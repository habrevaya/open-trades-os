import { describe, it, expect } from "vitest";
import {
  parseCatalogue, planCatalogue, splitRecords, parseCost, MAX_ROWS,
  type CatalogueState,
} from "../src/catalogue/index.js";

/**
 * A SUPPLIER'S CATALOGUE
 *
 * The file a supply house sends is not clean: quoted descriptions full of
 * commas, a dollar sign on the cost, a totals row at the bottom, headers in
 * whatever case their system writes. Every one of those is a row imported
 * under the wrong column or at the wrong cost if the reading is careless, and
 * a cost imported wrong is a margin report that lies quietly from then on.
 */

describe("reading the file", () => {
  it("keeps a quoted description with commas and a line break in one cell", () => {
    const records = splitRecords('sku,description,cost\nC455R,"Capacitor, dual run\n45/5 MFD",$12.50\n');
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual({ line: 2, cells: ["C455R", "Capacitor, dual run\n45/5 MFD", "$12.50"] });
  });

  it("reads the supply houses' spellings of the headers", () => {
    const parsed = parseCatalogue("Part #,Item Description,Net Price,Supplier\nC455R,Capacitor,12.5,Ferguson\n");
    expect(parsed.rows).toEqual([{ line: 2, sku: "C455R", description: "Capacitor", cost: "12.5", vendor: "Ferguson" }]);
    expect(parsed.hasVendorColumn).toBe(true);
  });

  it("refuses a file with no part number or cost column, saying which", () => {
    const parsed = parseCatalogue("name,price\nCapacitor,12\n");
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems[0]!.message).toMatch(/no sku column/);
  });

  it("skips a row it cannot read with the reason, and imports the rest", () => {
    const parsed = parseCatalogue([
      "sku,description,cost",
      "A1,Filter,8.00",
      "A2,Coil,call for price",
      ",Total,1200.00",
      "A3,Valve,\"1,204.50\"",
    ].join("\n"));
    expect(parsed.rows.map((r) => [r.sku, r.cost])).toEqual([["A1", "8.00"], ["A3", "1204.50"]]);
    expect(parsed.problems.map((p) => p.line)).toEqual([3, 4]);
    expect(parsed.problems[0]!.message).toMatch(/not an amount/);
  });

  it("never reads an ambiguous or negative amount as a number", () => {
    expect(parseCost("$1,204.50")).toBe("1204.50");
    expect(parseCost("1.234,56")).toBeNull();
    expect(parseCost("-4.00")).toBeNull();
    expect(parseCost("")).toBeNull();
  });

  it("refuses a file larger than one import", () => {
    const body = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `P${i},Part,1`).join("\n");
    expect(parseCatalogue(`sku,description,cost\n${body}`).problems[0]!.message).toMatch(/at most/);
  });
});

const STATE: CatalogueState = {
  vendors: [{ id: "v1", name: "Ferguson" }, { id: "v2", name: "Johnstone" }],
  links: [{ vendorId: "v1", itemId: "i1", partNumber: "C455R", cost: "11.00", description: "Cap 45/5" }],
  items: [
    { id: "i1", code: "CAP-45-5", name: "Capacitor 45/5", cost: "11.00" },
    { id: "i2", code: "FLT-16", name: "Filter 16x25", cost: "6.00" },
  ],
};

const row = (sku: string, cost: string, vendor = "Ferguson", description = "A part", line = 2) =>
  ({ line, sku, description, cost, vendor });

describe("deciding what each row does", () => {
  it("updates the link the vendor's number already names", () => {
    const plan = planCatalogue([row("c455r", "12.50", "ferguson", "Cap 45/5")], STATE, { updateItemCost: true });
    expect(plan.rows[0]).toMatchObject({
      action: "update", itemId: "i1", costBefore: "11.00", cost: "12.5000",
      itemCostBefore: "11.00", itemCostAfter: "12.5000",
    });
  });

  it("says a row that changes nothing is unchanged, rather than writing it again", () => {
    const plan = planCatalogue([row("C455R", "11", "Ferguson", "Cap 45/5")], STATE, { updateItemCost: true });
    expect(plan.rows[0]!.action).toBe("unchanged");
  });

  it("holds the item's cost back when a price change is already scheduled for it", () => {
    const held = planCatalogue([row("C455R", "12.50")], {
      ...STATE, items: STATE.items.map((i) => (i.id === "i1" ? { ...i, scheduled: true } : i)),
    }, { updateItemCost: true });
    expect(held.rows[0]).toMatchObject({ action: "update", itemCostAfter: null, costHeldBack: true });
  });

  it("leaves the item's own cost alone unless asked", () => {
    const plan = planCatalogue([row("C455R", "12.50")], STATE, { updateItemCost: false });
    expect(plan.rows[0]).toMatchObject({ action: "update", itemCostAfter: null });
  });

  it("links one of our items whose code is the part number", () => {
    const plan = planCatalogue([row("flt-16", "5.25", "Johnstone")], STATE, { updateItemCost: false });
    expect(plan.rows[0]).toMatchObject({ action: "link", itemId: "i2", vendorId: "v2", cost: "5.2500" });
  });

  it("renumbers a link when the supplier changed its number for an item already linked", () => {
    const plan = planCatalogue([row("CAP-45-5", "11.00", "Ferguson", "Cap 45/5")], STATE, { updateItemCost: false });
    expect(plan.rows[0]).toMatchObject({ action: "update", itemId: "i1", partNumberBefore: "C455R" });
  });

  it("creates a new item priced at the margin asked for, and refuses to without one", () => {
    const priced = planCatalogue([row("NEW-1", "60.00", "Ferguson", "Contactor 40A")], STATE,
      { updateItemCost: false, margin: "0.4" });
    expect(priced.rows[0]).toMatchObject({ action: "create", code: "NEW-1", name: "Contactor 40A", price: "100.0000" });

    const unpriced = planCatalogue([row("NEW-1", "60.00")], STATE, { updateItemCost: false });
    expect(unpriced.rows[0]).toMatchObject({ action: "skip" });
    expect((unpriced.rows[0] as { reason: string }).reason).toMatch(/margin/);
  });

  it("names a vendor nobody has added rather than inventing one", () => {
    const plan = planCatalogue([row("X", "1.00", "Acme Supply")], STATE, { updateItemCost: false, margin: "0.5" });
    expect((plan.rows[0] as { reason: string }).reason).toMatch(/no vendor called "Acme Supply"/);
  });

  it("takes the vendor chosen for the file when the rows do not name one", () => {
    const plan = planCatalogue([row("FLT-16", "5.00", "")], STATE, { updateItemCost: false, defaultVendorId: "v2" });
    expect(plan.rows[0]).toMatchObject({ action: "link", vendorId: "v2" });
  });

  it("refuses the second of two lines for one part and vendor, naming the first", () => {
    const plan = planCatalogue([row("FLT-16", "5.00", "Johnstone", "F", 2), row("flt-16", "5.10", "Johnstone", "F", 3)],
      STATE, { updateItemCost: false });
    expect(plan.counts).toMatchObject({ link: 1, skip: 1 });
    expect((plan.rows[1] as { reason: string }).reason).toMatch(/line 2/);
  });

  it("refuses two different numbers claiming one item for one vendor", () => {
    const plan = planCatalogue([row("C455R", "12", "Ferguson", "Cap", 2), row("CAP-45-5", "12", "Ferguson", "Cap", 3)],
      STATE, { updateItemCost: false });
    expect(plan.rows[1]).toMatchObject({ action: "skip" });
  });

  it("does not create a new item without a description to name it", () => {
    const plan = planCatalogue([row("NEW-2", "5.00", "Ferguson", "")], STATE, { updateItemCost: false, margin: "0.5" });
    expect((plan.rows[0] as { reason: string }).reason).toMatch(/no description/);
  });
});
