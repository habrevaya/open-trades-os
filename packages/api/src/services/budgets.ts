import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { budget as b, money as m, time } from "@opentradesos/core";
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
 *
 * BY JOB TYPE, THE SAME WAY. A line can be one job type's instead, read
 * against the ledger entries made from that type's jobs (every posting from a
 * job or its invoice carries the job). What a job type's figures cannot hold
 * is everything not booked to a job: rent, the trucks, payroll journals, and
 * the report counts it.
 *
 * AND BY BOTH: one job type in one branch ("service in the north shop"), read
 * against the entries that carry that branch and are on that type's jobs, with
 * both counts of what it cannot hold. None of the four is added into another:
 * the company's, a branch's, a job type's and a branch's job type's lines are
 * each their own statement.
 *
 * AND A FORECAST. Each line has a year end figure: the months already over at
 * their actual, and the months to come at their budget or, when the company
 * chose it, at the run rate of the months already over, or shaped like last
 * year, each line by its own last year in the same branch and job type
 * (`budget.forecastLine` in core). Shaping like last year is refused, in
 * words, until a whole year is in the books. It is an estimate, stated as one with the assumption beside it on
 * the screen, and nothing is posted.
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

/** Whose lines: the company's own, one branch's, one job type's, or one job type's in one branch. */
type Scope =
  | { kind: "company" }
  | { kind: "branch"; id: string; name: string }
  | { kind: "jobType"; id: string; name: string }
  | { kind: "both"; branch: { id: string; name: string }; jobType: { id: string; name: string } };

const branchIdOf = (scope: Scope): string | null =>
  scope.kind === "branch" ? scope.id : scope.kind === "both" ? scope.branch.id : null;
const jobTypeIdOf = (scope: Scope): string | null =>
  scope.kind === "jobType" ? scope.id : scope.kind === "both" ? scope.jobType.id : null;

/** Exactly this scope's lines: a branch's own lines are not its job types' lines, and the other way round. */
const ofScope = (scope: Scope) => {
  const branchId = branchIdOf(scope);
  const typeId = jobTypeIdOf(scope);
  return and(
    branchId ? eq(schema.budgetLine.businessUnitId, branchId) : isNull(schema.budgetLine.businessUnitId),
    typeId ? eq(schema.budgetLine.jobTypeId, typeId) : isNull(schema.budgetLine.jobTypeId),
  );
};

/** The scope a call asks for: a branch and a job type together are one job type's in that branch. */
async function scopeFor(
  tx: Database, organizationId: string,
  input: { businessUnitId?: string | undefined; jobTypeId?: string | undefined }, writing: boolean,
): Promise<Scope> {
  const branch = await branchFor(tx, organizationId, input.businessUnitId, writing);
  const type = await jobTypeFor(tx, organizationId, input.jobTypeId, writing);
  if (branch && type) return { kind: "both", branch, jobType: type };
  if (branch) return { kind: "branch", ...branch };
  if (type) return { kind: "jobType", ...type };
  return { kind: "company" };
}

/**
 * A job type a budget is for, refused as not found when it is not the
 * company's. One switched off can be read and is given no new lines, as a
 * retired branch.
 */
async function jobTypeFor(
  tx: Database, organizationId: string, jobTypeId: string | undefined, writing: boolean,
): Promise<{ id: string; name: string } | null> {
  if (!jobTypeId) return null;
  const [type] = await tx.select({ id: schema.jobType.id, name: schema.jobType.name, active: schema.jobType.active })
    .from(schema.jobType)
    .where(and(eq(schema.jobType.id, jobTypeId), eq(schema.jobType.organizationId, organizationId)))
    .limit(1);
  if (!type) throw new NotFoundError("Job type");
  if (writing && !type.active) {
    throw new UnprocessableError("A job type switched off", [{
      path: "jobTypeId", message: `${type.name} is switched off, so nothing new is budgeted for it.`,
    }]);
  }
  return { id: type.id, name: type.name };
}

