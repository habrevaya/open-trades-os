import { pgTable, pgEnum, uuid, text, boolean, integer, index, uniqueIndex, jsonb, timestamp, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, sourceRef, money, rate } from "./_shared";
import { organization, user, technician, businessUnit } from "./tenancy";
import { job, visit } from "./work";
import { invoice } from "./billing";

/**
 * TIME, AND WHY CLASSIFICATION LIVES ON THE ENTRY
 *
 * Labour cost as a per-employee hourly rate is wrong the moment a worker
 * changes role during a day, and it is structurally wrong for union work and
 * for anything covered by a prevailing wage determination.
 *
 * The same person can be a journeyman on a government job at a determined rate
 * in the morning, an apprentice on a commercial job under a collective
 * agreement after lunch, and a service technician at the shop rate in the
 * evening. Three classifications, three rates, one day, one employee.
 *
 * So classification sits on the TIME ENTRY, and the rate is resolved from a
 * scale that may come from an employee default, a collective agreement, a
 * government wage determination, or a contract.
 *
 * This is captured in the mobile app, which is phase 3. If the field is not
 * captured there, no downstream certified payroll report can ever be
 * reconstructed, because the information simply was not recorded. That is why
 * it is in the schema now rather than with the payroll module in phase 5.
 */

export const wageAuthority = pgEnum("wage_authority", [
  "employee_default",      // the shop rate on their profile
  "collective_agreement",  // a CBA scale
  "wage_determination",    // a government prevailing wage determination
  "contract",              // a rate negotiated into a client contract
  "manual_override",       // someone typed it, and we record who
]);

/**
 * A named classification with a rate, from whichever authority governs.
 * "Journeyman Plumber, Local 130, Zone 1" or "Electrician, Travis County TX,
 * determination TX20260012".
 */
export const wageScale = pgTable("wage_scale", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  authority: wageAuthority("authority").notNull().default("employee_default"),
  classification: text("classification").notNull(),
  /** Local union, county, or contract, depending on the authority. */
  jurisdiction: text("jurisdiction"),
  externalReference: text("external_reference"),
  baseRate: money("base_rate").notNull(),
  /** Health, pension, training. Tracked separately because they report separately. */
  fringeRate: money("fringe_rate"),
  overtimeMultiplier: rate("overtime_multiplier"),
  doubleTimeMultiplier: rate("double_time_multiplier"),
  /** Apprentice ratio rules, where a classification carries one. */
  apprenticeRatio: text("apprentice_ratio"),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  orgIdx: index("wage_scale_org_idx").on(t.organizationId, t.authority),
  classIdx: index("wage_scale_class_idx").on(t.organizationId, t.classification, t.jurisdiction),
}));

/**
 * The same list as `labor.TIME_ENTRY_KINDS` in core, and a test fails if it
 * stops being.
 *
 * It was not the same list. This enum had `job` where core has `on_site`, and
 * a single `break` where core distinguishes `paid_break` from `unpaid_break`,
 * which is a distinction with money on it: one is deducted and the other is
 * not, and one value cannot express both. Core had no `training`, `pto` or
 * `holiday`, so a row carrying one of those reached a lookup, found
 * undefined, and threw out of the timesheet.
 *
 * Nobody noticed because nothing had ever run a timesheet.
 */
export const timeEntryKind = pgEnum("time_entry_kind", [
  "travel", "on_site", "shop", "unpaid_break", "paid_break", "on_call",
  "training", "pto", "holiday",
]);

