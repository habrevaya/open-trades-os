import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString, PageRequest, pageOf, Timestamps } from "./common";

export const EstimateStatus = z.enum([
  "draft", "sent", "viewed", "approved", "declined", "expired", "converted",
]);

export const EstimateLine = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  quantity: MoneyString,
  unitPrice: MoneyString,
  discountAmount: MoneyString,
  taxable: z.boolean(),
  /** The rate AS APPLIED, frozen on the line and carried onto the invoice. */
  taxRate: RateString,
  taxAmount: MoneyString,
  lineTotal: MoneyString,
  /** Priced and shown, outside the total until the customer ticks it. */
  isOptional: z.boolean(),
  isSelected: z.boolean(),
  sortOrder: z.number().int(),
  costCode: z.string().nullable(),
  priceBookItemVersionId: Uuid.nullable(),
  /** Redacted unless the caller holds pricebook.cost:read. */
  unitCost: MoneyString.nullable().optional(),
});

export const EstimateOption = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  isRecommended: z.boolean(),
  subtotal: MoneyString,
  taxTotal: MoneyString,
  total: MoneyString,
  /** The option with nothing optional ticked. */
  baseTotal: MoneyString,
  /** Everything offered under this option and not taken. The live upsell. */
  optionalTotal: MoneyString,
  lines: z.array(EstimateLine),
  /** Redacted unless the caller holds job.cost:read. */
  cost: MoneyString.nullable().optional(),
  margin: RateString.nullable().optional(),
});

export const Estimate = z.object({
  id: Uuid,
  number: z.number().int(),
  status: EstimateStatus,
  customerId: Uuid,
  propertyId: Uuid,
  jobId: Uuid.nullable(),
  title: z.string().nullable(),
  expiresOn: z.string().date().nullable(),
  sentAt: z.string().datetime().nullable(),
  viewedAt: z.string().datetime().nullable(),
  decidedAt: z.string().datetime().nullable(),
  declineReason: z.string().nullable(),
  selectedOptionId: Uuid.nullable(),
  signerName: z.string().nullable(),
  currency: z.string().length(3),
  /** Presented most expensive first, with any recommended option pulled up. */
  options: z.array(EstimateOption),
}).merge(Timestamps);

const LineInput = z.object({
  priceBookItemId: Uuid.optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  quantity: MoneyString.default("1"),
  unitPrice: MoneyString,
  unitCost: MoneyString.optional(),
  discountAmount: MoneyString.default("0"),
  taxable: z.boolean().default(true),
  isOptional: z.boolean().default(false),
  isSelected: z.boolean().default(false),
  costCode: z.string().max(50).optional(),
});

export const createEstimate = defineRoute({
  method: "post",
  path: "/v1/estimates",
  summary: "Create an estimate",
  description:
    "One estimate, one to three options. Totals are computed server side from the lines; a client supplied total is ignored. " +
    "An option is a whole scope of work, not a discount tier: lines belong to the option, not to the estimate.",
  module: "M07",
  permissions: ["estimate:write"],
  idempotent: true,
  input: z.object({
    customerId: Uuid,
    propertyId: Uuid,
    jobId: Uuid.optional(),
    title: z.string().max(200).optional(),
    expiresOn: z.string().date().optional(),
    taxRate: RateString.default("0"),
    options: z.array(z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(2000).optional(),
      isRecommended: z.boolean().default(false),
      lines: z.array(LineInput).min(1),
    })).min(1).max(5),
  }),
  output: Estimate,
});

export const getEstimate = defineRoute({
  method: "get",
  path: "/v1/estimates/{id}",
  summary: "Get an estimate",
  module: "M07",
  permissions: ["estimate:read"],
  input: z.object({ id: Uuid }),
  output: Estimate,
});

export const listEstimates = defineRoute({
  method: "get",
  path: "/v1/estimates",
  summary: "List estimates",
  module: "M07",
  permissions: ["estimate:read"],
  input: PageRequest.extend({
    status: z.array(EstimateStatus).optional(),
    customerId: Uuid.optional(),
    jobId: Uuid.optional(),
    /** Ages out the pipeline: everything sent and undecided before this date. */
    sentBefore: z.string().date().optional(),
  }),
  output: pageOf(Estimate.omit({ options: true }).extend({
    customerName: z.string(),
    total: MoneyString,
    optionCount: z.number().int(),
  })),
});

/**
 * Sending is a distinct operation from editing, and it does two things an
 * update does not: it freezes the document by hashing what was rendered, and
 * it issues the customer a scoped grant so they can approve without an
 * account. Both have to happen together or an approval cannot be tied to what
 * the customer actually saw.
 */
export const sendEstimate = defineRoute({
  method: "post",
  path: "/v1/estimates/{id}/send",
  summary: "Send an estimate to the customer",
  module: "M07",
  permissions: ["estimate:send", "portal:grant"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    channel: z.enum(["email", "sms", "link"]).default("email"),
    /** Defaults to the customer's own address or number. */
    to: z.string().max(320).optional(),
    message: z.string().max(2000).optional(),
    /** How long the approval link stays live. */
    expiresInDays: z.number().int().min(1).max(365).default(30),
  }),
  output: z.object({
    estimate: Estimate,
    /** The plaintext token exists exactly once, here. It is never stored. */
    approvalUrl: z.string().url(),
    expiresAt: z.string().datetime(),
  }),
});

