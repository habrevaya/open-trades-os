import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as budgets from "../src/services/budgets";
import * as company from "../src/services/company";
import { UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M15. A FORECAST SHAPED LIKE LAST YEAR, AND A BRANCH'S JOB TYPE
 *
 * Last year a company did 1,000 in January, 2,000 in February, and so on to
 * 12,000 in December: 78,000, most of it late. This year every month so far
 * came to twice last year's. Shaped like last year, the months already over
 * are the same share of the year they were then, so the year is twice last
 * year whatever month it is now: 156,000. The run rate reads the busy end of
 * the year as the quiet start. Choosing the shape is refused until a whole
 * year is in the books. And a budget line can be one job type's in one
 * branch, with a forecast that has nothing last year to follow taken at its
 * budget and saying so.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("budgets-seasonal:org");
const USER = fixtureId("budgets-seasonal:user");
const NEW_ORG = fixtureId("budgets-seasonal:new-org");
const NEW_USER = fixtureId("budgets-seasonal:new-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], organizationId = ORG, userId = USER): ServiceContext =>
  ({ actor: { userId, organizationId, roles }, db: db() });
const finance = () => as(["accountant"]);

const YEAR = Number(companyToday().slice(0, 4));
/** The months of this year already over: before the one the company is in. */
const CLOSED = Number(companyToday().slice(5, 7)) - 1;
const all = (amount: string | null) => Array.from({ length: 12 }, () => amount);
const mid = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}-15T18:00:00Z`;

/** Revenue straight onto the ledger, as an invoice posts it, on a branch and a job or neither. */
async function revenue(organizationId: string, at: string, amount: string, over: { branch?: string; job?: string } = {}) {
  const tx = randomUUID();
  /** Both sides in one transaction, because the ledger refuses a transaction that does not balance. */
  await raw.begin(async (sql) => {
    for (const [code, direction] of [["1200", "debit"], ["4000", "credit"]] as const) {
      await sql`insert into public.ledger_entry
        (organization_id, transaction_id, occurred_at, direction, account_code, amount, source_type, source_id, business_unit_id, job_id)
        values (${organizationId}, ${tx}, ${at}, ${direction}, ${code}, ${amount}, 'invoice', ${randomUUID()}, ${over.branch ?? null}, ${over.job ?? null})`;
    }
  });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });
beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await resetOrg(raw, NEW_ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Seasonal Co", slug: "budgets-seasonal-co" });
  await seedOrg(raw, { organizationId: NEW_ORG, userId: NEW_USER, name: "Seasonal Newcomer", slug: "budgets-seasonal-newcomer" });
  for (const id of [ORG, NEW_ORG]) await raw`update public.organization set timezone = 'America/Chicago' where id = ${id}`;
});

run("a forecast shaped like last year", () => {
  it("takes the months already over as last year's share of the year, worked by hand", async () => {
    for (let month = 1; month <= 12; month += 1) await revenue(ORG, mid(YEAR - 1, month), String(1000 * month));
    for (let month = 1; month <= CLOSED; month += 1) await revenue(ORG, mid(YEAR, month), String(2000 * month));
    await budgets.setLine(finance(), { year: YEAR, line: "Revenue", amounts: all("5000") });

    expect(await budgets.setForecastMethod(finance(), { year: YEAR, method: "seasonal" })).toEqual({ year: YEAR, method: "seasonal" });
    const report = await budgets.report(finance(), { year: YEAR });
    if (CLOSED === 0) {
      /** January: nothing is over, so there is nothing to scale last year by. */
      expect(report.forecast).toMatchObject({ chosen: "seasonal", method: "budget", fellBack: true });
      return;
    }
    expect(report.forecast).toMatchObject({ chosen: "seasonal", method: "seasonal", fellBack: false, linesWithoutShape: 0 });
    expect(report.forecast.assumption).toContain(`shaped like ${YEAR - 1}`);
    expect(report.forecast.assumption).toContain("not a promise");
    const [line] = report.lines;
    expect(line!.forecast.forecast).toBe("156000.0000");
    expect(line!.forecast).not.toHaveProperty("noShape");

    /** The run rate reads the late busy months as the early quiet ones, and comes out short. */
    await budgets.setForecastMethod(finance(), { year: YEAR, method: "run_rate" });
    const flat = (await budgets.report(finance(), { year: YEAR })).lines[0]!.forecast.forecast;
    expect(Number(flat)).toBeLessThan(156000);
  });

  it("is refused in words until a whole year is in the books", async () => {
    const newcomer = as(["accountant"], NEW_ORG, NEW_USER);
    await expect(budgets.setForecastMethod(newcomer, { year: YEAR, method: "seasonal" })).rejects.toThrow(UnprocessableError);
    await revenue(NEW_ORG, mid(YEAR - 1, 3), "500");
    const refused = await budgets.setForecastMethod(newcomer, { year: YEAR, method: "seasonal" }).catch((e: UnprocessableError) => e);
    expect(refused).toBeInstanceOf(UnprocessableError);
    expect((refused as UnprocessableError).issues[0]!.message)
      .toBe(`Shaping ${YEAR} like ${YEAR - 1} needs all of ${YEAR - 1} in your books, and the first entry in them is on ${YEAR - 1}-03-15, so ${YEAR - 1} is not whole. Take the months to come at their budget or at the run rate until it is.`);
    /** The budget and the run rate are always there. */
    expect(await budgets.setForecastMethod(newcomer, { year: YEAR, method: "run_rate" })).toEqual({ year: YEAR, method: "run_rate" });
  });
});

run("one job type's budget in one branch", () => {
  it("is a line of its own, read against that branch's entries on that type's jobs, at its budget with nothing last year to follow", async () => {
    const north = (await company.createBusinessUnit(as(["owner"]), { name: "North shop" })).id;
    const [type] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name) values (${ORG}, 'Service') returning id`;
    const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Lee Park') returning id`;
    const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, '4 Elm St', 'Austin', 'TX', '78701') returning id`;
    const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, summary, status, job_type_id)
      values (${ORG}, 901, ${c!.id}, ${p!.id}, 'Service call', 'completed', ${type!.id}) returning id`;
    /** A whole last year for the company, none of it in the north shop on service. */
    for (let month = 1; month <= 12; month += 1) await revenue(ORG, mid(YEAR - 1, month), "1000");
    /** This year: 700 on a north shop service job, 300 in the north shop on no job, 400 on a service job in no branch. */
    await revenue(ORG, mid(YEAR, 1), "700", { branch: north, job: job!.id });
    await revenue(ORG, mid(YEAR, 1), "300", { branch: north });
    await revenue(ORG, mid(YEAR, 1), "400", { job: job!.id });

    const set = await budgets.setLine(finance(), { year: YEAR, line: "Revenue", amounts: all("900"), businessUnitId: north, jobTypeId: type!.id });
    expect(set).toMatchObject({ businessUnitId: north, jobTypeId: type!.id, months: 12 });
    /** Setting it again replaces it, under its own index. */
    await budgets.setLine(finance(), { year: YEAR, line: "Revenue", amounts: all("1000"), businessUnitId: north, jobTypeId: type!.id });
    await budgets.setLine(finance(), { year: YEAR, line: "Revenue", amounts: all("50"), businessUnitId: north });

    await budgets.setForecastMethod(finance(), { year: YEAR, method: "seasonal" });
    const report = await budgets.report(finance(), { year: YEAR, businessUnitId: north, jobTypeId: type!.id });
    expect(report.branch).toMatchObject({ id: north, name: "North shop" });
    expect(report.jobType).toMatchObject({ id: type!.id, name: "Service" });
    expect(report.lines).toHaveLength(1);
    const [line] = report.lines;
    expect(line!.months[0]).toMatchObject({ budget: "1000.0000", actual: "700.0000" });
    if (CLOSED > 0) {
      expect(line!.forecast.noShape).toBe(true);
      expect(report.forecast).toMatchObject({ chosen: "seasonal", method: "budget", linesWithoutShape: 1 });
      expect(report.forecast.assumption).toContain(`no line had anything in ${YEAR - 1} to follow`);
      /** At its budget: what is over at its actual, the rest at 1,000 a month. */
      const over = line!.months.slice(0, CLOSED).reduce((sum, m) => sum + Number(m.actual), 0);
      expect(Number(line!.forecast.forecast)).toBe(over + 1000 * (12 - CLOSED));
    }
    /** The branch's own line and the job type's are their own statements. */
    expect((await budgets.report(finance(), { year: YEAR, businessUnitId: north })).lines[0]!.year.budget).toBe("600.0000");
    expect((await budgets.report(finance(), { year: YEAR, jobTypeId: type!.id })).lines).toEqual([]);
  });
});
