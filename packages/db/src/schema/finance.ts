import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, integer, jsonb, index, uniqueIndex, timestamp, date, check } from "drizzle-orm/pg-core";
import { pk, money, currency } from "./_shared";
import { organization, user, businessUnit } from "./tenancy";
import { customer } from "./crm";
import { estimate, invoice, payment } from "./billing";
import { jobType } from "./work";
import { integrationConnection } from "./integrations";

/**
 * FINANCE: CONSUMER FINANCING, COSTING RATES, THE BUDGET AND MANUAL JOURNALS
 *
 * Four things an owner named together as "run job costing and financing",
 * and each one is a small table because the arithmetic lives elsewhere: the
 * monthly figure, the burden and the variance are in packages/core, and the
 * money itself is on the ledger.
 *
 * None of these tables is soft deleted, and none carries `deleted_at`. A loan
 * application is a fact about a lender; a rate is replaced by a later dated
 * one or removed outright; a budget line is overwritten; and a journal is
 * reversed, never removed.
 */

/** Mirrors `financing.APPLICATION_STATUSES` in core, which says what each means. */
export const financingStatus = pgEnum("financing_status", [
  "sent", "applied", "approved", "declined", "expired", "funded", "cancelled",
]);

/**
 * ONE LOAN APPLICATION, FOR ONE ESTIMATE OR ONE INVOICE.
 *
 * WHAT IS NOT HERE IS THE POINT. No credit score, no income, no date of birth,
 * no reason for a decline. The customer gives those to the lender on the
 * lender's own page, and this product keeps the status the lender returns,
 * the amount it approved and the offer the customer chose, because that is
 * all the company needs to finish the job and get paid, and anything more is
 * credit data this company would then have to protect.
 */
export const financingApplication = pgTable("financing_application", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => integrationConnection.id),
  /** The connection's provider key, copied so a report survives a reconnection. */
  provider: text("provider").notNull(),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  invoiceId: uuid("invoice_id").references(() => invoice.id),
  estimateId: uuid("estimate_id").references(() => estimate.id),
  /** The option on the estimate it was for, when there was a choice. */
  estimateOptionId: uuid("estimate_option_id"),
  status: financingStatus("status").notNull().default("sent"),
  currency: currency(),
  /** What the customer was asked to borrow: the invoice balance or the option's total, read here, never typed. */
  amount: money("amount").notNull(),
  /** The lender's id for the application. */
  externalId: text("external_id").notNull(),
  /** Where the customer applies. The lender's page, not ours. */
  applicationUrl: text("application_url").notNull(),
  approvedAmount: money("approved_amount"),
  /** The offer the customer accepted, as the lender reported it: months, APR and the payment. */
  chosenOffer: jsonb("chosen_offer").$type<{ months: number; aprPercent: string; monthlyPayment: string | null }>(),
  fundedAmount: money("funded_amount"),
  /**
   * What the lender kept. Null when it did not say, which is different from
   * zero and is shown as unknown rather than counted as free.
   */
  feeAmount: money("fee_amount"),
  fundedAt: timestamp("funded_at", { withTimezone: true }),
  /** The payment the funding became, recorded through the ordinary payments path. */
  paymentId: uuid("payment_id").references(() => payment.id),
  /** How the link reached the customer: from their own portal page, or texted or emailed by the office. */
  sentVia: text("sent_via").notNull(),
  sentTo: text("sent_to"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** Something the office has to look at that the status cannot say, such as a refund after funding. */
  attention: text("attention"),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /** A lender's id names one application here. A webhook finds it by this. */
  externalIdx: uniqueIndex("financing_application_external_idx").on(t.connectionId, t.externalId),
  invoiceIdx: index("financing_application_invoice_idx").on(t.invoiceId),
  estimateIdx: index("financing_application_estimate_idx").on(t.estimateId),
  orgIdx: index("financing_application_org_idx").on(t.organizationId, t.status, t.createdAt),
  subject: check("financing_application_subject", sql`(${t.invoiceId} is not null) <> (${t.estimateId} is not null)`),
}));

/* ------------------------------------------------------------- costing */

/** Mirrors `costing.COMPONENTS` in core. */
export const costingComponent = pgEnum("costing_component", [
  "payroll_taxes", "benefits", "workers_comp", "overhead",
]);

/** Mirrors `costing.BASES` in core, which says which component may use which. */
export const costingBasis = pgEnum("costing_basis", [
  "percent_of_wages", "per_hour", "per_job", "percent_of_revenue",
]);

/**
 * A RATE AND THE DAY IT TOOK EFFECT.
 *
 * A history rather than a setting: the rate in effect for a component on a
 * day is the latest row on or before it, so raising workers' compensation in
 * July does not reprice March. A zero switches a component off from a date.
 *
 * Overhead can be a mix: several rows on one day, one per basis, are the
 * parts charged from that day (see `costing.overheadMixOn` in core). A burden
 * component has one rate a day, which the service holds to.
 */
