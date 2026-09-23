import { pgTable, pgEnum, uuid, text, integer, index, uniqueIndex, timestamp, date, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, money } from "./_shared";
import { organization } from "./tenancy";
import { customer } from "./crm";
import { job } from "./work";

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
  "utm", "click_id", "tracked_number", "referrer", "none",
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
  ...timestamps,
}, (t) => ({
  slugIdx: uniqueIndex("web_form_slug_idx").on(t.organizationId, t.slug).where(sql`${t.deletedAt} is null`),
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
