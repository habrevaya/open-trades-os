import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, timestamp, date } from "drizzle-orm/pg-core";
import { pk, timestamps, sourceRef, money, currency, rate } from "./_shared";
import { organization, businessUnit } from "./tenancy";
import { customer, property } from "./crm";
import { job } from "./work";
import { priceBookItemVersion } from "./pricebook";

/**
 * MONEY
 *
 * Rules that are not negotiable, enforced here and tested in packages/core:
 *
 * 1. No floats. Every amount is numeric(14,4) with an explicit currency.
 * 2. Line items reference a price book VERSION id, never a live item. The
 *    historical price is frozen on the document.
 * 3. Tax rate is stored ON the line, not looked up at read time. Rates and
 *    jurisdictions change, and old invoices must keep their original rate.
 * 4. `ledger_entry` is append only and double entry. Nothing is ever updated
 *    or deleted. A correction is a new reversing pair. Every financial report
 *    reads from the ledger, never from invoice.total.
 * 5. Every call out to Stripe carries an idempotency key written to
 *    integration_event BEFORE the call fires.
 */

export const estimateStatus = pgEnum("estimate_status", [
  "draft", "sent", "viewed", "approved", "declined", "expired", "converted",
]);

export const estimate = pgTable("estimate", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  status: estimateStatus("status").notNull().default("draft"),
  title: text("title"),
  expiresOn: date("expires_on"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  viewedAt: timestamp("viewed_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  declineReason: text("decline_reason"),
  /** Which option the customer actually chose. Drives close-rate and mix reporting. */
  selectedOptionId: uuid("selected_option_id"),
  signatureUrl: text("signature_url"),
  signerName: text("signer_name"),
  currency: currency(),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  orgIdx: index("estimate_org_idx").on(t.organizationId, t.status),
  customerIdx: index("estimate_customer_idx").on(t.customerId),
}));

/** Good / better / best. The option is the unit the customer picks between. */
export const estimateOption = pgTable("estimate_option", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  estimateId: uuid("estimate_id").notNull().references(() => estimate.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  isRecommended: boolean("is_recommended").notNull().default(false),
  subtotal: money("subtotal").notNull().default("0"),
  taxTotal: money("tax_total").notNull().default("0"),
  total: money("total").notNull().default("0"),
  ...timestamps,
}, (t) => ({ estimateIdx: index("estimate_option_estimate_idx").on(t.estimateId) }));

export const invoiceStatus = pgEnum("invoice_status", [
  "draft", "open", "partially_paid", "paid", "void", "written_off",
]);

export const invoice = pgTable("invoice", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  propertyId: uuid("property_id").references(() => property.id),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  status: invoiceStatus("status").notNull().default("draft"),
  issuedOn: date("issued_on"),
  dueOn: date("due_on"),
  currency: currency(),
  subtotal: money("subtotal").notNull().default("0"),
  discountTotal: money("discount_total").notNull().default("0"),
  taxTotal: money("tax_total").notNull().default("0"),
  total: money("total").notNull().default("0"),
  /** Denormalized for AR aging queries. Authoritative figure is the ledger. */
  amountPaid: money("amount_paid").notNull().default("0"),
  balance: money("balance").notNull().default("0"),
  /** Deposit held against work not yet performed. A liability, not revenue. */
  depositHeld: money("deposit_held").notNull().default("0"),
  memo: text("memo"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  /** AR aging: open invoices by due date. The report every owner opens first. */
  agingIdx: index("invoice_aging_idx").on(t.organizationId, t.status, t.dueOn),
  customerIdx: index("invoice_customer_idx").on(t.customerId),
  jobIdx: index("invoice_job_idx").on(t.jobId),
}));

export const invoiceLine = pgTable("invoice_line", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id, { onDelete: "cascade" }),
  /** Frozen reference. Never the live item, always the version that was priced. */
  priceBookItemVersionId: uuid("price_book_item_version_id").references(() => priceBookItemVersion.id),
  sortOrder: integer("sort_order").notNull().default(0),
  /** Copied at write time so the document renders identically forever. */
  name: text("name").notNull(),
  description: text("description"),
  quantity: money("quantity").notNull().default("1"),
  unitPrice: money("unit_price").notNull().default("0"),
  unitCost: money("unit_cost"),
  discountAmount: money("discount_amount").notNull().default("0"),
  taxable: boolean("taxable").notNull().default(true),
  /** The rate AS APPLIED. Never recomputed on read. */
  taxRate: rate("tax_rate").notNull().default("0"),
  taxAmount: money("tax_amount").notNull().default("0"),
  lineTotal: money("line_total").notNull().default("0"),
  ...timestamps,
}, (t) => ({ invoiceIdx: index("invoice_line_invoice_idx").on(t.invoiceId) }));

