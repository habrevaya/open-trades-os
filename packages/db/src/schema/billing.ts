import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { pk, timestamps, sourceRef, sourceRefIndex, money, currency, rate } from "./_shared";
import { organization, businessUnit, user } from "./tenancy";
import { customer, property } from "./crm";
import { job, jobType } from "./work";
import { priceBookItemVersion } from "./pricebook";
import { taxRate } from "./tax";

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

/**
 * HOW A COMPANY LAYS OUT ITS PROPOSALS
 *
 * The proposal used to have one fixed shape: the options, then the terms. A
 * contractor selling a system against a competitor's glossy folder wants a
 * cover with a photograph of a finished install, a page about who they are,
 * the warranty in their own words, financing, what other customers said, and
 * the small print, in the order they sell in. This is that order, saved, by
 * name, and optionally the one a job type starts with.
 *
 * The layout is DATA in a closed vocabulary (`core/estimate/proposal-layout`),
 * checked before it is stored: a section kind this build cannot draw is
 * refused at the save rather than skipped on a customer's screen.
 *
 * An estimate COPIES the layout when one is applied (`estimate.proposal_layout`)
 * rather than pointing at this row, for the reason it copies the terms: a
 * company rewording its warranty page in March must not change what a
 * customer was shown in February. Editing a template changes the estimates it
 * is applied to from then on, and none before.
 */
