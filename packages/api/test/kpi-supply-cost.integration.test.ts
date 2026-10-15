import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as jobs from "../src/services/jobs";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * SUPPLY COST SHARE OF REVENUE, AND THE FLAG IT WAITED ON
 *
 * Cleaning's "chemical, consumable and equipment consumable cost divided by
 * invoiced revenue. EXCLUDES supplies stocked for a commercial account and
 * billed back at cost, which are a pass through and not a margin leak." A
 * supply used on a job can now be marked as billed back to the customer at
 * cost, and once it is on an issued invoice it leaves both halves: its cost
 * from the top and what it was billed at from the bottom.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-supply:org");
const USER = fixtureId("kpi-supply:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";
let seq = 0;
const types = new Map<string, string>();

async function typeOf(revenueClass: string): Promise<string> {
  const found = types.get(revenueClass);
  if (found) return found;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, revenue_class)
    values (${ORG}, ${revenueClass}, ${`sc-${revenueClass}`}, ${revenueClass}::job_revenue_class) returning id`;
  types.set(revenueClass, row!.id);
  return row!.id;
}

/** A job finished on `done`, with ledger revenue posted against it. */
async function job(name: string, revenue: string, opts: { done?: string; revenueClass?: string } = {}): Promise<string> {
  seq += 1;
  const at = `('${opts.done ?? "2026-06-20"} 16:00'::timestamp at time zone '${ZONE}')`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, completed_at)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${await typeOf(opts.revenueClass ?? "recurring")}, 'completed', ${name},
            ${raw.unsafe(at)})
    returning id`;
  if (revenue !== "0") {
    await raw`
      insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction, account_code, currency, amount,
                                       source_type, source_id, job_id)
      select ${ORG}, t.id, now(), d.direction, d.code, 'USD', ${revenue}, 'manual', t.id, ${row!.id}
      from (select gen_random_uuid() as id) t,
           (values ('debit'::ledger_direction, '1100'), ('credit'::ledger_direction, '4000')) as d(direction, code)`;
  }
  return row!.id;
}

