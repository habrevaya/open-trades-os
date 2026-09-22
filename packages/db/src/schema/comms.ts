import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, sourceRef } from "./_shared";
import { organization, businessUnit, user } from "./tenancy";
import { customer, contact } from "./crm";
import { job } from "./work";
import { integrationConnection } from "./integrations";

/**
 * CUSTOMER COMMUNICATIONS
 *
 * Every contractor in this industry runs their business through a phone
 * number, and most of them run it through a personal mobile. The office does
 * not see the text that agreed to a price, nobody knows which ad produced the
 * call, and when a technician leaves, the customer relationship leaves in
 * their pocket. That is the problem this module is for.
 *
 * Three things shape the model, and each of them is a thing that goes wrong
 * in systems that treat messaging as "send an SMS":
 *
 * 1. CONSENT IS PER PURPOSE, NOT PER CUSTOMER. A customer who asked for an
 *    arrival notice has not asked for a spring promotion. Collapsing those
 *    into one "opted in" boolean is the single most common mistake here, and
 *    it is the one that gets a sending number blocked.
 *
 * 2. SENDING IS NOT FREE TO START. A US business cannot send application to
 *    person SMS until a brand and a campaign are registered with the carriers
 *    and approved, which takes days to weeks and can be rejected. Software
 *    that assumes a number can text the moment it is bought will fail at the
 *    worst time, so registration is a first class record with a state.
 *
 * 3. A NUMBER IS AN ATTRIBUTION BOUNDARY. A tracking number per campaign is
 *    how a contractor learns which spend produced work. That only holds if
 *    the number a call arrived on is recorded on the call, permanently, even
 *    after the number is released and reassigned.
 *
 * On the regulatory fields throughout this file: they describe what the
 * SOFTWARE must record and produce, never what a business is required to do.
 * The same rule the trade packs follow. Whether a given recording or message
 * is permitted is a question for the operator and their counsel, and the job
 * here is to make sure that when they answer it, the record exists.
 */

/* ---------------------------------------------------------------- channels */

export const commChannel = pgEnum("comm_channel", ["sms", "mms", "voice", "email", "webchat"]);

/**
 * Why a message is being sent, which is the question consent is actually
 * about.
 *
 * `transactional` is about work in flight: your technician is on the way,
 * here is your invoice, your appointment moved. `marketing` is anything
 * intended to produce more work. The two carry different consent, different
 * revocation behaviour and different quiet hours, and a system with one flag
 * cannot tell them apart.
 */
export const commPurpose = pgEnum("comm_purpose", ["transactional", "marketing"]);

export const commDirection = pgEnum("comm_direction", ["inbound", "outbound"]);

/* ------------------------------------------------------------------ brands */

export const registrationStatus = pgEnum("registration_status", [
  "not_started", "submitted", "pending_review", "approved", "rejected", "suspended",
]);

/**
 * The business identity carriers vet before it may send.
 *
 * Separate from `organization` on purpose. The legal entity that registers
 * with the carriers is not always the tenant: a franchise registers centrally
 * while each location is its own tenant, and a holding company registers once
 * for six brands.
 */
export const messagingBrand = pgTable("messaging_brand", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").references(() => integrationConnection.id, { onDelete: "set null" }),
  legalName: text("legal_name").notNull(),
  displayName: text("display_name").notNull(),
  /** Whatever the provider calls its own registration record. */
  externalBrandId: text("external_brand_id"),
  entityType: text("entity_type"),
  /** Country specific registration identifiers, held opaquely. */
  taxIdLast4: text("tax_id_last4"),
  website: text("website"),
  status: registrationStatus("status").notNull().default("not_started"),
  /** The carrier's own words when it rejects. Shown to the operator verbatim. */
  statusReason: text("status_reason"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("messaging_brand_org_idx").on(t.organizationId),
}));

/**
 * A registered use case. A brand may hold several: one for appointment
 * reminders and one for marketing, which is how the two purposes above stay
 * separable all the way down to the carrier.
 */
