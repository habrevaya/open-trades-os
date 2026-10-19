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

/* ------------------------------------------- an item's own rate, the choice */

export const ItemRateRule = z.enum(["plan_only", "item_wins", "higher", "item_adds"]);

const ItemRuleView = z.object({
  rule: ItemRateRule,
  /** Each choice with the sentence the screen shows beside it, the plan only first. */
  rules: z.array(z.object({ rule: ItemRateRule, label: z.string(), meaning: z.string() })),
});

/** One invoice line as a commission read it, and what it paid. Empty under the plan only. */
export const CommissionLine = z.object({
  invoiceLineId: Uuid,
  label: z.string(),
  net: MoneyString,
  /** The price book version the line was priced from, and the rate that version carried. */
  priceBookItemVersionId: Uuid.nullable(),
  itemRate: RateString.nullable(),
  planPart: MoneyString,
  itemPart: MoneyString.nullable(),
  paid: MoneyString,
  source: z.enum(["plan", "item", "plan_and_item"]),
});

export const getCommissionItemRule = defineRoute({
  method: "get",
  path: "/v1/commissions/item-rule",
  summary: "How an item's own commission rate and the plan combine on a line",
  description:
    "The company's choice, one for everybody. `plan_only` (the default): an item's own rate is kept on the item and pays nothing. `item_wins`: a line priced from an item with its own rate pays that rate instead of the plan. `higher`: such a line pays the item's rate or the plan, whichever comes to more. `item_adds`: such a line pays the item's rate on top of the plan. The plan's part of a line is its rate on what the line charged for a percentage of revenue, and the line's share of the plan's figure by what it charged for any other plan.",
  module: "M17",
  permissions: ["commission:read"],
  input: z.object({}),
  output: ItemRuleView,
});

export const setCommissionItemRule = defineRoute({
  method: "post",
  path: "/v1/commissions/item-rule",
  summary: "Choose how an item's own commission rate and the plan combine",
  description:
    "A statement about what people are paid, so `commission:configure`, and audited with the choice before and after. It applies to commissions settled from then on: each earning keeps the choice it was made under, so a change never reprices one already made, and a reversal recomputes under the choice the earning was made under. The rate read is the one on the price book version each line was priced from, never today's. Sent again with the same choice, it changes nothing.",
  module: "M17",
  permissions: ["commission:configure"],
  idempotent: true,
  input: z.object({ rule: ItemRateRule }),
  output: ItemRuleView,
});

/* ------------------------------------------ settling by itself when paid */

const OnPaymentView = z.object({
  on: z.boolean(),
  /** When it was turned on. Only invoices paid in full from then are settled by it. */
  since: z.string().datetime().nullable(),
  /** The plans in force that earn on payment. With none, it settles nothing. */
  earnsOnPayment: z.array(z.object({ id: Uuid, label: z.string() })),
  /** Invoices it left for a person, still without a commission, with why. */
  left: z.array(z.object({
    invoiceId: Uuid, invoiceNumber: z.string(), customerName: z.string(), reason: z.string(), at: z.string().datetime(),
  })),
  /** The last twenty it settled. */
  settled: z.array(z.object({
    invoiceId: Uuid, invoiceNumber: z.string(), customerName: z.string(), total: MoneyString, at: z.string().datetime(),
  })),
});

export const getCommissionOnPayment = defineRoute({
  method: "get",
  path: "/v1/commissions/settle-on-payment",
  summary: "Whether a commission settles by itself when its invoice is paid in full, and what it has done",
  description:
    "Off unless the company turned it on. When on, each invoice paid in full from then whose one plan in force pays on what was collected is settled by the worker with the split proposed between the people on the job (standing shares included), exactly as settling it as proposed from the split screen would, and audited as done by the system. One whose plan is not known (two plans in force), whose split would need a person (nobody on the job, standing shares that cannot all be honoured) or which settling refuses is left, and listed here with why until somebody settles it.",
  module: "M17",
  permissions: ["commission:read"],
  input: z.object({}),
  output: OnPaymentView,
});

