import { pgTable, pgEnum, uuid, text, integer, boolean, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared";
import { organization, user } from "./tenancy";
import { device } from "./field";

/**
 * TELLING THE COMPANY'S OWN PEOPLE
 *
 * A notice is one sentence about one record for one person: an order waits
 * for your approval, your expense was refused, your EPA card runs out in a
 * month. It goes where that person said they want it, in the app (the bell),
 * on the phone app, and by text to their own mobile, and never anywhere for a
 * record they could not open. The rules are core's `notices`; the raising,
 * the sending and the reading are `services/staff-notices.ts`.
 *
 * Kept apart from `message` on purpose. A message is a conversation with a
 * customer that the whole office reads in the inbox; a notice to a member of
 * staff names records only they may open, and putting its words in the inbox
 * would tell everybody who reads it.
 */

/**
 * ONE NOTICE TO ONE PERSON.
 *
 * Keyed on what raised it (`source_key`, per person), so a worker reading the
 * same late task twice, an approval asked again by a retry, or a licence
 * looked at on every pass raises one notice and not one per look.
 *
 * Written even when the person has switched this kind off everywhere, with
 * `in_app` false and nothing to deliver, because the row is also the record
 * that this person was told, or chose not to be, and a worker that raises a
 * licence notice "once" needs somewhere to remember it did.
 */
export const staffNotice = pgTable("staff_notice", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  /** One of core's `NOTICE_KINDS`. */
  kind: text("kind").notNull(),
  /** What raised it, unique per person: "task_escalation:{id}", "expense:{id}:refused". */
  sourceKey: text("source_key").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  /** The record it is about. Not a foreign key: a notice outlives a record somebody removed. */
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  /**
   * Where opening it goes, for THIS person: their own `/me` for their own
   * licence, `/people/{id}` for a manager told about somebody else's. Worked
   * out when it is raised and checked again when it is opened.
   */
  href: text("href").notNull(),
  /** Whether the bell shows it. False when the person switched this kind off in the app. */
  inApp: boolean("in_app").notNull().default(true),
  readAt: timestamp("read_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  sourceIdx: uniqueIndex("staff_notice_source_idx").on(t.organizationId, t.userId, t.sourceKey),
  /** The bell: one person's newest first. */
  personIdx: index("staff_notice_person_idx").on(t.organizationId, t.userId, t.createdAt),
}));

/**
 * A PERSON'S SWITCHES FOR ONE KIND OF NOTICE.
 *
 * A row only for a kind they changed; every other kind takes core's
 * `DEFAULT_SWITCHES` (in the app and on the phone, never a text).
 */
export const staffNoticeSetting = pgTable("staff_notice_setting", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  inApp: boolean("in_app").notNull(),
  push: boolean("push").notNull(),
  text: boolean("text").notNull(),
  /**
   * Whether this kind also comes by email to their address on the company's
   * own email. Null, the default, is "not chosen": the kind's own default
   * applies (on for a licence or skill running out, which is emailed, and
   * meaningless for a kind nothing emails). Only a kind core lists as emailed
   * ever reads it.
   */
  email: boolean("email"),
  ...timestamps,
}, (t) => ({
  kindIdx: uniqueIndex("staff_notice_setting_kind_idx").on(t.organizationId, t.userId, t.kind),
}));

export const staffTextConsentState = pgEnum("staff_text_consent_state", ["granted", "revoked"]);

/**
 * A MEMBER OF STAFF'S OWN SAY SO TO BE TEXTED.
 *
 * Not `communication_consent`, which is a customer's, and the two are kept
 * apart deliberately: a technician who is also a customer at their own house
 * has said yes to one and not to the other, and neither may stand in for the
 * other. Only the person can write one, from their own page; nobody in the
 * office can turn somebody else's texts on.
 *
 * Superseded rather than updated, like a customer's consent: a yes, a no and
 * a later yes are three facts, and the row keeps the exact words they agreed
 * to and when, which is what a consent is worth.
 */
export const staffTextConsent = pgTable("staff_text_consent", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  /** Their mobile, in E.164. */
  address: text("address").notNull(),
  state: staffTextConsentState("state").notNull(),
  /** The words shown beside the box they ticked. */
  proofText: text("proof_text"),
  ipAddress: text("ip_address"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  /** At most one current row per person. */
  currentIdx: uniqueIndex("staff_text_consent_current_idx").on(t.organizationId, t.userId)
    .where(sql`${t.supersededAt} is null`),
}));

export const staffDeliveryChannel = pgEnum("staff_delivery_channel", ["push", "sms", "email"]);

export const staffDeliveryStatus = pgEnum("staff_delivery_status", [
  /** Waiting to go on the next pass. */
  "queued",
  /** A text inside the company's quiet hours, waiting for `hold_until`. */
  "held",
  /** Claimed by a worker that is handing it over now. */
  "sending",
  "sent",
  "failed",
  /** Not sent, on purpose, with the reason in `error`. */
  "skipped",
]);

/**
 * ONE NOTICE GOING TO ONE PHONE APP, ONE MOBILE NUMBER OR ONE MAILBOX.
 *
 * A row per channel per destination rather than a call that leaves no trace,
 * for the question somebody asks the day after: was I told, and if not, why
 * not. Keyed on the notice, the channel and the destination (a device id, a
 * number or a mailbox), so a pass cut short and repeated sends one buzz, one
 * text and one email.
 */
export const staffNoticeDelivery = pgTable("staff_notice_delivery", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  noticeId: uuid("notice_id").notNull().references(() => staffNotice.id, { onDelete: "cascade" }),
  channel: staffDeliveryChannel("channel").notNull(),
  /** The phone, for a push. */
  deviceId: uuid("device_id").references(() => device.id, { onDelete: "cascade" }),
  /** The number, for a text: the one their consent named when it was raised. The mailbox, for an email. */
  address: text("address"),
  /** The device id, the number or the mailbox, whichever this is, for the unique key. */
  target: text("target").notNull(),
  status: staffDeliveryStatus("status").notNull().default("queued"),
  /** A push inside quiet hours goes without sound, as a technician's does. */
  quiet: boolean("quiet").notNull().default(false),
  holdUntil: timestamp("hold_until", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  /** The push service's ticket, which its receipt is asked about by. */
  ticketId: text("ticket_id"),
  /** The carrier's id for a text. */
  providerMessageId: text("provider_message_id"),
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  receiptCheckedAt: timestamp("receipt_checked_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  targetIdx: uniqueIndex("staff_notice_delivery_target_idx").on(t.noticeId, t.channel, t.target),
  statusIdx: index("staff_notice_delivery_status_idx").on(t.organizationId, t.status, t.createdAt),
}));
