import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as budgets from "../src/services/budgets";
import * as company from "../src/services/company";
import { NotFoundError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M15. A JOB TYPE'S BUDGET, AND WHERE THE YEAR IS HEADING
 *
 * A budget line can be one job type's, read against the ledger entries made
 * from that type's jobs, and kept apart from the company's and every
 * branch's. And every line carries a year end forecast: the months already
 * over at their actual, the rest at their budget or, when the company chose
 * it, at the run rate. Worked by hand in each test.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("budgets-job-types:org");
const USER = fixtureId("budgets-job-types:user");
const OTHER_ORG = fixtureId("budgets-job-types:other-org");
const OTHER_USER = fixtureId("budgets-job-types:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], organizationId = ORG, userId = USER): ServiceContext =>
  ({ actor: { userId, organizationId, roles }, db: db() });
const finance = () => as(["accountant"]);

let installs = "";
let repairs = "";
let retired = "";
let elsewhere = "";
let customerId = "";
let propertyId = "";
let number = 500;

async function jobType(organizationId: string, name: string, active = true): Promise<string> {
  const [row] = await raw`insert into public.job_type (organization_id, name, active) values (${organizationId}, ${name}, ${active}) returning id`;
  return (row as { id: string }).id;
}

async function job(jobTypeId: string | null): Promise<string> {
  number += 1;
  const [row] = await raw`insert into public.job (organization_id, number, customer_id, property_id, summary, status, job_type_id)
    values (${ORG}, ${number}, ${customerId}, ${propertyId}, 'Work', 'completed', ${jobTypeId}) returning id`;
  return (row as { id: string }).id;
}

/** A balanced pair straight onto the ledger, on a job or none, as a posting would make it. */
async function post(at: string, jobId: string | null, entries: [string, "debit" | "credit", string][]) {
  const tx = randomUUID();
  await raw.begin(async (sql) => {
    for (const [code, direction, amount] of entries) {
      await sql`insert into public.ledger_entry
        (organization_id, transaction_id, occurred_at, direction, account_code, amount, source_type, source_id, job_id)
        values (${ORG}, ${tx}, ${at}, ${direction}, ${code}, ${amount}, 'invoice', ${randomUUID()}, ${jobId})`;
    }
  });
}

const all = (amount: string | null) => Array.from({ length: 12 }, () => amount);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });
beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Budget Types Co", slug: "budget-job-types-co" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Budget Types Next Door", slug: "budget-job-types-next-door" });
  installs = await jobType(ORG, "Installs");
  repairs = await jobType(ORG, "Repairs");
  retired = await jobType(ORG, "Duct cleaning", false);
  elsewhere = await jobType(OTHER_ORG, "Their installs");
  const [c] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Lee Park') returning id`;
  customerId = (c as { id: string }).id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Elm St', 'Austin', 'TX', '78701') returning id`;
  propertyId = (p as { id: string }).id;
});