export const setCommissionOnPayment = defineRoute({
  method: "post",
  path: "/v1/commissions/settle-on-payment",
  summary: "Turn settling a commission by itself on payment on or off",
  description:
    "`commission:configure`, audited with the setting before and after. It applies to invoices paid in full from the moment it is turned on, never to ones paid before. A refund or a void after it settled is handled as for any earning: nothing reverses by itself, and `POST /v1/commissions/reversals` takes it back. Sent again with the same setting, it changes nothing.",
  module: "M17",
  permissions: ["commission:configure"],
  idempotent: true,
  input: z.object({ on: z.boolean() }),
  output: OnPaymentView,
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
     * Omitted to take the split proposed between the technicians assigned to
     * the job: even, or shaped by their standing shares.
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
    /** The company's choice it was worked out under, frozen on the earning. */
    itemRule: ItemRateRule,
    /** What each line paid and why, when the choice read the lines. */
    lines: z.array(CommissionLine),
    occurredAt: z.string().datetime(),
    /** Null only when the commission came to zero, which posts nothing. */
    ledgerTransactionId: Uuid.nullable(),
    parts: z.array(CommissionPart),
  }),
});

/* ------------------------------------------- shared commission, from a screen */

const SettledSplit = z.object({
  eventId: Uuid,
  total: MoneyString,
  occurredAt: z.string().datetime(),
  /** The reason the office gave for a split other than the one proposed, or null. */
  splitNote: z.string().nullable(),
  /** The standing shares it was settled as proposed with, in words, or null. */
  standingNote: z.string().nullable(),
  /** How it was worked out, in the words the people paid read. */
  explanation: z.string(),
  itemRule: ItemRateRule,
  lines: z.array(CommissionLine),
  parts: z.array(z.object({ technicianId: Uuid, name: z.string(), weight: RateString.nullable(), amount: MoneyString })),
});

export const listSharedCommissions = defineRoute({
  method: "get",
  path: "/v1/commissions/shared",
  summary: "Commissions several people share: waiting to be settled, and the last ones settled",
  description:
    "Waiting: invoices sent or paid (not voided or written off) on a job more than one person was assigned to, made since the company's first commission plan, with no commission settled yet, newest first, fifty at most. Each waiting one carries the split proposed (even, or shaped by standing shares) worked out as settling it would be, or the refusal settling would give. Settled: the last twenty earnings paid to more than one person, each part with its weight, and the reason the office gave when it changed the proposed split.",
  module: "M17",
  permissions: ["commission:read"],
  input: z.object({}),
  output: z.object({
    waiting: z.array(z.object({
      invoiceId: Uuid, invoiceNumber: z.string(), status: z.string(), customerName: z.string(),
      jobNumber: z.string(), revenue: MoneyString, issuedAt: z.string().datetime(),
      people: z.array(z.object({ technicianId: Uuid, name: z.string() })),
      /** The split proposed, worked out as settling it would be, or the refusal settling would give. */
      proposed: z.object({
        total: MoneyString.nullable(),
        parts: z.array(z.object({ technicianId: Uuid, name: z.string(), amount: MoneyString })),
        standingSentence: z.string().nullable(),
        refusal: z.string().nullable(),
      }),
    })),
    settled: z.array(z.object({
      invoiceId: Uuid, invoiceNumber: z.string(), total: MoneyString, occurredAt: z.string().datetime(),
      splitNote: z.string().nullable(),
      standingNote: z.string().nullable(),
      parts: z.array(z.object({ technicianId: Uuid, name: z.string(), weight: RateString.nullable(), amount: MoneyString })),
    })),
  }),
});

/* ----------------------------------------- a standing share of shared commission */

export const StandingApplies = z.enum(["always", "as_lead"]);

const StandingShareView = z.object({
  id: Uuid,
  technicianId: Uuid,
  name: z.string(),
  /** Whole percent of a shared commission. */
  percent: z.number().int(),
  /** `always` whenever they are on the job's visits; `as_lead` only when they led one. */
  applies: StandingApplies,
  inWords: z.string(),
  reason: z.string(),
  setAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
});

export const listCommissionStandingShares = defineRoute({
  method: "get",
  path: "/v1/commissions/standing-shares",
  summary: "Standing shares of shared commission: in force, and the last ones stopped",
  description:
    "A standing share is a person who always takes the same part of a commission they share: the salesperson who always gets 30%, or a lead who gets 40% of the jobs they lead. When a shared commission is proposed, everybody on the job's visits with one that applies gets it and the rest is split evenly between the others. It only proposes: the office can change the split within the same rules, with a reason.",
  module: "M17",
  permissions: ["commission:read"],
  input: z.object({}),
  output: z.object({
    live: z.array(StandingShareView),
    ended: z.array(StandingShareView),
    /** Everybody who can be given one. */
    people: z.array(z.object({ technicianId: Uuid, name: z.string() })),
  }),
});

