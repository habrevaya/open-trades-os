import { pgTable, pgEnum, uuid, text, integer, jsonb, index, uniqueIndex, timestamp, date, char } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, money } from "./_shared";
import { organization, user } from "./tenancy";
import { customer } from "./crm";
import { job } from "./work";
import { acquisitionCampaign } from "./acquisition";
import { integrationConnection } from "./integrations";
import { consentMethod } from "./comms";

/**
 * THE AD PLATFORMS, SPOKEN TO DIRECTLY
 *
 * Google Ads, Local Services, Meta, Google Analytics and the Google Business
 * Profile, each an ordinary `integration_connection` with its settings and
 * its secret names. These tables are what a connection to one of them needs
 * that no other integration did: a person signing in on the platform's own
 * consent screen, the grant that comes back, the platform's campaigns mapped
 * onto the company's own, and a record of every conversion told to every
 * platform.
 */

/**
 * A SIGN IN IN FLIGHT
 *
 * A person presses "Sign in with Google", leaves for Google's consent screen
 * and comes back with a code and the `state` we gave them. This row is how
 * the code is tied back to the company, the connection and the person who
 * started it, and it is what makes a forged return refused: a `state` nobody
 * here issued, issued to somebody else, used twice or older than a quarter of
 * an hour opens nothing.
 *
 * Only the HASH of the state is kept, the way a password reset token is kept,
 * so a copy of this table cannot be replayed into somebody's connection.
 */
export const oauthAuthorization = pgTable("oauth_authorization", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => integrationConnection.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  stateHash: text("state_hash").notNull(),
  /** Who pressed the button. The return is refused for anybody else. */
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Set the moment the return is accepted, so the same code and state cannot be used twice. */
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  stateIdx: uniqueIndex("oauth_authorization_state_idx").on(t.stateHash),
}));

/**
 * THE GRANT, SEALED
 *
 * `integration_connection.credential_ref` names a secret in the deployment's
 * store and never holds one, and every other integration is set up that way:
 * the operator puts the key in their store and types its name. A refresh
 * token is different in one respect that decides where it lives. Nobody
 * fetches it from a vendor screen to paste into a store; Google hands it to
 * THIS PRODUCT, at the end of a consent screen a person walked through here.
 * Something here has to keep it.
 *
 * So it is kept sealed: AES-256-GCM under a key the deployment holds in its
 * environment (`CREDENTIAL_SEALING_KEY`) and the database never sees. A copy
 * of this table, a backup or a replica, is ciphertext and a fingerprint of
 * which key sealed it. Without the key the product refuses to start a sign
 * in at all and says why, and an operator who would rather keep the token in
 * their own store gives its name as the connection's credential instead and
 * never uses the button.
 *
 * One per connection. A second sign in replaces the first, which is what a
 * person pressing the button again after a revoked grant means.
 */
export const sealedCredential = pgTable("sealed_credential", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => integrationConnection.id, { onDelete: "cascade" }),
  /** `v1:<key fingerprint>:<iv>:<tag>:<ciphertext>`, all base64url. Never the token. */
  sealed: text("sealed").notNull(),
  /** Which key sealed it, so a rotated key is a sentence rather than a decryption error. */
  keyFingerprint: text("key_fingerprint").notNull(),
  /** What the person actually granted, which is not always what was asked for. */
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  grantedByUserId: uuid("granted_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /**
   * When the grant stops working on its own. Null for Google, whose refresh
   * tokens last until revoked. Meta's long lived token lasts about sixty days
   * and cannot be refreshed without the person signing in again, so this is
   * the date the screen counts down to.
   */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** When the platform last handed back a new token in place of this one. */
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  connectionIdx: uniqueIndex("sealed_credential_connection_idx").on(t.connectionId),
}));

/**
 * A PLATFORM'S CAMPAIGN, AND WHICH OF OURS IT IS
 *
 * The spend a platform reports is per ITS campaign, and the funnel groups by
 * the company's tracking campaigns. This is the join between the two: found
 * on the first pull, matched to a tracking campaign by name or utm tag when
 * exactly one agrees, and otherwise left on the platform's channel for a
 * person to map. Mapping one moves every spend row already pulled for it,
 * because a mapping is a statement about the campaign rather than about the
 * day it was made.
 */
