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
 * job or its invoice carries the job). A line is a branch's or a job type's,
 * never both, and neither is added into the company's. What a job type's
 * figures cannot hold is everything not booked to a job: rent, the trucks,
 * payroll journals, and the report counts it.
 *
 * AND A FORECAST. Each line has a year end figure: the months already over at
 * their actual, and the months to come at their budget or, when the company
 * chose it, at the run rate of the months already over (`budget.forecastLine`
 * in core). It is an estimate, stated as one with the assumption beside it on
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

/** Whose lines: the company's own, one branch's or one job type's. */
type Scope =
  | { kind: "company" }
  | { kind: "branch"; id: string; name: string }
  | { kind: "jobType"; id: string; name: string };

const ofScope = (scope: Scope) => scope.kind === "branch"
  ? eq(schema.budgetLine.businessUnitId, scope.id)
  : scope.kind === "jobType"
    ? eq(schema.budgetLine.jobTypeId, scope.id)
    : and(isNull(schema.budgetLine.businessUnitId), isNull(schema.budgetLine.jobTypeId));

/** The scope a call asks for, refused in words when it names a branch and a job type at once. */
async function scopeFor(
  tx: Database, organizationId: string,
  input: { businessUnitId?: string | undefined; jobTypeId?: string | undefined }, writing: boolean,
): Promise<Scope> {
  if (input.businessUnitId && input.jobTypeId) {
    throw new UnprocessableError("A branch or a job type", [{
      path: "jobTypeId", message: "A budget line is the company's, one branch's or one job type's. Pick a branch or a job type, not both.",
    }]);
  }
  const branch = await branchFor(tx, organizationId, input.businessUnitId, writing);
  if (branch) return { kind: "branch", ...branch };
  const type = await jobTypeFor(tx, organizationId, input.jobTypeId, writing);
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
  ...(scope.kind === "branch" ? { businessUnitId: scope.id } : {}),
  ...(scope.kind === "jobType" ? { jobTypeId: scope.id } : {}),
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
  const businessUnitId = scope.kind === "branch" ? scope.id : null;
  const jobTypeId = scope.kind === "jobType" ? scope.id : null;
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
    /** One index each for the company's cells, a branch's and a job type's, so the conflict names whichever this is. */
    await (scope.kind === "branch"
      ? insert.onConflictDoUpdate({
        target: [schema.budgetLine.budgetId, schema.budgetLine.businessUnitId, schema.budgetLine.line, schema.budgetLine.month],
        targetWhere: sql`${schema.budgetLine.businessUnitId} is not null`,
        set: { amount, updatedAt: new Date() },
      })
      : scope.kind === "jobType"
        ? insert.onConflictDoUpdate({
          target: [schema.budgetLine.budgetId, schema.budgetLine.jobTypeId, schema.budgetLine.line, schema.budgetLine.month],
          targetWhere: sql`${schema.budgetLine.jobTypeId} is not null`,
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
      businessUnitId: scope.kind === "branch" ? scope.id : null,
      jobTypeId: scope.kind === "jobType" ? scope.id : null,
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
    /** What was used: the budget when the run rate was chosen and no month is over yet. */
    method: b.ForecastMethod;
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
function assumption(method: b.ForecastMethod, chosen: b.ForecastMethod, closed: number, year: number, future: boolean): string {
  const estimate = "This is an estimate, not a promise.";
  if (closed >= 12) return `${year} is over, so the forecast is what the books say happened. ${estimate}`;
  if (future) {
    const how = chosen === "run_rate"
      ? "You chose the run rate, and there is none until a month is over, so every month is taken at its budget for now"
      : "Every month is taken at its budget";
    return `${year} has not started. ${how}, and a month with no budget counts as nothing. ${estimate}`;
  }
  const over = closed === 0
    ? "No month of the year is over yet."
    : `${closed === 1 ? "January is" : `January to ${MONTH_NAMES[closed - 1]} are`} read at what the books say happened.`;
  const fell = chosen === "run_rate" && method === "budget"
    ? " You chose the run rate, and there is none until a month is over, so the budget is used for now."
    : "";
  const rest = method === "run_rate"
    ? " This month and the months after it are each taken at the average of the months already over, which reads a seasonal year wrongly."
    : " This month and the months after it are taken at their budget, and a month with no budget counts as nothing.";
  return `${over}${fell}${rest} ${estimate}`;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

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

    /**
     * Each account's two sides per month of the year, in the company's
     * calendar. A job type's are the entries on its jobs, joined through the
     * job the entry carries; a job moved to another type later moves with it,
     * because the question is about the kind of work the job is.
     */
    const sums = await tx.execute<{ account_code: string; month: number; debit: string; credit: string }>(sql`
      select le.account_code,
             extract(month from le.occurred_at at time zone ${tz})::int as month,
             coalesce(sum(case when le.direction = 'debit' then le.amount end), 0)::numeric(14,4)::text as debit,
             coalesce(sum(case when le.direction = 'credit' then le.amount end), 0)::numeric(14,4)::text as credit
      from public.ledger_entry le
      ${scope.kind === "jobType" ? sql`join public.job j on j.id = le.job_id and j.job_type_id = ${scope.id}` : sql``}
      where le.organization_id = ${ctx.actor.organizationId}
        and extract(year from le.occurred_at at time zone ${tz}) = ${year}
        ${scope.kind === "branch" ? sql`and le.business_unit_id = ${scope.id}` : sql``}
      group by le.account_code, 2
    `);
    /** What a branch's or a job type's actuals cannot hold: the year's entries with no branch, or on no job. */
    const [uncovered] = scope.kind === "company"
      ? []
      : await tx.execute<{ entries: number; debits: string }>(sql`
        select count(*)::int as entries,
               coalesce(sum(case when le.direction = 'debit' then le.amount end), 0)::numeric(14,4)::text as debits
        from public.ledger_entry le
        where le.organization_id = ${ctx.actor.organizationId}
          and extract(year from le.occurred_at at time zone ${tz}) = ${year}
          and ${scope.kind === "branch" ? sql`le.business_unit_id is null` : sql`le.job_id is null`}
      `);
    const byMonth = new Map<number, Map<string, b.AccountSums>>();
    for (const row of sums) {
      const month = Number(row.month);
      const bucket = byMonth.get(month) ?? new Map<string, b.AccountSums>();
      bucket.set(row.account_code, { debit: m.money(row.debit), credit: m.money(row.credit) });
      byMonth.set(month, bucket);
    }

    const today = time.dateIn(new Date(), tz);
    const [thisYear, thisMonth] = today.split("-").map(Number) as [number, number];
    const through = year < thisYear ? 12 : year > thisYear ? 0 : thisMonth;
    const closed = b.closedMonths(year, today);
    const chosen: b.ForecastMethod = budgetRow?.forecastMethod ?? "budget";

    const keys = [...new Set(cells.map((cell) => cell.line))]
      .map((line) => b.parseLine(line))
      .filter((key): key is b.LineKey => key !== null)
      .sort((x, y) => order(x) - order(y) || (x < y ? -1 : 1));

    let used: b.ForecastMethod = chosen === "run_rate" && closed === 0 ? "budget" : chosen;
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
      const f = b.forecastLine({ key, months: raw, closed, method: chosen });
      used = f.method;
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
        },
      };
    });

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
      branch: scope.kind === "branch"
        ? {
          id: scope.id, name: scope.name,
          entriesWithoutBranch: Number(uncovered?.entries ?? 0), withoutBranchDebits: uncovered?.debits ?? "0.0000",
        }
        : null,
      jobType: scope.kind === "jobType"
        ? {
          id: scope.id, name: scope.name,
          entriesWithoutJob: Number(uncovered?.entries ?? 0), withoutJobDebits: uncovered?.debits ?? "0.0000",
        }
        : null,
      forecast: {
        chosen, method: used, closed, fellBack: chosen !== used,
        assumption: assumption(used, chosen, closed, year, year > thisYear),
        net: hasRevenue
          ? { forecast: m.toString(netOf((l) => l.forecast.forecast)), budget: m.toString(netOf((l) => l.year.budget)) }
          : null,
      },
    };
  });
}

