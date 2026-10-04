import { pgTable, pgEnum, uuid, text, integer, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { pk, timestamps, money, rate } from "./_shared";
import { organization, businessUnit } from "./tenancy";
import { customer, property } from "./crm";
import { job } from "./work";
import { invoice } from "./billing";

/**
 * M12. WORK THAT IS LONGER THAN A VISIT.
 *
 * A job in this product is one visit's worth of work, or a few: it has a
 * summary, a status that runs from lead to complete, a total, and visits
 * hanging off it. A bathroom refit, a system changeout and a commercial fit
 * out are none of those things. They run for weeks, they have phases that
 * cannot start until another phase finishes, they are billed in draws as the
 * work progresses rather than once at the end, and somebody is watching the
 * spend against a budget the whole time.
 *
 * ================================================================
 * IS A PROJECT A PARENT JOB? THE ARGUMENT, BOTH WAYS.
 * ================================================================
 *
 * `job.parent_job_id` already exists and already makes one job the parent of
 * others, so the cheap answer is to make a project a job with children.
 *
 * FOR THE PARENT JOB. Nothing new to build: visits, job lines, invoices, the
 * audit trail, custom fields, scope filtering and every report in the
 * catalogue already work on a job, and a project would inherit all of it on
 * day one. The dispatch board would show the phases without changing. Job
 * costing would roll up by following `parent_job_id`, which is one recursive
 * query rather than a new set of tables. Users already understand a job.
 *
 * AGAINST, AND THIS IS THE ARGUMENT THAT WINS. `parent_job_id` is not a spare
 * column: it has exactly one meaning today and the product depends on that
 * meaning being the only one.
 *
 *   `services/jobs.ts` guards it with `assertCallbackParent`, which refuses a
 *   parent belonging to a different customer and refuses a job being its own
 *   parent, and whose error messages say "return visit" out loud.
 *
 *   `services/reviews.ts` counts rows where `parent_job_id = <job>` and calls
 *   the result the CALLBACK RATE. Phases of a project would be counted as
 *   callbacks against the job that spawned them, which makes the one quality
 *   metric in this product read as though every project were rework.
 *
 *   The same service withholds a review request while a callback is open. A
 *   six phase fit out would suppress the review ask on the parent for the
 *   life of the project, and nobody would ever find out why.
 *
 * Those are not hypothetical costs to be weighed against the convenience:
 * they are two existing features that silently produce wrong numbers the day
 * a project is modelled this way, and neither of them fails loudly.
 *
 * There is a second, structural reason. A job's fields are about one piece of
 * work: a status that is `in_progress`, one completion date, one total. A
 * project needs a budget AND a contract value AND an ordered set of phases
 * with dependencies AND a billing schedule. Hanging all of that on the job
 * table would put six columns on every one of a plumbing company's forty
 * thousand single visit jobs that mean nothing for any of them.
 *
 * SO: A PROJECT IS ITS OWN ENTITY, and the connection to work runs the other
 * way. `job.project_id` and `job.project_phase_id` put a job INSIDE a phase,
 * and `parent_job_id` keeps meaning exactly what it has always meant, which
 * is that this job is rework on that one. A project's job can still have a
 * callback, and that callback is still a callback.
 *
 * WHAT A PROJECT DOES NOT DO. It holds no lines, takes no payment and posts
 * nothing to the ledger. Its jobs do, through the surfaces that already
 * exist, and the project reads them back. There is one copy of the money
 * arithmetic in this product and it is in `services/report-catalogue.ts`.
 */

export const projectStatus = pgEnum("project_status", [
  "planning", "active", "on_hold", "completed", "cancelled",
]);

/**
 * Phase state, which is NOT the same list as project state.
 *
 * `blocked` has no equivalent on a project and is the state the dependency
 * check produces: this phase is ready, its people are free, and the phase it
 * follows is not finished. `on_hold` on a project is a commercial decision
 * and a blocked phase is a consequence of the plan, and a single enum for
 * both would make "why is nothing happening" unanswerable.
 */
export const projectPhaseStatus = pgEnum("project_phase_status", [
  "not_started", "in_progress", "blocked", "complete",
]);

export const project = pgTable("project", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  /** What everybody calls it. "Hillcrest primary bath refit". */
  name: text("name").notNull(),
  description: text("description"),
  status: projectStatus("status").notNull().default("planning"),
  startsOn: date("starts_on"),
  targetCompletionOn: date("target_completion_on"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /**
   * WHAT THE CUSTOMER IS PAYING, which is the ceiling every draw is measured
   * against. Null means it has not been agreed yet, which is a real state for
   * a project in `planning`, and the billing guards refuse a draw while it
   * is null rather than treating an unknown contract as an unlimited one.
   */
  contractValue: money("contract_value"),
  /**
   * WHAT WE EXPECT IT TO COST US. Separate from the contract value and read
   * by a different permission, because one is the price and the other is the
   * margin: `job.cost:read` exists precisely to keep the second off a
   * technician's phone.
   */
  budgetCost: money("budget_cost"),
  /**
   * THE RETAINAGE THE CUSTOMER HOLDS BACK, as a fraction: 0.1 for ten per
   * cent. What a new application for payment starts from, and nothing more:
   * each application keeps its own rate, because lowering retainage at the
   * halfway point is a release and the earlier applications have to keep
   * saying what they said. Null means none is held.
   */
  retainageRate: rate("retainage_rate"),
  ...timestamps,
}, (t) => ({
  orgIdx: index("project_org_idx").on(t.organizationId, t.status),
  customerIdx: index("project_customer_idx").on(t.customerId),
}));

export const projectPhase = pgTable("project_phase", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  /** The order of work, and the number people say out loud. "We are on three." */
  sequence: integer("sequence").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: projectPhaseStatus("status").notNull().default("not_started"),
  /**
   * THE PHASE THIS ONE WAITS FOR.
   *
   * One predecessor rather than a dependency graph, deliberately. Every real
   * trades project this was modelled against is a chain: demolition, then
   * rough in, then inspection, then close up, then finish. A general directed
   * graph would need cycle detection, a critical path and a UI nobody in a
   * four person shop will fill in, and the chain is what the money actually
   * follows. A phase with no predecessor can start whenever.
   */
  dependsOnPhaseId: uuid("depends_on_phase_id"),
  /**
   * The slice of the contract value this phase carries. The sum across phases
   * cannot exceed the project's contract value, and the service refuses the
   * phase that would break it rather than letting a schedule add up to more
   * than the job is worth.
   */
  billingValue: money("billing_value"),
  budgetCost: money("budget_cost"),
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  /**
   * One phase per position. Two phases numbered three means the order of the
   * work depends on which row came back first, and the dependency chain is
   * read in that order.
   */
  sequenceIdx: uniqueIndex("project_phase_sequence_idx").on(t.projectId, t.sequence),
  projectIdx: index("project_phase_project_idx").on(t.organizationId, t.projectId),
}));