export const paymentMethod = pgEnum("payment_method", [
  "card", "card_present", "ach", "cash", "check", "financing", "credit", "other",
]);

export const paymentStatus = pgEnum("payment_status", [
  "pending", "succeeded", "failed", "refunded", "partially_refunded", "disputed",
]);

export const payment = pgTable("payment", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  method: paymentMethod("method").notNull(),
  status: paymentStatus("status").notNull().default("pending"),
  currency: currency(),
  amount: money("amount").notNull(),
  feeAmount: money("fee_amount").notNull().default("0"),
  tipAmount: money("tip_amount").notNull().default("0"),
  surchargeAmount: money("surcharge_amount").notNull().default("0"),
  refundedAmount: money("refunded_amount").notNull().default("0"),
  processor: text("processor").notNull().default("stripe"),
  processorPaymentId: text("processor_payment_id"),
  /** Written BEFORE the processor call. Replay safety for retries and webhooks. */
  idempotencyKey: text("idempotency_key").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  checkNumber: text("check_number"),
  notes: text("notes"),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  orgIdx: index("payment_org_idx").on(t.organizationId, t.receivedAt),
  idemIdx: index("payment_idempotency_idx").on(t.organizationId, t.idempotencyKey),
  processorIdx: index("payment_processor_idx").on(t.processor, t.processorPaymentId),
}));

/**
 * A payment can be split across several invoices, and an invoice can receive
 * several payments. Getting this join right is what makes migrations reconcile.
 */
export const paymentAllocation = pgTable("payment_allocation", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  paymentId: uuid("payment_id").notNull().references(() => payment.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id, { onDelete: "cascade" }),
  amount: money("amount").notNull(),
  ...timestamps,
}, (t) => ({
  paymentIdx: index("payment_allocation_payment_idx").on(t.paymentId),
  invoiceIdx: index("payment_allocation_invoice_idx").on(t.invoiceId),
}));

export const ledgerDirection = pgEnum("ledger_direction", ["debit", "credit"]);

/**
 * APPEND ONLY. No UPDATE, no DELETE, enforced by a trigger in the migration.
 *
 * Every invoice, payment, refund, deposit, payout, adjustment and write-off
 * writes a balanced pair of rows here. Financial reporting reads from this
 * table exclusively. The denormalized totals on `invoice` are a cache for the
 * UI and are reconciled against the ledger by a nightly worker job that alerts
 * on any drift.
 *
 * A correction is never an edit. It is a new reversing entry that references
 * the original through `reverses_entry_id`.
 */
export const ledgerEntry = pgTable("ledger_entry", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** Groups the balanced pair. Debits and credits in a transaction must sum to zero. */
  transactionId: uuid("transaction_id").notNull(),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  direction: ledgerDirection("direction").notNull(),
  /** Maps to the chart of accounts for the GL export and QBO/Xero sync. */
  accountCode: text("account_code").notNull(),
  currency: currency(),
  amount: money("amount").notNull(),
  /** What caused this entry. Polymorphic by design, always both columns set. */
  sourceType: text("source_type").notNull(),
  sourceId: uuid("source_id").notNull(),
  customerId: uuid("customer_id").references(() => customer.id),
  jobId: uuid("job_id").references(() => job.id),
  reversesEntryId: uuid("reverses_entry_id"),
  memo: text("memo"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  txIdx: index("ledger_entry_tx_idx").on(t.transactionId),
  orgTimeIdx: index("ledger_entry_org_time_idx").on(t.organizationId, t.occurredAt),
  accountIdx: index("ledger_entry_account_idx").on(t.organizationId, t.accountCode, t.occurredAt),
  jobIdx: index("ledger_entry_job_idx").on(t.jobId),
  sourceIdx: index("ledger_entry_source_idx").on(t.sourceType, t.sourceId),
}));
