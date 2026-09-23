import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString, PageRequest, pageOf, Timestamps } from "./common";
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
  balance: MoneyString,
  depositHeld: MoneyString,
  memo: z.string().nullable(),
  lines: z.array(InvoiceLine),
}).merge(Timestamps);

export const createInvoice = defineRoute({
  method: "post",
  path: "/v1/invoices",
  summary: "Create an invoice",
  description:
    "From a job, or standalone. Totals are computed server side from the lines; a client supplied total is ignored.",
  module: "M13",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({
    customerId: Uuid,
    payerCustomerId: Uuid.optional(),
    jobId: Uuid.optional(),
    purchaseOrderNumber: z.string().max(100).optional(),
    dueOn: z.string().date().optional(),
    memo: z.string().max(2000).optional(),
    lines: z.array(z.object({
      priceBookItemId: Uuid.optional(),
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      quantity: MoneyString.default("1"),
      unitPrice: MoneyString,
      discountAmount: MoneyString.default("0"),
      taxable: z.boolean().default(true),
      costCode: z.string().max(50).optional(),
      coverageSource: CoverageSource.optional(),
    })).min(1),
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
    customerId: Uuid,
    method: PaymentMethod,
    amount: MoneyString,
    tipAmount: MoneyString.default("0"),
    receivedAt: z.string().datetime().optional(),
    checkNumber: z.string().max(50).optional(),
    notes: z.string().max(1000).optional(),
    /**
     * Which invoices this pays, and how much of each. Omit and the server
     * applies oldest balance first. A payment can span invoices and an invoice
     * can take many payments; getting this join right is what makes a
     * migration reconcile.
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
    /** The balanced pair written to the ledger, so a caller can verify. */
    ledgerTransactionId: Uuid,
  }),
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

export const billingRoutes = {
  createInvoice, listInvoices, getInvoice, recordPayment, getArAging,
  voidInvoice, writeOffInvoice,
} as const;
