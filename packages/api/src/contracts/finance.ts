import { z } from "zod";
import { defineRoute } from "../lib/define";
import { DeletedInBooks, MoneyString, Uuid } from "./common";

/**
 * FINANCE: CONSUMER FINANCING (M13), THE COSTING RATES AND THE COMPANY BUDGET
 * (M15), AND MANUAL JOURNALS (M14)
 *
 * Four surfaces an owner named in one breath as "run job costing and
 * financing". Each is small over the API because the arithmetic lives in
 * core and the money lives on the ledger; these routes put a thing in and
 * read a thing back.
 */

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date is YYYY-MM-DD");

/* ------------------------------------------------------------ financing */

export const FinancingStatus = z.enum(["sent", "applied", "approved", "declined", "expired", "funded", "cancelled"]);

export const FinancingOffer = z.object({
  lender: z.string(),
  /** Never shown alone: `sentence` carries "subject to approval" with it. */
  monthly: MoneyString,
  months: z.number().int(),
  aprPercent: z.string(),
  sentence: z.string(),
  short: z.string(),
});

export const FinancingApplication = z.object({
  id: Uuid,
  provider: z.string(),
  status: FinancingStatus,
  statusLabel: z.string(),
  customerId: Uuid,
  customerName: z.string().nullable(),
  invoiceId: Uuid.nullable(),
  invoiceNumber: z.number().int().nullable(),
  estimateId: Uuid.nullable(),
  estimateNumber: z.number().int().nullable(),
  /** What the customer was asked to borrow: the invoice balance or the option's total. */
  amount: MoneyString,
  approvedAmount: MoneyString.nullable(),
  chosenOffer: z.object({ months: z.number().int(), aprPercent: z.string(), monthlyPayment: MoneyString.nullable() }).nullable(),
  fundedAmount: MoneyString.nullable(),
  /** Null when the lender did not say, which is not zero. */
  feeAmount: MoneyString.nullable(),
  fundedAt: z.string().datetime().nullable(),
  /** The payment the funding became. */
  paymentId: Uuid.nullable(),
  applicationUrl: z.string(),
  sentVia: z.string(),
  sentTo: z.string().nullable(),
  /** Something the office has to look at that the status cannot say. */
  attention: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const listFinancingApplications = defineRoute({
  method: "get",
  path: "/v1/financing/applications",
  summary: "Loan applications customers were sent, and where each stands",
  description:
    "Newest first. The status is what the lender last returned, read back from the lender rather than taken from a webhook. Nothing about the customer's credit is kept beyond it.",
  module: "M13",
  permissions: ["payment:read"],
  input: z.object({
    status: FinancingStatus.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }),
  output: z.object({ applications: z.array(FinancingApplication) }),
});

export const getInvoiceFinancing = defineRoute({
  method: "get",
  path: "/v1/invoices/{invoiceId}/financing",
  summary: "Financing on one invoice: the monthly figure and the applications",
  description:
    "The \"as low as\" offer for the balance, worked out from the plans on the company's lender connection and always carried with its \"subject to approval\" sentence, and every application on the invoice. `offer` is null when no lender is connected, the company hid the figure, no plans were entered, or the balance is outside what the lender finances.",
  module: "M13",
  permissions: ["invoice:read"],
  input: z.object({ invoiceId: Uuid }),
  output: z.object({
    connected: z.boolean(),
    lender: z.string().nullable(),
    offer: FinancingOffer.nullable(),
    applicable: z.boolean(),
    applications: z.array(FinancingApplication),
  }),
});

export const getEstimateFinancing = defineRoute({
  method: "get",
  path: "/v1/estimates/{estimateId}/financing",
  summary: "Financing on one estimate: a monthly figure per option and the applications",
  module: "M07",
  permissions: ["estimate:read"],
  input: z.object({ estimateId: Uuid }),
  output: z.object({
    connected: z.boolean(),
    lender: z.string().nullable(),
    options: z.array(z.object({
      optionId: Uuid, name: z.string(), total: MoneyString,
      offer: FinancingOffer.nullable(), applicable: z.boolean(),
    })),
    applications: z.array(FinancingApplication),
  }),
});

export const sendFinancingLink = defineRoute({
  method: "post",
  path: "/v1/financing/applications",
  summary: "Open a loan application for an invoice or an estimate, and text or email the customer its link",
  description:
    "The amount is read from the invoice's balance or the estimate option's total, never taken from the request. A live application for the same amount is reused rather than a second one opened. `channel` link sends nothing and returns the link to hand over. A text or email that cannot go (no number, the customer opted out, no provider) is reported in `delivery` with the reason, and the application stands. Idempotent on the request's key: a retry does not message the customer twice.",
  module: "M13",
  permissions: ["payment:collect"],
  idempotent: true,
  input: z.object({
    invoiceId: Uuid.optional(),
    estimateId: Uuid.optional(),
    /** The estimate option to finance, when the estimate has more than one and none was chosen. */
    optionId: Uuid.optional(),
    channel: z.enum(["sms", "email", "link"]),
    /** Overrides the number or address on the customer. */
    to: z.string().max(320).optional(),
  }),
  output: z.object({
    application: FinancingApplication,
    reused: z.boolean(),
    delivery: z.union([
      z.object({ sent: z.literal(true), channel: z.string() }),
      z.object({ sent: z.literal(false), channel: z.string(), reason: z.string() }),
    ]).nullable(),
  }),
});

export const refreshFinancingApplication = defineRoute({
  method: "post",
  path: "/v1/financing/applications/{id}/refresh",
  summary: "Ask the lender where an application stands now",
  description:
    "Reads the application back from the lender and records it, as a webhook would. When it has become funded the payment is recorded on the invoice with the lender's fee as an expense. Safe to repeat: an application only moves forward, and a funding is recorded once.",
  module: "M13",
  permissions: ["payment:collect"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: FinancingApplication,
});

export const getFinancingReport = defineRoute({
  method: "get",
  path: "/v1/financing/report",
  summary: "Applications, approval rate, funded volume and fees",
  description:
    "Over applications opened in the window. The approval rate is approved or funded over everything the lender decided, so a link nobody opened is not counted as a decline. Fees are what lenders reported keeping; funded loans with no reported fee are counted separately rather than as free.",
  module: "M13",
  permissions: ["report.financial:read"],
  input: z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }),
  output: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
    applications: z.number().int(),
    byStatus: z.record(FinancingStatus, z.number().int()),
    approvalRate: z.number().nullable(),
    decided: z.number().int(),
    fundedCount: z.number().int(),
    fundedVolume: MoneyString,
    fees: MoneyString,
    feesUnknown: z.number().int(),
    feePercent: z.number().nullable(),
    pendingVolume: MoneyString,
  }),
});

