import { pgTable, pgEnum, uuid, text, integer, index, uniqueIndex, timestamp, date, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, money } from "./_shared";
import { organization } from "./tenancy";
import { customer } from "./crm";
import { job } from "./work";
import { call } from "./comms";
import { marketingChannel, acquisitionCampaign } from "./acquisition";

/**
 * MARKETING, AND THE ONE THING THAT MAKES IT POSSIBLE
 *
 * `packages/core/src/marketing` is eighteen hundred lines that knew how to
 * parse a touch, credit it under five named attribution models, validate a
 * lead form and summarise ad spend against results. Exactly one of those was
 * reached in production, and only barely: booking called `parseTouch` and
 * then threw the whole touch away except for `.source`, which it wrote onto
 * the request as a string.
 *
 * That single line is the reason none of the rest could work. Attribution is
 * a property of a SEQUENCE of touches, and the product was keeping one word
 * per lead. Every model in core needs a list and there was no list, so
 * `attribute`, `creditRevenue` and `compareModels` had no possible caller.
 *
 * WHY A TOUCH IS ITS OWN ROW RATHER THAN COLUMNS ON THE LEAD
 *
 * The usual shape is `first_source` and `last_source` on the customer, and it
 * cannot answer the question a contractor actually has. A homeowner sees a
 * van, searches the company name, reads a review, clicks an ad two weeks
 * later and rings the number on a fridge magnet. Two columns keep the van and
 * the magnet and lose the rest, and the ad account looks worthless. Five rows
 * keep all of it, and which of them gets the credit becomes a question the
 * reader chooses a model for rather than one the schema decided years ago.
 *
 * ANONYMOUS FIRST, STITCHED LATER. Most touches happen before anybody knows
 * who the person is. `visitor_id` is a cookie or a device identifier and is
 * the only thing tying them together until a form is filled in, at which
 * point `customer_id` is written onto the whole history at once.
 */

/** How we decided what a touch was. Mirrors core's `TouchBasis`. */
export const touchBasis = pgEnum("touch_basis", [
  "utm", "click_id", "tracked_number", "referrer", "declared", "none",
]);

