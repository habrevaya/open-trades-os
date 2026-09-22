import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { pk, timestamps, sourceRef, money, rate } from "./_shared";
import { organization } from "./tenancy";
import { customer, property, contact } from "./crm";
import { job } from "./work";
import { invoice } from "./billing";

/**
 * THE COMMERCIAL ARRANGEMENT
 *
 * Research across ten business models found that our original design encoded a
 * single assumption so deeply it was invisible: ONE customer who owns the
 * property, approves the work, receives the invoice and pays it, at a price
 * from our own price book, with no intermediary.
 *
 * That is true for residential service and false for roughly half the market:
 *
 *   commercial FM      a facilities network orders it, a store manager is on
 *                      site, the client approves against a ceiling, and a
 *                      corporate AP portal pays a contract rate card
 *   property mgmt      a manager orders, a tenant is on site, an owner pays
 *   home warranty      a warranty company orders, approves and pays, while the
 *                      homeowner pays only the call fee
 *   builder            a superintendent orders, the GC approves, the builder
 *                      pays on draws against our bid
 *   restoration        the homeowner requests, an adjuster approves, the
 *                      carrier pays most and the homeowner pays the deductible
 *
 * These tables are the fix. They are here in the first migrations rather than
 * later because invoicing, communications and the portal all resolve "who"
 * from the job, and changing that after those exist rewrites all three.
 */

// ---------------------------------------------------------------------------
// 1. The party problem
// ---------------------------------------------------------------------------

export const partyRole = pgEnum("party_role", [
  "requester",     // who asked for the work
  "site_contact",  // who is actually there
  "approver",      // who authorizes scope and spend
  "bill_to",       // who receives the invoice
  "payer",         // who the money comes from, which is often not bill_to
  "referrer",      // who sent the work, for attribution and fee
  "owner",         // who owns the property, when that is nobody above
]);

/**
 * Replaces "the customer on the job" with the set of parties involved.
 *
 * Residential is the degenerate case: one customer holding every role, written
 * as one row with role 'requester' plus the job's own customer_id. Nothing
 * about the simple case gets harder, which is the test a change like this has
 * to pass.
 */
export const jobParty = pgTable("job_party", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  role: partyRole("role").notNull(),
  /** A party is a customer, a contact, or an external organization we do not bill. */
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contact.id, { onDelete: "set null" }),
  /** For a party with no record of their own: "ABC Warranty, claim 44812". */
  externalName: text("external_name"),
  externalReference: text("external_reference"),
  /** Splits a bill across payers: a carrier at 0.9 and a homeowner deductible. */
  sharePercent: rate("share_percent"),
  shareAmount: money("share_amount"),
  notes: text("notes"),
  ...timestamps,
}, (t) => ({
  jobIdx: index("job_party_job_idx").on(t.jobId, t.role),
  customerIdx: index("job_party_customer_idx").on(t.organizationId, t.customerId),
}));

// ---------------------------------------------------------------------------
// 2. The ceiling problem
// ---------------------------------------------------------------------------

export const authorizationState = pgEnum("authorization_state", [
  "requested", "granted", "exceeded", "denied", "expired", "superseded",
]);

/**
 * Not-to-exceed, coverage limit, approval limit and authorisation number are
 * all the same concept: a maximum we may not bill past without a separate
 * approval event.
 *
 * Job completion and invoicing both have to respect it, which is why it exists
 * before either is written. Bolting it on later means retro-validating every
 * path that can produce a charge.
 */
export const authorization = pgTable("authorization", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "cascade" }),
  estimateId: uuid("estimate_id"),
  state: authorizationState("state").notNull().default("requested"),
  /** The ceiling. Null means authorized with no stated limit. */
  amount: money("amount"),
  /** Consumed so far, maintained as charges land, for a fast breach check. */
  consumedAmount: money("consumed_amount").notNull().default("0"),
  /** Who granted it: an FM client, a property manager, a warranty company. */
  grantedByPartyId: uuid("granted_by_party_id").references(() => jobParty.id, { onDelete: "set null" }),
  grantedByName: text("granted_by_name"),
  /** Their reference. A warranty authorisation number, a PM approval id. */
  externalReference: text("external_reference"),
  grantedAt: timestamp("granted_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** Chain when a supplement raises an earlier ceiling. */
  supersedesId: uuid("supersedes_id"),
  scopeNotes: text("scope_notes"),
  ...timestamps,
}, (t) => ({
  jobIdx: index("authorization_job_idx").on(t.jobId, t.state),
  openIdx: index("authorization_open_idx").on(t.organizationId, t.state, t.expiresAt),
}));

