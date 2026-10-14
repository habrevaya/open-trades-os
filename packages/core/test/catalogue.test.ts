import { describe, it, expect } from "vitest";
import {
  parseCatalogue, planCatalogue, splitRecords, parseCost, MAX_ROWS, cheaperFirst, choosePack,
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

describe("vendors the file names that are not set up yet", () => {
  it("are added only when the person importing ticks it, once each, under the first spelling", () => {
    const rows = [row("FLT-16", "5.00", "Acme Supply", "F", 2), row("NEW-9", "2.00", "ACME SUPPLY", "Fuse 5A", 3)];
    const off = planCatalogue(rows, STATE, { updateItemCost: false, margin: "0.5" });
    expect(off.rows.every((r) => r.action === "skip")).toBe(true);
    expect((off.rows[0] as { reason: string }).reason).toMatch(/tick that the import may add/);
    expect(off.newVendors).toEqual([]);

    const on = planCatalogue(rows, STATE, { updateItemCost: false, margin: "0.5", createVendors: true });
    expect(on.newVendors).toEqual([{ name: "Acme Supply", line: 2 }]);
    expect(on.rows[0]).toMatchObject({ action: "link", vendorId: null, vendorName: "Acme Supply", newVendor: true, itemId: "i2" });
    expect(on.rows[1]).toMatchObject({ action: "create", vendorId: null, vendorName: "Acme Supply", newVendor: true });
  });

  it("match a vendor already set up without capitals, and are not added when every row of theirs is skipped", () => {
    const plan = planCatalogue([row("C455R", "12", "FERGUSON", "Cap", 2), row("NEW-3", "2.00", "Nobody Supply", "", 3)],
      STATE, { updateItemCost: false, margin: "0.5", createVendors: true });
    expect(plan.rows[0]).toMatchObject({ action: "update", vendorId: "v1", newVendor: false });
    expect(plan.rows[1]).toMatchObject({ action: "skip" });
    expect(plan.newVendors).toEqual([]);
  });
});

describe("a part bought two ways from one vendor", () => {
  const packed = (sku: string, cost: string, pack: string, unit: string, line: number, vendor = "Ferguson") =>
    ({ line, sku, description: "Wire nut", cost, vendor, pack, unit });

  it("keeps the second row with another pack as the link's second way to buy it", () => {
    const plan = planCatalogue([packed("C455R", "0.55", "1", "", 2), packed("C455R", "10.00", "25", "box", 3)],
      STATE, { updateItemCost: false });
    expect(plan.rows[0]).toMatchObject({ action: "update", slot: "first", pack: "1.0000" });
    expect(plan.rows[1]).toMatchObject({
      action: "pack", slot: "second", pairsWith: 2, itemId: "i1", pack: "25.0000", unit: "box", eachCost: "0.4000", cost: "10.0000",
    });
    // A second pack is a change to the link, and counted with the updates.
    expect(plan.counts).toMatchObject({ update: 2, skip: 0 });
  });

  it("refuses a third pack and the same pack twice, and pairs a new part's box with the line that makes it", () => {
    const three = planCatalogue([packed("C455R", "0.55", "1", "", 2), packed("C455R", "10.00", "25", "box", 3),
      packed("C455R", "38.00", "100", "case", 4), packed("NEW-5", "0.50", "1", "", 5), packed("NEW-5", "0.60", "1", "", 6),
      packed("NEW-5", "9.00", "25", "box", 7)], STATE, { updateItemCost: false, margin: "0.5" });
    expect((three.rows[2] as { reason: string }).reason).toMatch(/already bought two ways/);
    expect((three.rows[4] as { reason: string }).reason).toMatch(/already on line 5/);
    expect(three.rows[5]).toMatchObject({ action: "pack", pairsWith: 5, itemId: null, itemCode: "NEW-5" });
  });

  it("states the pack a link already holds, whichever line of the file it is on, and leaves the other alone", () => {
    const state: CatalogueState = {
      ...STATE,
      links: [{ ...STATE.links[0]!, packQuantity: "1", second: { packQuantity: "25", purchaseUnit: "box", cost: "10.00", priceBreaks: [] } }],
    };
    const box = planCatalogue([packed("C455R", "9.50", "25", "box", 2)], state, { updateItemCost: true });
    expect(box.rows[0]).toMatchObject({ action: "pack", slot: "second", pairsWith: null, costBefore: "10.00", packBefore: "25" });
    const same = planCatalogue([packed("C455R", "10.00", "25", "box", 2)], state, { updateItemCost: true });
    expect(same.rows[0]).toMatchObject({ action: "unchanged", slot: "second" });
  });

  it("skips the second way when the line it goes with was skipped", () => {
    const plan = planCatalogue([packed("NEW-6", "0.50", "1", "", 2), packed("NEW-6", "9.00", "25", "box", 3)],
      STATE, { updateItemCost: false });
    expect((plan.rows[1] as { reason: string }).reason).toMatch(/Line 2 for the same part was skipped/);
  });
});

describe("choosing between two ways to buy a part", () => {
  const each = { quantity: "1", unit: null, cost: "0.55", breaks: [] };
  const box = { quantity: "25", unit: "box", cost: "10.00", breaks: [{ minimum: "4", cost: "9.00" }] };

  it("offers the cheaper per one of ours first", () => {
    expect(cheaperFirst([each, box])).toEqual([box, each]);
    expect(cheaperFirst([{ ...box, cost: null }, each])).toEqual([each, { ...box, cost: null }]);
  });

  it("takes the cheaper way the quantity is whole packs of, at the break it reaches", () => {
    expect(choosePack([each, box], "50")).toEqual({ ok: true, pack: box, packs: "2" });
    expect(choosePack([each, box], "30")).toEqual({ ok: true, pack: each, packs: "30" });
    // A box dearer per nut than the each until the break: 3 boxes at 25 each is 1.00 a nut against 0.55...
    const dear = { ...box, cost: "25.00", breaks: [{ minimum: "4", cost: "12.50" }] };
    expect(choosePack([each, dear], "75")).toMatchObject({ ok: true, pack: each });
    // ...and four boxes reach the break at 0.50 a nut.
    expect(choosePack([each, dear], "100")).toMatchObject({ ok: true, pack: dear, packs: "4" });
  });

  it("takes the way named, and says what would go when it does not fit", () => {
    expect(choosePack([each, box], "50", "1")).toEqual({ ok: true, pack: each, packs: "50" });
    const refused = choosePack([each, box], "30", "25");
    expect(refused).toEqual({ ok: false, reason: "Order 25 or 50 by the box of 25, not 30." });
    expect(choosePack([each, box], "30", "10")).toMatchObject({ ok: false, reason: expect.stringContaining("do not sell it in packs of 10") });
  });
});