export const messagingCampaign = pgTable("messaging_campaign", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  brandId: uuid("brand_id").notNull().references(() => messagingBrand.id, { onDelete: "cascade" }),
  purpose: commPurpose("purpose").notNull(),
  useCase: text("use_case").notNull(),
  description: text("description"),
  externalCampaignId: text("external_campaign_id"),
  status: registrationStatus("status").notNull().default("not_started"),
  statusReason: text("status_reason"),
  /**
   * What was registered as the opt in language and the sample messages.
   * Carriers audit against these, and an operator who changes their web form
   * needs to know what they told the carrier a year ago.
   */
  optInDescription: text("opt_in_description"),
  sampleMessages: jsonb("sample_messages").$type<string[]>().notNull().default([]),
  /** Carrier assigned throughput, so the sender can pace rather than fail. */
  messagesPerSecond: integer("messages_per_second"),
  dailyCap: integer("daily_cap"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  brandIdx: index("messaging_campaign_brand_idx").on(t.brandId),
}));

/* ------------------------------------------------------------------ numbers */

export const phoneNumberPurpose = pgEnum("phone_number_purpose", [
  /** The number on the truck and the invoice. */
  "main",
  /** One per campaign or channel, so an inbound call attributes itself. */
  "tracking",
  /** Assigned to a person, so a technician texts from the company. */
  "user",
  /** Outbound only, for a sending pool. */
  "sending",
  "fax",
]);

/**
 * A phone number the company controls.
 *
 * `releasedAt` rather than a delete, because a released number is reassigned
 * to somebody else within weeks and a call from 2023 still has to say which
 * campaign it arrived on. Deleting the row would silently re-attribute years
 * of history to whoever holds the number next.
 */
export const phoneNumber = pgTable("phone_number", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").references(() => integrationConnection.id, { onDelete: "set null" }),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  /** E.164, always. The one format that is unambiguous across countries. */
  e164: text("e164").notNull(),
  label: text("label"),
  purpose: phoneNumberPurpose("purpose").notNull().default("main"),
  campaignId: uuid("campaign_id").references(() => messagingCampaign.id, { onDelete: "set null" }),
  /** The user this number rings for, when it is theirs. */
  userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
  capabilities: jsonb("capabilities").$type<{ voice?: boolean; sms?: boolean; mms?: boolean; fax?: boolean }>()
    .notNull().default({}),
  /** Where an inbound call goes when nothing else claims it. */
  forwardsToE164: text("forwards_to_e164"),
  /**
   * What a call to this number should be attributed to: a marketing source, a
   * yard sign, a truck wrap. Free text because an operator's own words are
   * more useful here than an enum we invented.
   */
  attributionSource: text("attribution_source"),
  /** Whether the provider has confirmed it may send. */
  smsRegistered: boolean("sms_registered").notNull().default(false),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  ...timestamps,
  ...sourceRef,
}, (t) => ({
  orgIdx: index("phone_number_org_idx").on(t.organizationId, t.purpose),
  /**
   * Unique while held, not forever. A number released and later bought back
   * is legitimately two rows, and the history hanging off the first one must
   * not move to the second.
   */
  liveIdx: uniqueIndex("phone_number_live_idx").on(t.organizationId, t.e164)
    .where(sql`${t.releasedAt} is null`),
}));

/* ------------------------------------------------------------------ consent */

export const consentState = pgEnum("consent_state", ["granted", "revoked", "pending"]);

export const consentMethod = pgEnum("consent_method", [
  "web_form", "verbal", "written", "sms_reply", "checkout", "imported", "api",
]);

/**
 * Consent, per party, per channel, per purpose.
 *
 * Three dimensions because all three vary independently: a customer can take
 * calls and refuse texts, or accept appointment texts and refuse promotions.
 * A single opted-in flag cannot express the customer who said "text me when
 * you're on the way, but stop sending me offers", which is the most common
 * thing a customer actually says.
 *
 * The row is the PROOF, so it keeps when, how, and the exact words shown at
 * the moment of capture. "We have consent" is worth nothing in a dispute
 * without the wording and the timestamp, and the wording changes whenever
 * somebody edits the booking form.
 *
 * Superseded rather than updated: a grant, a revocation and a later grant are
 * three facts, and flattening them to one row loses the history that makes
 * the current state defensible.
 */
