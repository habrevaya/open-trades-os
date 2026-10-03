import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { PermissionError } from "@opentradesos/core";
import * as vendorCatalogue from "../src/services/vendor-catalogue";
import * as inventory from "../src/services/inventory";
import * as priceBook from "../src/services/pricebook";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * VENDOR PART NUMBERS, A SUPPLIER'S CATALOGUE, AND THE PRICE BOOK EDITOR
 *
 * The supplier's number for a part lived on a sticky note and a purchase
 * order line was typed from memory. Their catalogue, which every supply
 * house sends as a spreadsheet, had nowhere to go, so costs went stale the
 * week they were entered. And a single item could not be opened and edited
 * on a screen at all.
 *
 * What has to hold: a part number names one item per vendor; a catalogue
 * previews exactly what it then does, writes item costs as new versions so
 * no document already priced moves, and refuses to sell anything new at
 * cost; an order line is looked up and carries the vendor's number as it was
 * when the order went out.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("catalogue:org");
const USER = fixtureId("catalogue:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(), ...extra,
});
const owner = () => as(["owner"]);

let warehouse = "";
let ferguson = "";
let johnstone = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Supply Co", slug: "supply-catalogue" });
  const [w] = await raw`insert into public.location (organization_id, name, is_warehouse)
    values (${ORG}, 'Shop', true) returning id`;
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
  johnstone = (await inventory.createVendor(owner(), { name: "Johnstone Supply" })).id;
});

const item = (code: string, price: string, cost: string) => priceBook.create(owner(), {
  kind: "material", code, name: `Item ${code}`, price, cost, taxable: true,
});

const versionsOf = async (itemId: string) =>
  (await raw`select version, cost from public.price_book_item_version
    where item_id = ${itemId} order by version`).map((r) => [r.version, r.cost]);

run("a vendor's number for an item", () => {
  it("records one number per item per vendor, and replaces it rather than adding a second", async () => {
    const cap = await item("CAP-45-5", "45.00", "11.00");
    await vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: cap.id, partNumber: "C455R", cost: "$11.40" });
    const renumbered = await vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: cap.id, partNumber: "C455R-2" });
    expect(renumbered).toMatchObject({ partNumber: "C455R-2", cost: "11.4000", vendorName: "Ferguson", itemCode: "CAP-45-5" });
    expect(await vendorCatalogue.links(owner(), { itemId: cap.id })).toHaveLength(1);
  });

  it("refuses one vendor number on two of our items, in words", async () => {
    const one = await item("A", "10.00", "5.00");
    const two = await item("B", "10.00", "5.00");
    await vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: one.id, partNumber: "X-1" });
    await expect(vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: two.id, partNumber: "x-1" }))
      .rejects.toThrow(/already this vendor's number for another/);
    /** Another vendor may use the same string for their own part. */
    await expect(vendorCatalogue.setLink(owner(), { vendorId: johnstone, itemId: two.id, partNumber: "X-1" }))
      .resolves.toBeTruthy();
  });

  it("is vendor data: a technician cannot read it and a dispatcher cannot write it", async () => {
    const one = await item("A", "10.00", "5.00");
    await expect(vendorCatalogue.links(as(["technician"]), { itemId: one.id })).rejects.toThrow(PermissionError);
    await expect(vendorCatalogue.setLink(as(["dispatcher"]), { vendorId: ferguson, itemId: one.id, partNumber: "Z" }))
      .rejects.toThrow(PermissionError);
  });

  it("forgets a number without touching an order that was sent with it", async () => {
    const one = await item("A", "10.00", "5.00");
    const link = await vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: one.id, partNumber: "F-A", cost: "4.00" });
    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: warehouse, lines: [{ partNumber: "F-A", quantity: "2" }],
    });
    await vendorCatalogue.removeLink(owner(), { id: link.id });
    expect((await inventory.purchaseOrder(owner(), { id: order.id })).lines[0]!.vendorPartNumber).toBe("F-A");
  });
});

const CSV = [
  "Part #,Description,Net Price,Supplier",
  "C455R,\"Capacitor, dual run 45/5\",12.50,Ferguson",
  "FLT-16,Filter 16x25x1,5.25,Johnstone Supply",
  "CTR-40,Contactor 40A,60.00,Ferguson",
  "ZZZ,Mystery part,1.00,Acme",
  "BAD,Broken,call us,Ferguson",
].join("\n");