/* -------------------------------------------------------------- costing */

const CostingBasis = z.enum([
  "percent_of_wages", "per_hour", "per_job", "percent_of_revenue", "percent_of_material", "per_visit", "per_truck",
]);

export const CostingRate = z.object({
  id: Uuid,
  component: z.enum(["payroll_taxes", "benefits", "workers_comp", "overhead"]),
  componentLabel: z.string(),
  basis: CostingBasis,
  basisLabel: z.string(),
  /** A percentage or an amount, by the basis. */
  rate: z.string(),
  effectiveFrom: DateString,
  note: z.string().nullable(),
  current: z.boolean(),
  createdAt: z.string().datetime(),
});

export const listCostingRates = defineRoute({
  method: "get",
  path: "/v1/costing/rates",
  summary: "Labour burden and overhead rates, with the dates they took effect",
  description:
    "Every rate the company has set, oldest first per component, with `current` on the one in effect today. These are what turn the direct margin on job costing into the fully loaded one beside it.",
  module: "M15",
  permissions: ["job.cost:read"],
  input: z.object({}),
  output: z.object({
    today: DateString,
    rates: z.array(CostingRate),
    /** The overhead charged today, part by part, or null with none set. */
    overheadNow: z.object({
      effectiveFrom: DateString,
      parts: z.array(z.object({
        basis: z.enum(["per_hour", "per_job", "percent_of_revenue", "percent_of_material", "per_visit", "per_truck"]),
        label: z.string(), rate: z.string(),
      })),
    }).nullable(),
  }),
});

export const setCostingRate = defineRoute({
  method: "post",
  path: "/v1/costing/rates",
  summary: "Set a burden or overhead rate from a date",
  description:
    "Payroll taxes, benefits and workers' compensation are a percent of base wages or an amount per paid hour; overhead is per paid hour, per job, a percent of the job's revenue, a percent of its material cost, an amount per visit, or an amount per truck day (each company vehicle that went out on the job, once for each day, by the vehicle register's custody record). A rate applies from its date until a later one for the same component, so a change does not reprice the past; a zero switches a component off. A second rate for one burden component on one day is refused. Overhead can be a mix: an overhead rate by another basis on a day that already has overhead is added to that day's mix, and the same basis twice is refused. Sending the same rate again returns it.",
  module: "M15",
  permissions: ["finance:configure"],
  idempotent: true,
  input: z.object({
    component: z.enum(["payroll_taxes", "benefits", "workers_comp", "overhead"]),
    basis: CostingBasis,
    rate: z.string().max(20),
    effectiveFrom: DateString,
    note: z.string().max(500).optional(),
  }),
  output: CostingRate,
});