export const setCommissionStandingShare = defineRoute({
  method: "post",
  path: "/v1/commissions/standing-shares",
  summary: "Give somebody a standing share of the commissions they share",
  description:
    "A whole percent from 1 to 99, when it applies, and a reason the people sharing with them read on their pay statement. A share already in force for the same person is stopped, not edited, so what was proposed before can still be explained. Sent again with what is in force it answers with that. Commissions already settled are not touched.",
  module: "M17",
  permissions: ["commission:configure"],
  idempotent: true,
  input: z.object({
    technicianId: Uuid,
    percent: z.number().int(),
    applies: StandingApplies,
    reason: z.string().min(1).max(500),
  }),
  output: StandingShareView.extend({ replayed: z.boolean() }),
});

export const endCommissionStandingShare = defineRoute({
  method: "post",
  path: "/v1/commissions/standing-shares/{id}/end",
  summary: "Stop a standing share",
  description: "Proposals from now on leave it out. Commissions already settled keep the split they were settled with. Stopping one already stopped answers with it.",
  module: "M17",
  permissions: ["commission:configure"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: StandingShareView,
});

export const getCommissionSplit = defineRoute({
  method: "get",
  path: "/v1/commissions/split-proposal",
  summary: "How an invoice's commission would be shared, worked out before it is settled",
  description:
    "The split between the people on the job's visits is proposed (even, or shaped by the standing shares of the people on it, said in `standingSentence`), and core works out each person's part under the plan. With `shares` (`technicianId:weight` pairs separated by commas, weights not percentages: \"2\" and \"1\" is two thirds and one third), the split given instead, worked out the same way. What settling would refuse comes back as `refusal`, in the same words. `changed` says the split is not the one proposed, which settling from the split screen needs a reason for. Writes nothing.",
  module: "M17",
  permissions: ["commission:read"],
  input: z.object({
    invoiceId: Uuid,
    planId: Uuid.optional(),
    shares: z.string().max(2000).optional(),
  }),
  output: z.object({
    invoice: z.object({
      id: Uuid, number: z.string(), status: z.string(), customerName: z.string(),
      jobId: Uuid.nullable(), jobNumber: z.string().nullable(),
    }),
    plans: z.array(z.object({ id: Uuid, label: z.string() })),
    /** The company's other technicians, who can be added to the split. */
    others: z.array(z.object({ technicianId: Uuid, name: z.string() })),
    planId: Uuid.nullable(),
    planLabel: z.string().nullable(),
    revenue: MoneyString.nullable(),
    total: MoneyString.nullable(),
    explanation: z.string().nullable(),
    people: z.array(z.object({
      technicianId: Uuid, name: z.string(), onJob: z.boolean(),
      proposedWeight: RateString, weight: RateString,
      amount: MoneyString.nullable(), explanation: z.string().nullable(),
    })),
    changed: z.boolean(),
    /** The standing shares that shaped the proposal, empty when it is the even split. */
    standing: z.array(z.object({
      technicianId: Uuid, name: z.string(), percent: z.number().int(), applies: StandingApplies, reason: z.string(),
    })),
    /** The proposal in words when a standing share shaped it. */
    standingSentence: z.string().nullable(),
    /** Why standing shares on this job could not all be honoured, so the even split was proposed instead. */
    standingConflict: z.string().nullable(),
    refusal: z.string().nullable(),
    /** The company's choice now, or the one the earning was made under once settled, and what each line paid under it. */
    itemRule: ItemRateRule,
    itemRuleLabel: z.string(),
    lines: z.array(CommissionLine),
    settled: SettledSplit.nullable(),
  }),
});

export const settleCommissionSplit = defineRoute({
  method: "post",
  path: "/v1/commissions/splits",
  summary: "Settle a commission several people share, from the split screen",
  description:
    "The same settling as `POST /v1/commissions`, with one more rule: a split other than the one proposed (even between the people on the job, or shaped by their standing shares) needs `reason`, which is kept on the earning and written into each part's explanation, the sentence the person paid reads on their statement. A share of 0 leaves that person out. The plan's total is never changed here, only how it is divided. The audit records the split proposed beside the one settled. Sent again with the same split it answers with what was settled; a different split for an invoice that has already earned is refused.",
  module: "M17",
  permissions: ["commission:configure"],
  idempotent: true,
  input: z.object({
    invoiceId: Uuid,
    planId: Uuid.optional(),
    shares: z.array(z.object({ technicianId: Uuid, weight: RateString })).min(1).max(20),
    reason: z.string().max(500).optional(),
  }),
  output: z.object({
    id: Uuid, invoiceId: Uuid, total: MoneyString, splitNote: z.string().nullable(), replayed: z.boolean(),
  }),
});

export const settleCommissionSplitsAsProposed = defineRoute({
  method: "post",
  path: "/v1/commissions/splits/as-proposed",
  summary: "Settle several shared commissions at once, each with the split proposed",
  description:
    "For the invoices whose proposed split nobody changed. Each one is settled exactly as `POST /v1/commissions/splits` would settle it alone with the split proposed (even between the people on the job, or shaped by their standing shares) and no reason: in its own transaction, audited as one earning with the proposal beside it. One that settling would refuse (two plans in force and none named, a margin plan with no cost, a closed pay period, a standing share changed since the proposal was read) is listed in `refused` with the reason and does not stop the rest. Sent again, an invoice already settled with its proposed split answers with that earning (`replayed`).",
  module: "M17",
  permissions: ["commission:configure"],
  idempotent: true,
  input: z.object({
    invoiceIds: z.array(Uuid).min(1).max(50),
    /** The plan they are all settled under, when more than one is in force. */
    planId: Uuid.optional(),
  }),
  output: z.object({
    settled: z.array(z.object({
      invoiceId: Uuid, invoiceNumber: z.string().nullable(), eventId: Uuid.nullable(), total: MoneyString.nullable(),
      replayed: z.boolean(), refusal: z.string().nullable(),
    })),
    refused: z.array(z.object({
      invoiceId: Uuid, invoiceNumber: z.string().nullable(), eventId: Uuid.nullable(), total: MoneyString.nullable(),
      replayed: z.boolean(), refusal: z.string().nullable(),
    })),
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
      /** Which of the company's choices the earning behind it was made under. */
      itemRule: ItemRateRule,
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
  /**
   * regular, overtime, double_time, on_call, salary, commission, commission_clawback, tip, cash_tip,
   * and the two that are not wages: reimbursement and per_diem.
   */
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
      /**
       * Reimbursements and per diem, paid in full beside the gross: not wages,
       * so no tax is taken from them, and not in `gross` for that reason.
       */
      nonTaxable: MoneyString,
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
    /** Reimbursements and per diem across everybody, paid beside the gross. */
    reimbursementTotal: MoneyString,
  }),
});

export const exportPayPeriod = defineRoute({
  method: "post",
  path: "/v1/payroll/exports",
  summary: "Produce the payroll file for a closed period",
  description:
    "CSV, and only CSV: every bureau takes one, no vendor has to approve it, and a self hoster can open it. One row per employee per pay category, because regular, overtime and double time are taxed and reported differently in enough places that collapsing them makes the file useless for what it is for. What a person spent for the company and the office approved is a `reimbursement` row, and a day away at the company's rate is a `per_diem` row: both are paid in full with no tax taken, so they are not in `grossTotal` and are totalled in `reimbursementTotal`. Reproducible by construction: the clock handed to the statement builder is the instant of the close, so running it twice produces the same bytes and the same checksum.",
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
    /** What the file pays beside the gross with no tax taken: approved reimbursements and per diem. */
    reimbursementTotal: MoneyString,
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
      reimbursementTotal: MoneyString,
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

/**
 * PASSING TIPS ON.
 *
 * A tip a customer added when they paid is held as Tips payable from the
 * moment it arrives, split between the technicians on the job. It appears on
 * the register and the export for the period it arrived in, as its own line,
 * and this clears it: the liability is discharged against cash and nothing is
 * expensed, because a tip was never the company's money to spend.
 */
export const payTips = defineRoute({
  method: "post",
  path: "/v1/payroll/tip-payments",
  summary: "Clear the tips held for technicians against cash",
  description:
    "Every tip still owed that arrived before the end of the period, not only those inside it, so a tip from a fortnight nobody declared a period for is not owed for ever. The period has to be closed. Running it again pays nothing twice: a tip once paid is marked with the period that paid it.",
  module: "M17",
  permissions: ["payroll:export"],
  idempotent: true,
  input: z.object({ periodId: Uuid }),
  output: z.object({
    periodId: Uuid,
    paidAt: z.string().datetime(),
    total: MoneyString,
    ledgerTransactionId: Uuid.nullable(),
    people: z.array(z.object({
      technicianId: Uuid,
      amount: MoneyString,
      includesEarlierPeriods: z.boolean(),
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
  listSharedCommissions, getCommissionSplit, settleCommissionSplit,
  listCommissionStandingShares, setCommissionStandingShare, endCommissionStandingShare,
  settleCommissionSplitsAsProposed,
  getCommissionItemRule, setCommissionItemRule, getCommissionOnPayment, setCommissionOnPayment,
  declarePayPeriod, listPayPeriods, closePayPeriod, reopenPayPeriod,
  getPayrollRegister, exportPayPeriod, listPayrollExports, payCommissions, payTips,
  getMyTimeclock,
} as const;
