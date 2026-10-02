import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString, PageRequest, pageOf, Timestamps, ExternalRef, ExternalLookup } from "./common";
import { CoverageSource } from "./jobs";

export const InvoiceStatus = z.enum(["draft", "open", "partially_paid", "paid", "void", "written_off"]);
export const PaymentMethod = z.enum(["card", "card_present", "ach", "cash", "check", "financing", "credit", "other"]);
export const LineOrigin = z.enum(["job", "delivery", "rental_period", "contract_schedule", "membership", "manual", "fee"]);

export const InvoiceLine = z.object({
  id: Uuid,
  origin: LineOrigin,
  name: z.string(),
  description: z.string().nullable(),
  quantity: MoneyString,
  unitPrice: MoneyString,
  discountAmount: MoneyString,
  taxable: z.boolean(),
  /** The rate AS APPLIED, frozen on the line. Never recomputed on read. */
  taxRate: RateString,
  taxAmount: MoneyString,
  lineTotal: MoneyString,
  costCode: z.string().nullable(),
  priceBookItemVersionId: Uuid.nullable(),
  /** Why this line is free or billed elsewhere. */
  coverageSource: CoverageSource.nullable(),
  /** Redacted unless the caller holds pricebook.cost:read. */
  unitCost: MoneyString.nullable().optional(),
});

export const Invoice = z.object({
  id: Uuid,
  number: z.number().int(),
  status: InvoiceStatus,
  customerId: Uuid,
  /** Frequently not the customer: a warranty company, a carrier, an owner. */
  payerCustomerId: Uuid.nullable(),
  payerExternalName: z.string().nullable(),
  jobId: Uuid.nullable(),
  purchaseOrderNumber: z.string().nullable(),
  issuedOn: z.string().date().nullable(),
  dueOn: z.string().date().nullable(),
  currency: z.string().length(3),
  subtotal: MoneyString,
  discountTotal: MoneyString,
  taxTotal: MoneyString,
  total: MoneyString,
  amountPaid: MoneyString,
  /** Taken off by credit notes. Never counted as paid. */
  amountCredited: MoneyString,
  balance: MoneyString,
  depositHeld: MoneyString,
  memo: z.string().nullable(),
  lines: z.array(InvoiceLine),
  externalRef: ExternalRef.nullable(),
}).merge(Timestamps);

/** A line as a caller writes it. Shared by a new invoice and a draft being edited. */
export const InvoiceLineInput = z.object({
  priceBookItemId: Uuid.optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  quantity: MoneyString.default("1"),
  unitPrice: MoneyString,
  discountAmount: MoneyString.default("0"),
  taxable: z.boolean().default(true),
  /**
   * The rate this line was taxed at by the system it came from, frozen on
   * the line as applied. Recording history only: needs `data:import`.
   * Today's tax is the server's to determine, never the caller's.
   */
  taxRate: RateString.optional(),
  /**
   * The tax that system charged on this line. Accepted only within
   * rounding of `taxRate` on the line's net (less than a cent away), so a
   * source that rounded per line keeps its cents and a made-up figure is
   * a 422. Needs `data:import`.
   */
  taxAmount: MoneyString.optional(),
  /**
   * Link the price book item and keep this line's own name, price and
   * taxability. Without it a linked line is re-priced from the item's
   * CURRENT version, which is right for a new invoice and rewrites what a
   * historical one charged. Needs `data:import`.
   */
  priceAsGiven: z.boolean().optional(),
  costCode: z.string().max(50).optional(),
  coverageSource: CoverageSource.optional(),
  /**
   * The job line this bills: a part or an hour recorded on the job. Marks it
   * billed, so the same capacitor cannot reach two invoices and "what is
   * still to invoice on this job" has an answer. Must be this invoice's
   * job's, unbilled, and billable.
   */
  jobLineId: Uuid.optional(),
});