export const timeclockEntry = pgTable("timeclock_entry", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  kind: timeEntryKind("kind").notNull().default("on_site"),

  /** Allocating time to a job is what makes labour cost land in job costing. */
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  visitId: uuid("visit_id").references(() => visit.id, { onDelete: "set null" }),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  costCode: text("cost_code"),

  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  /** Computed on close, stored so a timesheet does not recompute the world. */
  minutes: integer("minutes"),

  /** THE FIELD THIS TABLE EXISTS FOR. */
  wageScaleId: uuid("wage_scale_id").references(() => wageScale.id, { onDelete: "set null" }),
  classification: text("classification"),
  /**
   * Workers compensation class code, which is NOT the same as the wage
   * classification and is captured on the same entry for the same reason.
   *
   * Comp premium is rated per class code, and the split payroll rules let a
   * worker's hours be divided across codes when the work genuinely differs.
   * Capture it at the punch and the annual audit export falls out of payroll
   * for free. Do not capture it and the audit is a reconstruction exercise
   * with real money attached, which is a quantifiable reason to switch.
   */
  workClassCode: text("work_class_code"),
  /** Frozen at close. The scale can change; this entry's cost must not. */
  appliedBaseRate: money("applied_base_rate"),
  appliedFringeRate: money("applied_fringe_rate"),
  /** Loaded rate including burden, for job costing rather than payroll. */
  appliedLoadedRate: money("applied_loaded_rate"),
  overtimeMinutes: integer("overtime_minutes"),
  doubleTimeMinutes: integer("double_time_minutes"),

  /** GPS stamps and geofence result, captured at punch, never inferred later. */
  startLatitude: text("start_latitude"),
  startLongitude: text("start_longitude"),
  endLatitude: text("end_latitude"),
  endLongitude: text("end_longitude"),
  geofenceSatisfied: boolean("geofence_satisfied"),

  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedByUserId: uuid("approved_by_user_id"),
  /** Set when edited after the fact. Payroll auditors always ask. */
  editedAt: timestamp("edited_at", { withTimezone: true }),
  editReason: text("edit_reason"),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  techIdx: index("timeclock_tech_idx").on(t.organizationId, t.technicianId, t.startedAt),
  jobIdx: index("timeclock_job_idx").on(t.jobId),
  /** Open punches. Somebody always forgets to clock out. */
  openIdx: index("timeclock_open_idx").on(t.organizationId, t.endedAt),
  /** Certified payroll: every entry on a job, by classification, in a week. */
  payrollIdx: index("timeclock_payroll_idx").on(t.organizationId, t.classification, t.startedAt),
}));

/**
 * HOW THIS COMPANY PAYS OVERTIME, DECLARED RATHER THAN ASSUMED.
 *
 * The rules live in `packages/core/src/labor`, which takes this shape as
 * DATA and never as code. That is the same argument the report definitions
 * and the workflow conditions make: a self hosted product whose payroll
 * rules are expressions somebody can write is a product that executes
 * arbitrary code on behalf of whoever edits a settings screen.
 *
 * Every field here is a rule with money on it. There is no universal default
 * for any of them, which is why none of them is defaulted:
 *
 *   `week_starts_on` moves the boundary of the pot the weekly threshold is
 *   measured against, so a week starting on the wrong day moves overtime
 *   between two weeks and changes what is owed.
 *
 *   `day_attribution` decides what a night shift is. Nine hours starting at
 *   ten at night is one day of nine against an eight hour threshold, or two
 *   days of two and seven against nothing. They pay differently.
 *
 *   `on_call_treatment` is not a preference. Whether carrying a phone is
 *   hours worked is a question with a legal answer that varies, and the
 *   core module REFUSES to assemble a policy that leaves it unsaid.
 *
 * `note` is what the operator says this policy is, in their words, shown on
 * the settings screen. A rule nobody can explain is a rule nobody can audit.
 */
export const dayAttribution = pgEnum("day_attribution", ["shift_start", "split_at_midnight"]);
export const onCallTreatment = pgEnum("on_call_treatment", [
  "separate_rate_not_hours_worked", "hours_worked_at_base",
]);
export const roundingDirection = pgEnum("rounding_direction", ["nearest", "up", "down"]);

