import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { money as m, type Actor } from "@opentradesos/core";
import * as budgets from "../src/services/budgets";
import { UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M15. THE FORECAST BY MONTH, A BLEND, AND A SHAPE FROM SEVERAL YEARS
 *
 * A budget of 1,000 a month for Revenue, and 1,500 a month actually done in
 * every month of this year already over. By the budget the months to come are
 * 1,000 each; by the run rate 1,500 each; a blend of 60 budget and 40 run rate
 * is 1,200 each. Each line gives the year month by month, adding up to its
 * forecast. A shape can be the average of several past years, refused until
 * all of them are in the books. Nothing about the forecast is stored as the
 * budget.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("budget-blend:org");
const USER = fixtureId("budget-blend:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const finance = () => as(["accountant"]);

const YEAR = Number(companyToday().slice(0, 4));
const CLOSED = Number(companyToday().slice(5, 7)) - 1;
const all = (amount: string | null) => Array.from({ length: 12 }, () => amount);
const mid = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}-15T18:00:00Z`;

async function revenue(at: string, amount: string) {
  const tx = randomUUID();
  await raw.begin(async (sql) => {
    for (const [code, direction] of [["1200", "debit"], ["4000", "credit"]] as const) {
      await sql`insert into public.ledger_entry
        (organization_id, transaction_id, occurred_at, direction, account_code, amount, source_type, source_id)
        values (${ORG}, ${tx}, ${at}, ${direction}, ${code}, ${amount}, 'invoice', ${randomUUID()})`;
    }
  });
}

const sum = (values: readonly string[]) => m.toString(values.reduce((a, v) => m.add(a, m.money(v)), m.zero()));

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });
beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Blend Co", slug: "budget-blend-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
});

run("the forecast by month", () => {
  it("gives every line its year month by month, adding up to the forecast, and stores none of it", async () => {
    for (let month = 1; month <= CLOSED; month += 1) await revenue(mid(YEAR, month), "1500");
    await budgets.setLine(finance(), { year: YEAR, line: "Revenue", amounts: all("1000") });
    const before = await raw`select month, amount::text from public.budget_line bl join public.budget b on b.id = bl.budget_id
      where b.organization_id = ${ORG} order by month`;

    const report = await budgets.report(finance(), { year: YEAR });
    const line = report.lines[0]!;
    expect(line.forecast.months).toHaveLength(12);
    expect(sum(line.forecast.months)).toBe(line.forecast.forecast);
    expect(line.forecast.months.slice(0, CLOSED)).toEqual(Array(CLOSED).fill("1500.0000"));
    expect(line.forecast.months.slice(CLOSED)).toEqual(Array(12 - CLOSED).fill("1000.0000"));
    expect(report.forecast).toMatchObject({ weights: null, seasonalYears: 1 });

    const after = await raw`select month, amount::text from public.budget_line bl join public.budget b on b.id = bl.budget_id
      where b.organization_id = ${ORG} order by month`;
    expect(after).toEqual(before);
  });
});

run("a blend of the three", () => {
  it("weighs the budget and the run rate month by month, and says so", async () => {
    for (let month = 1; month <= CLOSED; month += 1) await revenue(mid(YEAR, month), "1500");
    await budgets.setLine(finance(), { year: YEAR, line: "Revenue", amounts: all("1000") });
    const chosen = await budgets.setForecastMethod(finance(), {
      year: YEAR, method: "blend", weights: { budget: 60, runRate: 40, seasonal: 0 },
    });
    expect(chosen).toEqual({ year: YEAR, method: "blend", weights: { budget: 60, runRate: 40, seasonal: 0 } });

    const report = await budgets.report(finance(), { year: YEAR });
    expect(report.forecast).toMatchObject({ chosen: "blend", method: "blend", weights: { budget: 60, runRate: 40, seasonal: 0 } });
    expect(report.forecast.assumption).toContain("60% at their budget and 40% at the run rate so far");
    expect(report.forecast.assumption).toContain("not a promise");
    const line = report.lines[0]!;
    if (CLOSED === 0) {
      /** January: no run rate yet, so the whole blend is at the budget. */
      expect(report.forecast.fellBack).toBe(true);
      expect(line.forecast.forecast).toBe("12000.0000");
      return;
    }
    expect(line.forecast.months.slice(CLOSED)).toEqual(Array(12 - CLOSED).fill("1200.0000"));
    expect(line.forecast.forecast).toBe(m.toString(m.money(String(1500 * CLOSED + 1200 * (12 - CLOSED)))));
    expect(line.forecast.parts).toEqual({
      budget: m.toString(m.money(String(1000 * (12 - CLOSED)))),
      runRate: m.toString(m.money(String(1500 * (12 - CLOSED)))),
      seasonal: m.toString(m.money(String(1000 * (12 - CLOSED)))),
    });
  });

  it("refuses weights that do not add up to 100, and a blend with none, in words", async () => {
    await expect(budgets.setForecastMethod(finance(), {
      year: YEAR, method: "blend", weights: { budget: 50, runRate: 30, seasonal: 0 },
    })).rejects.toMatchObject({ issues: [expect.objectContaining({ message: expect.stringMatching(/add up to 80/) })] });
    await expect(budgets.setForecastMethod(finance(), { year: YEAR, method: "blend" })).rejects.toThrow(UnprocessableError);
    await expect(budgets.setForecastMethod(as(["office_manager"]), {
      year: YEAR, method: "blend", weights: { budget: 100, runRate: 0, seasonal: 0 },
    })).rejects.toThrow();
  });

  it("is audited once, and sending it again changes nothing", async () => {
    const choice = { year: YEAR, method: "blend" as const, weights: { budget: 50, runRate: 50, seasonal: 0 } };
    await budgets.setForecastMethod(finance(), choice);
    await budgets.setForecastMethod(finance(), choice);
    const rows = await raw`select after from public.audit_log where organization_id = ${ORG} and action = 'budget.forecast_method_set'`;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { after: Record<string, unknown> }).after).toMatchObject({ forecastMethod: "blend", forecastWeights: choice.weights });
  });
});

run("a shape from several past years", () => {
  it("averages the past years, so one odd month counts for less", async () => {
    /** Two years ago a flat 1,000 a month; last year the same but a one off 13,000 in December. */
    for (let month = 1; month <= 12; month += 1) {
      await revenue(mid(YEAR - 2, month), "1000");
      await revenue(mid(YEAR - 1, month), month === 12 ? "13000" : "1000");
    }
    for (let month = 1; month <= CLOSED; month += 1) await revenue(mid(YEAR, month), "1000");
    await budgets.setLine(finance(), { year: YEAR, line: "Revenue", amounts: all("1000") });

    await budgets.setForecastMethod(finance(), { year: YEAR, method: "seasonal" });
    const one = (await budgets.report(finance(), { year: YEAR }));
    expect(await budgets.setForecastMethod(finance(), { year: YEAR, method: "seasonal", seasonalYears: 2 }))
      .toEqual({ year: YEAR, method: "seasonal", seasonalYears: 2 });
    const two = await budgets.report(finance(), { year: YEAR });
    expect(two.forecast.seasonalYears).toBe(2);
    if (CLOSED === 0 || CLOSED === 12) return;
    expect(two.forecast.assumption).toContain(`the average of ${YEAR - 2} to ${YEAR - 1}`);
    /**
     * Last year alone: the closed months were 1,000 of 24,000, so December's
     * one off is read as a big December coming. Averaged with the flat year it
     * counts for half as much.
     */
    const lastYearOnly = Number(one.lines[0]!.forecast.forecast);
    const averaged = Number(two.lines[0]!.forecast.forecast);
    expect(averaged).toBeLessThan(lastYearOnly);
    expect(averaged).toBeCloseTo((1000 * CLOSED) * (12 + 24) / (2 * CLOSED), 0);
    expect(sum(two.lines[0]!.forecast.months)).toBe(two.lines[0]!.forecast.forecast);
  });

  it("is refused in words until every one of those years is in the books", async () => {
    await revenue(mid(YEAR - 2, 3), "500");
    await revenue(mid(YEAR - 1, 1), "500");
    expect(await budgets.setForecastMethod(finance(), { year: YEAR, method: "seasonal", seasonalYears: 1 }))
      .toEqual({ year: YEAR, method: "seasonal" });
    const refused = await budgets.setForecastMethod(finance(), { year: YEAR, method: "seasonal", seasonalYears: 2 })
      .catch((e: UnprocessableError) => e);
    expect(refused).toBeInstanceOf(UnprocessableError);
    expect((refused as UnprocessableError).issues[0]!.message).toBe(
      `Shaping ${YEAR} like the average of ${YEAR - 2} to ${YEAR - 1} needs all of ${YEAR - 2} to ${YEAR - 1} in your books, `
      + `and the first entry in them is on ${YEAR - 2}-03-15, so ${YEAR - 2} to ${YEAR - 1} are not whole.`
      + " Use fewer years, or take the months to come at their budget or at the run rate until they are.",
    );
    /** A blend that weighs the shape needs the years too; one that does not, does not. */
    await expect(budgets.setForecastMethod(finance(), {
      year: YEAR, method: "blend", weights: { budget: 50, runRate: 0, seasonal: 50 }, seasonalYears: 2,
    })).rejects.toThrow(UnprocessableError);
    await budgets.setForecastMethod(finance(), {
      year: YEAR, method: "blend", weights: { budget: 50, runRate: 50, seasonal: 0 }, seasonalYears: 2,
    });
    await expect(budgets.setForecastMethod(finance(), { year: YEAR, method: "seasonal", seasonalYears: 6 }))
      .rejects.toThrow(UnprocessableError);
  });
});
