import { describe, it, expect } from "vitest";
import { parseCatalogue, planCatalogue, cheaperFirst, choosePack, type CatalogueState } from "../src/catalogue/index.js";

/**
 * A PACK WITH ITS OWN VENDOR PART NUMBER, IN THE CATALOGUE IMPORT
 *
 * A supply house that numbers the box differently from the each: wire nuts are
 * WN-25 by the each and WN-25-BX by the box of 25. One item, one link, two
 * numbers, and the number has to follow the pack onto the purchase order.
 */

const EACH_AND_BOX: CatalogueState["links"][number] = {
  vendorId: "v1", itemId: "i1", partNumber: "WN-25", cost: "0.50", description: "Wire nut", packQuantity: "1",
  second: { partNumber: "WN-25-BX", packQuantity: "25", purchaseUnit: "box", cost: "10.00", priceBreaks: [] },
};
const STATE: CatalogueState = {
  vendors: [{ id: "v1", name: "Ferguson" }, { id: "v2", name: "Johnstone" }],
  links: [
    EACH_AND_BOX,
    { vendorId: "v1", itemId: "i2", partNumber: "FLT-16", cost: "6.00", description: "Filter", packQuantity: "1" },
  ],
  items: [
    { id: "i1", code: "WN", name: "Wire nut", cost: "0.50" },
    { id: "i2", code: "FLT", name: "Filter", cost: "6.00" },
  ],
};
const options = { updateItemCost: false, defaultVendorId: "v1" };
const plan = (csv: string, state = STATE) => planCatalogue(parseCatalogue(csv).rows, state, options);

describe("reading the pack's own number", () => {
  it("reads the spellings of the column, and only when the cell has something in it", () => {
    const parsed = parseCatalogue("SKU,Description,Cost,Pack Qty,Box Part Number\nWN-25,Wire nut,0.50,1,\nWN-25,Wire nut,10.00,25,WN-25-BX\n");
    expect(parsed.rows.map((r) => r.packSku)).toEqual([undefined, "WN-25-BX"]);
    expect(parseCatalogue("sku,cost,pack,second sku\nA,1,2,A-2\n").rows[0]!.packSku).toBe("A-2");
  });
});