/**
 * PROGRESS BILLING: A DRAW.
 *
 * The thing a project most needs and the thing the website says is not built.
 * A fit out is not invoiced once at the end; it is invoiced at thirty per
 * cent when the rough in passes, and again at seventy when the walls close,
 * and the contractor's cash flow is that schedule.
 *
 * A DRAW IS PLANNED BEFORE IT IS RAISED, and the row exists in both states.
 * That is what makes "what is left to bill on this project" a number rather
 * than a conversation, and it is what makes raising one idempotent: the row
 * is the identity of the draw, `invoice_id` is written when the invoice
 * exists, and a retry finds the invoice already attached instead of billing
 * the customer twice.
 *
 * THE AMOUNT IS FROZEN ON THE ROW. A draw is twenty five per cent of a phase
 * at the moment it is raised; re-deriving it later from a phase whose billing
 * value has since been revised would change an amount that has already been
 * invoiced and, once the invoice is paid, already been received.
 */
export const projectDraw = pgTable("project_draw", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  /**
   * Null for a draw against the project rather than one phase: mobilisation,
   * a deposit, the release of retention at the end. Those are real draws and
   * they belong to no phase.
   */
  projectPhaseId: uuid("project_phase_id").references(() => projectPhase.id, { onDelete: "set null" }),
  sequence: integer("sequence").notNull(),
  /** What appears on the invoice line. "Rough in complete, 30%". */
  label: text("label").notNull(),
  /** 0.25 for a quarter. Null on a draw entered as a flat amount. */
  percent: rate("percent"),
  amount: money("amount").notNull(),
  /**
   * Set when this draw became a real invoice, by `services/billing.ts`. Null
   * means planned and not yet billed.
   */
  invoiceId: uuid("invoice_id").references(() => invoice.id, { onDelete: "set null" }),
  raisedAt: timestamp("raised_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  /** One draw per position on a project, for the reason the phase index gives. */
  sequenceIdx: uniqueIndex("project_draw_sequence_idx").on(t.projectId, t.sequence),
  projectIdx: index("project_draw_project_idx").on(t.organizationId, t.projectId),
}));

