import { z } from "zod";
import { defineRoute } from "../lib/define";
import { MoneyString, Uuid } from "./common";
import { Base64Bytes } from "./files";

/**
 * WHAT A PERSON PAID FOR THE COMPANY, A DAY AWAY, AND HOW BOTH ARE PAID BACK
 *
 * A person records what they paid with a photograph of the receipt and the job
 * it was for; the office approves or refuses it with a reason; an approved one
 * goes to the payroll bureau as a non-taxable `reimbursement` line in the pay
 * period it was approved in. A per diem is the company's flat rate for a day
 * away, recorded by the office against the job and exported as `per_diem`.
 *
 * NEITHER IS POSTED TO THE LEDGER. They are paid through payroll and counted in
 * the job's cost (M15).
 *
 * `/v1/me/expenses` takes no person: it is the signed in person's own, resolved
 * from the session, so there is no id to change to record on somebody else's pay.
 */

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date like 2026-11-01");
const DateTime = z.string().datetime();

const Receipt = z.object({
  fileName: z.string().min(1).max(255),
  /** What the caller thinks it is. Not believed: the type is decided from the bytes. */
  contentType: z.string().max(100).optional(),
  bytes: Base64Bytes,
});

const PaidIn = z.object({ id: Uuid, label: z.string(), closed: z.boolean() });

export const ExpenseView = z.object({
  id: Uuid,
  technicianId: Uuid,
  technicianName: z.string(),
  jobId: Uuid.nullable(),
  jobNumber: z.number().int().nullable(),
  amount: MoneyString,
  spentOn: IsoDate,
  description: z.string(),
  status: z.enum(["pending", "approved", "refused"]),
  recordedAt: DateTime,
  decidedAt: DateTime.nullable(),
  decidedByName: z.string().nullable(),
  decisionReason: z.string().nullable(),
  /** Photographs kept with it. */
  receipts: z.number().int(),
  /** For an approved one, the pay period it goes out in. Null when no pay period covers the day it was approved. */
  paidIn: PaidIn.nullable(),
});

export const PerDiemView = z.object({
  id: Uuid,
  technicianId: Uuid,
  technicianName: z.string(),
  jobId: Uuid,
  jobNumber: z.number().int(),
  day: IsoDate,
  amount: MoneyString,
  note: z.string().nullable(),
  paidIn: PaidIn.nullable(),
});

export const recordExpense = defineRoute({
  method: "post",
  path: "/v1/me/expenses",
  summary: "Record what you paid for the company",
  description:
    "The amount in dollars and cents, the day, what it was for, the job if there was one and a photograph of the receipt. Always the signed in person's own, and it waits for the office to approve it. `id` may be made by the caller (the phone does) and the same id sent again is the first one back, so a retry records it once. A receipt is a photograph or a PDF; the type is decided from the bytes. Not posted to the ledger: an approved one is paid through payroll as a non-taxable reimbursement.",
  module: "M17",
  permissions: ["expense:own"],
  idempotent: true,
  input: z.object({
    id: Uuid.optional(),
    jobId: Uuid.nullable().optional(),
    /** The job by its number, for a caller that does not have its id. Ignored when `jobId` is given. */
    jobNumber: z.number().int().positive().optional(),
    amount: z.string().max(20),
    spentOn: IsoDate,
    description: z.string().min(1).max(300),
    receipt: Receipt.optional(),
  }),
  output: ExpenseView,
});

export const addExpenseReceipt = defineRoute({
  method: "post",
  path: "/v1/me/expenses/{id}/receipts",
  summary: "Add a photograph of the receipt to one of your own",
  description: "Only while the office has not answered it. The same photograph twice is one receipt.",
  module: "M17",
  permissions: ["expense:own"],
  idempotent: true,
  input: z.object({ id: Uuid, receipt: Receipt }),
  output: z.object({ id: Uuid }),
});

export const listMyExpenses = defineRoute({
  method: "get",
  path: "/v1/me/expenses",
  summary: "What you recorded, what the office said, and the days away you were paid for",
  description:
    "The last four months, waiting ones first. `technician` is false for somebody with no place on the board, who has nobody to be paid back.",
  module: "M17",
  permissions: ["expense:own"],
  input: z.object({}),
  output: z.object({
    technician: z.boolean(),
    expenses: z.array(ExpenseView),
    perDiems: z.array(PerDiemView),
  }),
});

