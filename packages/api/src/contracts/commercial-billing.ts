import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";
import { CoverageSource, PartyRole } from "./jobs";

/**
 * BILLING COMMERCIAL AND WARRANTY WORK
 *
 * The routes that make a client's rate card the price authority, a
 * contract's clocks visible, a job billable to two payers at once, a claim
 * on a third party its own document, and a payer's invoices deliverable as a
 * link or a file. The decisions are in core (`rates`, `splits`, `deadlines`,
 * `claims`); these are the doors.
 */

/* ------------------------------------------------------ rate card terms */

export const LabourBand = z.enum(["standard", "after_hours", "weekend", "holiday"]);

export const CardTerms = z.object({
  rateCardId: Uuid,
  name: z.string(),
  authority: z.string(),
  contractId: Uuid.nullable(),
  labourRates: z.array(z.object({
    id: Uuid,
    /** The trade, as the job type the work is booked under. Null for every kind of work. */
    jobTypeId: Uuid.nullable(),
    jobTypeName: z.string().nullable(),
    band: LabourBand,
    hourlyRate: MoneyString,
    minimumMinutes: z.number().int().nullable(),
    incrementMinutes: z.number().int().nullable(),
  })),
  /** Markup on our cost by cost band, lowest first. Fractions: 0.25 is twenty five per cent. */
  materialMarkup: z.array(z.object({ upToCost: MoneyString.nullable(), percent: RateString })),
  tripCharge: MoneyString.nullable(),
  /** 0 for Sunday to 6 for Saturday. */
  standardDays: z.array(z.number().int()),
  standardStartMinute: z.number().int(),
  standardEndMinute: z.number().int(),
  holidays: z.array(z.string().date()),
});

export const getRateCardTerms = defineRoute({
  method: "get",
  path: "/v1/rate-cards/{rateCardId}/terms",
  summary: "A card's rules beyond its item list",
  module: "M31",
  permissions: ["pricebook:read"],
  input: z.object({ rateCardId: Uuid }),
  output: CardTerms,
});

export const setRateCardTerms = defineRoute({
  method: "put",
  path: "/v1/rate-cards/{rateCardId}/terms",
  summary: "Set a card's labour rates, markup, trip charge and hours",
  description:
    "Replaces every rule at once, because a schedule arrives as a document and merging next year's into last year's keeps every rate the client dropped. A labour rate names a band (standard, after hours, weekend, holiday) and optionally the job type it is for; the more specific rate wins, and a band the card does not price falls back to a lower one, never a higher. Bands are the client's own hours, not the office's. Markup is a fraction of our cost per cost band. Every rule is checked before anything is written.",
  module: "M31",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    rateCardId: Uuid,
    labourRates: z.array(z.object({
      jobTypeId: Uuid.nullable().optional(),
      band: LabourBand,
      hourlyRate: MoneyString,
      minimumMinutes: z.number().int().min(0).max(1440).nullable().optional(),
      incrementMinutes: z.number().int().min(0).max(1440).nullable().optional(),
    })).max(200),
    materialMarkup: z.array(z.object({
      upToCost: MoneyString.nullable().optional(),
      percent: RateString,
    })).max(20),
    tripCharge: MoneyString.nullable().optional(),
    standardDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    standardStartMinute: z.number().int().min(0).max(1440).optional(),
    standardEndMinute: z.number().int().min(0).max(1440).optional(),
    holidays: z.array(z.string().date()).max(100).optional(),
  }),
  output: CardTerms,
});

/* ------------------------------------------------------- billing a job */