/**
 * WHICH WORK BELONGS TO WHICH PHASE.
 *
 * A TABLE RATHER THAN TWO COLUMNS ON `job`, for two reasons and the second is
 * the one that would have cost an afternoon.
 *
 * `job` is the hottest table in this schema and the overwhelming majority of
 * rows in it will never be part of a project. A service company running this
 * has forty thousand single visit jobs and six projects, and two columns that
 * are null on every row but six are two columns on every index page of the
 * busiest table in the product.
 *
 * And `schema/billing.ts` already imports `schema/work.ts`, because an
 * invoice points at a job. A `project_id` on `job` would mean `work.ts`
 * imports `projects.ts`, which imports `billing.ts`, which imports
 * `work.ts`: a module scope cycle in the file every other schema file
 * depends on.
 *
 * ONE JOB IS IN AT MOST ONE PHASE, which the unique index enforces. Work that
 * genuinely spans two phases is two jobs, because it is two visits, two sets
 * of lines and two draws. A job in two phases would be counted twice in the
 * project's actual cost, and the roll up would be quietly wrong in the
 * direction that looks like an overrun.
 */
export const projectJob = pgTable("project_job", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  /**
   * Null for work that belongs to the project and to no phase of it: a survey
   * before the phases were planned, a snag nobody has filed yet.
   */
  projectPhaseId: uuid("project_phase_id").references(() => projectPhase.id, { onDelete: "set null" }),
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  ...timestamps,
}, (t) => ({
  /** See the comment above: one job, one phase, one project. */
  jobIdx: uniqueIndex("project_job_job_idx").on(t.jobId),
  projectIdx: index("project_job_project_idx").on(t.organizationId, t.projectId),
  phaseIdx: index("project_job_phase_idx").on(t.projectPhaseId),
}));

/**
 * A CHANGE ORDER: WORK NOBODY PRICED AT THE START, AGREED IN WRITING.
 *
 * It used to be a contract revision: somebody typed a bigger number into the
 * contract value, and the history of what was agreed, when, by whom and for
 * how much lived in the audit log, if anywhere. On a fit out that is the
 * whole argument at the end of the job. "We never agreed to the extra
 * circuits" is answered by a signed page or it is not answered.
 *
 * So a change order is a document with its own life:
 *
 *   requested   somebody asked for it, nothing is priced
 *   priced      it has lines, from the price book, a rate card or by hand
 *   sent        the customer has a link to approve it and sign
 *   approved    signed, and folded into the contract and the budget
 *   declined    the customer said no, which is kept
 *   void        withdrawn before anybody agreed to it
 *
 * APPROVING IT IS WHAT CHANGES THE CONTRACT, and nothing else does. The
 * amount goes onto the contract value and the phase it names, and the cost
 * onto the budget, in the same transaction as the signature, so a contract
 * value that has moved always has a signed change order under it. The
 * contract before and after are stamped on the row, which is what the
 * change order log prints.
 */
export const changeOrderStatus = pgEnum("project_change_order_status", [
  "requested", "priced", "sent", "approved", "declined", "void",
]);

