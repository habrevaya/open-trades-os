import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { imports as rules, type Actor } from "@opentradesos/core";
import * as imports from "../src/services/imports";
import * as customers from "../src/services/customers";
import * as workflows from "../src/services/workflows";
import { handleEvent } from "../src/services/workflow-runner";
import { routes } from "../src/contracts/index";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * A SPREADSHEET THAT TEXTS NOBODY, AND ONE RECORD FROM SEVERAL ROWS
 *
 * Two promises the screen makes beyond loading a row through its create.
 * First, a file brought in with "Do not start automations for what this file
 * brings in" (on unless turned off) starts no automation: a welcome on
 * `customer.created` goes to the customer typed in and not to the customer
 * list loaded on the same afternoon. Second, an invoice of several lines and
 * a payment split across invoices are several rows each, read together and
 * loaded as one create, or refused together naming the rows that disagree.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("spreadsheet-more:org");
const USER = fixtureId("spreadsheet-more:user");
const SOURCE = "old-ledger";
const FROM = "office@more-co.test";

let raw: postgres.Sql;
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: testDb(url!),
});

const csvOf = (rows: string[][]) =>
  `${rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n")}\r\n`;

async function bringIn(kind: rules.ImportKind, csv: string, over: { holdAutomations?: boolean } = {}) {
  const started = await imports.start(owner(), { kind, fileName: `${kind}.csv`, csv, ...over });
  await imports.map(owner(), { id: started.id, columns: started.columns, source: SOURCE, dayFirst: false });
  let checked = await imports.check(owner(), { id: started.id });
  while (checked.more) checked = await imports.check(owner(), { id: started.id });
  return { started, checked };
}
async function loadAll(id: string) {
  let last = await imports.load(owner(), { id });
  while (last.more) last = await imports.load(owner(), { id });
  return last;
}

const emails = () => raw<{ to_address: string; body: string }[]>`
  select to_address, body from public.message where organization_id = ${ORG} and channel = 'email' order by created_at`;

