import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as imports from "../src/services/imports";
import * as workflows from "../src/services/workflows";
import { handleEvent } from "../src/services/workflow-runner";
import { routes } from "../src/contracts/index";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * FORGETTING A FILE
 *
 * An uploaded file is kept so the screen can show what happened, and an owner
 * can ask for it to be forgotten: its rows, its refused rows and the columns it
 * was mapped with go, and the records it made stay exactly as they are. These
 * tests read the tables, not the answer, to see what went and what stayed, and
 * above all that a file forgotten after it was run does not turn the
 * automations back on for what it brought in.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("spreadsheet-forget:org");
const USER = fixtureId("spreadsheet-forget:user");
const OTHER = fixtureId("spreadsheet-forget:other-org");
const OTHER_USER = fixtureId("spreadsheet-forget:other-user");
const SOURCE = "forgotten-books";
const FROM = "office@forget-co.test";

let raw: postgres.Sql;
const as = (organizationId: string, userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId, roles: roles as Actor["roles"] }, db: testDb(url!),
});
const owner = () => as(ORG, USER, ["owner"]);

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
async function upload(rows: string[][], name = "customers.csv") {
  const started = await imports.start(owner(), { kind: "customers", fileName: name, csv: csvOf(rows) });
  await imports.map(owner(), { id: started.id, columns: started.columns, source: SOURCE, dayFirst: false });
  return started;
}
const rowsOf = (id: string) => raw<{ n: number }[]>`select count(*)::int as n from public.import_row where run_id = ${id}`;
const runsOf = (id: string) => raw<{ n: number }[]>`select count(*)::int as n from public.import_run where id = ${id}`;
const customersFrom = () => raw<{ name: string }[]>`
  select name from public.customer where organization_id = ${ORG} and source_system = ${SOURCE} order by source_id`;
