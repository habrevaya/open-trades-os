import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { pk, timestamps, sourceRef, money, rate } from "./_shared";
import { organization, businessUnit } from "./tenancy";
import { customer, property, equipment } from "./crm";
import { job, jobType } from "./work";
import { invoice } from "./billing";

/**
 * RECURRING WORK AND AGREEMENTS
 *
 * A note on the name, because it collided and the collision was worth fixing
 * rather than aliasing. `membership` already means a USER belonging to an
 * ORGANIZATION, in tenancy.ts. What this file describes is a CUSTOMER buying
 * recurring service. Two unrelated concepts sharing a word is how somebody
 * eventually joins the wrong one, so the customer-facing concept is
 * `agreement` throughout.
 *
 * It is also deliberately ONE concept. The industry says "membership" for
 * residential and "service agreement" for commercial, and at least one major
 * platform models them as two separate things, which means two of everything:
 * two billing paths, two visit generators, two renewal reports. They are the
 * same object with different marketing, and they are modelled once here.
 *
 * Maintenance agreements are the single biggest lever on what a home services
 * company is worth. A shop with four hundred members on auto renew sells for a
 * different multiple than an identical shop doing the same revenue in one off
 * calls, because one has predictable revenue and a reason for the customer to
 * call them first, and the other has neither.
 *
 * Three things have to be right or the module is decorative:
 *
 * 1. The agreement GENERATES ITS OWN VISITS. A plan that includes two tune ups
 *    a year and relies on somebody remembering to book them is a plan that
 *    quietly does not get delivered, and the first time anyone notices is at
 *    renewal when the customer says they never saw us.
 *
 * 2. Billing and delivery are SEPARATE SCHEDULES. A customer can pay monthly
 *    and be visited twice a year. Tying visit generation to billing, which is
 *    the obvious shortcut, breaks the moment somebody prepays annually.
 *
 * 3. Money billed is not money earned. Twelve months collected up front is a
 *    liability that unwinds as visits are delivered. Recognising it on receipt
 *    overstates a good month and leaves nothing behind for the eleven months
 *    of obligation that follow.
 */

// ---------------------------------------------------------------------------
// The recurrence primitive, shared by agreements, route stops and contracts
// ---------------------------------------------------------------------------

/**
 * The four recurrence models found in the wild. Named explicitly because a
 * migration has to reconstruct whichever one the old system used, and because
 * picking the wrong one silently drifts every future date.
 */
export const recurrenceModel = pgEnum("recurrence_model", [
  /** A rule plus an anchor. Occurrences computed. Calendar style. */
  "rule",
  /** Every future occurrence exists as a real row. Editable individually. */
  "materialized",
  /**
   * Next occurrence measured from when the last one ACTUALLY completed, not
   * from the calendar. Pool, pest, lawn and bin cleaning all work this way,
   * and a system storing only a cadence drifts a little on every rain day.
   */
  "anchored_to_completion",
  /** No rule at all. The office rebooks by hand each cycle. */
  "manual",
]);

export const recurringSchedule = pgTable("recurring_schedule", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  model: recurrenceModel("model").notNull().default("rule"),

  /**
   * WHO THE RECURRING WORK IS FOR.
   *
   * The table shipped with a recurrence spec and no subject: a cadence, a
   * horizon and an exception list, with nothing saying whose pool it was.
   * Nothing could have created a job from it, which is why nothing did.
   *
   * Distinct from an agreement's included visits, which have their own
   * table. A pool route, a quarterly pest treatment and a commercial filter
   * change are recurring WORK, billed per visit or on a contract, and a
   * company can run them without selling anybody a membership.
   */
  label: text("label").notNull().default(""),
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").references(() => property.id, { onDelete: "cascade" }),
  jobTypeId: uuid("job_type_id").references(() => jobType.id, { onDelete: "set null" }),
  /** What goes on the job. The customer's words for the work, not a code. */
  summary: text("summary").notNull().default(""),
  estimatedDurationMinutes: integer("estimated_duration_minutes"),

  /** iCalendar RRULE for the rule model. Null for the others. */
  rule: text("rule"),
  /** Plain language, for the UI. Derived, never parsed back. */
  friendly: text("friendly"),
  /** Days between occurrences, for the anchored model. */
  intervalDays: integer("interval_days"),
  /**
   * Seasonal anchoring. A heating tune up belongs in autumn regardless of when
   * the agreement was sold, so a plan can pin occurrences to months rather
   * than counting forward from the sale date.
   */
  anchorMonths: jsonb("anchor_months").$type<number[]>().notNull().default([]),

  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on"),
  /** Set for both anchored and rule models. The thing everything counts from. */
  lastOccurredOn: date("last_occurred_on"),
  nextDueOn: date("next_due_on"),

  /**
   * How far ahead occurrences are created. Bounded on purpose: materialising
   * an infinite series fills the dispatch board with rows nobody will ever
   * look at, and materialising nothing means the board is empty next week.
   */
  horizonMonths: integer("horizon_months").notNull().default(12),

  /**
   * Skipped and moved occurrences. A customer who declined a visit is data,
   * not noise: losing it means re-offering something they already refused.
   */
  exceptions: jsonb("exceptions").$type<Array<{
    date: string;
    action: "skipped" | "moved" | "cancelled";
    movedTo?: string;
    reason?: string;
  }>>().notNull().default([]),

  active: boolean("active").notNull().default(true),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  /** The generator's query: what is due inside the horizon. */
  dueIdx: index("recurring_schedule_due_idx").on(t.organizationId, t.active, t.nextDueOn),
}));

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const billingFrequency = pgEnum("billing_frequency", [
  "monthly", "quarterly", "semiannual", "annual", "one_time",
]);