describe("a pack's number in the plan", () => {
  it("makes the box the link's second pack under its own number, beside the each", () => {
    const state: CatalogueState = { ...STATE, links: [STATE.links[1]!] };
    const out = plan("sku,description,cost,pack,unit,pack part number\nNEW-EA,Zip tie,0.10,1,,\nNEW-EA,Zip tie,8.00,100,bag,NEW-BG\n", state);
    // Neither is in the price book, and with no margin both are skipped; give the each as a known link instead.
    expect(out.rows[0]).toMatchObject({ action: "skip" });
    const linked = plan("sku,description,cost,pack,unit,pack part number\nFLT-16,Filter,6.00,1,,\nFLT-16,Filter,60.00,12,case,FLT-16-CS\n");
    expect(linked.rows[1]).toMatchObject({
      action: "pack", slot: "second", itemId: "i2", pack: "12.0000", unit: "case", packSku: "FLT-16-CS", packSkuBefore: null,
    });
    expect(linked.rows[0]).toMatchObject({ action: "unchanged", slot: "first", packSku: null });
  });

  it("finds the link by the number it holds for its second pack and states that pack", () => {
    const out = plan("sku,description,cost,pack\nWN-25-BX,Wire nut box,11.00,25\n");
    expect(out.rows[0]).toMatchObject({
      action: "pack", slot: "second", itemId: "i1", cost: "11.0000", packSku: "WN-25-BX", packSkuBefore: "WN-25-BX", costBefore: "10.00",
    });
    // With no pack column the number is enough to say which pack.
    expect(plan("sku,description,cost\nWN-25-BX,Wire nut box,11.00\n").rows[0]).toMatchObject({ action: "pack", slot: "second", pack: "25.0000" });
    // Already exactly this.
    expect(plan("sku,description,cost,pack\nWN-25-BX,Wire nut box,10.00,25\n").rows[0]).toMatchObject({ action: "unchanged", slot: "second" });
  });

  it("refuses a number for the wrong pack, and two numbers for one pack", () => {
    expect(plan("sku,description,cost,pack\nWN-25-BX,Wire nut box,11.00,50\n").rows[0])
      .toMatchObject({ action: "skip", reason: expect.stringContaining("is Ferguson's number for the pack of 25, but the file says packs of 50") });
    expect(plan("sku,description,cost,pack,pack part number\nWN-25-BX,Box,10.00,25,OTHER\n").rows[0])
      .toMatchObject({ action: "skip", reason: expect.stringContaining("cannot give it another number") });
  });

  it("renumbers a box the supplier renumbered", () => {
    const out = plan("sku,description,cost,pack,pack part number\nWN-25,Wire nut,0.50,1,\nWN-25,Wire nut,10.00,25,WN-25-BOX\n");
    expect(out.rows[1]).toMatchObject({ action: "pack", slot: "second", packSku: "WN-25-BOX", packSkuBefore: "WN-25-BX" });
  });

  it("keeps the number the box has when a file that does not give numbers re-prices it", () => {
    const out = plan("sku,description,cost,pack\nWN-25,Wire nut,0.50,1\nWN-25,Wire nut,12.00,25\n");
    expect(out.rows[1]).toMatchObject({ action: "pack", slot: "second", packSku: "WN-25-BX", cost: "12.0000" });
  });

  it("refuses a number that is another item's, in either place, or another line's", () => {
    const first = plan("sku,description,cost,pack,pack part number\nFLT-16,Filter,6.00,1,\nFLT-16,Filter,60.00,12,WN-25\n");
    expect(first.rows[1]).toMatchObject({ action: "skip", reason: expect.stringContaining("WN-25 is already Ferguson's number for another of your items") });
    const second = plan("sku,description,cost,pack,pack part number\nFLT-16,Filter,6.00,1,\nFLT-16,Filter,60.00,12,WN-25-BX\n");
    expect(second.rows[1]).toMatchObject({ action: "skip", reason: expect.stringContaining("already Ferguson's number for another of your items") });
    // Another vendor's number is no matter.
    const other = planCatalogue(parseCatalogue("sku,description,cost,pack,pack part number,vendor\nFLT-16,Filter,60.00,12,WN-25-BX,Johnstone\n").rows,
      { ...STATE, links: [...STATE.links, { vendorId: "v2", itemId: "i2", partNumber: "FLT-16", cost: "6.00", description: null, packQuantity: "1" }] }, options);
    expect(other.rows[0]).toMatchObject({ action: "pack" });
  });

  it("refuses a number for the same pack as the first, and a number with no pack to say which", () => {
    expect(plan("sku,description,cost,pack,pack part number\nFLT-16,Filter,6.00,1,\nFLT-16,Filter,6.00,1,FLT-X\n").rows[1])
      .toMatchObject({ action: "skip" });
    expect(plan("sku,description,cost,pack part number\nFLT-16,Filter,60.00,FLT-16-CS\n").rows[0])
      .toMatchObject({ action: "skip", reason: expect.stringContaining("no pack size to say which pack") });
  });

  it("keeps a later row off a number an earlier row of the file gave a pack", () => {
    const out = plan("sku,description,cost,pack,pack part number\nFLT-16,Filter,6.00,1,\nFLT-16,Filter,60.00,12,FLT-16-CS\nFLT-16-CS,Another,1.00,\n");
    expect(out.rows[2]).toMatchObject({ action: "skip" });
  });
});

describe("a pack carries its number through the choice of pack", () => {
  it("returns the pack chosen with its own number", () => {
    const packs = [
      { quantity: "1", unit: null, cost: "0.50", breaks: [], partNumber: null },
      { quantity: "25", unit: "box", cost: "10.00", breaks: [], partNumber: "WN-25-BX" },
    ];
    const fifty = choosePack(packs, "50");
    expect(fifty).toMatchObject({ ok: true, pack: { partNumber: "WN-25-BX" } });
    expect(choosePack(packs, "30")).toMatchObject({ ok: true, pack: { partNumber: null } });
    expect(choosePack(packs, "30", "25")).toMatchObject({ ok: false });
    expect(cheaperFirst(packs).map((p) => p.partNumber)).toEqual(["WN-25-BX", null]);
  });
});
