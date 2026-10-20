import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, imports as rules, type Actor } from "@opentradesos/core";
import * as imports from "../src/services/imports";
import { routes } from "../src/contracts/index";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";
import { buildWorkbook, tamper, type Cell } from "./xlsx-builder";

/**
 * A WORKBOOK, BROUGHT IN LIKE A CSV
 *
 * Each sheet is read into the same rows a CSV would make, so these tests send
 * real .xlsx files (written by hand in ./xlsx-builder) and then read what the
 * creates wrote, and drive every refusal the screen promises in words: a file
 * that is not a workbook, an old .xls, a password, a workbook that opens into
 * gigabytes, a cell in the far corner of a sheet, a sheet nobody chose.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("spreadsheet-workbooks:org");
const USER = fixtureId("spreadsheet-workbooks:user");
const SOURCE = "old-workbook";

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

const CUSTOMER_ROWS: Cell[][] = [
  ["Customer ID", "Name", "Email", "Street", "City", "State", "Zip"],
  ["W-1", "Ada Lovelace", "ada@example.com", "1 Analytical Way", "Austin", "TX", 78701],
  ["W-2", "Grace Hopper", "grace@example.com", "2 Compiler Ct", "Austin", "TX", "78702"],
  [null, null, null, null, null, null, null],
  ["W-3", FORMULA, null, "3 Formula Rd", "Austin", "TX", 78703],
  ["W-4", { formula: 'CONCATENATE("Alan ","Turing")', value: "Alan Turing" }, null, "4 Machine St", "Austin", "TX", 78704],
];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Workbook Co", slug: "spreadsheet-workbooks-co" });
});

afterAll(async () => {
  if (raw) await raw.end();
});

run("choosing a sheet", () => {
  it("lists every sheet with its rows and the start of its header, and why one cannot be brought in", async () => {
    const book = await buildWorkbook([
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

  it("refuses a workbook with several sheets until one is chosen, naming them", async () => {
    const book = await buildWorkbook([
      { name: "Customers", rows: CUSTOMER_ROWS },
      { name: "Prices", rows: [["Code", "Name", "Price"], ["P-1", "Filter", 12.5]] },
    ]);
    await expect(imports.start(owner(), { kind: "customers", fileName: "book.xlsx", workbook: base64(book) }))
      .rejects.toThrow('That workbook has 2 sheets: "Customers", "Prices". Say which one to bring in.');
    await expect(imports.start(owner(), { kind: "customers", fileName: "book.xlsx", workbook: base64(book), sheet: "Nope" }))
      .rejects.toThrow('That workbook has no sheet called "Nope". Its sheets are "Customers", "Prices".');
  });

  it("never opens a macro: the part that holds one is skipped, whatever is in it", async () => {
    const book = await buildWorkbook(
      [{ name: "Sheet1", rows: [["Code", "Name", "Price"], ["MACRO-1", "Macro book item", 5]] }],
      { extra: { "xl/vbaProject.bin": Buffer.from("Sub AutoOpen(): Shell(\"calc\"): End Sub") } },
    );
    const started = await imports.start(owner(), { kind: "pricebook", fileName: "macro.xlsx", workbook: base64(book) });
    expect(started.rows).toBe(1);
  });

  it("takes the only sheet without being told", async () => {
    const book = await buildWorkbook([{ name: "Sheet1", rows: [["Code", "Name", "Price"], ["ONLY-1", "Only item", 5]] }]);
    const started = await imports.start(owner(), { kind: "pricebook", fileName: "only.xlsx", workbook: base64(book) });
    expect(started.sheetName).toBe("Sheet1");
    expect(started.rows).toBe(1);
  });

  it("is the owner's: somebody without data:import cannot even list the sheets", async () => {
    const book = await buildWorkbook([{ name: "Sheet1", rows: [["Name"], ["x"]] }]);
    await expect(imports.sheets(as(ORG, USER, ["technician"]), { workbook: base64(book) }))
      .rejects.toBeInstanceOf(PermissionError);
    await expect(imports.start(as(ORG, USER, ["technician"]), { kind: "customers", fileName: "x.xlsx", workbook: base64(book) }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("a sheet goes through the same mapping and checks as a CSV", () => {
  let runId = "";

  it("keeps each row's number from the sheet, drops the blank row, and guesses the columns", async () => {
    const book = await buildWorkbook([{ name: "Customers", rows: CUSTOMER_ROWS }, { name: "Spare", rows: [["x"], ["y"]] }]);
    const started = await imports.start(owner(), {
      kind: "customers", fileName: "clients.xlsx", workbook: base64(book), sheet: "Customers",
    });
    routes.startImport.output.parse(started);
    runId = started.id;
    expect(started.fileName).toBe("clients.xlsx");
    expect(started.sheetName).toBe("Customers");
    expect(started.rows).toBe(4);
    expect(started.columns).toEqual(["ref", "name", "email", "street", "city", "state", "zip"]);
    const rows = await raw<{ row_number: number }[]>`
      select row_number from public.import_row where run_id = ${runId} order by row_number`;
    expect(rows.map((r) => r.row_number)).toEqual([2, 3, 5, 6]);
    /** A zip held as a number comes through as its digits. */
    expect(started.preview[0]!.values).toMatchObject({ ref: "W-1", name: "Ada Lovelace", zip: "78701" });
    expect(await imports.list(owner())).toMatchObject({ imports: expect.arrayContaining([expect.objectContaining({ id: runId, sheetName: "Customers" })]) });
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
      { source_id: "W-1", name: "Ada Lovelace" },
      { source_id: "W-2", name: "Grace Hopper" },
      { source_id: "W-3", name: FORMULA },
      { source_id: "W-4", name: "Alan Turing" },
    ]);
  });

  it("brings the same sheet in again without making copies", async () => {
    const book = await buildWorkbook([{ name: "Customers", rows: CUSTOMER_ROWS }]);
    const again = await imports.start(owner(), { kind: "customers", fileName: "clients-again.xlsx", workbook: base64(book) });
    await imports.map(owner(), { id: again.id, columns: again.columns, source: SOURCE, dayFirst: false });
    const checked = await checkAll(owner(), again.id);
    expect(checked.counts).toMatchObject({ already: 4, ready: 0 });
  });

  it("reads dates, amounts with the noise a formula leaves, and yes or no cells, as a CSV's text would be", async () => {
    const book = await buildWorkbook([{
      name: "Prices",
      rows: [
        ["Code", "Name", "Price", "Cost", "Taxable"],
        ["WB-PRICE-1", "Computed price", { formula: "A1*1.0825", value: 108.25000000000001 }, 40, true],
        ["WB-PRICE-2", "Plain price", 19.99, null, false],
      ],
    }]);
    const started = await imports.start(owner(), { kind: "pricebook", fileName: "prices.xlsx", workbook: base64(book) });
    expect(started.columns).toEqual(["code", "name", "price", "cost", "taxable"]);
    expect(started.preview.map((p) => p.values)).toEqual([
      { code: "WB-PRICE-1", name: "Computed price", price: "108.2500", cost: "40.0000", taxable: "true" },
      { code: "WB-PRICE-2", name: "Plain price", price: "19.9900", taxable: "false" },
    ]);
    await imports.map(owner(), { id: started.id, columns: started.columns, source: SOURCE, dayFirst: false });
    await checkAll(owner(), started.id);
    await loadAll(owner(), started.id);
    const items = await raw<{ code: string; price: string; taxable: boolean }[]>`
      select i.code, v.price::text, v.taxable from public.price_book_item i
      join public.price_book_item_version v on v.item_id = i.id and v.effective_to is null
      where i.organization_id = ${ORG} and i.code like 'WB-PRICE-%' order by i.code`;
    expect(items.map((i) => [i.code, Number(i.price), i.taxable])).toEqual([["WB-PRICE-1", 108.25, true], ["WB-PRICE-2", 19.99, false]]);
  });

  it("reads a date cell as the day it shows, and refuses one in the future in words, as a CSV does", async () => {
    const book = await buildWorkbook([{
      name: "Notes",
      rows: [
        ["Customer ID", "Note", "Date"],
        ["W-1", "Asked about the furnace", new Date(Date.UTC(2021, 2, 4))],
        ["W-2", "Called back", new Date(Date.UTC(2090, 0, 1))],
        ["W-2", "Typed as text", "3/9/2021"],
      ],
    }]);
    const started = await imports.start(owner(), { kind: "notes", fileName: "notes.xlsx", workbook: base64(book) });
    expect(started.columns).toEqual(["customerRef", "body", "notedOn"]);
    expect(started.preview[0]!.values).toMatchObject({ notedOn: "2021-03-04" });
    expect(started.refused).toEqual([
      { row: 3, reason: expect.stringContaining("which has not happened yet"), recordId: null, recordLabel: null },
    ]);
  });

  it("hands the refused rows back with their number from the sheet", async () => {
    const book = await buildWorkbook([{
      name: "Customers",
      rows: [["Customer ID", "Name", "Street", "City", "State", "Zip"], [null], ["W-9", FORMULA, "9 Half Address", null, null, null]],
    }]);
    const started = await imports.start(owner(), { kind: "customers", fileName: "bad.xlsx", workbook: base64(book) });
    const file = await imports.refusedFile(owner(), { id: started.id });
    expect(file.fileName).toBe("bad-Customers-refused.csv");
    const lines = file.csv.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[1]).toContain(",3,");
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil.example"",""Click me"")"`);
  });
});

