import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { imports as rules, type Actor } from "@opentradesos/core";
import * as imports from "../src/services/imports";
import * as estimates from "../src/services/estimates";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";
import { buildWorkbook } from "./xlsx-builder";

/**
 * THE LAST GAPS IN BRINGING IN A SPREADSHEET (M30)
 *
 * The day an estimate was turned into a job, the hour a note was written, a past
 * visit that a crew went on, and an invoice line that names its price book item
 * and the discount taken off it. Each goes through the same mapping, the same
 * checks and the same creates as the rest of the file, and each is read back from
 * the tables rather than from what the import said it did.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("spreadsheet-polish:org");
const USER = fixtureId("spreadsheet-polish:user");
const RAY = fixtureId("spreadsheet-polish:ray");
const SAM = fixtureId("spreadsheet-polish:sam");
const SOURCE = "old-polish";

let raw: postgres.Sql;
let rayTech = "";
let samTech = "";
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: testDb(url!),
});

const csvOf = (rows: string[][]) =>
  `${rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n")}\r\n`;

async function drain(step: () => Promise<{ more: boolean }>) {
  let last = await step();
  while (last.more) last = await step();
  return last;
}

async function bringIn(kind: rules.ImportKind, file: { csv: string } | { workbook: string; sheet?: string }) {
  const started = await imports.start(owner(), { kind, fileName: `${kind}.file`, ...file });
  await imports.map(owner(), { id: started.id, columns: started.columns, source: SOURCE, dayFirst: false });
  const checked = await drain(() => imports.check(owner(), { id: started.id })) as Awaited<ReturnType<typeof imports.check>>;
  const loaded = await drain(() => imports.load(owner(), { id: started.id })) as Awaited<ReturnType<typeof imports.load>>;
  return { started, checked, loaded, detail: await imports.get(owner(), { id: started.id }) };
}

const technician = async (id: string, email: string, name: string) => {
  await raw`delete from public."user" where id = ${id} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${id}, ${email}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${id}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id;
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Polish Co", slug: "spreadsheet-polish-co" });
  rayTech = await technician(RAY, "ray@polish-co.test", "Ray Ortega");
  samTech = await technician(SAM, "sam@polish-co.test", "Sam Ruiz");
  await bringIn("customers", { csv: csvOf([
    ["Customer ID", "Name", "Email", "Street", "City", "State", "Zip"],
    ["C-1", "Ada Lovelace", "ada@polish.test", "1 Engine Way", "Austin", "TX", "78701"],
  ]) });
  await bringIn("jobs", { csv: csvOf([
    ["Job ID", "Job number", "Customer ID", "Summary", "Status", "Finished on"],
    ["J-1", "77101", "C-1", "Furnace tune up", "completed", "2021-03-04"],
    ["J-2", "77102", "C-1", "New heat pump", "completed", "2022-03-20"],
  ]) });
  await bringIn("pricebook", { csv: csvOf([
    ["Item ID", "Code", "Name", "Price", "Kind"],
    ["P-1", "FILTER-1", "Pleated filter", "50.00", "material"],
    ["P-2", "TUNE-1", "Seasonal tune up", "120.00", "service"],
  ]) });
});

afterAll(async () => { if (raw) await raw.end(); });

const ESTIMATE_HEADER = ["Estimate #", "Customer ID", "Job ID", "Date", "Sent On", "Line item", "Qty", "Price Each", "Tax", "Total", "Status", "Decided On", "Converted On", "Lost Reason"];
const estimateRow = (cells: Record<string, string>) => ESTIMATE_HEADER.map((h) => cells[h] ?? "");
const quote = (number: string, extra: Record<string, string>) => estimateRow({
  "Estimate #": number, "Customer ID": "C-1", Date: "2022-02-01", "Sent On": "2022-02-02", "Line item": "Heat pump",
  Qty: "1", "Price Each": "1000", Tax: "0", Total: "1000", ...extra,
});

run("the day an estimate was turned into a job", () => {
  it("records the estimate as converted on that day, tied to its job, and a second convert makes no second job", async () => {
    const result = await bringIn("estimates", { csv: csvOf([
      ESTIMATE_HEADER,
      quote("6101", { "Job ID": "J-2", Status: "Won", "Decided On": "2022-02-10", "Converted On": "2022-03-01" }),
      quote("6102", { Status: "Won", "Decided On": "2022-02-10" }),
      quote("6103", { Status: "Won", "Decided On": "2022-02-10", "Converted On": "2022-02-05" }),
      quote("6104", { Status: "Lost", "Decided On": "2022-02-10", "Converted On": "2022-03-01" }),
      quote("6105", { "Sent On": "", "Converted On": "2022-03-01" }),
    ]) });
    expect(result.loaded.counts).toMatchObject({ loaded: 2, refused: 3 });
    const reasons = result.detail.refused.map((r) => r.reason).join(" | ");
    expect(reasons).toContain("It was turned into a job on 2022-02-05, before it was approved on 2022-02-10.");
    expect(reasons).toContain("Only an approved estimate is turned into a job.");

    const rows = await raw<{ number: number; status: string; converted: string | null; job: string | null }[]>`
      select e.number, e.status, (e.converted_at at time zone 'America/Chicago')::date::text as converted, j.number::text as job
      from public.estimate e left join public.job j on j.id = e.job_id
      where e.organization_id = ${ORG} and e.source_system = ${SOURCE} order by e.number`;
    expect(rows).toEqual([
      { number: 6101, status: "converted", converted: "2022-03-01", job: "77102" },
      { number: 6102, status: "approved", converted: null, job: null },
    ]);

    const [made] = await raw<{ id: string }[]>`select id from public.estimate where organization_id = ${ORG} and number = 6101`;
    const again = await estimates.convert(owner(), { id: made!.id, createJob: true, createInvoice: false });
    expect(again.estimate.status).toBe("converted");
    expect(new Date(again.estimate.convertedAt!).toISOString().slice(0, 10)).toBe("2022-03-01");
    expect(again.jobId).toBe(again.estimate.jobId);
    const [jobs] = await raw<{ n: number }[]>`select count(*)::int as n from public.job where organization_id = ${ORG}`;
    expect(jobs!.n).toBe(2);
  });

  it("stamps the moment of a conversion done here", async () => {
    const [made] = await raw<{ id: string }[]>`select id from public.estimate where organization_id = ${ORG} and number = 6102`;
    const converted = await estimates.convert(owner(), { id: made!.id, createJob: true, createInvoice: false });
    expect(converted.estimate.status).toBe("converted");
    expect(converted.estimate.convertedAt).not.toBeNull();
  });
});

run("a note's time", () => {
  it("keeps the hour from a Time column or from a date written at a time, and refuses two that disagree", async () => {
    const result = await bringIn("notes", { csv: csvOf([
      ["Note ID", "Customer ID", "Date", "Time", "Note"],
      ["N-1", "C-1", "2021-03-04", "2:30 PM", "Side gate sticks."],
      ["N-2", "C-1", "3/5/2021 9:15 AM", "", "Dog in the yard."],
      ["N-3", "C-1", "2021-03-06 08:00", "09:00", "Two hours at once."],
      ["N-4", "C-1", "2021-03-07", "", "Only a day."],
      ["N-5", "C-1", "2021-03-08", "half past two", "Not a time."],
    ]) });
    expect(result.loaded.counts).toMatchObject({ loaded: 3, refused: 2 });
    const reasons = result.detail.refused.map((r) => r.reason).join(" | ");
    expect(reasons).toContain("The day says 08:00 and Time written says 09:00. Keep one of them.");
    expect(reasons).toContain("is not a time this can read");

    const notes = await raw<{ source_id: string; at: string }[]>`
      select source_id, to_char(noted_at at time zone 'America/Chicago', 'YYYY-MM-DD HH24:MI') as at
      from public.customer_note where organization_id = ${ORG} and source_system = ${SOURCE} order by source_id`;
    expect(notes).toEqual([
      { source_id: "N-1", at: "2021-03-04 14:30" },
      { source_id: "N-2", at: "2021-03-05 09:15" },
      { source_id: "N-4", at: "2021-03-07 12:00" },
    ]);
  });

  it("reads the time out of a workbook's date cell", async () => {
    const book = await buildWorkbook([{
      name: "Notes",
      rows: [
        ["Note ID", "Customer ID", "Created", "Note"],
        ["W-1", "C-1", new Date(Date.UTC(2021, 8, 2, 16, 45)), "Called back about the quote."],
      ],
    }]);
    const result = await bringIn("notes", { workbook: book.toString("base64"), sheet: "Notes" });
    expect(result.loaded.counts).toMatchObject({ loaded: 1 });
    const [note] = await raw<{ at: string }[]>`
      select to_char(noted_at at time zone 'America/Chicago', 'YYYY-MM-DD HH24:MI') as at
      from public.customer_note where organization_id = ${ORG} and source_id = 'W-1'`;
    expect(note!.at).toBe("2021-09-02 16:45");
  });
});

run("a past visit a crew went on", () => {
  it("puts every technician named on the visit, and refuses one nobody on the board signs in as", async () => {
    const result = await bringIn("visits", { csv: csvOf([
      ["Visit ID", "Job ID", "Technician email", "Visit date", "Start time", "End time"],
      ["V-1", "J-1", "ray@polish-co.test; SAM@polish-co.test", "2021-03-04", "9:00 AM", "11:00 AM"],
      ["V-2", "J-1", "ray@polish-co.test, nobody@polish-co.test", "2021-03-05", "9:00 AM", "11:00 AM"],
      ["V-3", "J-1", "ray@polish-co.test;ray@polish-co.test", "2021-03-06", "9:00 AM", "11:00 AM"],
      ["V-4", "J-1", "ray@polish-co.test; not an email", "2021-03-07", "9:00 AM", "11:00 AM"],
    ]) });
    expect(result.loaded.counts).toMatchObject({ loaded: 2, refused: 2 });
    const reasons = result.detail.refused.map((r) => r.reason).join(" | ");
    expect(reasons).toMatch(/Nobody on the board signs in with nobody@polish-co.test/);
    expect(reasons).toMatch(/"not an email" is not an email address/);

    const crews = await raw<{ source_id: string; technicians: string[] }[]>`
      select v.source_id, array_agg(a.technician_id::text order by a.technician_id) as technicians
      from public.visit v join public.visit_assignment a on a.visit_id = v.id
      where v.organization_id = ${ORG} and v.source_system = ${SOURCE} group by v.source_id order by v.source_id`;
    expect(crews).toEqual([
      { source_id: "V-1", technicians: [rayTech, samTech].sort() },
      /** The same address twice is one technician. */
      { source_id: "V-3", technicians: [rayTech] },
    ]);
  });
});

