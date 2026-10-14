import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as orderEmail from "../src/services/purchase-order-email";
import * as catalogue from "../src/services/vendor-catalogue";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A PART SOLD BY THE BOX UNDER A DIFFERENT PART NUMBER, THROUGH A REAL DATABASE
 *
 * A supply house that numbers the box apart from the each: wire nuts are WN-EA
 * by the each and WN-BX by the box of 25. One item and one link, with a number
 * on each pack. This proves what rows add: that the box's number is the
 * vendor's alone (no other link of theirs may use it, in either place, even
 * when two writers race), that typing it on an order means the box, that the
 * order, its email and its PDF carry the number of the pack the line became,
 * and that the catalogue import finds a link by it and can give it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("vn:org");
const OWNER = fixtureId("vn:owner");

let raw: postgres.Sql;
let wireNut = "";
let cap = "";
let strap = "";
let shop = "";
let ferguson = "";
let johnstone = "";

const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});

async function item(code: string, name: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'material', ${code}) returning id`;
  await raw`
    insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, effective_from)
    values (${ORG}, ${row!.id}, 1, ${name}, '2.00', '0.40', now() - interval '1 day')`;
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Box Numbers Co", slug: "vendor-pack-numbers-co" });
  wireNut = await item("WN", "Wire nut");
  cap = await item("CAP", "Capacitor");
  strap = await item("STRAP", "Strap");
  [{ id: shop }] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, is_warehouse, address_line1, city, state)
    values (${ORG}, 'Shop', true, '9 Yard Rd', 'Austin', 'TX') returning id` as unknown as [{ id: string }];
  ferguson = (await inventory.createVendor(owner(), { name: "Ferguson", email: "orders@ferguson.test" })).id;
  johnstone = (await inventory.createVendor(owner(), { name: "Johnstone" })).id;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@boxnumbers.test" })})`;
});

afterAll(async () => { if (raw) await raw.end(); });

const eachAndBox = (number: string | null | undefined = "WN-BX") => catalogue.setLink(owner(), {
  vendorId: ferguson, itemId: wireNut, partNumber: "WN-EA", cost: "0.50", packQuantity: "1",
  secondPack: { packQuantity: "25", purchaseUnit: "box", cost: "10.00", partNumber: number },
});