export const BillingLine = z.object({
  key: z.string(),
  jobLineId: Uuid.nullable(),
  priceBookItemId: Uuid.nullable(),
  name: z.string(),
  kind: z.string(),
  chargeKind: z.enum(["labour", "parts", "trip", "other"]),
  quantity: MoneyString,
  unitPrice: MoneyString,
  amount: MoneyString,
  /** Who priced it: a card's authority, `price_book`, or `entered`. */
  authority: z.string(),
  authorityLabel: z.string(),
  /** How: `card_line`, `labour_rate`, `material_markup`, `trip_charge`, `price_book`, `entered`. */
  basis: z.string(),
  note: z.string().nullable(),
  rateCardId: Uuid.nullable(),
  rateCardLineId: Uuid.nullable(),
  /** A card applies to this payer and none of its rules prices this line. */
  outOfScope: z.boolean(),
  taxable: z.boolean(),
  /** The rate this line is taxed at, as applied: the rate asked for on a taxable line, nought otherwise. */
  taxRate: RateString,
});

export const BillingPlan = z.object({
  jobId: Uuid,
  jobNumber: z.number().int(),
  basis: z.enum(["single", "coverage", "shares", "absorbed"]),
  coverage: z.object({ source: CoverageSource, label: z.string() }).nullable(),
  lines: z.array(BillingLine),
  payers: z.array(z.object({
    customerId: Uuid,
    name: z.string(),
    role: z.enum(["third_party", "customer", "share"]),
    /** Before tax. */
    total: MoneyString,
    /** The tax on this payer's parts, at each line's rate; nothing for a payer who is tax exempt. */
    taxTotal: MoneyString,
    /** What their invoice will ask for: `total` and `taxTotal`. */
    totalWithTax: MoneyString,
    taxExempt: z.boolean(),
    lines: z.array(z.object({ key: z.string(), amount: MoneyString, whole: z.boolean(), tax: MoneyString })),
    ceiling: z.object({ state: z.enum(["within", "over"]), held: z.boolean(), message: z.string().nullable() }).nullable(),
  })),
  pricedTotal: MoneyString,
  invoicedTotal: MoneyString,
  /** Covered by a plan or our own warranty, so billed to nobody. */
  absorbed: MoneyString,
  /** True when the payers' parts and what was absorbed come to the priced work exactly. */
  reconciles: z.boolean(),
  /**
   * The tax on everything invoiced, worked out on the whole and rounded once,
   * which the payers' `taxTotal`s add up to exactly.
   */
  taxTotal: MoneyString,
  outOfScope: z.number().int(),
  problems: z.array(z.string()),
  existing: z.array(z.object({
    id: Uuid, number: z.number().int(), customerName: z.string(), total: MoneyString, status: z.string(),
  })),
});

export const previewJobBilling = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}/billing",
  summary: "How a job would be billed, and to whom",
  description:
    "Every unbilled line on the job, plus a card's trip charge per visit made, each priced by the authority of whoever pays for it: their contract's card, a warranty network schedule or a manufacturer allowance, with our price book as the fallback. Then split between payers: a third party covering part of the work pays the covered work less the deductible and the customer the rest; payers named with shares pay their shares and the party billed the remainder. `problems` says what has to be decided before it can be billed. Nothing is written.",
  module: "M31",
  permissions: ["invoice:read"],
  input: z.object({
    id: Uuid,
    /**
     * The sales tax rate on the job's taxable lines, as a fraction: 0.0825.
     * Nought when left off, because the product does not decide a rate for
     * anybody (M13). Each payer is taxed on their own part of each taxable
     * line, a payer marked tax exempt on nothing.
     */
    taxRate: RateString.optional(),
  }),
  output: BillingPlan,
});

