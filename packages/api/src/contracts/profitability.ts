import { z } from "zod";
import { defineRoute } from "../lib/define";
import { MoneyString, Uuid } from "./common";

/**
 * M15. JOB COSTING AND PROFITABILITY
 *
 * The cost side of this product has existed for a long time:
 * `job_line.unit_cost` is written by the field app, `timeclock_entry` carries
 * the rate that was frozen onto each punch, and `job.cost:read` redacts both
 * from anybody who must not see them. What was missing is the only question
 * an owner of a trades business actually asks, which is which work makes
 * money.
 *
 * TWO ROUTES, BECAUSE THERE ARE TWO QUESTIONS.
 *
 * The summary is a roll-up and it is an ordinary report over the
 * `profitability` dataset in the catalogue, so it scopes, bounds and refuses
 * exactly like the other eight. The statement is one job with the ledger
 * rows, the lines and the punches behind every number on it, which is what
 * somebody wants the moment they do not believe the roll-up.
 *
 * WHAT THESE NUMBERS ARE NOT. Gross margin has no overhead allocated,
 * because a rate nobody chose would be an opinion in every margin; the
 * fully loaded margin beside it uses the burden and overhead rates the
 * company itself set, and equals the gross margin until it sets any. Labour at the loaded rate frozen onto each punch and not including
 * the overtime premium, because overtime belongs to a person's week rather
 * than to a job. Every response carries those caveats as text, so a figure
 * cannot travel without them.
 *
 * BOTH PERMISSIONS ON BOTH ROUTES. `job.cost:read` is the obvious one and on
 * its own it is not enough: a statement discloses revenue, so a surface that
 * served it to somebody who may not run the company's financial reports would
 * be the financial report with a loop around it.
 */

/** Hours as a decimal string, for the same reason money is a string. */
const HoursString = z.string().regex(/^-?\d+(\.\d{1,2})?$/, "Hours must be a decimal string with at most 2 places");

export const ProfitabilityCaveats = z.object({
  overhead: z.string(),
  overtime: z.string(),
  cost: z.string(),
  fees: z.string(),
});

export const ProfitabilityLedgerRow = z.object({
  transactionId: Uuid,
  occurredAt: z.string().datetime(),
  /** The chart of accounts code. 4000 revenue, 4900 contra revenue, 6100 fees. */
  accountCode: z.string(),
  direction: z.string(),
  amount: MoneyString,
  sourceType: z.string(),
  sourceId: Uuid,
  memo: z.string().nullable(),
});

export const CostedJobLine = z.object({
  id: Uuid,
  kind: z.string(),
  name: z.string(),
  quantity: z.string(),
  unitPrice: MoneyString,
  /** Null means nobody recorded a cost, which is not the same as zero. */
  unitCost: MoneyString.nullable(),
  extendedCost: MoneyString.nullable(),
  billed: z.boolean(),
  nonBillableReason: z.string().nullable(),
});

export const JobLabourRow = z.object({
  /** Null unless the caller holds `payroll:read`. Hours beside a name are a wage. */
  technicianId: Uuid.nullable(),
  technicianName: z.string().nullable(),
  hours: HoursString,
  cost: MoneyString,
  unpricedHours: HoursString,
});

