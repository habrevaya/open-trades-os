import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { PermissionError } from "@opentradesos/core";
import * as vendorCatalogue from "../src/services/vendor-catalogue";
import * as inventory from "../src/services/inventory";
import * as priceBook from "../src/services/pricebook";
import { routes } from "../src/contracts/index";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";
import { buildWorkbook, tamper, type Cell } from "./xlsx-builder";

/**
 * A SUPPLIER'S CATALOGUE, FROM A WORKBOOK (M16, reading it through M30)
 *
 * Supply houses send an .xlsx as often as a CSV. It is read by the reader the
 * spreadsheet import uses, so it has the same size cap and the same refusals,
 * and then its rows meet the same checks a CSV's do. What has to hold: the same
 * rows give the same plan whichever way they arrive, a line on the preview is
 * the row in the spreadsheet, a workbook of several sheets is not guessed at,
 * and nothing is written by a preview.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("catalogue-workbook:org");
const USER = fixtureId("catalogue-workbook:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(), ...extra,
});
const owner = () => as(["owner"]);

let ferguson = "";
const base64 = (bytes: Buffer) => bytes.toString("base64");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Workbook Supply Co", slug: "catalogue-workbook-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  for (const table of ["vendor_item", "vendor", "integration_event", "price_book_item_version", "price_book_item"]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
  ferguson = (await inventory.createVendor(owner(), { name: "Ferguson" })).id;
});

const ROWS: Cell[][] = [
  ["Part #", "Description", "Net Price", "Supplier"],
  ["C455R", "Capacitor, dual run 45/5", 12.5, "Ferguson"],
  [null, null, null, null],
  ["FLT-16", "Filter 16x25x1", { formula: "5+0.25", value: 5.25 }, "Ferguson"],
  ["BAD", "Broken", "call us", "Ferguson"],
];
const CSV = [
  "Part #,Description,Net Price,Supplier",
  "C455R,\"Capacitor, dual run 45/5\",12.5,Ferguson",
  "FLT-16,Filter 16x25x1,5.25,Ferguson",
  "BAD,Broken,call us,Ferguson",
].join("\n");

const item = (code: string, price: string, cost: string) => priceBook.create(owner(), {
  kind: "material", code, name: `Item ${code}`, price, cost, taxable: true,
});

run("a supplier's catalogue sent as a workbook", () => {
  it("gives the plan the same rows as a CSV give, with a line that is the row in the spreadsheet", async () => {
    await item("FLT-16", "18.00", "6.00");
    const book = await buildWorkbook([{ name: "Prices", rows: ROWS }]);
    const fromBook = await vendorCatalogue.preview(owner(), { workbook: base64(book), margin: "0.4" });
    const fromCsv = await vendorCatalogue.preview(owner(), { csv: CSV, margin: "0.4" });

    expect(fromBook.counts).toEqual(fromCsv.counts);
    expect(fromBook.rows.map((r) => [r.action, r.sku])).toEqual(fromCsv.rows.map((r) => [r.action, r.sku]));
    /** The empty row 3 is left out, and FLT-16 is still row 4 and BAD row 5, as a spreadsheet shows them. */
    expect(fromBook.rows.map((r) => r.line)).toEqual([2, 4]);
    expect(fromBook.problems).toEqual([{ line: 5, message: 'BAD has a cost of "call us", which is not an amount.' }]);
    /** A number cell and the stored answer of a formula both read as amounts. */
    expect(fromBook.rows.map((r) => ("cost" in r ? r.cost : null))).toEqual(["12.5000", "5.2500"]);
    const [links] = await raw`select count(*)::int as n from public.vendor_item where organization_id = ${ORG}`;
    expect(links!.n).toBe(0);
  });

  it("applies from the named sheet and writes what the plan said", async () => {
    await item("FLT-16", "18.00", "6.00");
    const book = await buildWorkbook([
      { name: "Read me", rows: [["Prices for 2026"]] },
      { name: "Prices", rows: ROWS },
    ]);
    const applied = await vendorCatalogue.apply(owner(), {
      workbook: base64(book), sheet: "Prices", margin: "0.4", updateItemCost: true,
    });
    expect(applied).toMatchObject({ created: 1, linked: 1, updated: 0, itemCostsRevised: 1 });
    const links = await vendorCatalogue.links(owner(), { vendorId: ferguson });
    expect(links.map((l) => [l.partNumber, l.cost])).toEqual([["C455R", "12.5000"], ["FLT-16", "5.2500"]]);
    const [audit] = await raw`select after from public.audit_log
      where organization_id = ${ORG} and action = 'vendor_catalogue.applied'`;
    expect(audit!.after).toMatchObject({ sheet: "Prices", created: 1 });
  });

  it("does not choose a sheet for the person, and says which sheets there are", async () => {
    const book = await buildWorkbook([
      { name: "Read me", rows: [["Prices for 2026"]] },
      { name: "Prices", rows: ROWS },
    ]);
    await expect(vendorCatalogue.preview(owner(), { workbook: base64(book) }))
      .rejects.toThrow(/2 sheets: "Read me", "Prices"\. Say which one/);
    await expect(vendorCatalogue.preview(owner(), { workbook: base64(book), sheet: "Costs" }))
      .rejects.toThrow(/no sheet called "Costs"/);

    const listed = await vendorCatalogue.sheets(owner(), { workbook: base64(book) });
    expect(listed.sheets.map((s) => [s.name, s.rows, s.why === null])).toEqual([["Read me", null, false], ["Prices", 3, true]]);
    expect(listed.sheets[1]!.header).toEqual(["Part #", "Description", "Net Price", "Supplier"]);
  });

  it("refuses a sheet with no cost column in words, as a CSV is refused", async () => {
    const book = await buildWorkbook([{ name: "Prices", rows: [["name", "price"], ["x", 1]] }]);
    await expect(vendorCatalogue.preview(owner(), { workbook: base64(book) })).rejects.toThrow(/there is no sku column/);
  });

  it("keeps the spreadsheet import's refusals: not a workbook, an old .xls, a password, a file too large", async () => {
    const text = Buffer.from("sku,cost\nA,1");
    await expect(vendorCatalogue.preview(owner(), { workbook: base64(text) })).rejects.toThrow(/does not look like an .xlsx/);
    const old = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(64)]);
    await expect(vendorCatalogue.preview(owner(), { workbook: base64(old) })).rejects.toThrow(/older .xls/);
    const book = await buildWorkbook([{ name: "Prices", rows: ROWS }]);
    await expect(vendorCatalogue.preview(owner(), { workbook: base64(tamper(book, { flags: 1 })) }))
      .rejects.toThrow(/protected with a password/);
    await expect(vendorCatalogue.preview(owner(), { workbook: "A".repeat(7_500_000) })).rejects.toThrow(/Bring in at most 5 MB/);
    const bomb = await buildWorkbook([{ name: "Prices", rows: ROWS }], { inflate: { name: "xl/junk.xml", megabytes: 120 } });
    await expect(vendorCatalogue.preview(owner(), { workbook: base64(bomb) })).rejects.toThrow(/far larger inside/);
    await expect(vendorCatalogue.preview(owner(), { workbook: base64(text) })).rejects.toBeInstanceOf(ConflictError);
  });

  it("takes a CSV or a workbook, never both, and a sheet only with a workbook", async () => {
    const book = await buildWorkbook([{ name: "Prices", rows: ROWS }]);
    await expect(vendorCatalogue.preview(owner(), { csv: CSV, workbook: base64(book) })).rejects.toThrow(/CSV or as a workbook, not both/);
    await expect(vendorCatalogue.preview(owner(), {})).rejects.toThrow(/Send the file/);
    await expect(vendorCatalogue.preview(owner(), { csv: CSV, sheet: "Prices" })).rejects.toThrow(/no sheets/);
  });

  it("needs vendor:write and pricebook:write to read the sheets, as previewing does", async () => {
    const book = await buildWorkbook([{ name: "Prices", rows: ROWS }]);
    await expect(vendorCatalogue.sheets(as(["technician"]), { workbook: base64(book) })).rejects.toThrow(PermissionError);
    await expect(vendorCatalogue.sheets(as(["dispatcher"]), { workbook: base64(book) })).rejects.toThrow(PermissionError);
    expect(routes.listVendorCatalogueSheets.permissions).toEqual(["vendor:write", "pricebook:write"]);
  });
});