export const setOverheadMix = defineRoute({
  method: "post",
  path: "/v1/costing/overhead",
  summary: "Set overhead from a date as a mix: per paid hour, per job, shares of revenue and material cost, per visit and per truck day",
  description:
    "Each part is optional and at least one is given; a 0 stops charging overhead from the day. The parts set on a day are the whole of the overhead from that day until a later day, so a mix is replaced whole rather than added to, and jobs before the day keep the overhead of their own day. A day that already has overhead is refused unless the same mix is sent again, which returns it. Each part is reported on its own on a job's costing and in the profitability measures.",
  module: "M15",
  permissions: ["finance:configure"],
  idempotent: true,
  input: z.object({
    effectiveFrom: DateString,
    /** An amount per paid hour on the job. */
    perHour: z.string().max(20).optional(),
    /** An amount per job. */
    perJob: z.string().max(20).optional(),
    /** A percentage of the job's revenue. */
    percentOfRevenue: z.string().max(20).optional(),
    /** A percentage of the job's material cost: its lines at cost and cost of goods sold posted to it. */
    percentOfMaterial: z.string().max(20).optional(),
    /** An amount per visit on the job that was not cancelled. */
    perVisit: z.string().max(20).optional(),
    /** An amount per truck day: each company vehicle that went out on the job, once for each day it did. */
    perTruck: z.string().max(20).optional(),
    note: z.string().max(500).optional(),
  }),
  output: z.object({ effectiveFrom: DateString, rates: z.array(CostingRate) }),
});

