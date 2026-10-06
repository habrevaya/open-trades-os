import { sql } from "drizzle-orm";
import { assertCan, costing as costingRules, permissionsFor, type reporting } from "@opentradesos/core";
import { guardedRead, NotFoundError, type ServiceContext } from "./context";
import { JOB_COSTING_SQL, GROSS_MARGIN_SQL, FULLY_LOADED_MARGIN_SQL, SETTLEMENT_SQL, PROFITABILITY_DATASET } from "./report-catalogue";
import { run, scopeFilterFor, type ReportResult } from "./reports";

/**
 * M15. WHICH WORK MAKES MONEY.
 *
 * WHY THIS IS NOT A SECOND REPORTING ENGINE, AND WHERE IT STOPS BEING ONE
 *
 * Everything that is a group by lives in the catalogue, as the
 * `profitability` dataset: a row per job, rolled up by job type, technician,
 * customer, business unit, month or day of the week through the same builder
 * that runs every other report in the product. That builder already scopes
 * a job read, drops soft deleted rows, bounds a date range, refuses a measure
 * the caller may not see and stops at a thousand rows. Writing a parallel
 * aggregator would mean writing all of that again and getting one of them
 * slightly different, and the one that is usually different is scope.
 *
 * What is here instead is the two things an aggregate cannot be:
 *
 *   A STATEMENT FOR ONE JOB, which has to show the rows behind each number.
 *   An owner who does not believe a margin wants the ledger transactions, the
 *   lines and the punches, and a `group by` has thrown all of those away by
 *   the time it returns.
 *
 *   A VERDICT ON WHETHER THE NUMBER IS FINISHED. Work in progress, hours with
 *   no rate on them, lines nobody has billed or written off: facts about one
 *   job, stated as sentences, which do not survive being summed.
 *
 * Both read their numbers from `JOB_COSTING_SQL` in report-catalogue.ts,
 * which is the same object the dataset's measures are built from. That is
 * deliberate and it is the whole reason this file is small: a per-job margin
 * and a rolled-up margin that disagree by six dollars is a meeting nobody
 * recovers from, and the only way to be sure they agree is for there to be
 * one copy of the arithmetic.
 */

/**
 * WHAT EVERY NUMBER ON A STATEMENT IS WRONG ABOUT.
 *
 * Travels with the numbers, in the shape `reviews.getRating` already
 * established here, because a margin shown without its caveat is the one that
 * gets quoted back in a board meeting as though it were net profit.
 */
export const CAVEATS = {
  overhead:
    "Gross margin. No overhead is allocated in it: not the truck, the dispatcher, the building, or the employer's payroll taxes and workers' compensation. "
    + "Where a fully loaded margin is shown beside it, on a job and on the job costing reports, it takes off labour burden and overhead at the rates your company set under Settings, Costing, each at the rate in effect on the day; with none set the two are equal. "
    + "An allocation is a choice, not a measurement: overhead by revenue leaves every job's margin percentage where it was, and overhead by the hour charges a job that ran long twice for the same overrun.",
  overtime:
    "Labour is hours at the loaded rate frozen onto each punch, which is base plus fringe. "
    + "The overtime premium is NOT included, because overtime is a property of a person's week rather than of a job: "
    + "the forty first hour is expensive because of forty hours worked on other jobs. The premium stays on the timesheet.",
  cost:
    "Revenue and processing fees come from the ledger. Material and labour cost mostly do not, because using stock does not post to cost of goods sold here: "
    + "they are read from the job lines and the timeclock, which are the records of consumption that exist. "
    + "The exceptions are cost of goods sold posted to the job in the ledger: freight or duty billed after a delivery on parts this job used, and any cost an accountant journalled to the job, such as a subcontractor's bill or a disposal receipt. Those are added to material cost, each read once, from the ledger. "
    + "A cost already on one of the job's lines should not also be journalled to the job, or it is counted twice. A journal line on a job in an account the margin does not read, labour for one, is listed and left out, because the hours are counted from the timeclock. "
    + "Every figure traces to the rows listed beside it.",
  fees:
    "A card fee is posted against the customer rather than the job, because one payment can clear invoices on several jobs. "
    + "It is split here across the invoices that payment cleared, in proportion to what was applied to each. That is an allocation, and it is the only basis this data supports.",
} as const;

