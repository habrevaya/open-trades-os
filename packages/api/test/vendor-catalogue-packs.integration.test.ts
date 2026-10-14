import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as vendorCatalogue from "../src/services/vendor-catalogue";
import * as inventory from "../src/services/inventory";
import * as priceBook from "../src/services/pricebook";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M16. A CATALOGUE THAT NAMES NEW VENDORS, AND A PART BOUGHT TWO WAYS
 *
 * A catalogue import adds the vendors its file names only when the person
 * importing ticks that it may, and a supplier selling wire nuts by the each
 * and by the box of 25 is one link with both packs on it. A purchase order
 * takes the cheaper per nut that the quantity is whole packs of:
 *
 *   each      0.55 a nut
 *   box of 25 10.00, 0.40 a nut
 *   50 nuts   two boxes, 20.00
 *   30 nuts   thirty each, 16.50 (30 is not whole boxes)
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("catalogue-packs:org");
const USER = fixtureId("catalogue-packs:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(), ...extra,
});
const owner = () => as(["owner"]);

let warehouse = "";
let ferguson = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Packs Supply Co", slug: "catalogue-packs-co" });
  const [w] = await raw`insert into public.location (organization_id, name, is_warehouse) values (${ORG}, 'Shop', true) returning id`;
  warehouse = w!.id;
});
afterAll(async () => { if (raw) await raw.end(); });
beforeEach(async () => {
  if (!url) return;
  for (const table of [
    "purchase_order_line", "purchase_order", "vendor_item", "vendor", "integration_event",
    "price_book_item_version", "price_book_item",
  ]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
  ferguson = (await inventory.createVendor(owner(), { name: "Ferguson" })).id;
});

const item = (code: string, price: string, cost: string) => priceBook.create(owner(), {
  kind: "material", code, name: `Item ${code}`, price, cost, taxable: true,
});

const NEW_VENDOR_CSV = [
  "sku,description,cost,vendor",
  "WN-1,Wire nut,0.55,Ferguson",
  "FUSE-5,Fuse 5A,2.00,Acme Electric",
  "FUSE-10,Fuse 10A,2.10,ACME ELECTRIC",
].join("\n");

run("vendors a catalogue names", () => {
  it("are skipped unless the person importing ticks that they may be added", async () => {
    await item("WN-1", "1.00", "0.50");
    const off = await vendorCatalogue.apply(owner(), { csv: NEW_VENDOR_CSV, margin: "0.5" });
    expect(off.rows.filter((r) => r.action === "skip")).toHaveLength(2);
    expect(off.vendorsAdded).toBe(0);
    expect(await raw`select 1 from public.vendor where organization_id = ${ORG} and lower(name) = 'acme electric'`).toHaveLength(0);
  });

  it("are added once each, under the first spelling, with their parts, and audited", async () => {
    await item("WN-1", "1.00", "0.50");
    const preview = await vendorCatalogue.preview(owner(), { csv: NEW_VENDOR_CSV, margin: "0.5", createVendors: true });
    expect(preview.newVendors).toEqual([{ name: "Acme Electric", line: 3 }]);
    expect(preview.rows[1]).toMatchObject({ action: "create", vendorId: null, vendorName: "Acme Electric", newVendor: true });
    /** Nothing written by a preview. */
    expect(await raw`select 1 from public.vendor where organization_id = ${ORG} and name = 'Acme Electric'`).toHaveLength(0);

    const applied = await vendorCatalogue.apply(owner(), { csv: NEW_VENDOR_CSV, margin: "0.5", createVendors: true });
    expect(applied).toMatchObject({ vendorsAdded: 1, created: 2, linked: 1 });
    const [acme] = await raw<{ id: string }[]>`select id from public.vendor where organization_id = ${ORG} and name = 'Acme Electric'`;
    const theirs = await vendorCatalogue.links(owner(), { vendorId: acme!.id });
    expect(theirs.map((l) => l.partNumber).sort()).toEqual(["FUSE-10", "FUSE-5"]);
    const logged = await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'vendor.created' and entity_id = ${acme!.id}`;
    expect(logged).toHaveLength(1);
  });

  it("does not add a vendor whose every row was unticked", async () => {
    const applied = await vendorCatalogue.apply(owner(), {
      csv: NEW_VENDOR_CSV, margin: "0.5", createVendors: true, skipLines: [3, 4],
    });
    expect(applied.vendorsAdded).toBe(0);
    expect(await raw`select 1 from public.vendor where organization_id = ${ORG} and name = 'Acme Electric'`).toHaveLength(0);
  });
});

run("a part bought by the each and by the box", () => {
  it("is kept as two packs on one link from a catalogue, and ordered the cheaper way that fits", async () => {
    const nut = await item("WN-1", "1.00", "0.50");
    const csv = [
      "sku,description,cost,vendor,pack qty,uom",
      "WN-1,Wire nut,0.55,Ferguson,1,",
      "WN-1,Wire nut box,10.00,Ferguson,25,box",
    ].join("\n");
    const applied = await vendorCatalogue.apply(owner(), { csv });
    expect(applied.rows.map((r) => r.action)).toEqual(["link", "pack"]);

    const [link] = await vendorCatalogue.links(owner(), { itemId: nut.id });
    expect(link).toMatchObject({ packQuantity: "1.0000", cost: "0.5500" });
    expect(link!.secondPack).toMatchObject({ packQuantity: "25.0000", purchaseUnit: "box", cost: "10.0000", eachCost: "0.4000" });
    /** Cheaper per nut first: the order a purchase order offers them in. */
    expect(link!.packs.map((p) => [p.packQuantity, p.second])).toEqual([["25.0000", true], ["1.0000", false]]);

    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: warehouse,
      lines: [
        { partNumber: "WN-1", quantity: "50" },
        { partNumber: "WN-1", quantity: "30" },
        { partNumber: "WN-1", quantity: "50", packQuantity: "1" },
      ],
    });
    const read = await inventory.purchaseOrder(owner(), { id: order.id });
    expect(read.lines.map((l) => [l.quantityOrdered, l.unitPrice, l.packs?.unit ?? null, l.lineTotal])).toEqual([
      ["50.0000", "0.4000", "box", "20.0000"],
      ["30.0000", "0.5500", null, "16.5000"],
      ["50.0000", "0.5500", null, "27.5000"],
    ]);

    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: warehouse, lines: [{ partNumber: "WN-1", quantity: "30", packQuantity: "25" }],
    })).rejects.toThrow(/Order 25 or 50 by the box of 25, not 30/);
  });

  it("is set and taken away on the vendor link, and refused as the same pack twice", async () => {
    const nut = await item("WN-1", "1.00", "0.50");
    const set = await vendorCatalogue.setLink(owner(), {
      vendorId: ferguson, itemId: nut.id, partNumber: "WN-1", cost: "0.55",
      secondPack: { packQuantity: "25", purchaseUnit: "box", cost: "10.00", priceBreaks: [{ minimum: "4", cost: "9.00" }] },
    });
    expect(set.secondPack).toMatchObject({ packQuantity: "25.0000", priceBreaks: [{ minimum: "4.0000", cost: "9.0000" }] });
    /** Left out keeps it. */
    const kept = await vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: nut.id, partNumber: "WN-1", cost: "0.60" });
    expect(kept.secondPack?.packQuantity).toBe("25.0000");
    await expect(vendorCatalogue.setLink(owner(), {
      vendorId: ferguson, itemId: nut.id, partNumber: "WN-1", secondPack: { packQuantity: "1" },
    })).rejects.toThrow(ConflictError);
    await expect(vendorCatalogue.setLink(owner(), {
      vendorId: ferguson, itemId: nut.id, partNumber: "WN-1", secondPack: { packQuantity: "lots" },
    })).rejects.toThrow(/not how many/);
    const gone = await vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: nut.id, partNumber: "WN-1", secondPack: null });
    expect(gone.secondPack).toBeNull();
    expect(gone.packs).toHaveLength(1);
  });

  it("leaves a part sold one way ordered as it always was", async () => {
    const nut = await item("WN-1", "1.00", "0.50");
    await vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: nut.id, partNumber: "WN-1", cost: "10.00", packQuantity: "25", purchaseUnit: "box" });
    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: warehouse, lines: [{ partNumber: "WN-1", quantity: "30" }],
    })).rejects.toThrow(/sells WN-1 by the box of 25\. Order 25 or 50, not 30/);
    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: warehouse, lines: [{ partNumber: "WN-1", quantity: "30", packQuantity: "1" }],
    })).rejects.toThrow(/one way only/);
  });
});
