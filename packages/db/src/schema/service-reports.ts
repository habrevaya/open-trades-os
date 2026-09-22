import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, timestamp } from "drizzle-orm/pg-core";
import { pk, timestamps, money } from "./_shared";
import { organization } from "./tenancy";
import { customer, property, equipment } from "./crm";
import { visit, job } from "./work";

/**
 * SERVICE REPORTS
 *
 * The primitive underneath the customer portal, and the reason the portal is
 * worth logging into at all.
 *
 * Every competitor ships a portal that shows invoices. A homeowner does not
 * care. What they want is different in every trade:
 *
 *   lawn         what was mowed, edged and blown, at what height, before and
 *                after photos, what the crew flagged, and why last week was
 *                skipped
 *   pool         chemical readings trended, what was dosed, filter status, and
 *                whether it is safe to swim today
 *   pest         chemicals applied with EPA registration numbers, device and
 *                station activity, warranty status
 *   HVAC         readings per unit trended across visits, warranty counting
 *                down, declined recommendations
 *   restoration  daily moisture readings and drying progress against the claim
 *
 * All of that is one record with a trade-shaped field set, produced as a side
 * effect of the technician doing the work rather than as paperwork afterwards.
 * Every portal view, every trend chart and every regulatory export is a
 * projection over this table.
 */

export const readingKind = pgEnum("reading_kind", [
  "numeric", "text", "boolean", "select", "photo", "signature", "chemical", "measurement",
]);

/**
 * The field set for a service report, defined per job type and seeded by the
 * trade pack. This is what makes one product serve twenty six trades without
 * either a generic form builder nobody configures or twenty six forks.
 */
export const serviceReportTemplate = pgTable("service_report_template", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  jobTypeId: uuid("job_type_id"),
  tradePackId: text("trade_pack_id"),
  /**
   * Ordered field definitions. Kept as JSON rather than rows because a
   * template is read as a whole, versioned as a whole, and shipped as a whole
   * inside a trade pack.
   */
  fields: jsonb("fields").$type<Array<{
    key: string;
    label: string;
    kind: "numeric" | "text" | "boolean" | "select" | "photo" | "signature" | "chemical" | "measurement";
    unit?: string | undefined;
    options?: string[] | undefined;
    required?: boolean | undefined;
    /** Show on the customer portal. Some readings are internal only. */
    customerVisible?: boolean | undefined;
    /** Chart this across visits. Only meaningful for numeric and measurement. */
    trend?: boolean | undefined;
    /** Acceptable range. Outside it, the portal flags the reading. */
    min?: number | undefined;
    max?: number | undefined;
    /** Regulatory: EPA registration, applicator licence, target pest. */
    regulated?: boolean | undefined;
  }>>().notNull().default([]),
  version: integer("version").notNull().default(1),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("service_report_template_org_idx").on(t.organizationId) }));

export const serviceReport = pgTable("service_report", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  visitId: uuid("visit_id").notNull().references(() => visit.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  templateId: uuid("template_id").references(() => serviceReportTemplate.id),
  templateVersion: integer("template_version"),

  /** What was done, in language a homeowner reads. AI-summarized from notes. */
  summary: text("summary"),
  /** The technician's own words. Internal unless explicitly published. */
  technicianNotes: text("technician_notes"),
  /** What the tech flagged for next time. Drives the recommendation pipeline. */
  observations: text("observations"),
  /** Why nothing happened, when nothing happened. A skipped visit still gets a report. */
  skipped: boolean("skipped").notNull().default(false),
  skipReason: text("skip_reason"),

  /**
   * The technician finished it. NOT the same as publishing it.
   *
   * The permission model already separates recording a report from publishing
   * one to the customer, because the office routinely reviews what a
   * technician wrote before a homeowner reads it. Without this the two states
   * are indistinguishable, and a report that has been submitted and not yet
   * reviewed looks exactly like one nobody has started.
   *
   * It is also what makes a second submission from the field detectable: that
   * usually means the technician edited after submitting and expects the
   * change to land, and silently accepting it would tell them it did.
   */
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  visitIdx: index("service_report_visit_idx").on(t.visitId),
  /** The office's review queue: submitted and not yet published. */
  reviewIdx: index("service_report_review_idx").on(t.organizationId, t.submittedAt, t.publishedAt),
  /** The portal's primary query: this property's reports, newest first. */
  portalIdx: index("service_report_portal_idx").on(t.organizationId, t.propertyId, t.publishedAt),
}));

/**
 * One row per captured field. Rows rather than a JSON blob on the report,
 * because these get trended, charted, range-checked and exported to
 * regulators, and none of that is pleasant against JSON at scale.
 */
export const serviceReportField = pgTable("service_report_field", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  reportId: uuid("report_id").notNull().references(() => serviceReport.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  /** Readings that belong to a specific unit, not the whole property. */
  equipmentId: uuid("equipment_id").references(() => equipment.id, { onDelete: "set null" }),

  key: text("key").notNull(),
  label: text("label").notNull(),
  kind: readingKind("kind").notNull(),

  valueNumeric: money("value_numeric"),
  valueText: text("value_text"),
  valueBoolean: boolean("value_boolean"),
  unit: text("unit"),

  /** Regulated application: pest chemicals, HVAC refrigerant, pool dosing. */
  productName: text("product_name"),
  epaRegistrationNumber: text("epa_registration_number"),
  quantityApplied: money("quantity_applied"),
  applicationUnit: text("application_unit"),
  applicatorLicense: text("applicator_license"),
  targetPest: text("target_pest"),

  customerVisible: boolean("customer_visible").notNull().default(true),
  outOfRange: boolean("out_of_range").notNull().default(false),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (t) => ({
  reportIdx: index("service_report_field_report_idx").on(t.reportId),
  /** The trend query: this property's readings for one key, over time. */
  trendIdx: index("service_report_field_trend_idx").on(t.organizationId, t.propertyId, t.key, t.recordedAt),
  /** The regulatory export: every regulated application in a date range. */
  regulatoryIdx: index("service_report_field_regulatory_idx").on(t.organizationId, t.epaRegistrationNumber, t.recordedAt),
}));

/**
 * PORTAL LAYOUT
 *
 * The portal is composed of blocks and each trade pack ships a default layout.
 * A contractor rearranges, hides and rebrands without touching code, and the
 * layout is addressable through the API and the MCP server for anything bespoke.
 */
export const portalBlockKind = pgEnum("portal_block_kind", [
  "visit_timeline", "service_report", "readings_trend", "equipment_register",
  "checklist_results", "photo_gallery", "documents", "invoices", "payments",
  "plan_status", "next_visit", "recommended_work", "referral", "contact_card",
]);

export const portalLayout = pgTable("portal_layout", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tradePackId: text("trade_pack_id"),
  isDefault: boolean("is_default").notNull().default(false),
  ...timestamps,
}, (t) => ({ orgIdx: index("portal_layout_org_idx").on(t.organizationId) }));

export const portalBlock = pgTable("portal_block", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  layoutId: uuid("layout_id").notNull().references(() => portalLayout.id, { onDelete: "cascade" }),
  kind: portalBlockKind("kind").notNull(),
  title: text("title"),
  sortOrder: integer("sort_order").notNull().default(0),
  visible: boolean("visible").notNull().default(true),
  /** Block-specific settings: which reading keys to trend, how many to show. */
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => ({ layoutIdx: index("portal_block_layout_idx").on(t.layoutId, t.sortOrder) }));
