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

/**
 * A line belongs to an OPTION, not to the estimate.
 *
 * Good, better, best is not a discount ladder, it is three different scopes of
 * work. The better option replaces the condenser; the best one replaces the
 * system and adds a surge protector. Hanging lines off the estimate and
 * flagging which option they belong to makes the common case, a line that
 * appears in two options at a different quantity, impossible to express.
 *
 * Shape mirrors invoice_line deliberately. Converting an approved option into
 * an invoice is then a copy, not a translation, and the frozen price book
 * version and applied tax rate survive the conversion unchanged.
 */
export const estimateLine = pgTable("estimate_line", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  optionId: uuid("option_id").notNull().references(() => estimateOption.id, { onDelete: "cascade" }),
  /** Frozen reference. Never the live item, always the version that was priced. */
  priceBookItemVersionId: uuid("price_book_item_version_id").references(() => priceBookItemVersion.id),
  sortOrder: integer("sort_order").notNull().default(0),
  name: text("name").notNull(),
  description: text("description"),
  quantity: money("quantity").notNull().default("1"),
  unitPrice: money("unit_price").notNull().default("0"),
  unitCost: money("unit_cost"),
  discountAmount: money("discount_amount").notNull().default("0"),
  taxable: boolean("taxable").notNull().default(true),
  /** The rate AS APPLIED, carried onto the invoice on conversion. */
  taxRate: rate("tax_rate").notNull().default("0"),
  taxAmount: money("tax_amount").notNull().default("0"),
  lineTotal: money("line_total").notNull().default("0"),
  /**
   * Optional lines are priced and shown but excluded from the option total
   * until the customer ticks them. A surge protector on an HVAC replacement
   * sells far better offered than buried in the price.
   */
  isOptional: boolean("is_optional").notNull().default(false),
  isSelected: boolean("is_selected").notNull().default(false),
  costCode: text("cost_code"),
  ...timestamps,
}, (t) => ({ optionIdx: index("estimate_line_option_idx").on(t.optionId) }));

/**
 * What was signed, by whom, from where.
 *
 * An e-signature is worth exactly as much as the record that it happened. The
 * useful record is not the image: it is the identifier the signer proved they
 * controlled, the moment, the address the request came from, and a hash of the
 * document content as displayed. Store the hash and a disagreement about what
 * was agreed is answerable; store only the image and it is not.
 *
 * Append only in practice: a re-signature is a new row, so the history of a
 * document that was revised and re-signed stays legible.
 */
export const signatureSubject = pgEnum("signature_subject", [
  "estimate", "service_report", "agreement", "authorization",
]);

export const documentSignature = pgTable("document_signature", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  subject: signatureSubject("subject").notNull(),
  subjectId: uuid("subject_id").notNull(),
  signerName: text("signer_name").notNull(),
  signerEmail: text("signer_email"),
  signerPhone: text("signer_phone"),
  /** Vector or raster capture, stored as a document reference. */
  imageUrl: text("image_url"),
  /** SHA-256 of the rendered document at the moment of signing. */
  documentHash: text("document_hash").notNull(),
  /** Which option the signature covers, where the subject offered a choice. */
  selectedOptionId: uuid("selected_option_id"),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  ...timestamps,
}, (t) => ({
  subjectIdx: index("document_signature_subject_idx").on(t.organizationId, t.subject, t.subjectId),
}));

/**
 * Money taken before the work is done.
 *
 * A deposit is a LIABILITY, not revenue, and it stays one until the work it
 * covers is performed. Booking it as revenue on receipt overstates the month,
 * overstates commission, and leaves a company that takes 50% up front unable
 * to tell what it has actually earned. The ledger postings in packages/core
 * enforce this; the row is here so that applying a deposit to an invoice is
 * traceable to the request that collected it.
 */
export const depositStatus = pgEnum("deposit_status", [
  "requested", "held", "applied", "refunded", "forfeited",
]);

export const deposit = pgTable("deposit", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  estimateId: uuid("estimate_id").references(() => estimate.id, { onDelete: "set null" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  /** Set once the deposit has been consumed by an invoice. */
  appliedInvoiceId: uuid("applied_invoice_id"),
  paymentId: uuid("payment_id"),
  status: depositStatus("status").notNull().default("requested"),
  currency: currency(),
  /** What was asked for. Kept alongside the amount actually received. */
  amountRequested: money("amount_requested").notNull(),
  amountReceived: money("amount_received").notNull().default("0"),
  amountApplied: money("amount_applied").notNull().default("0"),
  amountRefunded: money("amount_refunded").notNull().default("0"),
  /** Present when the deposit was computed as a percentage rather than set. */
  percentOfTotal: rate("percent_of_total"),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("deposit_org_idx").on(t.organizationId, t.status),
  customerIdx: index("deposit_customer_idx").on(t.customerId),
}));

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

  /**
   * The payer is frequently not the customer: a warranty company, an insurance
   * carrier, a property owner behind a manager, a builder paying on draws.
   * AR ages by PAYER, not by customer, or a commercial book is unreadable.
   */
  payerCustomerId: uuid("payer_customer_id").references(() => customer.id),
  payerExternalName: text("payer_external_name"),
  payerReference: text("payer_reference"),

  purchaseOrderNumber: text("purchase_order_number"),
  costCode: text("cost_code"),
  contractId: uuid("contract_id"),
  /** Set when a ceiling governs this invoice, so a breach is checkable. */
  authorizationId: uuid("authorization_id"),

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
  /** AR aging by payer, which is the only readable view on a commercial book. */
  payerIdx: index("invoice_payer_idx").on(t.organizationId, t.payerCustomerId, t.status),
  customerIdx: index("invoice_customer_idx").on(t.customerId),
  jobIdx: index("invoice_job_idx").on(t.jobId),
}));

/**
 * Where a line came from. Not every line originates from a job: a propane
 * delivery bills on metered quantity, a dumpster bills on elapsed rental
 * period, and a service contract bills on its own schedule whether or not
 * anyone visited. Without this, each of those becomes a separate product
 * rather than a trade pack.
 */
export const lineOrigin = pgEnum("line_origin", [
  "job", "delivery", "rental_period", "contract_schedule", "membership", "manual", "fee",
]);

export const invoiceLine = pgTable("invoice_line", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id, { onDelete: "cascade" }),
  origin: lineOrigin("origin").notNull().default("job"),
  originId: uuid("origin_id"),
  /** Resolved coverage. A zero dollar line under an agreement and a zero dollar
   *  line that is our own rework look identical on a revenue report and mean
   *  opposite things about the business. See schema/entitlement.ts. */
  entitlementId: uuid("entitlement_id"),
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
  /** Commercial and builder clients require cost coding at the line. */
  costCode: text("cost_code"),
  /** Set when the price came from a rate card rather than our own price book. */
  rateCardLineId: uuid("rate_card_line_id"),
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
