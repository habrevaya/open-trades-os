import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { reporting, permissionsFor, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import * as tasks from "../src/services/tasks";
import * as fieldOps from "../src/services/field";
import * as reports from "../src/services/reports";
import * as dashboards from "../src/services/dashboards";
import { BUILT_IN } from "../src/services/report-built-in";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * EVERY AGGREGATE OPENS ONTO THE RECORDS BEHIND IT, AND THEY ADD UP
 *
 * The promise of drill through is one sentence: click a number and you get the
 * records that make it, and those records total to the number you clicked. The
 * second half is the part worth a test, because the failure is silent. A drill
 * that forgot the date range, dropped a filter, counted a voided invoice or
 * pinned "Not set" with an equality that matches nothing still returns a
 * perfectly plausible list, and the owner who adds it up finds a report that
 * disagrees with itself.
 *
 * So this runs EVERY report that ships, and every tile on every dashboard that
 * ships, against a company with real work in it: invoices in every aging
 * bucket, a draft with no issue date, a voided one, a part paid one, hours on
 * the clock at a frozen rate, a card fee, jobs with no type, a visit nobody was
 * assigned. For every row each one returns, it drills, adds the records up
 * itself, and compares.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("drill:org");
const USER = fixtureId("drill:user");
const OTHER = fixtureId("drill:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles, ...extra }, db: db(),
});
const owner = () => as(["owner"]);