export const listExpenses = defineRoute({
  method: "get",
  path: "/v1/expenses",
  summary: "Everybody's expenses, waiting ones first",
  description:
    "For whoever approves them, narrowed to the people their timesheet scope reaches, so a branch manager sees their own branch's. `waiting` is how many are still to answer.",
  module: "M17",
  permissions: ["expense:approve"],
  input: z.object({
    status: z.enum(["pending", "approved", "refused"]).optional(),
    technicianId: Uuid.optional(),
    jobId: Uuid.optional(),
  }),
  output: z.object({
    expenses: z.array(ExpenseView),
    waiting: z.number().int(),
    /** The company's rate for a day away, or null when none is set. */
    perDiemRate: MoneyString.nullable(),
  }),
});

export const decideExpense = defineRoute({
  method: "post",
  path: "/v1/expenses/{id}/decision",
  summary: "Approve or refuse an expense",
  description:
    "A refusal needs a reason, which the person reads. An approved one goes to the payroll bureau as a non-taxable reimbursement line in the pay period the approval falls in. The same decision again answers with the first; the other decision is refused, because the payroll file is built from it. Not posted to the ledger.",
  module: "M17",
  permissions: ["expense:approve"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    decision: z.enum(["approve", "refuse"]),
    reason: z.string().max(500).nullable().optional(),
  }),
  output: ExpenseView,
});

export const recordPerDiem = defineRoute({
  method: "post",
  path: "/v1/per-diem",
  summary: "Record the company's rate for each day somebody was away on a job",
  description:
    "From the first day to the last, both included, at most 31. The rate is the company's current one (`POST /v1/payroll/pay-extras`) and is kept on each day, so a later change does not reprice it. A day that already has one for that person is left as it was and named in `alreadyHad`. A day inside a pay period that has been closed is refused. Paid through payroll as `per_diem`, with no tax taken, and counted in the job's cost.",
  module: "M17",
  permissions: ["expense:approve"],
  idempotent: true,
  input: z.object({
    technicianId: Uuid,
    /** The job they were away on, by id or by its number. One of the two. */
    jobId: Uuid.optional(),
    jobNumber: z.number().int().positive().optional(),
    from: IsoDate,
    to: IsoDate,
    note: z.string().max(300).nullable().optional(),
  }),
  output: z.object({
    recorded: z.array(IsoDate),
    alreadyHad: z.array(IsoDate),
    rate: MoneyString,
  }),
});

export const listPerDiem = defineRoute({
  method: "get",
  path: "/v1/per-diem",
  summary: "Days away that have been recorded",
  module: "M17",
  permissions: ["expense:approve"],
  input: z.object({
    technicianId: Uuid.optional(),
    jobId: Uuid.optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
  }),
  output: z.object({ perDiems: z.array(PerDiemView) }),
});