export const marketingTouch = pgTable("marketing_touch", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),

  /**
   * The anonymous thread. A cookie, a device id, whatever the front end can
   * keep. Never a fingerprint: a value derived from a browser's
   * characteristics identifies somebody who took steps not to be identified,
   * and this product does not do that.
   */
  visitorId: text("visitor_id"),
  /** Written across the whole visitor history the moment the person is known. */
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "cascade" }),
  /** Set when a touch led to work, so a job can be credited without a join through the customer. */
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),

  /** A key from core's lead source catalogue. Checked on write against it. */
  source: text("source").notNull(),
  basis: touchBasis("basis").notNull(),

  /**
   * The company's channel and tracking campaign, resolved when the touch is
   * written: from the number dialled, then from the utm_campaign, then from
   * the channel the source key maps to. Resolved once and kept, because a
   * campaign renamed or a number moved next spring must not rewrite which
   * campaign last spring's call belonged to.
   */
  channelId: uuid("channel_id").references(() => marketingChannel.id, { onDelete: "set null" }),
  acquisitionCampaignId: uuid("acquisition_campaign_id")
    .references(() => acquisitionCampaign.id, { onDelete: "set null" }),
  /** The call this touch is, when it is one. */
  callId: uuid("call_id").references(() => call.id, { onDelete: "set null" }),
  /**
   * The number that rang, in E.164. The anonymous thread for a caller in the
   * way `visitor_id` is for a browser: when a customer is created with this
   * phone, or a customer's phone is changed to it, every call they made
   * before anybody knew who they were becomes theirs.
   */
  callerE164: text("caller_e164"),
  /**
   * Set when a PERSON declared the source (a CSR choosing "Google Ads" on the
   * new job form), as against a marketplace declaring it over a signed
   * webhook. Both are `declared`; only one of them is somebody's memory of
   * what a customer said on the phone.
   */
  enteredByUserId: uuid("entered_by_user_id"),
  /**
   * The customer whose referral link this visit arrived through. Set only
   * with source `referral_customer`, and it is what names the referrer on
   * the report rather than leaving "a referral" as the whole answer.
   */
  referrerCustomerId: uuid("referrer_customer_id").references(() => customer.id, { onDelete: "set null" }),

  /**
   * Stored as five columns rather than one blob, because every one of them
   * is something an owner groups a report by, and a jsonb key nobody can
   * index is a dimension nobody uses.
   */
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmTerm: text("utm_term"),
  utmContent: text("utm_content"),

  /** gclid, msclkid, fbclid. The thing an ads platform matches a conversion on. */
  clickId: text("click_id"),
  /**
   * Which parameter carried the click id: gclid, gbraid, wbraid, fbclid or
   * msclkid. Google takes the three of its own in three different fields and
   * refuses one sent in the wrong one, so a conversion cannot be sent back
   * from the value alone.
   */
  clickIdParam: text("click_id_param"),
  /**
   * The browser's Google Analytics client id, read by the website snippet
   * from the `_ga` cookie the company's own analytics tag set. It is what a
   * lead or a purchase sent to Google Analytics is tied to, so the booked job
   * lands on the visit in the company's own analytics rather than as a
   * stranger.
   */
  gaClientId: text("ga_client_id"),
  /** Meta's browser id, from the `_fbp` cookie its pixel sets on the company's site. */
  metaBrowserId: text("meta_browser_id"),
  /** Lower case, without `www.`, and never one of our own hosts. */
  referrerHost: text("referrer_host"),
  landingPath: text("landing_path"),
  /**
   * The number they dialled. Dynamic number insertion means the number IS
   * the tag, and it is the only tag a yard sign or the side of a van can
   * carry.
   */
  trackedNumberE164: text("tracked_number_e164"),

  /**
   * What was written when the source could not be placed, kept verbatim.
   *
   * This is not diagnostics. It is the worklist: every row here is a real
   * campaign somebody is spending money on that no report can group, and
   * working through it is how the alias list gets better. Discarding it is
   * how a company ends up with a quarter of its leads under `unknown` and no
   * way to find out what they were.
   */
  unrecognised: text("unrecognised"),

  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  ...timestamps,
}, (t) => ({
  visitorIdx: index("marketing_touch_visitor_idx").on(t.organizationId, t.visitorId, t.occurredAt),
  customerIdx: index("marketing_touch_customer_idx").on(t.organizationId, t.customerId, t.occurredAt),
  /** The worklist: unplaced sources, newest first. */
  unrecognisedIdx: index("marketing_touch_unrecognised_idx")
    .on(t.organizationId, t.occurredAt)
    .where(sql`${t.unrecognised} is not null`),
  sourceIdx: index("marketing_touch_source_idx").on(t.organizationId, t.source, t.occurredAt),
  callerIdx: index("marketing_touch_caller_idx").on(t.organizationId, t.callerE164)
    .where(sql`${t.callerE164} is not null`),
  jobIdx: index("marketing_touch_job_idx").on(t.organizationId, t.jobId),
}));

/**
 * WHAT A CHANNEL COST, PER DAY
 *
 * A day rather than a month, because a contractor's spend moves with the
 * weather and a monthly figure cannot answer "what did the heat wave week
 * cost us per booked job". A day is also the grain every ads platform
 * exports, so an import is a copy rather than an aggregation somebody has to
 * be able to explain.
 *
 * `impressions` and `clicks` are nullable and stay that way. Some spend has
 * neither: a yard sign, a radio spot, a sponsorship. A schema that required
 * them would push offline spend out of the report, and offline spend is most
 * of what a trades company buys.
 *
 * NOTHING HERE IS A RESULT. Leads, jobs and revenue are counted from the
 * touches and the work, never written onto a spend row, for the same reason
 * a stock level is derived: a stored conversion count is a number somebody
 * can edit into agreement with a target.
 */
export const adSpend = pgTable("ad_spend", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** A key from core's lead source catalogue. */
  source: text("source").notNull(),
  /** Free text, matching what the platform calls it. A label, never a dimension. */
  campaign: text("campaign"),
  /**
   * The company's channel and tracking campaign this money went to, which
   * ARE dimensions. `source` stays the catalogue key so the roll up keeps
   * working for a row that names neither.
   */
  channelId: uuid("channel_id").references(() => marketingChannel.id, { onDelete: "set null" }),
  acquisitionCampaignId: uuid("acquisition_campaign_id")
    .references(() => acquisitionCampaign.id, { onDelete: "set null" }),
  spentOn: date("spent_on").notNull(),
  amount: money("amount").notNull(),
  impressions: integer("impressions"),
  clicks: integer("clicks"),
  /**
   * Where this row came from: `manual`, or the provider that reported it.
   * Kept so a figure somebody typed is never silently overwritten by an
   * import, and so an import can be re-run without doubling the month.
   */
  origin: text("origin").notNull().default("manual"),
  /** The platform's own id for the row, when it has one. Makes an import idempotent. */
  externalId: text("external_id"),
  ...timestamps,
}, (t) => ({
  /**
   * One row per source per campaign per day per origin. An import that runs
   * twice updates rather than doubles; a figure typed by hand and a figure
   * pulled from an API are allowed to coexist and be told apart, because an
   * operator reconciling them needs to see both.
   */
  uniq: uniqueIndex("ad_spend_uniq_idx")
    .on(t.organizationId, t.source, t.campaign, t.spentOn, t.origin)
    .where(sql`${t.deletedAt} is null`),
  dateIdx: index("ad_spend_date_idx").on(t.organizationId, t.spentOn),
}));

