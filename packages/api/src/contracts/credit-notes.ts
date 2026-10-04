import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString, PageRequest, pageOf, Timestamps } from "./common";

/**
 * CREDIT NOTES
 *
 * The third way a balance goes away, and the one that was missing. A void
 * says the invoice should never have existed and a write off says the money
 * will not arrive. Neither fits the commonest case in the trades: the work
 * happened, the bill asked for too much, and the company owes the customer
 * the difference. Without this, every one of those became a write off and the
 * bad debt figure an owner uses to judge a customer was made of their own
 * billing mistakes.
 *
 * Issuing and applying are separate acts. Issuing reverses the revenue and the
 * tax for what is credited and leaves the money owed to the customer; applying
 * puts it against an invoice. A credit nobody has applied yet is a liability,
 * and it shows on the customer as one.
 *
 * All of it is `invoice:credit`, which the office manager and finance roles
 * hold. Reading is `invoice:read`.
 */
export const CreditNoteStatus = z.enum(["draft", "open", "partially_applied", "applied", "void"]);
export const CreditNoteReason = z.enum([
  "billing_error", "price_adjustment", "goodwill", "work_not_done", "duplicate_invoice", "contract_adjustment",
]);

export const CreditNoteLine = z.object({
  id: Uuid,
  invoiceLineId: Uuid.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  quantity: MoneyString,
  unitPrice: MoneyString,
  taxable: z.boolean(),
  taxRate: RateString,
  taxAmount: MoneyString,
  lineTotal: MoneyString,
});

export const CreditNoteApplication = z.object({
  id: Uuid,
  invoiceId: Uuid,
  invoiceNumber: z.number().int(),
  amount: MoneyString,
  appliedOn: z.string().date().nullable(),
});

export const CreditNotePayoutMethod = z.enum(["card", "cash", "check", "other"]);

/**
 * Credit given back as money. A card payout is `pending` from the moment the
 * processor is asked until it reports the refund made, and is posted only
 * then; cash and cheques are `paid` when recorded.
 */
export const CreditNotePayout = z.object({
  id: Uuid,
  method: CreditNotePayoutMethod,
  status: z.enum(["pending", "paid", "failed"]),
  amount: MoneyString,
  /** The earlier card payment it went back through. */
  paymentId: Uuid.nullable(),
  /** A cheque number, or how the cash went. */
  reference: z.string().nullable(),
  paidOn: z.string().date().nullable(),
  note: z.string().nullable(),
  /** Why the processor would not make it. The credit is back on the account. */
  failureReason: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

export const CreditNote = z.object({
  id: Uuid,
  number: z.number().int(),
  status: CreditNoteStatus,
  customerId: Uuid,
  customerName: z.string(),
  invoiceId: Uuid.nullable(),
  invoiceNumber: z.number().int().nullable(),
  reason: CreditNoteReason,
  note: z.string().nullable(),
  issuedOn: z.string().date().nullable(),
  currency: z.string().length(3),
  subtotal: MoneyString,
  taxTotal: MoneyString,
  total: MoneyString,
  amountApplied: MoneyString,
  /** Given back as money, or on its way back to a card. */
  amountPaidOut: MoneyString,
  /** Still owed to the customer and not yet put against anything. */
  balance: MoneyString,
  voidedAt: z.string().datetime({ offset: true }).nullable(),
  lines: z.array(CreditNoteLine),
  applications: z.array(CreditNoteApplication),
  payouts: z.array(CreditNotePayout),
}).merge(Timestamps);

export const CreditNoteLineInput = z.object({
  /**
   * The invoice line this credits. Its name, rate and taxability are copied
   * from it, and the amount credited on it can never pass what it charged.
   */
  invoiceLineId: Uuid.optional(),
  /** Required without an invoice line. */
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  quantity: MoneyString.default("1"),
  unitPrice: MoneyString,
  taxable: z.boolean().optional(),
  /** Without an invoice line only. With one, the line's own rate is used. */
  taxRate: RateString.optional(),
});

export const createCreditNote = defineRoute({
  method: "post",
  path: "/v1/credit-notes",
  summary: "Raise a credit note",
  description:
    "Against an invoice or standing alone. Totals are computed here from the lines, with tax at the rate the credited invoice line charged. A line can never credit more than its invoice line charged, counting earlier credits, and a credit against an invoice can never pass what it billed. Goodwill needs a note. Issued straight away unless `draft` is set, and applied to its own invoice's balance at once unless `apply` is false.",
  module: "M13",
  permissions: ["invoice:credit"],
  idempotent: true,
  input: z.object({
    customerId: Uuid.optional(),
    invoiceId: Uuid.optional(),
    reason: CreditNoteReason,
    note: z.string().max(2000).optional(),
    lines: z.array(CreditNoteLineInput).min(1).max(200),
    draft: z.boolean().default(false),
    apply: z.boolean().default(true),
  }),
  output: CreditNote,
});

export const issueCreditNote = defineRoute({
  method: "post",
  path: "/v1/credit-notes/{id}/issue",
  summary: "Issue a draft credit note",
  description: "Posts it to the ledger and numbers it. A credit note already issued is returned as it is.",
  module: "M13",
  permissions: ["invoice:credit"],
  idempotent: true,
  input: z.object({ id: Uuid, apply: z.boolean().default(true) }),
  output: CreditNote,
});

export const applyCreditNote = defineRoute({
  method: "post",
  path: "/v1/credit-notes/{id}/apply",
  summary: "Put a credit against invoices",
  description:
    "Only that customer's open invoices, never more than the credit has left and never more than an invoice owes. No cash moves: what the company owed the customer settles what the customer owes the company.",
  module: "M13",
  permissions: ["invoice:credit"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    applications: z.array(z.object({ invoiceId: Uuid, amount: MoneyString })).min(1).max(100),
  }),
  output: CreditNote,
});

export const payOutCreditNote = defineRoute({
  method: "post",
  path: "/v1/credit-notes/{id}/payouts",
  summary: "Pay a credit out to the customer as money",
  description:
    "Credit the customer holds and has not used, given back. `card` refunds it through the card processor against one of the customer's earlier card payments (`paymentId`, or the newest with enough left to refund when it is left off): it is pending until the processor reports the refund made, and is posted then, taking the credit out of customer deposits against cash. The payment keeps what it paid and held, and the credit set aside goes back on the account if the processor will not make the refund. `cash`, `check` and `other` record money already handed over, posted on `paidOn` (today when left off). Never more than the credit has left. Synced to the accounting system as a refund of the credit note.",
  module: "M13",
  permissions: ["payment:refund"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    method: CreditNotePayoutMethod,
    /** All that is left when it is left off. */
    amount: MoneyString.optional(),
    paymentId: Uuid.optional(),
    reference: z.string().max(200).optional(),
    paidOn: z.string().date().optional(),
    note: z.string().max(2000).optional(),
  }),
  output: CreditNote,
});

