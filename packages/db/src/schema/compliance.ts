import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, timestamp, date } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";
import { organization } from "./tenancy";

/**
 * REGULATORY SUBMISSION AND RETENTION
 *
 * Research across every regulated trade found that the whole surface reduces
 * to nine shared primitives rather than twenty six special cases. Most are
 * already modeled: the regulated product register, the application event, the
 * credentialed actor, the measurement, the deficiency.
 *
 * Two were genuinely missing, and both are here.
 */

export const submissionState = pgEnum("submission_state", [
  "due", "prepared", "submitted", "acknowledged", "rejected", "resubmitted", "waived",
]);

/**
 * Capturing a regulatory record is the easy half. The half that makes a
 * compliance product sticky is SUBMITTING it: the right format for the right
 * authority, on a cadence, with an acknowledgement kept as proof, and a
 * resubmission path when it is rejected.
 *
 * A contractor with three years of accepted submissions in here does not
 * switch software casually, which makes this the strongest retention
 * mechanism in the compliance surface.
 */
export const regulatorySubmission = pgTable("regulatory_submission", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** "epa.608.leak_report", "osha.300a", "tx.structural_pest", "wh347". */
  kind: text("kind").notNull(),
  authorityName: text("authority_name").notNull(),
  jurisdiction: text("jurisdiction"),
  /** The reporting period this covers, which is what makes it deduplicable. */
  periodStart: date("period_start"),
  periodEnd: date("period_end"),
  state: submissionState("state").notNull().default("due"),
  dueOn: date("due_on"),

  /** How it goes: portal, api, sftp, email, mail, in_person. */
  route: text("route"),
  /** Which formatter produced the payload, versioned with the trade pack. */
  formatter: text("formatter"),
  formatterVersion: integer("formatter_version"),

  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  /** Proof. A confirmation number, a stamped receipt, a signed acknowledgement. */
  acknowledgementReference: text("acknowledgement_reference"),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  supersedesId: uuid("supersedes_id"),

  /** What went in, kept because an authority may ask years later. */
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  documentUrl: text("document_url"),
  ...timestamps,
}, (t) => ({
  /** The compliance calendar: what is due and what is overdue. */
  dueIdx: index("regulatory_submission_due_idx").on(t.organizationId, t.state, t.dueOn),
  kindIdx: index("regulatory_submission_kind_idx").on(t.organizationId, t.kind, t.periodEnd),
}));

/**
 * When a retention clock STARTS. This is the finding that would have bitten us.
 *
 * Retention almost never runs from the row's created_at, and the variations are
 * not cosmetic:
 *
 *   OSHA injury records    5 years from the END OF THE CALENDAR YEAR
 *   Lead RRP records       3 years from COMPLETION of the renovation
 *   Driver vehicle reports 3 months from PREPARATION of the report
 *   NFPA 25 ITM records    1 year after the NEXT inspection of that type
 *
 * That last one is the interesting case, and it is why this is an enum rather
 * than an integer on each table: you cannot compute a 2026 inspection's delete
 * date until the 2027 inspection exists. A purge job that assumes created_at
 * plus N years will delete records a contractor is required to still hold.
 */
export const retentionClockStart = pgEnum("retention_clock_start", [
  "record_created",
  "calendar_year_end",
  "work_completed",
  "report_prepared",
  "employment_ended",
  "next_activity_of_type",
  "contract_ended",
  "equipment_removed",
]);

export const retentionPolicy = pgTable("retention_policy", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  entityType: text("entity_type").notNull(),
  /** Narrows the policy within an entity type, e.g. one kind of inspection. */
  entityKind: text("entity_kind"),
  clockStart: retentionClockStart("clock_start").notNull().default("record_created"),
  retainMonths: integer("retain_months").notNull(),
  /** The rule this implements, as a citation, so it can be re-checked. */
  basis: text("basis"),
  tradePackId: text("trade_pack_id"),
  /** Never purge, only mark. Some records a contractor simply keeps. */
  purgeAllowed: boolean("purge_allowed").notNull().default(false),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("retention_policy_org_idx").on(t.organizationId, t.entityType) }));

/**
 * Tax and regulatory constants that CHANGE ON A DATE.
 *
 * Hardcoding one of these is how a system quietly becomes wrong. The immediate
 * example: the 1099-NEC reporting threshold moves to 2,000 dollars for tax
 * years beginning after 2025, with inflation adjustment from 2027. Anything
 * that hardcoded 600 is now wrong, and will be wrong again.
 */
export const regulatoryConstant = pgTable("regulatory_constant", {
  id: pk(),
  /** Global by default, with an organization override where one is needed. */
  organizationId: uuid("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  jurisdiction: text("jurisdiction").notNull().default("US"),
  value: text("value").notNull(),
  unit: text("unit"),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  basis: text("basis"),
  ...timestamps,
}, (t) => ({
  lookupIdx: index("regulatory_constant_lookup_idx").on(t.key, t.jurisdiction, t.effectiveFrom),
}));