/** An invoice in a status, for a supply line to be billed on. */
async function invoice(status: string): Promise<string> {
  seq += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.invoice (organization_id, number, customer_id, status, issued_on, due_on, total, balance)
    values (${ORG}, ${seq}, ${customerId}, ${status}::invoice_status, '2026-06-20', '2026-07-20', '0', '0') returning id`;
  return row!.id;
}

/** A line used on the job; billed on an invoice at a price when `billedOn` names one. */
async function used(jobId: string, opts: {
  name: string; quantity: string; unitCost: string | null; kind?: string;
  billedBack?: boolean; billedOn?: string; unitPrice?: string;
}): Promise<string> {
  let invoiceLineId: string | null = null;
  if (opts.billedOn) {
    const [line] = await raw<{ id: string }[]>`
      insert into public.invoice_line (organization_id, invoice_id, name, quantity, unit_price, line_total)
      values (${ORG}, ${opts.billedOn}, ${opts.name}, ${opts.quantity}, ${opts.unitPrice ?? "0"},
              (${opts.quantity}::numeric * ${opts.unitPrice ?? "0"}::numeric))
      returning id`;
    invoiceLineId = line!.id;
  }
  const [row] = await raw<{ id: string }[]>`
    insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price, unit_cost, invoice_line_id,
                                 billed_back_at)
    values (${ORG}, ${jobId}, ${opts.kind ?? "part"}::job_line_kind, ${opts.name}, ${opts.quantity}, ${opts.unitPrice ?? "0"},
            ${opts.unitCost}, ${invoiceLineId}, ${opts.billedBack ? raw.unsafe("now()") : null})
    returning id`;
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (raw) await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  types.clear();
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Supply Co", slug: "kpi-supply-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'cleaning' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'commercial', 'Office Park', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Office Park', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
});

/**
 * The month, by hand.
 *
 *   C1  revenue 200: two bottles of cleaner at 5                                 cost  10  revenue  200
 *   C2  revenue 1000: paper billed back at cost on an issued invoice, 1 x 150,
 *       and three pads at 10                                                      cost  30  revenue  850
 *   C3  revenue 300: liners marked billed back, not on an invoice yet, at 40     cost  40  revenue  300
 *   C4  revenue 500: a supply with no cost recorded                               left out
 *   C5  revenue 100: a lockbox fitted, which is equipment and not a supply        cost   0  revenue  100
 *   C6  internal work, a supply at 15                                             not customer work
 *   C7  revenue 400, a supply at 8, finished in July                              another month
 *   C8  no revenue (its invoice was voided): soap marked billed back, on the
 *       voided invoice, at 20                                                     cost  20  revenue    0
 *
 *   Cost 10 + 30 + 40 + 0 + 20 = 100; revenue 200 + 850 + 300 + 100 + 0 = 1450.   100 / 1450 = 6.9%
 *   One supply line billed back and left out, counted beside.
 */
async function month(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  ids.C1 = await job("C1", "200");
  await used(ids.C1, { name: "Cleaner", quantity: "2", unitCost: "5" });
  ids.C2 = await job("C2", "1000", { revenueClass: "project" });
  await used(ids.C2, { name: "Paper", quantity: "1", unitCost: "150", billedBack: true, billedOn: await invoice("open"), unitPrice: "150" });
  await used(ids.C2, { name: "Pads", quantity: "3", unitCost: "10" });
  ids.C3 = await job("C3", "300");
  await used(ids.C3, { name: "Liners", quantity: "1", unitCost: "40", billedBack: true });
  ids.C4 = await job("C4", "500");
  await used(ids.C4, { name: "Mystery", quantity: "1", unitCost: null });
  ids.C5 = await job("C5", "100");
  await used(ids.C5, { name: "Lockbox", quantity: "1", unitCost: "24", kind: "equipment" });
  ids.C6 = await job("C6", "0", { revenueClass: "internal" });
  await used(ids.C6, { name: "Degreaser", quantity: "1", unitCost: "15" });
  ids.C7 = await job("C7", "400", { done: "2026-07-02" });
  await used(ids.C7, { name: "Cleaner", quantity: "1", unitCost: "8" });
  ids.C8 = await job("C8", "0");
  await used(ids.C8, { name: "Soap", quantity: "1", unitCost: "20", billedBack: true, billedOn: await invoice("void"), unitPrice: "20" });
  return ids;
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "supply_cost_pct")!;

run("supply cost share of revenue", () => {
  it("leaves a supply billed back at cost out of both halves, and a job with an uncosted supply out of both", async () => {
    const ids = await month();
    const kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["100.0000", "1450.0000", "6.9"]);
    expect(kpi.besides).toEqual([expect.objectContaining({ key: "excluded", count: "1" })]);

    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    const cost = await kpis.drill(owner(), { key: "supply_cost_pct", half: "numerator", ...WINDOW });
    expect(Object.fromEntries(cost.records.map((r) => [name(r.id), Number(r.value)])))
      .toEqual({ C1: 10, C2: 30, C3: 40, C5: 0, C8: 20 });
    const revenue = await kpis.drill(owner(), { key: "supply_cost_pct", half: "denominator", ...WINDOW });
    expect(Object.fromEntries(revenue.records.map((r) => [name(r.id), Number(r.value)])))
      .toEqual({ C1: 200, C2: 850, C3: 300, C5: 100, C8: 0 });
    const passed = await kpis.drill(owner(), { key: "supply_cost_pct", half: "excluded", ...WINDOW });
    expect(passed.records.map((r) => r.label)).toEqual([expect.stringContaining("Paper")]);
    expect(passed.records[0]!.href).toBe(`/jobs/${ids.C2}`);
  });

  it("puts the same jobs through core's rule and gets the same answer", async () => {
    await month();
    const rows = await raw<{ id: string; completed_at: Date; revenue_class: string; revenue: string }[]>`
      select j.id, j.completed_at, jt.revenue_class::text,
             (select coalesce(sum(case when le.direction = 'credit' then le.amount else -le.amount end), 0)
              from public.ledger_entry le where le.job_id = j.id and le.account_code in ('4000', '4100', '4900'))::text as revenue
      from public.job j join public.job_type jt on jt.id = j.job_type_id where j.organization_id = ${ORG}`;
    const lines = await raw<{
      job_id: string; kind: string; quantity: string; unit_cost: string | null; billed_back_at: Date | null;
      invoice_status: string | null; billed: string | null;
    }[]>`
      select jl.job_id, jl.kind::text, jl.quantity, jl.unit_cost, jl.billed_back_at, i.status::text as invoice_status,
             (il.quantity * il.unit_price - il.discount_amount - il.member_discount_amount)::text as billed
      from public.job_line jl
      left join public.invoice_line il on il.id = jl.invoice_line_id
      left join public.invoice i on i.id = il.invoice_id
      where jl.organization_id = ${ORG}`;
    let cost = 0;
    let revenue = 0;
    for (const row of rows) {
      if (row.revenue_class === "internal") continue;
      const day = row.completed_at.toLocaleDateString("en-CA", { timeZone: ZONE });
      if (day < WINDOW.from || day > WINDOW.to) continue;
      const verdict = reporting.supplyCostOf({
        revenue: Number(row.revenue),
        lines: lines.filter((l) => l.job_id === row.id).map((l) => ({
          kind: l.kind, quantity: Number(l.quantity), unitCost: l.unit_cost === null ? null : Number(l.unit_cost),
          billedBack: l.billed_back_at !== null,
          billedRevenue: l.invoice_status !== null && !["draft", "void"].includes(l.invoice_status) ? Number(l.billed) : null,
        })),
      });
      if (!verdict.counted) continue;
      cost += verdict.supplyCost;
      revenue += verdict.revenue;
    }
    const kpi = await figure();
    expect(Number(kpi.numerator)).toBeCloseTo(cost, 4);
    expect(Number(kpi.denominator)).toBeCloseTo(revenue, 4);
  });

  it("is a cost figure, so it takes what a job's margin takes", async () => {
    await month();
    const card = await kpis.scorecard(as("dispatcher"), WINDOW);
    const refused = card.unavailable.find((k) => k.key === "supply_cost_pct")!;
    expect(refused.needs).toMatch(/what jobs cost/);
  });
});

run("marking a supply as billed back", () => {
  it("is set and taken off on a supply line by whoever may change the job, and said on the line", async () => {
    const jobId = await job("Mark", "100");
    const line = await used(jobId, { name: "Paper", quantity: "2", unitCost: "12" });
    const labour = await used(jobId, { name: "Labour", quantity: "1", unitCost: "30", kind: "labor" });

    const marked = await jobs.markBilledBack(owner(), { id: line, billedBack: true });
    expect(marked.billedBackAt).not.toBeNull();
    const listed = (await jobs.lines(owner(), { id: jobId })).data.find((l) => l.id === line)!;
    expect(listed.billedBackAt).not.toBeNull();
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and entity_id = ${line} and action = 'job_line.billed_back'`;
    expect(audited.length).toBe(1);

    const unmarked = await jobs.markBilledBack(owner(), { id: line, billedBack: false });
    expect(unmarked.billedBackAt).toBeNull();

    await expect(jobs.markBilledBack(owner(), { id: labour, billedBack: true }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(jobs.markBilledBack(as("technician"), { id: line, billedBack: true })).rejects.toThrow(/job:write/);
  });
});
