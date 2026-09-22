import { pgTable, pgEnum, uuid, text, boolean, integer, index, timestamp, date, time, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { pk, timestamps, money, currency, rate } from "./_shared";
import { organization, businessUnit } from "./tenancy";
import { customer, property } from "./crm";
import { job, jobType } from "./work";
import { territory } from "./scheduling";
import { estimate } from "./billing";

/**
 * SELF SERVE
 *
 * The two paths a customer takes without anyone in the office touching them:
 * approving an estimate, and booking a job. Both have the same hard problem,
 * which is identity. A homeowner will not create an account to approve a
 * quote, and a platform that insists on one loses the approval.
 *
 * The answer here is a capability grant: a single purpose, scoped, expiring
 * token that says what its bearer may do and to which record. It is not a
 * login. It cannot be widened, it cannot be enumerated, and it does not
 * survive the thing it was issued for.
 */

export const portalGrantScope = pgEnum("portal_grant_scope", [
  /** View and approve or decline one estimate. */
  "estimate",
  /** View one job: status, arrival window, technician, service report. */
  "job",
  /** Pay one invoice. */
  "invoice",
  /** The full customer view: visit timeline, documents, agreements, history. */
  "customer",
]);

/**
 * A capability, not a session.
 *
 * Only the hash is stored. A grant leaked from a database backup is useless,
 * and the plaintext exists exactly once, in the link that was sent. This
 * mirrors how `credential` and `session` are handled in schema/tenancy.ts,
 * for the same reason.
 *
 * `maxUses` exists because the failure mode differs by scope. An approval link
 * forwarded to a whole family is fine. A payment link forwarded to a whole
 * family is not.
 */
export const portalGrant = pgTable("portal_grant", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  scope: portalGrantScope("scope").notNull(),
  /** The single record this grant reaches. Null only for the customer scope. */
  subjectId: uuid("subject_id"),
  /** SHA-256 of the token. The token itself is never written down. */
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  maxUses: integer("max_uses"),
  useCount: integer("use_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  lastUsedIp: text("last_used_ip"),
  /** Set the moment the grant is spent, superseded or withdrawn. */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  hashIdx: uniqueIndex("portal_grant_token_idx").on(t.tokenHash),
  subjectIdx: index("portal_grant_subject_idx").on(t.organizationId, t.scope, t.subjectId),
}));

/**
 * BOOKING
 *
 * A booking widget that offers times the company cannot actually serve is
 * worse than no widget: every overbooked slot costs a reschedule call and the
 * trust that came with it. Offered availability is therefore derived, never
 * typed in.
 *
 * What a company configures is the shape of what it is willing to sell: which
 * job types are bookable at all, in which territories, how far ahead, how much
 * notice, and how many of each it will take per window. The engine intersects
 * that with business hours, time off and existing commitments.
 */

/** Named windows the company is willing to offer, e.g. "8am to 12pm". */
export const arrivalWindow = pgTable("arrival_window", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  startsAt: time("starts_at").notNull(),
  endsAt: time("ends_at").notNull(),
  /** Bitmask-free and readable: 0 is Sunday, matching Postgres `dow`. */
  daysOfWeek: integer("days_of_week").array().notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("arrival_window_org_idx").on(t.organizationId, t.isActive) }));

/**
 * What the public may book, and on what terms.
 *
 * Deliberately per job type rather than per company. A company will happily
 * let the internet book a tune up two days out and will never let it book an
 * emergency line replacement, and the difference is the job type.
 */
