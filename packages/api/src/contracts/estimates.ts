import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString, PageRequest, pageOf, Timestamps, ExternalRef, ExternalLookup } from "./common";
import { CustomFieldListFilter } from "./custom-fields";

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
  /**
   * How much of `discountAmount` was member pricing, and which agreement it
   * came from. Computed by the server when the estimate is written, never
   * taken from the request: `discountAmount` on a line sent in is only what
   * somebody typed.
   */
  memberDiscountAmount: MoneyString.optional(),
  memberAgreementId: Uuid.nullable().optional(),
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
  /** The day it was written, in the company's calendar. */
  issuedOn: z.string().date().nullable(),
  expiresOn: z.string().date().nullable(),
  sentAt: z.string().datetime().nullable(),
  viewedAt: z.string().datetime().nullable(),
  decidedAt: z.string().datetime().nullable(),
  declineReason: z.string().nullable(),
  selectedOptionId: Uuid.nullable(),
  signerName: z.string().nullable(),
  currency: z.string().length(3),
  /**
   * The terms printed on the proposal, copied from the company's own when it
   * was written and never looked up again. Covered by the approval hash.
   */
  terms: z.string().nullable(),
  /** Presented most expensive first, with any recommended option pulled up. */
  options: z.array(EstimateOption),
  externalRef: ExternalRef.nullable(),
  /** The company's own fields (M29), by key. Saved with `PUT .../custom-fields`. */
  customFields: z.record(z.unknown()).optional(),
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
  /**
   * This line's own rate, where it differs from the estimate's `taxRate`: a
   * part taxed and labour not, or an estimate recorded from a system that
   * taxed per line. Omit to use the estimate's.
   */
  taxRate: RateString.optional(),
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
    "An option is a whole scope of work, not a discount tier: lines belong to the option, not to the estimate. " +
    "When the customer holds an active agreement at this property whose plan carries a discount, the member rate is taken off each eligible line on top of any discount sent, and each line says how much and which agreement.",
  module: "M07",
  permissions: ["estimate:write"],
  idempotent: true,
  input: z.object({
    /**
     * The source document's own number, kept for history. Needs
     * `data:import`. Refused if taken; the next number this company is given
     * is always past the highest one in use, imported or not.
     */
    number: z.number().int().min(1).max(2_000_000_000).optional(),
    /** Where this came from in another system. See `ExternalRef`. */
    externalRef: ExternalRef.optional(),
    customerId: Uuid,
    propertyId: Uuid,
    jobId: Uuid.optional(),
    title: z.string().max(200).optional(),
    /**
     * The day it was written. Omit for today. Earlier than a week back is
     * history and needs `data:import`; never in the future.
     */
    issuedOn: z.string().date().optional(),
    expiresOn: z.string().date().optional(),
    /**
     * This estimate's own terms. Omit to take the company's
     * (`GET /v1/proposal-terms`); an empty string prints none. An estimate
     * recorded from another system takes none unless it brings its own.
     */
    terms: z.string().max(10000).optional(),
    /**
     * How it ended, for an estimate brought from another system. Needs
     * `data:import`. Written as it was: no signature is recorded and no
     * `estimate.approved` or `estimate.declined` is emitted, so loading
     * history starts no automation. An approval names its option by position
     * in `options`, counting from nought; an expiry's date becomes the
     * expiry date when none is given.
     */
    outcome: z.object({
      status: z.enum(["approved", "declined", "expired"]),
      on: z.string().date(),
      chosenOption: z.number().int().min(0).max(4).optional(),
      signerName: z.string().max(200).optional(),
      reason: z.string().max(1000).optional(),
    }).optional(),
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
    /** Estimates on one branch's jobs. An estimate with no job is in no branch. */
    businessUnitId: Uuid.optional(),
    /** Find by where it came from. See `ExternalRef`. */
    ...ExternalLookup,
    ...CustomFieldListFilter,
  }),
  output: pageOf(Estimate.omit({ options: true, terms: true }).extend({
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
export const EstimateDelivery = z.object({
  id: Uuid,
  channel: z.enum(["email", "sms", "link"]),
  /** The address or number it went to. Null for a link handed over by hand. */
  destination: z.string().nullable(),
  /**
   * What became of it, read from the message every time rather than stored:
   * `queued`, `sent`, `delivered`, `bounced`, `failed`, `refused` (consent,
   * the suppression list or no sender, with `error` saying which in words),
   * `link_issued` for a link handed over, or `interrupted`.
   */
  state: z.enum(["interrupted", "refused", "link_issued", "queued", "sent", "delivered", "bounced", "failed"]),
  /** The email or text, which is also the line in the customer's conversation thread. */
  messageId: Uuid.nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const sendEstimate = defineRoute({
  method: "post",
  path: "/v1/estimates/{id}/send",
  summary: "Send an estimate to the customer",
  description:
    "`email` and `sms` compose the message, with the approval link, and queue it through the same consent and suppression checks as every other message, into the customer's conversation thread. `link` only issues the link, for handing over another way. A send the transport refuses (they replied STOP, no consent, no sender connected) is recorded with the reason and changes nothing else: the estimate keeps its status, any link the customer already holds still works, and `approvalUrl` is null. A send that goes withdraws every earlier link.",
  module: "M07",
  permissions: ["estimate:send", "portal:grant"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    channel: z.enum(["email", "sms", "link"]).default("email"),
    /** Defaults to the customer's own address or number. */
    to: z.string().max(320).optional(),
    /** A line from whoever is sending, above the link. */
    message: z.string().max(2000).optional(),
    /** How long the approval link stays live. */
    expiresInDays: z.number().int().min(1).max(365).default(30),
  }),
  output: z.object({
    estimate: Estimate,
    /**
     * The plaintext token exists exactly once, here. It is never stored, so
     * a refused send and a replayed request both return null.
     */
    approvalUrl: z.string().url().nullable(),
    expiresAt: z.string().datetime().nullable(),
    delivery: EstimateDelivery,
  }),
});

export const listEstimateDeliveries = defineRoute({
  method: "get",
  path: "/v1/estimates/{id}/deliveries",
  summary: "Every attempt to send an estimate, and what became of each",
  module: "M07",
  permissions: ["estimate:read"],
  input: z.object({ id: Uuid }),
  output: z.object({ deliveries: z.array(EstimateDelivery) }),
});

export const Proposal = z.object({
  company: z.object({
    name: z.string(),
    legalName: z.string().nullable(),
    /** The company's colour as a fill, the text colour that reads on it, and a darker one safe as text. */
    color: z.string().nullable(),
    on: z.string().nullable(),
    text: z.string().nullable(),
    hasLogo: z.boolean(),
    version: z.number().int(),
    timezone: z.string(),
  }),
  id: Uuid,
  number: z.number().int(),
  title: z.string().nullable(),
  status: EstimateStatus,
  issuedOn: z.string().date().nullable(),
  expiresOn: z.string().date().nullable(),
  decidedAt: z.string().datetime().nullable(),
  signerName: z.string().nullable(),
  selectedOptionId: Uuid.nullable(),
  customerName: z.string(),
  propertyAddress: z.string(),
  terms: z.string().nullable(),
  options: z.array(z.object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    /** Good, Better or Best by price when there are two or three options. */
    tier: z.enum(["Good", "Better", "Best"]).nullable(),
    isRecommended: z.boolean(),
    subtotal: MoneyString,
    discountTotal: MoneyString,
    taxTotal: MoneyString,
    total: MoneyString,
    optionalTotal: MoneyString,
    lines: z.array(z.object({
      id: Uuid,
      name: z.string(),
      description: z.string().nullable(),
      quantity: MoneyString,
      unitPrice: MoneyString,
      lineTotal: MoneyString,
      discountAmount: MoneyString,
      memberDiscountAmount: MoneyString,
      memberPlan: z.string().nullable(),
      isOptional: z.boolean(),
      isSelected: z.boolean(),
    })),
  })),
  /**
   * How it is laid out: the company's template as copied onto this estimate
   * when one was applied, or the fixed layout, the options then the terms.
   * Each section's words, the reviews the reviews section shows, and each
   * option's photographs by id (`/estimates/{id}/proposal/photos/{photoId}`
   * on the office's screen, `cover` for the cover).
   */
  layout: z.object({
    templateName: z.string().nullable(),
    cover: z.object({ headline: z.string(), intro: z.string().nullable(), photoKey: z.string().nullable() }).nullable(),
    sections: z.array(z.object({
      kind: z.enum(["options", "about", "warranty", "financing", "reviews", "terms", "custom"]),
      title: z.string(),
      body: z.string().nullable(),
      minRating: z.number().int().optional(),
      count: z.number().int().optional(),
      reviews: z.array(z.object({
        author: z.string().nullable(), rating: z.number().int(), body: z.string().nullable(), postedAt: z.string(),
      })).optional(),
    })),
    showOptionPhotos: z.boolean(),
    optionPhotos: z.record(z.array(z.object({ id: Uuid, storageKey: z.string(), contentType: z.string().nullable() }))),
  }),
});

export const getEstimateProposal = defineRoute({
  method: "get",
  path: "/v1/estimates/{id}/proposal",
  summary: "An estimate as the customer's proposal",
  description:
    "What the printed proposal shows, built from what a customer may see and nothing else: the company's name, colour and whether it has a logo, the options in the order the customer is shown them with Good, Better and Best named by price, each line with any member discount and the plan that gave it, the terms copied onto the estimate, and who signed and when. No cost and no margin, by construction rather than by redaction.",
  module: "M07",
  permissions: ["estimate:read"],
  input: z.object({ id: Uuid }),
  output: Proposal,
});

export const getProposalTerms = defineRoute({
  method: "get",
  path: "/v1/proposal-terms",
  summary: "The terms printed on every proposal",
  description: "Copied onto each estimate when it is written, so changing them never changes what a customer already signed.",
  module: "M07",
  permissions: ["estimate:read"],
  input: z.object({}),
  output: z.object({ terms: z.string().nullable() }),
});

export const setProposalTerms = defineRoute({
  method: "put",
  path: "/v1/proposal-terms",
  summary: "Set the terms printed on every proposal",
  description: "`settings:write`, because what every proposal promises is a company decision. An empty string prints none. Reaches estimates written from now on.",
  module: "M07",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ terms: z.string().max(10000) }),
  output: z.object({ terms: z.string().nullable() }),
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

/**
 * The pipeline a company can still close: sent, not approved or declined, and
 * not expired. At its own path because a literal beside `/v1/estimates/{id}`
 * is ambiguous.
 */
export const listUnsoldEstimates = defineRoute({
  method: "get",
  path: "/v1/unsold-estimates",
  summary: "Estimates sent and still waiting for an answer",
  description:
    "Oldest first by default, or largest first with `sort=value`. The value is the recommended option, or the largest when none is recommended, which is what the work is worth if the customer says yes; summing every option would count one job two or three times.",
  module: "M07",
  permissions: ["estimate:read"],
  input: z.object({
    sort: z.enum(["age", "value"]).default("age"),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  output: z.object({
    estimates: z.array(z.object({
      id: Uuid,
      number: z.number().int(),
      title: z.string().nullable(),
      customerId: Uuid,
      customerName: z.string(),
      status: EstimateStatus,
      sentAt: z.string().datetime(),
      viewedAt: z.string().datetime().nullable(),
      /** Whole days since it went out. */
      ageDays: z.number().int(),
      value: MoneyString,
    })),
  }),
});

export const estimateRoutes = {
  listUnsoldEstimates, listEstimateDeliveries, getProposalTerms, setProposalTerms, getEstimateProposal,
  createEstimate, getEstimate, listEstimates, sendEstimate,
  approveEstimate, declineEstimate, convertEstimate,
  requestDeposit, applyDeposit, refundDeposit,
} as const;
