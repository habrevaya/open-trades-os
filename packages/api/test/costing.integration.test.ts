import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { costing as c, money as m, type Actor } from "@opentradesos/core";
import * as costing from "../src/services/costing";
import * as profitability from "../src/services/profitability";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M15. LABOUR BURDEN AND OVERHEAD ON A REAL JOB
 *
 * The figures, worked by hand:
 *
 *   revenue          1,000.00 from the ledger
 *   labour             136.00   four hours at a frozen loaded 34 (base 30)
 *   gross margin       864.00
 *   burden, March       13.99   2h: taxes 7.65% of 60, comp 4% of 60, benefits 3.50/h
 *   burden, August      15.19   2h: comp is 6% from July
 *   overhead            80.00   20 an hour over four hours
 *   fully loaded       754.82
 *
 * And the SQL that produces them is held to the TypeScript in core for the
 * same punches, because one copy of the arithmetic in SQL and another in
 * TypeScript is only safe while something checks they agree.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("costing:org");
const USER = fixtureId("costing:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";
let technicianId = "";

const RATES: c.CostingRate[] = [
  { component: "payroll_taxes", basis: "percent_of_wages", rate: "7.65", effectiveFrom: "2026-01-01" },
  { component: "workers_comp", basis: "percent_of_wages", rate: "4", effectiveFrom: "2026-01-01" },
  { component: "workers_comp", basis: "percent_of_wages", rate: "6", effectiveFrom: "2026-07-01" },
  { component: "benefits", basis: "per_hour", rate: "3.50", effectiveFrom: "2026-01-01" },
  { component: "overhead", basis: "per_hour", rate: "20", effectiveFrom: "2026-01-01" },
];

let number = 100;
async function job(input: { revenue: string; punches: { at: string; minutes: number; base: string | null }[]; completedAt: string; status?: string }) {
  number += 1;
  const [row] = await raw`insert into public.job (organization_id, number, customer_id, property_id, summary, status, completed_at)
    values (${ORG}, ${number}, ${customerId}, ${propertyId}, 'Furnace', ${input.status ?? "completed"}, ${input.completedAt})
    returning id`;
  const jobId = (row as { id: string }).id;
  for (const p of input.punches) {
    const start = new Date(p.at);
    const end = new Date(start.getTime() + p.minutes * 60_000);
    await raw`insert into public.timeclock_entry (organization_id, technician_id, job_id, kind, started_at, ended_at, minutes,
        applied_base_rate, applied_loaded_rate)
      values (${ORG}, ${technicianId}, ${jobId}, 'on_site', ${start}, ${end}, ${p.minutes}, ${p.base},
        ${p.base === null ? null : (Number(p.base) + 4).toFixed(2)})`;
  }
  const tx = randomUUID();
  await raw.begin(async (sql) => {
    await sql`insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction, account_code, amount, source_type, source_id, job_id)
      values (${ORG}, ${tx}, ${input.completedAt}, 'credit', '4000', ${input.revenue}, 'invoice', ${randomUUID()}, ${jobId}),
             (${ORG}, ${tx}, ${input.completedAt}, 'debit', '1200', ${input.revenue}, 'invoice', ${randomUUID()}, ${jobId})`;
  });
  return jobId;
}

async function setRates(rates: c.CostingRate[]) {
  for (const rate of rates) await costing.set(owner(), rate);
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Burden Co", slug: "burden-co" });
  const [c1] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Pat Lee') returning id`;
  customerId = (c1 as { id: string }).id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Oak St', 'Austin', 'TX', '78701') returning id`;
  propertyId = (p as { id: string }).id;
  const [membership] = await raw`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${(membership as { id: string }).id}, 'Sam Diaz') returning id`;
  technicianId = (t as { id: string }).id;
});

