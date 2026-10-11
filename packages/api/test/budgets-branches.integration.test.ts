import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as budgets from "../src/services/budgets";
import * as company from "../src/services/company";
import { NotFoundError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M15. A BRANCH'S BUDGET AGAINST WHAT THE LEDGER PUT IN THAT BRANCH
 *
 * A budget line can be one branch's, and the report can be read for one
 * branch: that branch's own lines against the ledger entries that carry it.
 * The whole company's report is the lines with no branch against everything,
 * as it was, and a branch's lines are not added into it. Nothing old moves.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("budgets-branches:org");
const USER = fixtureId("budgets-branches:user");
const OTHER_ORG = fixtureId("budgets-branches:other-org");
const OTHER_USER = fixtureId("budgets-branches:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], organizationId = ORG, userId = USER): ServiceContext =>
  ({ actor: { userId, organizationId, roles }, db: db() });
const finance = () => as(["accountant"]);

let austin = "";
let houston = "";
let waco = "";
let elsewhere = "";

/** A balanced pair straight onto the ledger, in a branch or none, as a posting would make it. */
async function post(at: string, businessUnitId: string | null, entries: [string, "debit" | "credit", string][]) {
  const tx = randomUUID();
  await raw.begin(async (sql) => {
    for (const [code, direction, amount] of entries) {
      await sql`insert into public.ledger_entry
        (organization_id, transaction_id, occurred_at, direction, account_code, amount, source_type, source_id, business_unit_id)
        values (${ORG}, ${tx}, ${at}, ${direction}, ${code}, ${amount}, 'invoice', ${randomUUID()}, ${businessUnitId})`;
    }
  });
}

const twelve = (first: string, rest: string | null = null) => [first, ...Array.from({ length: 11 }, () => rest)];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });
beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Budget Branches Co", slug: "budget-branches-co" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Budget Next Door", slug: "budget-branches-next-door" });
  const owner = as(["owner"]);
  austin = (await company.createBusinessUnit(owner, { name: "Austin" })).id;
  houston = (await company.createBusinessUnit(owner, { name: "Houston" })).id;
  waco = (await company.createBusinessUnit(owner, { name: "Waco" })).id;
  await company.updateBusinessUnit(owner, { id: waco, active: false });
  elsewhere = (await company.createBusinessUnit(as(["owner"], OTHER_ORG, OTHER_USER), { name: "Elsewhere" })).id;
});

run("a branch's budget", () => {
  it("reads a branch's own lines against what the ledger put in that branch, and keeps the company's apart", async () => {
    // January: Austin invoices 6,000, Houston 3,000, and 1,000 carries no branch.
    await post("2026-01-15T18:00:00Z", austin, [["1200", "debit", "6000"], ["4000", "credit", "6000"]]);
    await post("2026-01-16T18:00:00Z", houston, [["1200", "debit", "3000"], ["4000", "credit", "3000"]]);
    await post("2026-01-17T18:00:00Z", null, [["1200", "debit", "1000"], ["4000", "credit", "1000"]]);

    await budgets.setLine(finance(), { year: 2026, line: "Revenue", amounts: twelve("12000") });
    const set = await budgets.setLine(finance(), { year: 2026, line: "Revenue", amounts: twelve("5000"), businessUnitId: austin });
    expect(set.businessUnitId).toBe(austin);

    const whole = await budgets.report(finance(), { year: 2026 });
    expect(whole.branch).toBeNull();
    /** The company's own line, against everything, and not the branch's figure added in. */
    expect(whole.lines[0]!.months[0]).toMatchObject({ budget: "12000.0000", actual: "10000.0000" });

    const inAustin = await budgets.report(finance(), { year: 2026, businessUnitId: austin });
    expect(inAustin.lines.map((l) => l.label)).toEqual(["Revenue"]);
    expect(inAustin.lines[0]!.months[0]).toMatchObject({ budget: "5000.0000", actual: "6000.0000", variance: "1000.0000", favourable: true });
    /** It says what it cannot hold: the year's entries with no branch. */
    expect(inAustin.branch).toEqual({ id: austin, name: "Austin", entriesWithoutBranch: 2, withoutBranchDebits: "1000.0000" });

    /** A branch with no lines of its own has none, whatever the company budgeted. */
    const inHouston = await budgets.report(finance(), { year: 2026, businessUnitId: houston });
    expect(inHouston.lines).toEqual([]);
  });

  it("sets, replaces and removes one branch's line without touching the company's or another branch's", async () => {
    await budgets.setLine(finance(), { year: 2026, line: "6100", amounts: twelve("100") });
    await budgets.setLine(finance(), { year: 2026, line: "6100", amounts: twelve("40"), businessUnitId: austin });
    await budgets.setLine(finance(), { year: 2026, line: "6100", amounts: twelve("60"), businessUnitId: houston });
    await budgets.setLine(finance(), { year: 2026, line: "6100", amounts: twelve("45"), businessUnitId: austin });

    const cells = await raw<{ business_unit_id: string | null; amount: string }[]>`
      select business_unit_id, amount::text from public.budget_line
      where organization_id = ${ORG} and month = 1 order by budget_line.amount`;
    expect(cells).toEqual([
      { business_unit_id: austin, amount: "45.0000" },
      { business_unit_id: houston, amount: "60.0000" },
      { business_unit_id: null, amount: "100.0000" },
    ]);

    await budgets.removeLine(finance(), { year: 2026, line: "6100", businessUnitId: austin });
    expect((await budgets.report(finance(), { year: 2026, businessUnitId: austin })).lines).toEqual([]);
    expect((await budgets.report(finance(), { year: 2026, businessUnitId: houston })).lines).toHaveLength(1);
    expect((await budgets.report(finance(), { year: 2026 })).lines).toHaveLength(1);
  });

  it("loads a spreadsheet into one branch", async () => {
    const done = await budgets.importCsv(finance(), {
      year: 2026, csv: "Line,Jan,Feb\nRevenue,7000,7500\nMaterials,2000,2100", businessUnitId: houston,
    });
    expect(done).toMatchObject({ lines: 2, cells: 4 });
    expect((await budgets.report(finance(), { year: 2026, businessUnitId: houston })).lines.map((l) => l.label))
      .toEqual(["Revenue", "Materials"]);
    expect((await budgets.report(finance(), { year: 2026 })).lines).toEqual([]);
  });

  it("refuses another company's branch, and a retired branch for anything new", async () => {
    await expect(budgets.setLine(finance(), { year: 2026, line: "Revenue", amounts: twelve("1"), businessUnitId: elsewhere }))
      .rejects.toThrow(NotFoundError);
    await expect(budgets.report(finance(), { year: 2026, businessUnitId: elsewhere })).rejects.toThrow(NotFoundError);
    await expect(budgets.setLine(finance(), { year: 2026, line: "Revenue", amounts: twelve("1"), businessUnitId: waco }))
      .rejects.toThrow(UnprocessableError);
    await expect(budgets.importCsv(finance(), { year: 2026, csv: "Line,Jan\nRevenue,1", businessUnitId: waco }))
      .rejects.toThrow(/Waco has been retired|retired/);
    /** A retired branch's year can still be read: its postings did not go anywhere. */
    expect((await budgets.report(finance(), { year: 2026, businessUnitId: waco })).branch?.name).toBe("Waco");
  });
});
