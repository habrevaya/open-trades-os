import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, imports as rules, type Actor } from "@opentradesos/core";
import * as imports from "../src/services/imports";
import { routes } from "../src/contracts/index";
import * as workbooks from "../src/imports/workbook";
import { ZipWriter } from "../src/portability/zip";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";
import { buildOds, type OdsCell } from "./ods-builder";

/**
 * AN OPENDOCUMENT SPREADSHEET, BROUGHT IN LIKE A WORKBOOK
 *
 * Each sheet of an .ods is read into the same rows a CSV or an .xlsx makes, so
 * these tests send real .ods files (written by hand in ./ods-builder, the way
 * LibreOffice saves them, trailing million-row repeat and all) and then read what
 * the creates wrote, and drive every refusal the screen promises in words: a
 * file that is another kind of OpenDocument, a password, a file that opens into
 * gigabytes, a row of data repeated past the row cap, a sheet nobody chose.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("spreadsheet-ods:org");
const USER = fixtureId("spreadsheet-ods:user");
const SOURCE = "old-open-document";

let raw: postgres.Sql;

const as = (organizationId: string, userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId, roles: roles as Actor["roles"] },
  db: testDb(url!),
});
const owner = () => as(ORG, USER, ["owner"]);

const FORMULA = '=HYPERLINK("http://evil.example","Click me")';
const base64 = (bytes: Buffer) => bytes.toString("base64");

async function checkAll(ctx: ServiceContext, id: string) {
  let last = await imports.check(ctx, { id });
  while (last.more) last = await imports.check(ctx, { id });
  return last;
}
async function loadAll(ctx: ServiceContext, id: string) {
  let last = await imports.load(ctx, { id });
  while (last.more) last = await imports.load(ctx, { id });
  return last;
}

const CUSTOMER_ROWS: OdsCell[][] = [
  ["Customer ID", "Name", "Email", "Street", "City", "State", "Zip"],
  ["O-1", "Ada Lovelace", "ada@example.com", "1 Analytical Way", "Austin", "TX", 78701],
  ["O-2", "Grace Hopper", "grace@example.com", "2 Compiler Ct", "Austin", "TX", "78702"],
  [null, null, null, null, null, null, null],
  ["O-3", FORMULA, null, "3 Formula Rd", "Austin", "TX", 78703],
  ["O-4", { formula: 'CONCATENATE("Alan ","Turing")', value: "Alan Turing" }, null, "4 Machine St", "Austin", "TX", 78704],
];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Open Document Co", slug: "spreadsheet-ods-co" });
});

afterAll(async () => {
  if (raw) await raw.end();
});

run("choosing a sheet", () => {
  it("lists every sheet with its rows and the start of its header, and why one cannot be brought in", async () => {
    const book = await buildOds([
      { name: "Customers", rows: CUSTOMER_ROWS },
      { name: "Cover", rows: [[null, null], ["Prepared by the office"]] },
      { name: "Prices", rows: [["Code", "Name", "Price"], ["P-1", "Filter", 12.5]] },
    ]);
    const answer = await imports.sheets(owner(), { workbook: base64(book) });
    routes.listImportSheets.output.parse(answer);
    expect(answer.sheets).toEqual([
      { name: "Customers", rows: 4, header: ["Customer ID", "Name", "Email", "Street", "City", "State", "Zip"], why: null },
      { name: "Cover", rows: null, header: [], why: expect.stringContaining('The first row of the sheet "Cover" is empty') },
      { name: "Prices", rows: 1, header: ["Code", "Name", "Price"], why: null },
    ]);
  });

  it("refuses a file with several sheets until one is chosen, naming them, and takes the only sheet unasked", async () => {
    const two = await buildOds([
      { name: "Customers", rows: CUSTOMER_ROWS },
      { name: "Prices", rows: [["Code", "Name", "Price"], ["P-1", "Filter", 12.5]] },
    ]);
    await expect(imports.start(owner(), { kind: "customers", fileName: "book.ods", workbook: base64(two) }))
      .rejects.toThrow('That workbook has 2 sheets: "Customers", "Prices". Say which one to bring in.');
    await expect(imports.start(owner(), { kind: "customers", fileName: "book.ods", workbook: base64(two), sheet: "Nope" }))
      .rejects.toThrow('That workbook has no sheet called "Nope". Its sheets are "Customers", "Prices".');
    const one = await buildOds([{ name: "Sheet1", rows: [["Code", "Name", "Price"], ["ODS-ONLY-1", "Only item", 5]] }]);
    const started = await imports.start(owner(), { kind: "pricebook", fileName: "only.ods", workbook: base64(one) });
    expect(started.sheetName).toBe("Sheet1");
    expect(started.rows).toBe(1);
  });

  it("is the owner's: somebody without data:import cannot even list the sheets", async () => {
    const book = await buildOds([{ name: "Sheet1", rows: [["Name"], ["x"]] }]);
    await expect(imports.sheets(as(ORG, USER, ["technician"]), { workbook: base64(book) }))
      .rejects.toBeInstanceOf(PermissionError);
    await expect(imports.start(as(ORG, USER, ["technician"]), { kind: "customers", fileName: "x.ods", workbook: base64(book) }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("a sheet goes through the same mapping and checks as a CSV", () => {
  let runId = "";

  it("keeps each row's number from the sheet, drops the blank row, and ignores the trailing repeat", async () => {
    const book = await buildOds([{ name: "Customers", rows: CUSTOMER_ROWS }, { name: "Spare", rows: [["x"], ["y"]] }]);
    const started = await imports.start(owner(), {
      kind: "customers", fileName: "clients.ods", workbook: base64(book), sheet: "Customers",
    });
    routes.startImport.output.parse(started);
    runId = started.id;
    expect(started.fileName).toBe("clients.ods");
    expect(started.sheetName).toBe("Customers");
    expect(started.rows).toBe(4);
    expect(started.columns).toEqual(["ref", "name", "email", "street", "city", "state", "zip"]);
    const rows = await raw<{ row_number: number }[]>`
      select row_number from public.import_row where run_id = ${runId} order by row_number`;
    expect(rows.map((r) => r.row_number)).toEqual([2, 3, 5, 6]);
    /** A zip held as a number comes through as its digits. */
    expect(started.preview[0]!.values).toMatchObject({ ref: "O-1", name: "Ada Lovelace", zip: "78701" });
  });

  it("reads a formula as the answer stored beside it, and text that looks like one as text", async () => {
    const mapped = await imports.map(owner(), {
      id: runId, columns: (await imports.get(owner(), { id: runId })).columns, source: SOURCE, dayFirst: false,
    });
    expect(mapped.refused).toEqual([]);
    await checkAll(owner(), runId);
    const loaded = await loadAll(owner(), runId);
    expect(loaded.counts).toMatchObject({ loaded: 4, refused: 0 });
    const made = await raw<{ source_id: string; name: string }[]>`
      select source_id, name from public.customer where organization_id = ${ORG} and source_system = ${SOURCE} order by source_id`;
    expect(made).toEqual([
      { source_id: "O-1", name: "Ada Lovelace" },
      { source_id: "O-2", name: "Grace Hopper" },
      { source_id: "O-3", name: FORMULA },
      { source_id: "O-4", name: "Alan Turing" },
    ]);
  });

  it("brings the same sheet in again without making copies", async () => {
    const book = await buildOds([{ name: "Customers", rows: CUSTOMER_ROWS }]);
    const again = await imports.start(owner(), { kind: "customers", fileName: "clients-again.ods", workbook: base64(book) });
    await imports.map(owner(), { id: again.id, columns: again.columns, source: SOURCE, dayFirst: false });
    const checked = await checkAll(owner(), again.id);
    expect(checked.counts).toMatchObject({ already: 4, ready: 0 });
  });

  it("reads amounts, yes or no cells, dates and times as a CSV's text would be, and a header held in its group", async () => {
    const book = await buildOds([{
      name: "Prices",
      rows: [
        ["Code", "Name", "Price", "Cost", "Taxable"],
        ["ODS-PRICE-1", "Computed price", { formula: "A1*1.0825", value: 108.25000000000001 }, 40, true],
        ["ODS-PRICE-2", "Plain price", 19.99, null, false],
      ],
    }], { headerGroup: true });
    const started = await imports.start(owner(), { kind: "pricebook", fileName: "prices.ods", workbook: base64(book) });
    expect(started.columns).toEqual(["code", "name", "price", "cost", "taxable"]);
    expect(started.preview.map((p) => p.values)).toEqual([
      { code: "ODS-PRICE-1", name: "Computed price", price: "108.2500", cost: "40.0000", taxable: "true" },
      { code: "ODS-PRICE-2", name: "Plain price", price: "19.9900", taxable: "false" },
    ]);
  });

  it("reads a date as the day it shows and a date with a time as both, and a time alone as the clock", async () => {
    const book = await buildOds([{
      name: "Notes",
      rows: [
        ["Customer ID", "Note", "Date", "Time"],
        ["O-1", "Asked about the furnace", new Date(Date.UTC(2021, 2, 4)), new Date(Date.UTC(1899, 11, 30, 14, 30))],
        ["O-2", "Called back", new Date(Date.UTC(2021, 2, 5, 9, 15)), null],
      ],
    }]);
    const started = await imports.start(owner(), { kind: "notes", fileName: "notes.ods", workbook: base64(book) });
    expect(started.preview.map((p) => p.values)).toMatchObject([
      { customerRef: "O-1", notedOn: "2021-03-04" },
      { customerRef: "O-2", notedOn: "2021-03-05", notedTime: "09:15" },
    ]);
    const sheets = await imports.sheets(owner(), { workbook: base64(book) });
    expect(sheets.sheets[0]).toMatchObject({ rows: 2, why: null });
  });

  it("keeps the words of a cell and not its comment, joins its paragraphs, empties an error, and passes over merged cells", async () => {
    const book = await buildOds([{
      name: "Notes",
      rows: [
        ["Code", "Name", "Price", "Cost"],
        [
          "ODS-RAW-1",
          { raw: '<table:table-cell office:value-type="string"><office:annotation><text:p>Secret comment: ask Bob</text:p></office:annotation><text:p>Line one</text:p><text:p>Line  <text:s text:c="2"/>two &amp; more</text:p></table:table-cell>' },
          7,
          { error: "#N/A" },
        ],
        [
          "ODS-RAW-2",
          { raw: '<table:table-cell table:number-columns-spanned="2" office:value-type="string"><text:p>Merged</text:p></table:table-cell><table:covered-table-cell/>' },
          8,
        ],
      ],
    }]);
    const started = await imports.start(owner(), { kind: "pricebook", fileName: "raw.ods", workbook: base64(book) });
    const values = started.preview.map((p) => p.values);
    expect(values[0]).toMatchObject({ code: "ODS-RAW-1", name: "Line one\nLine    two & more", price: "7.0000" });
    expect(values[0]).not.toHaveProperty("cost");
    expect(JSON.stringify(values)).not.toContain("Secret comment");
    // The covered cell holds the place of the merged one, so the 8 lands under Cost and not Price.
    const read = await workbooks.readSheet(book, undefined);
    expect(read.rows[1]).toEqual(["ODS-RAW-2", "Merged", "", "8"]);
    expect(read.numbers).toEqual([2, 3]);
  });

  it("counts a row of data that repeats as that many rows, with their own numbers in the sheet", async () => {
    const book = await buildOds([{
      name: "Prices",
      rows: [
        ["Code", "Name", "Price"],
        ["ODS-REP-1", "First", 1],
        [{ raw: '<table:table-cell office:value-type="string"><text:p>ODS-REP-2</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Twice</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1" office:value-type="float" office:value="2"/>' }],
      ],
    }], { after: '<table:table-row table:number-rows-repeated="3"><table:table-cell office:value-type="string"><text:p>ODS-REP-3</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Thrice</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>' });
    const started = await imports.start(owner(), { kind: "pricebook", fileName: "repeat.ods", workbook: base64(book) });
    expect(started.rows).toBe(5);
    const rows = await raw<{ row_number: number }[]>`
      select row_number from public.import_row where run_id = ${started.id} order by row_number`;
    expect(rows.map((r) => r.row_number)).toEqual([2, 3, 4, 5, 6]);
  });

  it("does not expand an entity the file defines", async () => {
    const book = await buildOds([{
      name: "Prices",
      rows: [["Code", "Name", "Price"], [{ raw: '<table:table-cell office:value-type="string"><text:p>ODS-ENT-1</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>&lol9;</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="3"/>' }]],
    }]);
    const started = await imports.start(owner(), { kind: "pricebook", fileName: "entity.ods", workbook: base64(book) });
    expect(started.preview[0]!.values).toMatchObject({ name: "&lol9;" });
  });
});

