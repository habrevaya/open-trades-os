import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { imports as rules, type Actor } from "@opentradesos/core";
import * as imports from "../src/services/imports";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";
import { buildWorkbook, type Cell } from "./xlsx-builder";

/**
 * AN ESTIMATE THAT ARRIVES WHOLE
 *
 * A file with a row per line brings in an estimate with its options and its
 * lines, each option's total checked against the file's, the option the
 * customer chose taken from the file and never guessed, and every disagreement
 * refused in words naming the rows. The estimates are then read back from the
 * tables, not from what the import said it did.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("spreadsheet-estimates:org");
const USER = fixtureId("spreadsheet-estimates:user");
const SOURCE = "old-quotes";

let raw: postgres.Sql;
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: testDb(url!),
});

const csvOf = (rows: string[][]) =>
  `${rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n")}\r\n`;

async function checkAll(id: string) {
  let last = await imports.check(owner(), { id });
  while (last.more) last = await imports.check(owner(), { id });
  return last;
}
async function loadAll(id: string) {
  let last = await imports.load(owner(), { id });
  while (last.more) last = await imports.load(owner(), { id });
  return last;
}

async function bringIn(kind: rules.ImportKind, csv: string) {
  const started = await imports.start(owner(), { kind, fileName: `${kind}.csv`, csv });
  await imports.map(owner(), { id: started.id, columns: started.columns, source: SOURCE, dayFirst: false });
  return { started, checked: await checkAll(started.id) };
}

const HEADER = ["Estimate #", "Customer ID", "Title", "Date", "Sent On", "Option", "Line item", "Qty", "Price Each", "Tax", "Total",
  "Recommended", "Status", "Decided On", "Chosen", "Lost Reason"];

/** A row of the estimates file, in the header's order, with the cells it names. */
const line = (cells: Record<string, string>) => HEADER.map((h) => cells[h] ?? "");

/** Good: 3000 + 150 + 247.50 tax = 3397.50. Better: 4200 + 150 + 346.50 tax = 4696.50. */
const WON = [
  line({ "Estimate #": "9401", "Customer ID": "Q-1", Title: "New furnace", Date: "2022-02-01", "Sent On": "2022-02-02", Option: "Good", "Line item": "Furnace", Qty: "1", "Price Each": "3000", Tax: "247.50", Total: "3397.50", Recommended: "no", Status: "Won", "Decided On": "2022-02-10", Chosen: "no" }),
  line({ "Estimate #": "9401", Option: "Good", "Line item": "Install", Qty: "5", "Price Each": "30", Tax: "0", Total: "3397.50" }),
  line({ "Estimate #": "9401", Option: "Better", "Line item": "Furnace plus filter", Qty: "1", "Price Each": "4200", Tax: "346.50", Total: "4696.50", Recommended: "yes", Chosen: "yes" }),
  line({ "Estimate #": "9401", Option: "Better", "Line item": "Install", Qty: "5", "Price Each": "30", Tax: "0", Total: "4696.50" }),
];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Estimates Co", slug: "spreadsheet-estimates-co" });
  /** The customers an estimate is for, with the addresses an estimate needs, brought in the way an owner would. */
  const { started } = await bringIn("customers", csvOf([
    ["Customer ID", "Name", "Street", "City", "State", "Zip"],
    ["Q-1", "Quote Ada", "1 Quote Way", "Austin", "TX", "78701"],
    ["Q-2", "Quote Grace", "2 Quote Way", "Austin", "TX", "78702"],
  ]));
  await loadAll(started.id);
});

afterAll(async () => { if (raw) await raw.end(); });

const optionsOf = (number: number) => raw<{ name: string; total: string; tax_total: string; is_recommended: boolean; chosen: boolean; lines: number }[]>`
  select o.name, o.total::text, o.tax_total::text, o.is_recommended, e.selected_option_id = o.id as chosen,
    (select count(*)::int from public.estimate_line l where l.option_id = o.id) as lines
  from public.estimate_option o join public.estimate e on e.id = o.estimate_id
  where e.organization_id = ${ORG} and e.number = ${number} order by o.name`;