export const communicationConsent = pgTable("communication_consent", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contact.id, { onDelete: "cascade" }),
  /** The address consent was given for: an E.164 number or an email. */
  address: text("address").notNull(),
  channel: commChannel("channel").notNull(),
  purpose: commPurpose("purpose").notNull(),
  state: consentState("state").notNull(),
  method: consentMethod("method").notNull(),
  /** The exact wording presented or spoken. The part that is actually proof. */
  proofText: text("proof_text"),
  /** Where it happened: a URL, a form id, a call recording id. */
  proofReference: text("proof_reference"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  capturedByUserId: uuid("captured_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ipAddress: text("ip_address"),
  /** Set when a later row replaces this one, so current state is one lookup. */
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  ...timestamps,
  ...sourceRef,
}, (t) => ({
  lookupIdx: index("communication_consent_lookup_idx")
    .on(t.organizationId, t.address, t.channel, t.purpose, t.supersededAt),
  customerIdx: index("communication_consent_customer_idx").on(t.customerId),
}));

/**
 * A hard stop, independent of any consent row.
 *
 * When somebody replies STOP the carrier itself blocks the number, and the
 * software has to agree with the carrier immediately rather than after the
 * next sync. It is also where a manual do-not-contact lands, which is a
 * different fact from consent never having been given.
 */
export const suppression = pgTable("suppression", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  address: text("address").notNull(),
  channel: commChannel("channel").notNull(),
  /** Null means every purpose, which is what a STOP reply means. */
  purpose: commPurpose("purpose"),
  reason: text("reason").notNull(),
  /** The inbound message that caused it, when there was one. */
  sourceMessageId: uuid("source_message_id"),
  liftedAt: timestamp("lifted_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  /**
   * Two indexes rather than one, because `purpose` is nullable and a null
   * never equals a null: a plain unique index would happily allow two live
   * blanket suppressions for the same address.
   *
   * The obvious fix is `coalesce(purpose::text, 'all')`, and Postgres refuses
   * it: casting an enum to text is not IMMUTABLE, so it cannot appear in an
   * index expression. Splitting on whether the purpose is present says the
   * same thing and is something the database will actually build.
   */
  perPurposeIdx: uniqueIndex("suppression_live_purpose_idx")
    .on(t.organizationId, t.address, t.channel, t.purpose)
    .where(sql`${t.liftedAt} is null and ${t.purpose} is not null`),
  blanketIdx: uniqueIndex("suppression_live_all_idx")
    .on(t.organizationId, t.address, t.channel)
    .where(sql`${t.liftedAt} is null and ${t.purpose} is null`),
}));

/* ------------------------------------------------------- conversations */

export const conversationStatus = pgEnum("conversation_status", [
  "open", "snoozed", "closed", "spam",
]);

/**
 * A thread with one party on one channel.
 *
 * Keyed on the ADDRESS rather than only the customer, because the first
 * message from a new number arrives before anybody knows who it is. The
 * customer link is filled in on match and can be corrected later without
 * losing the thread.
 */
export const conversation = pgTable("conversation", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  channel: commChannel("channel").notNull(),
  /** The customer's side of the thread. */
  externalAddress: text("external_address").notNull(),
  /** The company's side: which of our numbers or inboxes it is on. */
  phoneNumberId: uuid("phone_number_id").references(() => phoneNumber.id, { onDelete: "set null" }),
  internalAddress: text("internal_address"),
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contact.id, { onDelete: "set null" }),
  /** The work being discussed, when the thread is about one job. */
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  subject: text("subject"),
  status: conversationStatus("status").notNull().default("open"),
  assignedUserId: uuid("assigned_user_id").references(() => user.id, { onDelete: "set null" }),
  /**
   * Denormalized so an inbox list is one indexed read. A shared inbox is
   * refreshed constantly and computing it from the messages each time is the
   * difference between instant and unusable.
   */
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  lastMessagePreview: text("last_message_preview"),
  unreadCount: integer("unread_count").notNull().default(0),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  inboxIdx: index("conversation_inbox_idx").on(t.organizationId, t.status, t.lastMessageAt),
  addressIdx: index("conversation_address_idx").on(t.organizationId, t.channel, t.externalAddress),
  customerIdx: index("conversation_customer_idx").on(t.customerId),
  jobIdx: index("conversation_job_idx").on(t.jobId),
}));

export const messageStatus = pgEnum("message_status", [
  "queued", "sending", "sent", "delivered", "undelivered", "failed", "received",
]);

