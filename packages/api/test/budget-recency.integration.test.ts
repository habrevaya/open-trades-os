import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { money as m, type Actor } from "@opentradesos/core";
import * as budgets from "../src/services/budgets";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M15. A RUN RATE THAT WEIGHS RECENT MONTHS MORE, AND A BLEND FOR ONE LINE
 *
 * Revenue grows: the first month of this year 100, the second 200, and so on.
 * The even run rate is the plain average; weighing recent months more counts
 * the latest month most, so a growing line is forecast higher. One line can
 * have a blend of its own while every other keeps the year's choice. Only the
 * choices are stored; the forecast is worked out on every read.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("budget-recency:org");
const USER = fixtureId("budget-recency:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const finance = () => as(["accountant"]);

const YEAR = Number(companyToday().slice(0, 4));
const CLOSED = Number(companyToday().slice(5, 7)) - 1;
const all = (amount: string | null) => Array.from({ length: 12 }, () => amount);
const mid = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}-15T18:00:00Z`;

async function post(at: string, amount: string, debit: string, credit: string) {
  const tx = randomUUID();
  await raw.begin(async (sql) => {
    for (const [code, direction] of [[debit, "debit"], [credit, "credit"]] as const) {
      await sql`insert into public.ledger_entry
        (organization_id, transaction_id, occurred_at, direction, account_code, amount, source_type, source_id)
        values (${ORG}, ${tx}, ${at}, ${direction}, ${code}, ${amount}, 'invoice', ${randomUUID()})`;
    }
  });
}

/** What the months to come come to, to the cent, for a monthly figure times the months left. */
const toCome = (perMonth: number) => m.toString(m.round(m.multiply(m.money(String(perMonth)), String(12 - CLOSED))));

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });
beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Recency Co", slug: "budget-recency-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  /** Revenue growing by 100 a month; materials a flat 50 a month. */
  for (let month = 1; month <= CLOSED; month += 1) {
    await post(mid(YEAR, month), String(month * 100), "1200", "4000");
    await post(mid(YEAR, month), "50", "5000", "2000");
  }
  await budgets.setLine(finance(), { year: YEAR, line: "Revenue", amounts: all("1000") });
  await budgets.setLine(finance(), { year: YEAR, line: "Materials", amounts: all("80") });
});

const lineOf = (report: Awaited<ReturnType<typeof budgets.report>>, key: string) => report.lines.find((l) => l.line === key)!;

run("a run rate weighing recent months more", () => {
  it("is off until chosen, then counts the latest month most, and says so", async () => {
    if (CLOSED < 2) return;
    await budgets.setForecastMethod(finance(), { year: YEAR, method: "run_rate" });
    const even = await budgets.report(finance(), { year: YEAR });
    expect(even.forecast.recentWeighted).toBe(false);
    /** The plain average of 100, 200 ... is 100 times (months + 1) / 2. */
    expect(lineOf(even, "category:revenue").forecast.toCome).toBe(toCome((100 * (CLOSED + 1)) / 2));

    const chosen = await budgets.setForecastMethod(finance(), { year: YEAR, method: "run_rate", recentWeighted: true });
    expect(chosen).toMatchObject({ method: "run_rate", recentWeighted: true });
    const recent = await budgets.report(finance(), { year: YEAR });
    expect(recent.forecast.recentWeighted).toBe(true);
    expect(recent.forecast.assumption).toMatch(/recent months count for more/);
    /** Weighted 1, 2 ... months: 100 times (2 x months + 1) / 3, more than the plain average for a growing line. */
    const weighted = lineOf(recent, "category:revenue").forecast;
    const expected = m.round(m.divide(m.multiply(m.money(String(100 * (2 * CLOSED + 1))), String(12 - CLOSED)), "3"));
    expect(weighted.toCome).toBe(m.toString(expected));
    expect(m.compare(m.money(weighted.toCome), m.money(lineOf(even, "category:revenue").forecast.toCome))).toBe(1);
    /** A flat line is the same either way. */
    expect(lineOf(recent, "category:materials").forecast.toCome).toBe(toCome(50));
  });

  it("is kept when the method is chosen again without it, audited, and stores no forecast", async () => {
    await budgets.setForecastMethod(finance(), { year: YEAR, method: "run_rate", recentWeighted: true });
    await budgets.setForecastMethod(finance(), { year: YEAR, method: "run_rate" });
    expect((await budgets.report(finance(), { year: YEAR })).forecast.recentWeighted).toBe(true);
    const [row] = await raw`select run_rate_recent from public.budget where organization_id = ${ORG} and year = ${YEAR}`;
    expect((row as { run_rate_recent: boolean }).run_rate_recent).toBe(true);
    const audits = await raw`select after from public.audit_log where organization_id = ${ORG} and action = 'budget.forecast_method_set' order by created_at`;
    /** Chosen once; choosing the method again without it changes nothing, so writes nothing. */
    expect(audits.map((a) => (a as { after: { recentWeighted: boolean } }).after.recentWeighted)).toEqual([true]);
    await budgets.setForecastMethod(finance(), { year: YEAR, method: "run_rate", recentWeighted: false });
    expect((await budgets.report(finance(), { year: YEAR })).forecast.recentWeighted).toBe(false);
  });
});

run("a blend for one line", () => {
  it("forecasts that line by its own blend while every other line keeps the year's choice", async () => {
    if (CLOSED < 1) return;
    const set = await budgets.setLineBlend(finance(), { year: YEAR, line: "Revenue", weights: { budget: 50, runRate: 50, seasonal: 0 } });
    expect(set).toEqual({ year: YEAR, line: "category:revenue", weights: { budget: 50, runRate: 50, seasonal: 0 } });
    const report = await budgets.report(finance(), { year: YEAR });
    expect(report.forecast.chosen).toBe("budget");
    const revenue = lineOf(report, "category:revenue").forecast;
    expect(revenue.ownBlend).toEqual({ budget: 50, runRate: 50, seasonal: 0 });
    /** Half at the budget of 1,000 and half at the plain run rate. */
    expect(revenue.toCome).toBe(m.toString(m.round(m.add(
      m.multiply(m.money(toCome(1000)), "0.5"), m.multiply(m.money(toCome((100 * (CLOSED + 1)) / 2)), "0.5"),
    ))));
    expect(revenue.parts).toBeDefined();
    const materials = lineOf(report, "category:materials").forecast;
    expect(materials.ownBlend).toBeUndefined();
    expect(materials.toCome).toBe(toCome(80));
    expect(report.forecast.lineBlends).toEqual([{ line: "category:revenue", label: "Revenue", weights: { budget: 50, runRate: 50, seasonal: 0 } }]);
    expect(report.forecast.assumption).toMatch(/Revenue has a blend of its own/);
  });

  it("is taken off with no weights, refused for a line not in the budget or weights that do not add up, and audited", async () => {
    await budgets.setLineBlend(finance(), { year: YEAR, line: "Revenue", weights: { budget: 70, runRate: 30, seasonal: 0 } });
    await budgets.setLineBlend(finance(), { year: YEAR, line: "Revenue", weights: { budget: 70, runRate: 30, seasonal: 0 } });
    await expect(budgets.setLineBlend(finance(), { year: YEAR, line: "Labour", weights: { budget: 50, runRate: 50, seasonal: 0 } }))
      .rejects.toThrow(/not in the/);
    await expect(budgets.setLineBlend(finance(), { year: YEAR, line: "Revenue", weights: { budget: 50, runRate: 10, seasonal: 0 } }))
      .rejects.toMatchObject({ issues: [expect.objectContaining({ message: expect.stringMatching(/add up to 60/) })] });
    await expect(budgets.setLineBlend(finance(), { year: YEAR, line: "Revenue", weights: { budget: 0, runRate: 0, seasonal: 100 } }))
      .rejects.toMatchObject({ issues: [expect.objectContaining({ message: expect.stringMatching(/needs all of/) })] });
    await expect(budgets.setLineBlend(as(["office_manager"]), { year: YEAR, line: "Revenue", weights: null })).rejects.toThrow();
    const off = await budgets.setLineBlend(finance(), { year: YEAR, line: "Revenue", weights: null });
    expect(off).toEqual({ year: YEAR, line: "category:revenue", weights: null });
    const report = await budgets.report(finance(), { year: YEAR });
    expect(lineOf(report, "category:revenue").forecast.ownBlend).toBeUndefined();
    expect(report.forecast.lineBlends).toEqual([]);
    const audits = await raw`select action from public.audit_log where organization_id = ${ORG} and action like 'budget.line_blend%' order by created_at`;
    expect(audits.map((a) => (a as { action: string }).action)).toEqual(["budget.line_blend_set", "budget.line_blend_removed"]);
  });
});
