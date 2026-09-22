import { pgTable, pgEnum, uuid, text, boolean, integer, index, timestamp, date } from "drizzle-orm/pg-core";
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

export const timeEntryKind = pgEnum("time_entry_kind", [
  "job", "travel", "shop", "training", "break", "on_call", "pto", "holiday",
]);

export const timeclockEntry = pgTable("timeclock_entry", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  kind: timeEntryKind("kind").notNull().default("job"),

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
