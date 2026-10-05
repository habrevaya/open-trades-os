import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as stockUnits from "../src/services/stock-units";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * SERIALS, LOTS, LANDED COST AND TRUCK STOCK, THROUGH A REAL DATABASE
 *
 * The rules are tested in core. What this file proves is the part core
 * cannot: that a serial received on a purchase order, moved onto a van and
 * used on a job can be traced back from the customer's equipment record to
 * the order it came on, that freight on a delivery reaches the cost a job is
 * charged, and that a retried stock write is the first one rather than a
 * second.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("su:org");
const USER = fixtureId("su:user");

let raw: postgres.Sql;
let compressor = "";
let capacitor = "";
let refrigerant = "";
let shop = "";
let van = "";
let vendorId = "";
let jobId = "";
let propertyId = "";

const db = () => testDb(url!);
const as = (roles: string[], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);

async function item(code: string, name: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'material', ${code}) returning id`;
  await raw`
    insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
    values (${ORG}, ${row!.id}, 1, ${name}, '100.00', now() - interval '1 day')`;
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Serial Co", slug: "serial-co" });
  compressor = await item("COMP-3T", "Compressor, 3 ton");
  capacitor = await item("CAP-45", "Capacitor 45/5");
  refrigerant = await item("R410A-25", "R-410A, 25 lb cylinder");
  [{ id: shop }] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, is_warehouse) values (${ORG}, 'Shop', true) returning id` as unknown as [{ id: string }];
  [{ id: van }] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name) values (${ORG}, 'Van 4') returning id` as unknown as [{ id: string }];
  const vendor = await inventory.createVendor(owner(), { name: "Ferguson" });
  vendorId = vendor.id;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Hollis Tran", phone: "+15125550142",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "41 Elm St", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  propertyId = property.id;
  const job = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "Compressor change", tags: [], customFields: {},
  });
  jobId = job.id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("a serialised part, from the order to the customer's equipment", () => {
  it("tracks an item with unnumbered units on the shelf, says where they are, and will not move them unnamed", async () => {
    await inventory.receive(owner(), { itemId: capacitor, locationId: shop, quantity: "4", totalCost: "40.00" });
    const tracked = await stockUnits.setTracking(owner(), { itemId: capacitor, mode: "serial" });
    expect(tracked.unnumbered).toEqual([{ locationId: shop, locationName: "Shop", quantity: "4" }]);
    await expect(inventory.transfer(owner(), { itemId: capacitor, fromLocationId: shop, toLocationId: van, quantity: "1" }))
      .rejects.toThrow(/tracked by serial number, so say which ones/);
    // Counted only again for the rest of this file, which receives it unnamed.
    await stockUnits.setTracking(owner(), { itemId: capacitor, mode: null });
  });

  it("receives on an order with freight, naming every serial, and spreads the freight into the cost", async () => {
    await stockUnits.setTracking(owner(), { itemId: compressor, mode: "serial" });
    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: shop,
      lines: [
        { itemId: compressor, quantity: "2", unitPrice: "900.00" },
        { itemId: capacitor, quantity: "10", unitPrice: "10.00" },
      ],
    });
    await inventory.setPurchaseOrderStatus(owner(), { id: order.id, status: "submitted" });
    const detail = await inventory.purchaseOrder(owner(), { id: order.id });
    const compLine = detail.lines.find((l) => l.itemId === compressor)!;
    const capLine = detail.lines.find((l) => l.itemId === capacitor)!;
    expect(compLine.tracking).toBe("serial");

    // The serials are required on the tracked line.
    await expect(inventory.receivePurchaseOrder(owner(), {
      purchaseOrderId: order.id, lines: [{ lineId: compLine.id, quantity: "2" }],
    })).rejects.toThrow(/tracked by serial number, so say which ones/);

    const received = await inventory.receivePurchaseOrder(owner(), {
      purchaseOrderId: order.id,
      lines: [
        { lineId: compLine.id, quantity: "2", units: [{ number: "SN-1001" }, { number: "SN-1002" }] },
        { lineId: capLine.id, quantity: "10" },
      ],
      charges: [{ description: "Freight", amount: "57.00" }],
      basis: "value",
    });
    expect(received).toMatchObject({ status: "received", chargesTotal: "57.0000" });

    /**
     * $1,900 of goods and $57 of freight by value: the compressors carry
     * 1800/1900 of it, $54.00, so each is $927.00; the capacitors carry $3.00.
     */
    const after = await inventory.purchaseOrder(owner(), { id: order.id });
    expect(after.lines.find((l) => l.itemId === compressor)!.landedCost).toBe("54.0000");
    expect(after.lines.find((l) => l.itemId === capacitor)!.landedCost).toBe("3.0000");
    expect(after.lines.find((l) => l.itemId === compressor)!.units.map((u) => u.number).sort()).toEqual(["SN-1001", "SN-1002"]);
    expect(after.receipts[0]!.charges).toEqual([{ description: "Freight", amount: "57.0000" }]);

    const costs = await raw<{ total_cost: string; landed_cost: string | null }[]>`
      select total_cost, landed_cost from public.stock_movement
      where organization_id = ${ORG} and item_id = ${compressor} and kind = 'receipt' order by sequence`;
    expect(costs.map((c) => c.total_cost)).toEqual(["927.0000", "927.0000"]);
  });

  it("refuses the same serial arriving again while it is on the shelf", async () => {
    await expect(inventory.receive(owner(), {
      itemId: compressor, locationId: shop, quantity: "1", totalCost: "900.00", units: [{ number: "sn-1001" }],
    })).rejects.toThrow(/Serial SN-1001 of Compressor, 3 ton is already in stock at Shop/);
  });

  it("moves one serial onto a van, and refuses moving one that is not where it is said to be", async () => {
    await inventory.transfer(owner(), {
      itemId: compressor, fromLocationId: shop, toLocationId: van, quantity: "1", units: [{ number: "SN-1002" }],
    });
    await expect(inventory.transfer(owner(), {
      itemId: compressor, fromLocationId: shop, toLocationId: van, quantity: "1", units: [{ number: "SN-1002" }],
    })).rejects.toThrow(/SN-1002 is not at Shop/);
    const vanUnits = await stockUnits.units(owner(), { locationId: van });
    expect(vanUnits.map((u) => u.number)).toEqual(["SN-1002"]);
  });

  it("refuses a count of a tracked item and a part used unnamed", async () => {
    await expect(inventory.count(owner(), { itemId: compressor, locationId: shop, counted: "0" }))
      .rejects.toThrow(/count by number alone/);
    await expect(inventory.issue(owner(), { itemId: compressor, locationId: van, quantity: "1", jobId }))
      .rejects.toThrow(/tracked by serial number/);
  });

  it("uses the serial on a job, records it as the customer's equipment, and traces it back to the order", async () => {
    await inventory.issue(owner("issue-sn-1002"), {
      itemId: compressor, locationId: van, quantity: "1", jobId,
      units: [{ number: "SN-1002", installAs: { category: "Condenser", manufacturer: "Carrier", model: "24ACC636" } }],
    });
    // A retried issue is the first one, not a second: the van does not go negative and no second equipment record appears.
    await inventory.issue(owner("issue-sn-1002"), {
      itemId: compressor, locationId: van, quantity: "1", jobId,
      units: [{ number: "SN-1002", installAs: { category: "Condenser", manufacturer: "Carrier", model: "24ACC636" } }],
    });
    const equipment = await raw<{ serial_number: string; installed_by_us: boolean }[]>`
      select serial_number, installed_by_us from public.equipment where organization_id = ${ORG} and property_id = ${propertyId}`;
    expect(equipment).toEqual([{ serial_number: "SN-1002", installed_by_us: true }]);

    const [unit] = await stockUnits.units(owner(), { number: "1002" });
    expect(unit).toMatchObject({ state: "used", jobId });
    const trace = await stockUnits.trace(owner(), { id: unit!.id });
    expect(trace.steps.map((s) => s.kind)).toEqual(["receipt", "transfer_out", "transfer_in", "issue"]);
    expect(trace.steps[0]).toMatchObject({ vendorName: "Ferguson", cost: "927.0000" });
    expect(trace.equipment).toMatchObject({ serialNumber: "SN-1002", address: "41 Elm St, Austin", customerName: "Hollis Tran" });

    // The job's material cost is the landed cost, not the invoice price alone.
    expect(await inventory.costOfJob(owner(), { jobId })).toBe("927.0000");

    // A technician sees where it went and not what it cost.
    const seen = await stockUnits.trace(as(["technician"]), { id: unit!.id });
    expect(seen.steps[0]!.cost).toBeNull();
  });

  it("writes off a serial by number with a reason", async () => {
    await stockUnits.writeOff(owner(), { itemId: compressor, locationId: shop, units: [{ number: "SN-1001" }], reason: "Dropped off the forklift" });
    const [unit] = await stockUnits.units(owner(), { number: "SN-1001" });
    expect(unit!.state).toBe("gone");
  });
});

run("lots", () => {
  it("receives a lot, moves part of it, and refuses moving more than the lot holds there", async () => {
    await stockUnits.setTracking(owner(), { itemId: refrigerant, mode: "lot" });
    await inventory.receive(owner(), {
      itemId: refrigerant, locationId: shop, quantity: "6", totalCost: "1200.00",
      units: [{ number: "LOT-24A", expiresOn: "2029-01-01" }],
    });
    await inventory.transfer(owner(), {
      itemId: refrigerant, fromLocationId: shop, toLocationId: van, quantity: "2", units: [{ number: "LOT-24A" }],
    });
    // A second lot that never left the shop cannot leave the van.
    await inventory.receive(owner(), {
      itemId: refrigerant, locationId: shop, quantity: "1", totalCost: "200.00", units: [{ number: "LOT-24B" }],
    });
    await expect(inventory.transfer(owner(), {
      itemId: refrigerant, fromLocationId: van, toLocationId: shop, quantity: "1", units: [{ number: "LOT-24B" }],
    })).rejects.toThrow(/LOT-24B is not at Van 4/);
    // Nor can more of a lot leave than the van holds of it.
    await expect(inventory.transfer(owner(), {
      itemId: refrigerant, fromLocationId: van, toLocationId: shop, quantity: "2",
      units: [{ number: "LOT-24A", quantity: "1" }, { number: "LOT-24B", quantity: "1" }],
    })).rejects.toThrow(/LOT-24B is not at Van 4/);
    const lots = await stockUnits.units(owner(), { itemId: refrigerant });
    expect(lots.find((l) => l.number === "LOT-24A")!.where.map((w) => `${w.locationName}:${w.quantity}`).sort())
      .toEqual(["Shop:4", "Van 4:2"]);
    expect(lots.find((l) => l.number === "LOT-24A")!.expiresOn).toBe("2029-01-01");
  });
});

run("landed cost by quantity", () => {
  it("spreads a per piece freight charge by how many arrived", async () => {
    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: shop,
      lines: [{ itemId: capacitor, quantity: "3", unitPrice: "5.00" }],
    });
    await inventory.setPurchaseOrderStatus(owner(), { id: order.id, status: "submitted" });
    const [line] = (await inventory.purchaseOrder(owner(), { id: order.id })).lines;
    await inventory.receivePurchaseOrder(owner(), {
      purchaseOrderId: order.id, lines: [{ lineId: line!.id, quantity: "3" }],
      charges: [{ description: "Handling", amount: "1.00" }], basis: "quantity",
    });
    const after = await inventory.purchaseOrder(owner(), { id: order.id });
    expect(after.lines[0]!.landedCost).toBe("1.0000");
    expect(after.receipts[0]!.basis).toBe("quantity");
  });
});

run("what each truck should carry", () => {
  it("refuses a minimum at a warehouse, and suggests filling a van from the shop", async () => {
    await expect(stockUnits.setTruckMinimum(owner(), { itemId: capacitor, locationId: shop, minimum: "2", target: "6" }))
      .rejects.toThrow(/Shop is a warehouse/);
    await stockUnits.setTruckMinimum(owner(), { itemId: capacitor, locationId: van, minimum: "2", target: "6" });
    const [suggestion] = await stockUnits.restockSuggestions(owner());
    expect(suggestion).toMatchObject({ truckName: "Van 4", fromLocationName: "Shop", wanted: "6", take: "6", short: "0" });

    await stockUnits.restock(owner("restock-1"), { itemId: capacitor, truckId: van, fromLocationId: shop, quantity: "6" });
    await stockUnits.restock(owner("restock-1"), { itemId: capacitor, truckId: van, fromLocationId: shop, quantity: "6" });
    const level = (await inventory.levels(owner())).find((l) => l.itemId === capacitor && l.locationId === van);
    expect(level?.onHand).toBe("6");
    expect(await stockUnits.restockSuggestions(owner())).toEqual([]);
  });
});