// ---------------------------------------------------------------------------
// 3. The external work order problem
// ---------------------------------------------------------------------------

export const externalWorkOrderState = pgEnum("external_work_order_state", [
  "offered", "accepted", "rejected", "in_progress", "completed",
  "cancelled_by_client", "reopened", "invoiced", "closed",
]);

/**
 * In five segments the work order is created elsewhere and we mirror it.
 *
 * The invariant that matters, and the reason this is not just a few columns on
 * `job`: THE EXTERNAL SYSTEM IS THE SYSTEM OF RECORD. A local edit that
 * conflicts loses or escalates. Some networks make acceptance irreversible,
 * and some will only accept a prebilled work order via an invoice submission.
 * Every status transition has to know whether it owes a push.
 */
export const externalWorkOrder = pgTable("external_work_order", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  /** "corrigo", "servicechannel", "ahs", "carrier-dealer", "angi". */
  sourceSystem: text("source_system").notNull(),
  externalId: text("external_id").notNull(),
  /** What the client calls it, which is what everyone quotes on the phone. */
  externalNumber: text("external_number"),
  state: externalWorkOrderState("state").notNull().default("offered"),
  /** Their status string verbatim, because ours will never map cleanly. */
  externalStatus: text("external_status"),
  /** True when their system wins a conflict. Effectively always, hence the default. */
  externalIsSystemOfRecord: boolean("external_is_system_of_record").notNull().default(true),
  /** Some networks make acceptance final. Guarded here, not in a code comment. */
  acceptanceIsIrreversible: boolean("acceptance_is_irreversible").notNull().default(false),
  /** Some accept only by submitting an invoice, with no separate accept call. */
  acceptsViaInvoiceOnly: boolean("accepts_via_invoice_only").notNull().default(false),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  /** Set when a local change is waiting to be pushed back. */
  pendingPush: boolean("pending_push").notNull().default(false),
  lastPushError: text("last_push_error"),
  ...timestamps,
}, (t) => ({
  uniq: uniqueIndex("external_work_order_uniq_idx").on(t.organizationId, t.sourceSystem, t.externalId),
  pushIdx: index("external_work_order_push_idx").on(t.organizationId, t.pendingPush),
}));

// ---------------------------------------------------------------------------
// 4. The clock problem
// ---------------------------------------------------------------------------

export const obligationState = pgEnum("obligation_state", [
  "open", "satisfied", "breached", "waived", "cancelled",
]);

/**
 * SLAs, acknowledge-by, on-site-by, invoicing windows, warranty registration
 * deadlines and claim windows are all one thing: a deadline attached to a
 * record, with a breach state and a consequence.
 *
 * One primitive rather than a date column on six tables, because the thing
 * everyone actually needs is "what is about to breach", across all of them.
 */
export const obligation = pgTable("obligation", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** "sla.acknowledge", "sla.on_site", "invoice.submit_by", "warranty.register_by". */
  kind: text("kind").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  state: obligationState("state").notNull().default("open"),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  satisfiedAt: timestamp("satisfied_at", { withTimezone: true }),
  breachedAt: timestamp("breached_at", { withTimezone: true }),
  /** What satisfied it, so a scorecard can be audited rather than asserted. */
  satisfiedByEvent: text("satisfied_by_event"),
  /** A chargeback, a scorecard hit, a lost lien right. */
  consequence: text("consequence"),
  escalateAt: timestamp("escalate_at", { withTimezone: true }),
  escalatedAt: timestamp("escalated_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  /** The query everything uses: what is open and about to breach. */
  dueIdx: index("obligation_due_idx").on(t.organizationId, t.state, t.dueAt),
  entityIdx: index("obligation_entity_idx").on(t.entityType, t.entityId),
}));