export const overtimePolicy = pgTable("overtime_policy", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  /** The COMPANY's zone. Not the server's, which is a container in UTC. */
  timeZone: text("time_zone").notNull(),
  weekStartsOn: integer("week_starts_on").notNull(),
  dayAttributionMode: dayAttribution("day_attribution").notNull(),
  weeklyThresholdMinutes: integer("weekly_threshold_minutes"),
  weeklyDoubleTimeThresholdMinutes: integer("weekly_double_time_threshold_minutes"),
  dailyThresholdMinutes: integer("daily_threshold_minutes"),
  dailyDoubleTimeThresholdMinutes: integer("daily_double_time_threshold_minutes"),
  /** "1.5" for time and a half. A decimal string, never a float. */
  overtimeMultiplier: rate("overtime_multiplier").notNull(),
  doubleTimeMultiplier: rate("double_time_multiplier").notNull(),
  onCallMode: onCallTreatment("on_call_treatment").notNull(),
  /**
   * Punch rounding, when a company does it.
   *
   * Null means punches are used as recorded, which is the only setting that
   * cannot systematically underpay anybody. When it is set, core rounds the
   * whole punch pair once rather than each day segment, so a shift crossing
   * midnight is not rounded twice.
   */
  roundingMinutes: integer("rounding_minutes"),
  roundingMode: roundingDirection("rounding_direction"),
  /** Per kind overrides of whether time counts toward an overtime threshold. */
  countsTowardOvertime: jsonb("counts_toward_overtime").$type<Record<string, boolean>>(),
  note: text("note").notNull(),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  /**
   * One active policy per organization.
   *
   * Two would mean a timesheet whose answer depends on which row was read
   * first, and the answer is somebody's wages.
   */
  activeIdx: uniqueIndex("overtime_policy_active_idx").on(t.organizationId)
    .where(sql`${t.active} and ${t.deletedAt} is null`),
}));

/* ========================================================================
 * COMMISSION, AND WHY IT IS A LIABILITY RATHER THAN A FIELD ON A JOB
 * ======================================================================== */

/**
 * A COMMISSION IS OWED THE MOMENT IT IS EARNED.
 *
 * `packages/core/src/ledger` spends a long comment on why a deposit is a
 * liability and not revenue, and the same argument applies here with the sign
 * reversed. The moment a technician sells a job under a plan the company
 * declared, the company owes them money. It has not paid it, it will not pay
 * it until the payroll run, and if it closed its doors that afternoon it would
 * still owe it.
 *
 * Every field service product this project looked at models commission as a
 * number on a report that payroll reads once a fortnight. That number is not
 * on the balance sheet, so the company's own accounts never show what it owes
 * its technicians, and the month a big install lands looks far more profitable
 * than it was. These tables exist so the earning is an event with a ledger
 * posting behind it and the paying is a different event that clears it.
 *
 * The arithmetic is NOT here and is not in the service either. It is in
 * `packages/core/src/labor`, which has had `computeCommission`, `clawbackFor`
 * and `buildStatement` since before any of this existed and had no caller
 * outside its own tests. These tables record what that module decided.
 */
export const commissionBasis = pgEnum("commission_basis", [
  "percent_of_revenue", "percent_of_gross_margin", "flat_per_job", "percent_of_collected",
]);

/**
 * WHAT THIS COMPANY PAYS COMMISSION ON, DECLARED RATHER THAN GUESSED.
 *
 * The same argument `overtime_policy` makes. There is no default basis: a
 * percentage of revenue rewards selling the expensive option, a percentage of
 * margin rewards selling the profitable one and depends on a cost nobody has
 * in the driveway, a flat amount rewards volume and nothing else, and a
 * percentage of what was collected puts the technician's pay behind the
 * office's collections. Core carries a `wrongAbout` sentence for each, and the
 * plan screen shows it, because a commission plan is the most powerful
 * instruction a contractor ever gives a technician and it is usually given by
 * accident.
 *
 * `note` is required for the same reason the overtime policy's is: it is what
 * a technician is shown when they ask how the number was worked out, and core
 * refuses to compute a commission under a plan that has none.
 *
 * SUPERSEDED, NOT EDITED. A plan is deactivated and a new one declared, so
 * "what were we paying in March" has an answer. The earned rows below freeze
 * the basis and the rate they were computed at anyway, for the same reason
 * `timeclock_entry` freezes the wage: a plan that can be edited retroactively
 * reprices commissions that have already been paid.
 */
