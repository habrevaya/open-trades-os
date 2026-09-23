import { pgTable, pgEnum, uuid, text, boolean, integer, index, uniqueIndex, jsonb, timestamp, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, sourceRef, money, rate } from "./_shared";
import { organization, technician, businessUnit } from "./tenancy";
import { job, visit } from "./work";

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
