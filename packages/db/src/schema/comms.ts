import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, sourceRef } from "./_shared";
import { organization, businessUnit, user } from "./tenancy";
import { customer, contact } from "./crm";
import { job } from "./work";
import { marketingChannel, acquisitionCampaign } from "./acquisition";
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

/* ------------------------------------------------------- phone menus */

/**
 * Where a call goes, as core's router names it: a ring group, a menu, the on
 * call rota, voicemail, a forwarded number or one person. Declared here as
 * the stored shape rather than imported, because this package does not
 * depend on core; the services check every value against core's catalogue
 * before it is written.
 */
export type StoredDestination =
  | { kind: "ring_group"; id: string }
  | { kind: "queue"; id: string }
  | { kind: "voicemail"; box: string }
  | { kind: "forward"; e164: string }
  | { kind: "ivr"; menu: string }
  | { kind: "on_call_rota"; id: string }
  | { kind: "person"; userId: string };

/**
 * A PHONE MENU: "press 1 for service, 2 for billing".
 *
 * The options are a list on the row rather than a table of their own,
 * because a menu is edited and saved as one thing on one screen, and an
 * option means nothing outside the menu it is in. What each option points
 * at is checked against what exists every time the menu is saved, and again
 * when a call reaches it, because a ring group can be deleted afterwards.
 *
 * `after_hours_to` is where calls go outside the company's business hours
 * (the hours online booking keeps). Null means the menu answers at every
 * hour.
 */
export const phoneMenu = pgTable("phone_menu", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  greeting: text("greeting").notNull(),
  options: jsonb("options").$type<{ key: string; label: string; to: StoredDestination }[]>().notNull().default([]),
  noInputTo: jsonb("no_input_to").$type<StoredDestination>().notNull(),
  afterHoursTo: jsonb("after_hours_to").$type<StoredDestination | null>(),
  timeoutSeconds: integer("timeout_seconds").notNull().default(6),
  ...timestamps,
}, (t) => ({
  orgIdx: index("phone_menu_org_idx").on(t.organizationId),
}));

/**
 * A RING GROUP: several phones rung at once, or one after another.
 *
 * Members are people at the company (rung on the number their account holds,
 * resolved at the moment of the call, so a new phone needs no change here)
 * or a number outside it, such as an answering service.
 */
export const ringGroup = pgTable("ring_group", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** `all_at_once` or `in_order`, from core's catalogue. */
  strategy: text("strategy").notNull(),
  ringSeconds: integer("ring_seconds").notNull().default(20),
  members: jsonb("members").$type<{ userId?: string | null; e164?: string | null; label: string }[]>()
    .notNull().default([]),
  noAnswerTo: jsonb("no_answer_to").$type<StoredDestination>().notNull(),
  ...timestamps,
}, (t) => ({
  orgIdx: index("ring_group_org_idx").on(t.organizationId),
}));

/**
 * THE NUMBER A PERSON ANSWERS THE COMPANY'S CALLS ON.
 *
 * What a phone menu option, a ring group or the on call rota actually rings
 * when it rings a person. Kept per company rather than on the person's
 * account, because the same person can work for two companies on two
 * phones, and because it is the office that decides where its calls go:
 * the person's own account page is theirs.
 */
