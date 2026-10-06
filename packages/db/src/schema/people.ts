import { pgTable, pgEnum, uuid, text, boolean, integer, index, uniqueIndex, timestamp, date, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared";
import { organization, user, membership, memberRole, role, technician } from "./tenancy";
import { certificationType } from "./qualifications";
import { companyAsset } from "./assets";

/**
 * M24. THE PERSON, BEYOND WHAT THEY ARE QUALIFIED FOR.
 *
 * `qualifications.ts` is who may do what and the proof. This file is the
 * rest of what an office keeps about somebody who works here: how far
 * through their first weeks they are, who to ring when they are hurt on a
 * job, the basic facts of their employment, the hours of continuing
 * education behind a licence renewal, and the skills they have with when
 * and how anybody knows.
 *
 * NOT PAYROLL. The employment record names how a person is paid and the id
 * the payroll bureau knows them by. It holds no rate and no amount: those
 * are payroll's (`workforce.ts`), behind `payroll:read`, and copying one
 * here would put a wage in front of everybody who may read the roster.
 *
 * Keyed on the MEMBERSHIP, not the technician, for everything that is about
 * a person rather than about field work. An office manager is onboarded and
 * has an emergency contact too. Continuing education and skills are keyed on
 * the technician, because that is what the assignment check and the
 * certification register already key on.
 */

/* ------------------------------------------------------- documents to sign */

/**
 * WORDS THE COMPANY ASKS ITS OWN PEOPLE TO SIGN.
 *
 * The handbook, the drug and alcohol policy, the vehicle use agreement. The
 * text is held here rather than as a file, because a signature is worth what
 * the record of what was signed is worth, and a hash of the words shown is
 * that record (`body_hash`, kept on the signature too).
 *
 * NOT EDITABLE. A policy changed after twelve people signed it would leave
 * twelve signatures under words they never saw. A new version is a new
 * document, and the old one is retired with its signatures intact.
 */
export const staffDocument = pgTable("staff_document", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  /** SHA-256 of the title and the body as shown, which every signature against it carries. */
  bodyHash: text("body_hash").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Nobody new is asked to sign it. Those already asked can still sign what they were given. */
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("staff_document_org_idx").on(t.organizationId),
}));

/**
 * ONE PERSON ASKED TO SIGN ONE DOCUMENT, AND WHETHER THEY HAVE.
 *
 * The signature itself is a `document_signature` row, the same record every
 * other signature in the product is, with this row as its subject: who was
 * signed in, when, from where, and the hash of the words. A drawn signature's
 * picture is an attachment on that signature, kind `signature`.
 */
export const staffDocumentRequest = pgTable("staff_document_request", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => staffDocument.id, { onDelete: "cascade" }),
  membershipId: uuid("membership_id").notNull().references(() => membership.id, { onDelete: "cascade" }),
  requestedByUserId: uuid("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  /** `typed` or `drawn`: which way they signed. */
  signedVia: text("signed_via"),
  signatureId: uuid("signature_id"),
  ...timestamps,
}, (t) => ({
  /** One request per person per document, so asking twice asks once. */
  personIdx: uniqueIndex("staff_document_request_person_idx").on(t.documentId, t.membershipId),
  memberIdx: index("staff_document_request_member_idx").on(t.organizationId, t.membershipId),
}));

/* ------------------------------------------------------------------ invites */

/**
 * AN INVITE SENT, AND WHEN ITS LINK STOPS WORKING.
 *
 * The link itself is never here, nor its hash: that is `setup_token`, which
 * nothing in the tenant may read. This is what the team list says beside
 * somebody who has not signed in yet (sent when, by whom, emailed or not,
 * good until when), and what the email outbox asks before it puts a fresh
 * link into the invite's email at the moment of sending.
 *
 * A new invite to the same person replaces the old one: `replaced_at` is
 * set on it, and its links stop working in the same transaction.
 */