export interface LedgerRow {
  transactionId: string;
  occurredAt: Date;
  accountCode: string;
  direction: string;
  amount: string;
  sourceType: string;
  sourceId: string;
  memo: string | null;
  /** The journal's number, when the row is a line of a manual journal. */
  journalNumber: number | null;
}

/**
 * A line of a manual journal that names this job (M14), and what the margin
 * does with it. Every one is listed, so a journal never touches a job without
 * the statement saying so, and the ones costing does not read say that too.
 */
export interface JournalOnJob {
  transactionId: string;
  occurredAt: Date;
  journalId: string;
  journalNumber: number;
  accountCode: string;
  direction: string;
  amount: string;
  memo: string | null;
  /** Which figure it is in: revenue, materials or card fees. Null when costing does not count it. */
  countedIn: costingRules.JournalCounts;
}

export interface CostedLine {
  id: string;
  kind: string;
  name: string;
  quantity: string;
  /** What it would bill at. Zero on warranty and on our own rework. */
  unitPrice: string;
  /** Null means the cost was never recorded, which is not the same as zero. */
  unitCost: string | null;
  extendedCost: string | null;
  billed: boolean;
  nonBillableReason: string | null;
}

export interface LabourRow {
  /** Null when the caller does not hold `payroll:read`. See `statement`. */
  technicianId: string | null;
  technicianName: string | null;
  hours: string;
  cost: string;
  unpricedHours: string;
}

export interface JobProfitability {
  jobId: string;
  number: number;
  summary: string;
  status: string;
  customerName: string | null;
  isWarranty: boolean;
  asOf: Date;

  revenue: string;
  materialCost: string;
  labourCost: string;
  processingFees: string;
  /** What people spent for the job that the company agreed to pay back, and the per diem for days away on it (M17). */
  expenseCost: string;
  grossMargin: string;
  /** Null, never zero, when there is no revenue to be a percentage of. */
  grossMarginPercent: number | null;
  /** Employer's payroll taxes, benefits and workers' comp at the company's rates. Zero with none set. */
  labourBurden: string;
  /** Overhead at the company's rate for the job's day. Zero with none set. */
  overhead: string;
  /** Gross margin less burden and overhead. Equal to gross margin until rates are set. */
  fullyLoadedMargin: string;
  fullyLoadedMarginPercent: number | null;

  scheduledHours: string;
  actualHours: string;
  hoursOverPlan: string;

  settled: boolean;
  /** Why the margin is not final yet. Empty when it is. */
  provisional: string[];

  unbilledCost: string;
  unpricedLabourHours: string;
  openTimeEntries: number;
  uncostedLines: number;
  labourRecorded: boolean;

  caveats: typeof CAVEATS;
  revenueEntries: LedgerRow[];
  /**
   * Cost of goods sold posted to the job: late freight on parts it used, and
   * what an accountant journalled to it. Added to material cost.
   */
  costEntries: LedgerRow[];
  feeEntries: LedgerRow[];
  /** Every manual journal line on this job, with what the margin does with it. */
  journalLines: JournalOnJob[];
  lines: CostedLine[];
  labour: LabourRow[];
}

/** A ledger row as the query returns it, in the database's own column names. */
type LedgerSqlRow = {
  transaction_id: string;
  occurred_at: Date;
  account_code: string;
  direction: string;
  amount: string;
  source_type: string;
  source_id: string;
  memo: string | null;
  journal_number: number | null;
};

/** A money column as a decimal string, never a float. */
const money = (expression: string, alias: string) =>
  sql.raw(`(${expression})::numeric(14,4)::text as "${alias}"`);

/** Hours to two places, which is how a timesheet reads them. */
const hours = (expression: string, alias: string) =>
  sql.raw(`round((${expression})::numeric, 2)::text as "${alias}"`);

type StatementRow = {
  id: string;
  number: number;
  summary: string;
  status: string;
  is_warranty: boolean;
  customer_name: string | null;
  as_of: Date;
  revenue: string;
  material_cost: string;
  labour_cost: string;
  processing_fees: string;
  expense_cost: string;
  gross_margin: string;
  labour_burden: string;
  overhead: string;
  fully_loaded_margin: string;
  unbilled_cost: string;
  scheduled_hours: string;
  actual_hours: string;
  unpriced_labour_hours: string;
  open_time_entries: string;
  uncosted_lines: string;
  labour_not_recorded: string;
  settlement: string;
};