/**
 * A FORM SOMEBODY CAN FILL IN
 *
 * `checkForm` and `checkSubmission` in core validate a definition and then a
 * submission against it, with per-field refusals a visitor can act on. Both
 * were unreachable, because a form definition had nowhere to live.
 *
 * THE DEFINITION IS DATA AND IS VALIDATED TWICE: when it is stored, and
 * again when a submission is checked against it. The same rule the report
 * definitions follow. A form is edited by an office user and then executed
 * against input from the open internet, so trusting what is in the column is
 * trusting whatever was in it the last time somebody had access.
 */
export const webForm = pgTable("web_form", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** What the embed code names. Stable across edits, unlike the title. */
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  /** Core's `FormDefinition`. Validated by `checkForm` before it is stored. */
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  /** Where a submission lands when it is not a booking: a source key for the touch it creates. */
  source: text("source").notNull().default("website"),
  /**
   * The form's address on the hosted page, `/f/{key}`. Unique across every
   * company, because the page is reached before anybody knows whose form it
   * is, and random rather than the slug, because two companies may both call
   * a form "quote".
   */
  publicKey: text("public_key"),
  /**
   * What happens after a good submission: a confirmation text or email to the
   * person who sent it, and the sentence the page shows. Data the office
   * edits, never code.
   */
  settings: jsonb("settings").$type<{
    thankYou?: string; confirmationText?: string;
    confirmationEmailSubject?: string; confirmationEmailBody?: string;
  }>().notNull().default({}),
  ...timestamps,
}, (t) => ({
  slugIdx: uniqueIndex("web_form_slug_idx").on(t.organizationId, t.slug).where(sql`${t.deletedAt} is null`),
  publicKeyIdx: uniqueIndex("web_form_public_key_idx").on(t.publicKey).where(sql`${t.publicKey} is not null`),
}));

export const formSubmissionState = pgEnum("form_submission_state", [
  "received", "accepted", "rejected", "spam",
]);

/**
 * WHAT SOMEBODY SENT, KEPT WHETHER OR NOT IT WAS ANY GOOD
 *
 * A rejected submission is stored, with its refusals, and that is the point.
 * A form that silently drops what it cannot parse is a form whose owner
 * believes it works: the leads it loses are invisible by construction, and
 * the first evidence is a customer ringing to ask why nobody called back.
 */
export const formSubmission = pgTable("form_submission", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  formId: uuid("form_id").notNull().references(() => webForm.id, { onDelete: "cascade" }),
  state: formSubmissionState("state").notNull().default("received"),
  /** Exactly what arrived, before anything was decided about it. */
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  /** What survived validation, in core's cleaned shape. Null when it was refused. */
  clean: jsonb("clean").$type<Record<string, unknown>>(),
  /** Per field, in core's shape, so the visitor can be told what to fix. */
  refusals: jsonb("refusals").$type<{ field: string; reason: string; message: string }[]>()
    .notNull().default([]),
  touchId: uuid("touch_id").references(() => marketingTouch.id, { onDelete: "set null" }),
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  formIdx: index("form_submission_form_idx").on(t.organizationId, t.formId, t.createdAt),
  stateIdx: index("form_submission_state_idx").on(t.organizationId, t.state, t.createdAt),
}));

/* ------------------------------------------------------------- campaigns */

/**
 * THE SEND, WHICH M19 HAD NO TABLE FOR
 *
 * Everything above this line measures what somebody else's channel sent us.
 * A contractor's best list is the one they already own, and until these three
 * tables there was nowhere to describe a send to it, nowhere to record who it
 * went to, and no way for a job six weeks later to say which campaign brought
 * it in. `job.campaign_id` has been on the job table from the beginning, with
 * no foreign key, written by nothing and read by nothing, waiting for this.
 */

export const campaignChannel = pgEnum("campaign_channel", ["sms", "email"]);

export const campaignState = pgEnum("campaign_state", [
  "draft", "scheduled", "sending", "sent", "cancelled",
]);