export const createInvoice = defineRoute({
  method: "post",
  path: "/v1/invoices",
  summary: "Create an invoice",
  description:
    "From a job, or standalone. Totals are computed server side from the lines. A client's own totals are never used; sent as `expectedTotals` they are a cross check that refuses the invoice when they differ to the cent.",
  module: "M13",
  permissions: ["invoice:write"],
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
    payerCustomerId: Uuid.optional(),
    jobId: Uuid.optional(),
    purchaseOrderNumber: z.string().max(100).optional(),
    /**
     * The day the invoice was issued, in the company's calendar. Omit for
     * today. The ledger posting is dated by it, so revenue lands in the
     * period it was earned. Up to a week back is ordinary late entry; earlier
     * than that is recording history and needs `data:import`. Never in the
     * future, and never inside a closed period.
     */
    issuedOn: z.string().date().optional(),
    /**
     * Save it as a draft: numbered, editable, and nothing else. No posting,
     * nothing owed, the job not yet invoiced, and it cannot be sent or paid
     * until `POST /v1/invoices/{id}/issue`.
     */
    draft: z.boolean().optional(),
    dueOn: z.string().date().optional(),
    memo: z.string().max(2000).optional(),
    lines: z.array(InvoiceLineInput).min(1),
    /**
     * One invoice-level amount the lines do not account for: an
     * invoice-wide discount (negative) or a charge (positive). Becomes a
     * non-taxable `manual` line at the end, and a discount posts to contra
     * revenue like every other discount.
     */
    adjustment: z.object({
      name: z.string().min(1).max(200),
      amount: MoneyString,
    }).optional(),
    /**
     * What the caller expects the totals to be. A cross check, never an
     * input: the totals are computed here from the lines, and any that
     * differ from these to the cent refuse the invoice with a 422 naming
     * each one, rather than storing a document that disagrees with the one
     * the customer was sent.
     */
    expectedTotals: z.object({
      subtotal: MoneyString.optional(),
      discountTotal: MoneyString.optional(),
      taxTotal: MoneyString.optional(),
      total: MoneyString.optional(),
    }).optional(),
  }),
  output: Invoice,
});

export const listInvoices = defineRoute({
  method: "get",
  path: "/v1/invoices",
  summary: "List invoices",
  module: "M13",
  permissions: ["invoice:read"],
  input: PageRequest.extend({
    status: z.array(InvoiceStatus).optional(),
    customerId: Uuid.optional(),
    /** AR ages by PAYER. A commercial book is unreadable otherwise. */
    payerCustomerId: Uuid.optional(),
    jobId: Uuid.optional(),
    dueBefore: z.string().date().optional(),
    /** Find by where it came from. See `ExternalRef`. */
    ...ExternalLookup,
  }),
  output: pageOf(Invoice.omit({ lines: true }).extend({ customerName: z.string() })),
});

export const getInvoice = defineRoute({
  method: "get",
  path: "/v1/invoices/{id}",
  summary: "Get an invoice",
  module: "M13",
  permissions: ["invoice:read"],
  input: z.object({ id: Uuid }),
  output: Invoice,
});

/**
 * Recording a payment. The idempotency key is not optional and not advisory:
 * a retried request must be a no-op, never a second charge. The key is written
 * to `integration_event` BEFORE the processor call fires.
 */
export const recordPayment = defineRoute({
  method: "post",
  path: "/v1/payments",
  summary: "Record a payment",
  module: "M13",
  permissions: ["payment:collect"],
  idempotent: true,
  input: z.object({
    /** Where this came from in another system. See `ExternalRef`. */
    externalRef: ExternalRef.optional(),
    customerId: Uuid,
    method: PaymentMethod,
    amount: MoneyString,
    tipAmount: MoneyString.default("0"),
    /**
     * What the processor kept, when one was involved.
     *
     * The column and the ledger's fee leg have both existed since the first
     * migration and nothing ever fed either of them, so every card payment
     * posted its gross amount to cash. That overstates the bank by the fee on
     * every card the company has ever taken, and the difference is invisible
     * until somebody reconciles against a statement.
     *
     * Optional rather than defaulted, unlike `tipAmount` above, because a
     * default here would have to be applied by every internal caller that
     * does not go through the HTTP layer, and the honest shape of this field
     * is "a fee if there was one".
     */
    feeAmount: MoneyString.optional(),
    /** What was added for taking a card, where the company adds one. */
    surchargeAmount: MoneyString.optional(),
    /**
     * When the money arrived. Omit for now. The ledger posting is dated by
     * it, so cash lands in the period it was received rather than the period
     * somebody typed it in. Up to a week back is ordinary late entry; earlier
     * needs `data:import`. Never in the future, and never inside a closed
     * period.
     */
    receivedAt: z.string().datetime().optional(),
    checkNumber: z.string().max(50).optional(),
    notes: z.string().max(1000).optional(),
    /**
     * Which invoices this pays, and how much of each. Omit and the server
     * applies oldest balance first. Send an EMPTY list to apply it to
     * nothing: a deposit, or a customer paying ahead. Whatever is not
     * applied is held for the customer as a liability, returned as
     * `unappliedAmount`, and applied later through
     * `POST /v1/payments/{id}/apply`. A payment can span invoices and an
     * invoice can take many payments; getting this join right is what makes
     * a migration reconcile.
     */
    allocations: z.array(z.object({
      invoiceId: Uuid,
      amount: MoneyString,
    })).optional(),
    /** Stripe payment intent, when the card was taken through the platform. */
    processorPaymentId: z.string().max(200).optional(),
  }),
  output: z.object({
    id: Uuid,
    amount: MoneyString,
    allocations: z.array(z.object({ invoiceId: Uuid, amount: MoneyString })),
    /** Received and applied to nothing, held for the customer. */
    unappliedAmount: MoneyString,
    /** The balanced pair written to the ledger, so a caller can verify. */
    ledgerTransactionId: Uuid,
  }),
});

