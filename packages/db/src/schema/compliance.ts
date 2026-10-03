import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, timestamp, date } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";
import { organization, user } from "./tenancy";

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
 * A RECORD THAT MUST NOT BE PURGED, WHATEVER ITS AGE.
 *
 * A dispute, a claim, an inspector's letter: once somebody may ask for a
 * record, deleting it on schedule is destroying evidence, and the schedule
 * does not know about the letter. A hold is the operator telling it.
 *
 * Released rather than deleted, so "this was held from March to June because
 * of the Smith claim" survives the claim settling.
 */
export const retentionHold = pgTable("retention_hold", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** The same names a retention policy uses: `incident_report`, `service_report`, ... */
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  reason: text("reason").notNull(),
  placedByUserId: uuid("placed_by_user_id").references(() => user.id, { onDelete: "set null" }),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  releasedByUserId: uuid("released_by_user_id").references(() => user.id, { onDelete: "set null" }),
  releaseNote: text("release_note"),
}, (t) => ({
  entityIdx: index("retention_hold_entity_idx").on(t.organizationId, t.entityType, t.entityId),
}));

/**
 * ONE PASS OF THE PURGE, AND WHAT IT DID.
 *
 * Each record it removed has its own audit line; this is the pass those lines
 * belong to, and it is also how the worker paces itself to once a day per
 * company without a clock of its own.
 */
export const retentionPurgeRun = pgTable("retention_purge_run", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** `worker` on the daily pass, `person` when somebody pressed the button. */
  trigger: text("trigger").notNull(),
  requestedByUserId: uuid("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  purged: integer("purged").notNull().default(0),
  /** Past their date and kept because a hold is on them. */
  held: integer("held").notNull().default(0),
  /** Past their date and kept because removing them failed. The reasons are in `failures`. */
  failed: integer("failed").notNull().default(0),
  failures: jsonb("failures").$type<Array<{ entityType: string; entityId: string; reason: string }>>()
    .notNull().default([]),
}, (t) => ({
  orgIdx: index("retention_purge_run_org_idx").on(t.organizationId, t.startedAt),
}));

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
  /**
   * ALWAYS THE COMPANY'S OWN, THOUGH THE COLUMN IS NULLABLE.
   *
   * This said "global by default, with an organization override where one is
   * needed", and a global row cannot work. `sql/after.sql` applies row level
   * security to every table carrying an `organization_id`, with
   * `organization_id = app.current_organization_id()`, which is never true of
   * NULL, and the table is under `force row level security`. A global figure
   * would be written successfully and then be invisible to every tenant,
   * including the one that wrote it, with no symptom beyond a lookup that
   * finds nothing.
   *
   * So the service writes the organization on every constant, which also
   * suits the decision that this product ships no figures of its own: a
   * threshold seeded by the repository would be the repository telling a
   * contractor what the law says, and a wrong one would be silently wrong in
   * every deployment until a release fixed it.
   *
   * The column stays nullable rather than being tightened, because making it
   * NOT NULL is a migration against a shared security file while several
   * things are in flight. If a genuinely global row is ever wanted it needs
   * its own select policy and a seeding path, not a null and a hope.
   */
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

/**
 * WHAT A DOCUMENT IS DOING ON FILE.
 *
 * `active` is the one in force. `superseded` is the one a renewal replaced,
 * and it is kept rather than overwritten because the question an authority or
 * an insurer asks years later is "what were you holding in March", which a
 * register that only remembers the current certificate cannot answer.
 * `withdrawn` is one the operator pulled: revoked, issued in error, or simply
 * no longer theirs.
 *
 * THERE IS NO `expired` STATE, and that is the important absence. Expiry is a
 * date arriving, not a decision anybody records, so a stored state for it
 * would be a column that is only correct while some sweep is running. The
 * same argument `obligation` makes about breaches: a monitoring surface whose
 * failure mode is a clean bill of health is worse than none. Expiry is
 * computed from `expires_on` against the clock on every read.
 */
export const complianceDocumentState = pgEnum("compliance_document_state", [
  "active", "superseded", "withdrawn",
]);