const emails = () => raw<{ to_address: string }[]>`
  select to_address from public.message where organization_id = ${ORG} and channel = 'email' order by created_at`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Forget Co", slug: "spreadsheet-forget-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: OTHER_USER, name: "Forget Neighbour", slug: "spreadsheet-forget-neighbour" });
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: FROM })})`;
  const welcome = await workflows.create(owner(), {
    name: "Welcome", triggerKind: "event", triggerEvents: ["customer.created"],
    steps: [{ kind: "send_message", config: { channel: "email", subject: "Welcome", body: "Welcome, {{ customer.name }}." } }],
  });
  await workflows.setEnabled(owner(), { id: welcome.id, enabled: true });
});

afterAll(async () => { if (raw) await raw.end(); });

run("forgetting a file that has not been run", () => {
  it("removes the file and its rows, and says nothing had been loaded", async () => {
    const started = await upload([["Customer ID", "Name"], ["F-1", "Never Loaded"], ["F-2", "Not Loaded Either"]]);
    expect((await rowsOf(started.id))[0]!.n).toBe(2);

    const answer = await imports.forget(owner(), { id: started.id });
    routes.forgetImport.output.parse(answer);
    expect(answer).toEqual({ id: started.id, removed: true, ran: false, rows: 2, loaded: 0 });
    expect((await runsOf(started.id))[0]!.n).toBe(0);
    expect((await rowsOf(started.id))[0]!.n).toBe(0);
    expect(await customersFrom()).toEqual([]);
    await expect(imports.get(owner(), { id: started.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("says the same of a file that was checked and not loaded, and writes an audit line either way", async () => {
    const started = await upload([["Customer ID", "Name"], ["F-3", "Checked Only"]]);
    const checked = await checkAll(started.id);
    expect(checked.counts).toMatchObject({ ready: 1, loaded: 0 });
    const answer = await imports.forget(owner(), { id: started.id });
    expect(answer).toMatchObject({ ran: false, loaded: 0, rows: 1 });
    const [audit] = await raw<{ action: string; before: { fileName: string; ran: boolean; loaded: number } }[]>`
      select action, before from public.audit_log where organization_id = ${ORG} and entity_id = ${started.id} and action = 'import.forgotten'`;
    expect(audit).toMatchObject({ action: "import.forgotten", before: { fileName: "customers.csv", ran: false, loaded: 0 } });
    expect(await customersFrom()).toEqual([]);
  });
});

run("forgetting a file that has been run", () => {
  it("removes the file and keeps every record it made, and says how many", async () => {
    const started = await upload([["Customer ID", "Name", "Email"], ["F-10", "Ada Kept", "ada@forget.test"], ["F-11", "Grace Kept", "grace@forget.test"]], "kept.csv");
    await checkAll(started.id);
    await loadAll(started.id);
    expect((await customersFrom()).map((c) => c.name)).toEqual(["Ada Kept", "Grace Kept"]);

    const answer = await imports.forget(owner(), { id: started.id });
    expect(answer).toEqual({ id: started.id, removed: true, ran: true, rows: 2, loaded: 2 });
    expect((await runsOf(started.id))[0]!.n).toBe(0);
    expect((await rowsOf(started.id))[0]!.n).toBe(0);
    expect((await customersFrom()).map((c) => c.name)).toEqual(["Ada Kept", "Grace Kept"]);
    const [audit] = await raw<{ before: { ran: boolean; loaded: number } }[]>`
      select before from public.audit_log where organization_id = ${ORG} and entity_id = ${started.id} and action = 'import.forgotten'`;
    expect(audit!.before).toMatchObject({ ran: true, loaded: 2 });
  });

  it("does not let the same file be loaded twice afterwards: the records still say where they came from", async () => {
    const again = await upload([["Customer ID", "Name", "Email"], ["F-10", "Ada Kept", "ada@forget.test"], ["F-11", "Grace Kept", "grace@forget.test"]], "kept-again.csv");
    const checked = await checkAll(again.id);
    expect(checked.counts).toMatchObject({ already: 2, ready: 0 });
    await loadAll(again.id);
    expect(await customersFrom()).toHaveLength(2);
  });

  it("keeps the automations held for what the file brought in, even though the file that said so is gone", async () => {
    const started = await upload([["Customer ID", "Name", "Email"], ["F-20", "Quiet Customer", "quiet@forget.test"]], "quiet.csv");
    await checkAll(started.id);
    await loadAll(started.id);
    const [made] = await raw<{ id: string }[]>`
      select id from public.customer where organization_id = ${ORG} and source_system = ${SOURCE} and source_id = 'F-20'`;
    await imports.forget(owner(), { id: started.id });

    /** The event is still waiting to be handled, and it names a file that no longer exists. */
    const events = await raw<{ id: string; import_run_id: string | null }[]>`
      select id, import_run_id from public.domain_event where organization_id = ${ORG} and entity_id = ${made!.id} order by sequence`;
    expect(events.map((e) => e.import_run_id)).toEqual([started.id]);
    const summaries = [];
    for (const event of events) summaries.push(...await handleEvent(owner(), event.id));
    expect(summaries.map((s) => [s.status, s.reason])).toEqual([["skipped", "imported"]]);
    expect((await emails()).map((e) => e.to_address)).not.toContain("quiet@forget.test");
  });

  it("forgets a file that is part way through loading, and keeps what went in", async () => {
    const rows = [["Customer ID", "Name"], ...Array.from({ length: 101 }, (_, i) => [`F-3${String(i).padStart(3, "0")}`, `Batch Customer ${i}`])];
    const started = await upload(rows, "big.csv");
    await checkAll(started.id);
    const first = await imports.load(owner(), { id: started.id });
    expect(first).toMatchObject({ status: "loading", more: true });
    const answer = await imports.forget(owner(), { id: started.id });
    expect(answer).toEqual({ id: started.id, removed: true, ran: true, rows: 101, loaded: 100 });
    const kept = await raw<{ n: number }[]>`
      select count(*)::int as n from public.customer where organization_id = ${ORG} and source_system = ${SOURCE} and source_id like 'F-3%'`;
    expect(kept[0]!.n).toBe(100);
  }, 60_000);
});

run("who may forget a file", () => {
  it("is the owner's: somebody without data:import cannot", async () => {
    const started = await upload([["Customer ID", "Name"], ["F-90", "Protected"]]);
    await expect(imports.forget(as(ORG, USER, ["technician"]), { id: started.id })).rejects.toBeInstanceOf(PermissionError);
    expect((await runsOf(started.id))[0]!.n).toBe(1);
  });

  it("cannot reach another company's file, and cannot forget one twice", async () => {
    const started = await upload([["Customer ID", "Name"], ["F-91", "Theirs"]]);
    await expect(imports.forget(as(OTHER, OTHER_USER, ["owner"]), { id: started.id })).rejects.toBeInstanceOf(NotFoundError);
    await imports.forget(owner(), { id: started.id });
    await expect(imports.forget(owner(), { id: started.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.forget(owner(), { id: "00000000-0000-4000-8000-000000000000" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