run("an estimate with options and lines", () => {
  it("loads each option with its lines, its totals as the file has them and the option the customer chose", async () => {
    const { started, checked } = await bringIn("estimates", csvOf([HEADER, ...WON]));
    expect(started.columns).toEqual(["number", "customerRef", "title", "issuedOn", "sentOn", "option", "lineName", "quantity", "unitPrice", "tax", "total", "recommended", "outcome", "decidedOn", "chosen", "reason"]);
    expect(checked.counts).toMatchObject({ ready: 4, refused: 0 });
    const loaded = await loadAll(started.id);
    expect(loaded.counts).toMatchObject({ loaded: 4 });

    const [made] = await raw<{ id: string; number: number; status: string; sent: string | null; decided: string | null; title: string | null }[]>`
      select id, number, status, title,
        (sent_at at time zone 'America/Chicago')::date::text as sent,
        (decided_at at time zone 'America/Chicago')::date::text as decided
      from public.estimate where organization_id = ${ORG} and source_system = ${SOURCE} and source_id = '9401'`;
    expect(made).toMatchObject({ number: 9401, status: "approved", title: "New furnace", sent: "2022-02-02", decided: "2022-02-10" });

    const options = await optionsOf(9401);
    expect(options.map((o) => [o.name, Number(o.total), Number(o.tax_total), o.is_recommended, o.chosen, o.lines])).toEqual([
      ["Better", 4696.5, 346.5, true, true, 2],
      ["Good", 3397.5, 247.5, false, false, 2],
    ]);

    const lines = await raw<{ option: string; name: string; quantity: string; unit_price: string; taxable: boolean; tax_rate: string }[]>`
      select o.name as option, l.name, l.quantity::text, l.unit_price::text, l.taxable, l.tax_rate::text
      from public.estimate_line l join public.estimate_option o on o.id = l.option_id
      where o.estimate_id = ${made!.id} order by o.name, l.sort_order`;
    expect(lines.map((l) => [l.option, l.name, Number(l.quantity), Number(l.unit_price), l.taxable, Number(l.tax_rate)])).toEqual([
      ["Better", "Furnace plus filter", 1, 4200, true, 0.0825],
      ["Better", "Install", 5, 30, false, 0],
      ["Good", "Furnace", 1, 3000, true, 0.0825],
      ["Good", "Install", 5, 30, false, 0],
    ]);
    const events = await raw`select name from public.domain_event where organization_id = ${ORG} and entity_id = ${made!.id}`;
    expect(events).toEqual([]);
  });

  it("brings the same file in again without making a second estimate", async () => {
    const { checked } = await bringIn("estimates", csvOf([HEADER, ...WON]));
    expect(checked.counts).toMatchObject({ already: 4, ready: 0 });
  });
});

run("an estimate that disagrees with itself is refused in words, naming the rows", () => {
  it("refuses an option whose lines do not come to the total the file gives it", async () => {
    const rows = WON.map((r) => [...r]);
    rows[0]![0] = rows[1]![0] = rows[2]![0] = rows[3]![0] = "9402";
    rows[0]![HEADER.indexOf("Total")] = rows[1]![HEADER.indexOf("Total")] = "3400.00";
    const { started, checked } = await bringIn("estimates", csvOf([HEADER, ...rows]));
    expect(checked.counts).toMatchObject({ refused: 4, ready: 0 });
    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused.map((r) => r.row)).toEqual([2, 3, 4, 5]);
    expect(new Set(detail.refused.map((r) => r.reason))).toEqual(new Set(['The option "Good" comes to 3397.50, not the 3400.00 in Total.']));
  });

  it("refuses an approval that does not say which option the customer chose", async () => {
    const rows = WON.map((r) => [...r]);
    for (const r of rows) { r[0] = "9403"; r[HEADER.indexOf("Chosen")] = ""; }
    const { started, checked } = await bringIn("estimates", csvOf([HEADER, ...rows]));
    expect(checked.counts).toMatchObject({ refused: 4 });
    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused[0]!.reason).toBe("It was approved and the file does not say which of its 2 options the customer chose. Fill in the Chosen column for that option.");
  });

  it("refuses rows that disagree about whose the estimate is", async () => {
    const rows = WON.map((r) => [...r]);
    for (const r of rows) r[0] = "9404";
    rows[3]![HEADER.indexOf("Customer ID")] = "Q-2";
    const { started } = await bringIn("estimates", csvOf([HEADER, ...rows]));
    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused[0]!.reason).toMatch(/Row 2 says Customer's id is Q-1 and row 5 says Q-2. They are one estimate, so they have to agree./);
  });

  it("refuses an estimate that comes out a different total here than the file gives, and keeps none of it", async () => {
    /**
     * Tax of 41,250.37 on 500,000.00 is a rate of 8.250074%, which a rate to six
     * places cannot make exactly: written here it would be 41,250.50. A cent of
     * rounding is one thing and thirteen cents is a quote that disagrees with the
     * customer's copy, so it is refused with both figures rather than loaded.
     */
    const rows = [
      line({ "Estimate #": "9405", "Customer ID": "Q-1", Date: "2022-03-01", Option: "Only", "Line item": "Whole house", Qty: "1", "Price Each": "500000", Tax: "41250.37", Total: "541250.37" }),
    ];
    const { started, checked } = await bringIn("estimates", csvOf([HEADER, ...rows]));
    expect(checked.counts).toMatchObject({ refused: 1, ready: 0 });
    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused[0]!.reason).toMatch(/Written here it comes to 541250.50, not the 541250.37 in the file/);
    expect(await raw`select id from public.estimate where organization_id = ${ORG} and number = 9405`).toEqual([]);
  });
});