export const adPlatformCampaign = pgTable("ad_platform_campaign", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => integrationConnection.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  /** The ad account it lives in: a Google Ads customer id, a Meta ad account id. */
  accountId: text("account_id").notNull(),
  /** The platform's own campaign id. */
  externalId: text("external_id").notNull(),
  /** What the platform calls it, as of the last pull. */
  name: text("name").notNull(),
  /** Google's advertising channel type (SEARCH, LOCAL_SERVICES); null for Meta. */
  channelType: text("channel_type"),
  /** The lead source key its spend is filed under. */
  source: text("source").notNull(),
  acquisitionCampaignId: uuid("acquisition_campaign_id")
    .references(() => acquisitionCampaign.id, { onDelete: "set null" }),
  /** `matched` when the names agreed, `person` when somebody chose; null while unmapped. */
  mappedBy: text("mapped_by"),
  /** The last day it reported any spend, so a list can put live campaigns first. */
  lastSpentOn: date("last_spent_on"),
  ...timestamps,
}, (t) => ({
  externalIdx: uniqueIndex("ad_platform_campaign_idx").on(t.connectionId, t.externalId),
  mappedIdx: index("ad_platform_campaign_mapped_idx").on(t.organizationId, t.acquisitionCampaignId),
}));

/** What a platform is told: a lead when a job is booked, a purchase when it is paid. */
export const adEventKind = pgEnum("ad_event_kind", ["lead", "purchase"]);

/**
 * Where one send stands.
 *
 *   `sending`: claimed, and the request is in flight or died in flight. Sent
 *   again only after a while, and safe to send again, because the platform
 *   deduplicates on the event id the row carries.
 *   `sent`: the platform accepted it.
 *   `withheld`: decided here not to send, with the reason. Consent, nothing
 *   to match on, no credit under the company's model.
 *   `refused`: the platform looked at it and said no, with its words. Not
 *   retried by itself, because the same request gets the same answer.
 *   `failed`: it did not get there. Retried on a ladder, then left.
 */
export const adSendState = pgEnum("ad_send_state", ["sending", "sent", "withheld", "refused", "failed"]);

/**
 * EVERY CONVERSION TOLD TO EVERY PLATFORM, AND EVERY ONE THAT WAS NOT
 *
 * One row per job, per platform, per kind, enforced by a unique index, which
 * is the whole guarantee that a paid job is reported to Google once however
 * many workers, retries and "send now" presses there are. The row is written
 * BEFORE the request goes, so a second worker finds it and leaves it alone.
 *
 * A withheld send is a row too. "Why does Google not know about the Hendersons'
 * furnace" has an answer, and it is usually that they said no, or that
 * nothing about their visit could be matched, and both are worth seeing.
 *
 * What was sent is recorded by NAME (click id, email, phone), never by value:
 * the hashes are not stored, because a table of hashed emails is a table of
 * emails to anybody with a list to hash.
 */
export const adConversionSend = pgTable("ad_conversion_send", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").references(() => integrationConnection.id, { onDelete: "set null" }),
  provider: text("provider").notNull(),
  kind: adEventKind("kind").notNull(),
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
  state: adSendState("state").notNull(),
  /** The id the platform deduplicates on. The same for every attempt at this send. */
  eventId: text("event_id").notNull(),
  /** This platform's share of the job's revenue, for a purchase. */
  value: money("value"),
  currency: char("currency", { length: 3 }),
  /** Which identifiers went, by name. Never their values. */
  identifiers: jsonb("identifiers").$type<string[]>().notNull().default([]),
  /** The click id matched on, which is the platform's own identifier and not a person's. */
  clickId: text("click_id"),
  /** What the platform was told about consent for advertising use. */
  adUserData: text("ad_user_data"),
  /** One of core's withheld reasons, when nothing was sent. */
  withheldReason: text("withheld_reason"),
  /** The reason in words: ours for a withheld send, the platform's for a refused one. */
  detail: text("detail"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  /** THE GUARD. One job, one kind, one platform. */
  sendIdx: uniqueIndex("ad_conversion_send_idx").on(t.organizationId, t.provider, t.kind, t.jobId),
  queueIdx: index("ad_conversion_send_queue_idx").on(t.organizationId, t.state, t.nextAttemptAt),
}));

export const advertisingChoice = pgEnum("advertising_choice", ["granted", "refused"]);

/**
 * WHETHER A CUSTOMER'S DETAILS MAY BE USED TO MEASURE ADVERTISING
 *
 * Not `communication_consent`, which is about whether we may text or email
 * somebody. A customer happy to get appointment texts has said nothing about
 * their email going to Meta, hashed or not, and one who asked never to be
 * texted may be perfectly content for Google to learn that a click became a
 * job. Two questions, two records.
 *
 * Superseded rather than updated, like consent: a yes, a no and a later yes
 * are three facts, with who recorded each and what was said.
 */
export const advertisingConsent = pgTable("advertising_consent", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  choice: advertisingChoice("choice").notNull(),
  method: consentMethod("method").notNull(),
  /** What the customer was told, or what they said, in their words or ours. */
  proofText: text("proof_text"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  capturedByUserId: uuid("captured_by_user_id").references(() => user.id, { onDelete: "set null" }),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  /** One live answer per customer. */
  liveIdx: uniqueIndex("advertising_consent_live_idx").on(t.customerId).where(sql`${t.supersededAt} is null`),
  customerIdx: index("advertising_consent_customer_idx").on(t.organizationId, t.customerId),
}));