run("a supplier's catalogue", () => {
  const seedBook = async () => {
    const cap = await item("CAP-45-5", "45.00", "11.00");
    const filter = await item("FLT-16", "18.00", "6.00");
    await vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: cap.id, partNumber: "C455R", cost: "11.00" });
    return { cap, filter };
  };

  it("previews what each row would do and writes nothing", async () => {
    await seedBook();
    const preview = await vendorCatalogue.preview(owner(), { csv: CSV, margin: "0.4", updateItemCost: true });

    expect(preview.counts).toEqual({ create: 1, link: 1, update: 1, unchanged: 0, skip: 1 });
    expect(preview.problems).toEqual([{ line: 6, message: 'BAD has a cost of "call us", which is not an amount.' }]);
    expect(preview.rows.map((r) => [r.line, r.action])).toEqual([[2, "update"], [3, "link"], [4, "create"], [5, "skip"]]);
    expect(preview.rows[2]).toMatchObject({ code: "CTR-40", price: "100.0000" });
    const [links] = await raw`select count(*)::int as n from public.vendor_item where organization_id = ${ORG}`;
    expect(links!.n).toBe(1);
  });

  it("applies exactly the plan: new item, new link, updated cost, each item cost as a new version", async () => {
    const { cap, filter } = await seedBook();
    const applied = await vendorCatalogue.apply(owner(), { csv: CSV, margin: "0.4", updateItemCost: true });
    expect(applied).toMatchObject({ created: 1, linked: 1, updated: 1, itemCostsRevised: 2 });

    /** The old cost stays on the version every existing document points at. */
    expect(await versionsOf(cap.id)).toEqual([[1, "11.0000"], [2, "12.5000"]]);
    expect(await versionsOf(filter.id)).toEqual([[1, "6.0000"], [2, "5.2500"]]);
    const fromFerguson = await vendorCatalogue.links(owner(), { vendorId: ferguson });
    expect(fromFerguson.map((l) => [l.partNumber, l.cost, l.description])).toEqual([
      ["C455R", "12.5000", "Capacitor, dual run 45/5"],
      ["CTR-40", "60.0000", "Contactor 40A"],
    ]);
    const created = (await priceBook.list(owner(), { limit: 50, includeInactive: false, q: "CTR-40" })).data[0]!;
    expect(created).toMatchObject({ kind: "material", name: "Contactor 40A", price: "100.0000", cost: "60.0000" });
  });

  it("leaves item costs alone when not asked, and a line the person unticked alone entirely", async () => {
    const { cap } = await seedBook();
    const applied = await vendorCatalogue.apply(owner(), { csv: CSV, margin: "0.4", skipLines: [4] });
    expect(applied).toMatchObject({ created: 0, linked: 1, updated: 1, itemCostsRevised: 0 });
    expect(await versionsOf(cap.id)).toEqual([[1, "11.0000"]]);
  });

  it("skips a new part rather than sell it at cost when no margin is given", async () => {
    await seedBook();
    const preview = await vendorCatalogue.preview(owner(), { csv: CSV });
    expect(preview.rows.find((r) => r.line === 4)).toMatchObject({ action: "skip" });
  });

  it("holds an item's cost back when a price change is already scheduled for it", async () => {
    const { cap } = await seedBook();
    await priceBook.revise(owner(), { id: cap.id, price: "49.00", effectiveFrom: new Date(Date.now() + 30 * 864e5).toISOString() });
    const applied = await vendorCatalogue.apply(owner(), { csv: CSV, margin: "0.4", updateItemCost: true });
    expect(applied.rows.find((r) => r.line === 2)).toMatchObject({ action: "update", costHeldBack: true, itemCostAfter: null });
    expect((await versionsOf(cap.id)).map((v) => v[0])).toEqual([1, 2]);
  });

  it("answers a retried apply with the first answer and writes nothing twice", async () => {
    await seedBook();
    const keyed = () => as(["owner"], { idempotencyKey: "catalogue-1" });
    const first = await vendorCatalogue.apply(keyed(), { csv: CSV, margin: "0.4" });
    const again = await vendorCatalogue.apply(keyed(), { csv: CSV, margin: "0.4" });
    expect(again).toEqual(first);
    const [items] = await raw`select count(*)::int as n from public.price_book_item where organization_id = ${ORG}`;
    expect(items!.n).toBe(3);
  });

  it("takes the vendor chosen for a file that names none, and refuses a file with no part numbers", async () => {
    await seedBook();
    const preview = await vendorCatalogue.preview(owner(), {
      csv: "sku,description,cost\nFLT-16,Filter,5.00", vendorId: johnstone,
    });
    expect(preview.rows[0]).toMatchObject({ action: "link", vendorName: "Johnstone Supply" });
    await expect(vendorCatalogue.preview(owner(), { csv: "name,price\nx,1" })).rejects.toThrow(/no sku column/);
  });

  it("needs both vendor:write and pricebook:write, and shows an item's cost only to who may see it", async () => {
    await seedBook();
    await expect(vendorCatalogue.preview(as(["office_manager"]), { csv: CSV })).rejects.toThrow(/pricebook:write/);
    const narrow = as(["office_manager"], {});
    narrow.actor.grants = ["pricebook:write"];
    narrow.actor.revocations = ["pricebook.cost:read"];
    const preview = await vendorCatalogue.preview(narrow, { csv: CSV, updateItemCost: true });
    expect(preview.rows[0]).toMatchObject({ action: "update", itemCostBefore: null });
  });
});

