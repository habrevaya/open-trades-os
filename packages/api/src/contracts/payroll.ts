import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";
import { HoursString } from "./labor";

/**
 * PAYROLL AND COMMISSION
 *
 * The timesheet publishes hours. This publishes the two things that come after
 * them: what a bureau is actually sent, and what a technician is owed on top
 * of their hours.
 *
 * THE SHAPE OF THE PROMISE. An export is a FILE, so the route returns the
 * bytes and a checksum over them rather than a link to something generated
 * later: a payroll file that exists only behind a URL is a payroll file that
 * can change between being produced and being fetched, and nothing on either
 * copy says which one went to the bureau. The checksum is the testable form of
 * the claim that running it twice gives the same answer.
 *
 * A COMMISSION IS A LIABILITY. Settling one posts an expense and a liability
 * to the ledger; paying it is a different endpoint that clears the liability
 * against cash. There is deliberately no field anywhere below that marks a
 * commission paid without moving money, because that is the shape that leaves
 * a company's accounts never showing what it owes its own people.
 *
 * EVERY BASIS CARRIES WHAT IT IS WRONG ABOUT, published on
 * `GET /v1/commissions/bases` and repeated on every plan. A commission plan is
 * the most powerful instruction a contractor ever gives a technician and it is
 * usually given in about ninety seconds; the sentence that would have changed
 * their mind has to be on the screen where the choice is made.
 */

export const CommissionBasis = z.enum([
  "percent_of_revenue", "percent_of_gross_margin", "flat_per_job", "percent_of_collected",
]);

export const CommissionBasisSpec = z.object({
  key: CommissionBasis,
  label: z.string(),
  meaning: z.string(),
  /** Required, never optional. See the note at the top of this file. */
  wrongAbout: z.string(),
  needs: z.enum(["rate", "flat"]),
});

export const listCommissionBases = defineRoute({
  method: "get",
  path: "/v1/commissions/bases",
  summary: "The four bases, each with what it is wrong about",
  description:
    "A percentage of revenue rewards selling the expensive option rather than the right one. A percentage of margin rewards the profitable one and depends on a cost nobody has in the driveway. A flat amount rewards volume and nothing else. A percentage of what was collected puts the technician's pay behind the office's collections. There is no default and this endpoint is why.",
  module: "M17",
  permissions: ["commission:read"],
  input: z.object({}),
  output: z.object({ bases: z.array(CommissionBasisSpec) }),
});

export const CommissionPlan = z.object({
  id: Uuid,
  label: z.string(),
  basis: CommissionBasis,
  /** "0.08" is eight per cent. Null on a flat plan, never zero: zero is a claim. */
  rate: RateString.nullable(),
  flatAmount: MoneyString.nullable(),
  /** What a technician is shown when they ask how the number was worked out. */
  note: z.string(),
  active: z.boolean(),
  wrongAbout: z.string(),
});

export const listCommissionPlans = defineRoute({
  method: "get",
  path: "/v1/commissions/plans",
  summary: "Every plan this company has declared",
  module: "M17",
  permissions: ["commission:read"],
  input: z.object({}),
  output: z.object({ plans: z.array(CommissionPlan) }),
});

export const declareCommissionPlan = defineRoute({
  method: "post",
  path: "/v1/commissions/plans",
  summary: "Declare a commission plan",
  description:
    "Superseded rather than edited, the same way an overtime policy is: a plan that can be edited reprices commissions that have already been earned and, downward, already been paid. The note is required, because core refuses to compute a commission under a plan that cannot explain itself to the person being paid.",
  module: "M17",
  permissions: ["commission:configure"],
  idempotent: true,
  input: z.object({
    label: z.string().min(1).max(200),
    basis: CommissionBasis,
    rate: RateString.optional(),
    flatAmount: MoneyString.optional(),
    note: z.string().min(1).max(2000),
  }),
  output: CommissionPlan,
});