/** Which half of an A/B test a recipient was put in. Every recipient of a campaign with no test is `a`. */
export const campaignVariant = pgEnum("campaign_variant", ["a", "b"]);

export const campaignRecipientState = pgEnum("campaign_recipient_state", [
  "pending", "queued", "skipped",
]);

/**
 * One send to a selected part of the customer list.
 *
 * THE AUDIENCE IS STORED AS RULES, NOT AS A LIST OF PEOPLE, and the recipients
 * are frozen when the send starts. Both halves matter. Rules are what an owner
 * can read back and change; a stored list of four thousand ids is not
 * reviewable by anybody. But once the send begins, who it went to is a fact,
 * so `campaign_recipient` is written then and never recomputed: re-running the
 * rules a month later would answer a different question and quietly rewrite
 * history.
 *
 * NOTHING HERE COUNTS ANYTHING. Sent, skipped, replied, booked and revenue are
 * all derived from the recipient rows and the work, for the same reason a
 * stock level is derived: a stored total is a number somebody can edit into
 * agreement with what they hoped for.
 */
export const marketingCampaign = pgTable("marketing_campaign", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  channel: campaignChannel("channel").notNull(),
  state: campaignState("state").notNull().default("draft"),

  /** Core's `AudienceRule[]`, validated by `checkAudience` on every write. */
  audience: jsonb("audience").$type<Record<string, unknown>[]>().notNull().default([]),

  /** Null on an SMS campaign, and refused if present: a text has no subject. */
  subject: text("subject"),
  body: text("body").notNull(),

  /**
   * THE SECOND VERSION OF AN A/B TEST, when there is one. `body` and `subject`
   * are version A. Null body means no test: every recipient gets version A.
   * Fixed with the rest of the words once the campaign has gone, and the half a
   * person is in is written on their recipient row, so changing nothing here
   * can move anybody.
   */
  variantBBody: text("variant_b_body"),
  /** Null on a text and refused if present, as the first version's is. */
  variantBSubject: text("variant_b_subject"),

  /**
   * What a touch arriving later will carry in `utm_campaign`, so a click from
   * this send credits this send. Defaulted from the name rather than typed
   * twice, because two fields that have to agree and nothing making them
   * agree is how attribution reports end up with four spellings of one
   * campaign.
   */
  utmCampaign: text("utm_campaign").notNull(),

  /**
   * The registered carrier campaign this sends under, on SMS. Its throughput
   * and daily cap are what the sender paces against; before this, those two
   * columns were written, displayed, and consulted by no sender.
   */
  messagingCampaignId: uuid("messaging_campaign_id"),

  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancellationReason: text("cancellation_reason"),

  createdByUserId: uuid("created_by_user_id"),
  ...timestamps,
}, (t) => ({
  stateIdx: index("marketing_campaign_state_idx").on(t.organizationId, t.state, t.scheduledFor),
  /**
   * One live campaign per utm value, so two campaigns cannot both claim the
   * credit for the same arriving touch. Cancelled and deleted ones are out of
   * the way, because a name is worth reusing after a campaign is abandoned.
   */
  utmIdx: uniqueIndex("marketing_campaign_utm_idx")
    .on(t.organizationId, t.utmCampaign)
    .where(sql`${t.deletedAt} is null and ${t.cancelledAt} is null`),
}));

/**
 * One person this campaign was sent to, or deliberately not sent to.
 *
 * A SKIPPED ROW IS WRITTEN, ALWAYS. The alternative, filtering the
 * unreachable out before the list is stored, is how a company comes to
 * believe it sent four thousand texts when it sent nine hundred: the gate
 * refused the rest for consent, and the refusals existed only in a log
 * nobody reads. Stored with its reason, the same list is the worklist for
 * collecting the consent that would make the next campaign twice the size.
 */
export const campaignRecipient = pgTable("campaign_recipient", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  campaignId: uuid("campaign_id").notNull().references(() => marketingCampaign.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  /** E.164 or a lowercased email, whichever the channel is. */
  address: text("address").notNull(),
  /**
   * The version this person was given, decided when the row is written by a
   * stable hash of the campaign and the customer and never recomputed, so the
   * results read what was sent rather than what the rule would say today.
   */
  variant: campaignVariant("variant").notNull().default("a"),
  state: campaignRecipientState("state").notNull().default("pending"),
  /** A `comms.SendRefusal`, or one of this service's own. Never null on a skip. */
  skipReason: text("skip_reason"),
  /** The outbox row, when one was made. Delivery is the outbox's answer, not ours. */
  messageId: uuid("message_id"),
  queuedAt: timestamp("queued_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  /**
   * One row per address per campaign. This is the only thing standing between
   * a retried send and a customer getting the same text twice, and it is a
   * database constraint rather than a check in the sender because the sender
   * is exactly what will be running twice.
   */
  onceIdx: uniqueIndex("campaign_recipient_once_idx").on(t.campaignId, t.address),
  pendingIdx: index("campaign_recipient_state_idx").on(t.campaignId, t.state),
  customerIdx: index("campaign_recipient_customer_idx").on(t.organizationId, t.customerId),
}));