export const refundableCardPayments = defineRoute({
  method: "get",
  path: "/v1/credit-notes/{id}/refundable-payments",
  summary: "The card payments a credit can go back through",
  description:
    "The credit note's customer's payments taken through the card processor, newest first, with what each still has that the processor would refund: its amount, less what has been refunded and what other credit payouts are waiting on it.",
  module: "M13",
  permissions: ["payment:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    payments: z.array(z.object({
      id: Uuid,
      method: z.string(),
      amount: MoneyString,
      refundable: MoneyString,
      receivedAt: z.string().datetime({ offset: true }),
    })),
  }),
});

export const voidCreditNote = defineRoute({
  method: "post",
  path: "/v1/credit-notes/{id}/void",
  summary: "Void a credit note nothing has used",
  description:
    "Reverses its posting. Refused once any of it is applied or paid out, because each of those has its own posting and unwinding both from here would be two reversals pretending to be one.",
  module: "M13",
  permissions: ["invoice:credit"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().min(1).max(500) }),
  output: CreditNote,
});

export const deleteCreditNote = defineRoute({
  method: "delete",
  path: "/v1/credit-notes/{id}",
  summary: "Throw away a draft credit note",
  description: "Drafts only. An issued credit note is in the ledger and is voided instead.",
  module: "M13",
  permissions: ["invoice:credit"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ deleted: z.literal(true), id: Uuid }),
});

export const getCreditNote = defineRoute({
  method: "get",
  path: "/v1/credit-notes/{id}",
  summary: "One credit note, its lines and where it went",
  description: "With every application, so a credit spread over three invoices reconciles back to the document that created it.",
  module: "M13",
  permissions: ["invoice:read"],
  input: z.object({ id: Uuid }),
  output: CreditNote,
});

export const listCreditNotes = defineRoute({
  method: "get",
  path: "/v1/credit-notes",
  summary: "Credit notes",
  description: "Newest first. Filter by customer, by the invoice they were raised against, or by status.",
  module: "M13",
  permissions: ["invoice:read"],
  input: PageRequest.extend({
    customerId: Uuid.optional(),
    invoiceId: Uuid.optional(),
    status: CreditNoteStatus.optional(),
  }),
  output: pageOf(CreditNote),
});

export const creditNoteRoutes = {
  createCreditNote, issueCreditNote, applyCreditNote, voidCreditNote, deleteCreditNote,
  getCreditNote, listCreditNotes, payOutCreditNote, refundableCardPayments,
} as const;