export const commissionPlan = pgTable("commission_plan", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  basis: commissionBasis("basis").notNull(),
  /** "0.08" is eight per cent. Set on a percentage basis, null on a flat one. */
  rate: rate("rate"),
  /** Set on a flat basis, null on a percentage one. */
  flatAmount: money("flat_amount"),
  /** What a technician is shown when they ask how the number was worked out. */
  note: text("note").notNull(),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  orgIdx: index("commission_plan_org_idx").on(t.organizationId, t.active),
}));

/**
 * ONE EARNING, AGAINST ONE INVOICE.
 *
 * The unique index is the whole point of the table. Settling an invoice twice
 * pays the commission twice, the ledger carries the liability twice, and the
 * only person who finds out is the one reading a payroll register wondering
 * why a job appears on it in two different fortnights.
 *
 * The basis and the rate are FROZEN here, beside the revenue and cost they
 * were computed from, so that a plan changed next year does not reprice what
 * was paid this year. That is the same rule as `applied_base_rate` on a punch
 * and it is right for the same reason.
 */
export const commissionEvent = pgTable("commission_event", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /**
   * Set null rather than cascade. Deleting a plan must not delete the record
   * of money somebody has already been paid, and the frozen columns below mean
   * the row still explains itself without it.
   */
  planId: uuid("plan_id").references(() => commissionPlan.id, { onDelete: "set null" }),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),

  basis: commissionBasis("basis").notNull(),
  appliedRate: rate("applied_rate"),
  appliedFlatAmount: money("applied_flat_amount"),

  /**
   * Revenue NET OF TAX and net of discount, which is what the invoice posting
   * recognised as revenue. Commission on the tax line is a share of money owed
   * to a jurisdiction, and paying it is paying a technician out of the state's
   * money.
   */
  revenue: money("revenue").notNull(),
  /** Null when nothing is known. A margin basis is refused rather than assuming zero. */
  cost: money("cost"),
  /** Cash received against the invoice, for a collected basis. */
  collected: money("collected"),
  total: money("total").notNull(),
  /** When it was earned. Decides which pay period it belongs to, and nothing else does. */
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  explanation: text("explanation").notNull(),
  /**
   * Null only when the commission computed to zero, which posts nothing,
   * because a posting with no entries is not a posting.
   */
  ledgerTransactionId: uuid("ledger_transaction_id"),
  ...timestamps,
}, (t) => ({
  /** One earning per invoice. See the comment above: this index is the guard. */
  invoiceIdx: uniqueIndex("commission_event_invoice_idx").on(t.organizationId, t.invoiceId),
  occurredIdx: index("commission_event_occurred_idx").on(t.organizationId, t.occurredAt),
}));

export const commissionReversalReason = pgEnum("commission_reversal_reason", [
  "refund", "credit_note", "write_off", "callback",
]);

/**
 * THE MONEY COMING BACK.
 *
 * A plan with no reversal is a plan where a company pays commission on money
 * it never received. The customer disputes the bill in April, the money goes
 * back, and the technician keeps eight per cent of a job nobody was paid for.
 * It is not malice: nothing in most systems connects the two events.
 *
 * `cause_type` and `cause_id` name what caused it, and they are unique per
 * event, so one write-off cannot reverse the same commission twice. That is
 * not a theoretical retry: a write-off that is retried, or a human clicking
 * twice, would otherwise take the money back off a technician as many times as
 * the button was pressed.
 */