export const PaymentStatus = z.enum(["pending", "succeeded", "failed", "refunded", "partially_refunded", "disputed"]);

export const Payment = z.object({
  id: Uuid,
  customerId: Uuid,
  method: PaymentMethod,
  status: PaymentStatus,
  currency: z.string().length(3),
  amount: MoneyString,
  feeAmount: MoneyString,
  tipAmount: MoneyString,
  surchargeAmount: MoneyString,
  refundedAmount: MoneyString,
  processor: z.string(),
  processorPaymentId: z.string().nullable(),
  receivedAt: z.string().datetime(),
  checkNumber: z.string().nullable(),
  notes: z.string().nullable(),
  allocations: z.array(z.object({ invoiceId: Uuid, amount: MoneyString })),
  /** What arrived, less what is applied, less what was given back. */
  unappliedAmount: MoneyString,
  externalRef: ExternalRef.nullable(),
}).merge(Timestamps);

/**
 * Applying money held for a customer to their invoices.
 *
 * The other half of recording a payment with `allocations: []`. Without it a
 * deposit or a credit, once recorded, could never reach the invoice it was
 * for.
 */
export const applyPayment = defineRoute({
  method: "post",
  path: "/v1/payments/{id}/apply",
  summary: "Apply a customer's unapplied money to their invoices",
  description:
    "Never more than the payment still holds and never more than an invoice owes, and only to that customer's open invoices. Posted today: the liability it was held in is discharged against the receivable, and no cash moves.",
  module: "M13",
  permissions: ["payment:collect"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    allocations: z.array(z.object({ invoiceId: Uuid, amount: MoneyString })).min(1),
  }),
  output: Payment,
});

export const getArAging = defineRoute({
  method: "get",
  path: "/v1/reports/ar-aging",
  summary: "AR aging",
  description: "By payer rather than by customer, which is the only readable view on a commercial book.",
  module: "M13",
  permissions: ["invoice:read"],
  input: z.object({ asOf: z.string().date().optional() }),
  output: z.object({
    asOf: z.string().date(),
    buckets: z.array(z.object({
      payerId: Uuid.nullable(),
      payerName: z.string(),
      current: MoneyString,
      days1to30: MoneyString,
      days31to60: MoneyString,
      days61to90: MoneyString,
      over90: MoneyString,
      total: MoneyString,
    })),
    total: MoneyString,
  }),
});

/**
 * THE TWO WAYS AN INVOICE ENDS WITHOUT BEING PAID.
 *
 * `invoice_status` has carried `void` and `written_off` since it was
 * written, `InvoiceStatus` above publishes both, and nothing could reach
 * either. A company's only option for an invoice that was never going to be
 * paid was to leave it open, so receivables aged past a year and the AR
 * report kept counting money that did not exist.
 *
 * Two routes rather than one with a flag, because they are different acts
 * with different postings. A write off says the money is owed and will not
 * arrive: the receivable goes, the revenue stays, and a bad debt appears. A
 * void says the invoice should never have existed and reverses the original
 * posting line for line. Behind one parameter, the wrong one gets picked.
 */
export const voidInvoice = defineRoute({
  method: "post",
  path: "/v1/invoices/{id}/void",
  summary: "Void an invoice that should never have been raised",
  description:
    "Reverses the original posting. Refused once anything has been paid against it, because a payment with nothing to allocate to is stranded: refund it first, or write the balance off instead.",
  module: "M13",
  permissions: ["invoice:void"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** Why. An auditor asks this before they ask anything else. */
    reason: z.string().min(1).max(500),
  }),
  output: Invoice,
});

export const writeOffInvoice = defineRoute({
  method: "post",
  path: "/v1/invoices/{id}/write-off",
  summary: "Write off a balance that will not be collected",
  description:
    "Posts the OUTSTANDING BALANCE to bad debt, never the total: an invoice half paid and then written off would otherwise remove a receivable that was already settled in cash.",
  module: "M13",
  permissions: ["invoice:writeoff"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    reason: z.string().min(1).max(500),
  }),
  output: Invoice,
});

/**
 * GIVING MONEY BACK THAT DID NOT GO THROUGH A PROCESSOR.
 *
 * `POST /v1/payments/{paymentId}/refund` refunds through the processor and
 * rightly refuses a cheque: money that arrived as a cheque goes back as a
 * cheque, written by a person. There was then no way to record that it had
 * been, so a refund already made, today or in a migrated company's history,
 * had nowhere to go and the books kept the money.
 *
 * This records it. It moves no money itself.
 */