run("estimates in their other shapes", () => {
  it("brings an open estimate with two options in as a draft with none recommended, and loads a one row estimate as before", async () => {
    const rows = [
      line({ "Estimate #": "9501", "Customer ID": "Q-2", Title: "Water heater", Date: "2022-04-01", Option: "Standard", "Line item": "40 gallon", Qty: "1", "Price Each": "1200" }),
      line({ "Estimate #": "9501", Option: "Tankless", "Line item": "Tankless unit", Qty: "1", "Price Each": "2400" }),
      line({ "Estimate #": "9502", "Customer ID": "Q-2", Title: "Thermostat", Date: "2022-04-02", "Price Each": "300" }),
    ];
    const { started, checked } = await bringIn("estimates", csvOf([HEADER, ...rows]));
    expect(checked.counts).toMatchObject({ ready: 3, refused: 0 });
    await loadAll(started.id);
    const [draft] = await raw<{ status: string }[]>`select status from public.estimate where organization_id = ${ORG} and number = 9501`;
    expect(draft!.status).toBe("draft");
    expect((await optionsOf(9501)).map((o) => [o.name, Number(o.total), o.is_recommended])).toEqual([["Standard", 1200, false], ["Tankless", 2400, false]]);
    expect((await optionsOf(9502)).map((o) => [o.name, Number(o.total), o.is_recommended])).toEqual([["As quoted", 300, true]]);
  });

  it("reads the options and lines of a workbook sheet the same way", async () => {
    const cells: Cell[][] = [
      ["Quote", "Customer ID", "Package", "Item", "Qty", "Each", "Tax", "Status", "Decided", "Selected", "Date"],
      [9601, "Q-1", "Basic", "Tune up", 1, 100, 8.25, "Won", new Date(Date.UTC(2022, 5, 10)), "yes", new Date(Date.UTC(2022, 5, 1))],
      [9601, "Q-1", "Basic", "Filter", 2, 20, 3.3, "Won", new Date(Date.UTC(2022, 5, 10)), "yes", new Date(Date.UTC(2022, 5, 1))],
      [9601, "Q-1", "Plus", "Tune up and coil clean", 1, 250, 20.63, "Won", new Date(Date.UTC(2022, 5, 10)), "no", new Date(Date.UTC(2022, 5, 1))],
    ];
    const book = await buildWorkbook([{ name: "Quotes", rows: cells }]);
    const started = await imports.start(owner(), { kind: "estimates", fileName: "quotes.xlsx", workbook: book.toString("base64") });
    expect(started.columns).toEqual(["number", "customerRef", "option", "lineName", "quantity", "unitPrice", "tax", "outcome", "decidedOn", "chosen", "issuedOn"]);
    await imports.map(owner(), { id: started.id, columns: started.columns, source: SOURCE, dayFirst: false });
    const checked = await checkAll(started.id);
    expect(checked.counts).toMatchObject({ ready: 3, refused: 0 });
    await loadAll(started.id);
    expect((await optionsOf(9601)).map((o) => [o.name, Number(o.total), o.chosen, o.lines])).toEqual([["Basic", 151.55, true, 2], ["Plus", 270.63, false, 1]]);
  });
});