const scopeIds = (scope: Scope) => ({
  ...(branchIdOf(scope) ? { businessUnitId: branchIdOf(scope)! } : {}),
  ...(jobTypeIdOf(scope) ? { jobTypeId: jobTypeIdOf(scope)! } : {}),
});

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
  tx: Database, organizationId: string, budgetId: string, scope: Scope, line: b.LineKey, amounts: (string | null)[],
) {
  const businessUnitId = branchIdOf(scope);
  const jobTypeId = jobTypeIdOf(scope);
  for (let month = 1; month <= 12; month += 1) {
    const raw = amounts[month - 1]?.trim() ?? "";
    if (raw === "") {
      await tx.delete(schema.budgetLine).where(and(
        eq(schema.budgetLine.budgetId, budgetId), ofScope(scope),
        eq(schema.budgetLine.line, line), eq(schema.budgetLine.month, month),
      ));
      continue;
    }
    const amount = m.toString(m.money(raw.replace(/[$,\s]/g, "")));
    const insert = tx.insert(schema.budgetLine).values({ organizationId, budgetId, businessUnitId, jobTypeId, line, month, amount });
    /** One index each for the company's cells, a branch's, a job type's and a branch's job type's, so the conflict names whichever this is. */
    await (scope.kind === "both"
      ? insert.onConflictDoUpdate({
        target: [schema.budgetLine.budgetId, schema.budgetLine.businessUnitId, schema.budgetLine.jobTypeId, schema.budgetLine.line, schema.budgetLine.month],
        targetWhere: sql`${schema.budgetLine.businessUnitId} is not null and ${schema.budgetLine.jobTypeId} is not null`,
        set: { amount, updatedAt: new Date() },
      })
      : scope.kind === "branch"
      ? insert.onConflictDoUpdate({
        target: [schema.budgetLine.budgetId, schema.budgetLine.businessUnitId, schema.budgetLine.line, schema.budgetLine.month],
        targetWhere: sql`${schema.budgetLine.businessUnitId} is not null and ${schema.budgetLine.jobTypeId} is null`,
        set: { amount, updatedAt: new Date() },
      })
      : scope.kind === "jobType"
        ? insert.onConflictDoUpdate({
          target: [schema.budgetLine.budgetId, schema.budgetLine.jobTypeId, schema.budgetLine.line, schema.budgetLine.month],
          targetWhere: sql`${schema.budgetLine.jobTypeId} is not null and ${schema.budgetLine.businessUnitId} is null`,
          set: { amount, updatedAt: new Date() },
        })
        : insert.onConflictDoUpdate({
          target: [schema.budgetLine.budgetId, schema.budgetLine.line, schema.budgetLine.month],
          targetWhere: sql`${schema.budgetLine.businessUnitId} is null and ${schema.budgetLine.jobTypeId} is null`,
          set: { amount, updatedAt: new Date() },
        }));
  }
}

const AMOUNT = /^-?\$?\s*[\d,]*\d(\.\d{1,4})?$/;

type ScopeInput = { businessUnitId?: string | undefined; jobTypeId?: string | undefined };

/** Set one line of a year's budget, all twelve months at once: the company's, one branch's or one job type's. */
export async function setLine(
  ctx: ServiceContext,
  input: { year: number; line: string; amounts: (string | null)[] } & ScopeInput,
): Promise<{ year: number; line: string; months: number; businessUnitId: string | null; jobTypeId: string | null }> {
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
    const scope = await scopeFor(tx, ctx.actor.organizationId, input, true);
    const budgetId = await budgetFor(tx, ctx.actor.organizationId, year);
    await writeLine(tx, ctx.actor.organizationId, budgetId, scope, line, input.amounts);
    await audit(tx, ctx, "budget.line_set", "budget", budgetId, null, {
      year, line, amounts: input.amounts, ...scopeIds(scope),
    });
    return {
      year, line, months: input.amounts.filter((a) => a !== null && a.trim() !== "").length,
      businessUnitId: branchIdOf(scope),
      jobTypeId: jobTypeIdOf(scope),
    };
  });
}

