import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, imports as rules, type Actor } from "@opentradesos/core";
import * as imports from "../src/services/imports";
import * as notes from "../src/services/customer-notes";
import * as jobs from "../src/services/jobs";
import * as tips from "../src/services/tips";
import * as commissions from "../src/services/commissions";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * NOTES AND PAST VISITS FROM A SPREADSHEET
 *
 * The last of a customer's history a file carries. A note lands among the
 * customer's notes on the day the file says, marked as brought in. A past
 * visit goes on a past job, done, at the time in the file, by the technician
 * whose email it names and nobody else: an email nobody on the board signs in
 * with is refused, and so is a job still open. It starts nothing, is not
 * refused for time off recorded since, and is counted toward no commission
 * and no tip.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("spreadsheet-history:org");
const USER = fixtureId("spreadsheet-history:user");
const RAY = fixtureId("spreadsheet-history:ray");
const SOURCE = "old-field";

let raw: postgres.Sql;
let rayTech = "";
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: testDb(url!),
});
const owner = () => as(["owner"]);

const csvOf = (rows: string[][]) =>
  `${rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n")}\r\n`;

async function bringIn(kind: rules.ImportKind, csv: string) {
  const started = await imports.start(owner(), { kind, fileName: `${kind}.csv`, csv });
  await imports.map(owner(), { id: started.id, columns: started.columns, source: SOURCE, dayFirst: false });
  let checked = await imports.check(owner(), { id: started.id });
  while (checked.more) checked = await imports.check(owner(), { id: started.id });
  let loaded = await imports.load(owner(), { id: started.id });
  while (loaded.more) loaded = await imports.load(owner(), { id: started.id });
  return { started, checked, loaded, detail: await imports.get(owner(), { id: started.id }) };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "History Co", slug: "spreadsheet-history-co" });
  await raw`delete from public."user" where id = ${RAY} or email = 'ray@history-co.test'`;
  await raw`insert into public."user" (id, email, name) values (${RAY}, 'ray@history-co.test', 'Ray Ortega')`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${RAY}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, 'Ray Ortega') returning id`;
  rayTech = t!.id;

  await bringIn("customers", csvOf([
    ["Customer ID", "Name", "Email", "Street", "City", "State", "Zip"],
    ["C-1", "Ada Lovelace", "ada@history.test", "1 Engine Way", "Austin", "TX", "78701"],
  ]));
  await bringIn("jobs", csvOf([
    ["Job ID", "Job number", "Customer ID", "Summary", "Status", "Finished on"],
    ["J-1", "88101", "C-1", "Furnace tune up", "completed", "2021-03-04"],
    ["J-2", "88102", "C-1", "Quote for a heat pump", "open", ""],
  ]));
});

afterAll(async () => { if (raw) await raw.end(); });

run("customer notes from a file", () => {
  it("lands each on its day, marked as brought in, and a second upload makes no copies", async () => {
    const file = csvOf([
      ["Note ID", "Customer ID", "Date", "Note", "For technician"],
      ["N-1", "C-1", "3/4/2021", "Side gate sticks.", "yes"],
      ["N-2", "C-1", "2022-11-30", "Asked about financing.", "no"],
      ["N-3", "C-404", "2022-11-30", "Nobody's.", ""],
    ]);
    const first = await bringIn("notes", file);
    expect(first.loaded.counts).toMatchObject({ loaded: 2, refused: 1 });
    expect(first.detail.refused[0]!.reason).toMatch(/No customer brought in from "old-field" has the id C-404/);

    const [ada] = await raw<{ id: string }[]>`select id from public.customer where organization_id = ${ORG} and source_id = 'C-1'`;
    const listed = await notes.list(owner(), { id: ada!.id });
    const gate = listed.data.find((n) => n.body === "Side gate sticks.")!;
    expect(gate).toMatchObject({ origin: "imported", author: null, forField: true, externalRef: { source: SOURCE, id: "N-1" } });
    expect(gate.notedAt.slice(0, 10)).toBe("2021-03-04");
    expect(listed.data.find((n) => n.body === "Asked about financing.")!.forField).toBe(false);

    const again = await bringIn("notes", file);
    expect(again.checked.counts).toMatchObject({ already: 2 });
    const [count] = await raw<{ n: number }[]>`select count(*)::int as n from public.customer_note where organization_id = ${ORG}`;
    expect(count!.n).toBe(2);
  });
});

run("past visits from a file", () => {
  it("records each done, at its time, by the technician it names, and starts nothing", async () => {
    // Ray took the day off after the fact: history is not refused for it.
    await raw`insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
      values (${ORG}, ${rayTech}, '2021-03-04T00:00:00Z', '2021-03-05T12:00:00Z', true)`;
    const result = await bringIn("visits", csvOf([
      ["Visit ID", "Job ID", "Technician email", "Visit date", "Start time", "End time", "Notes"],
      ["V-1", "J-1", "RAY@history-co.test", "2021-03-04", "9:00 AM", "11:30 AM", "Cleaned the flame sensor."],
      ["V-2", "J-1", "nobody@history-co.test", "2021-03-04", "13:00", "", ""],
      ["V-3", "J-2", "ray@history-co.test", "2021-03-05", "13:00", "", ""],
    ]));
    expect(result.loaded.counts).toMatchObject({ loaded: 1, refused: 2 });
    const reasons = result.detail.refused.map((r) => r.reason).join(" ");
    expect(reasons).toMatch(/Nobody on the board signs in with nobody@history-co.test/);
    expect(reasons).toMatch(/Job 88102 is not finished/);

    const [visit] = await raw<{
      id: string; status: string; from_history: boolean; window_start: Date; window_end: Date;
      completed_at: Date; technician_notes: string; job_status: string;
    }[]>`
      select v.id, v.status, v.from_history, v.window_start, v.window_end, v.completed_at, v.technician_notes, j.status as job_status
      from public.visit v join public.job j on j.id = v.job_id
      where v.organization_id = ${ORG} and v.source_id = 'V-1'`;
    expect(visit).toMatchObject({ status: "completed", from_history: true, technician_notes: "Cleaned the flame sensor.", job_status: "completed" });
    // On the company's clock: nine in Chicago is fifteen hundred in March.
    expect(visit!.window_start.toISOString()).toBe("2021-03-04T15:00:00.000Z");
    expect(visit!.window_end.toISOString()).toBe("2021-03-04T17:30:00.000Z");
    expect(visit!.completed_at.toISOString()).toBe("2021-03-04T17:30:00.000Z");
    const [assigned] = await raw<{ technician_id: string }[]>`select technician_id from public.visit_assignment where visit_id = ${visit!.id}`;
    expect(assigned!.technician_id).toBe(rayTech);

    const [events] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.domain_event where organization_id = ${ORG} and entity_id = ${visit!.id}`;
    expect(events!.n).toBe(0);
  });

  it("counts a visit from history toward no tip and no commission", async () => {
    const invoices = await bringIn("invoices", csvOf([
      ["Invoice ID", "Customer ID", "Job ID", "Invoice Date", "Total"],
      ["I-1", "C-1", "J-1", "2021-03-04", "189.00"],
    ]));
    expect(invoices.loaded.counts).toMatchObject({ loaded: 1 });
    const [invoice] = await raw<{ id: string }[]>`select id from public.invoice where organization_id = ${ORG} and source_id = 'I-1'`;
    const tipped = await inTenant(owner(), (tx) => tips.techniciansFor(tx, invoice!.id));
    expect(tipped.technicians).toEqual([]);
    await commissions.declarePlan(owner(), {
      label: "Eight per cent", basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of what the job invoiced for.",
    });
    await expect(commissions.settle(owner(), { invoiceId: invoice!.id }))
      .rejects.toThrow(/Nobody is assigned to that job's visits/);
  });

  it("needs data:import to record a visit as done through the API", async () => {
    const [job] = await raw<{ id: string }[]>`select id from public.job where organization_id = ${ORG} and source_id = 'J-1'`;
    await expect(jobs.addVisit(as(["office_manager"]), {
      id: job!.id, windowStart: "2021-03-06T15:00:00.000Z", windowEnd: "2021-03-06T16:00:00.000Z",
      estimatedDurationMinutes: 60, technicianIds: [rayTech], completedAt: "2021-03-06T16:00:00.000Z",
    })).rejects.toBeInstanceOf(PermissionError);
    await expect(jobs.addVisit(owner(), {
      id: job!.id, estimatedDurationMinutes: 60, technicianIds: [], technicianNotes: "Loose note.",
    })).rejects.toThrow(/Notes go with a visit recorded as done/);
  });
});