export const billJob = defineRoute({
  method: "post",
  path: "/v1/jobs/{id}/billing",
  summary: "Bill a job to whoever pays for it, one invoice per payer",
  description:
    "Writes exactly what the preview shows, as one invoice per payer in one transaction: every invoice or none. Each line keeps the authority that priced it; a line two payers share appears on both invoices with each payer's part. The invoices plus anything absorbed are checked to come to the priced work to the cent after they are written, and a mismatch keeps nothing. Refused while the preview lists a problem, with the problem as the reason. The job's authorisation is applied to the payer it belongs to, and each payer's contract limit to theirs. With a `taxRate`, each payer's invoice is taxed on that payer's part of each taxable line, and the tax across the invoices adds up to the tax on the whole job to the cent.",
  module: "M31",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({ id: Uuid, draft: z.boolean().optional(), taxRate: RateString.optional() }),
  output: z.object({
    jobId: Uuid,
    basis: z.enum(["single", "coverage", "shares", "absorbed"]),
    invoices: z.array(z.object({
      id: Uuid, number: z.number().int(), customerId: Uuid, customerName: z.string(),
      total: MoneyString, role: z.string(),
    })),
    pricedTotal: MoneyString,
    invoicedTotal: MoneyString,
    absorbed: MoneyString,
    taxTotal: MoneyString,
  }),
});

export const setJobContract = defineRoute({
  method: "put",
  path: "/v1/jobs/{id}/contract",
  summary: "Say which contract a job runs under",
  description:
    "Only a contract with somebody on the job. Its cards price the job and its clocks (respond, arrive, complete, invoice by, claim by) are raised on it at once. Null takes the contract off and cancels the clocks it started. A job with no contract named still runs under the contract of whoever pays, when they have one in force.",
  module: "M31",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, contractId: Uuid.nullable() }),
  output: z.object({ jobId: Uuid, contractId: Uuid.nullable(), priceSource: z.string() }),
});

export const JobClock = z.object({
  id: Uuid,
  kind: z.string(),
  label: z.string(),
  state: z.string(),
  dueAt: z.string().datetime(),
  satisfiedAt: z.string().datetime().nullable(),
  satisfiedByEvent: z.string().nullable(),
  breachedAt: z.string().datetime().nullable(),
  consequence: z.string().nullable(),
  standing: z.enum(["met", "met_late", "waived", "cancelled", "due", "overdue"]),
  minutesRemaining: z.number().int(),
});

export const listJobClocks = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}/deadlines",
  summary: "The deadlines a job carries, and how each stands",
  description:
    "The contract the job runs under, and every obligation on it: SLA clocks, the invoicing window, the claim deadline, and anything else raised against the job. Standing is worked out against the clock on read.",
  module: "M31",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    contract: z.object({ id: Uuid, name: z.string(), customerId: Uuid }).nullable(),
    named: z.boolean(),
    clocks: z.array(JobClock),
  }),
});

export const setJobParties = defineRoute({
  method: "put",
  path: "/v1/jobs/{id}/parties",
  summary: "Say who is involved in a job",
  description:
    "Replaces the whole cast. A payer with a share (a fraction, or an amount) splits the bill with whoever the job is billed to, who pays the rest. One bill-to party at most.",
  module: "M31",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    parties: z.array(z.object({
      role: PartyRole,
      customerId: Uuid.optional(),
      contactId: Uuid.optional(),
      externalName: z.string().max(200).optional(),
      externalReference: z.string().max(100).optional(),
      sharePercent: RateString.optional(),
      shareAmount: MoneyString.optional(),
      notes: z.string().max(1000).optional(),
    })).max(20),
  }),
  output: z.object({
    parties: z.array(z.object({
      id: Uuid, role: PartyRole, customerId: Uuid.nullable(), contactId: Uuid.nullable(),
      externalName: z.string().nullable(), externalReference: z.string().nullable(),
      sharePercent: RateString.nullable(), shareAmount: MoneyString.nullable(),
    })),
  }),
});

export const setJobCoverage = defineRoute({
  method: "put",
  path: "/v1/jobs/{id}/coverage",
  summary: "Say who is paying for a job, and why",
  description:
    "The source's defaults fill in what it covers, and anything the paperwork says differently overrides them. The customer's share under this coverage is taken off automatically when an invoice to them is raised. Null clears it.",
  module: "M32",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    source: CoverageSource.nullable(),
    externalReference: z.string().max(100).optional(),
    coversLabour: z.boolean().optional(),
    coversParts: z.boolean().optional(),
    coversTrip: z.boolean().optional(),
    coveragePercent: RateString.optional(),
    coverageLimit: MoneyString.optional(),
    customerResponsibility: MoneyString.optional(),
    notes: z.string().max(1000).optional(),
  }),
  output: z.object({
    source: CoverageSource.nullable(),
    coversLabour: z.boolean().nullable(),
    coversParts: z.boolean().nullable(),
    coversTrip: z.boolean().nullable(),
  }),
});