// ---------------------------------------------------------------------------
// 5. Contracts and rate cards: the price authority problem
// ---------------------------------------------------------------------------

/**
 * Distinct from consumer memberships. An MSA with a commercial client carries a
 * rate card, a covered scope, a site list, SLA terms and an escalation.
 */
export const serviceContract = pgTable("service_contract", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contractNumber: text("contract_number"),
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  autoRenews: boolean("auto_renews").notNull().default(false),
  /** Annual uplift, so year three billing is not a manual exercise. */
  escalationRate: rate("escalation_rate"),
  /** Default ceiling for work under this contract, before a per-job override. */
  defaultNotToExceed: money("default_not_to_exceed"),
  /** Their PO covering the term, required on every invoice by many clients. */
  purchaseOrderNumber: text("purchase_order_number"),
  slaTerms: jsonb("sla_terms").$type<Array<{ kind: string; minutes: number; priority?: string }>>().notNull().default([]),
  coveredScope: text("covered_scope"),
  active: boolean("active").notNull().default(true),
  ...sourceRef,
  ...timestamps,
}, (t) => ({ orgIdx: index("service_contract_org_idx").on(t.organizationId, t.customerId) }));

export const contractSite = pgTable("contract_site", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  contractId: uuid("contract_id").notNull().references(() => serviceContract.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").notNull().references(() => property.id, { onDelete: "cascade" }),
  siteNumber: text("site_number"),
  notToExceed: money("not_to_exceed"),
  ...timestamps,
}, (t) => ({ contractIdx: index("contract_site_contract_idx").on(t.contractId) }));

/**
 * Our price book is not the price authority in five segments. A rate card is a
 * price authority that is not ours: a client contract, a warranty network
 * schedule, a manufacturer labour allowance, an insurance price list.
 *
 * Cost tracking stays ours in every case, which is what keeps margin reporting
 * working even when we did not set the price.
 */
export const rateCard = pgTable("rate_card", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contractId: uuid("contract_id").references(() => serviceContract.id, { onDelete: "cascade" }),
  /** contract | warranty_network | manufacturer_allowance | insurance | brand */
  authority: text("authority").notNull().default("contract"),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("rate_card_org_idx").on(t.organizationId) }));

export const rateCardLine = pgTable("rate_card_line", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  rateCardId: uuid("rate_card_id").notNull().references(() => rateCard.id, { onDelete: "cascade" }),
  /** Their code, which rarely matches ours, hence the mapping to our item. */
  externalCode: text("external_code"),
  priceBookItemId: uuid("price_book_item_id"),
  description: text("description").notNull(),
  unit: text("unit"),
  price: money("price").notNull(),
  /** Labour allowance schedules pay a fixed time, not actual time. */
  allowedMinutes: integer("allowed_minutes"),
  ...timestamps,
}, (t) => ({ cardIdx: index("rate_card_line_card_idx").on(t.rateCardId) }));

// ---------------------------------------------------------------------------
// Invoice delivery: commercial clients rarely accept a PDF by email
// ---------------------------------------------------------------------------

export const invoiceDeliveryChannel = pgEnum("invoice_delivery_channel", [
  "email", "portal_link", "fm_network_api", "cxml", "edi", "mail", "manual",
]);

export const invoiceDelivery = pgTable("invoice_delivery", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id, { onDelete: "cascade" }),
  channel: invoiceDeliveryChannel("channel").notNull(),
  destination: text("destination"),
  externalReference: text("external_reference"),
  /** Several networks make an invoice immutable once submitted. */
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  disputedAt: timestamp("disputed_at", { withTimezone: true }),
  disputeReason: text("dispute_reason"),
  error: text("error"),
  ...timestamps,
}, (t) => ({ invoiceIdx: index("invoice_delivery_invoice_idx").on(t.invoiceId) }));