/**
 * WHAT A ONE CLICK UNSUBSCRIBE RESOLVES TO
 *
 * `email.queue` has refused every marketing email without an unsubscribe URL
 * since it was written, correctly, because CAN-SPAM requires one and Gmail and
 * Yahoo both require one click unsubscribe from bulk senders. And this product
 * served no unsubscribe page. The only way to satisfy that gate was to hand it
 * a URL hosted somewhere else, so the header went out pointing at a page that
 * either did not exist or could not write a suppression into this database.
 * A live gate demanding something that does not exist is worse than no gate:
 * it reads as solved.
 *
 * NOT `portal_grant`, which is the obvious reuse. Two reasons, and the first
 * is decisive: `portal_grant.expires_at` is NOT NULL, and an unsubscribe link
 * must never expire. "This link has expired" is the single worst page this
 * product could serve to somebody trying to stop hearing from a company,
 * because their next move is the complaint button, which costs the sending
 * domain more than ten unsubscribes. The second is that the subject here is
 * an address rather than a record.
 *
 * Only the hash is stored, as with every other token in this schema.
 */
export const unsubscribeLink = pgTable("unsubscribe_link", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** SHA-256 of the token. The token exists once, in the message that carried it. */
  tokenHash: text("token_hash").notNull(),
  address: text("address").notNull(),
  /** Which campaign's link this was, so a complaint rate is per send. */
  campaignId: uuid("campaign_id").references(() => marketingCampaign.id, { onDelete: "set null" }),
  /**
   * Set the first time it is used and never cleared. A second click is
   * answered with the same page rather than an error: somebody clicking twice
   * wants to be sure it worked.
   */
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedIp: text("used_ip"),
  ...timestamps,
}, (t) => ({
  hashIdx: uniqueIndex("unsubscribe_link_token_idx").on(t.tokenHash),
  addressIdx: index("unsubscribe_link_address_idx").on(t.organizationId, t.address),
}));

/* ------------------------------------------------------------- referrals */

export const referralRewardState = pgEnum("referral_reward_state", [
  /** A credit note was issued to the referrer and sits on their account. */
  "credited",
  /** A fixed amount the company owes the referrer and has not paid yet. */
  "owed",
  /** That amount, paid, by whatever means the office pays people. */
  "paid",
  /** Withdrawn by the office, with a reason. Never re-granted. */
  "void",
]);

/**
 * WHAT A REFERRAL EARNED, AND WHETHER IT HAS BEEN GIVEN
 *
 * One row per referred customer, granted when their first job is paid in
 * full. The unique index is the idempotency: the worker can look at the same
 * paid invoice on every pass, and a second pass finds the row and does
 * nothing, so a referrer is rewarded once for each person they sent however
 * many times the check runs.
 *
 * The reward is a LEDGER, not a flag on the customer, because "did we ever
 * pay Mrs Alvarez for sending the Nguyens" is a question with a date, an
 * amount and a document behind it, and a boolean answers none of them.
 */
export const referralReward = pgTable("referral_reward", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  referrerCustomerId: uuid("referrer_customer_id").notNull()
    .references(() => customer.id, { onDelete: "cascade" }),
  referredCustomerId: uuid("referred_customer_id").notNull()
    .references(() => customer.id, { onDelete: "cascade" }),
  /** The first job, whose payment earned it. */
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  /** `credit_note` or `owed`, as the company's referral settings said when it was granted. */
  kind: text("kind").notNull(),
  amount: money("amount").notNull(),
  state: referralRewardState("state").notNull(),
  /** The credit note issued for it, when the reward was a credit. */
  creditNoteId: uuid("credit_note_id"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  note: text("note"),
  ...timestamps,
}, (t) => ({
  referredIdx: uniqueIndex("referral_reward_referred_idx").on(t.organizationId, t.referredCustomerId),
  referrerIdx: index("referral_reward_referrer_idx").on(t.organizationId, t.referrerCustomerId),
}));
