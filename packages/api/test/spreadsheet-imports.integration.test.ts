import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, imports as rules, type Actor } from "@opentradesos/core";
import * as imports from "../src/services/imports";
import * as customers from "../src/services/customers";
import * as billing from "../src/services/billing";
import * as accounting from "../src/services/accounting";
import { routes } from "../src/contracts/index";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb, companyToday } from "./helpers";

/**
 * A SPREADSHEET, BROUGHT IN BY AN OWNER
 *
 * Every row goes through the create the API already has for that record, so
 * these tests read what those creates wrote (the customer and its address,
 * the ledger's dates, the events the workflows read) rather than what the
 * import said it did. And each refusal the screen promises is driven here:
 * another company's provenance key, a row that would post history into
 * today's books, a file too large, a formula in a cell, and a row that fails
 * after the check, which must not leave its batch half loaded.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("spreadsheet-imports:org");
const USER = fixtureId("spreadsheet-imports:user");
const OTHER = fixtureId("spreadsheet-imports:other-org");
const OTHER_USER = fixtureId("spreadsheet-imports:other-user");
const SOURCE = "old-books";
const ZONE = "America/Chicago";

let raw: postgres.Sql;

const as = (organizationId: string, userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId, roles: roles as Actor["roles"] },
  db: testDb(url!),
});
const owner = () => as(ORG, USER, ["owner"]);
const otherOwner = () => as(OTHER, OTHER_USER, ["owner"]);

const FORMULA = '=HYPERLINK("http://evil.example","Click me")';

const csvOf = (rows: string[][]) =>
  `${rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n")}\r\n`;

const CUSTOMERS = csvOf([
  ["Customer ID", "Name", "Email", "Phone", "Street", "City", "State", "Zip", "Contact Name", "Contact Phone"],
  ["C-1", "Ada Lovelace", "ada@example.com", "5125550101", "1 Analytical Way", "Austin", "TX", "78701", "Byron", "5125550199"],
  ["C-2", "Grace Hopper", "grace@example.com", "", "2 Compiler Ct", "Austin", "TX", "78702", "", ""],
  ["C-3", "Half Address", "", "", "3 Nowhere Ln", "", "", "", "", ""],
  ["C-4", FORMULA, "", "", "", "", "", "", "", ""],
  ["C-5", FORMULA, "", "", "5 Formula Rd", "", "", "", "", ""],
]);

/** Check every batch, then load every batch, as the screen's progress page does. */
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

/** Upload, keep the guessed columns under a source name, check and load. */
async function bringIn(
  ctx: ServiceContext, kind: rules.ImportKind, csv: string, saveAs?: string,
) {
  const started = await imports.start(ctx, { kind, fileName: `${kind}.csv`, csv });
  const mapped = await imports.map(ctx, {
    id: started.id, columns: started.columns, source: SOURCE, dayFirst: false, ...(saveAs ? { saveAs } : {}),
  });
  const checked = await checkAll(ctx, started.id);
  return { started, mapped, checked };
}

async function customersFrom(organizationId: string) {
  return raw<{ id: string; name: string; source_id: string }[]>`
    select id, name, source_id from public.customer
    where organization_id = ${organizationId} and source_system = ${SOURCE} order by source_id`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Spreadsheet Co", slug: "spreadsheet-imports-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: OTHER_USER, name: "Neighbour Co", slug: "spreadsheet-imports-neighbour" });
});

afterAll(async () => {
  if (raw) await raw.end();
});