/**
 * How the year's forecast takes the months to come: at their budget, or at
 * the run rate of the months already over. One choice per year, for every
 * reader and every branch's and job type's report, made by whoever sets the
 * budget. Setting the one already chosen is a no op, so a retry is harmless.
 */
export async function setForecastMethod(
  ctx: ServiceContext, input: { year: number; method: b.ForecastMethod },
): Promise<{ year: number; method: b.ForecastMethod }> {
  return guardedWrite(ctx, "finance:configure", async (tx) => {
    const year = YEAR(input.year);
    if (!(b.FORECAST_METHODS as readonly string[]).includes(input.method)) {
      throw new UnprocessableError("Not a way to forecast", [{ path: "method", message: "The months to come are taken at their budget or at the run rate." }]);
    }
    const budgetId = await budgetFor(tx, ctx.actor.organizationId, year);
    const [before] = await tx.select({ method: schema.budget.forecastMethod }).from(schema.budget)
      .where(eq(schema.budget.id, budgetId)).limit(1);
    if (before?.method !== input.method) {
      await tx.update(schema.budget).set({ forecastMethod: input.method, updatedAt: new Date() })
        .where(eq(schema.budget.id, budgetId));
      await audit(tx, ctx, "budget.forecast_method_set", "budget", budgetId, { forecastMethod: before?.method ?? null }, {
        year, forecastMethod: input.method,
      });
    }
    return { year, method: input.method };
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
  setBudgetForecastMethod: (ctx: ServiceContext, input: { year: number; method: b.ForecastMethod }) => setForecastMethod(ctx, input),
} as const;
