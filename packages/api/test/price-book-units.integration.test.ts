import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { type Actor } from "@opentradesos/core";
import { createInvoice, revisePriceBookItem } from "../src/contracts";
import * as priceBook from "../src/services/pricebook";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as kpis from "../src/services/kpis";
import * as productsApplied from "../src/services/products-applied";
import * as vendorCatalogue from "../src/services/vendor-catalogue";
import { type ServiceContext } from "../src/services/context";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * BOUGHT BY THE GALLON, USED BY THE OUNCE
 *
 * A concentrate bought at 40.00 a gallon and applied by the ounce, 128 to the
 * gallon. The item's version says so; its cost stays the 40.00 on the
 * supplier's bill, and everything that counts it on a job counts ounces at
 * 0.3125: a job line, an invoice line and its margin, and pest control's
 * chemical cost per stop, which values an application recorded in gallons at
 * the cost and one in ounces at the cost over 128. An item that says nothing
 * about units is costed exactly as before.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("pbunits:org");
const USER = fixtureId("pbunits:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const gallon = { buy: "gal", use: "oz", usePerBuy: "128" };

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });
beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Units Co", slug: "price-book-units-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
});

run("an item bought in one unit and used in another", () => {
  it("keeps the cost per buy unit, costs a use unit at the ratio, and carries the units through a price change", async () => {
    const made = await priceBook.create(owner(), {
      kind: "material", code: "CONC", name: "Concentrate", price: "1.50", cost: "40.00", taxable: false, units: gallon,
    });
    expect(made).toMatchObject({ units: { buy: "gal", use: "oz", usePerBuy: "128" }, cost: "40.0000", costPerUse: "0.3125" });
    /** The margin is of what a line costs: 1.50 an ounce against 0.3125 an ounce. */
    expect(made.margin).toBe("0.7917");

    const plain = await priceBook.create(owner(), { kind: "material", code: "PLAIN", name: "Plain part", price: "10.00", cost: "4.00" });
    expect(plain.units).toBeNull();
    expect(plain).not.toHaveProperty("costPerUse");
    expect(plain.margin).toBe("0.6000");

    const raised = await priceBook.revise(owner(), revisePriceBookItem.input.parse({ id: made.id, price: "1.75" }));
    expect(raised.units).toEqual(made.units);
    await expect(priceBook.revise(owner(), revisePriceBookItem.input.parse({ id: made.id, units: { buy: "oz", use: "OZ", usePerBuy: "1" } })))
      .rejects.toThrow(/Units it is bought and used in/);
    const cleared = await priceBook.revise(owner(), revisePriceBookItem.input.parse({ id: made.id, units: null }));
    expect(cleared.units).toBeNull();
    /** With no units the 40.00 is the cost of the one unit a line counts again, as it always was. */
    expect(cleared.margin).toBe("-21.8571");
  });

  it("puts the cost per use unit on a job line and an invoice line, and an item with no units as before", async () => {
    const conc = (await priceBook.create(owner(), {
      kind: "material", code: "CONC", name: "Concentrate", price: "1.50", cost: "40.00", taxable: false, units: gallon,
    })).id;
    const plain = (await priceBook.create(owner(), { kind: "material", code: "PLAIN", name: "Plain part", price: "10.00", cost: "4.00", taxable: false })).id;
    const customer = (await customers.create(owner(), {
      type: "residential", name: "Una Units", phone: "+15125550931", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    })).id;
    const home = (await properties.create(owner(), {
      address: { line1: "3 Drum Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId: customer, customerRole: "owner",
    })).id;
    const job = await jobs.create(owner(), {
      customerId: customer, propertyId: home, summary: "Perimeter spray", tags: [], customFields: {},
      visit: { windowStart: "2026-10-06T14:00:00.000Z", windowEnd: "2026-10-06T17:00:00.000Z", estimatedDurationMinutes: 60, technicianIds: [] },
    } as Parameters<typeof jobs.create>[1]);
    const [visit] = await raw<{ id: string }[]>`select id from public.visit where job_id = ${job.id as string}`;
    await jobs.complete(owner(), { id: visit!.id, partsUsed: [{ priceBookItemId: conc, quantity: "16" }, { priceBookItemId: plain, quantity: "1" }] });
    const lines = await raw<{ name: string; unit_cost: string }[]>`
      select name, unit_cost::text from public.job_line where job_id = ${job.id as string} order by name`;
    expect(lines).toEqual([{ name: "Concentrate", unit_cost: "0.3125" }, { name: "Plain part", unit_cost: "4.0000" }]);

    const invoice = await billing.create(owner(), createInvoice.input.parse({
      customerId: customer, lines: [{ priceBookItemId: conc, name: "Concentrate", quantity: "16", unitPrice: "1.50", taxable: false }],
    }));
    const [line] = await raw<{ unit_cost: string }[]>`select unit_cost::text from public.invoice_line where invoice_id = ${invoice.id as string}`;
    expect(line!.unit_cost).toBe("0.3125");
  });
});

run("a supplier's file for an item bought by the gallon", () => {
  it("reads the file's cost per our unit, the ounce, and keeps the version's cost per gallon", async () => {
    const conc = await priceBook.create(owner(), {
      kind: "material", code: "CONC", name: "Concentrate", price: "1.50", cost: "40.00", taxable: false, units: gallon,
    });
    const [vendor] = await raw<{ id: string }[]>`
      insert into public.vendor (organization_id, name) values (${ORG}, 'Pest Supply') returning id`;
    await vendorCatalogue.setLink(owner(), { vendorId: vendor!.id, itemId: conc.id, partNumber: "CONC-1" });
    /** Their gallon at 44.80 is 0.35 an ounce, which is what the file's "each" is for an item counted in ounces. */
    const csv = ["Part #,Description,Net Price,Supplier", "CONC-1,Concentrate,0.35,Pest Supply"].join("\n");
    const applied = await vendorCatalogue.apply(owner(), { csv, updateItemCost: true });
    expect(applied).toMatchObject({ itemCostsRevised: 1 });
    const after = await priceBook.detail(owner(), { id: conc.id });
    expect(after).toMatchObject({ cost: "44.8000", costPerUse: "0.3500", units: { buy: "gal", use: "oz", usePerBuy: "128" } });
  });
});

run("chemical cost per stop for a product bought by the gallon and applied by the ounce", () => {
  it("values an application in gallons at the cost and one in ounces at the cost over 128", async () => {
    const [c] = await raw<{ id: string }[]>`
      insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Pat Pests') returning id`;
    const [p] = await raw<{ id: string }[]>`
      insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, '9 Ant Hill', 'Austin', 'TX', '78704') returning id`;
    /** The figure is pest control's, so the company is one. */
    await raw`update public.organization set primary_trade = 'pest-control' where id = ${ORG}`;
    const [type] = await raw<{ id: string }[]>`
      insert into public.job_type (organization_id, name, code, revenue_class)
      values (${ORG}, 'Quarterly', 'recurring', 'recurring') returning id`;
    await raw`insert into public.service_report_template (organization_id, name, job_type_id, fields)
              values (${ORG}, 'Quarterly', ${type!.id}, ${raw.json([
                { key: "product_applied", label: "Product applied", kind: "chemical", regulated: true, required: true },
                { key: "second_product", label: "Second product applied", kind: "chemical", regulated: true },
              ])})`;
    const [item] = await raw<{ id: string }[]>`
      insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'material', 'CONC') returning id`;
    await raw`
      insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, buy_unit, use_unit, use_per_buy, effective_from)
      values (${ORG}, ${item!.id}, 1, 'Concentrate', '1.50', '40', 'gal', 'oz', '128', '2026-01-01T06:00:00Z')`;
    await priceBook.updateItem(owner(), { id: item!.id, chemical: { unit: "oz", epaRegistrationNumber: "100-1" } });

    let n = 0;
    const stop = async (day: string) => {
      n += 1;
      const at = `${day}T19:00:00Z`;
      const [job] = await raw<{ id: string }[]>`
        insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, completed_at)
        values (${ORG}, ${n}, ${c!.id}, ${p!.id}, ${type!.id}, 'completed', ${`Quarterly ${n}`}, ${at}) returning id`;
      const [visit] = await raw<{ id: string }[]>`
        insert into public.visit (organization_id, job_id, sequence, status, completed_at)
        values (${ORG}, ${job!.id}, 1, 'completed', ${at}) returning id`;
      return visit!.id;
    };
    const s1 = await stop("2026-06-10");
    await productsApplied.record(owner(), { id: s1, field: "product_applied", priceBookItemId: item!.id, quantity: "16", unit: "oz" });
    await productsApplied.record(owner(), { id: s1, field: "second_product", priceBookItemId: item!.id, quantity: "0.5", unit: "GAL" });
    const s2 = await stop("2026-06-12");
    /** A unit that is neither is recorded in the chemical's own unit, as an application always was. */
    const shown = await productsApplied.record(owner(), { id: s2, field: "product_applied", priceBookItemId: item!.id, quantity: "32", unit: "quart" });
    expect(shown.applied.map((a) => a.unit)).toEqual(["oz"]);
    expect(shown.chemicals).toEqual([expect.objectContaining({ unit: "oz", units: { buy: "gal", use: "oz" } })]);

    const [kpi] = (await kpis.scorecard(owner(), { from: "2026-06-01", to: "2026-06-30" })).computed
      .filter((k) => k.key === "chemical_cost_per_stop");
    /** Stop one: 16 oz at 0.3125 and half a gallon at 40, 25.00. Stop two: 32 oz, 10.00. */
    expect([kpi!.numerator, kpi!.denominator, kpi!.value]).toEqual(["35.0000", "2", "17.5000"]);
    const drill = await kpis.drill(owner(), { key: "chemical_cost_per_stop", half: "numerator", from: "2026-06-01", to: "2026-06-30" });
    expect(drill.records.map((r) => r.label)).toEqual(expect.arrayContaining([
      "Concentrate, 16 oz at $0.3125, #1 visit 1, Quarterly 1",
      "Concentrate, 0.5 gal at $40.00, #1 visit 1, Quarterly 1",
    ]));
  });
});