export const removeCostingRate = defineRoute({
  method: "delete",
  path: "/v1/costing/rates/{id}",
  summary: "Remove a rate entered by mistake",
  module: "M15",
  permissions: ["finance:configure"],
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

/* --------------------------------------------------------------- budget */

const Year = z.coerce.number().int().min(2000).max(2100);

/** How the year end forecast takes the months to come; mirrors `budget.FORECAST_METHODS` in core. */
const ForecastMethod = z.enum(["budget", "run_rate", "seasonal"]);

export const getBudgetReport = defineRoute({
  method: "get",
  path: "/v1/budgets/{year}",
  summary: "The year's budget against the ledger, by line and month, with variance",
  description:
    "Actuals are read from the ledger in the company's calendar, so they agree with the trial balance. Months not yet over show the budget and no variance. `caveat` says which costs the ledger only holds when they are journalled. With `businessUnitId`, the branch's own lines against the ledger entries that carry that branch; with `jobTypeId`, the job type's own lines against the ledger entries on that type's jobs, and `jobType` counts the year's entries on no job, which it cannot hold; with both, that job type's lines in that branch against the entries that carry the branch and are on the type's jobs, with both counts. The whole company's report is the lines with neither, and no branch's or job type's lines are added into it, nor a branch's job type's into either. Each line has a year end `forecast`: the months already over at their actual, and this month and the rest at their budget or, when the company chose it, at the run rate of the months already over, or shaped like last year (the months already over taken as the share of the year they were last year in the same branch and job type, the rest in proportion; a line with nothing last year to follow is at its budget and says `noShape`); `forecast.assumption` says which, and it is an estimate, never a promise.",
  module: "M15",
  permissions: ["report.financial:read"],
  input: z.object({
    year: Year,
    /** One branch's own lines against what the ledger put in that branch. Left out is the whole company. */
    businessUnitId: Uuid.optional(),
    /** One job type's own lines against the ledger entries on its jobs. With `businessUnitId`, that type's lines in that branch. */
    jobTypeId: Uuid.optional(),
  }),
  output: z.object({
    year: z.number().int(),
    through: z.number().int(),
    lines: z.array(z.object({
      line: z.string(),
      label: z.string(),
      months: z.array(z.object({
        month: z.number().int(),
        budget: MoneyString.nullable(),
        actual: MoneyString,
        variance: MoneyString.nullable(),
        favourable: z.boolean().nullable(),
      })),
      toDate: z.object({
        budget: MoneyString, actual: MoneyString, variance: MoneyString,
        percent: z.number().nullable(), favourable: z.boolean().nullable(),
      }),
      year: z.object({ budget: MoneyString }),
      /** The year end forecast for the line, against the whole year's budget. */
      forecast: z.object({
        closedActual: MoneyString, toCome: MoneyString, forecast: MoneyString,
        variance: MoneyString, percent: z.number().nullable(), favourable: z.boolean().nullable(),
        unbudgetedMonths: z.number().int(),
        /** Present, and true, on a line shaped like last year that had nothing last year to follow, so it is at its budget. */
        noShape: z.literal(true).optional(),
      }),
    })),
    net: z.object({ budget: MoneyString, actual: MoneyString }).nullable(),
    caveat: z.string(),
    /** For a branch's report: the branch, and the year's ledger entries that carry no branch, which its actuals cannot hold. */
    branch: z.object({
      id: Uuid, name: z.string(), entriesWithoutBranch: z.number().int(), withoutBranchDebits: MoneyString,
    }).nullable(),
    /** For a job type's report: the type, and the year's ledger entries on no job, which its actuals cannot hold. */
    jobType: z.object({
      id: Uuid, name: z.string(), entriesWithoutJob: z.number().int(), withoutJobDebits: MoneyString,
    }).nullable(),
    forecast: z.object({
      chosen: ForecastMethod,
      method: ForecastMethod,
      closed: z.number().int(),
      fellBack: z.boolean(),
      /** With last year's shape chosen, how many lines had none and were taken at their budget. */
      linesWithoutShape: z.number().int().optional(),
      assumption: z.string(),
      net: z.object({ forecast: MoneyString, budget: MoneyString }).nullable(),
    }),
  }),
});

export const setBudgetForecastMethod = defineRoute({
  method: "put",
  path: "/v1/budgets/{year}/forecast",
  summary: "Choose how the year end forecast takes the months to come",
  description:
    "`budget` (the default) takes this month and the months after it at their budget; `run_rate` takes them at the average of the months already over, and falls back to the budget until a month is over; `seasonal` shapes them like last year: the months already over are taken as the share of the year they were last year, and the rest follows in proportion, each line by its own last year in the same branch and job type. `seasonal` is refused, in words, unless the books hold the whole of last year (their first entry is in its January or earlier). One choice for the year, which every reader and every branch's and job type's report uses. Nothing is posted.",
  module: "M15",
  permissions: ["finance:configure"],
  input: z.object({ year: Year, method: ForecastMethod }),
  output: z.object({ year: z.number().int(), method: ForecastMethod }),
});

export const setBudgetLine = defineRoute({
  method: "put",
  path: "/v1/budgets/{year}/lines",
  summary: "Set one budget line's twelve months",
  description:
    "`line` is Revenue, Materials, Labour, Overhead or an account code. `amounts` is January to December; null or empty is no budget that month. With `businessUnitId` the line is that branch's, with `jobTypeId` that job type's, and with both that job type's in that branch, a line of its own apart from the branch's and the job type's.",
  module: "M15",
  permissions: ["finance:configure"],
  input: z.object({
    year: Year,
    line: z.string().min(1).max(40),
    amounts: z.array(z.string().max(30).nullable()).length(12),
    /** The branch the line is for. Left out is the whole company's own line. */
    businessUnitId: Uuid.optional(),
    /** The job type the line is for, instead of a branch. */
    jobTypeId: Uuid.optional(),
  }),
  output: z.object({
    year: z.number().int(), line: z.string(), months: z.number().int(), businessUnitId: Uuid.nullable(), jobTypeId: Uuid.nullable(),
  }),
});

export const removeBudgetLine = defineRoute({
  method: "delete",
  path: "/v1/budgets/{year}/lines/{line}",
  summary: "Take a line out of the year's budget",
  module: "M15",
  permissions: ["finance:configure"],
  input: z.object({ year: Year, line: z.string().min(1).max(40), businessUnitId: Uuid.optional(), jobTypeId: Uuid.optional() }),
  output: z.object({ year: z.number().int(), line: z.string(), removed: z.literal(true) }),
});

export const importBudget = defineRoute({
  method: "post",
  path: "/v1/budgets/{year}/import",
  summary: "Load a year's budget from a spreadsheet",
  description:
    "CSV with a header row of months (Jan to Dec, or 1 to 12) and one row per line. Each line in the file replaces that line entirely; lines not in the file are left alone. Every problem is reported at once and nothing is written unless the whole file reads. Importing the same file twice leaves the same budget.",
  module: "M15",
  permissions: ["finance:configure"],
  idempotent: true,
  input: z.object({ year: Year, csv: z.string().min(1).max(200_000), businessUnitId: Uuid.optional(), jobTypeId: Uuid.optional() }),
  output: z.object({ year: z.number().int(), lines: z.number().int(), cells: z.number().int() }),
});

/* ------------------------------------------------------------- journals */

export const JournalEntry = z.object({
  id: Uuid,
  number: z.number().int(),
  occurredOn: DateString,
  memo: z.string(),
  total: MoneyString,
  currency: z.string(),
  reversesJournalId: Uuid.nullable(),
  reversesNumber: z.number().int().nullable(),
  reversedByJournalId: Uuid.nullable(),
  reversedByNumber: z.number().int().nullable(),
  createdByUserId: Uuid.nullable(),
  createdAt: z.string().datetime(),
  lines: z.array(z.object({
    entryId: Uuid,
    accountCode: z.string(),
    direction: z.enum(["debit", "credit"]),
    amount: MoneyString,
    memo: z.string().nullable(),
    businessUnitId: Uuid.nullable(),
    branchName: z.string().nullable(),
    jobId: Uuid.nullable(),
    jobNumber: z.string().nullable(),
    customerId: Uuid.nullable(),
    customerName: z.string().nullable(),
  })),
  /** Sent to the books and deleted there since. Nothing is re-sent or reversed by itself. */
  deletedInBooks: DeletedInBooks.nullable(),
});

export const listJournalEntries = defineRoute({
  method: "get",
  path: "/v1/ledger/journal-entries",
  summary: "Manual journal entries, newest first",
  module: "M14",
  permissions: ["ledger:read"],
  input: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
  output: z.object({ journals: z.array(JournalEntry) }),
});

export const getJournalEntry = defineRoute({
  method: "get",
  path: "/v1/ledger/journal-entries/{id}",
  summary: "One manual journal entry and its lines",
  module: "M14",
  permissions: ["ledger:read"],
  input: z.object({ id: Uuid }),
  output: JournalEntry,
});

export const createJournalEntry = defineRoute({
  method: "post",
  path: "/v1/ledger/journal-entries",
  summary: "Post a manual journal entry",
  description:
    "Lines with an account code and a debit or a credit, and optionally a branch (businessUnitId), a job and a customer each line is about. Each must be this company's own: a branch that is retired, a job or customer that has been removed, or another company's, refuses the entry and names the line. A line that names a job and no branch takes the job's branch. A job's costs and revenue include the journal lines on it (M15). Refused, with every problem named against its line, when it does not balance, when a line touches an account the product keeps in step with documents (receivable, customer deposits, tips and commission payable, deferred revenue), when the date is in the future, or when it falls in a closed period. Audited, and sent to the accounting system on the next sync once its accounts are mapped; the branch, job and customer are not sent, which carries each line's account and amount only.",
  module: "M14",
  permissions: ["ledger:post"],
  idempotent: true,
  input: z.object({
    occurredOn: DateString.optional(),
    memo: z.string().min(1).max(500),
    lines: z.array(z.object({
      accountCode: z.string().min(1).max(12),
      debit: z.string().max(20).optional(),
      credit: z.string().max(20).optional(),
      memo: z.string().max(500).optional(),
      businessUnitId: Uuid.optional(),
      jobId: Uuid.optional(),
      customerId: Uuid.optional(),
    })).min(2).max(100),
  }),
  output: JournalEntry,
});

export const reverseJournalEntry = defineRoute({
  method: "post",
  path: "/v1/ledger/journal-entries/{id}/reverse",
  summary: "Reverse a manual journal entry",
  description:
    "A new entry with every line on the other side, each pointing at the entry it takes back. Dated today unless another open day is given, never before the original. An entry is reversed once, and a reversal is not itself reversed.",
  module: "M14",
  permissions: ["ledger:post"],
  idempotent: true,
  input: z.object({ id: Uuid, occurredOn: DateString.optional(), memo: z.string().max(500).optional() }),
  output: JournalEntry,
});

export const financeRoutes = {
  listFinancingApplications, getInvoiceFinancing, getEstimateFinancing, sendFinancingLink,
  refreshFinancingApplication, getFinancingReport,
  listCostingRates, setCostingRate, setOverheadMix, removeCostingRate,
  getBudgetReport, setBudgetLine, removeBudgetLine, importBudget, setBudgetForecastMethod,
  listJournalEntries, getJournalEntry, createJournalEntry, reverseJournalEntry,
} as const;