run("bringing in a customer list", () => {
  let runId = "";

  it("guesses each column from its header and shows the rows as they will land", async () => {
    const started = await imports.start(owner(), { kind: "customers", fileName: "clients.csv", csv: CUSTOMERS });
    routes.startImport.output.parse(started);
    runId = started.id;
    expect(started.columns).toEqual(["ref", "name", "email", "phone", "street", "city", "state", "zip", "contactName", "contactPhone"]);
    expect(started.status).toBe("mapping");
    expect(started.rows).toBe(5);
    expect(started.preview[0]).toEqual({
      row: 2,
      values: expect.objectContaining({ ref: "C-1", name: "Ada Lovelace", street: "1 Analytical Way", zip: "78701" }),
    });
  });

  it("lists every row that will be refused, with the reason in words, before anything is tried", async () => {
    const mapped = await imports.map(owner(), {
      id: runId, columns: (await imports.get(owner(), { id: runId })).columns,
      source: SOURCE, dayFirst: false, saveAs: "From the old books",
    });
    routes.mapImport.output.parse(mapped);
    expect(mapped.mappingName).toBe("From the old books");
    expect(mapped.refused.map((r) => r.row)).toEqual([4, 6]);
    expect(mapped.refused[0]!.reason).toMatch(/The address is missing its city, state, zip/);
    expect(mapped.counts).toMatchObject({ waiting: 3, refused: 2 });
  });

  it("checks in a dry run that keeps nothing but the answers", async () => {
    const checked = await checkAll(owner(), runId);
    routes.checkImport.output.parse(checked);
    expect(checked.status).toBe("checked");
    expect(checked.counts).toMatchObject({ ready: 3, refused: 2, waiting: 0, loaded: 0 });
    expect(await customersFrom(ORG)).toEqual([]);
  });

  it("refuses to load before every row is checked", async () => {
    const started = await imports.start(owner(), { kind: "customers", fileName: "again.csv", csv: CUSTOMERS });
    await expect(imports.load(owner(), { id: started.id })).rejects.toThrow(/Check the file first/);
  });

  it("loads through the customer create, with the address, the contact and the provenance", async () => {
    const loaded = await loadAll(owner(), runId);
    routes.loadImport.output.parse(loaded);
    expect(loaded.status).toBe("finished");
    expect(loaded.counts).toMatchObject({ loaded: 3, refused: 2, ready: 0 });

    const made = await customersFrom(ORG);
    expect(made.map((c) => c.source_id)).toEqual(["C-1", "C-2", "C-4"]);
    const [ada] = made;
    const read = await customers.get(owner(), { id: ada!.id });
    expect(read.externalRef).toEqual({ source: SOURCE, id: "C-1" });
    const places = await raw<{ address_line1: string }[]>`
      select p.address_line1 from public.customer_property cp join public.property p on p.id = cp.property_id
      where cp.customer_id = ${ada!.id}`;
    expect(places.map((p) => p.address_line1)).toEqual(["1 Analytical Way"]);
    const people = await raw<{ name: string; phone: string; is_primary: boolean }[]>`
      select name, phone, is_primary from public.contact where customer_id = ${ada!.id}`;
    expect(people).toEqual([{ name: "Byron", phone: "5125550199", is_primary: true }]);
  });

  it("stores a formula as the text it is, and hands a refused one back as text", async () => {
    const [stored] = await raw<{ name: string }[]>`
      select name from public.customer where organization_id = ${ORG} and source_id = 'C-4'`;
    expect(stored!.name).toBe(FORMULA);

    const file = await imports.refusedFile(owner(), { id: runId });
    routes.getImportRefusals.output.parse(file);
    expect(file.fileName).toBe("clients-refused.csv");
    expect(file.rows).toBe(2);
    const lines = file.csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("Customer ID,Name,Email,Phone,Street,City,State,Zip,Contact Name,Contact Phone,Original row,Refused because");
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://evil.example"",""Click me"")"`);
    expect(lines.some((line) => line.startsWith("C-5,=") || line.includes(",=HYPERLINK"))).toBe(false);
  });

  it("maps a second file from the same place by itself, and loads nothing twice", async () => {
    const again = await imports.start(owner(), { kind: "customers", fileName: "clients (1).csv", csv: CUSTOMERS });
    expect(again.mappingName).toBe("From the old books");
    expect(again.source).toBe(SOURCE);
    const checked = await checkAll(owner(), again.id);
    expect(checked.counts).toMatchObject({ already: 3, refused: 2, ready: 0 });
    const detail = await imports.get(owner(), { id: again.id });
    expect(detail.skipped.map((s) => s.recordLabel)).toContain("Customer Ada Lovelace");
    await loadAll(owner(), again.id);
    expect((await customersFrom(ORG)).length).toBe(3);
  });

  it("is the owner's: somebody without data:import cannot bring in a file", async () => {
    await expect(imports.start(as(ORG, USER, ["office_manager"]), { kind: "customers", fileName: "x.csv", csv: CUSTOMERS }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("the refusals", () => {
  it("refuses a file too large to be one file, in words", async () => {
    const row = `${"x".repeat(1000)}\r\n`;
    const csv = `Name\r\n${row.repeat(Math.ceil(rules.MAX_BYTES / row.length) + 10)}`;
    await expect(imports.start(owner(), { kind: "customers", fileName: "huge.csv", csv }))
      .rejects.toThrow(/Bring in at most 5 MB at a time/);
  });

  it("does not reach another company's records through a provenance key", async () => {
    /** The neighbouring company brought in its own customer under the same source and id. */
    await bringIn(otherOwner(), "customers", csvOf([["Customer ID", "Name"], ["N-1", "Neighbour's Customer"]]));
    const neighbour = (await imports.list(otherOwner())).imports[0]!;
    await loadAll(otherOwner(), neighbour.id);
    expect((await customersFrom(OTHER)).map((c) => c.source_id)).toEqual(["N-1"]);

    const jobs = csvOf([["Customer ID", "Job Title", "Completed On"], ["N-1", "Furnace tune up", "2022-05-06"]]);
    const { checked, started } = await bringIn(owner(), "jobs", jobs);
    expect(checked.counts).toMatchObject({ refused: 1, ready: 0 });
    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused[0]!.reason).toBe(
      `No customer brought in from "${SOURCE}" has the id N-1. Bring in the customers file first, under the same name for where it came from.`,
    );
    const theirs = await raw`select id from public.job where organization_id = ${OTHER}`;
    expect(theirs.length).toBe(0);

    /** And the same key is this company's own to use: it is unique per company, not across them. */
    const ours = await bringIn(owner(), "customers", csvOf([["Customer ID", "Name"], ["N-1", "Our Own N-1"]]));
    expect(ours.checked.counts).toMatchObject({ ready: 1 });
  });

  it("refuses a row that would post history into today's books", async () => {
    const csv = csvOf([
      ["Invoice #", "Customer ID", "Invoice Date", "Total"],
      ["7001", "C-1", "", "100.00"],
    ]);
    const { started, checked } = await bringIn(owner(), "invoices", csv);
    expect(checked.counts).toMatchObject({ refused: 1, ready: 0 });
    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused[0]!.reason).toMatch(/Without one it would be put in today's books/);
    const made = await raw`select id from public.invoice where organization_id = ${ORG} and source_id = '7001'`;
    expect(made.length).toBe(0);
  });

  it("refuses history inside a closed period, in the books' own words", async () => {
    await accounting.closePeriod(owner(), { periodEnd: "2019-12-31", note: "2019 filed." });
    const csv = csvOf([
      ["Invoice #", "Customer ID", "Invoice Date", "Total"],
      ["7002", "C-1", "2019-06-01", "100.00"],
    ]);
    const { started, checked } = await bringIn(owner(), "invoices", csv);
    expect(checked.counts).toMatchObject({ refused: 1 });
    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused[0]!.reason).toMatch(/closed/i);
  });
});

run("history, on the days it happened", () => {
  it("posts a past invoice and its payment on their own days, and announces neither", async () => {
    const before = await raw<{ n: number }[]>`
      select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}
      and (occurred_at at time zone ${ZONE})::date = ${companyToday()}::date`;
    const csv = csvOf([
      ["Invoice #", "Customer ID", "Invoice Date", "Description", "Subtotal", "Tax", "Total", "Amount Paid", "Payment Date", "Payment Method"],
      ["7100", "C-1", "3/4/2021", "Furnace repair", "$100.00", "$8.25", "$108.25", "108.25", "3/20/2021", "Check"],
      ["7101", "C-2", "2021-04-01", "Drain clearing", "", "", "250", "", "", ""],
    ]);
    const { started, checked } = await bringIn(owner(), "invoices", csv);
    expect(checked.counts).toMatchObject({ ready: 2, refused: 0 });
    await loadAll(owner(), started.id);

    const [invoice] = await raw<{ id: string; number: number; issued_on: string; status: string; total: string; tax_total: string }[]>`
      select id, number, issued_on::text, status, total::text, tax_total::text from public.invoice
      where organization_id = ${ORG} and source_system = ${SOURCE} and source_id = '7100'`;
    expect(invoice).toMatchObject({ number: 7100, issued_on: "2021-03-04", status: "paid", total: "108.2500", tax_total: "8.2500" });

    const posted = await raw<{ day: string }[]>`
      select distinct (occurred_at at time zone ${ZONE})::date::text as day from public.ledger_entry
      where organization_id = ${ORG} and (source_id = ${invoice!.id}::uuid or source_id in (
        select payment_id from public.payment_allocation where invoice_id = ${invoice!.id}::uuid))
      order by day`;
    expect(posted.map((p) => p.day)).toEqual(["2021-03-04", "2021-03-20"]);

    const after = await raw<{ n: number }[]>`
      select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}
      and (occurred_at at time zone ${ZONE})::date = ${companyToday()}::date`;
    expect(after[0]!.n).toBe(before[0]!.n);

    const events = await raw`select name from public.domain_event where organization_id = ${ORG} and entity_id = ${invoice!.id}`;
    expect(events).toEqual([]);

    const [payment] = await raw<{ method: string; source_id: string }[]>`
      select method, source_id from public.payment where organization_id = ${ORG} and source_system = ${SOURCE}`;
    expect(payment).toEqual({ method: "check", source_id: "7100/payment" });
  });

  it("keeps a past job's number and finishes it on its own day, without a word to the customer", async () => {
    const csv = csvOf([
      ["Job #", "Customer ID", "Job Title", "Status", "Completed On"],
      ["4100", "C-1", "Furnace tune up", "Done", "2022-05-06"],
      ["4101", "C-2", "Water heater swap", "Cancelled", "2022-06-01"],
      ["4102", "C-2", "Quote for AC", "Open", ""],
    ]);
    const { started, checked } = await bringIn(owner(), "jobs", csv);
    expect(checked.counts).toMatchObject({ ready: 3 });
    await loadAll(owner(), started.id);
    const made = await raw<{ id: string; number: number; status: string; completed_at: Date | null; cancelled_at: Date | null }[]>`
      select id, number, status, completed_at, cancelled_at from public.job
      where organization_id = ${ORG} and source_system = ${SOURCE} order by number`;
    expect(made.map((j) => [j.number, j.status])).toEqual([[4100, "completed"], [4101, "cancelled"], [4102, "lead"]]);
    expect(made[0]!.completed_at!.toISOString().slice(0, 10)).toBe("2022-05-06");
    const events = await raw<{ name: string }[]>`
      select name from public.domain_event where organization_id = ${ORG} and entity_id in ${raw([made[0]!.id, made[1]!.id])}`;
    expect(events).toEqual([]);
  });

  it("links a past invoice to the job it billed, by the job's number", async () => {
    const csv = csvOf([
      ["Invoice #", "Customer ID", "Job #", "Invoice Date", "Total"],
      ["7200", "C-1", "4100", "2022-05-07", "180.00"],
    ]);
    const { started } = await bringIn(owner(), "invoices", csv);
    await loadAll(owner(), started.id);
    const [linked] = await raw<{ number: number }[]>`
      select j.number from public.invoice i join public.job j on j.id = i.job_id
      where i.organization_id = ${ORG} and i.source_id = '7200'`;
    expect(linked!.number).toBe(4100);
  });
});

run("a batch goes in whole or not at all", () => {
  it("refuses a row that fails after the check and loads the rest of its batch without it", async () => {
    const csv = csvOf([
      ["Invoice #", "Customer ID", "Invoice Date", "Total"],
      ["7300", "C-1", "2021-01-05", "10.00"],
      ["7301", "C-1", "2021-01-06", "20.00"],
      ["7302", "C-1", "2021-01-07", "30.00"],
    ]);
    const { started, checked } = await bringIn(owner(), "invoices", csv);
    expect(checked.counts).toMatchObject({ ready: 3 });

    /** Between the check and the load, somebody types in invoice 7301 by hand. */
    const [ada] = await customersFrom(ORG);
    await billing.create(owner(), {
      number: 7301, customerId: ada!.id, issuedOn: "2021-01-06",
      lines: [{ name: "Typed by hand", quantity: "1", unitPrice: "20.00", discountAmount: "0", taxable: false }],
    });

    const loaded = await loadAll(owner(), started.id);
    expect(loaded.counts).toMatchObject({ loaded: 2, refused: 1, ready: 0 });
    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused.map((r) => r.row)).toEqual([3]);
    expect(detail.refused[0]!.reason).toMatch(/7301/);
    const kept = await raw<{ source_id: string }[]>`
      select source_id from public.invoice where organization_id = ${ORG} and source_id in ('7300', '7301', '7302') order by source_id`;
    expect(kept.map((k) => k.source_id)).toEqual(["7300", "7302"]);
  });
});

run("equipment and the price book, through their own creates", () => {
  it("registers units at the customer's address, once", async () => {
    const csv = csvOf([
      ["Unit ID", "Customer ID", "Equipment Type", "Make", "Model", "Serial Number", "Install Date"],
      ["U-1", "C-1", "Furnace", "Acme", "F-100", "SN-1001", "2018-09-01"],
      ["U-2", "C-9", "Boiler", "Acme", "B-1", "SN-2002", "2018-09-01"],
    ]);
    const { started, checked } = await bringIn(owner(), "equipment", csv);
    expect(checked.counts).toMatchObject({ ready: 1, refused: 1 });
    await loadAll(owner(), started.id);
    const [unit] = await raw<{ serial_number: string; installed_on: string; source_id: string }[]>`
      select serial_number, installed_on::text, source_id from public.equipment
      where organization_id = ${ORG} and source_system = ${SOURCE}`;
    expect(unit).toEqual({ serial_number: "SN-1001", installed_on: "2018-09-01", source_id: "U-1" });

    const again = await bringIn(owner(), "equipment", csv);
    expect(again.checked.counts).toMatchObject({ already: 1, refused: 1 });
  });

  it("refuses a code used twice in one file, naming the first row", async () => {
    const csv = csvOf([
      ["SKU", "Item Name", "Unit Price", "Taxable"],
      ["TUNE", "Tune up", "$129.00", "no"],
      ["TUNE", "Tune up, again", "$139.00", "no"],
    ]);
    const { started, checked } = await bringIn(owner(), "pricebook", csv, "Price list");
    expect(checked.counts).toMatchObject({ ready: 1, refused: 1 });
    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused[0]!.reason).toBe("Row 2 has the same id, TUNE. Each item once.");
    await loadAll(owner(), started.id);
    const [item] = await raw<{ code: string; source_id: string }[]>`
      select code, source_id from public.price_book_item where organization_id = ${ORG} and source_system = ${SOURCE}`;
    expect(item).toEqual({ code: "TUNE", source_id: "TUNE" });

    const saved = await imports.mappings(owner());
    routes.listImportMappings.output.parse(saved);
    const priceList = saved.mappings.find((s) => s.name === "Price list")!;
    expect(priceList.columns).toEqual({ sku: "code", "item name": "name", "unit price": "price", taxable: "taxable" });
    await imports.removeMapping(owner(), { id: priceList.id });
    expect((await imports.mappings(owner())).mappings.some((s) => s.name === "Price list")).toBe(false);
  });
});