export const commissionReversal = pgTable("commission_reversal", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull().references(() => commissionEvent.id, { onDelete: "cascade" }),
  reason: commissionReversalReason("reason").notNull(),
  creditedRevenue: money("credited_revenue").notNull(),
  creditedCost: money("credited_cost"),
  /** Negative, or zero where the basis does not move. Never a magnitude. */
  total: money("total").notNull(),
  /**
   * When the CREDIT happened, which is usually not when the job did. Core is
   * explicit that a reversal lands in the period the credit happened in rather
   * than reopening the period the commission was paid in, because that period
   * was paid, tax was withheld on the amount shown, and that withholding was
   * remitted.
   */
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  explanation: text("explanation").notNull(),
  /** "invoice.written_off", "invoice.voided", "payment.refunded". */
  causeType: text("cause_type").notNull(),
  causeId: uuid("cause_id").notNull(),
  ledgerTransactionId: uuid("ledger_transaction_id"),
  ...timestamps,
}, (t) => ({
  /** One reversal per cause per event. See the comment above. */
  causeIdx: uniqueIndex("commission_reversal_cause_idx").on(t.eventId, t.causeType, t.causeId),
  occurredIdx: index("commission_reversal_occurred_idx").on(t.organizationId, t.occurredAt),
}));

export const commissionEntryKind = pgEnum("commission_entry_kind", ["earned", "reversed"]);

/**
 * WHOSE MONEY IT IS, which is the question a split answers.
 *
 * One row per person per event, and one row per person per reversal. The
 * amounts are allocated by `money.allocate` in core and never by division: a
 * commission of $347.63 split two ways is $173.815 each, there is no such
 * coin, and rounding each half independently leaves the parts not adding back
 * to the whole. One cent a job, every job, and the liability account never
 * reconciles again.
 *
 * `occurred_at` is copied from the event or the reversal rather than joined
 * for. A pay period reads this table by person and by instant, and both
 * parents are immutable once written, so there is nothing for the copy to
 * drift from. It is the difference between a payroll register that is one
 * indexed scan and one that is three joins over a fortnight of rows.
 */
export const commissionEntry = pgTable("commission_entry", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull().references(() => commissionEvent.id, { onDelete: "cascade" }),
  /** Set on a reversal line, null on an earning. */
  reversalId: uuid("reversal_id").references(() => commissionReversal.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  kind: commissionEntryKind("kind").notNull(),
  /** The weight this person's share was allocated by. Null on a reversal line. */
  weight: rate("weight"),
  /**
   * The position this person had in the split, and it is load bearing.
   *
   * `money.allocate` hands the odd cent to the largest weight and breaks a tie
   * by POSITION, deterministically. A reversal recomputes the whole split and
   * takes the difference per person, so it has to hand core the shares in the
   * order they were handed over the first time. Sorting by anything else, an
   * id that is random or a created_at that ties inside one transaction, moves
   * the odd cent between two technicians and leaves the parts not adding back
   * to the whole.
   */
  shareIndex: integer("share_index").notNull(),
  /** Signed. Positive on an earning, negative on a reversal. */
  amount: money("amount").notNull(),
  explanation: text("explanation").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  /** Set when a payroll run cleared the liability. Null means still owed. */
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paidInPeriodId: uuid("paid_in_period_id"),
  ...timestamps,
}, (t) => ({
  personIdx: index("commission_entry_person_idx").on(t.organizationId, t.technicianId, t.occurredAt),
  eventIdx: index("commission_entry_event_idx").on(t.eventId),
  /** Everything still owed. The query the liability balance is checked against. */
  unpaidIdx: index("commission_entry_unpaid_idx").on(t.organizationId, t.paidAt),
}));

/* ========================================================================
 * PAY PERIODS, AND WHY ONE HAS TO BE CLOSABLE
 * ======================================================================== */

/**
 * A PERIOD, DECLARED IN CALENDAR TERMS.
 *
 * A start date and a number of whole workweeks, never two instants, because
 * overtime is measured over a workweek and only over a workweek. A period that
 * cuts a workweek in half cannot be settled: half the hours that decide
 * whether Thursday was overtime are in the other period, which may already be
 * closed and paid. Semimonthly periods, the fifteenth and the last day of the
 * month, do exactly this, and `labor.checkPeriod` in core refuses them rather
 * than half supporting them.
 *
 * The instants are derived with core's `periodBounds`, which knows that a week
 * containing a clock change is 167 or 169 hours. A period whose end is the
 * start plus seven times 864e5 is an hour short twice a year, and the shift in
 * that hour falls out of the period entirely: somebody works a Saturday night
 * and it is on nobody's payroll.
 */
