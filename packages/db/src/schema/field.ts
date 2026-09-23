import { pgTable, pgEnum, uuid, text, integer, boolean, index, uniqueIndex, timestamp, jsonb } from "drizzle-orm/pg-core";
import { pk, timestamps, sourceRef } from "./_shared";
import { organization } from "./tenancy";
import { technician } from "./tenancy";
import { message } from "./comms";

/**
 * THE FIELD
 *
 * A technician's phone is offline for most of a working day: basements, crawl
 * spaces, mechanical rooms, the middle of a county with one bar. Everything
 * here exists so that the work is recorded anyway and arrives intact.
 *
 * The reasoning about ordering, clock drift and conflict lives in
 * packages/core/src/field, which has no database and is tested without one.
 * This file is the durable record it operates on.
 */

/** A phone or tablet that has been registered to a technician. */
export const device = pgTable("device", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  /** Stable across reinstalls where the platform allows it, so a reinstall
   *  does not orphan the operations already queued under the old identity. */
  installationId: text("installation_id").notNull(),
  label: text("label"),
  platform: text("platform"),
  appVersion: text("app_version"),
  osVersion: text("os_version"),
  pushToken: text("push_token"),

  /**
   * The highest sequence number accepted from this device.
   *
   * The device numbers its own operations from one and never skips, so this is
   * what lets the server notice a gap: a batch starting at 8 when this says 5
   * is a batch missing 6 and 7. Holding the tail is better than rejecting the
   * batch, because the missing operations usually arrive on the next attempt.
   */
  lastSequence: integer("last_sequence").notNull().default(0),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  /**
   * The gap between this and lastSyncedAt is how long somebody was off
   * network, which is the number a dispatcher actually wants when a technician
   * has gone quiet.
   */
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("device_org_idx").on(t.organizationId, t.technicianId),
  installIdx: uniqueIndex("device_installation_idx").on(t.organizationId, t.installationId),
}));

export const operationStatus = pgEnum("operation_status", [
  /** Received, sequence complete, not yet applied. */
  "accepted",
  /** Applied. The normal terminal state. */
  "applied",
  /** Applied, and it disagreed with the state the server holds. A person
   *  needs to look at it. See `conflict`. */
  "conflicted",
  /** Could not be applied and will not be retried. See `rejection`. */
  "rejected",
  /** A later operation replaced this one's effect. Kept, not deleted. */
  "superseded",
  /** Waiting on an earlier operation from the same device. */
  "held",
]);

/**
 * THE LOG
 *
 * Every write from the field, as a named intent rather than a row diff. The
 * difference matters when the world moved while the phone was in a basement: a
 * diff overwrites whatever happened in the meantime and loses the fact that
 * there was a disagreement, while an intent can record that a technician
 * arrived at a visit the office had cancelled, which is two true things that a
 * human needs to see.
 *
 * Append only in practice. An operation that turns out to be wrong is
 * superseded by another one, never edited, because this table is the evidence
 * for what someone was paid and what a customer was billed.
 */
export const fieldOperation = pgTable("field_operation", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => device.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),

  /**
   * Generated on the device, and the idempotency key. A phone that regenerates
   * this on retry will clock its technician in four times from one tap, so the
   * uniqueness is enforced here rather than trusted.
   */
  clientId: text("client_id").notNull(),
  /** Monotonic per device. Not global: two phones share no clock and no order. */
  sequence: integer("sequence").notNull(),
  kind: text("kind").notNull(),
  /** The visit, report, equipment or timeclock entry this is about. */
  subjectId: uuid("subject_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),

  /**
   * When it happened, by the device's clock, after clamping.
   *
   * A phone offline since breakfast may have drifted, may have crossed a
   * timezone, or may have been set by hand by somebody who wanted an earlier
   * punch. An occurrence in the future is clamped to when the server heard
   * about it, and one that runs backwards on its own device is clamped
   * forward.
   */
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  /** What the device claimed, before clamping. Kept because a clamp is
   *  evidence, and throwing it away makes a payroll dispute unanswerable. */
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
  clamped: text("clamped"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),

  status: operationStatus("status").notNull().default("accepted"),
  /** Set when the operation was applied and disagreed with current state. */
  conflict: text("conflict"),
  /** Set when it could not be applied. Returned to the device, not swallowed. */
  rejection: text("rejection"),
  /** The operation that replaced this one's effect. */
  supersededBy: uuid("superseded_by"),
  /** Cleared when a person has dealt with the conflict. */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByUserId: uuid("resolved_by_user_id"),

  /** Where the phone was. Captured at the moment, never inferred later. */
  latitude: text("latitude"),
  longitude: text("longitude"),
  accuracyMeters: integer("accuracy_meters"),
  ...timestamps,
}, (t) => ({
  /** Idempotency. A replay finds the original instead of writing a second. */
  clientIdx: uniqueIndex("field_operation_client_idx").on(t.organizationId, t.clientId),
  /** The gap check: the highest sequence this device has had accepted. */
  deviceIdx: uniqueIndex("field_operation_device_seq_idx").on(t.deviceId, t.sequence),
  subjectIdx: index("field_operation_subject_idx").on(t.organizationId, t.subjectId, t.occurredAt),
  /** The queue a dispatcher works: everything that needs a human. */
  conflictIdx: index("field_operation_conflict_idx").on(t.organizationId, t.status, t.resolvedAt),
}));