export const message = pgTable("message", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversation.id, { onDelete: "cascade" }),
  direction: commDirection("direction").notNull(),
  channel: commChannel("channel").notNull(),
  purpose: commPurpose("purpose").notNull().default("transactional"),
  fromAddress: text("from_address").notNull(),
  toAddress: text("to_address").notNull(),
  body: text("body"),
  /** Attachments by reference. The bytes live in object storage. */
  media: jsonb("media").$type<{ url: string; contentType: string; bytes?: number }[]>()
    .notNull().default([]),
  status: messageStatus("status").notNull(),
  /**
   * The provider's own id and error. Kept because every real support question
   * about a message that did not arrive is answered from the provider's
   * record, not ours.
   */
  providerMessageId: text("provider_message_id"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  /**
   * Which consent row permitted this send. Null on inbound and on anything
   * sent before consent was recorded, and that nullability is deliberate:
   * a message with no consent row is exactly what an audit needs to find.
   */
  consentId: uuid("consent_id").references(() => communicationConsent.id, { onDelete: "set null" }),
  sentByUserId: uuid("sent_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Set when an automation sent it rather than a person. */
  automationRef: text("automation_ref"),
  templateId: uuid("template_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  ...timestamps,
  ...sourceRef,
}, (t) => ({
  threadIdx: index("message_thread_idx").on(t.conversationId, t.createdAt),
  providerIdx: index("message_provider_idx").on(t.organizationId, t.providerMessageId),
}));

/* ---------------------------------------------------------------- voice */

export const callStatus = pgEnum("call_status", [
  "ringing", "in_progress", "completed", "no_answer", "busy", "failed",
  "voicemail", "abandoned",
]);

/**
 * A phone call.
 *
 * The number it arrived on is copied onto the row rather than only joined,
 * because a tracking number is released and reassigned and the attribution
 * has to survive that. `phoneNumberId` keeps the link while it exists;
 * `receivedOnE164` keeps the fact forever.
 *
 * Recording is stored with the consent state that applied at the time, not
 * as a bare boolean. Some jurisdictions require every party to agree, and an
 * operator answering a question about a 2024 call needs to know what the
 * system did then rather than what it is configured to do now.
 */
export const call = pgTable("call", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  direction: commDirection("direction").notNull(),
  phoneNumberId: uuid("phone_number_id").references(() => phoneNumber.id, { onDelete: "set null" }),
  receivedOnE164: text("received_on_e164"),
  fromE164: text("from_e164").notNull(),
  toE164: text("to_e164").notNull(),
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contact.id, { onDelete: "set null" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  conversationId: uuid("conversation_id").references(() => conversation.id, { onDelete: "set null" }),
  answeredByUserId: uuid("answered_by_user_id").references(() => user.id, { onDelete: "set null" }),
  status: callStatus("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
  /** Time before answer. The number a shop actually manages to. */
  ringSeconds: integer("ring_seconds"),
  recordingUrl: text("recording_url"),
  recordingConsent: text("recording_consent"),
  recordingDeletedAt: timestamp("recording_deleted_at", { withTimezone: true }),
  voicemailUrl: text("voicemail_url"),
  transcript: text("transcript"),
  /** What the call was: booked, quote requested, wrong number, spam. */
  disposition: text("disposition"),
  attributionSource: text("attribution_source"),
  providerCallId: text("provider_call_id"),
  ...timestamps,
  ...sourceRef,
}, (t) => ({
  orgIdx: index("call_org_idx").on(t.organizationId, t.startedAt),
  customerIdx: index("call_customer_idx").on(t.customerId),
  numberIdx: index("call_number_idx").on(t.organizationId, t.receivedOnE164),
}));

/* ------------------------------------------------------------- templates */

/**
 * A reusable message, versioned the way the price book is.
 *
 * The wording a customer was sent is a fact about that message, so editing a
 * template must not rewrite what went out last year. Messages keep their own
 * rendered body; this is what future sends are built from.
 */
export const messageTemplate = pgTable("message_template", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  channel: commChannel("channel").notNull(),
  purpose: commPurpose("purpose").notNull().default("transactional"),
  subject: text("subject"),
  body: text("body").notNull(),
  /** Declared so the editor can offer them and a send can be validated. */
  variables: jsonb("variables").$type<string[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  codeIdx: uniqueIndex("message_template_code_idx").on(t.organizationId, t.code),
}));