const INVOICE_HEADER = ["Invoice ID", "Customer ID", "Invoice Date", "Item code", "Description", "Qty", "Price Each", "Discount", "Before tax", "Tax", "Total"];
const invoiceRow = (cells: Record<string, string>) => INVOICE_HEADER.map((h) => cells[h] ?? "");

run("an invoice line with a price book item and a discount", () => {
  it("links the item, keeps what was charged, and takes the discount off the line", async () => {
    const result = await bringIn("invoices", { csv: csvOf([
      INVOICE_HEADER,
      invoiceRow({ "Invoice ID": "I-1", "Customer ID": "C-1", "Invoice Date": "2022-04-01", "Item code": "filter-1", Description: "Filters for the shop", Qty: "2", "Price Each": "50", Discount: "10", "Before tax": "90.00", Tax: "7.43", Total: "205.68" }),
      invoiceRow({ "Invoice ID": "I-1", "Item code": "TUNE-1", Qty: "1", "Price Each": "100", "Before tax": "100", Tax: "8.25", Total: "205.68" }),
      invoiceRow({ "Invoice ID": "I-2", "Customer ID": "C-1", "Invoice Date": "2022-04-02", "Item code": "NOPE-9", Description: "Mystery", Qty: "1", "Price Each": "10", "Before tax": "10", Tax: "0", Total: "10" }),
      invoiceRow({ "Invoice ID": "I-3", "Customer ID": "C-1", "Invoice Date": "2022-04-03", Description: "Too much off", Qty: "1", "Price Each": "10", Discount: "11", "Before tax": "10", Tax: "0", Total: "10" }),
      invoiceRow({ "Invoice ID": "I-4", "Customer ID": "C-1", "Invoice Date": "2022-04-04", Description: "Wrong amount", Qty: "2", "Price Each": "50", Discount: "10", "Before tax": "100", Tax: "0", Total: "100" }),
      invoiceRow({ "Invoice ID": "I-5", "Customer ID": "C-1", "Invoice Date": "2022-04-05", "Item code": "P-2", Description: "By their id", Qty: "1", "Price Each": "120", "Before tax": "120", Tax: "0", Total: "120" }),
    ]) });
    expect(result.started.columns).toEqual(["ref", "customerRef", "issuedOn", "itemRef", "description", "quantity", "unitPrice", "discount", "subtotal", "tax", "total"]);
    expect(result.loaded.counts).toMatchObject({ loaded: 3, refused: 3 });
    const reasons = result.detail.refused.map((r) => r.reason).join(" | ");
    expect(reasons).toContain("There is no price book item NOPE-9.");
    expect(reasons).toContain("The discount of 11.00 is more than the 10.00 the line comes to before it.");
    expect(reasons).toContain("2 at 50.00 less 10.00 is 90.00, not the 100.00 in Before tax.");

    const lines = await raw<{ source_id: string; name: string; qty: string; price: string; discount: string; item: string | null; tax: string }[]>`
      select i.source_id, l.name, l.quantity::text as qty, l.unit_price::text as price, l.discount_amount::text as discount,
        pi.code as item, l.tax_amount::text as tax
      from public.invoice_line l join public.invoice i on i.id = l.invoice_id
      left join public.price_book_item_version v on v.id = l.price_book_item_version_id
      left join public.price_book_item pi on pi.id = v.item_id
      where i.organization_id = ${ORG} and i.source_system = ${SOURCE} order by i.source_id, l.sort_order`;
    expect(lines.map((l) => [l.source_id, l.name, Number(l.qty), Number(l.price), Number(l.discount), l.item, Number(l.tax)])).toEqual([
      ["I-1", "Filters for the shop", 2, 50, 10, "FILTER-1", 7.43],
      /** Not worded in the file, so called what the item is called. */
      ["I-1", "Seasonal tune up", 1, 100, 0, "TUNE-1", 8.25],
      ["I-5", "By their id", 1, 120, 0, "TUNE-1", 0],
    ]);
    /** The item kept the price it has; the line kept the price it was charged. */
    const [item] = await raw<{ price: string }[]>`
      select v.price::text from public.price_book_item_version v join public.price_book_item i on i.id = v.item_id
      where i.organization_id = ${ORG} and i.code = 'TUNE-1'`;
    expect(Number(item!.price)).toBe(120);

    const [invoice] = await raw<{ total: string; discount_total: string }[]>`
      select total::text, discount_total::text from public.invoice where organization_id = ${ORG} and source_id = 'I-1'`;
    expect(Number(invoice!.total)).toBe(205.68);
    expect(Number(invoice!.discount_total)).toBe(10);
  });

  it("refuses a mapping that has a discount and no price each", async () => {
    const started = await imports.start(owner(), { kind: "invoices", fileName: "discount.csv", csv: csvOf([
      ["Invoice ID", "Customer ID", "Invoice Date", "Discount", "Total"],
      ["I-9", "C-1", "2022-04-09", "5", "95"],
    ]) });
    const mapped = await imports.map(owner(), { id: started.id, columns: started.columns, source: SOURCE, dayFirst: false });
    expect(mapped.problems.join(" ")).toMatch(/Discount and none to Price each/);
  });
});