export const uploadStatus = pgEnum("upload_status", [
  "queued", "uploading", "stored", "failed", "abandoned",
]);

/**
 * A photo or signature taken offline.
 *
 * The record is created by the operation that references it, before the bytes
 * exist on the server. That ordering is deliberate: a service report that
 * mentions three photos should say so the moment it syncs, with the images
 * arriving behind it, rather than appearing to have none until the last upload
 * finishes over a cellular connection in a van.
 */
export const fieldUpload = pgTable("field_upload", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").references(() => device.id, { onDelete: "set null" }),
  /** The operation that announced it. */
  operationId: uuid("operation_id").references(() => fieldOperation.id, { onDelete: "cascade" }),
  /** Generated on the device so the operation can name it before it exists. */
  clientId: text("client_id").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id"),

  status: uploadStatus("status").notNull().default("queued"),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size"),
  /** SHA-256 of the file, computed on the device. Lets a retry be recognised
   *  as the same image rather than uploaded twice over a metered connection. */
  contentHash: text("content_hash"),
  storageKey: text("storage_key"),
  caption: text("caption"),
  /** Taken at, by the device clock. Not when it finished uploading, which may
   *  be hours later and in a different place. */
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  latitude: text("latitude"),
  longitude: text("longitude"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  storedAt: timestamp("stored_at", { withTimezone: true }),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  clientIdx: uniqueIndex("field_upload_client_idx").on(t.organizationId, t.clientId),
  subjectIdx: index("field_upload_subject_idx").on(t.organizationId, t.subjectType, t.subjectId),
  /** The retry queue. */
  pendingIdx: index("field_upload_pending_idx").on(t.organizationId, t.status, t.attempts),
  hashIdx: index("field_upload_hash_idx").on(t.organizationId, t.contentHash),
}));

/**
 * What the device should hold locally.
 *
 * A technician's phone cannot carry the whole company, and deciding what it
 * carries is a product decision rather than a cache policy: the day's visits,
 * their customers and properties, the equipment at those properties, the price
 * book, and the forms for the job types on the schedule. This records what was
 * sent and when, so a device that has been off for three days is given a delta
 * rather than everything.
 */
export const deviceSnapshot = pgTable("device_snapshot", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => device.id, { onDelete: "cascade" }),
  /** The horizon the device holds: usually today and tomorrow. */
  fromDate: text("from_date").notNull(),
  toDate: text("to_date").notNull(),
  /** Bumped whenever anything in the device's slice changes, so a poll is one
   *  integer comparison rather than a diff of the whole payload. */
  revision: integer("revision").notNull().default(1),
  visitCount: integer("visit_count").notNull().default(0),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  deviceIdx: index("device_snapshot_device_idx").on(t.deviceId, t.sentAt),
}));

/**
 * The customer-facing "on my way" message.
 *
 * Its own table rather than a flag on the visit, because a company that sends
 * two of them has a problem worth seeing, and because the useful question
 * later is how long before arrival it actually went out. A flag answers
 * neither.
 */
export const arrivalNotice = pgTable("arrival_notice", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  visitId: uuid("visit_id").notNull(),
  channel: text("channel").notNull(),
  /**
   * The text this notice actually is.
   *
   * Null when nothing went out, which happens when the customer has replied
   * STOP or the company has no registered number: the row still exists,
   * because the technician did say they were on their way and that is a fact
   * worth keeping, and `failed_reason` says why the customer never heard it.
   *
   * Before this column the notice recorded a send that the code never made.
   * A row saying a message went out, with no message anywhere, is worse than
   * no row: dispatch reads it and stops calling the customer.
   */
  messageId: uuid("message_id").references(() => message.id, { onDelete: "set null" }),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  /** What the technician's phone estimated at the moment of sending. */
  etaMinutes: integer("eta_minutes"),
  /** Set when the technician actually got there, so the estimate can be scored. */
  arrivedAt: timestamp("arrived_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  failedReason: text("failed_reason"),
  includesTracking: boolean("includes_tracking").notNull().default(true),
  ...timestamps,
}, (t) => ({
  visitIdx: index("arrival_notice_visit_idx").on(t.visitId, t.sentAt),
  orgIdx: index("arrival_notice_org_idx").on(t.organizationId, t.sentAt),
}));