export const payPeriod = pgTable("pay_period", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** What the operator calls it. "Fortnight ending 14 March". */
  label: text("label").notNull(),
  /** The first calendar date, in the overtime policy's zone. */
  startDate: date("start_date").notNull(),
  weeks: integer("weeks").notNull(),
  ...timestamps,
}, (t) => ({
  startIdx: uniqueIndex("pay_period_start_idx").on(t.organizationId, t.startDate),
}));

/**
 * A PERIOD SOMEBODY HAS RUN PAYROLL ON.
 *
 * The shape is `accounting_period`'s, deliberately, down to the reopen
 * columns, because it is the same problem one ledger over: once hours have
 * been exported to a bureau and paid, a punch edited into that period changes
 * a number that has already been paid and taxed, and nobody can say what
 * changed it.
 *
 * It is a SEPARATE TABLE from the period rather than four columns on it, for
 * the reason `accounting_period` keeps a reopened row instead of deleting it:
 * "this fortnight was closed, reopened on the 14th by Dana, and closed again"
 * is a fact a payroll auditor asks for, and a column overwritten by the second
 * close cannot answer it.
 *
 * `hours_fingerprint` is what makes an edit after the close VISIBLE rather
 * than silent. It is taken over every punch and every commission line inside
 * the period at the moment of closing, and the export recomputes it and
 * refuses when it has moved. Without it, an approval or a corrected punch
 * landing after the close simply produces a different file the second time
 * somebody runs the export, and the two files look equally authoritative.
 */
export const payPeriodClose = pgTable("pay_period_close", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  payPeriodId: uuid("pay_period_id").notNull().references(() => payPeriod.id, { onDelete: "cascade" }),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  closedByUserId: uuid("closed_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Why, in the closer's own words. "Sent to the bureau 2026-03-16." */
  note: text("note"),
  /** Every punch and every commission line in the period, as it stood at close. */
  hoursFingerprint: text("hours_fingerprint").notNull(),
  reopenedAt: timestamp("reopened_at", { withTimezone: true }),
  reopenedByUserId: uuid("reopened_by_user_id").references(() => user.id, { onDelete: "set null" }),
  reopenedReason: text("reopened_reason"),
  ...timestamps,
}, (t) => ({
  /**
   * At most one live close per period. Two would mean an export whose answer
   * depends on which row was read first, and the answer is somebody's wages.
   */
  liveIdx: uniqueIndex("pay_period_close_live_idx").on(t.payPeriodId)
    .where(sql`${t.reopenedAt} is null`),
  periodIdx: index("pay_period_close_period_idx").on(t.organizationId, t.payPeriodId),
}));

/**
 * EVERY EXPORT THAT HAS EVER BEEN RUN.
 *
 * Recorded because an export is a thing that left the building. The bureau has
 * it, somebody has been paid from it, and "which file did we send" is the first
 * question when a technician says their cheque is wrong.
 *
 * `checksum` is over the exact bytes produced. Running the same export twice
 * against the same close produces the same checksum, which is the testable
 * form of the promise that an export is reproducible; and two rows against one
 * close with two different checksums would mean the file changed under a
 * closed period, which is the thing the fingerprint above exists to prevent.
 */
export const payrollExport = pgTable("payroll_export", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  payPeriodId: uuid("pay_period_id").notNull().references(() => payPeriod.id, { onDelete: "cascade" }),
  /** Which close it was run against, so a reopened and reclosed period is a different file. */
  closeId: uuid("close_id").notNull().references(() => payPeriodClose.id, { onDelete: "cascade" }),
  /** "csv". Every bureau takes one and no vendor has to approve it. */
  format: text("format").notNull(),
  rowCount: integer("row_count").notNull(),
  grossTotal: money("gross_total").notNull(),
  checksum: text("checksum").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  generatedByUserId: uuid("generated_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  periodIdx: index("payroll_export_period_idx").on(t.organizationId, t.payPeriodId),
}));
