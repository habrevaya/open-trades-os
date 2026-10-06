import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as stockUnits from "../src/services/stock-units";
import * as stockReturns from "../src/services/stock-returns";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { routes } from "../src/contracts";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * COUNTED STOCK GOING BACK TO A VENDOR, THROUGH THE SAME RETURN THE SERIALS USE
 *
 * A box of filters has no serial number, and a buyer still sends three back
 * when they were the wrong size. It is one vendor return with a quantity in
 * place of numbers, waiting for the same credit memo. What this file holds on
 * to: the credit is the figure the buyer was promised (counted stock has no
 * receipt of its own to read one from), stock held for a job stays put, and the
 * numbered path keeps refusing a quantity so the two cannot be mixed up.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("cvr:org");
const OWNER = fixtureId("cvr:owner");

let raw: postgres.Sql;
let filter = "";
let compressor = "";
let shop = "";
let van = "";
let vendorId = "";
let jobId = "";

const db = () => testDb(url!);
const as = (roles: string[], key?: string, grants: string[] = []): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: roles as Actor["roles"], grants: grants as NonNullable<Actor["grants"]> },
  db: db(), ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);

async function item(code: string, name: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'material', ${code}) returning id`;
  await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
    values (${ORG}, ${row!.id}, 1, ${name}, '20.00', now() - interval '1 day')`;
  return row!.id;
}

const onHand = async (itemId: string, locationId: string) =>
  (await inventory.levels(owner())).find((l) => l.itemId === itemId && l.locationId === locationId)?.onHand ?? "0";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Counted Return Co", slug: "counted-return-co" });
  filter = await item("FILT-16", "Filter 16x25");
  compressor = await item("COMP-2T", "Compressor, 2 ton");
  [{ id: shop }] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, is_warehouse) values (${ORG}, 'Shop', true) returning id` as unknown as [{ id: string }];
  [{ id: van }] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name) values (${ORG}, 'Van 2') returning id` as unknown as [{ id: string }];
  vendorId = (await inventory.createVendor(owner(), { name: "Johnstone" })).id;
  const customer = await customers.create(owner(), {
    type: "residential", name: "Ida Park", phone: "+15125550177", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "7 Oak St", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  jobId = (await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "Filter change", tags: [], customFields: {},
  })).id;
  await inventory.receive(owner(), { itemId: filter, locationId: shop, quantity: "10", totalCost: "50.00" });
  await inventory.receive(owner(), { itemId: filter, locationId: van, quantity: "4", totalCost: "20.00" });
  await stockUnits.setTracking(owner(), { itemId: compressor, mode: "serial" });
  await inventory.receive(owner(), {
    itemId: compressor, locationId: shop, quantity: "2", totalCost: "1000.00", units: [{ number: "CR-1" }, { number: "CR-2" }],
  });
});

afterAll(async () => { if (raw) await raw.end(); });

