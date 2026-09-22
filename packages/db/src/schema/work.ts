import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, timestamp } from "drizzle-orm/pg-core";
import { pk, timestamps, sourceRef, money } from "./_shared";
import { organization, businessUnit, location, technician } from "./tenancy";
import { customer, property, equipment } from "./crm";

/**
 * WORK
 *
 * `job` is the commercial unit: what was sold, what gets invoiced, what gets
 * costed. `visit` is the operational unit: what gets dispatched to a truck on
 * a given day.
 *
 * One job has many visits. This is NOT an edge case. A diagnostic trip, a
 * parts-return trip and a two-day install are all one job. Modeling a job as a
 * single calendar block is the mistake that forces every "we need to reschedule
 * half of this" workaround, and it is why Jobber struggles with install work.
 */

export const jobStatus = pgEnum("job_status", [
  "lead", "estimating", "scheduled", "in_progress", "on_hold",
  "completed", "invoiced", "paid", "cancelled",
]);

export const visitStatus = pgEnum("visit_status", [
  "unassigned", "scheduled", "dispatched", "en_route",
  "working", "completed", "cancelled", "no_show",
]);

export const jobType = pgTable("job_type", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code"),
  defaultDurationMinutes: integer("default_duration_minutes").notNull().default(60),
  /** Skills a technician must hold to be assignable. Enforced by the scheduling engine. */
  requiredSkills: jsonb("required_skills").$type<string[]>().notNull().default([]),
  checklistTemplate: jsonb("checklist_template").$type<Array<{ id: string; label: string; required: boolean }>>().notNull().default([]),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  color: text("color"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("job_type_org_idx").on(t.organizationId) }));

export const job = pgTable("job", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** Human-facing sequential number, per organization. Generated, never the uuid. */
  number: integer("number").notNull(),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  jobTypeId: uuid("job_type_id").references(() => jobType.id, { onDelete: "set null" }),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  status: jobStatus("status").notNull().default("lead"),
  summary: text("summary").notNull(),
  description: text("description"),
  /** The customer's own words, captured at intake. Invaluable for the AI agents. */
  customerComplaint: text("customer_complaint"),
  equipmentId: uuid("equipment_id").references(() => equipment.id, { onDelete: "set null" }),
  leadSource: text("lead_source"),
  campaignId: uuid("campaign_id"),
  /** Set when this job is warranty rework on a previous one. Drives callback rate. */
  parentJobId: uuid("parent_job_id"),
  isWarranty: boolean("is_warranty").notNull().default(false),
  /** Generated from a membership or recurring schedule rather than booked ad hoc. */
  agreementId: uuid("agreement_id"),
  priority: integer("priority").notNull().default(0),
  total: money("total"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancellationReason: text("cancellation_reason"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  orgStatusIdx: index("job_org_status_idx").on(t.organizationId, t.status),
  customerIdx: index("job_customer_idx").on(t.customerId),
  propertyIdx: index("job_property_idx").on(t.propertyId),
  numberIdx: index("job_number_idx").on(t.organizationId, t.number),
}));

export const visit = pgTable("visit", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull().default(1),
  status: visitStatus("status").notNull().default("unassigned"),
  /**
   * Arrival WINDOW, not a point in time. Contractors promise "between 1 and 4",
   * and storing a single timestamp is what produces the angry review.
   */
  windowStart: timestamp("window_start", { withTimezone: true }),
  windowEnd: timestamp("window_end", { withTimezone: true }),
  estimatedDurationMinutes: integer("estimated_duration_minutes").notNull().default(60),
  locationId: uuid("location_id").references(() => location.id, { onDelete: "set null" }),
  /** Ordering within a technician's day, set by the dispatch board and route pass. */
  routeOrder: integer("route_order"),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  enRouteAt: timestamp("en_route_at", { withTimezone: true }),
  arrivedAt: timestamp("arrived_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  technicianNotes: text("technician_notes"),
  checklist: jsonb("checklist").$type<Array<{ id: string; label: string; required: boolean; doneAt: string | null }>>().notNull().default([]),
  signatureUrl: text("signature_url"),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  jobIdx: index("visit_job_idx").on(t.jobId),
  /** The dispatch board's primary query: everything in a window, by org. */
  boardIdx: index("visit_board_idx").on(t.organizationId, t.windowStart, t.status),
}));

/** A visit can carry a crew, not just one technician. */
export const visitAssignment = pgTable("visit_assignment", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  visitId: uuid("visit_id").notNull().references(() => visit.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  isLead: boolean("is_lead").notNull().default(false),
  ...timestamps,
}, (t) => ({
  visitIdx: index("visit_assignment_visit_idx").on(t.visitId),
  techIdx: index("visit_assignment_tech_idx").on(t.technicianId),
}));