export const removePerDiem = defineRoute({
  method: "post",
  path: "/v1/per-diem/{id}/removal",
  summary: "Take a recorded day away back out",
  description: "For one recorded against the wrong person or job. Refused once the pay period it falls in has been closed.",
  module: "M17",
  permissions: ["expense:approve"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const getJobExpenses = defineRoute({
  method: "get",
  path: "/v1/jobs/{jobId}/expenses",
  summary: "What the company has agreed to pay people for one job",
  description:
    "Approved reimbursements and per diem days, and what they come to, which is part of the job's cost (M15). A cost, so `job.cost:read`.",
  module: "M15",
  permissions: ["job.cost:read"],
  input: z.object({ jobId: Uuid }),
  output: z.object({
    reimbursements: z.array(ExpenseView),
    perDiems: z.array(PerDiemView),
    total: MoneyString,
  }),
});

const TipSplitRule = z.enum(["even", "hours", "lead"]);

export const PayExtras = z.object({
  /** What a day away is worth, in dollars and cents. Null until somebody sets it, which pays none. */
  perDiemRate: MoneyString.nullable(),
  /** How a tip is shared between the people on the job it was left for, from the next tip on. */
  tipSplit: TipSplitRule,
  rules: z.array(z.object({ rule: TipSplitRule, label: z.string() })),
});

export const getPayExtras = defineRoute({
  method: "get",
  path: "/v1/payroll/pay-extras",
  summary: "The company's rate for a day away, and how tips are shared",
  module: "M17",
  permissions: ["timesheet:read"],
  input: z.object({}),
  output: PayExtras,
});

export const setPayExtras = defineRoute({
  method: "post",
  path: "/v1/payroll/pay-extras",
  summary: "Set the rate for a day away, or how tips are shared",
  description:
    "What is not named stays as it was. `perDiemRate` is dollars and cents, or null to stop paying one; it is kept on each day when the day is recorded, so a change does not reprice days already recorded. `tipSplit` is `even` (the default), `hours` (by the hours each person was clocked in on the job) or `lead` (all to the lead on the job's visits): it applies to tips from then on, because a tip is shared the moment it is paid and the rule is kept on each share; a rule with nothing to go on (no hours, no lead) shares evenly and says so on the share. A statement about what people are owed, so `payroll:configure`. A per diem is paid without tax taken from it, which is only right when it is within the rates the tax authority allows for the place and the day, and that is the company's to check.",
  module: "M17",
  permissions: ["payroll:configure"],
  idempotent: true,
  input: z.object({
    perDiemRate: z.string().max(20).nullable().optional(),
    tipSplit: TipSplitRule.optional(),
  }),
  output: PayExtras,
});

/* ------------------------------------------------------------- cash tips */

const CashTipView = z.object({
  id: Uuid,
  technicianId: Uuid,
  technicianName: z.string(),
  jobId: Uuid.nullable(),
  jobNumber: z.number().int().nullable(),
  amount: MoneyString,
  receivedAt: DateTime,
  /** The technician's own note, or for one the office recorded, why it did. */
  note: z.string().nullable(),
  /** Who put it on their pay: they did from the phone, or somebody in the office. */
  recordedBy: z.enum(["technician", "office"]),
  recordedByName: z.string().nullable(),
  /** Every change since it was recorded, oldest first. */
  corrections: z.array(z.object({
    previousAmount: MoneyString,
    newAmount: MoneyString,
    reason: z.string(),
    correctedByName: z.string().nullable(),
    at: DateTime,
  })),
});

export const recordCashTipFor = defineRoute({
  method: "post",
  path: "/v1/cash-tips",
  summary: "Put a cash tip a customer handed a technician on their pay",
  description:
    "For a tip the technician kept and did not record from the phone, which the office knows about because the customer said so. A reason is required and is shown to the technician. It is reported as pay (`cash_tip` on the register and the export, already in their hand) and nothing is booked, because the company never held it. Refused when the technician already has a tip of the same amount that day (a likely duplicate), and when the pay period it falls in has been closed. Narrowed to the people the caller's timesheet scope reaches.",
  module: "M17",
  permissions: ["tip:record"],
  idempotent: true,
  input: z.object({
    technicianId: Uuid,
    amount: z.string().max(20),
    /** The day it was handed over. Today when left out. */
    receivedOn: IsoDate.optional(),
    jobNumber: z.number().int().positive().optional(),
    reason: z.string().min(1).max(500),
  }),
  output: CashTipView,
});

export const correctCashTip = defineRoute({
  method: "post",
  path: "/v1/cash-tips/{id}/correction",
  summary: "Change what a cash tip was",
  description:
    "With a reason, which the technician reads beside the tip. The amounts before and after and who changed it are kept. An amount of 0 takes the tip off their pay. Refused when the pay period the tip falls in has been closed: reopen it first.",
  module: "M17",
  permissions: ["tip:record"],
  idempotent: true,
  input: z.object({ id: Uuid, amount: z.string().max(20), reason: z.string().min(1).max(500) }),
  output: CashTipView,
});

export const listCashTips = defineRoute({
  method: "get",
  path: "/v1/cash-tips",
  summary: "The cash tips on people's pay, with every change made to each",
  description: "The last four months, newest first, for the people the caller's timesheet scope reaches.",
  module: "M17",
  permissions: ["tip:record"],
  input: z.object({ technicianId: Uuid.optional() }),
  output: z.object({ tips: z.array(CashTipView) }),
});

export const listMyCashTips = defineRoute({
  method: "get",
  path: "/v1/me/cash-tips",
  summary: "Your own cash tips, whoever recorded them, and every change made to each",
  description: "The last four months. Takes no person: it is the signed in person's own. `technician` is false for somebody with no place on the board.",
  module: "M17",
  permissions: ["payroll:own"],
  input: z.object({}),
  output: z.object({ technician: z.boolean(), tips: z.array(CashTipView) }),
});

export const expenseRoutes = {
  recordExpense, addExpenseReceipt, listMyExpenses, listExpenses, decideExpense,
  recordPerDiem, listPerDiem, removePerDiem, getJobExpenses, getPayExtras, setPayExtras,
  recordCashTipFor, correctCashTip, listCashTips, listMyCashTips,
} as const;