export const resolveCoverageFromEquipment = defineRoute({
  method: "post",
  path: "/v1/jobs/{id}/coverage/from-equipment",
  summary: "Read who is paying from the unit's warranty dates",
  description:
    "On the day of the first visit, not today: a repair done while the warranty was in force was covered, whenever it is invoiced. Parts and labour separately. Out of warranty is answered with `resolved: false` and nothing is written, because the office may know of an extension the dates do not.",
  module: "M32",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, equipmentId: Uuid.optional(), on: z.string().date().optional() }),
  output: z.object({
    resolved: z.boolean(),
    on: z.string().date(),
    source: CoverageSource.optional(),
    coversParts: z.boolean().optional(),
    coversLabour: z.boolean().optional(),
    note: z.string().optional(),
    reason: z.string().optional(),
  }),
});

/* --------------------------------------------------------------- claims */

export const ClaimStatus = z.enum(["submitted", "approved", "paid", "short_paid", "denied"]);

export const Claim = z.object({
  id: Uuid,
  jobId: Uuid,
  jobNumber: z.number().int(),
  invoiceId: Uuid,
  invoiceNumber: z.number().int(),
  invoiceBalance: MoneyString,
  payerCustomerId: Uuid,
  payerName: z.string(),
  source: CoverageSource,
  sourceLabel: z.string(),
  status: ClaimStatus,
  claimedAmount: MoneyString,
  approvedAmount: MoneyString.nullable(),
  paidAmount: MoneyString,
  outstanding: MoneyString,
  shortfall: MoneyString,
  externalReference: z.string().nullable(),
  submittedAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  paidAt: z.string().datetime().nullable(),
  decisionNote: z.string().nullable(),
});

export const listClaims = defineRoute({
  method: "get",
  path: "/v1/claims",
  summary: "Claims on third parties",
  module: "M32",
  permissions: ["invoice:read"],
  input: z.object({
    status: z.preprocess((v) => (typeof v === "string" ? v.split(",") : v), z.array(ClaimStatus)).optional(),
    jobId: Uuid.optional(),
  }),
  output: z.object({ claims: z.array(Claim) }),
});

export const getClaim = defineRoute({
  method: "get",
  path: "/v1/claims/{id}",
  summary: "One claim",
  module: "M32",
  permissions: ["invoice:read"],
  input: z.object({ id: Uuid }),
  output: Claim,
});

export const fileClaim = defineRoute({
  method: "post",
  path: "/v1/claims",
  summary: "File a claim on the invoice to whoever covers the work",
  description:
    "On an issued invoice addressed to the third party: a home warranty company, a manufacturer, a carrier. The invoice is the receivable; the claim is the conversation about it. Filing meets the claim deadline the contract set. One claim per invoice.",
  module: "M32",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({ invoiceId: Uuid, externalReference: z.string().max(100).optional() }),
  output: Claim,
});

export const decideClaim = defineRoute({
  method: "post",
  path: "/v1/claims/{id}/decision",
  summary: "Record what they decided",
  description:
    "Approved, for what was claimed or less, or denied with their reason. Never more than was claimed. A denial is final: an appeal is a new claim with their new reference.",
  module: "M32",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    outcome: z.enum(["approved", "denied"]),
    amount: MoneyString.optional(),
    note: z.string().max(1000).optional(),
    externalReference: z.string().max(100).optional(),
  }),
  output: Claim,
});