run("the fully loaded margin", () => {
  it("is the gross margin until a rate is set", async () => {
    const jobId = await job({ revenue: "1000", completedAt: "2026-08-11T18:00:00Z",
      punches: [{ at: "2026-03-10T15:00:00Z", minutes: 120, base: "30" }] });
    const statement = await profitability.statement(owner(), { jobId });
    expect(statement.labourBurden).toBe("0.0000");
    expect(statement.overhead).toBe("0.0000");
    expect(statement.fullyLoadedMargin).toBe(statement.grossMargin);
  });

  it("takes off burden at each punch's own rate and overhead at the job's", async () => {
    await setRates(RATES);
    const punches = [
      { at: "2026-03-10T15:00:00Z", minutes: 120, base: "30" },
      { at: "2026-08-10T15:00:00Z", minutes: 120, base: "30" },
    ];
    const jobId = await job({ revenue: "1000", completedAt: "2026-08-11T18:00:00Z", punches });
    const statement = await profitability.statement(owner(), { jobId });
    expect(statement.labourCost).toBe("136.0000");
    expect(statement.grossMargin).toBe("864.0000");
    expect(statement.labourBurden).toBe("29.1800");
    expect(statement.overhead).toBe("80.0000");
    expect(statement.fullyLoadedMargin).toBe("754.8200");
    expect(statement.fullyLoadedMarginPercent).toBe(75.5);
    expect(statement.caveats.overhead).toContain("fully loaded");

    /** The SQL and core agree on the same punches. */
    const core = c.labourBurden(
      punches.map((p) => ({ date: p.at.slice(0, 10), minutes: p.minutes, baseRate: p.base })), RATES,
    );
    expect(m.toString(m.round(core))).toBe("29.1800");
    const overhead = c.overhead({ date: "2026-08-11", minutes: 240, revenue: m.money("1000") }, RATES);
    expect(m.toString(overhead)).toBe(statement.overhead);
  });

  it("follows a change of overhead basis from its date, and charges a cancelled job none", async () => {
    await setRates([...RATES, { component: "overhead", basis: "percent_of_revenue", rate: "15", effectiveFrom: "2026-08-01" }]);
    const july = await job({ revenue: "1000", completedAt: "2026-07-20T18:00:00Z",
      punches: [{ at: "2026-07-20T15:00:00Z", minutes: 60, base: "30" }] });
    const august = await job({ revenue: "1000", completedAt: "2026-08-20T18:00:00Z",
      punches: [{ at: "2026-08-20T15:00:00Z", minutes: 60, base: "30" }] });
    const cancelled = await job({ revenue: "0", completedAt: "2026-08-20T18:00:00Z", status: "cancelled",
      punches: [{ at: "2026-08-20T15:00:00Z", minutes: 60, base: "30" }] });
    expect((await profitability.statement(owner(), { jobId: july })).overhead).toBe("20.0000");
    expect((await profitability.statement(owner(), { jobId: august })).overhead).toBe("150.0000");
    expect((await profitability.statement(owner(), { jobId: cancelled })).overhead).toBe("0.0000");
  });

  it("charges an unpriced hour only the per hour part", async () => {
    await setRates(RATES);
    const jobId = await job({ revenue: "500", completedAt: "2026-03-11T18:00:00Z",
      punches: [{ at: "2026-03-10T15:00:00Z", minutes: 60, base: null }] });
    expect((await profitability.statement(owner(), { jobId })).labourBurden).toBe("3.5000");
  });

  it("rolls up beside the gross margin on the report", async () => {
    await setRates(RATES);
    await job({ revenue: "1000", completedAt: "2026-08-11T18:00:00Z",
      punches: [{ at: "2026-03-10T15:00:00Z", minutes: 120, base: "30" }, { at: "2026-08-10T15:00:00Z", minutes: 120, base: "30" }] });
    const result = await profitability.summary(owner(), { by: "month", includeInProgress: true, from: "2026-01-01T00:00:00Z" });
    const row = result.rows[0] as Record<string, unknown>;
    expect(Number(row["fully_loaded_margin"])).toBeCloseTo(754.82, 2);
    expect(Number(row["gross_margin"])).toBeCloseTo(864, 2);
  });
});

run("the rates", () => {
  it("are dated, replayable, refused on a second answer for one day, and removable", async () => {
    const first = await costing.set(owner(), { component: "benefits", basis: "per_hour", rate: "3.50", effectiveFrom: "2026-01-01" });
    const again = await costing.set(owner(), { component: "benefits", basis: "per_hour", rate: "3.5", effectiveFrom: "2026-01-01" });
    expect(again.id).toBe(first.id);
    await expect(costing.set(owner(), { component: "benefits", basis: "per_hour", rate: "4", effectiveFrom: "2026-01-01" }))
      .rejects.toThrow(/already has a rate/);
    await expect(costing.set(owner(), { component: "overhead", basis: "percent_of_wages", rate: "4", effectiveFrom: "2026-01-01" }))
      .rejects.toThrow();
    const listed = await costing.list(owner());
    expect(listed.rates).toHaveLength(1);
    expect(listed.rates[0]!.rate).toBe("3.5");
    await costing.remove(owner(), { id: first.id });
    expect((await costing.list(owner())).rates).toHaveLength(0);
  });

  it("are set by finance and the owner, read by whoever sees job cost", async () => {
    await expect(costing.set(as(["office_manager"]), { component: "benefits", basis: "per_hour", rate: "1", effectiveFrom: "2026-01-01" }))
      .rejects.toThrow();
    await costing.set(as(["accountant"]), { component: "benefits", basis: "per_hour", rate: "1", effectiveFrom: "2026-01-01" });
    expect((await costing.list(as(["office_manager"]))).rates).toHaveLength(1);
    await expect(costing.list(as(["dispatcher"]))).rejects.toThrow();
  });

  it("price an hour for the settings screen", async () => {
    await setRates(RATES);
    const hour = await costing.hour(owner(), { baseRate: "30", on: "2026-03-10" });
    expect(hour).toMatchObject({ wage: "30.0000", burden: "7.0000", overhead: "20.0000", total: "57.0000" });
  });
});
