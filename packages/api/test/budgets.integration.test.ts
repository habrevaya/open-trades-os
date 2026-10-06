import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as budgets from "../src/services/budgets";
import * as journals from "../src/services/journals";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M15. THE COMPANY BUDGET AGAINST THE LEDGER
 *
 * The actual is the ledger in the company's calendar: revenue net of
 * discounts, costs by category, a journal booked into a month counted in it,
 * and a posting at eleven at night on the last day of a month counted in that
 * month and not the next one, which is where a UTC month would put it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("budgets:org");
const USER = fixtureId("budgets:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const finance = () => as(["accountant"]);

/** A balanced pair straight onto the ledger, as an invoice posting would make it. */
async function post(at: string, entries: [string, "debit" | "credit", string][]) {
  const tx = randomUUID();
  await raw.begin(async (sql) => {
    for (const [code, direction, amount] of entries) {
      await sql`insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction, account_code, amount, source_type, source_id)
        values (${ORG}, ${tx}, ${at}, ${direction}, ${code}, ${amount}, 'invoice', ${randomUUID()})`;
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
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Budget Co", slug: "budget-co" });
});

run("budget against actual", () => {
  it("reads revenue net of discounts and costs by category, month by month in the company's calendar", async () => {
    // January: 10,000 invoiced, 500 discounted. 23:30 on 31 January in Chicago is February in UTC.
    await post("2026-01-15T18:00:00Z", [["1200", "debit", "10000"], ["4000", "credit", "10000"]]);
    await post("2026-01-20T18:00:00Z", [["4900", "debit", "500"], ["1200", "credit", "500"]]);
    await post("2026-02-01T05:30:00Z", [["1200", "debit", "1000"], ["4000", "credit", "1000"]]);
    // A card fee and a write off are overhead; rent arrives by journal.
    await post("2026-01-22T18:00:00Z", [["6100", "debit", "290"], ["1000", "credit", "290"]]);
    await journals.create(finance(), {
      occurredOn: "2026-01-31", memo: "January rent",
      lines: [{ accountCode: "6500", debit: "2000" }, { accountCode: "1000", credit: "2000" }],
    });

    await budgets.setLine(finance(), { year: 2026, line: "Revenue", amounts: twelve("10000", "12000") });
    await budgets.setLine(finance(), { year: 2026, line: "overhead", amounts: twelve("2000", "2000") });
    await budgets.setLine(finance(), { year: 2026, line: "6100", amounts: twelve("250", "250") });

    const report = await budgets.report(finance(), { year: 2026 });
    expect(report.lines.map((l) => l.label)).toEqual(["Revenue", "Overhead", "Account 6100"]);
    const revenue = report.lines[0]!;
    expect(revenue.months[0]).toMatchObject({ budget: "10000.0000", actual: "10500.0000", variance: "500.0000", favourable: true });
    const overhead = report.lines[1]!;
    expect(overhead.months[0]).toMatchObject({ actual: "2290.0000", variance: "290.0000", favourable: false });
    expect(report.lines[2]!.months[0]!.actual).toBe("290.0000");
    expect(report.caveat).toContain("journals");
    expect(report.net).not.toBeNull();
  });

  it("imports a spreadsheet, replacing only the lines in it, and refuses a bad one whole", async () => {
    await budgets.setLine(finance(), { year: 2026, line: "Labour", amounts: twelve("3000") });
    const result = await budgets.importCsv(finance(), {
      year: 2026,
      csv: "Line,Jan,Feb,Mar\nRevenue,\"80,000\",85000,90000\nMaterials,20000,,21000\n",
    });
    expect(result).toEqual({ year: 2026, lines: 2, cells: 5 });
    const report = await budgets.report(finance(), { year: 2026 });
    expect(report.lines.map((l) => l.label)).toEqual(["Revenue", "Materials", "Labour"]);
    expect(report.lines[1]!.months[1]!.budget).toBeNull();
    expect(report.lines[0]!.year.budget).toBe("255000.0000");

    await expect(budgets.importCsv(finance(), { year: 2026, csv: "Line,Jan\nRevenue,lots\nPets,4\n" }))
      .rejects.toThrow(/problems/);
    expect((await budgets.report(finance(), { year: 2026 })).lines[0]!.year.budget).toBe("255000.0000");

    /** The same file twice leaves the same budget. */
    await budgets.importCsv(finance(), { year: 2026, csv: "Line,Jan,Feb,Mar\nRevenue,\"80,000\",85000,90000\nMaterials,20000,,21000\n" });
    expect((await budgets.report(finance(), { year: 2026 })).lines[0]!.year.budget).toBe("255000.0000");
  });

  it("removes a line, and is written by finance and read with the financial reports", async () => {
    await budgets.setLine(finance(), { year: 2026, line: "Revenue", amounts: twelve("1") });
    await budgets.removeLine(finance(), { year: 2026, line: "revenue" });
    expect((await budgets.report(finance(), { year: 2026 })).lines).toHaveLength(0);
    await expect(budgets.setLine(as(["office_manager"]), { year: 2026, line: "Revenue", amounts: twelve("1") })).rejects.toThrow();
    await expect(budgets.report(as(["office_manager"]), { year: 2026 })).rejects.toThrow();
    await expect(budgets.setLine(finance(), { year: 2026, line: "Pets", amounts: twelve("1") })).rejects.toThrow(/Not a budget line/);
  });

  it("shows no variance for a month that has not happened", async () => {
    await budgets.setLine(finance(), { year: 2099, line: "Revenue", amounts: twelve("100", "100") });
    const report = await budgets.report(finance(), { year: 2099 });
    expect(report.through).toBe(0);
    expect(report.lines[0]!.months.every((month) => month.variance === null)).toBe(true);
  });
});