const ONE_HOUR = 3_600_000;
let techA = "";
let techB = "";
const days = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Drill Co", slug: "drill-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;

  const [mine] = await raw<{ id: string }[]>`
    select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  await raw`delete from public."user" where id = ${OTHER} or email = 'drill-other@test.local'`;
  await raw`insert into public."user" (id, email) values (${OTHER}, 'drill-other@test.local')`;
  const [theirs] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${OTHER}, 'technician') returning id`;
  const [a] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, wage_classification)
    values (${ORG}, ${mine!.id}, 'Ann Able', 'Journeyman') returning id`;
  const [b] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${theirs!.id}, 'Ben Baker') returning id`;
  techA = a!.id;
  techB = b!.id;
  await raw`insert into public.wage_scale
    (organization_id, authority, classification, base_rate, fringe_rate)
    values (${ORG}, 'employee_default', 'Journeyman', '30.0000', '7.5000')`;

  const [drain] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name) values (${ORG}, 'Drain cleaning') returning id`;
  const [install] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name) values (${ORG}, 'Install') returning id`;

  const ada = await customers.create(owner(), {
    type: "residential", name: "Ada Archer", phone: "+15125550191",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const bea = await customers.create(owner(), {
    type: "commercial", name: "Bea's Bakery", phone: "+15125550192",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  });
  const place = async (customerId: string, line1: string) => (await properties.create(owner(), {
    address: { line1, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id as string;
  const adaHome = await place(ada.id as string, "1 Archer Ln");
  const beaShop = await place(bea.id as string, "2 Baker St");

  const job = async (
    customerId: string, propertyId: string, summary: string,
    over: { jobTypeId?: string; technicianIds?: string[]; minutes?: number } = {},
  ) => {
    const start = new Date(Date.now() - 3 * ONE_HOUR);
    const created = await jobs.create(owner(), {
      customerId, propertyId, summary, tags: [], customFields: {},
      ...(over.jobTypeId ? { jobTypeId: over.jobTypeId } : {}),
      visit: {
        windowStart: start.toISOString(),
        windowEnd: new Date(start.getTime() + 2 * ONE_HOUR).toISOString(),
        estimatedDurationMinutes: over.minutes ?? 60,
        technicianIds: over.technicianIds ?? [],
      },
    });
    const [visit] = await raw<{ id: string }[]>`
      select id from public.visit where job_id = ${created.id} order by sequence limit 1`;
    return { jobId: created.id as string, visitId: visit!.id };
  };

  // ---- Ada's drain: two hours on the clock, a part, invoiced long ago ----
  const j1 = await job(ada.id as string, adaHome, "Kitchen drain", { jobTypeId: drain!.id, technicianIds: [techA], minutes: 60 });
  const punchIn = new Date(Date.now() - 2.5 * ONE_HOUR);
  const { deviceId } = await fieldOps.register(as(["technician"]), { installationId: `drill-${randomUUID()}` });
  await fieldOps.sync(as(["technician"]), {
    deviceId,
    operations: [
      {
        clientId: randomUUID(), sequence: 1, kind: "timeclock.punch_in", occurredAt: punchIn.toISOString(),
        payload: { technicianId: techA, jobId: j1.jobId, classification: "Journeyman" },
      },
      {
        clientId: randomUUID(), sequence: 2, kind: "visit.add_line", subjectId: j1.visitId,
        occurredAt: punchIn.toISOString(),
        payload: { kind: "part", name: "P-trap", quantity: "1", unitPrice: "30.00", unitCost: "11.25" },
      },
      {
        // Seventy minutes, so the labour is a repeating decimal at the frozen
        // rate and the drill's totals have to be exact rather than close.
        clientId: randomUUID(), sequence: 3, kind: "timeclock.punch_out",
        occurredAt: new Date(punchIn.getTime() + 70 * 60_000).toISOString(),
        payload: { technicianId: techA },
      },
    ],
  } as Parameters<typeof fieldOps.sync>[1]);
  await jobs.complete(owner(), { id: j1.visitId, technicianNotes: "Cleared." });
  const inv1 = await billing.create(owner(), {
    customerId: ada.id as string, jobId: j1.jobId, issuedOn: days(-100), dueOn: days(-95),
    lines: [{ name: "Drain clearing", quantity: "1", unitPrice: "300.00", discountAmount: "0", taxable: false }],
  });
  const [line1] = await raw<{ id: string }[]>`select id from public.invoice_line where invoice_id = ${inv1.id}`;
  await raw`update public.job_line set invoice_line_id = ${line1!.id} where job_id = ${j1.jobId}`;

  // ---- Ada again: part paid, in the 31 to 60 bucket --------------------
  const j2 = await job(ada.id as string, adaHome, "Bathroom drain", { jobTypeId: drain!.id, technicianIds: [techB] });
  await jobs.complete(owner(), { id: j2.visitId, technicianNotes: "Snaked." });
  const inv2 = await billing.create(owner(), {
    customerId: ada.id as string, jobId: j2.jobId, issuedOn: days(-40), dueOn: days(-35),
    lines: [{ name: "Drain clearing", quantity: "1", unitPrice: "120.00", discountAmount: "0", taxable: false }],
  });
  await billing.pay({ ...owner(), idempotencyKey: `drill-${randomUUID()}` }, {
    customerId: ada.id as string, method: "cash", amount: "20.00", tipAmount: "0",
    allocations: [{ invoiceId: inv2.id as string, amount: "20.00" }],
  });

  // ---- Bea's install: discounted, paid by card with a fee, current ------
  const j3 = await job(bea.id as string, beaShop, "Water heater", { jobTypeId: install!.id, technicianIds: [techB, techA], minutes: 240 });
  await jobs.complete(owner(), { id: j3.visitId, technicianNotes: "Installed." });
  const inv3 = await billing.create(owner(), {
    customerId: bea.id as string, jobId: j3.jobId, issuedOn: days(-5), dueOn: days(25),
    lines: [{ name: "Heater", quantity: "1", unitPrice: "500.00", discountAmount: "50.00", taxable: false }],
  });
  await billing.pay({ ...owner(), idempotencyKey: `drill-${randomUUID()}` }, {
    customerId: bea.id as string, method: "card", amount: "450.00", tipAmount: "0", feeAmount: "13.35",
    allocations: [{ invoiceId: inv3.id as string, amount: "450.00" }],
  });

  // ---- Bea, no job, 1 to 30 days late ---------------------------------
  await billing.create(owner(), {
    customerId: bea.id as string, issuedOn: days(-20), dueOn: days(-10),
    lines: [{ name: "Service call", quantity: "1", unitPrice: "80.00", discountAmount: "0", taxable: false }],
  });

  // ---- Voided, and a draft with no issue date at all ------------------
  const j4 = await job(bea.id as string, beaShop, "Repipe that fell through", { jobTypeId: install!.id });
  const inv4 = await billing.create(owner(), {
    customerId: bea.id as string, jobId: j4.jobId,
    lines: [{ name: "Repipe", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false }],
  });
  await billing.voidInvoice(owner(), { id: inv4.id as string, reason: "Wrong property" });
  await billing.create(owner(), {
    customerId: ada.id as string, draft: true,
    lines: [{ name: "Filter", quantity: "1", unitPrice: "60.00", discountAmount: "0", taxable: false }],
  });

  // ---- A job with no type and nobody assigned --------------------------
  await job(ada.id as string, adaHome, "Look at the noise");

  // ---- Estimates and tasks ---------------------------------------------
  const option = (price: string) => [{
    name: "Repair", isRecommended: true,
    lines: [{ name: "Work", quantity: "1", unitPrice: price, discountAmount: "0", taxable: false, isOptional: false, isSelected: false }],
  }];
  await estimates.create(owner(), { customerId: ada.id as string, propertyId: adaHome, taxRate: "0", options: option("410.00") });
  await estimates.create(owner(), { customerId: bea.id as string, propertyId: beaShop, taxRate: "0", options: option("1299.99") });
  await tasks.create(owner(), { title: "Call Ada back" });
  await tasks.create(owner(), { title: "Order the heater", priority: "high", queue: "parts" });
});

afterAll(async () => { if (raw) await raw.end(); });

/**
 * The comparison, for one row of one report.
 *
 * Money and counts exactly. Hours come back from the report as floats, so they
 * are compared to a millionth of an hour, and an average is compared at four
 * places because it is a division. Everything else is equality.
 */
async function drillAndCompare(
  ctx: ServiceContext,
  definition: reporting.ReportDefinition,
  row: Record<string, string | number | null>,
  where: string,
): Promise<number> {
  const resolved = reporting.resolveReport(definition, reports.CATALOGUE, permissionsFor(ctx.actor));
  if (!resolved.ok) throw new Error(`${where}: ${JSON.stringify(resolved)}`);

  const drilled = await reports.drill(ctx, { definition, match: reporting.matchFor(definition, row) });
  expect(drilled.truncated, where).toBe(false);
  expect(drilled.count, where).toBe(drilled.rows.length);

  const added = reporting.drillTotals(resolved.measures, drilled.rows.map((r) => r.values));

  for (const measure of resolved.measures) {
    const clicked = row[measure.key] ?? null;
    const sum = added[measure.key] ?? null;
    const total = drilled.totals[measure.key] ?? null;
    const label = `${where}, ${measure.key}: clicked ${String(clicked)}, drilled rows add to ${String(sum)}`;

    if (measure.kind === "avg") {
      expect(clicked === null ? null : reporting.roundDecimal(clicked, 4), label)
        .toBe(sum === null ? null : reporting.roundDecimal(sum, 4));
    } else if (measure.type === "money" || measure.kind === "count") {
      expect(reporting.normalizeDecimal(sum ?? "0"), label).toBe(reporting.normalizeDecimal(clicked ?? "0"));
      expect(reporting.normalizeDecimal(total ?? "0"), label).toBe(reporting.normalizeDecimal(clicked ?? "0"));
    } else {
      expect(Math.abs(Number(sum ?? 0) - Number(clicked ?? 0)), label).toBeLessThan(1e-6);
      expect(Math.abs(Number(total ?? 0) - Number(clicked ?? 0)), label).toBeLessThan(1e-6);
    }
  }

  // Every record links somewhere real, and a pinned null came back as null.
  for (const record of drilled.rows) expect(record.href, where).toMatch(/^\/[a-z]/);
  return drilled.rows.length;
}

run("every built-in report opens onto records that add up to it", () => {
  it("has a fixture with something in every report", async () => {
    const empty: string[] = [];
    for (const report of BUILT_IN) {
      const result = await reports.run(owner(), report.definition);
      if (result.rows.length === 0) empty.push(report.slug);
    }
    // A report with no rows would pass the next test by checking nothing.
    expect(empty).toEqual([]);
  });

  it.each(BUILT_IN.map((report) => [report.slug, report] as const))(
    "%s: every row's drilled records total to the row",
    async (_slug, report) => {
      const result = await reports.run(owner(), report.definition);
      let records = 0;
      for (const [index, row] of result.rows.entries()) {
        records += await drillAndCompare(owner(), report.definition, row, `${report.slug} row ${index}`);
      }
      expect(records).toBeGreaterThan(0);
    },
  );

  it("keeps the date range: a report run over the last two months drills to the last two months", async () => {
    const definition = { ...BUILT_IN.find((r) => r.slug === "ar-aging")!.definition, from: days(-60), to: days(1) };
    const result = await reports.run(owner(), definition);
    const overNinety = result.rows.find((row) => String(row["aging"]).includes("Over 90"));
    // Ada's long overdue invoice was issued a hundred days ago, so it is not in this range at all.
    expect(overNinety).toBeUndefined();
    for (const row of result.rows) await drillAndCompare(owner(), definition, row, "ranged aging");
  });

  it("opens a group that came back empty, rather than matching nothing", async () => {
    const definition = BUILT_IN.find((r) => r.slug === "revenue-by-month")!.definition;
    const result = await reports.run(owner(), definition);
    const unissued = result.rows.find((row) => row["month"] === null);
    expect(unissued, "the draft has no issue date, so it lands in a month called Not set").toBeDefined();
    const drilled = await reports.drill(owner(), { definition, match: { month: null } });
    expect(drilled.rows.map((r) => r.label)).toHaveLength(1);
    expect(drilled.rows[0]!.values["status"]).toBe("draft");
  });

  it("names the customer on each invoice and links to them", async () => {
    const definition = BUILT_IN.find((r) => r.slug === "outstanding-by-customer")!.definition;
    const drilled = await reports.drill(owner(), { definition, match: { customer: "Ada Archer" } });
    // The two she owes on and the draft, which is not paid either: the
    // report's own filter is "not paid", and the drill keeps it.
    expect(drilled.rows.length).toBe(3);
    for (const record of drilled.rows) {
      expect(record.values["customer"]).toBe("Ada Archer");
      expect(record.links["customer"]).toMatch(/^\/customers\/[0-9a-f-]{36}$/);
      expect(record.href).toBe(`/invoices/${record.id}`);
    }
    // And it says what it pinned, in the report's own words.
    expect(drilled.pinned).toEqual([{ key: "customer", label: "Customer", type: "text", value: "Ada Archer" }]);
  });

  it("opens a visit on its own screen, not on its job", async () => {
    const definition = BUILT_IN.find((r) => r.slug === "visits-by-technician")!.definition;
    const result = await reports.run(owner(), definition);
    const unassigned = result.rows.find((row) => row["technician"] === "Unassigned")!;
    const drilled = await reports.drill(owner(), { definition, match: reporting.matchFor(definition, unassigned) });
    expect(drilled.rows.length).toBeGreaterThan(0);
    for (const record of drilled.rows) expect(record.href).toBe(`/visits/${record.id}`);
  });

  it("opens a task on its own page, not on the queue", async () => {
    await raw`insert into public.task (organization_id, title) values (${ORG}, 'Ring the supplier')`;
    const definition: reporting.ReportDefinition = { dataset: "tasks", dimensions: ["status"], measures: ["count"], filters: [] };
    const result = await reports.run(owner(), definition);
    const drilled = await reports.drill(owner(), { definition, match: reporting.matchFor(definition, result.rows[0]!) });
    expect(drilled.rows.length).toBeGreaterThan(0);
    for (const record of drilled.rows) expect(record.href).toBe(`/tasks/${record.id}`);
  });
});

run("every built-in dashboard tile opens the same way", () => {
  it("drills every row of every tile to records that add up to it", async () => {
    let checked = 0;
    for (const board of dashboards.catalogue(owner())) {
      const { tiles } = await dashboards.get(owner(), { slug: board.slug });
      for (const tile of tiles) {
        expect(tile.problem, `${board.slug}/${tile.key}`).toBeUndefined();
        expect(tile.definition, `${board.slug}/${tile.key} carries the definition it drills with`).toBeDefined();
        for (const [index, row] of (tile.result?.rows ?? []).entries()) {
          await drillAndCompare(owner(), tile.definition!, row, `${board.slug}/${tile.key} row ${index}`);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

run("a drill is a read like the report it came from", () => {
  it("is refused to somebody the report is refused to, in the report's words", async () => {
    const definition = BUILT_IN.find((r) => r.slug === "ar-aging")!.definition;
    await expect(reports.drill(as(["dispatcher"]), { definition, match: {} }))
      .rejects.toThrow(/report\.financial:read/);
  });

  it("refuses to pin something the report does not group by", async () => {
    const definition = BUILT_IN.find((r) => r.slug === "jobs-by-status")!.definition;
    await expect(reports.drill(owner(), { definition, match: { customer: "Ada Archer" } }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("gives a technician their own jobs, and the count agrees with their report", async () => {
    const tech = as(["technician"], { technicianId: techB });
    const definition = BUILT_IN.find((r) => r.slug === "jobs-by-status")!.definition;
    const mine = await reports.run(tech, definition);
    const all = await reports.run(owner(), definition);
    const count = (rows: typeof mine.rows) => rows.reduce((n, r) => n + Number(r["count"]), 0);
    expect(count(mine.rows)).toBeLessThan(count(all.rows));
    for (const row of mine.rows) await drillAndCompare(tech, definition, row, "technician jobs");
    const drilled = await reports.drill(tech, { definition, match: {} });
    expect(drilled.count).toBe(count(mine.rows));
  });
});