export const proposalTemplate = pgTable("proposal_template", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /**
   * The job type whose estimates start with this layout. One template per
   * job type at most, and none is fine: those estimates take the company's
   * default, or the fixed layout when there is no default either.
   */
  jobTypeId: uuid("job_type_id").references(() => jobType.id, { onDelete: "set null" }),
  /** The layout every estimate starts with when its job type names none. */
  isDefault: boolean("is_default").notNull().default(false),
  /**
   * The cover page: a headline, a sentence under it, and the photograph by
   * its stored file key. Null is no cover; the proposal opens on its first
   * section.
   */
  cover: jsonb("cover").$type<{ headline: string; intro: string | null; photoKey: string | null } | null>(),
  /** The sections in the order they are drawn. See core for the vocabulary. */
  sections: jsonb("sections").$type<Array<Record<string, unknown>>>().notNull().default([]),
  /** Whether each option shows the photographs attached to it on the estimate. */
  showOptionPhotos: boolean("show_option_photos").notNull().default(true),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  nameIdx: uniqueIndex("proposal_template_name_idx").on(t.organizationId, t.name)
    .where(sql`${t.deletedAt} is null`),
  /** One layout per job type, or which one a new estimate starts with depends on the heap. */
  jobTypeIdx: uniqueIndex("proposal_template_job_type_idx").on(t.organizationId, t.jobTypeId)
    .where(sql`${t.deletedAt} is null and ${t.jobTypeId} is not null`),
  /** One default, for the same reason. */
  defaultIdx: uniqueIndex("proposal_template_default_idx").on(t.organizationId)
    .where(sql`${t.deletedAt} is null and ${t.isDefault}`),
}));

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
  /**
   * The day it was written, in the company's calendar. Separate from
   * `created_at`, which is when this row was inserted: for an estimate
   * migrated from another system those are years apart, and close rate by
   * month is computed from this one.
   */
  issuedOn: date("issued_on"),
  expiresOn: date("expires_on"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  viewedAt: timestamp("viewed_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  declineReason: text("decline_reason"),
  /** Which option the customer actually chose. Drives close-rate and mix reporting. */
  selectedOptionId: uuid("selected_option_id"),
  signatureUrl: text("signature_url"),
  signerName: text("signer_name"),
  /**
   * The terms printed under the options, copied from the company's own at the
   * moment the estimate is written and never looked up again.
   *
   * Copied rather than read live for the reason a price is: a company that
   * changes its warranty wording in March must not change what a customer
   * signed in February. The approval hash covers this column, so what was
   * agreed includes the small print that was on the page.
   */
  terms: text("terms"),
  /**
   * The proposal layout this estimate is drawn in, COPIED from a template when
   * one was applied, with the template's id and name for the record. Null is
   * the fixed layout: the options, then the terms. Copied rather than read
   * live, like `terms` above, so editing a template never changes a proposal
   * a customer has already been sent.
   */
  proposalTemplateId: uuid("proposal_template_id").references(() => proposalTemplate.id, { onDelete: "set null" }),
  proposalLayout: jsonb("proposal_layout").$type<Record<string, unknown> | null>(),
  /** The company's own fields. See `services/custom-fields.ts`. */
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
  currency: currency(),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  sourceRefIdx: sourceRefIndex("estimate_source_ref_idx", t),
  /** UNIQUE for the same reason as job_number_idx: see services/jobs.ts. */
  numberIdx: uniqueIndex("estimate_number_idx").on(t.organizationId, t.number),
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
/**
 * WHO MAY DISCOUNT, AND BY HOW MUCH.
 *
 * `estimate_line.discount_amount` has existed since the first migration and
 * anybody holding `estimate:write` could set it to anything. The permission
 * catalogue declares `estimate:discount` and `estimate.discount.unlimited`,
 * both of which were granted to roles and checked by nothing, so the two
 * authorities a company actually wants were a restriction the owner believed
 * they had applied.
 *
 * ONE ROW PER COMPANY, like `review_policy` and `overtime_policy` next door.
 * A per-role cap would be the obvious design and it is the wrong one: roles
 * are editable, a company invents its own, and the question "what is the most
 * anybody can take off without a manager" has one answer per company rather
 * than one per role. Somebody who should not be capped holds
 * `estimate.discount.unlimited` instead, which is what that permission is
 * for and why it is spelled with a dot rather than a colon: it is a
 * modifier on an authority, not an authority of its own.
 *
 * NO ROW MEANS NO DISCOUNTING AT ALL BEYOND ZERO. That is deliberate and it
 * is the opposite of the usual default. A company that has not said what its
 * limit is has not authorised anybody to give money away, and the refusal
 * names the screen that fixes it. The alternative, treating silence as
 * unlimited, means every company that never opened the settings page has a
 * technician who can discount a job to nothing.
 */
export const discountPolicy = pgTable("discount_policy", {
  id: pk(),
  organizationId: uuid("organization_id").notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  /**
   * The most a holder of `estimate:discount` may take off one option, as a
   * fraction of its subtotal before tax.
   *
   * A PERCENTAGE RATHER THAN AN AMOUNT, because a cap in dollars is either
   * meaningless on a forty thousand dollar re-pipe or absurd on a service
   * call, and a company that sells both would have to pick which of the two
   * it wanted the limit to work for.
   */
  maxPercent: rate("max_percent").notNull(),
  /**
   * An absolute ceiling as well, when a company wants one.
   *
   * Both apply and the LOWER wins, which is the only composition that is not
   * surprising: "up to ten per cent, and never more than two thousand" is a
   * sentence an owner says out loud, and the other reading, whichever is
   * larger, would make the second half authorise more than the first.
   */
  maxAmount: money("max_amount"),
  /** Why these numbers. Read by whoever approves a discount at the edge of it. */
  note: text("note"),
  ...timestamps,
}, (t) => ({
  /**
   * One per company, enforced rather than assumed. Two policies means the cap
   * that applies depends on which row the query returned first, so the same
   * discount is refused and allowed on alternate afternoons.
   */
  orgIdx: uniqueIndex("discount_policy_org_idx").on(t.organizationId)
    .where(sql`${t.deletedAt} is null`),
}));

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
  /**
   * MEMBER PRICING, AND WHICH AGREEMENT PRODUCED IT.
   *
   * `discount_amount` is the whole of the line's discount and is what every
   * total and the ledger read, so a member discount posts to the discounts
   * account exactly as a hand typed one does. These two say how much of it
   * came from a plan and from which agreement, because "why is this line
   * cheaper" has to have an answer that is not somebody's memory, and a
   * discount a customer is entitled to is a different fact from one somebody
   * chose to give. Not a foreign key, like `entitlement_id`: the agreement
   * schema imports this file, and the link is a record of what applied on
   * the day rather than a dependency.
   */
  memberAgreementId: uuid("member_agreement_id"),
  memberDiscountAmount: money("member_discount_amount").notNull().default("0"),
  taxable: boolean("taxable").notNull().default(true),
  /** The rate AS APPLIED, carried onto the invoice on conversion. */
  taxRate: rate("tax_rate").notNull().default("0"),
  taxAmount: money("tax_amount").notNull().default("0"),
  /** The company's rate it charged, when it was one of them. See `invoice_line.tax_rate_id`. */
  taxRateId: uuid("tax_rate_id").references(() => taxRate.id),
  /** Where the rate came from. See `invoice_line.tax_source`. */
  taxSource: text("tax_source"),
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
  /** A change order on a project, signed through its link or recorded by the office. */
  "change_order",
  /** An invoice the customer signed for on the technician's phone, at the end of the visit. */
  "invoice",
  /**
   * A document the company gave one of its own people to sign: the handbook,
   * the vehicle use agreement. The subject is the request to that person, so
   * the signature says whose it is and which words it was given against.
   */
  "staff_document",
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
  /**
   * The drawn signature taken on a technician's phone, by the id the phone
   * gave it. The image travels the way every photograph from the field does,
   * behind the record and hash checked, and is found by this id in
   * `field_upload` once it lands. Null for a signature made anywhere else.
   */
  uploadId: text("upload_id"),
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
  /**
   * The branch's mark printed in front of the number ("AUS-7100"), written
   * once when the invoice is made and only when the company prints branch
   * marks. Never worked out again, so moving work between branches or
   * changing a branch's code renumbers nothing a customer already holds.
   * `app.number_prefix` in `sql/after.sql` writes it.
   */
  numberPrefix: text("number_prefix"),
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
  /**
   * What credit notes took off it. Kept apart from `amountPaid` because a
   * credit is not money arriving: a collections report that counted it as
   * paid would show cash the bank never saw.
   */
  amountCredited: money("amount_credited").notNull().default("0"),
  balance: money("balance").notNull().default("0"),
  /** Deposit held against work not yet performed. A liability, not revenue. */
  depositHeld: money("deposit_held").notNull().default("0"),
  memo: text("memo"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  ...sourceRef,
  /**
   * The company's own fields, checked against the definitions in M29 by the
   * service that writes them. See `services/custom-fields.ts`.
   */
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => ({
  sourceRefIdx: sourceRefIndex("invoice_source_ref_idx", t),
  /** AR aging: open invoices by due date. The report every owner opens first. */
  /** UNIQUE for the same reason as job_number_idx: see services/jobs.ts. */
  numberIdx: uniqueIndex("invoice_number_idx").on(t.organizationId, t.number),
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
  /** See `estimate_line.member_agreement_id`. Carried across on conversion. */
  memberAgreementId: uuid("member_agreement_id"),
  memberDiscountAmount: money("member_discount_amount").notNull().default("0"),
  taxable: boolean("taxable").notNull().default(true),
  /** The rate AS APPLIED. Never recomputed on read. */
  taxRate: rate("tax_rate").notNull().default("0"),
  taxAmount: money("tax_amount").notNull().default("0"),
  /**
   * WHICH OF THE COMPANY'S RATES THIS LINE CHARGED, when it was one of them.
   * `tax_rate` above is still the figure; this is the name a filing report
   * groups by, so "Travis County" is one row however many invoices charged
   * it. Null for a line nobody taxed, a rate typed by hand that matches none
   * of the company's, and history. No cascade: a rate is retired, never
   * removed, because lines name it.
   */
  taxRateId: uuid("tax_rate_id").references(() => taxRate.id),
  /**
   * Where the line's rate came from, written when the line is priced:
   * `address`, `customer` or `default` (the company's table, `core/tax`),
   * `exempt` (the customer's certificate), `none` (no rate applies), `off`
   * (the company charges no sales tax), `chosen` (a person picked it),
   * `estimate` (carried from the option signed for), `given` (history).
   * Null on a line that is not taxable, and on lines written before it was
   * recorded. Issuing a draft checks the first six against the rate in force
   * on the day it is issued.
   */
  taxSource: text("tax_source"),
  lineTotal: money("line_total").notNull().default("0"),
  /** Commercial and builder clients require cost coding at the line. */
  costCode: text("cost_code"),
  /** Set when the price came from a rate card rather than our own price book. */
  rateCardLineId: uuid("rate_card_line_id"),
  /**
   * WHO PRICED THIS LINE, written when the line is priced and never worked
   * out again. `price_book`, `entered` (a price somebody typed), or a card's
   * authority: `contract`, `warranty_network`, `manufacturer_allowance`,
   * `insurance`, `brand`. A commercial client rejecting an invoice asks one
   * question first, "whose price is that", and the answer has to be on the
   * line rather than reconstructed from which card was in force that week.
   */
  priceAuthority: text("price_authority"),
  /** The card that priced it, when one did. */
  rateCardId: uuid("rate_card_id"),
  /**
   * HOW the authority priced it: `card_line`, `labour_rate`, `material_markup`,
   * `trip_charge`, `price_book`, `entered`, `history`, or `share` for a line
   * that is one payer's part of a line split between payers.
   */
  priceBasis: text("price_basis"),
  /** The working, in a sentence: "After hours rate, 1.50 h at 142.50". */
  priceNote: text("price_note"),
  ...timestamps,
}, (t) => ({ invoiceIdx: index("invoice_line_invoice_idx").on(t.invoiceId) }));

/**
 * WHY A CREDIT NOTE IS ITS OWN DOCUMENT
 *
 * Three different things reduce what a customer owes and they are not
 * interchangeable, which is the whole reason this table exists rather than a
 * flag on `invoice`:
 *
 *   A REFUND moves cash back out. There is a bank line for it.
 *   A WRITE OFF admits the money will never arrive. It is a bad debt expense
 *     and it says something about the customer.
 *   A CREDIT NOTE says the invoice asked for too much. No cash moves, nothing
 *     is owed and nothing was lost: the bill was wrong, or the company chose to
 *     give something back.
 *
 * Collapsing the third into the second is the common shortcut and it is
 * expensive in a specific way: every mis-billed invoice becomes bad debt
 * expense, so the one number an owner uses to decide whether to keep selling to
 * a customer is made of their own billing mistakes.
 *
 * NOT A NEGATIVE INVOICE, which is the other shortcut. An invoice with a
 * negative total would be picked up by every query in this product that means
 * "what is owed": the aging report, the receivables total, the statement, the
 * dunning list. Each one would need an exclusion, and the first one anybody
 * forgets reports a company's receivables as smaller than they are.
 */
export const creditNoteStatus = pgEnum("credit_note_status", [
  "draft",
  /** Issued and posted. Some or all of it may still be unapplied. */
  "open",
  "partially_applied",
  "applied",
  "void",
]);

/**
 * Why the credit was given, from a closed list.
 *
 * Required, and closed, because the free text version of this field is always
 * filled in with the customer's name. The six below are what the reasons
 * actually are, and the distinction an owner needs is the first one against the
 * rest: a billing error is a process problem that can be fixed, and goodwill is
 * a decision somebody made.
 */
export const creditReason = pgEnum("credit_reason", [
  "billing_error",
  "price_adjustment",
  "goodwill",
  "work_not_done",
  "duplicate_invoice",
  "contract_adjustment",
]);

export const creditNote = pgTable("credit_note", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** Its own sequence, so a credit note and an invoice never share a number. */
  number: integer("number").notNull(),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  /**
   * The invoice it was raised against, when there is one.
   *
   * Nullable because a standalone credit is real: a customer owed something at
   * the end of a contract, or a goodwill credit against future work. Those have
   * no invoice to point at, and inventing one would be a document nobody sent.
   */
  invoiceId: uuid("invoice_id").references(() => invoice.id, { onDelete: "set null" }),
  status: creditNoteStatus("status").notNull().default("draft"),
  reason: creditReason("reason").notNull(),
  /** In the person's own words, beside the category. Required for goodwill. */
  note: text("note"),
  issuedOn: date("issued_on"),
  currency: currency(),
  subtotal: money("subtotal").notNull().default("0"),
  taxTotal: money("tax_total").notNull().default("0"),
  total: money("total").notNull().default("0"),
  /** How much of it has been put against an invoice. */
  amountApplied: money("amount_applied").notNull().default("0"),
  /**
   * How much of it has been given back as money, or is on its way back to a
   * card: see `credit_note_payout`. Counted from the moment a card refund is
   * asked for, so the same credit cannot be used on an invoice while the
   * money is in flight.
   */
  amountPaidOut: money("amount_paid_out").notNull().default("0"),
  /** What is left to apply. Credit sitting on the account, which is a liability. */
  balance: money("balance").notNull().default("0"),
  issuedByUserId: uuid("issued_by_user_id").references(() => user.id, { onDelete: "set null" }),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  sourceRefIdx: sourceRefIndex("credit_note_source_ref_idx", t),
  /** UNIQUE for the same reason as the invoice and job numbers. */
  numberIdx: uniqueIndex("credit_note_number_idx").on(t.organizationId, t.number),
  customerIdx: index("credit_note_customer_idx").on(t.organizationId, t.customerId, t.status),
  invoiceIdx: index("credit_note_invoice_idx").on(t.invoiceId),
}));

export const creditNoteLine = pgTable("credit_note_line", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  creditNoteId: uuid("credit_note_id").notNull().references(() => creditNote.id, { onDelete: "cascade" }),
  /**
   * The invoice line this credits, when it credits one.
   *
   * What makes a credit note answerable rather than a lump: "we took the
   * capacitor off" is a different conversation from "we took two hundred
   * dollars off", and only the first one tells anybody what to fix.
   */
  invoiceLineId: uuid("invoice_line_id").references(() => invoiceLine.id, { onDelete: "set null" }),
  sortOrder: integer("sort_order").notNull().default(0),
  name: text("name").notNull(),
  description: text("description"),
  quantity: money("quantity").notNull().default("1"),
  unitPrice: money("unit_price").notNull().default("0"),
  taxable: boolean("taxable").notNull().default(true),
  /** The rate AS APPLIED on the invoice being credited, never recomputed. */
  taxRate: rate("tax_rate").notNull().default("0"),
  taxAmount: money("tax_amount").notNull().default("0"),
  lineTotal: money("line_total").notNull().default("0"),
  ...timestamps,
}, (t) => ({ noteIdx: index("credit_note_line_note_idx").on(t.creditNoteId) }));

