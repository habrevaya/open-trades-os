import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { budget as b, money as m } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, timezoneOf,
  UnprocessableError, NotFoundError, type ServiceContext,
} from "./context";

/**
 * M15. THE COMPANY BUDGET AGAINST WHAT THE LEDGER SAYS HAPPENED
 *
 * M12 has budget against actual per project. This is the same question for
 * the whole company and the whole year: twelve numbers per line, and beside
 * each the ledger's actual and how far off it is.
 *
 * THE ACTUAL IS THE LEDGER, grouped by account and by month in the company's
 * own calendar, so the report agrees with the trial balance for the same
 * dates to the cent. A month's actual is everything posted in it, including a
 * journal an accountant booked into it; a closed month does not change
 * because nothing can be posted into it.
 *
 * `finance:configure` writes it, `report.financial:read` reads it.
 *
 * BY BRANCH, TOO. A line can be one branch's, and the report can be read for
 * one branch: that branch's own lines against what the ledger put in that
 * branch (every posting carries the branch of the job or invoice it came
 * from, M14). The whole company's report is the lines with no branch against
 * everything, as it always was; a branch's lines are not added into it,
 * because a company that budgets Revenue for itself and for each shop has
 * said two things, and adding them would count the money twice. Nothing old
 * is moved: every line written before this is the company's.
 */

const YEAR = (year: number) => {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new UnprocessableError("Not a year", [{ path: "year", message: "A budget is for a year between 2000 and 2100." }]);
  }
  return year;
};

function lineOf(text: string): b.LineKey {
  const key = b.parseLine(text);
  if (!key) {
    throw new UnprocessableError("Not a budget line", [{
      path: "line", message: `"${text}" is not Revenue, Materials, Labour, Overhead or an account code.`,
    }]);
  }
  return key;
}

/** The budget row for a year, made the first time anything is put in it. */
async function budgetFor(tx: Database, organizationId: string, year: number): Promise<string> {
  await tx.insert(schema.budget).values({ organizationId, year }).onConflictDoNothing();
  const [row] = await tx.select({ id: schema.budget.id }).from(schema.budget)
    .where(and(eq(schema.budget.organizationId, organizationId), eq(schema.budget.year, year))).limit(1);
  return row!.id;
}

/** The company's own lines, or one branch's. */
const ofBranch = (businessUnitId: string | null) => businessUnitId
  ? eq(schema.budgetLine.businessUnitId, businessUnitId)
  : isNull(schema.budgetLine.businessUnitId);

/**
 * A branch a budget is for: the company's own, or refused as not found. A
 * retired branch can be read, because its year may have actuals in it, and
 * cannot be given a new budget, because nothing new is put in a branch the
 * company has put away.
 */
async function branchFor(
  tx: Database, organizationId: string, businessUnitId: string | undefined, writing: boolean,
): Promise<{ id: string; name: string } | null> {
  if (!businessUnitId) return null;
  const [unit] = await tx.select({ id: schema.businessUnit.id, name: schema.businessUnit.name, active: schema.businessUnit.active })
    .from(schema.businessUnit)
    .where(and(eq(schema.businessUnit.id, businessUnitId), eq(schema.businessUnit.organizationId, organizationId)))
    .limit(1);
  if (!unit) throw new NotFoundError("Branch");
  if (writing && !unit.active) {
    throw new UnprocessableError("A retired branch", [{
      path: "businessUnitId", message: `${unit.name} has been retired, so nothing new is budgeted for it.`,
    }]);
  }
  return { id: unit.id, name: unit.name };
}

/**
 * Write one line's twelve months. A blank month is no budget for it and is
 * removed, so the screen's grid is the whole truth about the line.
 */