export const deactivateCommissionPlan = defineRoute({
  method: "post",
  path: "/v1/commissions/plans/deactivate",
  summary: "Stop using a plan without destroying what was earned under it",
  module: "M17",
  permissions: ["commission:configure"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: CommissionPlan,
});

export const CommissionPart = z.object({
  technicianId: Uuid,
  weight: RateString,
  amount: MoneyString,
  /** How this number was worked out, in a sentence the person paid can check. */
  explanation: z.string(),
});

export const settleCommission = defineRoute({
  method: "post",
  path: "/v1/commissions",
  summary: "Earn the commission on an invoice",
  description:
    "Once per invoice, enforced by a unique index: settling twice pays twice and carries the liability twice, and the only symptom is a job appearing in two payroll runs. Revenue is net of tax and of discount, because commission on the tax line pays a technician a share of money owed to a jurisdiction. A margin plan is refused when the job has no cost recorded rather than treating the unknown cost as zero. A collected plan is refused until the invoice is paid in full.",
  module: "M17",
  permissions: ["commission:configure"],
  idempotent: true,
  input: z.object({
    invoiceId: Uuid,
    /** Omitted when the company runs exactly one active plan. Two active plans refuses rather than guessing. */
    planId: Uuid.optional(),
    /**
     * Weights, not percentages: "2" and "1" is a two thirds, one third split.
     * Omitted to split evenly between the technicians assigned to the job.
     */
    shares: z.array(z.object({
      technicianId: Uuid,
      weight: RateString,
    })).min(1).optional(),
    /**
     * When it was earned. Defaults to now, and is refused into a pay period
     * that has already been closed and run.
     */
    occurredAt: z.string().datetime().optional(),
  }),
  output: z.object({
    id: Uuid,
    invoiceId: Uuid,
    planId: Uuid.nullable(),
    basis: CommissionBasis,
    revenue: MoneyString,
    /** Null when the job has no cost recorded. Not zero: zero is a claim about profit. */
    cost: MoneyString.nullable(),
    total: MoneyString,
    explanation: z.string(),
    occurredAt: z.string().datetime(),
    /** Null only when the commission came to zero, which posts nothing. */
    ledgerTransactionId: Uuid.nullable(),
    parts: z.array(CommissionPart),
  }),
});

export const CreditReason = z.enum(["refund", "credit_note", "write_off", "callback"]);

export const reverseCommission = defineRoute({
  method: "post",
  path: "/v1/commissions/reversals",
  summary: "Take a commission back off when the money came back",
  description:
    "The commission is recomputed as though the cumulative credit had always applied and what has already been reversed is subtracted, rather than applying the rate to the credit: those are the same number for a plain percentage and are not the same number for anything with a floor, a tier or a margin. The credit may not exceed what the commission was earned on, and one cause reverses once, so a retry does not take the money off a technician twice. The reversal lands in the period the credit happened in, never the one the commission was paid in, because that period was paid and its tax was withheld and remitted on the amount shown.",
  module: "M17",
  permissions: ["commission:configure"],
  idempotent: true,
  input: z.object({
    invoiceId: Uuid,
    reason: CreditReason,
    /** How much of the net revenue came back off. */
    creditedRevenue: MoneyString,
    creditedCost: MoneyString.optional(),
    /** What caused it: "invoice.written_off", "payment.refunded". */
    causeType: z.string().min(1).max(100),
    causeId: Uuid,
  }),
  output: z.object({
    id: Uuid,
    eventId: Uuid,
    reason: CreditReason,
    creditedRevenue: MoneyString,
    /** Negative. What comes back off, in total. */
    total: MoneyString,
    occurredAt: z.string().datetime(),
    explanation: z.string(),
    ledgerTransactionId: Uuid.nullable(),
    lines: z.array(z.object({
      technicianId: Uuid,
      amount: MoneyString,
      explanation: z.string(),
    })),
  }),
});

export const listCommissionEarnings = defineRoute({
  method: "get",
  path: "/v1/commissions",
  summary: "What has been earned, what came back, and what is still owed",
  description:
    "`owed` is the figure that should agree with the commission payable balance in the ledger. The two are computed from different rows by different code, which is the only way the agreement means anything.",
  module: "M17",
  permissions: ["commission:read"],
  input: z.object({
    technicianId: Uuid.optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  output: z.object({
    entries: z.array(z.object({
      id: Uuid,
      technicianId: Uuid,
      technicianName: z.string(),
      invoiceId: Uuid,
      invoiceNumber: z.number().int(),
      kind: z.enum(["earned", "reversed"]),
      amount: MoneyString,
      explanation: z.string(),
      occurredAt: z.string().datetime(),
      paidAt: z.string().datetime().nullable(),
    })),
    earned: MoneyString,
    reversed: MoneyString,
    owed: MoneyString,
    net: MoneyString,
  }),
});

/* --------------------------------------------------------- pay periods */

export const PayPeriod = z.object({
  id: Uuid,
  label: z.string(),
  startDate: z.string().date(),
  weeks: z.number().int(),
  /** Null while the period is open. A reopened close reads as null. */
  closedAt: z.string().datetime().nullable(),
  note: z.string().nullable(),
});

export const declarePayPeriod = defineRoute({
  method: "post",
  path: "/v1/payroll/periods",
  summary: "Declare a pay period",
  description:
    "A start date and a number of whole workweeks, never two instants. Overtime is measured over a workweek and only over a workweek, so a period that cuts one in half cannot be settled: half the hours that decide whether Thursday was overtime are in the other period, which may already be closed and paid. Semimonthly periods do exactly that and are refused rather than half supported. Overlapping periods are refused too, because two periods covering one Tuesday export that Tuesday twice.",
  module: "M17",
  permissions: ["payroll:configure"],
  idempotent: true,
  input: z.object({
    label: z.string().min(1).max(200),
    /** Must fall on the workweek boundary the overtime policy declares. */
    startDate: z.string().date(),
    weeks: z.number().int().min(1).max(8),
  }),
  output: z.object({
    id: Uuid,
    label: z.string(),
    startDate: z.string().date(),
    weeks: z.number().int(),
    periodStart: z.string().datetime(),
    /** Derived with the policy's zone, so a week containing a clock change is 167 or 169 hours. */
    periodEnd: z.string().datetime(),
  }),
});

export const listPayPeriods = defineRoute({
  method: "get",
  path: "/v1/payroll/periods",
  summary: "Every pay period, newest first",
  module: "M17",
  permissions: ["payroll:read"],
  input: z.object({}),
  output: z.object({ periods: z.array(PayPeriod) }),
});

export const closePayPeriod = defineRoute({
  method: "post",
  path: "/v1/payroll/periods/close",
  summary: "Close a period so it can be exported",
  description:
    "Refused while a punch inside the period is still open, because an open punch is not zero hours: somebody forgot to clock out and has worked them. Refused before the period has finished, because closing one freezes hours still being worked. The close records a fingerprint over every punch and commission line inside the period, and the export refuses when it has moved, which is what makes an edit after a close visible rather than a quietly different file.",
  module: "M17",
  permissions: ["payroll:export"],
  idempotent: true,
  input: z.object({
    periodId: Uuid,
    /** Why, in the closer's own words. "Sent to the bureau 2026-03-16." */
    note: z.string().max(2000).optional(),
  }),
  output: z.object({
    periodId: Uuid,
    closeId: Uuid,
    label: z.string(),
    closedAt: z.string().datetime(),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
  }),
});

export const reopenPayPeriod = defineRoute({
  method: "post",
  path: "/v1/payroll/periods/reopen",
  summary: "Reopen a closed period",
  description:
    "Possible, and deliberately the same permission as closing. A period closed by mistake that cannot be reopened is not a control, it is an obstacle, and people get around obstacles by back-dating punches into a period that is still open, which is worse and leaves no trace. The reason is required, and the close row stays on the record marked reopened.",
  module: "M17",
  permissions: ["payroll:export"],
  idempotent: true,
  input: z.object({
    periodId: Uuid,
    reason: z.string().min(1).max(2000),
  }),
  output: z.object({
    periodId: Uuid,
    closeId: Uuid,
    reopenedAt: z.string().datetime().nullable(),
  }),
});

export const RegisterLine = z.object({
  /** regular, overtime, double_time, on_call, salary, commission, commission_clawback. */
  kind: z.string(),
  label: z.string(),
  explanation: z.string(),
  hours: HoursString.nullable(),
  rate: MoneyString.nullable(),
  amount: MoneyString,
});

export const getPayrollRegister = defineRoute({
  method: "get",
  path: "/v1/payroll/register",
  summary: "What every person is owed for a period, and why",
  description:
    "Derived on read, never stored: a stored overtime total is a number somebody can edit, and a payroll figure nobody can explain is worse than a wrong one. Hours are paid at the BASE rate frozen onto each punch rather than the loaded rate, because the fringe is a contribution to a fund and paying it as wages hands a technician their own pension money. People who cannot be assembled come back under `problems` rather than as an error, so the screen shows all of them at once; the export refuses on any of them.",
  module: "M17",
  permissions: ["payroll:read"],
  input: z.object({ periodId: Uuid }),
  output: z.object({
    periodId: Uuid,
    label: z.string(),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    closedAt: z.string().datetime().nullable(),
    rows: z.array(z.object({
      technicianId: Uuid,
      technicianName: z.string(),
      classification: z.string().nullable(),
      lines: z.array(RegisterLine),
      gross: MoneyString,
      /** What a reversal could not take out of this period without the statement going negative. */
      carriedForward: MoneyString,
      warnings: z.array(z.string()),
    })),
    problems: z.array(z.object({
      technicianId: Uuid,
      technicianName: z.string(),
      messages: z.array(z.string()),
    })),
    grossTotal: MoneyString,
  }),
});

export const exportPayPeriod = defineRoute({
  method: "post",
  path: "/v1/payroll/exports",
  summary: "Produce the payroll file for a closed period",
  description:
    "CSV, and only CSV: every bureau takes one, no vendor has to approve it, and a self hoster can open it. One row per employee per pay category, because regular, overtime and double time are taxed and reported differently in enough places that collapsing them makes the file useless for what it is for. Reproducible by construction: the clock handed to the statement builder is the instant of the close, so running it twice produces the same bytes and the same checksum.",
  module: "M17",
  permissions: ["payroll:export"],
  idempotent: true,
  input: z.object({
    periodId: Uuid,
    format: z.literal("csv").optional(),
  }),
  output: z.object({
    periodId: Uuid,
    closeId: Uuid,
    format: z.string(),
    /** The file itself. */
    content: z.string(),
    /** sha256 of the content. The same close always produces the same value. */
    checksum: z.string(),
    rowCount: z.number().int(),
    grossTotal: MoneyString,
    generatedAt: z.string().datetime(),
    /** True when this period has been exported before, so a duplicate file is visible as one. */
    previouslyExported: z.boolean(),
  }),
});

export const listPayrollExports = defineRoute({
  method: "get",
  path: "/v1/payroll/exports",
  summary: "Every export that has left the building",
  description:
    "Which file was sent, when, and what was in it. The first question when a technician says their cheque is wrong.",
  module: "M17",
  permissions: ["payroll:read"],
  input: z.object({ periodId: Uuid }),
  output: z.object({
    exports: z.array(z.object({
      id: Uuid,
      closeId: Uuid,
      format: z.string(),
      rowCount: z.number().int(),
      grossTotal: MoneyString,
      checksum: z.string(),
      generatedAt: z.string().datetime(),
    })),
  }),
});

export const payCommissions = defineRoute({
  method: "post",
  path: "/v1/payroll/commission-payments",
  summary: "Clear the commission liability against cash",
  description:
    "A different event from earning it. Earning posted an expense and a liability; this discharges the liability and expenses nothing, because recognising the expense again at payout would double the cost of every job. Everything owed up to the end of the period is paid, not only what was earned inside it, so a commission earned in a fortnight nobody declared a period for does not sit outside every window forever. A person whose net is negative is skipped and named rather than handed a negative cheque.",
  module: "M17",
  permissions: ["payroll:export"],
  idempotent: true,
  input: z.object({ periodId: Uuid }),
  output: z.object({
    periodId: Uuid,
    paidAt: z.string().datetime(),
    total: MoneyString,
    /** Null when nothing was owed, because a posting with no entries is not a posting. */
    ledgerTransactionId: Uuid.nullable(),
    people: z.array(z.object({
      technicianId: Uuid,
      amount: MoneyString,
      includesEarlierPeriods: z.boolean(),
    })),
    carried: z.array(z.object({
      technicianId: Uuid,
      amount: MoneyString,
    })),
  }),
});

/* ------------------------------------------- a technician's own timeclock */

export const getMyTimeclock = defineRoute({
  method: "get",
  path: "/v1/timeclock/me",
  summary: "The caller's own hours this week, and whether they are still clocked in",
  description:
    "Scoped to the session and takes no technician id, deliberately: an endpoint that took one under this permission would let any technician read any other technician's hours. No rate is returned, because what a shift was paid at reads under payroll:read and this permission is not that one.",
  module: "M17",
  permissions: ["timeclock:own"],
  input: z.object({
    /** Any date in the week. Defaults to today in the company's zone. */
    weekOf: z.string().date().optional(),
  }),
  output: z.object({
    technicianId: Uuid,
    technicianName: z.string(),
    weekStart: z.string().date(),
    regularHours: HoursString,
    overtimeHours: HoursString,
    doubleTimeHours: HoursString,
    /** Null when they are not clocked in, which is what this screen is opened to find out. */
    openSince: z.string().datetime().nullable(),
    entries: z.array(z.object({
      id: Uuid,
      kind: z.string(),
      jobId: Uuid.nullable(),
      startedAt: z.string().datetime(),
      endedAt: z.string().datetime().nullable(),
      minutes: z.number().int().nullable(),
      approvedAt: z.string().datetime().nullable(),
    })),
  }),
});

export const payrollRoutes = {
  listCommissionBases, listCommissionPlans, declareCommissionPlan, deactivateCommissionPlan,
  settleCommission, reverseCommission, listCommissionEarnings,
  declarePayPeriod, listPayPeriods, closePayPeriod, reopenPayPeriod,
  getPayrollRegister, exportPayPeriod, listPayrollExports, payCommissions,
  getMyTimeclock,
} as const;