/** Take a line out of the budget altogether: the company's, one branch's or one job type's. */
export async function removeLine(ctx: ServiceContext, input: { year: number; line: string } & ScopeInput) {
  return guardedWrite(ctx, "finance:configure", async (tx) => {
    const line = lineOf(input.line);
    const scope = await scopeFor(tx, ctx.actor.organizationId, input, false);
    const [row] = await tx.select({ id: schema.budget.id }).from(schema.budget)
      .where(and(eq(schema.budget.organizationId, ctx.actor.organizationId), eq(schema.budget.year, YEAR(input.year)))).limit(1);
    if (!row) throw new NotFoundError("Budget");
    await tx.delete(schema.budgetLine).where(and(
      eq(schema.budgetLine.budgetId, row.id), ofScope(scope), eq(schema.budgetLine.line, line),
    ));
    await audit(tx, ctx, "budget.line_removed", "budget", row.id, { line, ...scopeIds(scope) }, null);
    return { year: input.year, line, removed: true as const };
  });
}

/**
 * A year's budget from a spreadsheet. Every line in the file replaces that
 * line entirely; lines not in the file are left alone, so somebody can import
 * revenue from one sheet and costs from another. Nothing is written unless
 * the whole file reads, and every problem in it is reported at once.
 */
export async function importCsv(ctx: ServiceContext, input: { year: number; csv: string } & ScopeInput) {
  return guardedWrite(ctx, "finance:configure", async (tx) => {
    const year = YEAR(input.year);
    const parsed = b.parseBudgetCsv(input.csv);
    if (!parsed.ok) {
      throw new UnprocessableError("The file has problems", parsed.problems.map((message) => ({ path: "csv", message })));
    }
    const scope = await scopeFor(tx, ctx.actor.organizationId, input, true);
    const budgetId = await budgetFor(tx, ctx.actor.organizationId, year);
    const lines = [...new Set(parsed.cells.map((cell) => cell.line))];
    for (const line of lines) {
      const amounts: (string | null)[] = Array.from({ length: 12 }, () => null);
      for (const cell of parsed.cells.filter((x) => x.line === line)) amounts[cell.month - 1] = cell.amount;
      await writeLine(tx, ctx.actor.organizationId, budgetId, scope, line, amounts);
    }
    await audit(tx, ctx, "budget.imported", "budget", budgetId, null, {
      year, lines, cells: parsed.cells.length, ...scopeIds(scope),
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
  /**
   * The year end forecast: the months already over at their actual, the
   * months to come as the report's `forecast.method` says, and the result
   * against the whole year's budget. An estimate, never a promise.
   */
  forecast: {
    closedActual: string; toCome: string; forecast: string;
    variance: string; percent: number | null; favourable: boolean | null;
    /** Months to come with no budget, counted as nothing. */
    unbudgetedMonths: number;
    /** True only on a line shaped like last year that had nothing last year to follow, so it is at its budget. */
    noShape?: true;
    /**
     * The year month by month, January to December: a month over at its
     * actual, a month to come at what the forecast takes it at. They add up
     * to `forecast`. Shown, never stored as the budget.
     */
    months: string[];
    /** For a blend: what each of the three would make the months to come on its own. */
    parts?: { budget: string; runRate: string; seasonal: string };
  };
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
  /**
   * The job type the report is for, and the year's ledger entries that are on
   * no job at all (rent, trucks, payroll journals, anything an accountant did
   * not book to a job), which no job type's figures can hold. Null otherwise.
   */
  jobType: { id: string; name: string; entriesWithoutJob: number; withoutJobDebits: string } | null;
  /** How the forecast was made, in words the screen shows beside it. */
  forecast: {
    /** What the company chose for the year. */
    chosen: b.ForecastMethod;
    /** What was used: the budget when the run rate or last year's shape was chosen and no month is over yet. */
    method: b.ForecastMethod;
    /** With last year's shape chosen (or weighed in a blend), how many lines had none and were taken at their budget. */
    linesWithoutShape?: number;
    /** For a blend: the whole percentages of the budget, the run rate and the seasonal shape. Null otherwise. */
    weights: b.ForecastWeights | null;
    /** How many past years the seasonal shape is the average of. */
    seasonalYears: number;
    /** Months of the year already over, read at their actual. */
    closed: number;
    fellBack: boolean;
    assumption: string;
    /** Revenue less the three cost categories at year end, forecast and budget, where the budget has revenue. */
    net: { forecast: string; budget: string } | null;
  };
}

const CAVEAT =
  "Actuals are read from the ledger. This product posts revenue, discounts, card and financing fees, write offs and "
  + "commission itself; it posts no wages or materials. Labour and materials show here only as your accountant "
  + "journals them (to 5000 for materials and 5100 to 5999 for labour), so a labour line with no journals behind it "
  + "is unbooked, not under budget. Job costing reads labour and materials from the timeclock and the job lines instead.";

/** The sentence beside the forecast: what it assumed, so nobody reads it as a promise. */
function assumption(
  method: b.ForecastMethod, chosen: b.ForecastMethod, closed: number, year: number, future: boolean, unshaped = 0,
  weights: b.ForecastWeights | null = null, years = 1,
): string {
  const estimate = "This is an estimate, not a promise.";
  /** "2025", or "the average of 2023 to 2025". */
  const past = years <= 1 ? `${year - 1}` : `the average of ${year - years} to ${year - 1}`;
  if (chosen === "blend" && closed < 12) {
    const w = weights ?? { budget: 100, runRate: 0, seasonal: 0 };
    const parts = [
      w.budget > 0 ? `${w.budget}% at their budget` : null,
      w.runRate > 0 ? `${w.runRate}% at the run rate so far` : null,
      w.seasonal > 0 ? `${w.seasonal}% shaped like ${past}` : null,
    ].filter((x): x is string => x !== null);
    const said = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;
    const over = future ? `${year} has not started.`
      : closed === 0 ? "No month of the year is over yet."
        : `${closed === 1 ? "January is" : `January to ${MONTH_NAMES[closed - 1]} are`} read at what the books say happened.`;
    const fell = (w.runRate > 0 || w.seasonal > 0) && closed === 0
      ? " Until a month is over there is no run rate and nothing to shape, so those parts are at the budget for now."
      : w.seasonal > 0 && unshaped > 0
        ? ` ${unshaped === 1 ? "One line had" : `${unshaped} lines had`} nothing in ${past} to follow, so its shaped part is at its budget.`
        : "";
    return `${over} This month and the months after it are a blend: ${said}.${fell} A month with no budget counts as nothing in the budget's part. ${estimate}`;
  }
  if (closed >= 12) return `${year} is over, so the forecast is what the books say happened. ${estimate}`;
  if (future) {
    const how = chosen === "run_rate"
      ? "You chose the run rate, and there is none until a month is over, so every month is taken at its budget for now"
      : chosen === "seasonal"
        ? `You chose to shape the year like ${year - 1}, and there is nothing to shape until a month is over, so every month is taken at its budget for now`
        : "Every month is taken at its budget";
    return `${year} has not started. ${how}, and a month with no budget counts as nothing. ${estimate}`;
  }
  const over = closed === 0
    ? "No month of the year is over yet."
    : `${closed === 1 ? "January is" : `January to ${MONTH_NAMES[closed - 1]} are`} read at what the books say happened.`;
  const fell = chosen === "run_rate" && method === "budget"
    ? " You chose the run rate, and there is none until a month is over, so the budget is used for now."
    : chosen === "seasonal" && method === "budget"
      ? closed === 0
        ? ` You chose to shape the year like ${year - 1}, and there is nothing to shape until a month is over, so the budget is used for now.`
        : ` You chose to shape the year like ${year - 1}, and no line had anything in ${year - 1} to follow, so the budget is used.`
      : "";
  const rest = method === "run_rate"
    ? " This month and the months after it are each taken at the average of the months already over, which reads a seasonal year wrongly."
    : method === "seasonal"
      ? ` This month and the months after it are shaped like ${past}: the months already over are taken as the same share of the year`
        + ` they were in ${past}, and the rest of the year follows in proportion.`
        + (unshaped > 0
          ? ` ${unshaped === 1 ? "One line had" : `${unshaped} lines had`} nothing in ${past} to follow and ${unshaped === 1 ? "is" : "are"} taken at ${unshaped === 1 ? "its" : "their"} budget.`
          : "")
      : " This month and the months after it are taken at their budget, and a month with no budget counts as nothing.";
  return `${over}${fell}${rest} ${estimate}`;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Each account's two sides per month of a year, in the company's calendar,
 * for a scope. A job type's are the entries on its jobs, joined through the
 * job the entry carries; a job moved to another type later moves with it,
 * because the question is about the kind of work the job is. A branch's are
 * the entries that carry it; both, the entries that carry the branch and are
 * on that type's jobs.
 */
async function sumsByMonth(
  tx: Database, organizationId: string, tz: string, scope: Scope, year: number,
): Promise<Map<number, Map<string, b.AccountSums>>> {
  const branchId = branchIdOf(scope);
  const typeId = jobTypeIdOf(scope);
  const sums = await tx.execute<{ account_code: string; month: number; debit: string; credit: string }>(sql`
    select le.account_code,
           extract(month from le.occurred_at at time zone ${tz})::int as month,
           coalesce(sum(case when le.direction = 'debit' then le.amount end), 0)::numeric(14,4)::text as debit,
           coalesce(sum(case when le.direction = 'credit' then le.amount end), 0)::numeric(14,4)::text as credit
    from public.ledger_entry le
    ${typeId ? sql`join public.job j on j.id = le.job_id and j.job_type_id = ${typeId}` : sql``}
    where le.organization_id = ${organizationId}
      and extract(year from le.occurred_at at time zone ${tz}) = ${year}
      ${branchId ? sql`and le.business_unit_id = ${branchId}` : sql``}
    group by le.account_code, 2
  `);
  const byMonth = new Map<number, Map<string, b.AccountSums>>();
  for (const row of sums) {
    const month = Number(row.month);
    const bucket = byMonth.get(month) ?? new Map<string, b.AccountSums>();
    bucket.set(row.account_code, { debit: m.money(row.debit), credit: m.money(row.credit) });
    byMonth.set(month, bucket);
  }
  return byMonth;
}

/**
 * Budget against actual for a year, every line, every month.
 *
 * Months after `through` show the budget and no variance, because a month
 * that has not happened is not under budget.
 */
export async function report(
  ctx: ServiceContext, input: { year: number } & ScopeInput,
): Promise<BudgetReport> {
  return guardedRead(ctx, "report.financial:read", async (tx) => {
    const year = YEAR(input.year);
    const tz = await timezoneOf(tx, ctx.actor.organizationId);
    const scope = await scopeFor(tx, ctx.actor.organizationId, input, false);
    const [budgetRow] = await tx.select().from(schema.budget)
      .where(and(eq(schema.budget.organizationId, ctx.actor.organizationId), eq(schema.budget.year, year))).limit(1);
    const cells = budgetRow
      ? await tx.select().from(schema.budgetLine)
        .where(and(eq(schema.budgetLine.budgetId, budgetRow.id), ofScope(scope)))
        .orderBy(asc(schema.budgetLine.line), asc(schema.budgetLine.month))
      : [];

    const byMonth = await sumsByMonth(tx, ctx.actor.organizationId, tz, scope, year);
    /** What a branch's or a job type's actuals cannot hold: the year's entries with no branch, or on no job. */
    const uncovered = async (what: "branch" | "job") => {
      const [row] = await tx.execute<{ entries: number; debits: string }>(sql`
        select count(*)::int as entries,
               coalesce(sum(case when le.direction = 'debit' then le.amount end), 0)::numeric(14,4)::text as debits
        from public.ledger_entry le
        where le.organization_id = ${ctx.actor.organizationId}
          and extract(year from le.occurred_at at time zone ${tz}) = ${year}
          and ${what === "branch" ? sql`le.business_unit_id is null` : sql`le.job_id is null`}
      `);
      return row;
    };
    const noBranch = branchIdOf(scope) ? await uncovered("branch") : undefined;
    const noJob = jobTypeIdOf(scope) ? await uncovered("job") : undefined;

    const today = time.dateIn(new Date(), tz);
    const [thisYear, thisMonth] = today.split("-").map(Number) as [number, number];
    const through = year < thisYear ? 12 : year > thisYear ? 0 : thisMonth;
    const closed = b.closedMonths(year, today);
    const chosen: b.ForecastMethod = budgetRow?.forecastMethod ?? "budget";
    const weights: b.ForecastWeights | null = chosen === "blend"
      ? budgetRow?.forecastWeights ?? { budget: 100, runRate: 0, seasonal: 0 }
      : null;
    const years = Math.max(1, Math.min(b.MAX_SEASONAL_YEARS, budgetRow?.seasonalYears ?? 1));
    const shapes = chosen === "seasonal" || (chosen === "blend" && (weights?.seasonal ?? 0) > 0);

    const keys = [...new Set(cells.map((cell) => cell.line))]
      .map((line) => b.parseLine(line))
      .filter((key): key is b.LineKey => key !== null)
      .sort((x, y) => order(x) - order(y) || (x < y ? -1 : 1));

    let used: b.ForecastMethod = chosen !== "budget" && chosen !== "blend" && closed === 0 ? "budget" : chosen;
    /**
     * The past years' months in the same branch and job type, for a forecast
     * shaped like them: last year alone, or several added together month by
     * month, which is their average as a shape.
     */
    const pastYears = shapes && closed > 0 && closed < 12
      ? await Promise.all(Array.from({ length: years }, (_, i) => sumsByMonth(tx, ctx.actor.organizationId, tz, scope, year - 1 - i)))
      : null;
    const shapeOf = (key: b.LineKey): m.Money[] | undefined => (pastYears
      ? Array.from({ length: 12 }, (_, i) => pastYears.reduce(
        (sum, past) => m.add(sum, b.actualFor(key, past.get(i + 1) ?? new Map())), m.zero()))
      : undefined);
    let unshaped = 0;
    const lines: BudgetReportLine[] = keys.map((key) => {
      let budgetToDate = m.zero();
      let actualToDate = m.zero();
      let budgetYear = m.zero();
      const raw = Array.from({ length: 12 }, (_, i) => {
        const month = i + 1;
        const cell = cells.find((x) => x.line === key && x.month === month);
        return { month, budget: cell ? m.money(cell.amount) : null, actual: b.actualFor(key, byMonth.get(month) ?? new Map()) };
      });
      const months = raw.map(({ month, budget, actual }) => {
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
      const f = b.forecastLine({ key, months: raw, closed, method: chosen, lastYear: shapeOf(key), weights: weights ?? undefined });
      /** A line with no shape in the past years is taken at its budget; the report still says it was shaped where it could be. */
      if (f.noShape) unshaped += 1;
      else if (chosen !== "blend") used = f.method;
      return {
        line: key,
        label: b.lineLabel(key),
        months,
        toDate: {
          budget: m.toString(budgetToDate), actual: m.toString(actualToDate),
          variance: m.toString(v.variance), percent: v.percent, favourable: v.favourable,
        },
        year: { budget: m.toString(budgetYear) },
        forecast: {
          closedActual: m.toString(f.closedActual), toCome: m.toString(f.toCome), forecast: m.toString(f.forecast),
          variance: m.toString(f.variance.variance), percent: f.variance.percent, favourable: f.variance.favourable,
          unbudgetedMonths: f.unbudgetedMonths,
          /** Present and true only for a line taken at its budget because last year gave it no shape. */
          ...(f.noShape ? { noShape: true as const } : {}),
          months: f.months.map((month) => m.toString(month)),
          ...(f.parts ? {
            parts: { budget: m.toString(f.parts.budget), runRate: m.toString(f.parts.runRate), seasonal: m.toString(f.parts.seasonal) },
          } : {}),
        },
      };
    });
    /** Every line without a shape: the year is at its budget, so say that rather than "shaped". */
    if (chosen === "seasonal" && closed > 0 && closed < 12 && unshaped === lines.length && lines.length > 0) used = "budget";

    const categories = lines.filter((l) => l.line.startsWith("category:"));
    const hasRevenue = categories.some((l) => l.line === "category:revenue");
    /** Revenue added, each cost category taken off; account lines sit inside a category and are left out. */
    const netOf = (pick: (l: BudgetReportLine) => string) => categories.reduce(
      (acc, l) => (l.line === "category:revenue" ? m.add(acc, m.money(pick(l))) : m.subtract(acc, m.money(pick(l)))),
      m.zero(),
    );
    const net = hasRevenue
      ? { budget: m.toString(netOf((l) => l.toDate.budget)), actual: m.toString(netOf((l) => l.toDate.actual)) }
      : null;

    return {
      year, through, lines, net, caveat: CAVEAT,
      branch: scope.kind === "branch" || scope.kind === "both"
        ? {
          ...(scope.kind === "both" ? scope.branch : { id: scope.id, name: scope.name }),
          entriesWithoutBranch: Number(noBranch?.entries ?? 0), withoutBranchDebits: noBranch?.debits ?? "0.0000",
        }
        : null,
      jobType: scope.kind === "jobType" || scope.kind === "both"
        ? {
          ...(scope.kind === "both" ? scope.jobType : { id: scope.id, name: scope.name }),
          entriesWithoutJob: Number(noJob?.entries ?? 0), withoutJobDebits: noJob?.debits ?? "0.0000",
        }
        : null,
      forecast: {
        chosen, method: used, closed,
        fellBack: chosen === "blend" ? closed === 0 && ((weights?.runRate ?? 0) > 0 || (weights?.seasonal ?? 0) > 0) : chosen !== used,
        ...(shapes ? { linesWithoutShape: unshaped } : {}),
        weights,
        seasonalYears: years,
        assumption: assumption(used, chosen, closed, year, year > thisYear, unshaped, weights, years),
        net: hasRevenue
          ? { forecast: m.toString(netOf((l) => l.forecast.forecast)), budget: m.toString(netOf((l) => l.year.budget)) }
          : null,
      },
    };
  });
}

/**
 * How the year's forecast takes the months to come: at their budget, at the
 * run rate of the months already over, shaped like the past year or the
 * average of several, or a blend of the three by whole percentages adding up
 * to 100. One choice per year, for every reader and every branch's and job
 * type's report, made by whoever sets the budget. Sending the choice already
 * made is a no op, so a retry is harmless. The choice is all that is kept:
 * the forecast itself is worked out on every read and never stored as the
 * budget.
 *
 * A SHAPE NEEDS ITS YEARS. Shaping (on its own, or weighed in a blend) is
 * refused, in words, unless the books hold the whole of every year the shape
 * is drawn from: their first entry is in the January of the earliest of them,
 * or before. A company four months old has no shape of a year to follow, and
 * a forecast drawn from part of one would read its first months as its year.
 */
export async function setForecastMethod(
  ctx: ServiceContext,
  input: {
    year: number; method: b.ForecastMethod;
    weights?: { budget?: unknown; runRate?: unknown; seasonal?: unknown } | undefined;
    seasonalYears?: number | undefined;
  },
): Promise<{ year: number; method: b.ForecastMethod; weights?: b.ForecastWeights; seasonalYears?: number }> {
  return guardedWrite(ctx, "finance:configure", async (tx) => {
    const year = YEAR(input.year);
    if (!(b.FORECAST_METHODS as readonly string[]).includes(input.method)) {
      throw new UnprocessableError("Not a way to forecast", [{ path: "method", message: "The months to come are taken at their budget, at the run rate, shaped like last year, or a blend of the three." }]);
    }
    let weights: b.ForecastWeights | null = null;
    if (input.method === "blend") {
      const checked = b.checkWeights(input.weights ?? {});
      if (!checked.ok) throw new UnprocessableError("That blend cannot be used", [{ path: `weights.${checked.field}`, message: checked.reason }]);
      weights = checked.weights;
    }
    if (input.seasonalYears !== undefined
      && (!Number.isInteger(input.seasonalYears) || input.seasonalYears < 1 || input.seasonalYears > b.MAX_SEASONAL_YEARS)) {
      throw new UnprocessableError("Not a number of years", [{
        path: "seasonalYears", message: `A shape is the average of 1 to ${b.MAX_SEASONAL_YEARS} past years.`,
      }]);
    }
    const budgetId = await budgetFor(tx, ctx.actor.organizationId, year);
    const [before] = await tx.select({
      method: schema.budget.forecastMethod, weights: schema.budget.forecastWeights, years: schema.budget.seasonalYears,
    }).from(schema.budget).where(eq(schema.budget.id, budgetId)).limit(1);
    const years = input.seasonalYears ?? before?.years ?? 1;

    if (input.method === "seasonal" || (weights !== null && weights.seasonal > 0)) {
      const tz = await timezoneOf(tx, ctx.actor.organizationId);
      const [first] = await tx.execute<{ day: string | null }>(sql`
        select to_char(min(le.occurred_at) at time zone ${tz}, 'YYYY-MM-DD') as day
        from public.ledger_entry le where le.organization_id = ${ctx.actor.organizationId}
      `);
      const day = first?.day ?? null;
      const from = year - years;
      if (day === null || day > `${from}-01-31`) {
        const span = years === 1 ? `${year - 1}` : `${from} to ${year - 1}`;
        throw new UnprocessableError("Not enough years of history", [{
          path: input.method === "blend" ? "weights.seasonal" : "method",
          message: (years === 1
            ? `Shaping ${year} like ${year - 1} needs all of ${year - 1} in your books, and `
            : `Shaping ${year} like the average of ${span} needs all of ${span} in your books, and `)
            + (day === null ? "there is nothing in them yet." : `the first entry in them is on ${day}, so ${years === 1 ? `${year - 1} is` : `${span} are`} not whole.`)
            + (years > 1
              ? " Use fewer years, or take the months to come at their budget or at the run rate until they are."
              : " Take the months to come at their budget or at the run rate until it is."),
        }]);
      }
    }

    const same = before?.method === input.method && before.years === years
      && JSON.stringify(before.weights ?? null) === JSON.stringify(weights);
    if (!same) {
      await tx.update(schema.budget).set({
        forecastMethod: input.method, forecastWeights: weights, seasonalYears: years, updatedAt: new Date(),
      }).where(eq(schema.budget.id, budgetId));
      await audit(tx, ctx, "budget.forecast_method_set", "budget", budgetId, {
        forecastMethod: before?.method ?? null, forecastWeights: before?.weights ?? null, seasonalYears: before?.years ?? null,
      }, {
        year, forecastMethod: input.method, forecastWeights: weights, seasonalYears: years,
      });
    }
    /** The weights only for a blend, and the years only when the shape is more than last year's, as they were set. */
    return {
      year, method: input.method,
      ...(weights ? { weights } : {}),
      ...(years !== 1 ? { seasonalYears: years } : {}),
    };
  });
}

function order(key: b.LineKey): number {
  if (key.startsWith("category:")) return b.BUDGET_CATEGORIES.indexOf(key.slice(9) as b.BudgetCategory);
  return 10 + Number(key.slice(8));
}

export const handlers = {
  getBudgetReport: (ctx: ServiceContext, input: { year: number } & ScopeInput) => report(ctx, input),
  setBudgetLine: (ctx: ServiceContext, input: { year: number; line: string; amounts: (string | null)[] } & ScopeInput) => setLine(ctx, input),
  removeBudgetLine: (ctx: ServiceContext, input: { year: number; line: string } & ScopeInput) => removeLine(ctx, input),
  importBudget: (ctx: ServiceContext, input: { year: number; csv: string } & ScopeInput) => importCsv(ctx, input),
  setBudgetForecastMethod: (ctx: ServiceContext, input: {
    year: number; method: b.ForecastMethod;
    weights?: { budget: number; runRate: number; seasonal: number } | undefined; seasonalYears?: number | undefined;
  }) => setForecastMethod(ctx, input),
} as const;