/** Hand every event about these records to the workflow engine, the way the worker does. */
async function runAutomations(entityIds: string[]) {
  const events = await raw<{ id: string; import_run_id: string | null }[]>`
    select id, import_run_id from public.domain_event
    where organization_id = ${ORG} and entity_id in ${raw(entityIds)} order by sequence`;
  const summaries = [];
  for (const event of events) summaries.push(...await handleEvent(owner(), event.id));
  return { events, summaries };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "More Co", slug: "spreadsheet-more-co" });
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: FROM })})`;
  /** The welcome a company builds before its customer list comes in. */
  const welcome = await workflows.create(owner(), {
    name: "Welcome", triggerKind: "event", triggerEvents: ["customer.created"],
    steps: [{ kind: "send_message", config: { channel: "email", subject: "Welcome", body: "Welcome, {{ customer.name }}." } }],
  });
  await workflows.setEnabled(owner(), { id: welcome.id, enabled: true });
});

afterAll(async () => { if (raw) await raw.end(); });

run("a file brought in with automations held texts nobody", () => {
  it("is on unless turned off, and says so on the file", async () => {
    const started = await imports.start(owner(), {
      kind: "customers", fileName: "x.csv", csv: csvOf([["Name"], ["Nobody Yet"]]),
    });
    routes.startImport.output.parse(started);
    expect(started.holdAutomations).toBe(true);
    const off = await imports.map(owner(), {
      id: started.id, columns: started.columns, source: SOURCE, dayFirst: false, holdAutomations: false,
    });
    expect(off.holdAutomations).toBe(false);
    const kept = await imports.map(owner(), { id: started.id, columns: started.columns, source: SOURCE, dayFirst: false });
    expect(kept.holdAutomations).toBe(false);
  });

  it("starts nothing for a customer it brings in, and still welcomes one typed in", async () => {
    const { started, checked } = await bringIn("customers", csvOf([
      ["Customer ID", "Name", "Email"],
      ["C-1", "Ada Lovelace", "ada@more.test"],
      ["C-2", "Grace Hopper", "grace@more.test"],
    ]));
    expect(checked.counts).toMatchObject({ ready: 2 });
    await loadAll(started.id);
    const loaded = await raw<{ id: string }[]>`
      select id from public.customer where organization_id = ${ORG} and source_system = ${SOURCE} and source_id in ('C-1', 'C-2')`;
    expect(loaded).toHaveLength(2);

    const brought = await runAutomations(loaded.map((c) => c.id));
    expect(brought.events.length).toBe(2);
    expect(brought.events.every((e) => e.import_run_id === started.id)).toBe(true);
    expect(brought.summaries.map((s) => [s.status, s.reason])).toEqual([["skipped", "imported"], ["skipped", "imported"]]);
    expect(await emails()).toEqual([]);

    const typed = await customers.create(owner(), {
      type: "residential", name: "Typed In", email: "typed@more.test",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    const byHand = await runAutomations([typed.id]);
    expect(byHand.events.map((e) => e.import_run_id)).toEqual([null]);
    expect(byHand.summaries.map((s) => s.status)).toEqual(["succeeded"]);
    expect(await emails()).toEqual([{ to_address: "typed@more.test", body: "Welcome, Typed In." }]);
  });

  it("starts them as usual for a file brought in with the switch off", async () => {
    const { started } = await bringIn("customers", csvOf([["Customer ID", "Name", "Email"], ["C-3", "Kept Loud", "loud@more.test"]]),
      { holdAutomations: false });
    await loadAll(started.id);
    const [loud] = await raw<{ id: string }[]>`select id from public.customer where organization_id = ${ORG} and source_id = 'C-3'`;
    const fired = await runAutomations([loud!.id]);
    expect(fired.summaries.map((s) => s.status)).toEqual(["succeeded"]);
    expect((await emails()).map((e) => e.to_address)).toContain("loud@more.test");
  });
});

run("an invoice of several lines, one row per line", () => {
  it("loads the rows with one invoice number as one invoice with every line and its tax", async () => {
    const { started, checked } = await bringIn("invoices", csvOf([
      ["Invoice #", "Customer ID", "Invoice Date", "Description", "Qty", "Price Each", "Tax", "Invoice Total", "Amount Paid", "Paid On"],
      ["8001", "C-1", "2021-05-01", "Igniter", "2", "50.00", "8.25", "158.25", "158.25", "2021-05-10"],
      ["8001", "", "", "Labor", "1", "50.00", "0", "", "", ""],
      ["8002", "C-2", "2021-05-02", "Drain clearing", "1", "120.00", "", "", "", ""],
    ]));
    expect(checked.counts).toMatchObject({ ready: 3, refused: 0 });
    await loadAll(started.id);

    const [invoice] = await raw<{ id: string; total: string; tax_total: string; status: string }[]>`
      select id, total::text, tax_total::text, status from public.invoice
      where organization_id = ${ORG} and source_system = ${SOURCE} and source_id = '8001'`;
    expect(invoice).toMatchObject({ total: "158.2500", tax_total: "8.2500", status: "paid" });
    const lines = await raw<{ name: string; quantity: string; unit_price: string }[]>`
      select name, quantity::text, unit_price::text from public.invoice_line where invoice_id = ${invoice!.id} order by sort_order, name`;
    expect(lines.map((l) => [l.name, Number(l.quantity), Number(l.unit_price)])).toEqual([["Igniter", 2, 50], ["Labor", 1, 50]]);

    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.counts).toMatchObject({ loaded: 3 });
  });

  it("refuses every row of an invoice whose rows disagree, naming them, and loads the rest", async () => {
    const { started, checked } = await bringIn("invoices", csvOf([
      ["Invoice #", "Customer ID", "Invoice Date", "Description", "Before Tax", "Invoice Total"],
      ["8101", "C-1", "2021-07-01", "Part", "40.00", "100.00"],
      ["8101", "C-1", "2021-07-02", "Labor", "60.00", "100.00"],
      ["8102", "C-1", "2021-07-03", "Part", "40.00", "90.00"],
      ["8102", "C-1", "2021-07-03", "Labor", "60.00", "90.00"],
      ["8103", "C-2", "2021-07-04", "Tune up", "75.00", "75.00"],
    ]));
    expect(checked.counts).toMatchObject({ refused: 4, ready: 1 });
    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused.map((r) => r.row)).toEqual([2, 3, 4, 5]);
    expect(detail.refused[0]!.reason).toMatch(/Row 2 says Invoice date is 2021-07-01 and row 3 says 2021-07-02/);
    expect(detail.refused[2]!.reason).toBe("Its 2 lines come to 100.00, not the 90.00 in Total.");
    const file = await imports.refusedFile(owner(), { id: started.id });
    expect(file.rows).toBe(4);
  });
});

run("a payment split across invoices, one row per invoice it paid", () => {
  it("loads the rows with one payment id as one payment on each invoice, on the day it was paid", async () => {
    const invoices = await bringIn("invoices", csvOf([
      ["Invoice #", "Customer ID", "Invoice Date", "Total"],
      ["8201", "C-1", "2021-08-01", "100.00"],
      ["8202", "C-1", "2021-08-02", "75.00"],
    ]));
    await loadAll(invoices.started.id);

    const { started, checked } = await bringIn("payments", csvOf([
      ["Payment ID", "Invoice #", "Amount", "Date", "Method", "Check Number"],
      ["P-1", "8201", "100.00", "2021-08-10", "Check", "1042"],
      ["P-1", "8202", "50.00", "2021-08-10", "Check", "1042"],
      ["P-2", "8202", "25.00", "2021-08-11", "Cash", ""],
      ["P-3", "9999", "10.00", "2021-08-12", "Cash", ""],
    ]));
    routes.checkImport.output.parse(checked);
    expect(checked.counts).toMatchObject({ ready: 3, refused: 1 });
    const loaded = await loadAll(started.id);
    expect(loaded.counts).toMatchObject({ loaded: 3, refused: 1 });

    const [p1] = await raw<{ id: string; amount: string; method: string; check_number: string; received_at: Date }[]>`
      select id, amount::text, method, check_number, received_at from public.payment
      where organization_id = ${ORG} and source_system = ${SOURCE} and source_id = 'P-1'`;
    expect(p1).toMatchObject({ amount: "150.0000", method: "check", check_number: "1042" });
    const shares = await raw<{ number: number; amount: string }[]>`
      select i.number, a.amount::text from public.payment_allocation a join public.invoice i on i.id = a.invoice_id
      where a.payment_id = ${p1!.id} order by i.number`;
    expect(shares).toEqual([{ number: 8201, amount: "100.0000" }, { number: 8202, amount: "50.0000" }]);
    const paid = await raw<{ number: number; status: string; balance: string }[]>`
      select number, status, balance::text from public.invoice where organization_id = ${ORG} and number in (8201, 8202) order by number`;
    expect(paid).toEqual([{ number: 8201, status: "paid", balance: "0.0000" }, { number: 8202, status: "paid", balance: "0.0000" }]);

    const days = await raw<{ day: string }[]>`
      select distinct (occurred_at at time zone 'America/Chicago')::date::text as day from public.ledger_entry
      where organization_id = ${ORG} and source_id = ${p1!.id}::uuid`;
    expect(days.map((d) => d.day)).toEqual(["2021-08-10"]);

    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused.map((r) => [r.row, r.reason])).toEqual([[5, expect.stringMatching(/There is no invoice 9999/)]]);
    expect((await bringIn("payments", csvOf([["Payment ID", "Invoice #", "Amount", "Date"], ["P-1", "8201", "100.00", "2021-08-10"]])))
      .checked.counts).toMatchObject({ already: 1 });
  });

  it("refuses a payment whose rows disagree on the day it was paid", async () => {
    const { started, checked } = await bringIn("payments", csvOf([
      ["Payment ID", "Customer ID", "Amount", "Date"],
      ["P-9", "C-1", "10.00", "2021-09-01"],
      ["P-9", "C-1", "20.00", "2021-09-02"],
    ]));
    expect(checked.counts).toMatchObject({ refused: 2 });
    const detail = await imports.get(owner(), { id: started.id });
    expect(detail.refused[0]!.reason).toMatch(/Row 2 says Paid on is 2021-09-01 and row 3 says 2021-09-02/);
  });
});

run("past estimates, as they ended", () => {
  it("records each with how it ended and the day it was sent, announcing nothing", async () => {
    /** An estimate is for an address: give the two customers theirs. */
    for (const ref of ["C-1", "C-2"]) {
      const [c] = await raw<{ id: string }[]>`select id from public.customer where organization_id = ${ORG} and source_id = ${ref}`;
      const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
        values (${ORG}, ${`1 ${ref} Way`}, 'Austin', 'TX', '78701') returning id`;
      await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${c!.id}, ${p!.id})`;
    }
    const { started, checked } = await bringIn("estimates", csvOf([
      ["Estimate #", "Customer ID", "Title", "Date", "Sent On", "Subtotal", "Tax", "Total", "Status", "Decided On", "Lost Reason"],
      ["9301", "C-1", "New furnace", "2022-02-01", "2022-02-02", "4000.00", "330.00", "4330.00", "Won", "2022-02-10", ""],
      ["9302", "C-2", "Duct cleaning", "2022-03-01", "2022-03-01", "500.00", "", "500.00", "Lost", "2022-03-15", "Went with a cheaper quote"],
      ["9303", "C-2", "Water heater", "2022-04-01", "", "1200.00", "", "1200.00", "Open", "", ""],
      ["9304", "C-1", "Heat pump", "2022-05-01", "2022-05-02", "9000.00", "", "9000.00", "Pending", "", ""],
      ["9305", "C-1", "Thermostat", "2022-06-01", "", "300.00", "", "300.00", "Won", "", ""],
    ]));
    const detail = await imports.get(owner(), { id: started.id });
    expect(checked.counts).toMatchObject({ ready: 3, refused: 2 });
    expect(detail.refused.map((r) => [r.row, r.reason])).toEqual([
      [5, expect.stringMatching(/sent and is still waiting for an answer/)],
      [6, "It says it was approved and not when. Fill in the day in Decided on."],
    ]);
    await loadAll(started.id);

    const made = await raw<{ id: string; number: number; status: string; sent: string | null; decided: string | null; decline_reason: string | null; selected: boolean }[]>`
      select id, number, status,
        (sent_at at time zone 'America/Chicago')::date::text as sent,
        (decided_at at time zone 'America/Chicago')::date::text as decided,
        decline_reason, selected_option_id is not null as selected
      from public.estimate where organization_id = ${ORG} and source_system = ${SOURCE} order by number`;
    expect(made.map(({ id: _id, ...rest }) => rest)).toEqual([
      { number: 9301, status: "approved", sent: "2022-02-02", decided: "2022-02-10", decline_reason: null, selected: true },
      { number: 9302, status: "declined", sent: "2022-03-01", decided: "2022-03-15", decline_reason: "Went with a cheaper quote", selected: false },
      { number: 9303, status: "draft", sent: null, decided: null, decline_reason: null, selected: false },
    ]);
    const [won] = await raw<{ total: string }[]>`
      select o.total::text from public.estimate_option o where o.estimate_id = ${made[0]!.id}`;
    expect(won!.total).toBe("4330.0000");
    const events = await raw`select name from public.domain_event where organization_id = ${ORG} and entity_id in ${raw(made.map((e) => e.id))}`;
    expect(events).toEqual([]);
  });
});