async function writeLine(
  tx: Database, organizationId: string, budgetId: string, businessUnitId: string | null, line: b.LineKey, amounts: (string | null)[],
) {
  for (let month = 1; month <= 12; month += 1) {
    const raw = amounts[month - 1]?.trim() ?? "";
    if (raw === "") {
      await tx.delete(schema.budgetLine).where(and(
        eq(schema.budgetLine.budgetId, budgetId), ofBranch(businessUnitId),
        eq(schema.budgetLine.line, line), eq(schema.budgetLine.month, month),
      ));
      continue;
    }
    const amount = m.toString(m.money(raw.replace(/[$,\s]/g, "")));
    const insert = tx.insert(schema.budgetLine).values({ organizationId, budgetId, businessUnitId, line, month, amount });
    /** One index for the company's cells and one for a branch's, so the conflict names whichever this is. */
    await (businessUnitId
      ? insert.onConflictDoUpdate({
        target: [schema.budgetLine.budgetId, schema.budgetLine.businessUnitId, schema.budgetLine.line, schema.budgetLine.month],
        targetWhere: sql`${schema.budgetLine.businessUnitId} is not null`,
        set: { amount, updatedAt: new Date() },
      })
      : insert.onConflictDoUpdate({
        target: [schema.budgetLine.budgetId, schema.budgetLine.line, schema.budgetLine.month],
        targetWhere: sql`${schema.budgetLine.businessUnitId} is null`,
        set: { amount, updatedAt: new Date() },
      }));
  }
}

const AMOUNT = /^-?\$?\s*[\d,]*\d(\.\d{1,4})?$/;

/** Set one line of a year's budget, all twelve months at once: the company's, or one branch's. */
export async function setLine(
  ctx: ServiceContext,
  input: { year: number; line: string; amounts: (string | null)[]; businessUnitId?: string | undefined },
): Promise<{ year: number; line: string; months: number; businessUnitId: string | null }> {
  return guardedWrite(ctx, "finance:configure", async (tx) => {
    const year = YEAR(input.year);
    const line = lineOf(input.line);
    if (input.amounts.length !== 12) {
      throw new UnprocessableError("Twelve months", [{ path: "amounts", message: "A line has twelve months, January to December." }]);
    }
    input.amounts.forEach((amount, i) => {
      if (amount !== null && amount.trim() !== "" && !AMOUNT.test(amount.trim())) {
        throw new UnprocessableError("Not an amount", [{ path: `amounts.${i}`, message: `"${amount}" is not an amount.` }]);
      }
    });
    const branch = await branchFor(tx, ctx.actor.organizationId, input.businessUnitId, true);
    const budgetId = await budgetFor(tx, ctx.actor.organizationId, year);
    await writeLine(tx, ctx.actor.organizationId, budgetId, branch?.id ?? null, line, input.amounts);
    await audit(tx, ctx, "budget.line_set", "budget", budgetId, null, {
      year, line, amounts: input.amounts, ...(branch ? { businessUnitId: branch.id } : {}),
    });
    return {
      year, line, months: input.amounts.filter((a) => a !== null && a.trim() !== "").length, businessUnitId: branch?.id ?? null,
    };
  });
}

/** Take a line out of the budget altogether: the company's, or one branch's. */
export async function removeLine(ctx: ServiceContext, input: { year: number; line: string; businessUnitId?: string | undefined }) {
  return guardedWrite(ctx, "finance:configure", async (tx) => {
    const line = lineOf(input.line);
    const branch = await branchFor(tx, ctx.actor.organizationId, input.businessUnitId, false);
    const [row] = await tx.select({ id: schema.budget.id }).from(schema.budget)
      .where(and(eq(schema.budget.organizationId, ctx.actor.organizationId), eq(schema.budget.year, YEAR(input.year)))).limit(1);
    if (!row) throw new NotFoundError("Budget");
    await tx.delete(schema.budgetLine).where(and(
      eq(schema.budgetLine.budgetId, row.id), ofBranch(branch?.id ?? null), eq(schema.budgetLine.line, line),
    ));
    await audit(tx, ctx, "budget.line_removed", "budget", row.id, { line, ...(branch ? { businessUnitId: branch.id } : {}) }, null);
    return { year: input.year, line, removed: true as const };
  });
}

/**
 * A year's budget from a spreadsheet. Every line in the file replaces that
 * line entirely; lines not in the file are left alone, so somebody can import
 * revenue from one sheet and costs from another. Nothing is written unless
 * the whole file reads, and every problem in it is reported at once.
 */