export const getJobProfitability = defineRoute({
  method: "get",
  path: "/v1/profitability/jobs/{id}",
  summary: "What one job earned, and the rows behind every number",
  description:
    "Revenue and processing fees come from the ledger. Material and labour cost come from the job lines and the timeclock, because using stock does not post to cost of goods sold; the one exception, freight billed after a delivery on parts the job used, is posted to cost of goods sold on the job and added to material cost (`costEntries`). Labour is hours at the loaded rate frozen onto each punch, which excludes the overtime premium: overtime belongs to a person's week, not to a job. The gross margin has no overhead in it; the fully loaded margin beside it takes off labour burden and overhead at the rates the company set (`GET /v1/costing/rates`), and equals the gross margin until any are set. A job with a punch still running, hours with no wage scale, or a line nobody has billed or written off comes back with `settled` false and a sentence per reason, because its margin is not finished being wrong.",
  module: "M15",
  permissions: ["report.financial:read", "job.cost:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    jobId: Uuid,
    number: z.number().int(),
    summary: z.string(),
    status: z.string(),
    customerName: z.string().nullable(),
    isWarranty: z.boolean(),
    /** When the work happened: completion, or creation while it is running. */
    asOf: z.string().datetime(),

    revenue: MoneyString,
    materialCost: MoneyString,
    labourCost: MoneyString,
    processingFees: MoneyString,
    /** What people spent for the job that the company agreed to pay back, and per diem for days away on it (M17). */
    expenseCost: MoneyString,
    grossMargin: MoneyString,
    /** Null, never zero. A warranty job has cost and no income; 0% says it broke even. */
    grossMarginPercent: z.number().nullable(),
    /** Employer's payroll taxes, benefits and workers' compensation at the company's own dated rates. */
    labourBurden: MoneyString,
    /** Overhead at the company's own rate for the job's day. */
    overhead: MoneyString,
    /** Gross margin less burden and overhead. Beside the gross margin, never instead of it. */
    fullyLoadedMargin: MoneyString,
    fullyLoadedMarginPercent: z.number().nullable(),

    scheduledHours: HoursString,
    actualHours: HoursString,
    /** Where the money goes: a price list right at four hours loses at seven. */
    hoursOverPlan: HoursString,

    settled: z.boolean(),
    provisional: z.array(z.string()),

    unbilledCost: MoneyString,
    unpricedLabourHours: HoursString,
    openTimeEntries: z.number().int(),
    uncostedLines: z.number().int(),
    labourRecorded: z.boolean(),

    caveats: ProfitabilityCaveats,
    revenueEntries: z.array(ProfitabilityLedgerRow),
    /** Cost of goods sold posted to the job (late freight on parts it used), added to `materialCost` beside the lines. */
    costEntries: z.array(ProfitabilityLedgerRow),
    /**
     * Fee postings at their FULL amount, as the ledger holds them. The job's
     * share is in `processingFees`: a pro rated figure listed as a ledger row
     * would be a number that is not in the ledger.
     */
    feeEntries: z.array(ProfitabilityLedgerRow),
    lines: z.array(CostedJobLine),
    labour: z.array(JobLabourRow),
  }),
});

/**
 * The dimensions worth grouping by, spelled out rather than taking any string.
 *
 * It would be resolved against the catalogue either way, and a refusal naming
 * a key nobody can list is a worse error than a 422 that names the five
 * things that work.
 */
export const ProfitabilityDimension = z.enum([
  "job", "month", "day", "weekday", "job_type",
  "customer", "business_unit", "technician", "status", "settled", "warranty",
]);

export const getProfitabilitySummary = defineRoute({
  method: "get",
  path: "/v1/profitability/summary",
  summary: "Margin rolled up by the thing that changes a decision",
  description:
    "The same job costing, grouped: by job type, by technician, by customer, by business unit, by month or by day of the week. An owner who learns that drain cleaning loses money on Saturdays can do something about it on Monday. Jobs that are still accruing labour are EXCLUDED by default, because a job with all of its revenue and half of its cost reads as the most profitable work in the company; `includeInProgress` puts them back for the report whose whole point is the unfinished work.",
  module: "M15",
  permissions: ["report.financial:read", "job.cost:read"],
  input: z.object({
    by: ProfitabilityDimension,
    /** Inclusive start, exclusive end, against the date the WORK happened. */
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    includeInProgress: z.boolean().optional(),
  }),
  output: z.object({
    columns: z.array(z.object({
      key: z.string(),
      label: z.string(),
      type: z.string(),
      /** The screen right aligns a measure and not a dimension. */
      role: z.enum(["dimension", "measure"]),
      sortPrefix: z.boolean().optional(),
    })),
    rows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))),
    truncated: z.boolean(),
  }),
});

export const profitabilityRoutes = {
  getJobProfitability, getProfitabilitySummary,
} as const;