export const membershipInvite = pgTable("membership_invite", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  membershipId: uuid("membership_id").notNull().references(() => membership.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  sentByUserId: uuid("sent_by_user_id").references(() => user.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Why it was not emailed, when it was not: no provider, no public address. */
  emailRefusal: text("email_refusal"),
  replacedAt: timestamp("replaced_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  memberIdx: index("membership_invite_member_idx").on(t.organizationId, t.membershipId),
}));

/* --------------------------------------------------------------- onboarding */

/**
 * What an onboarding item is. A document to collect, training to give,
 * equipment to hand over. "Other" for the line that fits none.
 */
export const onboardingItemKind = pgEnum("onboarding_item_kind", [
  "document", "training", "equipment", "other",
]);

/**
 * THE CHECKLIST FOR A ROLE.
 *
 * One row per line, for a preset role or one of the company's own roles,
 * exactly one of the two, for the reason `purchase_approval_rule` gives: a
 * custom role replaces the preset on a membership. Retired with `deleted_at`
 * rather than removed, so a person's progress keeps the line it was copied
 * from.
 */
export const onboardingTemplateItem = pgTable("onboarding_template_item", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  role: memberRole("role"),
  roleId: uuid("role_id").references(() => role.id, { onDelete: "cascade" }),
  kind: onboardingItemKind("kind").notNull(),
  label: text("label").notNull(),
  /** Optional lines count toward nothing; a person is onboarded when every required line is done. */
  required: boolean("required").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  /**
   * A document the person signs themselves, for a line that is one: the
   * handbook, the vehicle use agreement. Starting their onboarding hands it
   * to them, and their signature is what ticks the line.
   */
  staffDocumentId: uuid("staff_document_id").references(() => staffDocument.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  roleIdx: index("onboarding_template_item_role_idx").on(t.organizationId, t.role, t.roleId),
}));

/**
 * ONE PERSON'S LINE, AND WHETHER IT IS DONE.
 *
 * Copied from the template when the person's onboarding starts, label and
 * all, so editing the checklist for the next hire does not rewrite what this
 * one was asked to do.
 */
export const onboardingItem = pgTable("onboarding_item", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  membershipId: uuid("membership_id").notNull().references(() => membership.id, { onDelete: "cascade" }),
  templateItemId: uuid("template_item_id").references(() => onboardingTemplateItem.id, { onDelete: "set null" }),
  kind: onboardingItemKind("kind").notNull(),
  label: text("label").notNull(),
  required: boolean("required").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  doneAt: timestamp("done_at", { withTimezone: true }),
  doneByUserId: uuid("done_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** What was collected or handed over: "I-9 seen", "Gauges, serial 2231". */
  note: text("note"),
  /** The van, the meter or the ladder handed over, when it is on the fleet register. */
  companyAssetId: uuid("company_asset_id").references(() => companyAsset.id, { onDelete: "set null" }),
  /** The document this line is done by signing, copied from the template line. */
  staffDocumentId: uuid("staff_document_id").references(() => staffDocument.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  personIdx: index("onboarding_item_person_idx").on(t.organizationId, t.membershipId),
  /** One copy of each template line per person, so starting twice adds nothing. */
  templateIdx: uniqueIndex("onboarding_item_template_idx").on(t.membershipId, t.templateItemId)
    .where(sql`${t.templateItemId} is not null`),
}));

/* ------------------------------------------------------- emergency contacts */

/**
 * WHO TO RING.
 *
 * Kept by the office rather than in a phone, because the person who needs it
 * is a dispatcher at three in the afternoon when a technician has fallen off
 * a ladder and is not answering. Ordered: the first is rung first.
 */
export const emergencyContact = pgTable("emergency_contact", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  membershipId: uuid("membership_id").notNull().references(() => membership.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  relationship: text("relationship"),
  phone: text("phone").notNull(),
  alternatePhone: text("alternate_phone"),
  note: text("note"),
  priority: integer("priority").notNull().default(1),
  ...timestamps,
}, (t) => ({
  personIdx: index("emergency_contact_person_idx").on(t.organizationId, t.membershipId),
}));

/* -------------------------------------------------------- employment record */

export const employmentType = pgEnum("employment_type", [
  "full_time", "part_time", "seasonal", "temporary", "contractor",
]);

/** How a person is paid, as a reference for payroll. Never what. */
export const payType = pgEnum("pay_type", ["hourly", "salary", "piece_rate", "commission_only"]);