export const agreementPlan = pgTable("agreement_plan", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code"),
  description: text("description"),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),

  price: money("price").notNull(),
  billingFrequency: billingFrequency("billing_frequency").notNull().default("monthly"),
  termMonths: integer("term_months").notNull().default(12),
  autoRenews: boolean("auto_renews").notNull().default(true),
  /** Days before renewal the customer must be told. Drives a reminder job. */
  renewalNoticeDays: integer("renewal_notice_days").notNull().default(30),

  /** How many visits the price includes, and how often they land. */
  includedVisitsPerTerm: integer("included_visits_per_term").notNull().default(0),
  visitJobTypeId: uuid("visit_job_type_id"),
  visitRecurrenceModel: recurrenceModel("visit_recurrence_model").notNull().default("rule"),
  visitIntervalDays: integer("visit_interval_days"),
  /** Seasonal plans pin visits to months: spring cooling, autumn heating. */
  visitAnchorMonths: jsonb("visit_anchor_months").$type<number[]>().notNull().default([]),
  /**
   * Which day of an anchor month, clamped to the month's length.
   *
   * Null means the day the agreement was SOLD, which is what this product
   * did before the column existed and is why it defaults to null rather
   * than to a number: picking one would move every future sale's visit
   * dates the day it shipped, and nothing on any screen would say why.
   *
   * A company that wants its spring visits on the 15th sets it here. One
   * that never looks keeps the behaviour it already had.
   */
  visitAnchorDay: integer("visit_anchor_day"),

  /** Member benefits, which are the reason anyone renews. */
  discountRate: rate("discount_rate"),
  priorityDispatch: boolean("priority_dispatch").notNull().default(false),
  waivesDiagnosticFee: boolean("waives_diagnostic_fee").notNull().default(false),
  waivesAfterHoursRate: boolean("waives_after_hours_rate").notNull().default(false),
  extendedWarrantyMonths: integer("extended_warranty_months"),
  benefits: jsonb("benefits").$type<string[]>().notNull().default([]),

  /**
   * Where deferred revenue sits until a visit is delivered. Separate from the
   * revenue account because an unearned obligation is a liability.
   */
  deferredAccountCode: text("deferred_account_code"),
  revenueAccountCode: text("revenue_account_code"),

  tradePackId: text("trade_pack_id"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  orgIdx: index("agreement_plan_org_idx").on(t.organizationId, t.active),
  codeIdx: uniqueIndex("agreement_plan_code_idx").on(t.organizationId, t.code),
}));

// ---------------------------------------------------------------------------
// Enrollments
// ---------------------------------------------------------------------------

export const agreementStatus = pgEnum("agreement_status", [
  "pending", "active", "past_due", "paused", "lapsed", "cancelled", "completed",
]);

export const agreement = pgTable("agreement", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").notNull().references(() => agreementPlan.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  /** A plan is usually sold against a property, sometimes a specific unit. */
  propertyId: uuid("property_id").references(() => property.id, { onDelete: "cascade" }),
  equipmentId: uuid("equipment_id").references(() => equipment.id, { onDelete: "set null" }),

  status: agreementStatus("status").notNull().default("pending"),
  startedOn: date("started_on").notNull(),
  endsOn: date("ends_on"),
  cancelledOn: date("cancelled_on"),
  cancellationReason: text("cancellation_reason"),

  /** Frozen at sale. Raising the plan price must not reprice existing members. */
  price: money("price").notNull(),
  billingFrequency: billingFrequency("billing_frequency").notNull(),
  autoRenews: boolean("auto_renews").notNull().default(true),
  renewalCount: integer("renewal_count").notNull().default(0),
  renewalNoticeSentAt: timestamp("renewal_notice_sent_at", { withTimezone: true }),

  /** Delivery, kept deliberately separate from billing below. */
  visitScheduleId: uuid("visit_schedule_id").references(() => recurringSchedule.id, { onDelete: "set null" }),
  visitsIncludedThisTerm: integer("visits_included_this_term").notNull().default(0),
  visitsDeliveredThisTerm: integer("visits_delivered_this_term").notNull().default(0),

  /** Stripe subscription, when billing runs through the platform. */
  processorSubscriptionId: text("processor_subscription_id"),

  ...sourceRef,
  ...timestamps,
}, (t) => ({
  customerIdx: index("agreement_customer_idx").on(t.organizationId, t.customerId),
  /** Renewals due, and lapsed members to win back. Both are campaigns. */
  renewalIdx: index("agreement_renewal_idx").on(t.organizationId, t.status, t.endsOn),
  propertyIdx: index("agreement_property_idx").on(t.propertyId),
}));