export const costingRate = pgTable("costing_rate", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  component: costingComponent("component").notNull(),
  basis: costingBasis("basis").notNull(),
  /** A percentage ("7.65") or an amount ("4.50"), by the basis. */
  rate: money("rate").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  note: text("note"),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /**
   * One rate per component and basis per day, or "which rate applied on the
   * 1st" has two answers. The basis is in it for overhead's mix; that a burden
   * has one basis a day is checked by the service, in words.
   */
  partDayIdx: uniqueIndex("costing_rate_part_day_idx").on(t.organizationId, t.component, t.basis, t.effectiveFrom),
}));

/* -------------------------------------------------------------- budget */

/** Mirrors `budget.FORECAST_METHODS` in core, which says what each does. */
export const budgetForecastMethod = pgEnum("budget_forecast_method", ["budget", "run_rate", "seasonal"]);

/** A company's budget for one calendar year. */
export const budget = pgTable("budget", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  year: integer("year").notNull(),
  note: text("note"),
  /**
   * How the year end forecast takes the months still to come: at their
   * budget, the default, at the run rate of the months already over, or
   * shaped like last year, month by month (`seasonal`). One
   * choice for the year, so everybody reading the report reads the same
   * forecast, and it applies to a branch's and a job type's report too.
   */
  forecastMethod: budgetForecastMethod("forecast_method").notNull().default("budget"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  yearIdx: uniqueIndex("budget_year_idx").on(t.organizationId, t.year),
}));

/**
 * One number: a line of the budget in one month.
 *
 * `line` is `category:revenue` or `account:6100` (see `budget.parseLine` in
 * core), as text rather than two nullable columns, so "one figure per line
 * per month" is a plain unique index.
 */
export const budgetLine = pgTable("budget_line", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  budgetId: uuid("budget_id").notNull().references(() => budget.id, { onDelete: "cascade" }),
  /**
   * The branch this figure is for, or null for the whole company's own line.
   *
   * The two are kept apart rather than added together. A company that sets
   * Revenue for the whole company and Revenue for each shop has said two
   * things, and whether the shops add up to the company is its own business:
   * adding them would count the money twice for one company and not at all
   * for another. Every line written before branches had budgets is the
   * company's, and nothing old is moved.
   */
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "cascade" }),
  /**
   * The job type this figure is for, or null. A line is the company's, one
   * branch's, one job type's, or one job type's in one branch ("service in the
   * north shop"), for the reason the branch's are kept apart from the
   * company's: each is its own statement, and nothing adds them together, so
   * a branch's own line and that branch's line for one job type are two.
   */
  jobTypeId: uuid("job_type_id").references(() => jobType.id, { onDelete: "cascade" }),
  line: text("line").notNull(),
  month: integer("month").notNull(),
  amount: money("amount").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /** One figure per line per month for the whole company... */
  cellIdx: uniqueIndex("budget_line_cell_idx").on(t.budgetId, t.line, t.month)
    .where(sql`${t.businessUnitId} is null and ${t.jobTypeId} is null`),
  /** ...one per line per month for each branch. Separate indexes, because a null branch is not equal to itself... */
  branchCellIdx: uniqueIndex("budget_line_branch_cell_idx").on(t.budgetId, t.businessUnitId, t.line, t.month)
    .where(sql`${t.businessUnitId} is not null and ${t.jobTypeId} is null`),
  /** ...one per line per month for each job type... */
  jobTypeCellIdx: uniqueIndex("budget_line_job_type_cell_idx").on(t.budgetId, t.jobTypeId, t.line, t.month)
    .where(sql`${t.jobTypeId} is not null and ${t.businessUnitId} is null`),
  /** ...and one per line per month for each job type in each branch. */
  branchJobTypeCellIdx: uniqueIndex("budget_line_branch_job_type_cell_idx")
    .on(t.budgetId, t.businessUnitId, t.jobTypeId, t.line, t.month)
    .where(sql`${t.businessUnitId} is not null and ${t.jobTypeId} is not null`),
  monthCheck: check("budget_line_month", sql`${t.month} between 1 and 12`),
}));

/* ------------------------------------------------------------ journals */

/**
 * A MANUAL JOURNAL ENTRY: the header. The lines are the ledger entries it
 * posted (`source_type = 'journal'`, `source_id` = this id), because the
 * ledger is the record and a second copy of the lines is a second thing that
 * could disagree with it.
 *
 * Reversed, never edited or removed. `reverses_journal_id` points a reversal
 * at the entry it takes back, and the unique index on it means an entry can be
 * reversed once.
 */
export const journalEntry = pgTable("journal_entry", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  /** The day it is booked on, in the company's calendar. */
  occurredOn: date("occurred_on").notNull(),
  memo: text("memo").notNull(),
  currency: currency(),
  /** Debits, which equal credits. Kept for the list, so it is not summed from the ledger on every row. */
  total: money("total").notNull(),
  reversesJournalId: uuid("reverses_journal_id"),
  ledgerTransactionId: uuid("ledger_transaction_id").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  numberIdx: uniqueIndex("journal_entry_number_idx").on(t.organizationId, t.number),
  reversesIdx: uniqueIndex("journal_entry_reverses_idx").on(t.reversesJournalId)
    .where(sql`reverses_journal_id is not null`),
  orgIdx: index("journal_entry_org_idx").on(t.organizationId, t.occurredOn),
}));