export const projectChangeOrder = pgTable("project_change_order", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  /** "Change order 3". Per project, in the order they were raised. */
  number: integer("number").notNull(),
  title: text("title").notNull(),
  /** What the work is, for the customer reading the page they sign. */
  description: text("description"),
  /** Who asked for it: the customer, the architect, an inspector, us. */
  requestedBy: text("requested_by"),
  /** Why, in a sentence. A hidden pipe behind the wall. */
  reason: text("reason"),
  status: changeOrderStatus("status").notNull().default("requested"),
  /**
   * The phase the work lands on, so the schedule of values keeps adding up
   * to the contract. Null for work that is its own line on the schedule.
   */
  projectPhaseId: uuid("project_phase_id").references(() => projectPhase.id, { onDelete: "set null" }),
  /** Days the change adds to the programme, or takes off when negative. Printed, not applied. */
  scheduleDays: integer("schedule_days"),
  /** The lines added up, rounded line by line. Negative for a credit. */
  amount: money("amount").notNull().default("0"),
  /** Our cost of the lines. Null when a line has no cost, which is unknown rather than zero. */
  cost: money("cost"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** SHA-256 of the document as sent, which the signature is checked against. */
  documentHash: text("document_hash"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  /** portal when the customer signed through the link, office when somebody recorded it. */
  decidedVia: text("decided_via"),
  signerName: text("signer_name"),
  declineReason: text("decline_reason"),
  /** The contract value either side of agreeing it. What the log prints. */
  contractValueBefore: money("contract_value_before"),
  contractValueAfter: money("contract_value_after"),
  voidReason: text("void_reason"),
  ...timestamps,
}, (t) => ({
  /** One change order 3 per project, for the reason the phase index gives. */
  numberIdx: uniqueIndex("project_change_order_number_idx").on(t.projectId, t.number),
  projectIdx: index("project_change_order_project_idx").on(t.organizationId, t.projectId, t.status),
}));

/**
 * One line of a change order, PRICED WHEN IT WAS WRITTEN.
 *
 * The price is frozen on the line, with where it came from: the price book
 * version in force, the customer's rate card, or typed. A change order the
 * customer signed in March says what it said in March, whatever the price
 * book says in May.
 */
export const projectChangeOrderLine = pgTable("project_change_order_line", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  changeOrderId: uuid("change_order_id").notNull().references(() => projectChangeOrder.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
  priceBookItemId: uuid("price_book_item_id"),
  priceBookItemVersionId: uuid("price_book_item_version_id"),
  rateCardId: uuid("rate_card_id"),
  /** price_book, rate_card or manual. */
  priceSource: text("price_source").notNull().default("manual"),
  name: text("name").notNull(),
  description: text("description"),
  /** Signed: a credit for work taken out is a negative quantity. */
  quantity: money("quantity").notNull().default("1"),
  unitPrice: money("unit_price").notNull(),
  unitCost: money("unit_cost"),
  lineTotal: money("line_total").notNull(),
  ...timestamps,
}, (t) => ({
  orderIdx: index("project_change_order_line_order_idx").on(t.changeOrderId, t.sortOrder),
}));

/**
 * AN APPLICATION FOR PAYMENT: ONE PERIOD'S PROGRESS BILLING.
 *
 * The formal version of a draw. Where a draw is "thirty per cent of the rough
 * in", an application states the whole position every period: each line of
 * the schedule of values with what was done before, what was done this
 * period, what materials are stored on site, how much retainage the customer
 * is holding, and what is due now. It is the document a general contractor,
 * an owner's representative or a lender certifies before paying, in the
 * shape they all expect: a summary page and a continuation sheet.
 *
 * A PROJECT BILLS BY DRAWS OR BY APPLICATIONS, NOT BOTH. Two ways of billing
 * the same work is how the same work gets billed twice, and the service
 * refuses the second kind on a project that has the first.
 *
 * A DRAFT IS LIVE AND AN INVOICED ONE IS FROZEN. While it is a draft its
 * lines follow the schedule of values (an approved change order appears on
 * it); once it is invoiced every total is stamped on the row, because the
 * next application reads its previous certificates from these columns and
 * not from a recomputation that could drift.
 */
export const applicationStatus = pgEnum("project_application_status", ["draft", "invoiced"]);

export const projectApplication = pgTable("project_application", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  /** Application 1, 2, 3, in order. */
  number: integer("number").notNull(),
  periodFrom: date("period_from"),
  periodTo: date("period_to").notNull(),
  status: applicationStatus("status").notNull().default("draft"),
  /** Held on completed work, as a fraction. */
  retainageRate: rate("retainage_rate").notNull().default("0"),
  /** Held on materials stored and not yet installed, as a fraction. */
  storedRetainageRate: rate("stored_retainage_rate").notNull().default("0"),
  /** Retainage released on this application. */
  retainageReleased: money("retainage_released").notNull().default("0"),
  notes: text("notes"),
  /* The summary, stamped when it is invoiced. Null on a draft. */
  contractSum: money("contract_sum"),
  netChangeOrders: money("net_change_orders"),
  totalCompletedAndStored: money("total_completed_and_stored"),
  totalRetainage: money("total_retainage"),
  totalEarnedLessRetainage: money("total_earned_less_retainage"),
  previousCertificates: money("previous_certificates"),
  currentPaymentDue: money("current_payment_due"),
  invoiceId: uuid("invoice_id").references(() => invoice.id, { onDelete: "set null" }),
  invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
  /**
   * What this application moved on the retainage receivable when it was
   * invoiced: the retainage it held (positive) or released (negative), posted
   * as `retainage` against this row (`services/retainage.ts`). NULL on an
   * application invoiced before retainage was booked to a receivable, which
   * is how a project billed the old way is recognised and left on it.
   */
  retainageBooked: money("retainage_booked"),
  /** When a void of its invoice took that retainage back off. */
  retainageReversedAt: timestamp("retainage_reversed_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  numberIdx: uniqueIndex("project_application_number_idx").on(t.projectId, t.number),
  projectIdx: index("project_application_project_idx").on(t.organizationId, t.projectId),
}));