/**
 * One row per visit the agreement owes, created when the term starts.
 *
 * Existing up front rather than being generated lazily is what makes "which
 * members have not had their visit yet" a query instead of an investigation,
 * and that query is the difference between an agreement book that renews and
 * one that quietly does not.
 */
export const agreementVisit = pgTable("agreement_visit", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  agreementId: uuid("agreement_id").notNull().references(() => agreement.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  /** When it should happen. Seasonal plans set this from anchor months. */
  dueOn: date("due_on").notNull(),
  windowStartOn: date("window_start_on"),
  windowEndOn: date("window_end_on"),

  /** Set once booked. Null means owed and unscheduled, which is the report. */
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  deliveredOn: date("delivered_on"),
  skippedOn: date("skipped_on"),
  skipReason: text("skip_reason"),

  /** What this visit is worth, for recognition. Term price over visit count. */
  recognitionAmount: money("recognition_amount"),
  recognizedOn: date("recognized_on"),
  ...timestamps,
}, (t) => ({
  agreementIdx: index("agreement_visit_agreement_idx").on(t.agreementId, t.sequence),
  /** The report that keeps an agreement book alive: owed and unscheduled. */
  owedIdx: index("agreement_visit_owed_idx").on(t.organizationId, t.dueOn, t.jobId),
}));

// ---------------------------------------------------------------------------
// Billing, separate from delivery
// ---------------------------------------------------------------------------

export const billingScheduleStatus = pgEnum("billing_schedule_status", [
  "scheduled", "invoiced", "paid", "failed", "skipped", "cancelled",
]);

export const agreementBilling = pgTable("agreement_billing", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  agreementId: uuid("agreement_id").notNull().references(() => agreement.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  dueOn: date("due_on").notNull(),
  amount: money("amount").notNull(),
  status: billingScheduleStatus("status").notNull().default("scheduled"),
  invoiceId: uuid("invoice_id").references(() => invoice.id, { onDelete: "set null" }),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastError: text("last_error"),
  ...timestamps,
}, (t) => ({
  agreementIdx: index("agreement_billing_agreement_idx").on(t.agreementId, t.sequence),
  dueIdx: index("agreement_billing_due_idx").on(t.organizationId, t.status, t.dueOn),
}));

/**
 * DEFERRED REVENUE
 *
 * Twelve months collected up front is not twelve months earned. It is a
 * liability that unwinds as the obligation is delivered, and a company that
 * recognises it on receipt shows a spectacular month followed by eleven months
 * of servicing work with no revenue attached to it.
 *
 * Materialised as rows rather than computed, because the schedule has to
 * survive a plan price change, a cancellation and a partial refund, and a
 * function that recomputes from current values cannot.
 */
export const deferredRevenueEntry = pgTable("deferred_revenue_entry", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  agreementId: uuid("agreement_id").references(() => agreement.id, { onDelete: "cascade" }),
  agreementVisitId: uuid("agreement_visit_id").references(() => agreementVisit.id, { onDelete: "set null" }),
  invoiceId: uuid("invoice_id").references(() => invoice.id, { onDelete: "set null" }),

  amount: money("amount").notNull(),
  /** When it is expected to be earned, versus when it actually was. */
  scheduledFor: date("scheduled_for").notNull(),
  recognizedOn: date("recognized_on"),
  /** The balanced pair written when it is recognised. */
  ledgerTransactionId: uuid("ledger_transaction_id"),
  /** Set when a cancellation releases the remaining balance early. */
  releasedOn: date("released_on"),
  releaseReason: text("release_reason"),
  ...timestamps,
}, (t) => ({
  /** The balance sheet number: unrecognised and not released. */
  openIdx: index("deferred_revenue_open_idx").on(t.organizationId, t.recognizedOn, t.scheduledFor),
  agreementIdx: index("deferred_revenue_agreement_idx").on(t.agreementId),
}));