export const answeringPhone = pgTable("answering_phone", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  e164: text("e164").notNull(),
  ...timestamps,
}, (t) => ({
  personIdx: uniqueIndex("answering_phone_person_idx").on(t.organizationId, t.userId),
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
  /**
   * One of the numbers the website snippet swaps onto a page, one per visitor
   * at a time, so a call on it can be matched back to the visit that showed
   * it. Never sent from and never credited to a campaign of its own: the
   * visit it was shown on is its attribution.
   */
  "pool",
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
  /**
   * The CARRIER registration this number sends under. Called `campaign_id`
   * until the marketing module grew a campaign of its own, at which point a
   * column named only "campaign" on the table tracking numbers live in was
   * one somebody would point at the wrong thing.
   */
  messagingCampaignId: uuid("messaging_campaign_id").references(() => messagingCampaign.id, { onDelete: "set null" }),
  /**
   * The tracking campaign a call to this number is credited to, and its
   * channel. Set together, and `attribution_source` is kept equal to the
   * channel's catalogue key, so the number map core reads and the campaign
   * on the screen cannot disagree.
   */
  channelId: uuid("channel_id").references(() => marketingChannel.id, { onDelete: "set null" }),
  acquisitionCampaignId: uuid("acquisition_campaign_id")
    .references(() => acquisitionCampaign.id, { onDelete: "set null" }),
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
  /**
   * The carrier's own id for the number, set when it was bought through this
   * product (Twilio's `PN...`). It is what releasing it at the carrier needs,
   * and its absence is what says a number was typed in by hand and is the
   * operator's to hand back.
   */
  providerNumberId: text("provider_number_id"),
  /**
   * HOW A CALL TO IT IS ANSWERED, for a number whose calls this product
   * routes. Four plain settings rather than a routing table, because a
   * tracking number does one thing: ring the office, and say where the call
   * came from before it connects.
   *
   * `whisper` names the channel and campaign to the person answering.
   * `record_calls` asks the caller whether the call may be recorded, and
   * nothing is recorded unless the recording check then says yes.
   * `route_by_hours` sends calls outside the company's business hours to
   * `after_hours_forwards_to_e164`, or to voicemail when that is empty.
   */
  whisper: boolean("whisper").notNull().default(false),
  recordCalls: boolean("record_calls").notNull().default(false),
  routeByHours: boolean("route_by_hours").notNull().default(false),
  afterHoursForwardsToE164: text("after_hours_forwards_to_e164"),
  /**
   * The phone menu that answers this number, when it has one. Set, it
   * replaces the forward above: in business hours the caller hears the menu,
   * and outside them goes where the menu says.
   */
  menuId: uuid("menu_id").references(() => phoneMenu.id, { onDelete: "set null" }),
  /**
   * WHEN A NUMBER THE COMPANY ALREADY HAD WAS POINTED HERE, rather than
   * bought here.
   *
   * The difference matters most when it stops. A number bought here is
   * released at the carrier when it is released here; a number the company
   * brought with it (the one on the van for twenty years) must never be,
   * because releasing it at the carrier gives it away. So an adopted number
   * keeps where its calls used to go, and "stop answering here" puts that
   * back instead.
   */
  adoptedAt: timestamp("adopted_at", { withTimezone: true }),
  previousVoiceUrl: text("previous_voice_url"),
  previousStatusUrl: text("previous_status_url"),
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
  /**
   * The token in the address an email thread's replies go to,
   * `reply+TOKEN@` the company's reply domain. Random and long, because it
   * is the only thing that decides which thread an incoming email lands in.
   * Null on a text thread and on an email thread nothing has been sent from
   * since replies were turned on.
   */
  replyToken: text("reply_token"),
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
  replyTokenIdx: uniqueIndex("conversation_reply_token_idx").on(t.replyToken)
    .where(sql`${t.replyToken} is not null`),
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
  /**
   * THE THREE THINGS EMAIL HAS AND A TEXT DOES NOT.
   *
   * Email shares everything else on this table with SMS: a direction, a
   * purpose, two addresses, a status, a provider id, a delivery stamp. Giving
   * it a table of its own would split the customer timeline in half and hand
   * the product two outbound paths and one suppression check, which is the
   * exact failure comms-send.ts was written to close.
   *
   * `subject` is per message rather than per conversation because a reply
   * renames the thread ("Re: Invoice 1042") and `conversation.subject` can
   * only hold one of those. What went out is what the log has to show.
   *
   * `body_html` sits beside `body` rather than replacing it, because an email
   * carries both parts and the plain text one is what a spam filter reads
   * when the HTML is missing. Null on SMS, where there is no such thing.
   *
   * `headers` is what we ASKED the provider to set, kept because the header
   * that matters is List-Unsubscribe: a marketing send that went without one
   * is a compliance problem, and a column nobody wrote would leave the
   * question unanswerable after the fact. Reply-To lives in here too, since
   * it is a header; the provider seam surfaces it separately only because
   * every provider API models it separately.
   */
  subject: text("subject"),
  bodyHtml: text("body_html"),
  headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
  /**
   * Pictures and files that came with a text, or went with one.
   *
   * `storageKey` is set when this product kept the bytes as a stored file:
   * an inbound picture fetched from the carrier, or a picture sent from the
   * inbox. `url` is where the CARRIER fetches an outgoing one from (a public
   * address carrying `publicKey`, unguessable and good for a week), or the
   * carrier's own address for something that was not kept. `refused` says
   * why an inbound file was not kept, in words, so the thread can show
   * something other than a gap.
   */
  media: jsonb("media").$type<{
    url: string; contentType: string; bytes?: number;
    storageKey?: string; publicKey?: string; refused?: string;
  }[]>()
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

/**
 * A FILE THAT GOES WITH AN EMAIL.
 *
 * `message.media` is attachments by reference, a URL the provider fetches,
 * which is the MMS shape and assumes an object store this product does not
 * have. A delivered report's CSV is a few kilobytes made at the moment it is
 * sent, so it is kept here as bytes beside the message it belongs to and
 * handed to the provider with it, and the outbox's retry sends the same file
 * the first attempt would have.
 *
 * Bytes in Postgres, for the reason `stored_file` gives: a contractor self
 * hosting this should be able to email a spreadsheet without standing up a
 * bucket first.
 */
export const messageAttachment = pgTable("message_attachment", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => message.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  content: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("content").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  messageIdx: index("message_attachment_message_idx").on(t.organizationId, t.messageId),
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
  /**
   * The rule that GOVERNED this call, resolved from every party's
   * jurisdiction at the moment recording was asked for: one_party, all_party
   * or unknown. Not the company's configured rule, and not a boolean. An
   * operator answering a question about a 2024 call needs the answer the
   * system reached then.
   */
  recordingConsent: text("recording_consent"),
  /** When permission was granted and the first byte could be kept. Null means no recording was ever allowed to start. */
  recordingStartedAt: timestamp("recording_started_at", { withTimezone: true }),
  /**
   * Why recording was refused, as one of core's refusal codes. Stored
   * because "there is no recording" and "we were told not to record" look
   * identical on a row that only carries a null URL, and only one of them is
   * a thing to go and fix.
   */
  recordingRefusal: text("recording_refusal"),
  /** When the recording notice was played. The precondition, not an inference from it. */
  announcementPlayedAt: timestamp("announcement_played_at", { withTimezone: true }),
  recordingDeletedAt: timestamp("recording_deleted_at", { withTimezone: true }),
  /**
   * Where the audio is kept, when this product keeps it: the content
   * addressed key of a stored file. `recording_url` is cleared with it on
   * deletion, and both are only ever written after the recording check said
   * yes for this call.
   */
  recordingStorageKey: text("recording_storage_key"),
  voicemailUrl: text("voicemail_url"),
  /** The voicemail's stored file, for a call this product answered. */
  voicemailStorageKey: text("voicemail_storage_key"),
  /**
   * Why the call went where it went, in one sentence, from core's router.
   * "Why did that customer get voicemail at two in the afternoon" is the
   * question this is kept to answer.
   */
  routedBecause: text("routed_because"),
  /** The readable rendering, already redacted. Never the provider's raw text. */
  transcript: text("transcript"),
  /**
   * The redacted segments with their speakers and offsets, so a viewer can
   * jump to a timestamp. Offsets survive redaction by construction: masking
   * only ever replaces characters, so every segment is exactly as long as it
   * was.
   */
  transcriptSegments: jsonb("transcript_segments").$type<{
    speaker: string; startMs: number; endMs: number; text: string; confidence: number;
  }[]>(),
  /** When the redaction pass ran. The destruction step, dated. */
  transcriptRedactedAt: timestamp("transcript_redacted_at", { withTimezone: true }),
  /**
   * How many of each category were removed. Kept so a viewer can be told a
   * card number was taken out of this call without anybody reopening the
   * audio to find out, and so a spike in card numbers spoken aloud is
   * visible without reading transcripts.
   */
  transcriptRedactionCounts: jsonb("transcript_redaction_counts").$type<Record<string, number>>(),
  /**
   * The same redacted words, without speakers or timestamps, for the search
   * index. Kept apart from `transcript` because that one carries "[00:14]"
   * on every line, and a timestamp in an index is a token: searching for a
   * unit number like "214" would match the clock on a hundred calls.
   */
  transcriptText: text("transcript_text"),
  /**
   * Where transcribing this call's audio stands: `pending` while it waits for
   * the speech to text provider, `done`, or `failed` with the provider's
   * reason. Null for a call with no kept audio, or none that was sent.
   */
  transcriptStatus: text("transcript_status"),
  /** Which audio the transcript is of: `recording` or `voicemail`. Deleting a recording deletes its transcript. */
  transcriptSource: text("transcript_source"),
  transcriptError: text("transcript_error"),
  transcriptAttempts: integer("transcript_attempts").notNull().default(0),
  /**
   * What the caller pressed in each phone menu on the way, in order: the
   * menu, the key and what it was for. "Where it went" says the end of the
   * route; this says the path, which is what an owner reads when a billing
   * question rang the service team.
   */
  menuChoices: jsonb("menu_choices").$type<{ menuId: string; menu: string; key: string | null; label: string; at: string }[]>()
    .notNull().default([]),
  /** What the call was: booked, quote requested, wrong number, spam. */
  disposition: text("disposition"),
  attributionSource: text("attribution_source"),
  /**
   * Whether this was the first time this number had rung the company. Null
   * when nobody can say: a call tracking provider's own answer wins when it
   * sends one, because it has seen calls this product never did.
   */
  firstTimeCaller: boolean("first_time_caller"),
  /**
   * The channel and tracking campaign of the number it arrived on, AT THE
   * TIME. Copied rather than joined for the reason `received_on_e164` is: a
   * number moves to next season's campaign and last season's calls must not
   * move with it.
   */
  channelId: uuid("channel_id").references(() => marketingChannel.id, { onDelete: "set null" }),
  acquisitionCampaignId: uuid("acquisition_campaign_id")
    .references(() => acquisitionCampaign.id, { onDelete: "set null" }),
  providerCallId: text("provider_call_id"),
  ...timestamps,
  ...sourceRef,
}, (t) => ({
  orgIdx: index("call_org_idx").on(t.organizationId, t.startedAt),
  customerIdx: index("call_customer_idx").on(t.customerId),
  numberIdx: index("call_number_idx").on(t.organizationId, t.receivedOnE164),
  /** Full text over the redacted words, for searching the call log. */
  transcriptSearchIdx: index("call_transcript_search_idx")
    .using("gin", sql`to_tsvector('english', coalesce(${t.transcriptText}, ''))`),
  /** The worker's queue: calls whose audio is waiting to be transcribed. */
  transcriptPendingIdx: index("call_transcript_pending_idx").on(t.organizationId)
    .where(sql`${t.transcriptStatus} = 'pending'`),
  /**
   * ONE ROW PER CALL AT THE PROVIDER, AND THE REASON IT IS AN INDEX.
   *
   * A call tracking provider sends several webhooks about one call: a
   * pre-call when it rings, another when it is routed, a post-call when the
   * recording has attached, and a modified one every time somebody adds a
   * tag afterwards. CallRail in particular does not resend a delivery that
   * failed, which means the remedy for a missed one is a backfill over the
   * same window, which replays calls that did land.
   *
   * So the same call arrives repeatedly by design, and the service upserts
   * on this index rather than checking first. A select followed by an insert
   * has a window between the two, and two workers in that window both see
   * nothing and both insert: the operator gets two rows for one call, the
   * duration on each is right, and every count of calls in the business is
   * quietly too high.
   *
   * Partial, because the column is null for every call this product logged
   * itself and a plain unique index would allow exactly one of them.
   */
  providerCallIdx: uniqueIndex("call_provider_call_idx")
    .on(t.organizationId, t.providerCallId)
    .where(sql`${t.providerCallId} is not null`),
}));

/* ------------------------------------------------- recording policy */

/**
 * What the operator has DECLARED about recording in one place.
 *
 * This table holds a claim the operator made, not a statement of law. The
 * software's job is to hold them to it consistently and to refuse to record
 * when their own declaration does not cover the call. Whether the declaration
 * is correct is a question for them and their counsel, which is the same rule
 * the trade packs follow.
 *
 * `jurisdiction` is matched EXACTLY against what is recorded on a party.
 * Nothing here parses it, infers a country from it, or falls back to a prefix
 * match, because a fuzzy match silently applies one place's rule to another.
 *
 * `announcement_required` is separate from `rule` rather than derived from
 * it, because the two move independently: an operator may choose to announce
 * everywhere, and may have advice that one place needs more than an
 * announcement.
 */
export const recordingPolicy = pgTable("recording_policy", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  jurisdiction: text("jurisdiction").notNull(),
  /** One of core's CONSENT_RULES. Checked on write, because a value outside the catalogue would fall through every comparison and behave like the most permissive one. */
  rule: text("rule").notNull(),
  announcementRequired: boolean("announcement_required").notNull().default(true),
  /** The operator's own words, shown on the settings screen. Required: a blank note tells the person deciding whether to turn recording on nothing at all. */
  note: text("note").notNull(),
  ...timestamps,
}, (t) => ({
  jurisdictionIdx: uniqueIndex("recording_policy_jurisdiction_idx")
    .on(t.organizationId, t.jurisdiction)
    .where(sql`${t.deletedAt} is null`),
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