/**
 * ONE JOB, AND THE ROWS BEHIND EVERY NUMBER ON IT.
 *
 * GUARDED BY BOTH PERMISSIONS, and the first one is the one that is easy to
 * leave out. `job.cost:read` is the obvious guard and on its own it is not
 * enough: this statement discloses revenue, and a surface that hands out one
 * job's margin to somebody who may not run the company's financial reports is
 * simply the financial report with a loop around it. Ten thousand calls and
 * you have the roll-up the catalogue refused them.
 *
 * Refused rather than blanked, which is the report surface's rule and the
 * right one. A statement returned with its cost fields stripped teaches
 * whoever ran it that the job cost nothing, and they act on it.
 *
 * Scoped as well as permissioned, through the same `scopeFilterFor` the
 * builder uses, so a technician who has been granted the money permissions on
 * a custom role reads their own jobs and not the company's.
 */
export async function statement(
  ctx: ServiceContext,
  input: { jobId: string },
): Promise<JobProfitability> {
  assertCan(ctx.actor, "report.financial:read");

  return guardedRead(ctx, "job.cost:read", async (tx) => {
    const scoped = scopeFilterFor(ctx, PROFITABILITY_DATASET);

    const [row] = await tx.execute<StatementRow>(sql`
      select
        job.id, job.number, job.summary, job.status::text as status, job.is_warranty,
        (select c.name from public.customer c where c.id = job.customer_id) as customer_name,
        coalesce(job.completed_at, job.created_at) as as_of,
        ${money(JOB_COSTING_SQL.revenue, "revenue")},
        ${money(JOB_COSTING_SQL.materialCost, "material_cost")},
        ${money(JOB_COSTING_SQL.labourCost, "labour_cost")},
        ${money(JOB_COSTING_SQL.processingFees, "processing_fees")},
        ${money(JOB_COSTING_SQL.expenseCost, "expense_cost")},
        ${money(GROSS_MARGIN_SQL, "gross_margin")},
        ${money(JOB_COSTING_SQL.labourBurden, "labour_burden")},
        ${money(JOB_COSTING_SQL.overhead, "overhead")},
        ${money(FULLY_LOADED_MARGIN_SQL, "fully_loaded_margin")},
        ${money(JOB_COSTING_SQL.unbilledCost, "unbilled_cost")},
        ${hours(JOB_COSTING_SQL.scheduledHours, "scheduled_hours")},
        ${hours(JOB_COSTING_SQL.actualHours, "actual_hours")},
        ${hours(JOB_COSTING_SQL.unpricedLabourHours, "unpriced_labour_hours")},
        ${sql.raw(`${JOB_COSTING_SQL.openTimeEntries}::text as "open_time_entries"`)},
        ${sql.raw(`${JOB_COSTING_SQL.uncostedLines}::text as "uncosted_lines"`)},
        ${sql.raw(`${JOB_COSTING_SQL.labourNotRecorded}::text as "labour_not_recorded"`)},
        ${sql.raw(`${SETTLEMENT_SQL} as "settlement"`)}
      from public.job
      where job.id = ${input.jobId}::uuid
        and job.deleted_at is null
        ${scoped ? sql` and ${scoped}` : sql``}
      limit 1
    `);

    /**
     * The same answer for "no such job" and "not yours". Distinguishing them
     * tells a technician which job numbers exist, which is most of what they
     * would want the statement for in the first place.
     */
    if (!row) throw new NotFoundError("Job");

    /**
     * THE LEDGER ROWS BY JOB, which is where a manual journal line on a job
     * arrives too: a line that names a job is a ledger entry with that job on
     * it, so these three accounts read it without a second query, and a line
     * cannot be counted twice by being read in two places. The journal's
     * number is joined on so a reader can find the entry it came from.
     */
    const ledger = await tx.execute<LedgerSqlRow>(sql`
      select le.transaction_id, le.occurred_at, le.account_code, le.direction::text as direction,
             le.amount::numeric(14,4)::text as amount, le.source_type, le.source_id, le.memo,
             je.number as journal_number
      from public.ledger_entry le
      left join public.journal_entry je on le.source_type = 'journal' and je.id = le.source_id
      where le.job_id = ${input.jobId}::uuid
        and le.account_code in ('4000', '4100', '4900', '6100', '5000')
      order by le.occurred_at, le.account_code
    `);

    /**
     * Every journal line on the job, counted or not. The three accounts above
     * are the ones costing reads; a journal line on any other account (labour,
     * rent, an asset) is listed here as booked to the job and left out of the
     * margin, with the reason in core (`journalCounts`).
     */
    const journalLines = await tx.execute<{
      transaction_id: string; occurred_at: Date; source_id: string; journal_number: number;
      account_code: string; direction: string; amount: string; memo: string | null;
    }>(sql`
      select le.transaction_id, le.occurred_at, le.source_id, je.number as journal_number,
             le.account_code, le.direction::text as direction, le.amount::numeric(14,4)::text as amount, le.memo
      from public.ledger_entry le
      join public.journal_entry je on je.id = le.source_id
      where le.job_id = ${input.jobId}::uuid and le.source_type = 'journal'
      order by le.occurred_at, je.number, le.account_code
    `);

    /**
     * The fee rows a payment produced, which carry no job and are reached
     * through the allocations instead. Listed as they were posted, at their
     * full amount, with the job's share stated separately in
     * `processingFees`: showing a pro rated figure as though it were a ledger
     * row would be a number that does not exist in the ledger, which is the
     * one thing this statement promises not to do.
     */
    const allocatedFees = await tx.execute<LedgerSqlRow>(sql`
      select distinct le.transaction_id, le.occurred_at, le.account_code, le.direction::text as direction,
             le.amount::numeric(14,4)::text as amount, le.source_type, le.source_id, le.memo,
             null::int as journal_number
      from public.payment_allocation pa
      join public.invoice i on i.id = pa.invoice_id
      join public.ledger_entry le
        on le.source_type = 'payment' and le.source_id = pa.payment_id and le.account_code = '6100'
      where i.job_id = ${input.jobId}::uuid
      order by le.occurred_at
    `);

    const lines = await tx.execute<{
      id: string; kind: string; name: string; quantity: string;
      unit_price: string; unit_cost: string | null; extended_cost: string | null;
      billed: boolean; non_billable_reason: string | null;
    }>(sql`
      select jl.id, jl.kind::text as kind, jl.name,
             jl.quantity::text as quantity,
             jl.unit_price::numeric(14,4)::text as unit_price,
             jl.unit_cost::numeric(14,4)::text as unit_cost,
             (jl.quantity * jl.unit_cost)::numeric(14,4)::text as extended_cost,
             (jl.invoice_line_id is not null) as billed,
             jl.non_billable_reason
      from public.job_line jl
      where jl.job_id = ${input.jobId}::uuid
      order by jl.occurred_at, jl.id
    `);

    /**
     * WHOSE HOURS, AND WHY THAT IS A DIFFERENT PERMISSION.
     *
     * `timeclock_entry.applied_base_rate`, `applied_fringe_rate` and
     * `applied_loaded_rate` are all guarded by `payroll:read` in
     * FIELD_PERMISSIONS, because what a named person is paid is payroll
     * rather than job costing. A per-technician split of this job's labour
     * hands that over by division: four hours and a hundred and sixty dollars
     * beside somebody's name is a forty dollar loaded rate.
     *
     * That matters for a role that really exists. `admin` holds
     * `report.financial:read` and `job.cost:read` and deliberately does NOT
     * hold `payroll:read`, under a preset whose description says payroll is
     * excluded and must be granted explicitly. Without this check, every
     * administrator reads every technician's wage off a profit statement.
     *
     * So the split is withheld and the job's own totals are not, because the
     * totals are what `job.cost:read` names. WHAT THIS DOES NOT PREVENT: on a
     * job worked by exactly one person, the job's labour cost divided by its
     * hours is still that person's loaded rate. Preventing that would mean
     * withholding job costing from somebody who holds the job costing
     * permission. What it does prevent is naming them, which is the part that
     * turns a rate into somebody's wage.
     */
    const named = permissionsFor(ctx.actor).has("payroll:read");

    const labour = await tx.execute<{
      technician_id: string; technician_name: string;
      hours: string; cost: string; unpriced_hours: string;
    }>(sql`
      select tc.technician_id,
             t.display_name as technician_name,
             round((coalesce(sum(tc.minutes), 0)::numeric / 60), 2)::text as hours,
             coalesce(sum(
               (tc.minutes::numeric / 60) * coalesce(tc.applied_loaded_rate, tc.applied_base_rate)
             ), 0)::numeric(14,4)::text as cost,
             round((coalesce(sum(case
               when coalesce(tc.applied_loaded_rate, tc.applied_base_rate) is null then tc.minutes else 0
             end), 0)::numeric / 60), 2)::text as unpriced_hours
      from public.timeclock_entry tc
      join public.technician t on t.id = tc.technician_id
      where tc.job_id = ${input.jobId}::uuid
        and tc.ended_at is not null
        and tc.kind <> 'unpaid_break'
      group by tc.technician_id, t.display_name
      order by t.display_name
    `);

    const settled = row.settlement === "Settled";
    const openEntries = Number(row.open_time_entries);
    const uncosted = Number(row.uncosted_lines);
    const labourRecorded = row.labour_not_recorded === "0";

    /**
     * WHY THE MARGIN IS NOT FINISHED BEING WRONG, as sentences rather than as
     * a boolean.
     *
     * "Provisional" on its own tells somebody not to trust the number and not
     * what to do about it. Each reason below names the thing that has to
     * happen, because every one of them is fixable by a person in the office
     * this afternoon.
     */
    const provisional: string[] = [];
    if (openEntries > 0) {
      provisional.push(
        `${openEntries} ${openEntries === 1 ? "punch is" : "punches are"} still running on this job, `
        + "so the labour cost is still going up.",
      );
    }
    if (Number(row.unpriced_labour_hours) > 0) {
      provisional.push(
        `${row.unpriced_labour_hours} hours were worked with no wage scale in effect, so they cost nothing here `
        + "and the real labour cost is higher by an amount nobody can state.",
      );
    }
    if (Number(row.unbilled_cost) !== 0) {
      provisional.push(
        "Work has been consumed that is neither billed nor marked non-billable, "
        + "so revenue on this job may still be coming.",
      );
    }
    if (uncosted > 0) {
      provisional.push(
        `${uncosted} ${uncosted === 1 ? "line has" : "lines have"} no cost recorded, which is unknown rather than zero.`,
      );
    }
    const [waiting] = await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from public.expense
      where job_id = ${input.jobId}::uuid and status = 'pending'
    `);
    if (Number(waiting?.n ?? 0) > 0) {
      provisional.push(
        `${waiting!.n} ${waiting!.n === "1" ? "receipt is" : "receipts are"} waiting for the office to approve, `
        + "so what they cost is not in this margin yet.",
      );
    }
    if (!labourRecorded) {
      provisional.push(
        "No hours were ever recorded against this job, so its labour cost is zero because nobody measured it, "
        + "not because the work was free.",
      );
    }

    const revenue = Number(row.revenue);
    const toLedgerRow = (r: LedgerSqlRow): LedgerRow => ({
      transactionId: r.transaction_id,
      occurredAt: r.occurred_at,
      accountCode: r.account_code,
      direction: r.direction,
      amount: r.amount,
      sourceType: r.source_type,
      sourceId: r.source_id,
      memo: r.memo,
      journalNumber: r.journal_number,
    });

    return {
      jobId: row.id,
      number: row.number,
      summary: row.summary,
      status: row.status,
      customerName: row.customer_name,
      isWarranty: row.is_warranty,
      asOf: row.as_of,

      revenue: row.revenue,
      materialCost: row.material_cost,
      labourCost: row.labour_cost,
      processingFees: row.processing_fees,
      expenseCost: row.expense_cost,
      grossMargin: row.gross_margin,
      /**
       * Null rather than zero when there is no revenue. A warranty job has a
       * real cost and no income, and "0%" says it broke even.
       */
      grossMarginPercent: revenue === 0
        ? null
        : Math.round((Number(row.gross_margin) / revenue) * 1000) / 10,
      labourBurden: row.labour_burden,
      overhead: row.overhead,
      fullyLoadedMargin: row.fully_loaded_margin,
      fullyLoadedMarginPercent: revenue === 0
        ? null
        : Math.round((Number(row.fully_loaded_margin) / revenue) * 1000) / 10,

      scheduledHours: row.scheduled_hours,
      actualHours: row.actual_hours,
      hoursOverPlan: (Number(row.actual_hours) - Number(row.scheduled_hours)).toFixed(2),

      settled,
      provisional,

      unbilledCost: row.unbilled_cost,
      unpricedLabourHours: row.unpriced_labour_hours,
      openTimeEntries: openEntries,
      uncostedLines: uncosted,
      labourRecorded,

      caveats: CAVEATS,
      revenueEntries: ledger.filter((r) => r.account_code !== "6100" && r.account_code !== "5000").map(toLedgerRow),
      costEntries: ledger.filter((r) => r.account_code === "5000").map(toLedgerRow),
      feeEntries: [
        ...ledger.filter((r) => r.account_code === "6100").map(toLedgerRow),
        ...allocatedFees.map(toLedgerRow),
      ],
      journalLines: journalLines.map((j) => ({
        transactionId: j.transaction_id,
        occurredAt: j.occurred_at,
        journalId: j.source_id,
        journalNumber: j.journal_number,
        accountCode: j.account_code,
        direction: j.direction,
        amount: j.amount,
        memo: j.memo,
        countedIn: costingRules.journalCounts(j.account_code),
      })),
      lines: lines.map((l) => ({
        id: l.id,
        kind: l.kind,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unit_price,
        unitCost: l.unit_cost,
        extendedCost: l.extended_cost,
        billed: l.billed,
        nonBillableReason: l.non_billable_reason,
      })),
      labour: labour.map((l) => ({
        technicianId: named ? l.technician_id : null,
        technicianName: named ? l.technician_name : null,
        hours: l.hours,
        cost: l.cost,
        unpricedHours: l.unpriced_hours,
      })),
    };
  });
}

/** The dimensions a summary may be grouped by, taken from the catalogue. */
export const SUMMARY_DIMENSIONS = PROFITABILITY_DATASET.dimensions.map((d) => d.key);

/**
 * THE ROLL-UP, WHICH IS AN ORDINARY REPORT.
 *
 * A named route rather than making every caller assemble a definition,
 * because "margin by job type this quarter" is one question and should be one
 * request. It is still resolved by `reporting.resolveReport` against the
 * catalogue, so the dimension a caller names is a key that is either in the
 * catalogue or refused, the measures are refused one at a time against what
 * they hold, and the scope filter is applied by the builder rather than by
 * this function remembering to.
 *
 * IN PROGRESS WORK IS EXCLUDED BY DEFAULT and can be asked for. A job still
 * accruing labour has all of its revenue and some of its cost, so it reads as
 * the most profitable work in the company; leaving it in by default would put
 * the unfinished jobs at the top of every league table. Leaving it out
 * ALTOGETHER would hide the jobs somebody can still do something about, which
 * is why it is a flag and not a rule.
 */
export async function summary(
  ctx: ServiceContext,
  input: {
    by: string;
    from?: string | undefined;
    to?: string | undefined;
    limit?: number | undefined;
    includeInProgress?: boolean | undefined;
  },
): Promise<ReportResult> {
  const definition: reporting.ReportDefinition = {
    dataset: "profitability",
    dimensions: [input.by],
    measures: [
      "revenue", "material_cost", "labour_cost", "processing_fees", "gross_margin",
      "labour_burden", "overhead", "fully_loaded_margin",
      "scheduled_hours", "actual_hours", "hours_over", "count",
    ],
    ...(input.includeInProgress
      ? {}
      : { filters: [{ dimension: "settled", op: "eq" as const, value: "Settled" }] }),
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  };

  return run(ctx, definition);
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  getJobProfitability: (ctx: ServiceContext, input: { id: string }): Promise<JobProfitability> =>
    statement(ctx, { jobId: input.id }),

  getProfitabilitySummary: (ctx: ServiceContext, input: {
    by: string;
    from?: string | undefined;
    to?: string | undefined;
    limit?: number | undefined;
    includeInProgress?: boolean | undefined;
  }): Promise<ReportResult> => summary(ctx, input),
} as const;