export async function importCsv(ctx: ServiceContext, input: { year: number; csv: string; businessUnitId?: string | undefined }) {
  return guardedWrite(ctx, "finance:configure", async (tx) => {
    const year = YEAR(input.year);
    const parsed = b.parseBudgetCsv(input.csv);
    if (!parsed.ok) {
      throw new UnprocessableError("The file has problems", parsed.problems.map((message) => ({ path: "csv", message })));
    }
    const branch = await branchFor(tx, ctx.actor.organizationId, input.businessUnitId, true);
    const budgetId = await budgetFor(tx, ctx.actor.organizationId, year);
    const lines = [...new Set(parsed.cells.map((cell) => cell.line))];
    for (const line of lines) {
      const amounts: (string | null)[] = Array.from({ length: 12 }, () => null);
      for (const cell of parsed.cells.filter((x) => x.line === line)) amounts[cell.month - 1] = cell.amount;
      await writeLine(tx, ctx.actor.organizationId, budgetId, branch?.id ?? null, line, amounts);
    }
    await audit(tx, ctx, "budget.imported", "budget", budgetId, null, {
      year, lines, cells: parsed.cells.length, ...(branch ? { businessUnitId: branch.id } : {}),
    });
    return { year, lines: lines.length, cells: parsed.cells.length };
  });
}

export interface BudgetReportLine {
  line: string;
  label: string;
  /** Twelve months. */
  months: { month: number; budget: string | null; actual: string; variance: string | null; favourable: boolean | null }[];
  /** January through the last month reported, budget and actual. */
  toDate: { budget: string; actual: string; variance: string; percent: number | null; favourable: boolean | null };
  year: { budget: string };
}

export interface BudgetReport {
  year: number;
  /** The last month with actuals in it: this month for the current year, December for a past one. */
  through: number;
  lines: BudgetReportLine[];
  /** Revenue less the three cost categories, where the budget has them. Account lines are not added, because they sit inside a category. */
  net: { budget: string; actual: string } | null;
  /** Said on the report, because a labour line with no journals behind it reads as a saving. */
  caveat: string;
  /**
   * The branch the report is for, and what its actuals cannot include: the
   * year's ledger entries that carry no branch (payroll, the release of
   * deferred revenue, a payment spread over two branches, and everything
   * posted before branches were carried), counted and added up so a branch
   * that looks under budget can be read for why. Null for the whole company.
   */
  branch: { id: string; name: string; entriesWithoutBranch: number; withoutBranchDebits: string } | null;
}

const CAVEAT =
  "Actuals are read from the ledger. This product posts revenue, discounts, card and financing fees, write offs and "
  + "commission itself; it posts no wages or materials. Labour and materials show here only as your accountant "
  + "journals them (to 5000 for materials and 5100 to 5999 for labour), so a labour line with no journals behind it "
  + "is unbooked, not under budget. Job costing reads labour and materials from the timeclock and the job lines instead.";

/**
 * Budget against actual for a year, every line, every month.
 *
 * Months after `through` show the budget and no variance, because a month
 * that has not happened is not under budget.
 */