/**
 * Where a credit went, invoice by invoice.
 *
 * The same shape as `payment_allocation` and for the same reason: a credit can
 * span invoices and an invoice can take several credits, so the connection
 * between them is a row rather than a column on either side. Without it, a
 * credit applied to three invoices is three numbers nobody can reconcile back
 * to the document that created them.
 */
export const creditNoteApplication = pgTable("credit_note_application", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  creditNoteId: uuid("credit_note_id").notNull().references(() => creditNote.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id, { onDelete: "cascade" }),
  amount: money("amount").notNull(),
  appliedOn: date("applied_on"),
  ...timestamps,
}, (t) => ({
  noteIdx: index("credit_note_application_note_idx").on(t.creditNoteId),
  invoiceIdx: index("credit_note_application_invoice_idx").on(t.invoiceId),
}));

/**
 * CREDIT PAID OUT AS MONEY.
 *
 * The third thing that can happen to credit a customer holds, beside using it
 * on an invoice and leaving it on the account: giving it back. Back to the
 * card they paid with, as a refund through the card processor against one of
 * their earlier card payments, or by cash or cheque handed over and recorded.
 *
 * A ROW OF ITS OWN, NOT A NEGATIVE APPLICATION. An application settles an
 * invoice and moves no cash; a payout moves cash and settles nothing. Its
 * posting takes the credit out of customer deposits against cash
 * (`ledger.postCreditNotePayout`), which is neither a refund of a payment
 * (that puts the receivable back) nor a void (that puts the revenue back).
 *
 * A card payout is `pending` from the moment the processor is asked until it
 * reports the refund, and only then is it posted, exactly as a card refund
 * is: a refund that was asked for has not moved money. Cash and cheques are
 * `paid` when recorded, because the person recording it handed it over.
 */