/**
 * Approving on the customer's behalf, from the office or the driveway.
 *
 * Separate permission from `estimate:write` on purpose: recording that a
 * customer agreed to something is a different act from editing what they were
 * offered, and the people trusted to do the second are not always the people
 * trusted to do the first. The customer's own approval goes through
 * /v1/portal/estimates/{id}/approve instead, and carries a signature.
 */
export const approveEstimate = defineRoute({
  method: "post",
  path: "/v1/estimates/{id}/approve",
  summary: "Record an approval taken outside the portal",
  module: "M07",
  permissions: ["estimate:approve"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    optionId: Uuid,
    /** Which optional lines the customer took. */
    selectedLineIds: z.array(Uuid).default([]),
    signerName: z.string().min(1).max(200),
    /** How the customer actually said yes. Recorded, not inferred. */
    capturedVia: z.enum(["in_person", "phone", "email", "text"]),
    notes: z.string().max(2000).optional(),
  }),
  output: Estimate,
});

export const declineEstimate = defineRoute({
  method: "post",
  path: "/v1/estimates/{id}/decline",
  summary: "Record a decline",
  module: "M07",
  permissions: ["estimate:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    reason: z.string().max(1000).optional(),
  }),
  output: Estimate,
});

/**
 * Turning an approved option into work and a bill.
 *
 * The conversion is a copy, not a re-price. The frozen price book version and
 * the tax rate as applied travel onto the invoice unchanged, because an
 * invoice that disagrees with the approved quote is the fastest way to lose a
 * customer who was, a moment ago, happy.
 */
export const convertEstimate = defineRoute({
  method: "post",
  path: "/v1/estimates/{id}/convert",
  summary: "Convert an approved estimate into a job, an invoice, or both",
  module: "M07",
  permissions: ["estimate:write", "job:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    createJob: z.boolean().default(true),
    createInvoice: z.boolean().default(false),
    jobTypeId: Uuid.optional(),
    scheduledFor: z.string().date().optional(),
  }),
  output: z.object({
    estimate: Estimate,
    jobId: Uuid.nullable(),
    invoiceId: Uuid.nullable(),
    depositId: Uuid.nullable(),
  }),
});

export const DepositStatus = z.enum(["requested", "held", "applied", "refunded", "forfeited"]);

export const Deposit = z.object({
  id: Uuid,
  status: DepositStatus,
  customerId: Uuid,
  estimateId: Uuid.nullable(),
  jobId: Uuid.nullable(),
  appliedInvoiceId: Uuid.nullable(),
  currency: z.string().length(3),
  amountRequested: MoneyString,
  amountReceived: MoneyString,
  amountApplied: MoneyString,
  amountRefunded: MoneyString,
  percentOfTotal: RateString.nullable(),
  receivedAt: z.string().datetime().nullable(),
  appliedAt: z.string().datetime().nullable(),
}).merge(Timestamps);

export const requestDeposit = defineRoute({
  method: "post",
  path: "/v1/deposits",
  summary: "Ask for a deposit",
  description:
    "A deposit is money held against work not yet done. It is a liability from the moment it arrives and stays one until the work is performed.",
  module: "M13",
  permissions: ["deposit:collect"],
  idempotent: true,
  input: z.object({
    customerId: Uuid,
    estimateId: Uuid.optional(),
    jobId: Uuid.optional(),
    amount: MoneyString.optional(),
    percent: RateString.optional(),
    /** Ceiling, so a percentage on a large job stays reasonable. */
    maximum: MoneyString.optional(),
  }).refine((v) => (v.amount === undefined) !== (v.percent === undefined), {
    message: "Set an amount or a percent, not both and not neither",
  }),
  output: Deposit,
});

export const applyDeposit = defineRoute({
  method: "post",
  path: "/v1/deposits/{id}/apply",
  summary: "Apply a held deposit to an invoice",
  description:
    "Never more than the deposit has left and never more than the invoice is asking for. The remainder stays held against the next invoice on the job.",
  module: "M13",
  permissions: ["deposit:collect", "invoice:write"],
  idempotent: true,
  input: z.object({ id: Uuid, invoiceId: Uuid }),
  output: z.object({ deposit: Deposit, amountApplied: MoneyString }),
});

export const refundDeposit = defineRoute({
  method: "post",
  path: "/v1/deposits/{id}/refund",
  summary: "Return or forfeit a deposit",
  description:
    "A refund returns cash and touches no revenue, because nothing was sold. A forfeiture earns the money without moving cash. They are not the same posting.",
  module: "M13",
  permissions: ["deposit:refund"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    disposition: z.enum(["refund", "forfeit"]),
    amount: MoneyString.optional(),
    reason: z.string().max(1000).optional(),
  }),
  output: Deposit,
});

export const estimateRoutes = {
  createEstimate, getEstimate, listEstimates, sendEstimate,
  approveEstimate, declineEstimate, convertEstimate,
  requestDeposit, applyDeposit, refundDeposit,
} as const;