/**
 * One line of the continuation sheet: a phase, or an agreed change order of
 * its own. Previous figures are copied from the last invoiced application
 * when the line is made, so this application can be printed without reading
 * the last one, and the last one can never be changed by reading this.
 */
export const projectApplicationLine = pgTable("project_application_line", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  applicationId: uuid("application_id").notNull().references(() => projectApplication.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
  projectPhaseId: uuid("project_phase_id").references(() => projectPhase.id, { onDelete: "set null" }),
  changeOrderId: uuid("change_order_id").references(() => projectChangeOrder.id, { onDelete: "set null" }),
  description: text("description").notNull(),
  scheduledValue: money("scheduled_value").notNull(),
  previousWork: money("previous_work").notNull().default("0"),
  previousStored: money("previous_stored").notNull().default("0"),
  workThisPeriod: money("work_this_period").notNull().default("0"),
  storedNow: money("stored_now").notNull().default("0"),
  ...timestamps,
}, (t) => ({
  applicationIdx: index("project_application_line_application_idx").on(t.applicationId, t.sortOrder),
}));

/**
 * NOTICES AND WAIVERS: THE PAPER THAT DECIDES WHETHER SOMEBODY GETS PAID.
 *
 * A preliminary notice sent to an owner, a notice received from a supplier,
 * a conditional waiver handed over with an invoice, an unconditional one once
 * the money cleared, a final one at the end. Each is a document with a date,
 * a party, an amount and the payment it is against, and a contractor who
 * cannot find one when a lien is threatened has a problem nobody can fix in
 * the time there is.
 *
 * RECORDS, NEVER RULES. Which notices a state requires, by when, in what
 * form, and when a waiver takes effect differ by state and change, and the
 * consequences of getting them wrong are somebody's right to be paid. This
 * table holds what was sent and received; it does not know what should have
 * been, and nothing in this product claims to. BUILD.md says the same.
 */
export const lienRecordKind = pgEnum("project_lien_record_kind", ["notice", "waiver"]);
export const lienRecordDirection = pgEnum("project_lien_record_direction", ["sent", "received"]);
export const waiverCondition = pgEnum("project_waiver_condition", ["conditional", "unconditional"]);
export const waiverScope = pgEnum("project_waiver_scope", ["progress", "final"]);

export const projectLienRecord = pgTable("project_lien_record", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  kind: lienRecordKind("kind").notNull(),
  direction: lienRecordDirection("direction").notNull(),
  /** Waivers only. */
  condition: waiverCondition("condition"),
  scope: waiverScope("scope"),
  /** What the document calls itself. "Preliminary notice", "Conditional waiver on progress payment". */
  title: text("title").notNull(),
  /** Who it went to or came from. */
  partyName: text("party_name").notNull(),
  /** The day it was sent, received or signed. */
  onDate: date("on_date").notNull(),
  /** A waiver covers work through this date. */
  throughDate: date("through_date"),
  amount: money("amount"),
  /** The payment it is against: a raised draw's or an application's invoice. */
  invoiceId: uuid("invoice_id").references(() => invoice.id, { onDelete: "set null" }),
  notes: text("notes"),
  ...timestamps,
}, (t) => ({
  projectIdx: index("project_lien_record_project_idx").on(t.organizationId, t.projectId, t.onDate),
  invoiceIdx: index("project_lien_record_invoice_idx").on(t.invoiceId),
}));