export async function report(
  ctx: ServiceContext, input: { year: number; businessUnitId?: string | undefined },
): Promise<BudgetReport> {
  return guardedRead(ctx, "report.financial:read", async (tx) => {
    const year = YEAR(input.year);
    const tz = await timezoneOf(tx, ctx.actor.organizationId);
    const branch = await branchFor(tx, ctx.actor.organizationId, input.businessUnitId, false);
    const [budgetRow] = await tx.select().from(schema.budget)
      .where(and(eq(schema.budget.organizationId, ctx.actor.organizationId), eq(schema.budget.year, year))).limit(1);
    const cells = budgetRow
      ? await tx.select().from(schema.budgetLine)
        .where(and(eq(schema.budgetLine.budgetId, budgetRow.id), ofBranch(branch?.id ?? null)))
        .orderBy(asc(schema.budgetLine.line), asc(schema.budgetLine.month))
      : [];

    /** Each account's two sides per month of the year, in the company's calendar. */
    const sums = await tx.execute<{ account_code: string; month: number; debit: string; credit: string }>(sql`
      select le.account_code,
             extract(month from le.occurred_at at time zone ${tz})::int as month,
             coalesce(sum(case when le.direction = 'debit' then le.amount end), 0)::numeric(14,4)::text as debit,
             coalesce(sum(case when le.direction = 'credit' then le.amount end), 0)::numeric(14,4)::text as credit
      from public.ledger_entry le
      where le.organization_id = ${ctx.actor.organizationId}
        and extract(year from le.occurred_at at time zone ${tz}) = ${year}
        ${branch ? sql`and le.business_unit_id = ${branch.id}` : sql``}
      group by le.account_code, 2
    `);
    /** What a branch's actuals cannot hold: the year's entries that carry no branch at all. */
    const [unbranched] = branch
      ? await tx.execute<{ entries: number; debits: string }>(sql`
        select count(*)::int as entries,
               coalesce(sum(case when le.direction = 'debit' then le.amount end), 0)::numeric(14,4)::text as debits
        from public.ledger_entry le
        where le.organization_id = ${ctx.actor.organizationId}
          and extract(year from le.occurred_at at time zone ${tz}) = ${year}
          and le.business_unit_id is null
      `)
      : [];
    const byMonth = new Map<number, Map<string, b.AccountSums>>();
    for (const row of sums) {
      const month = Number(row.month);
      const bucket = byMonth.get(month) ?? new Map<string, b.AccountSums>();
      bucket.set(row.account_code, { debit: m.money(row.debit), credit: m.money(row.credit) });
      byMonth.set(month, bucket);
    }

    const now = new Date();
    const [thisYear, thisMonth] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" })
      .format(now).split("-").map(Number) as [number, number];
    const through = year < thisYear ? 12 : year > thisYear ? 0 : thisMonth;

    const keys = [...new Set(cells.map((cell) => cell.line))]
      .map((line) => b.parseLine(line))
      .filter((key): key is b.LineKey => key !== null)
      .sort((x, y) => order(x) - order(y) || (x < y ? -1 : 1));

    const lines: BudgetReportLine[] = keys.map((key) => {
      let budgetToDate = m.zero();
      let actualToDate = m.zero();
      let budgetYear = m.zero();
      const months = Array.from({ length: 12 }, (_, i) => {
        const month = i + 1;
        const cell = cells.find((x) => x.line === key && x.month === month);
        const budget = cell ? m.money(cell.amount) : null;
        const actual = b.actualFor(key, byMonth.get(month) ?? new Map());
        if (budget) budgetYear = m.add(budgetYear, budget);
        const happened = month <= through;
        if (happened) {
          actualToDate = m.add(actualToDate, actual);
          if (budget) budgetToDate = m.add(budgetToDate, budget);
        }
        const v = happened && budget ? b.variance(key, budget, actual) : null;
        return {
          month,
          budget: budget ? m.toString(budget) : null,
          actual: m.toString(actual),
          variance: v ? m.toString(v.variance) : null,
          favourable: v ? v.favourable : null,
        };
      });
      const v = b.variance(key, budgetToDate, actualToDate);
      return {
        line: key,
        label: b.lineLabel(key),
        months,
        toDate: {
          budget: m.toString(budgetToDate), actual: m.toString(actualToDate),
          variance: m.toString(v.variance), percent: v.percent, favourable: v.favourable,
        },
        year: { budget: m.toString(budgetYear) },
      };
    });

    const categories = lines.filter((l) => l.line.startsWith("category:"));
    const net = categories.some((l) => l.line === "category:revenue")
      ? categories.reduce((acc, l) => {
        const sign = l.line === "category:revenue" ? 1 : -1;
        const add = (a: string, x: string) => m.toString(sign > 0 ? m.add(m.money(a), m.money(x)) : m.subtract(m.money(a), m.money(x)));
        return { budget: add(acc.budget, l.toDate.budget), actual: add(acc.actual, l.toDate.actual) };
      }, { budget: "0", actual: "0" })
      : null;

    return {
      year, through, lines, net, caveat: CAVEAT,
      branch: branch
        ? {
          id: branch.id, name: branch.name,
          entriesWithoutBranch: Number(unbranched?.entries ?? 0), withoutBranchDebits: unbranched?.debits ?? "0.0000",
        }
        : null,
    };
  });
}

function order(key: b.LineKey): number {
  if (key.startsWith("category:")) return b.BUDGET_CATEGORIES.indexOf(key.slice(9) as b.BudgetCategory);
  return 10 + Number(key.slice(8));
}

type Branch = { businessUnitId?: string | undefined };

export const handlers = {
  getBudgetReport: (ctx: ServiceContext, input: { year: number } & Branch) => report(ctx, input),
  setBudgetLine: (ctx: ServiceContext, input: { year: number; line: string; amounts: (string | null)[] } & Branch) => setLine(ctx, input),
  removeBudgetLine: (ctx: ServiceContext, input: { year: number; line: string } & Branch) => removeLine(ctx, input),
  importBudget: (ctx: ServiceContext, input: { year: number; csv: string } & Branch) => importCsv(ctx, input),
} as const;