run("a second pack with a number of its own", () => {
  it("keeps the box's number on the link, and says so in both views of it", async () => {
    const link = await eachAndBox();
    expect(link.secondPack).toMatchObject({ partNumber: "WN-BX", packQuantity: "25.0000", purchaseUnit: "box" });
    // Cheaper per piece first, each carrying the number it is ordered by.
    expect(link.packs.map((p) => [p.packQuantity, p.partNumber])).toEqual([["25.0000", "WN-BX"], ["1.0000", "WN-EA"]]);
    // Left out keeps what is on record; a pack stated again without one has none.
    const kept = await catalogue.setLink(owner(), { vendorId: ferguson, itemId: wireNut, partNumber: "WN-EA", cost: "0.55" });
    expect(kept.secondPack!.partNumber).toBe("WN-BX");
    const same = await eachAndBox("wn-ea");
    expect(same.secondPack!.partNumber).toBeNull();
    expect((await eachAndBox("")).secondPack!.partNumber).toBeNull();
    await eachAndBox();
  });

  it("is this vendor's alone: no other link of theirs may use it as either number, and another vendor may", async () => {
    await expect(catalogue.setLink(owner(), { vendorId: ferguson, itemId: cap, partNumber: "WN-BX" }))
      .rejects.toThrow(/WN-BX is already this vendor's number for another of your items/);
    await expect(catalogue.setLink(owner(), { vendorId: ferguson, itemId: cap, partNumber: "CAP-1", cost: "5", secondPack: { packQuantity: "10", partNumber: "wn-ea" } }))
      .rejects.toThrow(/WN-EA is already this vendor's number|wn-ea is already this vendor's number/i);
    await catalogue.setLink(owner(), { vendorId: ferguson, itemId: cap, partNumber: "CAP-1", cost: "5", secondPack: { packQuantity: "10", partNumber: "CAP-10" } });
    await expect(catalogue.setLink(owner(), { vendorId: ferguson, itemId: strap, partNumber: "S-1", secondPack: { packQuantity: "5", partNumber: "CAP-10" } }))
      .rejects.toThrow(/CAP-10 is already this vendor's number/);
    // Johnstone numbers things its own way.
    await catalogue.setLink(owner(), { vendorId: johnstone, itemId: strap, partNumber: "WN-BX" });
    // A first number cannot take over a number the same link has for its box.
    await expect(catalogue.setLink(owner(), { vendorId: ferguson, itemId: wireNut, partNumber: "WN-BX" }))
      .rejects.toThrow(/also the number this vendor has for the second way/);
  });

  it("is held by the database too, so two writers cannot both take it", async () => {
    // A number against another link's first number, in either direction, goes through the trigger.
    await expect(raw`update public.vendor_item set second_part_number = 'CAP-1' where vendor_id = ${ferguson} and item_id = ${wireNut}`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "vendor_item_part_number_idx" });
    await expect(raw`update public.vendor_item set part_number = 'WN-BX' where vendor_id = ${ferguson} and item_id = ${cap}`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "vendor_item_part_number_idx" });
    // Two boxes with one number is the unique index.
    await expect(raw`update public.vendor_item set second_part_number = 'WN-BX' where vendor_id = ${ferguson} and item_id = ${cap}`)
      .rejects.toMatchObject({ code: "23505" });
    // A number needs a pack, and cannot be the first's.
    await expect(raw`update public.vendor_item set second_pack_quantity = null where vendor_id = ${ferguson} and item_id = ${wireNut}`)
      .rejects.toMatchObject({ code: "23514" });
    await expect(raw`update public.vendor_item set second_part_number = 'wn-ea' where vendor_id = ${ferguson} and item_id = ${wireNut}`)
      .rejects.toMatchObject({ code: "23514" });
  });

  it("goes with the pack when the pack is taken away", async () => {
    await catalogue.setLink(owner(), { vendorId: ferguson, itemId: cap, partNumber: "CAP-1", secondPack: null });
    const [row] = await raw<{ second_part_number: string | null }[]>`
      select second_part_number from public.vendor_item where vendor_id = ${ferguson} and item_id = ${cap}`;
    expect(row!.second_part_number).toBeNull();
  });
});

run("ordering by either number", () => {
  const order = (lines: Parameters<typeof inventory.createPurchaseOrder>[1]["lines"]) =>
    inventory.createPurchaseOrder(owner(), { vendorId: ferguson, defaultLocationId: shop, lines });

  it("takes the box's number to mean the box, and sends the order with it", async () => {
    const made = await order([{ partNumber: "WN-BX", quantity: "250" }]);
    const detail = await inventory.purchaseOrder(owner(), { id: made.id });
    expect(detail.lines[0]).toMatchObject({
      vendorPartNumber: "WN-BX", quantityOrdered: "250.0000", packs: { count: "10", size: "25", unit: "box", price: "10.0000" },
    });
    const sent = await orderEmail.emailOrder(owner(), { id: made.id });
    expect(sent.state).toBe("queued");
    const [mail] = await raw<{ body: string }[]>`
      select body from public.message where organization_id = ${ORG} and to_address = 'orders@ferguson.test' order by created_at desc limit 1`;
    expect(mail!.body).toContain("10 box of 25 x WN-BX");
  });

  it("refuses a quantity that is not whole boxes, and a way that contradicts the number", async () => {
    await expect(order([{ partNumber: "WN-BX", quantity: "30" }])).rejects.toThrow(/Order 25 or 50 by the box of 25, not 30/);
    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: shop, lines: [{ partNumber: "WN-BX", quantity: "30", packQuantity: "1" }],
    })).rejects.toThrow(/WN-BX is this vendor's number for the pack of 25, not the pack of 1/);
  });

  it("sends the each's number for the each and the box's for the box when the quantity decides", async () => {
    const each = await order([{ partNumber: "WN-EA", quantity: "30" }]);
    expect((await inventory.purchaseOrder(owner(), { id: each.id })).lines[0]).toMatchObject({ vendorPartNumber: "WN-EA" });
    // Fifty is two boxes, cheaper per nut, so the line becomes the box and carries the box's number.
    const fifty = await order([{ partNumber: "WN-EA", quantity: "50" }]);
    expect((await inventory.purchaseOrder(owner(), { id: fifty.id })).lines[0]).toMatchObject({
      vendorPartNumber: "WN-BX", packs: { count: "2", size: "25" },
    });
    // By our item the same, and our own item's code finds the link.
    const byItem = await order([{ itemId: wireNut, quantity: "25" }]);
    expect((await inventory.purchaseOrder(owner(), { id: byItem.id })).lines[0]).toMatchObject({ vendorPartNumber: "WN-BX" });
    // Naming the item and the box's number agree.
    const both = await order([{ itemId: wireNut, partNumber: "WN-BX", quantity: "25" }]);
    expect((await inventory.purchaseOrder(owner(), { id: both.id })).lines[0]).toMatchObject({ vendorPartNumber: "WN-BX" });
    await expect(order([{ itemId: wireNut, partNumber: "NOPE", quantity: "25" }]))
      .rejects.toThrow(/they call it WN-EA, or WN-BX for the box of 25/);
  });

  it("edits a draft the same way", async () => {
    const draft = await order([{ partNumber: "WN-EA", quantity: "5" }]);
    await inventory.editPurchaseOrder(owner(), { id: draft.id, lines: [{ partNumber: "WN-BX", quantity: "75" }] });
    expect((await inventory.purchaseOrder(owner(), { id: draft.id })).lines[0]).toMatchObject({ vendorPartNumber: "WN-BX", packs: { count: "3" } });
  });
});