export const recordRefund = defineRoute({
  method: "post",
  path: "/v1/payments/{id}/refunds",
  summary: "Record a refund that was paid outside a processor",
  description:
    "Never more than is left of the payment. Comes out of money the payment still holds for the customer first, which returns a credit and reverses nothing; any more reopens the invoices it paid, newest allocation first, so the receivable comes back until the invoice is voided, written off or paid another way. A refund more than a week back needs data:import, and none may land in a closed period.",
  module: "M13",
  permissions: ["payment:refund"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    amount: MoneyString,
    /** How the money went back. */
    method: z.enum(["cash", "check", "ach", "credit", "other"]),
    /** When it went back. Omit for now. */
    refundedAt: z.string().datetime().optional(),
    checkNumber: z.string().max(50).optional(),
    reason: z.string().min(1).max(500),
  }),
  output: Payment,
});

/**
 * Reading payments back.
 *
 * Payments could be recorded and never listed: the invoice carried its own
 * `amountPaid`, and money held for a customer, a payment's method or its
 * date could not be read at all, so nothing could reconcile against them.
 */
export const listPayments = defineRoute({
  method: "get",
  path: "/v1/payments",
  summary: "List payments",
  module: "M13",
  permissions: ["payment:read"],
  input: PageRequest.extend({
    customerId: Uuid.optional(),
    /** Payments with any allocation to this invoice. */
    invoiceId: Uuid.optional(),
    method: PaymentMethod.optional(),
    /** Received on or after this instant. */
    receivedFrom: z.string().datetime().optional(),
    /** Received before this instant. */
    receivedTo: z.string().datetime().optional(),
    status: z.string().max(40).optional(),
    /** Only payments still holding money for the customer. */
    unappliedOnly: z.boolean().default(false),
    ...ExternalLookup,
  }),
  /**
   * A page, and the totals for the whole window rather than for the page.
   * Totals are per method because cash and cheque sit in a drawer until
   * somebody banks them and card settles net of a fee two days later, and
   * they cover one currency rather than adding several into a sum that is
   * not money in any of them.
   */
  output: pageOf(Payment).extend({
    totals: z.object({
      gross: MoneyString, fees: MoneyString, refunded: MoneyString, net: MoneyString,
    }),
    byMethod: z.array(z.object({
      method: z.string(), count: z.number(), gross: MoneyString, net: MoneyString,
    })),
  }),
});


/**
 * EDITING, ISSUING AND THROWING AWAY A DRAFT.
 *
 * A draft could be written (by converting an estimate) and nothing else:
 * sending refused it, voiding refused it, and nothing could change or issue
 * it, so it was stranded. An issued invoice is never edited; a draft is
 * nothing else.
 */
export const updateInvoice = defineRoute({
  method: "patch",
  path: "/v1/invoices/{id}",
  summary: "Edit a draft invoice",
  description:
    "Drafts only. Lines, when sent, replace the draft's lines and are priced by the same rules as a new invoice. An issued invoice is refused: void it and raise another.",
  module: "M13",
  permissions: ["invoice:write"],
  /** A replacement, not an increment: sending the same edit twice leaves the same draft. */
  idempotent: true,
  input: z.object({
    id: Uuid,
    lines: z.array(InvoiceLineInput).min(1).optional(),
    adjustment: z.object({ name: z.string().min(1).max(200), amount: MoneyString }).optional(),
    expectedTotals: z.object({
      subtotal: MoneyString.optional(),
      discountTotal: MoneyString.optional(),
      taxTotal: MoneyString.optional(),
      total: MoneyString.optional(),
    }).optional(),
    dueOn: z.string().date().nullable().optional(),
    memo: z.string().max(2000).nullable().optional(),
    purchaseOrderNumber: z.string().max(100).nullable().optional(),
  }),
  output: Invoice,
});

export const issueInvoice = defineRoute({
  method: "post",
  path: "/v1/invoices/{id}/issue",
  summary: "Issue a draft invoice",
  description:
    "Posts it to the ledger, moves its job to invoiced, consumes the client's authorisation, and makes it something that can be sent and paid. The issue date follows the same rules as on create.",
  module: "M13",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    issuedOn: z.string().date().optional(),
  }),
  output: Invoice,
});

export const deleteInvoice = defineRoute({
  method: "delete",
  path: "/v1/invoices/{id}",
  summary: "Delete a draft invoice",
  description: "Drafts only, which were never posted or sent. Its job lines go back to unbilled. An issued invoice is voided instead.",
  module: "M13",
  permissions: ["invoice:write"],
  /** A retry finds nothing to delete and says so, and nothing else happens. */
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ deleted: z.literal(true), id: Uuid }),
});

export const billingRoutes = {
  createInvoice, listInvoices, getInvoice, recordPayment, getArAging,
  voidInvoice, writeOffInvoice, applyPayment, listPayments, recordRefund,
  updateInvoice, issueInvoice, deleteInvoice,
} as const;