run("a job type's budget", () => {
  it("reads a job type's own lines against the entries on its jobs, and keeps the company's apart", async () => {
    const install = await job(installs);
    const repair = await job(repairs);
    // 2025: an install invoiced at 8,000 with a 200 card fee, a repair at 1,500, and rent of 2,000 on no job.
    await post("2025-03-10T18:00:00Z", install, [["1200", "debit", "8000"], ["4000", "credit", "8000"]]);
    await post("2025-03-11T18:00:00Z", install, [["6100", "debit", "200"], ["1000", "credit", "200"]]);
    await post("2025-03-12T18:00:00Z", repair, [["1200", "debit", "1500"], ["4000", "credit", "1500"]]);
    await post("2025-03-13T18:00:00Z", null, [["6500", "debit", "2000"], ["1000", "credit", "2000"]]);

    await budgets.setLine(finance(), { year: 2025, line: "Revenue", amounts: all("10000") });
    const set = await budgets.setLine(finance(), { year: 2025, line: "Revenue", amounts: all("7000"), jobTypeId: installs });
    expect(set).toMatchObject({ jobTypeId: installs, businessUnitId: null });
    await budgets.setLine(finance(), { year: 2025, line: "Overhead", amounts: all("100"), jobTypeId: installs });

    const whole = await budgets.report(finance(), { year: 2025 });
    expect(whole.jobType).toBeNull();
    expect(whole.lines.map((l) => l.label)).toEqual(["Revenue"]);
    expect(whole.lines[0]!.months[2]).toMatchObject({ budget: "10000.0000", actual: "9500.0000" });

    const forInstalls = await budgets.report(finance(), { year: 2025, jobTypeId: installs });
    expect(forInstalls.lines.map((l) => l.label)).toEqual(["Revenue", "Overhead"]);
    expect(forInstalls.lines[0]!.months[2]).toMatchObject({ budget: "7000.0000", actual: "8000.0000", favourable: true });
    /** The card fee is on the install, so it is in the install's overhead; the rent is on no job, so it is not. */
    expect(forInstalls.lines[1]!.months[2]).toMatchObject({ budget: "100.0000", actual: "200.0000", favourable: false });
    /** It says what it cannot hold: the year's entries on no job. */
    expect(forInstalls.jobType).toEqual({ id: installs, name: "Installs", entriesWithoutJob: 2, withoutJobDebits: "2000.0000" });
    expect(forInstalls.branch).toBeNull();

    /** A job type with no lines of its own has none, whatever the company budgeted. */
    expect((await budgets.report(finance(), { year: 2025, jobTypeId: repairs })).lines).toEqual([]);
  });

  it("sets, replaces, loads and removes one job type's line without touching anybody else's", async () => {
    const owner = as(["owner"]);
    const branch = (await company.createBusinessUnit(owner, { name: "Austin" })).id;
    await budgets.setLine(finance(), { year: 2026, line: "6100", amounts: all("100") });
    await budgets.setLine(finance(), { year: 2026, line: "6100", amounts: all("30"), businessUnitId: branch });
    await budgets.setLine(finance(), { year: 2026, line: "6100", amounts: all("40"), jobTypeId: installs });
    await budgets.setLine(finance(), { year: 2026, line: "6100", amounts: all("45"), jobTypeId: installs });
    await budgets.importCsv(finance(), { year: 2026, csv: "Line,Jan\n6100,60", jobTypeId: repairs });

    const cells = await raw<{ business_unit_id: string | null; job_type_id: string | null; amount: string }[]>`
      select business_unit_id, job_type_id, amount::text from public.budget_line
      where organization_id = ${ORG} and month = 1 order by budget_line.amount`;
    expect(cells).toEqual([
      { business_unit_id: branch, job_type_id: null, amount: "30.0000" },
      { business_unit_id: null, job_type_id: installs, amount: "45.0000" },
      { business_unit_id: null, job_type_id: repairs, amount: "60.0000" },
      { business_unit_id: null, job_type_id: null, amount: "100.0000" },
    ]);

    await budgets.removeLine(finance(), { year: 2026, line: "6100", jobTypeId: installs });
    expect((await budgets.report(finance(), { year: 2026, jobTypeId: installs })).lines).toEqual([]);
    expect((await budgets.report(finance(), { year: 2026, jobTypeId: repairs })).lines).toHaveLength(1);
    expect((await budgets.report(finance(), { year: 2026, businessUnitId: branch })).lines).toHaveLength(1);
    expect((await budgets.report(finance(), { year: 2026 })).lines).toHaveLength(1);
  });

  it("refuses a branch and a job type at once, another company's job type, and one switched off for anything new", async () => {
    const branch = (await company.createBusinessUnit(as(["owner"]), { name: "Houston" })).id;
    await expect(budgets.setLine(finance(), { year: 2026, line: "Revenue", amounts: all("1"), businessUnitId: branch, jobTypeId: installs }))
      .rejects.toThrow(UnprocessableError);
    await expect(budgets.report(finance(), { year: 2026, businessUnitId: branch, jobTypeId: installs }))
      .rejects.toThrow(UnprocessableError);
    await expect(budgets.setLine(finance(), { year: 2026, line: "Revenue", amounts: all("1"), jobTypeId: elsewhere }))
      .rejects.toThrow(NotFoundError);
    await expect(budgets.report(finance(), { year: 2026, jobTypeId: elsewhere })).rejects.toThrow(NotFoundError);
    await expect(budgets.setLine(finance(), { year: 2026, line: "Revenue", amounts: all("1"), jobTypeId: retired }))
      .rejects.toThrow(/switched off/);
    /** Its year can still be read. */
    expect((await budgets.report(finance(), { year: 2026, jobTypeId: retired })).jobType?.name).toBe("Duct cleaning");
    /** And the database holds the rule too. */
    const [b] = await raw`insert into public.budget (organization_id, year) values (${ORG}, 2031) returning id`;
    await expect(raw`insert into public.budget_line (organization_id, budget_id, business_unit_id, job_type_id, line, month, amount)
      values (${ORG}, ${(b as { id: string }).id}, ${branch}, ${installs}, 'category:revenue', 1, 1)`).rejects.toThrow(/budget_line_one_scope/);
  });
});