export const creditNotePayout = pgTable("credit_note_payout", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  creditNoteId: uuid("credit_note_id").notNull().references(() => creditNote.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  /** `card` back through the processor; `cash`, `check` or `other` handed over by hand. */
  method: text("method").notNull(),
  /** `pending` while a card refund is on its way, `paid` once it has moved, `failed` if it never will. */
  status: text("status").notNull().default("pending"),
  currency: currency(),
  amount: money("amount").notNull(),
  /** The earlier card payment the refund goes back through. Null for cash and cheques. */
  paymentId: uuid("payment_id"),
  processor: text("processor"),
  /** The processor's id for the refund, which is what its webhook names. */
  processorRefundId: text("processor_refund_id"),
  /** A cheque number or a note of how the cash went. */
  reference: text("reference"),
  /** The company's day it was paid, once it was. */
  paidOn: date("paid_on"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  note: text("note"),
  /** Why a card refund did not go, in the processor's words. */
  failureReason: text("failure_reason"),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  noteIdx: index("credit_note_payout_note_idx").on(t.creditNoteId),
  refundIdx: index("credit_note_payout_refund_idx").on(t.organizationId, t.processorRefundId),
  paymentIdx: index("credit_note_payout_payment_idx").on(t.paymentId),
}));

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
  /**
   * Of `refundedAmount`, what went back to the card to pay out a credit note
   * rather than to give back money this payment paid. It reopens nothing:
   * the invoices it paid stay paid and the money it held stays held, so it
   * is left out of what the payment still holds (`billing.unappliedOf`).
   * `refundedAmount` keeps it, because that is what the processor reports.
   */
  paidOutAmount: money("paid_out_amount").notNull().default("0"),
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
  sourceRefIdx: sourceRefIndex("payment_source_ref_idx", t),
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
  /**
   * THE BRANCH THE ENTRY BELONGS TO, written by `writePosting` for every
   * posting made from here on: a journal line's own, else the branch of the
   * invoice or job the posting came from (see `services/ledger-branch.ts`).
   * NULL is not "every branch". It is a posting made before branches were
   * carried (nothing old is migrated, and this table cannot be updated), or
   * one that cannot be traced to a single branch: payroll, the release of
   * deferred revenue, a payment spread over invoices in two branches. The
   * ledger reports say how much of what they show is that.
   */
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
  /** A branch's trial balance and journal: one company's entries in one branch, in time order. */
  unitIdx: index("ledger_entry_unit_idx").on(t.organizationId, t.businessUnitId, t.occurredAt),
  sourceIdx: index("ledger_entry_source_idx").on(t.sourceType, t.sourceId),
  /** A customer's statement reads their receivable and what is held for them, in order. */
  customerIdx: index("ledger_entry_customer_idx").on(t.organizationId, t.customerId, t.occurredAt),
}));