run("a workbook that cannot be read is refused in words", () => {
  const start = (workbook: string, sheet?: string) =>
    imports.start(owner(), { kind: "customers", fileName: "x.xlsx", workbook, ...(sheet ? { sheet } : {}) });
  const GOOD: Cell[][] = [["Name"], ["x"]];

  it("a file that is not a workbook", async () => {
    await expect(start(base64(Buffer.from("Name,Email\r\nAda,ada@example.com\r\n"))))
      .rejects.toThrow("That does not look like an .xlsx workbook");
    await expect(start("")).rejects.toThrow("That file is empty.");
    await expect(start(base64(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9]))))
      .rejects.toThrow("That workbook could not be read");
  });

  it("an older .xls, which is the container a password protected workbook is kept in too", async () => {
    const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
    await expect(start(base64(xls))).rejects.toThrow("an older .xls workbook, or one protected with a password");
  });

  it("a workbook whose parts are marked as encrypted", async () => {
    const book = tamper(await buildWorkbook([{ name: "S", rows: GOOD }]), { flags: 1 });
    await expect(start(base64(book))).rejects.toThrow("protected with a password");
  });

  it("a workbook cut short", async () => {
    const book = await buildWorkbook([{ name: "S", rows: GOOD }]);
    await expect(start(base64(book.subarray(0, book.length - 40)))).rejects.toThrow("That workbook could not be read");
  });

  it("a zip with no workbook in it", async () => {
    const book = await buildWorkbook([{ name: "S", rows: GOOD }]);
    const other = book.toString("latin1").split("xl/workbook.xml").join("xl/notbook.xml");
    await expect(start(base64(Buffer.from(other, "latin1")))).rejects.toThrow(/does not look like an .xlsx workbook|could not be read/);
  });

  it("a file over five megabytes, before it is opened", async () => {
    const big = Buffer.alloc(rules.MAX_BYTES + 1000, 0x50);
    await expect(start(base64(big))).rejects.toThrow("Bring in at most 5 MB at a time");
  });

  it("a small workbook that opens into gigabytes, however small it says its parts are", async () => {
    const bomb = await buildWorkbook([{ name: "S", rows: GOOD }], { inflate: { name: "xl/worksheets/sheet9.xml", megabytes: rules.MAX_OPENED_BYTES / 1024 / 1024 + 20 } });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(start(base64(bomb))).rejects.toThrow("far larger inside than its size says");
    await expect(imports.sheets(owner(), { workbook: base64(bomb) })).rejects.toThrow("far larger inside than its size says");
    const lying = tamper(bomb, { declaredSize: 100 });
    await expect(start(base64(lying))).rejects.toThrow("far larger inside than its size says");
  }, 60_000);

  it("a sheet with a cell in the far corner, which would ask a reader for gigabytes", async () => {
    const rows: Cell[][] = [["Name", "Email"], ["Ada", "ada@example.com"]];
    rows[1 + rules.MAX_ROWS + 5] = ["far away"];
    const sparse = rows.map((r) => r ?? []);
    const book = await buildWorkbook([{ name: "Far", rows: sparse }, { name: "Fine", rows: GOOD }]);
    await expect(start(base64(book), "Far")).rejects.toThrow(/has data down to row 10,0\d\d\. Bring in at most 10,000 rows/);
    /** It is the sheet that is refused, not the workbook: the other can still be chosen. */
    const listed = await imports.sheets(owner(), { workbook: base64(book) });
    expect(listed.sheets.map((s) => [s.name, s.rows, s.why === null])).toEqual([["Far", null, false], ["Fine", 1, true]]);
    expect((await start(base64(book), "Fine")).rows).toBe(1);
  }, 60_000);

  it("a sheet of too many rows, and a sheet of too many columns", async () => {
    const longRows: Cell[][] = [["Name"], ...Array.from({ length: rules.MAX_ROWS + 1 }, (_, i) => [`P${i}`])];
    await expect(start(base64(await buildWorkbook([{ name: "Long", rows: longRows }]))))
      .rejects.toThrow("Bring in at most 10,000 rows at a time");
    const wide: Cell[] = Array.from({ length: rules.MAX_COLUMNS + 2 }, (_, i) => `C${i}`);
    await expect(start(base64(await buildWorkbook([{ name: "Wide", rows: [wide, wide.map(() => "x")] }]))))
      .rejects.toThrow(`Bring in at most ${rules.MAX_COLUMNS} columns`);
  }, 60_000);

  it("exactly the most rows is taken", async () => {
    const rows: Cell[][] = [["Code", "Name", "Price"], ...Array.from({ length: rules.MAX_ROWS }, (_, i) => [`BIG-${i}`, `Item ${i}`, i + 1])];
    const book = await buildWorkbook([{ name: "Big", rows }]);
    expect(book.length).toBeLessThan(rules.MAX_BYTES);
    const started = await imports.start(owner(), { kind: "pricebook", fileName: "big.xlsx", workbook: base64(book) });
    expect(started.rows).toBe(rules.MAX_ROWS);
    expect(started.preview[0]!.values).toMatchObject({ code: "BIG-0", price: "1.0000" });
  }, 60_000);

  it("a sheet whose first row is empty, and a CSV sent as a workbook or a workbook sent as a CSV", async () => {
    await expect(start(base64(await buildWorkbook([{ name: "S", rows: [[null], ["Name"], ["Ada"]] }]))))
      .rejects.toThrow('The first row of the sheet "S" is empty');
    await expect(imports.start(owner(), { kind: "customers", fileName: "x.csv", csv: "PK\u0003\u0004binary" }))
      .rejects.toThrow(/pick CSV/);
    await expect(imports.start(owner(), { kind: "customers", fileName: "x.csv", csv: "Name\r\nAda\r\n", sheet: "S" }))
      .rejects.toThrow("A CSV file has no sheets");
    await expect(imports.start(owner(), { kind: "customers", fileName: "x", csv: "Name\r\nAda\r\n", workbook: "AAAA" }))
      .rejects.toThrow("not both");
    await expect(imports.start(owner(), { kind: "customers", fileName: "x" })).rejects.toThrow("Send the file to bring in");
  });
});