run("the year end forecast", () => {
  it("is what the books say for a year that is over", async () => {
    await post("2025-02-10T18:00:00Z", null, [["1200", "debit", "4000"], ["4000", "credit", "4000"]]);
    await budgets.setLine(finance(), { year: 2025, line: "Revenue", amounts: all("1000") });
    const report = await budgets.report(finance(), { year: 2025 });
    expect(report.forecast).toMatchObject({ chosen: "budget", method: "budget", closed: 12, fellBack: false });
    expect(report.forecast.assumption).toContain("not a promise");
    expect(report.lines[0]!.forecast).toMatchObject({
      closedActual: "4000.0000", toCome: "0.0000", forecast: "4000.0000", variance: "-8000.0000", favourable: false,
    });
    expect(report.forecast.net).toEqual({ forecast: "4000.0000", budget: "12000.0000" });
  });

  it("takes a year not begun at its budget, and says the run rate has to wait", async () => {
    const next = Number(companyToday().slice(0, 4)) + 1;
    const months = all("500");
    months[11] = null;
    await budgets.setLine(finance(), { year: next, line: "Labour", amounts: months });
    await budgets.setForecastMethod(finance(), { year: next, method: "run_rate" });
    const report = await budgets.report(finance(), { year: next });
    expect(report.forecast).toMatchObject({ chosen: "run_rate", method: "budget", closed: 0, fellBack: true });
    expect(report.forecast.assumption).toContain("has not started");
    /** Eleven months at 500, December with no budget counted as nothing. */
    expect(report.lines[0]!.forecast).toMatchObject({ forecast: "5500.0000", unbudgetedMonths: 1, favourable: null });
    /** No revenue line, so no net. */
    expect(report.forecast.net).toBeNull();
  });

  it("reads this year's closed months at their actual and the rest by the company's choice", async () => {
    const today = companyToday();
    const year = Number(today.slice(0, 4));
    const closed = Number(today.slice(5, 7)) - 1;
    /** 1,200 of revenue in every month so far, including this one, which the forecast does not read until it is over. */
    for (let month = 1; month <= closed + 1; month += 1) {
      await post(`${year}-${String(month).padStart(2, "0")}-10T18:00:00Z`, null, [["1200", "debit", "1200"], ["4000", "credit", "1200"]]);
    }
    await budgets.setLine(finance(), { year, line: "Revenue", amounts: all("1000") });

    const byBudget = await budgets.report(finance(), { year });
    expect(byBudget.forecast.closed).toBe(closed);
    expect(Number(byBudget.lines[0]!.forecast.closedActual)).toBe(1200 * closed);
    expect(Number(byBudget.lines[0]!.forecast.forecast)).toBe(1200 * closed + 1000 * (12 - closed));

    const chose = await budgets.setForecastMethod(finance(), { year, method: "run_rate" });
    expect(chose).toEqual({ year, method: "run_rate" });
    /** Choosing it again is the same answer, and writes nothing twice. */
    await budgets.setForecastMethod(finance(), { year, method: "run_rate" });
    const audits = await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'budget.forecast_method_set'`;
    expect(audits).toHaveLength(1);

    const byRunRate = await budgets.report(finance(), { year });
    if (closed === 0) {
      expect(byRunRate.forecast).toMatchObject({ method: "budget", fellBack: true });
    } else {
      expect(byRunRate.forecast).toMatchObject({ chosen: "run_rate", method: "run_rate", fellBack: false });
      expect(Number(byRunRate.lines[0]!.forecast.forecast)).toBe(1200 * 12);
      expect(byRunRate.lines[0]!.forecast.favourable).toBe(true);
      expect(byRunRate.forecast.assumption).toContain("average");
    }
  });

  it("is chosen by whoever sets the budget, and read by whoever reads it", async () => {
    await expect(budgets.setForecastMethod(as(["office_manager"]), { year: 2026, method: "run_rate" })).rejects.toThrow();
    await budgets.setForecastMethod(as(["owner"]), { year: 2026, method: "run_rate" });
    expect((await budgets.report(as(["accountant"]), { year: 2026 })).forecast.chosen).toBe("run_rate");
  });
});
