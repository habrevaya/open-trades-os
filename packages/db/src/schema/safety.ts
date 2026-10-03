import { pgTable, pgEnum, uuid, text, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared";
import { organization, user, technician } from "./tenancy";
import { property } from "./crm";
import { job } from "./work";

/**
 * SAFETY RECORDS
 *
 * Two records a trades company keeps because somebody may ask for them years
 * later: the toolbox talk, which says the crew was told, and the incident
 * report, which says what happened when something went wrong anyway.
 *
 * Neither is a judgement. A toolbox talk records a topic, who was there and
 * who signed, and nothing here decides whether the talk was enough. An
 * incident report records what happened, who was involved and what was done
 * about it, and nothing here decides whether it was reportable to anybody:
 * that depends on the jurisdiction, the injury and what a doctor did, none of
 * which this database can know. The same posture as the rest of compliance,
 * for the same reason.
 */

/**
 * A TOOLBOX TALK, OR ANY SAFETY MEETING.
 *
 * Held at a time and a place, by somebody, about something. The attendees are
 * rows of their own, because each one signs separately and usually from their
 * own phone, often the next morning.
 */
export const safetyMeeting = pgTable("safety_meeting", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** What it was about, in the words used on the day. "Ladder safety", "Heat". */
  topic: text("topic").notNull(),
  /** What was covered. The part an inspector reads. */
  notes: text("notes"),
  heldAt: timestamp("held_at", { withTimezone: true }).notNull(),
  /** Where, as written: the shop, a job site, an address. */
  location: text("location"),
  /** The job it was held on, when it was held on one. */
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  /** Who led it, as a name, because it is often a supplier's rep or a foreman with no account. */
  ledBy: text("led_by"),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /**
   * When the sheet was closed. After this nobody else signs and nobody is
   * added: a sign in sheet that keeps growing for a month after the talk is a
   * sheet that proves nothing about who was in the room.
   */
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedByUserId: uuid("closed_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  heldIdx: index("safety_meeting_held_idx").on(t.organizationId, t.heldAt),
}));

/**
 * One person at one talk, and their signature once they give it.
 *
 * The name is kept as written even when a technician is linked, because a
 * record of who attended has to survive the technician leaving and their row
 * being renamed or removed.
 */
export const safetyMeetingAttendee = pgTable("safety_meeting_attendee", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  meetingId: uuid("meeting_id").notNull().references(() => safetyMeeting.id, { onDelete: "cascade" }),
  /** Linked when the attendee is one of the company's own people, so they can sign from their phone. */
  technicianId: uuid("technician_id").references(() => technician.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  /**
   * The drawn signature, as a stored file. Null until signed, and null for a
   * signature on the paper sheet, which is photographed onto the meeting
   * instead.
   */
  signatureStorageKey: text("signature_storage_key"),
  /** `field` when the person signed on their own phone, `office` when somebody recorded it for them. */
  signedVia: text("signed_via"),
  signedByUserId: uuid("signed_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  meetingIdx: index("safety_meeting_attendee_meeting_idx").on(t.organizationId, t.meetingId),
  /** One line per person per talk. A second line for the same technician would be a second signature. */
  personIdx: uniqueIndex("safety_meeting_attendee_person_idx")
    .on(t.meetingId, t.technicianId).where(sql`technician_id is not null`),
}));

/**
 * WHAT KIND OF THING WENT WRONG.
 *
 * A near miss is here on purpose and first among equals: the companies with
 * the fewest injuries are the ones whose people report the ladder that nearly
 * slipped, and a form that only has room for an injury teaches them not to.
 */
export const incidentKind = pgEnum("incident_kind", [
  "injury", "near_miss", "property_damage", "vehicle", "environmental", "other",
]);

export const incidentStatus = pgEnum("incident_status", ["open", "closed"]);

export const incidentReport = pgTable("incident_report", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  kind: incidentKind("kind").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  /** Where, as written. A property and a job are linked as well when there is one. */
  location: text("location"),
  propertyId: uuid("property_id").references(() => property.id, { onDelete: "set null" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  /** What happened, in the reporter's own words. Never rewritten by anybody else. */
  description: text("description").notNull(),
  /** What was done straight away: first aid given, the area taped off, the van parked. */
  immediateAction: text("immediate_action"),
  status: incidentStatus("status").notNull().default("open"),
  reportedByUserId: uuid("reported_by_user_id").references(() => user.id, { onDelete: "set null" }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedByUserId: uuid("closed_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Why it was closed: what was learned, what changed. */
  closingNote: text("closing_note"),
  ...timestamps,
}, (t) => ({
  occurredIdx: index("incident_report_occurred_idx").on(t.organizationId, t.occurredAt),
  statusIdx: index("incident_report_status_idx").on(t.organizationId, t.status),
}));

export const incidentPersonRole = pgEnum("incident_person_role", ["injured", "involved", "witness"]);

/**
 * Who was there, and how.
 *
 * Rows rather than a list of names on the report, because "every incident this
 * technician was hurt in" is a question somebody asks, and a name in a text
 * column cannot answer it once two people share a first name.
 */
export const incidentPerson = pgTable("incident_person", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  incidentId: uuid("incident_id").notNull().references(() => incidentReport.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").references(() => technician.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  role: incidentPersonRole("role").notNull(),
  /** The injury as described, for somebody injured. Not a diagnosis. */
  injury: text("injury"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  incidentIdx: index("incident_person_incident_idx").on(t.organizationId, t.incidentId),
}));