run("sending counted stock back to a vendor", () => {
  it("is one vendor return with a quantity, for the credit the buyer was promised, and takes the stock off the shelf", async () => {
    const made = await stockReturns.createVendorReturn(owner(), {
      vendorId, itemId: filter, locationId: shop, quantity: "3", reason: "Wrong size",
      reference: "RMA-9", creditExpected: "13.50",
    });
    expect(made).toMatchObject({ status: "awaiting_credit", creditExpected: "13.5000", reference: "RMA-9", reason: "Wrong size" });
    expect(made.units).toEqual([expect.objectContaining({ number: "", quantity: "3", locationName: "Shop" })]);
    expect(await onHand(filter, shop)).toBe("7");

    // Listed with the serials' returns, and credited the same way.
    expect((await stockReturns.vendorReturns(owner())).map((r) => r.id)).toContain(made.id);
    const credited = await stockReturns.recordVendorCredit(owner(), { id: made.id, amount: "12.00", reference: "CM-5" });
    expect(credited).toMatchObject({ status: "credited", creditReceived: "12.0000" });

    const [movement] = await raw`select kind, lot_id, vendor_return_id, reason_code from public.stock_movement
      where organization_id = ${ORG} and vendor_return_id = ${made.id}`;
    expect(movement).toMatchObject({ kind: "return_to_vendor", lot_id: null, vendor_return_id: made.id, reason_code: "Wrong size" });
    const [audited] = await raw`select after from public.audit_log where action = 'vendor_return.created' and entity_id = ${made.id}`;
    expect(audited!.after).toMatchObject({ counted: { itemId: filter, quantity: "3.0000" } });
  });

  it("posts nothing to the ledger for the goods or the credit", async () => {
    const [before] = await raw`select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}`;
    await stockReturns.createVendorReturn(owner(), {
      vendorId, itemId: filter, locationId: shop, quantity: "1", reason: "Damaged", creditExpected: "0.00",
    });
    const [after] = await raw`select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}`;
    expect(after!.n).toBe(before!.n);
  });

  it("is made once however many times it is sent", async () => {
    const first = await stockReturns.createVendorReturn(owner("cvr-1"), {
      vendorId, itemId: filter, locationId: van, quantity: "1", reason: "Cracked", creditExpected: "5.00",
    });
    const again = await stockReturns.createVendorReturn(owner("cvr-1"), {
      vendorId, itemId: filter, locationId: van, quantity: "1", reason: "Cracked", creditExpected: "5.00",
    });
    expect(again.id).toBe(first.id);
    expect(await onHand(filter, van)).toBe("3");
  });

  it("needs the credit said, because counted stock has no receipt to read one from", async () => {
    await expect(stockReturns.createVendorReturn(owner(), {
      vendorId, itemId: filter, locationId: shop, quantity: "1", reason: "Wrong size",
    })).rejects.toThrow(/Say what credit they are giving, even if it is nothing/);
  });

  it("says how many, never which ones, and a part with numbers never says how many", async () => {
    await expect(stockReturns.createVendorReturn(owner(), {
      vendorId, itemId: filter, locationId: shop, reason: "Wrong size", creditExpected: "1.00",
    })).rejects.toThrow(/Say how many/);
    await expect(stockReturns.createVendorReturn(owner(), {
      vendorId, itemId: filter, locationId: shop, units: [{ number: "X1" }], reason: "Wrong size", creditExpected: "1.00",
    })).rejects.toThrow(/counted, not numbered/);
    await expect(stockReturns.createVendorReturn(owner(), {
      vendorId, itemId: filter, locationId: shop, quantity: "0", reason: "Wrong size", creditExpected: "1.00",
    })).rejects.toThrow(/at least one/);
    await expect(stockReturns.createVendorReturn(owner(), {
      vendorId, itemId: compressor, locationId: shop, quantity: "1", reason: "Wrong voltage", creditExpected: "400.00",
    })).rejects.toThrow(/say which ones are going back rather than how many/);
    // The numbered path is as it was.
    const made = await stockReturns.createVendorReturn(owner(), {
      vendorId, itemId: compressor, locationId: shop, units: [{ number: "CR-1" }], reason: "Wrong voltage",
    });
    expect(made.units).toEqual([expect.objectContaining({ number: "CR-1", quantity: "1" })]);
    expect(made.creditExpected).toBe("500.0000");
  });

  it("will not send back more than the shelf holds, or what is held for a job", async () => {
    const level = Number(await onHand(filter, shop));
    await expect(stockReturns.createVendorReturn(owner(), {
      vendorId, itemId: filter, locationId: shop, quantity: String(level + 1), reason: "Wrong size", creditExpected: "1.00",
    })).rejects.toThrow(/only|short|on hand/i);

    await inventory.reserve(owner(), { itemId: filter, locationId: shop, jobId, quantity: "4" });
    const free = level - 4;
    await expect(stockReturns.createVendorReturn(owner(), {
      vendorId, itemId: filter, locationId: shop, quantity: String(free + 1), reason: "Wrong size", creditExpected: "1.00",
    })).rejects.toThrow(new RegExp(`held for jobs. Only ${free} can go back`));
    expect(await onHand(filter, shop)).toBe(String(level));
    await stockReturns.createVendorReturn(owner(), {
      vendorId, itemId: filter, locationId: shop, quantity: String(free), reason: "Wrong size", creditExpected: "1.00",
    });
    expect(await onHand(filter, shop)).toBe("4");
  });

  it("is refused for somebody who may not move stock or deal with a vendor", async () => {
    await expect(stockReturns.createVendorReturn(as(["accountant"], undefined, ["po:write"]), {
      vendorId, itemId: filter, locationId: van, quantity: "1", reason: "x", creditExpected: "1.00",
    })).rejects.toThrow(/inventory:adjust|permission/i);
    await expect(stockReturns.createVendorReturn(as(["technician"], undefined, ["inventory:adjust"]), {
      vendorId, itemId: filter, locationId: van, quantity: "1", reason: "x", creditExpected: "1.00",
    })).rejects.toThrow(/po:write|permission/i);
  });

  it("declares both permissions on the route, and takes a quantity", () => {
    expect(routes.createVendorReturn.permissions).toEqual(["po:write", "inventory:adjust"]);
    const parsed = routes.createVendorReturn.input.safeParse({
      vendorId, itemId: filter, locationId: shop, quantity: "3", reason: "Wrong size", creditExpected: "13.50",
    });
    expect(parsed.success).toBe(true);
  });
});