run("refusals, in words", () => {
  it("refuses an OpenDocument file that is not a spreadsheet, and a zip that is not OpenDocument at all", async () => {
    const text = await buildOds([{ name: "Sheet1", rows: [["a"], ["b"]] }], { mimetype: "application/vnd.oasis.opendocument.text" });
    await expect(imports.sheets(owner(), { workbook: base64(text) }))
      .rejects.toThrow(/OpenDocument file, but not a spreadsheet/);
    const odd = await buildOds([{ name: "Sheet1", rows: [["a"], ["b"]] }], { mimetype: "application/zip" });
    await expect(imports.sheets(owner(), { workbook: base64(odd) })).rejects.toThrow(/does not look like an .xlsx workbook/);
  });

  it("refuses a file protected with a password, which the zip does not say", async () => {
    const manifest = '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"><manifest:encryption-data manifest:checksum-type="SHA1/1K"/></manifest:file-entry></manifest:manifest>';
    const locked = await buildOds([{ name: "Sheet1", rows: [["a"], ["b"]] }], { manifest });
    await expect(imports.sheets(owner(), { workbook: base64(locked) })).rejects.toThrow(/protected with a password/);
  });

  it("refuses a file that is empty, too large, or not a zip, the way a workbook is", async () => {
    await expect(imports.sheets(owner(), { workbook: Buffer.alloc(0).toString("base64") })).rejects.toThrow();
    const book = await buildOds([{ name: "Sheet1", rows: [["a"], ["b"]] }]);
    const big = Buffer.concat([book, Buffer.alloc(rules.MAX_BYTES)]);
    await expect(imports.sheets(owner(), { workbook: base64(big) })).rejects.toThrow(/Bring in at most 5 MB/);
    await expect(imports.sheets(owner(), { workbook: Buffer.from("plain text").toString("base64") })).rejects.toThrow(/does not look like an .xlsx workbook/);
  });

  it("refuses a file that opens into far more than it says, without reading it", async () => {
    const chunks: Buffer[] = [];
    const zip = new ZipWriter(async (chunk) => { chunks.push(Buffer.from(chunk)); }, new Date("2024-01-01T00:00:00Z"));
    await zip.addFile("mimetype", Buffer.from("application/vnd.oasis.opendocument.spreadsheet"));
    const entry = await zip.begin("content.xml");
    const block = Buffer.alloc(1024 * 1024, 0x20);
    for (let i = 0; i < Math.ceil(rules.MAX_OPENED_BYTES / (1024 * 1024)) + 2; i++) await entry.write(block);
    await entry.end();
    await zip.finish();
    await expect(imports.sheets(owner(), { workbook: base64(Buffer.concat(chunks)) }))
      .rejects.toThrow(/far larger inside than its size says/);
  });

  it("refuses a row of data repeated past the row cap before building any of it", async () => {
    const book = await buildOds([{ name: "Prices", rows: [["Code", "Name"]] }], {
      after: '<table:table-row table:number-rows-repeated="900000000"><table:table-cell office:value-type="string"><text:p>boom</text:p></table:table-cell></table:table-row>',
    });
    const answer = await imports.sheets(owner(), { workbook: base64(book) });
    expect(answer.sheets[0]).toMatchObject({ rows: null, why: expect.stringContaining("has data down to row 900,000,001") });
    await expect(imports.start(owner(), { kind: "pricebook", fileName: "bomb.ods", workbook: base64(book) }))
      .rejects.toThrow(/Bring in at most 10,000 rows at a time/);
  });

  it("reads as many rows as a file may hold and refuses one more, with their numbers from the sheet", async () => {
    const rows = (n: number): OdsCell[][] => [["Code", "Name", "Price"], ...Array.from({ length: n }, (_, i): OdsCell[] => [`ODS-BIG-${i}`, `Item ${i}`, i])];
    const full = await buildOds([{ name: "Big", rows: rows(rules.MAX_ROWS) }]);
    const read = await workbooks.readSheet(full, undefined);
    expect(read.rows).toHaveLength(rules.MAX_ROWS);
    expect(read.numbers[rules.MAX_ROWS - 1]).toBe(rules.MAX_ROWS + 1);
    const over = await buildOds([{ name: "Big", rows: rows(rules.MAX_ROWS + 1) }]);
    await expect(workbooks.readSheet(over, undefined)).rejects.toThrow(/Bring in at most 10,000 rows at a time/);
  });

  it("refuses a cell of data repeated past the column cap, and data past the last column it will read", async () => {
    const wide = await buildOds([{ name: "Wide", rows: [["Code"], [{ repeat: 100000, value: "x" }]] }]);
    await expect(imports.start(owner(), { kind: "pricebook", fileName: "wide.ods", workbook: base64(wide) }))
      .rejects.toThrow(/reaches column 100,000\. Bring in at most 500 columns/);
  });

  it("refuses a workbook of more sheets than it lists", async () => {
    const sheets = Array.from({ length: rules.MAX_SHEETS + 1 }, (_, i) => ({ name: `S${i}`, rows: [["a"], ["b"]] as OdsCell[][] }));
    const book = await buildOds(sheets);
    await expect(imports.sheets(owner(), { workbook: base64(book) })).rejects.toThrow(/has 51 sheets/);
  });

  it("is damaged, in words, when the content is missing", async () => {
    const chunks: Buffer[] = [];
    const zip = new ZipWriter(async (chunk) => { chunks.push(Buffer.from(chunk)); }, new Date("2024-01-01T00:00:00Z"));
    await zip.addFile("mimetype", Buffer.from("application/vnd.oasis.opendocument.spreadsheet"));
    await zip.finish();
    await expect(imports.sheets(owner(), { workbook: base64(Buffer.concat(chunks)) })).rejects.toThrow(/could not be read/);
  });
});