export const bookableService = pgTable("bookable_service", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  jobTypeId: uuid("job_type_id").notNull().references(() => jobType.id, { onDelete: "cascade" }),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  territoryId: uuid("territory_id").references(() => territory.id, { onDelete: "set null" }),
  /** Customer-facing name and blurb, which are rarely the internal ones. */
  publicName: text("public_name").notNull(),
  publicDescription: text("public_description"),
  /** Shown before booking. Null means "we will quote on site", which is honest
   *  and converts better than a number the company will not honour. */
  displayPrice: money("display_price"),
  currency: currency(),
  /** Collected at booking. Deters the no-show that a free slot invites. */
  depositAmount: money("deposit_amount"),
  depositPercent: rate("deposit_percent"),
  /** Hours of notice required, and how far out the calendar is opened. */
  minNoticeHours: integer("min_notice_hours").notNull().default(24),
  maxAdvanceDays: integer("max_advance_days").notNull().default(60),
  /** Ceiling per window, so a single busy day cannot be sold twice over. */
  maxPerWindow: integer("max_per_window").notNull().default(2),
  /** Questions asked at booking. Answers land on the request. */
  intakeFields: jsonb("intake_fields").$type<Array<{
    key: string;
    label: string;
    type: "text" | "select" | "boolean" | "number" | "photo";
    required: boolean;
    options?: string[];
  }>>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  orgIdx: index("bookable_service_org_idx").on(t.organizationId, t.isActive),
  jobTypeIdx: index("bookable_service_job_type_idx").on(t.jobTypeId),
}));

export const bookingRequestStatus = pgEnum("booking_request_status", [
  "pending", "confirmed", "declined", "cancelled", "expired",
]);

/**
 * An inbound request, kept as its own record rather than written straight to
 * `job`.
 *
 * Two reasons. A request that a company declines or lets expire is a real
 * event worth counting: the decline rate on a booking widget is one of the
 * few honest signals about whether the offered availability is real. And a
 * request carries things a job does not, such as who was on the page, what
 * campaign sent them, and what they typed into the intake form.
 */
export const bookingRequest = pgTable("booking_request", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  bookableServiceId: uuid("bookable_service_id").notNull().references(() => bookableService.id),
  /** Null until an existing customer is matched or a new one is created. */
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
  propertyId: uuid("property_id").references(() => property.id, { onDelete: "set null" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  status: bookingRequestStatus("status").notNull().default("pending"),

  /** As typed by the requester, before any matching. Never overwritten. */
  contactName: text("contact_name").notNull(),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  region: text("region"),
  postalCode: text("postal_code"),

  requestedDate: date("requested_date").notNull(),
  arrivalWindowId: uuid("arrival_window_id").references(() => arrivalWindow.id, { onDelete: "set null" }),
  notes: text("notes"),
  intakeAnswers: jsonb("intake_answers").$type<Record<string, unknown>>().notNull().default({}),

  /** Attribution, captured at the only moment it is knowable. */
  sourceUrl: text("source_url"),
  referrer: text("referrer"),
  utm: jsonb("utm").$type<Record<string, string>>().notNull().default({}),

  depositId: uuid("deposit_id"),
  declineReason: text("decline_reason"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("booking_request_org_idx").on(t.organizationId, t.status, t.requestedDate),
  dateIdx: index("booking_request_date_idx").on(t.organizationId, t.requestedDate),
}));

/**
 * The visit timeline the customer sees.
 *
 * Written by the system as things happen rather than assembled on read. A
 * customer refreshing a tracking page during a four hour window is the single
 * heaviest read in the product, and it must not fan out across a dozen tables
 * every time. It is also the record of what the customer was actually told,
 * which is not always what the office believes it sent.
 */
export const portalEventKind = pgEnum("portal_event_kind", [
  "booked", "confirmed", "scheduled", "rescheduled", "dispatched",
  "on_the_way", "arrived", "in_progress", "completed", "cancelled",
  "estimate_sent", "estimate_viewed", "estimate_approved", "estimate_declined",
  "invoice_sent", "payment_received", "report_published", "message_sent",
]);

export const portalEvent = pgTable("portal_event", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "cascade" }),
  estimateId: uuid("estimate_id").references(() => estimate.id, { onDelete: "cascade" }),
  kind: portalEventKind("kind").notNull(),
  /** Customer-facing wording. Written once, never regenerated on read. */
  headline: text("headline").notNull(),
  detail: text("detail"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  /** False for events the office should see but the customer should not. */
  isCustomerVisible: boolean("is_customer_visible").notNull().default(true),
  ...timestamps,
}, (t) => ({
  customerIdx: index("portal_event_customer_idx").on(t.organizationId, t.customerId, t.occurredAt),
  jobIdx: index("portal_event_job_idx").on(t.jobId, t.occurredAt),
}));