export const recordClaimPayment = defineRoute({
  method: "post",
  path: "/v1/claims/{id}/payments",
  summary: "Record money from them against a claim",
  description:
    "A real payment from the payer, applied to the claim's invoice. Paid when what they agreed has arrived, short paid when less has; more than they agreed is refused. A shortfall stays on the invoice for the office to chase or write off.",
  module: "M32",
  permissions: ["payment:collect", "invoice:read"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    amount: MoneyString,
    method: z.enum(["check", "ach", "card", "other"]),
    reference: z.string().max(100).optional(),
    receivedAt: z.string().datetime().optional(),
  }),
  output: Claim,
});

/* -------------------------------------------- delivery to a payer */

export const exportPayerInvoices = defineRoute({
  method: "post",
  path: "/v1/payers/{customerId}/invoice-export",
  summary: "A payer's open invoices as a CSV or XML file",
  description:
    "In the format their contract names, which wins over one asked for. One CSV row per invoice line, or one XML document in this product's own shape (not cXML, not EDI). Each invoice in the file is recorded as delivered. No network is contacted: the file is for a person to upload to the payer's system.",
  module: "M31",
  permissions: ["invoice:send"],
  idempotent: true,
  input: z.object({ customerId: Uuid, format: z.enum(["csv", "xml"]).optional() }),
  output: z.object({
    fileName: z.string(),
    contentType: z.string(),
    format: z.enum(["csv", "xml"]),
    body: z.string(),
    invoiceCount: z.number().int(),
  }),
});

export const issuePayerPortalLink = defineRoute({
  method: "post",
  path: "/v1/payers/{customerId}/portal-link",
  summary: "A link listing every invoice a payer owes",
  description:
    "Reaches this payer's invoices and nothing else: what is addressed to them or names them as payer, open first, then what they paid in the last year. Recorded against each open invoice as a link handed over.",
  module: "M31",
  permissions: ["portal:grant"],
  idempotent: true,
  input: z.object({ customerId: Uuid, expiresInDays: z.number().int().min(1).max(365).optional() }),
  output: z.object({ url: z.string().url(), expiresAt: z.string().datetime(), invoiceCount: z.number().int() }),
});

const PayerInvoiceLine = z.object({
  name: z.string(),
  description: z.string().nullable(),
  quantity: MoneyString,
  unitPrice: MoneyString,
  discountAmount: MoneyString,
  lineTotal: MoneyString,
  priceAuthority: z.string(),
  priceNote: z.string().nullable(),
});

export const viewPayerPortal = defineRoute({
  method: "get",
  path: "/v1/portal/payer",
  summary: "A payer's invoices, for the payer holding the link",
  description: "A read, so opening it every morning does not spend the link. Our cost is never selected.",
  module: "M31",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: z.string().min(20).max(200) }),
  output: z.object({
    organizationName: z.string(),
    payerName: z.string(),
    owed: MoneyString,
    invoices: z.array(z.object({
      number: z.number().int(),
      issuedOn: z.string().date().nullable(),
      dueOn: z.string().date().nullable(),
      purchaseOrderNumber: z.string().nullable(),
      jobNumber: z.number().int().nullable(),
      customerName: z.string(),
      siteAddress: z.string(),
      claimReference: z.string().nullable(),
      subtotal: MoneyString,
      discountTotal: MoneyString,
      taxTotal: MoneyString,
      total: MoneyString,
      amountPaid: MoneyString,
      balance: MoneyString,
      status: z.string(),
      lines: z.array(PayerInvoiceLine),
    })),
  }),
});

export const commercialBillingRoutes = {
  getRateCardTerms, setRateCardTerms,
  previewJobBilling, billJob, setJobContract, listJobClocks, setJobParties, setJobCoverage,
  resolveCoverageFromEquipment,
  listClaims, getClaim, fileClaim, decideClaim, recordClaimPayment,
  exportPayerInvoices, issuePayerPortalLink, viewPayerPortal,
} as const;