/**
 * A DOCUMENT WITH AN EXPIRY SOMEBODY HAS TO ACT ON.
 *
 * A contractor's licence, a certificate of insurance, a permit, a safety data
 * sheet, a technician's training card. The valuable part is not keeping the
 * file: `stored_file` and `attachment` already do that, and this table does
 * not duplicate them. The valuable part is the date, and the person who has
 * to do something about it before it arrives.
 *
 * WHY THERE IS NO SECOND DEADLINE MECHANISM HERE. There is no `next_action_at`
 * column, no reminder table, no sweep. `obligation` exists for exactly this
 * and its own comment says why one table rather than a date column on six:
 * "the thing everyone actually needs is what is about to breach, across all
 * of them". A renewal that lived only in this table would be a deadline on a
 * compliance screen instead of in the queue the office works, which is how a
 * licence lapses in a product that knew the date.
 *
 * WHAT IT DOES NOT CLAIM. This is an inventory of documents the operator put
 * here. Nothing in it knows which documents a business is required to hold:
 * that depends on jurisdiction, trade, contract and insurer, and it changes.
 * So the register can say that a document expired, and it can never say that
 * the set on file is complete. `required_for_work` below is the operator's
 * own declaration about their own work, held against them consistently, and
 * is not a statement about law.
 */
export const complianceDocument = pgTable("compliance_document", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** "licence", "insurance", "permit", "sds", "training", "registration". */
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  /** The number on the document: licence number, policy number, permit number. */
  reference: text("reference"),
  /** Who issued it. A state board, an insurer, a city, a manufacturer. */
  issuerName: text("issuer_name"),
  jurisdiction: text("jurisdiction"),

  /**
   * What the document is about, or null for the company itself.
   *
   * A string pair rather than six nullable foreign keys, the same shape
   * `attachment` and `obligation` use, because the alternative is a column
   * per subject and a new migration every time a document can belong to one
   * more kind of thing.
   *
   * A PERSON'S OWN CREDENTIAL DOES NOT BELONG HERE. `person_certification`
   * is the register for what an individual holds, with the certification
   * type's own renewal lead time on it, and a technician's licence recorded
   * in both places is two expiry dates for one card. What belongs here is a
   * document the COMPANY holds: its contractor licence, its liability cover,
   * a permit on a job, a product's safety data sheet.
   */
  subjectType: text("subject_type"),
  subjectId: uuid("subject_id"),

  issuedOn: date("issued_on"),
  /**
   * Null means it does not expire. A safety data sheet is reissued when the
   * formulation changes rather than on a date, and giving it an invented
   * expiry would put a false deadline in the queue every year.
   */
  expiresOn: date("expires_on"),
  /**
   * How many days of notice the renewal needs, which is a fact about the
   * issuer's turnaround and the operator's own process. The default is a
   * starting point the operator changes, never a claim about any authority:
   * a state board that takes ten weeks and a certificate of insurance the
   * broker reissues the same afternoon are both in here.
   */
  noticeDays: integer("notice_days").notNull().default(30),
  /**
   * The operator's declaration that work they marked as needing this should
   * not be assigned while it is lapsed. Their claim, not ours, and the same
   * posture `recording_policy` takes: the software's job is to hold them to
   * what they declared, and whether the declaration is right is a question
   * for them and their counsel.
   */
  requiredForWork: boolean("required_for_work").notNull().default(false),

  state: complianceDocumentState("state").notNull().default("active"),
  /** The document this one renewed, so the history is a chain rather than edits. */
  supersedesId: uuid("supersedes_id"),
  /** Required when withdrawing. A withdrawal with no reason reads as a mistake. */
  withdrawnReason: text("withdrawn_reason"),
  notes: text("notes"),
  ...timestamps,
}, (t) => ({
  /** The renewal screen: what is in force and when it runs out. */
  expiryIdx: index("compliance_document_expiry_idx").on(t.organizationId, t.state, t.expiresOn),
  subjectIdx: index("compliance_document_subject_idx").on(t.organizationId, t.subjectType, t.subjectId),
}));