/**
 * THE BASIC FACTS OF SOMEBODY'S EMPLOYMENT.
 *
 * One current row per person, changed in place, with every change in the
 * audit log. The start date is the one fact asked of it most: probation,
 * holiday accrual, the anniversary a company with any sense remembers.
 */
export const employmentRecord = pgTable("employment_record", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  membershipId: uuid("membership_id").notNull().references(() => membership.id, { onDelete: "cascade" }),
  jobTitle: text("job_title"),
  startedOn: date("started_on").notNull(),
  endedOn: date("ended_on"),
  employmentType: employmentType("employment_type").notNull(),
  payType: payType("pay_type").notNull(),
  /** The id the payroll bureau or payroll system knows this person by. */
  payrollReference: text("payroll_reference"),
  ...timestamps,
}, (t) => ({
  personIdx: uniqueIndex("employment_record_person_idx").on(t.organizationId, t.membershipId),
}));

/* ---------------------------------------------------- continuing education */

/**
 * Whether hours count toward a renewal. The office's own entries are approved
 * as they are logged. A person's own wait as `pending` until the office has
 * looked at the certificate, and only `approved` hours are counted.
 */
export const ceStatus = pgEnum("continuing_education_status", ["pending", "approved", "declined"]);

/**
 * HOURS OF CONTINUING EDUCATION, toward a certification's renewal.
 *
 * Logged against the certification TYPE rather than one holding, because a
 * course is often finished before the renewal is recorded, and the hours
 * belong to the cycle they were earned in. The register counts the hours
 * since the current holding was issued against the type's requirement.
 */
export const continuingEducation = pgTable("continuing_education", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  certificationTypeId: uuid("certification_type_id").notNull()
    .references(() => certificationType.id, { onDelete: "cascade" }),
  completedOn: date("completed_on").notNull(),
  hours: numeric("hours", { precision: 7, scale: 2 }).notNull(),
  course: text("course").notNull(),
  provider: text("provider"),
  /** The certificate number or where the certificate is filed. */
  evidence: text("evidence"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Approved unless a person logged it themselves and the office has not answered. */
  status: ceStatus("status").notNull().default("approved"),
  /** The person logged these hours from their own record, with the certificate photographed. */
  selfLogged: boolean("self_logged").notNull().default(false),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedByUserId: uuid("decided_by_user_id").references(() => user.id, { onDelete: "set null" }),
  declineReason: text("decline_reason"),
  ...timestamps,
}, (t) => ({
  personIdx: index("continuing_education_person_idx").on(t.organizationId, t.technicianId, t.certificationTypeId),
}));

/* ------------------------------------------------------------------- skills */

/**
 * A SKILL, WITH WHEN AND HOW ANYBODY KNOWS.
 *
 * `technician.skills` is the list the assignment check reads, and it is a
 * list of strings with no date and no evidence. This is the record behind
 * each entry: since when, and what showed it ("three supervised installs
 * signed off by Dana", "manufacturer course, certificate 88123"). Recording
 * one puts the skill on the list; ending one takes it off and keeps the row,
 * so "could Sam braze in March" still has an answer.
 */
export const technicianSkill = pgTable("technician_skill", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  skill: text("skill").notNull(),
  since: date("since").notNull(),
  evidence: text("evidence").notNull(),
  recordedByUserId: uuid("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  endedOn: date("ended_on"),
  endedReason: text("ended_reason"),
  /**
   * The last day this record stands, for a skill that has to be shown again
   * (a course certificate good for two years, a sign off to be repeated).
   * Null does not expire. Read as a certification's is: still good on the day,
   * expired from the next, and from then the skill stays on the person's list
   * and no longer clears the assignment check.
   */
  expiresOn: date("expires_on"),
  /** How many days before it expires the skill is put on the list to renew. */
  renewalLeadDays: integer("renewal_lead_days").notNull().default(30),
  ...timestamps,
}, (t) => ({
  /** One open record per skill per person; an ended one stays as history. */
  openIdx: uniqueIndex("technician_skill_open_idx").on(t.technicianId, t.skill)
    .where(sql`${t.endedOn} is null`),
}));