run("a purchase order line, looked up", () => {
  it("finds the part by the vendor's number or our code, and prices it at what they charge", async () => {
    const cap = await item("CAP-45-5", "45.00", "11.00");
    const filter = await item("FLT-16", "18.00", "6.00");
    await vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: cap.id, partNumber: "C455R", cost: "11.40" });

    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: warehouse,
      lines: [
        { partNumber: "c455r", quantity: "4" },
        { partNumber: "FLT-16", quantity: "10", unitPrice: "5.10" },
        { itemId: cap.id, quantity: "1", unitPrice: "11.00" },
      ],
    });
    const read = await inventory.purchaseOrder(owner(), { id: order.id });
    expect(read.lines.map((l) => [l.itemId, l.vendorPartNumber, l.quantityOrdered, l.unitPrice])).toEqual([
      [cap.id, "C455R", "4.0000", "11.4000"],
      [filter.id, null, "10.0000", "5.1000"],
      [cap.id, "C455R", "1.0000", "11.0000"],
    ]);
    expect(read).toMatchObject({ vendorName: "Ferguson", total: "107.6000" });
  });

  it("refuses a part nobody can find, and one with no price to order it at", async () => {
    await item("FLT-16", "18.00", "6.00");
    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: warehouse, lines: [{ partNumber: "NOPE", quantity: "1" }],
    })).rejects.toThrow(/Nothing answers to NOPE/);
    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: warehouse, lines: [{ partNumber: "FLT-16", quantity: "1" }],
    })).rejects.toThrow(ConflictError);
  });

  it("keeps the number the order was sent with when the vendor renumbers the part", async () => {
    const cap = await item("CAP-45-5", "45.00", "11.00");
    await vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: cap.id, partNumber: "C455R", cost: "11.40" });
    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId: ferguson, defaultLocationId: warehouse, lines: [{ itemId: cap.id, quantity: "1" }],
    });
    await vendorCatalogue.setLink(owner(), { vendorId: ferguson, itemId: cap.id, partNumber: "C455R-NEW" });
    expect((await inventory.purchaseOrder(owner(), { id: order.id })).lines[0]!.vendorPartNumber).toBe("C455R");
  });

  it("raises one order for a retried request", async () => {
    const cap = await item("CAP-45-5", "45.00", "11.00");
    const keyed = () => as(["owner"], { idempotencyKey: "po-1" });
    const input = { vendorId: ferguson, defaultLocationId: warehouse, lines: [{ itemId: cap.id, quantity: "1", unitPrice: "9.00" }] };
    const first = await inventory.createPurchaseOrder(keyed(), input);
    expect(await inventory.createPurchaseOrder(keyed(), input)).toEqual(first);
  });
});

run("one price book item, on its own screen", () => {
  it("reads every version with when it was in force, and a revision waiting", async () => {
    const cap = await item("CAP-45-5", "45.00", "11.00");
    await priceBook.revise(owner(), { id: cap.id, price: "47.00" });
    await priceBook.revise(owner(), { id: cap.id, price: "49.00", effectiveFrom: new Date(Date.now() + 864e5).toISOString() });

    const read = await priceBook.detail(owner(), { id: cap.id });
    expect(read.price).toBe("47.0000");
    expect(read.versions.map((v) => [v.version, v.price, v.state])).toEqual([
      [3, "49.0000", "scheduled"], [2, "47.0000", "in_force"], [1, "45.0000", "past"],
    ]);
    expect(read.versions[0]!.cost).toBe("11.0000");

    /** A technician reads the history, and no cost on any version of it. */
    const theirs = await priceBook.detail(as(["technician"]), { id: cap.id });
    expect(theirs.versions.every((v) => !("cost" in v))).toBe(true);
    expect("cost" in theirs).toBe(false);
  });

  it("changes what an item is without writing a version, and refuses a code another item has", async () => {
    const fee = await item("DIAG", "89.00", "0.00");
    await item("TRIP", "50.00", "0.00");
    const changed = await priceBook.updateItem(owner(), { id: fee.id, kind: "fee", feeRole: "diagnostic", code: "DIAG-FEE" });
    expect(changed).toMatchObject({ kind: "fee", feeRole: "diagnostic", code: "DIAG-FEE", version: 1 });
    await expect(priceBook.updateItem(owner(), { id: fee.id, code: "TRIP" })).rejects.toThrow(/already exists/);
    await expect(priceBook.updateItem(as(["technician"]), { id: fee.id, feeRole: null })).rejects.toThrow(PermissionError);
  });

  it("carries the warranty and tax class through a revision when they change, and keeps them when they do not", async () => {
    const part = await item("COIL", "900.00", "400.00");
    await priceBook.revise(owner(), { id: part.id, warrantyMonths: 60, taxClass: "equipment" });
    const revised = await priceBook.revise(owner(), { id: part.id, price: "950.00" });
    expect(revised).toMatchObject({ warrantyMonths: 60, taxClass: "equipment", price: "950.0000", version: 3 });
  });
});