run("the catalogue import and the pack's number", () => {
  it("finds a link by its box's number, and re-prices the box", async () => {
    const csv = "Part #,Description,Net Price,Vendor,Pack Qty\nWN-BX,Wire nut box,11.00,Ferguson,25\n";
    const preview = await catalogue.preview(owner(), { csv });
    expect(preview.rows[0]).toMatchObject({ action: "pack", slot: "second", itemId: wireNut, packSku: "WN-BX", packSkuBefore: "WN-BX", cost: "11.0000" });
    const applied = await catalogue.apply(owner(), { csv });
    expect(applied.updated).toBe(1);
    const [link] = await catalogue.links(owner(), { itemId: wireNut, vendorId: ferguson });
    expect(link).toMatchObject({ partNumber: "WN-EA", cost: "0.5000" });
    expect(link!.secondPack).toMatchObject({ partNumber: "WN-BX", cost: "11.0000" });
  });

  it("gives a box its own number from a file, and renumbers it, refusing a number that is another's", async () => {
    // A link that sells only by the each, then a file that gives the box.
    await catalogue.setLink(owner(), { vendorId: ferguson, itemId: strap, partNumber: "STR-EA", cost: "0.20", packQuantity: "1" });
    const csv = [
      "Part #,Description,Net Price,Vendor,Pack Qty,UOM,Pack Part Number",
      "STR-EA,Strap,0.20,Ferguson,1,,",
      "STR-EA,Strap,18.00,Ferguson,100,bag,STR-BG",
    ].join("\n");
    const applied = await catalogue.apply(owner(), { csv });
    expect(applied.counts.skip).toBe(0);
    const [link] = await catalogue.links(owner(), { itemId: strap, vendorId: ferguson });
    expect(link!.secondPack).toMatchObject({ partNumber: "STR-BG", packQuantity: "100.0000", purchaseUnit: "bag" });
    expect(link!.packs[0]).toMatchObject({ partNumber: "STR-BG" });

    const renumbered = await catalogue.apply(owner(), {
      csv: ["Part #,Description,Net Price,Vendor,Pack Qty,Pack Part Number", "STR-EA,Strap,0.20,Ferguson,1,", "STR-EA,Strap,18.00,Ferguson,100,STR-BAG"].join("\n"),
    });
    expect(renumbered.rows[1]).toMatchObject({ action: "pack", packSku: "STR-BAG", packSkuBefore: "STR-BG" });
    expect((await catalogue.links(owner(), { itemId: strap, vendorId: ferguson }))[0]!.secondPack!.partNumber).toBe("STR-BAG");

    // A number that is another link's is skipped in the preview, in words.
    const taken = await catalogue.preview(owner(), {
      csv: ["Part #,Description,Net Price,Vendor,Pack Qty,Pack Part Number", "STR-EA,Strap,0.20,Ferguson,1,", "STR-EA,Strap,18.00,Ferguson,100,WN-BX"].join("\n"),
    });
    expect(taken.rows[1]).toMatchObject({ action: "skip", reason: expect.stringContaining("WN-BX is already Ferguson's number for another of your items") });
  });
});
