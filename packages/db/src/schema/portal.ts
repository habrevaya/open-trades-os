import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, boolean, integer, index, timestamp, date, time, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { pk, timestamps, money, currency, rate } from "./_shared";
import { organization, businessUnit, user, technician } from "./tenancy";
import { customer, property, contact } from "./crm";
import { job, jobType, visit } from "./work";
import { territory } from "./scheduling";
import { estimate } from "./billing";
import { connectedApp } from "./integrations";

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
  /**
   * A booking request, before anyone has confirmed it and therefore before
   * there is a customer to attach it to. The requester still wants to see that
   * something happened, and the gap between booking and a human looking at it
   * is exactly when they want it most.
   */
  "booking",
  /**
   * Pay one deposit. The link an approved estimate hands back when the
   * company asks for money before the work, which used to be the deposit's
   * bare id in a URL with no page behind it.
   */
  "deposit",
  /**
   * View and approve or decline one change order on a project. Its own scope
   * rather than an estimate's, because approving one changes a contract
   * that already exists, and the page has to say so in those words.
   */
  "change_order",
  /**
   * Every invoice one payer owes: a warranty company, a carrier, a
   * facilities client's accounts payable. The subject is the payer's own
   * customer record, and the page lists what is addressed to them or paid by
   * them and nothing else.
   */
  "payer",
]);

/**
 * A CUSTOMER ASKING TO SIGN IN, AND THE CODE THEY WERE SENT.
 *
 * A link is still the main way in: a homeowner approving a quote will not
 * sign in to do it. Signing in is for the customer who comes back, to pay
 * the next bill with a card they saved, to find last spring's invoice or to
 * see what is booked. They type the email or mobile number the company
 * already has for them, a six digit code goes there through the company's
 * own email and text senders, and typing it back opens their account.
 *
 * No password, ever. A password for a company somebody deals with twice a
 * year is a password they reuse or forget, and a reused one is how a
 * stranger pays their bill with their card.
 *
 * ONLY THE HASH OF THE CODE IS STORED, salted with this row's id, and that
 * is said plainly rather than oversold: six digits are a million guesses
 * away from any hash, so the hash is what stops a code being read off this
 * table by anybody who can see it, not what stops it being worked out. What
 * stops a code being guessed is that it dies after ten minutes, after one
 * use, and after five wrong tries, and that asking for codes is counted per
 * address and per network address.
 *
 * Kept after use, as the record of who signed in, when and from where. The
 * session the code opened is a `portal_grant` naming this row.
 */
export const portalSignInChannel = pgEnum("portal_sign_in_channel", ["email", "sms"]);

export const portalSignIn = pgTable("portal_sign_in", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  channel: portalSignInChannel("channel").notNull(),
  /** As it is compared: a lower cased email or an E.164 number. */
  address: text("address").notNull(),
  /** SHA-256 of this row's id and the code. Null when no code was sent, because nobody has that address. */
  codeHash: text("code_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Wrong codes typed against this one. Five and it is dead. */
  attempts: integer("attempts").notNull().default(0),
  /** Set when the code stops working for any reason: used, superseded, or guessed at too often. */
  endedAt: timestamp("ended_at", { withTimezone: true }),
  /** `signed_in`, `superseded`, `too_many_attempts`, or `no_customer` for an address nobody has. */
  endedReason: text("ended_reason"),
  /** Who it signed in as, once it did. */
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
  /**
   * The contact the address belonged to, when a contact signed in as the
   * customer rather than the customer themselves.
   */
  contactId: uuid("contact_id").references(() => contact.id, { onDelete: "set null" }),
  /**
   * The customers the address was on when the code was asked for. What lets
   * the office see a customer's failed tries, which never get as far as
   * `customer_id`; empty for an address nobody has. Kept as it was then,
   * because the question is what happened, not who has the address today.
   */
  matchedCustomerIds: uuid("matched_customer_ids").array().notNull().default(sql`'{}'::uuid[]`),
  /** What became of the message: `queued`, or why it could not go. Never shown to whoever asked. */
  delivery: text("delivery"),
  /** The caller's own key, so a double tap on "Send me a code" sends one code. */
  requestKey: text("request_key"),
  requestedIp: text("requested_ip"),
  signedInIp: text("signed_in_ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  addressIdx: index("portal_sign_in_address_idx").on(t.organizationId, t.address, t.createdAt),
}));

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
  /**
   * Null only while the grant precedes its customer, which happens exactly
   * once: a booking request issues a tracking link before anyone has confirmed
   * it into a customer. Confirmation fills this in.
   */
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "cascade" }),
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
  /**
   * Set when this grant is a customer's own sign in rather than a link
   * somebody sent: the code that opened it. Always a customer scope grant,
   * held in a cookie rather than a URL, and the only kind of grant that may
   * save a card, because a link can be forwarded and a code went to the
   * address on the customer's own record.
   */
  signInId: uuid("sign_in_id").references(() => portalSignIn.id, { onDelete: "set null" }),
  /**
   * The contact this grant acts for, when a contact signed in as the
   * customer (and on every narrower link minted from that sign in). The
   * customer is still `customer_id`: what they see is the customer's
   * account, and what they do is recorded as this person.
   */
  contactId: uuid("contact_id").references(() => contact.id, { onDelete: "set null" }),
  /**
   * Why `revoked_at` was set on a sign in: `signed_out` by the customer,
   * `office` when somebody in the office ended it, `access_removed` when the
   * office took a contact's sign in away. Null for a link, which says
   * nothing more than that it was withdrawn or spent.
   */
  revokedReason: text("revoked_reason"),
  ...timestamps,
}, (t) => ({
  hashIdx: uniqueIndex("portal_grant_token_idx").on(t.tokenHash),
  subjectIdx: index("portal_grant_subject_idx").on(t.organizationId, t.scope, t.subjectId),
  /** The office's view of a customer's sign ins: theirs, newest first. */
  customerIdx: index("portal_grant_customer_idx").on(t.organizationId, t.customerId, t.createdAt),
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
  state: text("state"),
  postalCode: text("postal_code"),

  requestedDate: date("requested_date").notNull(),
  arrivalWindowId: uuid("arrival_window_id").references(() => arrivalWindow.id, { onDelete: "set null" }),
  notes: text("notes"),
  intakeAnswers: jsonb("intake_answers").$type<Record<string, unknown>>().notNull().default({}),

  /** Attribution, captured at the only moment it is knowable. */
  sourceUrl: text("source_url"),
  referrer: text("referrer"),
  utm: jsonb("utm").$type<Record<string, string>>().notNull().default({}),
  /**
   * The landing page query string, exactly as it arrived.
   *
   * Kept alongside `utm` rather than instead of it, because the two answer
   * different questions: `utm` is the tidy bag a screen reads, and this is
   * the evidence. The field it saves is the CLICK ID. `gclid`, `msclkid`
   * and `fbclid` are not utm_ keys, so a widget that stored only utm_ lost
   * them, and the click id is the one value an ads platform will match a
   * conversion back to. Without it a booked job can never be reported to
   * the account that bought it.
   */
  landingQuery: text("landing_query"),
  /**
   * The anonymous thread this request came from, so the touches somebody
   * made before filling the form can be joined to them afterwards. A
   * cookie or a device id, never a fingerprint.
   */
  visitorId: text("visitor_id"),
  /**
   * The connected application that sent this, when one did.
   *
   * A booking arriving through a partner is attributable the same way a
   * booking from a landing page is, and for the same reason: an operator
   * deciding whether a channel is worth keeping needs to know which ones
   * actually produced work. Without it a partner's bookings are
   * indistinguishable from the widget's.
   */
  connectedAppId: uuid("connected_app_id").references(() => connectedApp.id, { onDelete: "set null" }),

  /**
   * The technician a returning customer asked for, from their own signed in
   * account. A wish rather than an assignment: the slot was offered from
   * their free time, and booking the request with its visit puts them on it
   * when they are still free and qualified on the day.
   */
  preferredTechnicianId: uuid("preferred_technician_id").references(() => technician.id, { onDelete: "set null" }),
  depositId: uuid("deposit_id"),
  declineReason: text("decline_reason"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("booking_request_org_idx").on(t.organizationId, t.status, t.requestedDate),
  dateIdx: index("booking_request_date_idx").on(t.organizationId, t.requestedDate),
}));

/**
 * A CUSTOMER ASKING TO MOVE OR CALL OFF A VISIT, FROM THEIR OWN LINK.
 *
 * A request and never a move. A visit on the board has a technician, a route
 * and a morning built around it, and the customer cannot see any of that: a
 * portal that moved a dispatched visit on a tap would leave a van outside an
 * empty house and a dispatcher finding out from the technician. So the
 * customer asks, the office decides from the visit or from the queue, and the
 * customer is told the answer through the same messaging everything else
 * uses.
 *
 * The window asked for is one of the windows online booking would offer for
 * that work, checked when the request is made and again when it is approved,
 * because the slot free on Monday evening can be gone by Tuesday morning.
 *
 * The task is the office's to work. It is raised with the request and closed
 * with the decision, so the queue and this table cannot disagree about
 * whether anybody still owes the customer an answer.
 */
export const visitChangeKind = pgEnum("visit_change_kind", ["reschedule", "cancel"]);
export const visitChangeStatus = pgEnum("visit_change_status", [
  "pending", "approved", "declined",
  /** The visit moved on without the request: done, cancelled, or already moved by the office. */
  "superseded",
]);

export const visitChangeRequest = pgTable("visit_change_request", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  visitId: uuid("visit_id").notNull().references(() => visit.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  kind: visitChangeKind("kind").notNull(),
  status: visitChangeStatus("status").notNull().default("pending"),
  /** The customer's own words. Required to cancel, optional to move. */
  reason: text("reason"),

  /** Where they asked to move it, for a reschedule. Null for a cancel. */
  bookableServiceId: uuid("bookable_service_id").references(() => bookableService.id, { onDelete: "set null" }),
  requestedDate: date("requested_date"),
  arrivalWindowId: uuid("arrival_window_id").references(() => arrivalWindow.id, { onDelete: "set null" }),
  /** The window as instants, worked out once in the company's zone when asked. */
  requestedStart: timestamp("requested_start", { withTimezone: true }),
  requestedEnd: timestamp("requested_end", { withTimezone: true }),
  /** Where the visit was when they asked, so the office sees the move and not just the target. */
  previousStart: timestamp("previous_start", { withTimezone: true }),
  previousEnd: timestamp("previous_end", { withTimezone: true }),

  /** The office queue's copy of this. Closed with the decision. */
  taskId: uuid("task_id"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedByUserId: uuid("decided_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** What the office said back, when it declined. Sent to the customer as written. */
  response: text("response"),
  /**
   * Whether the customer was told, as a word: `queued`, or the refusal.
   * A decision the customer never heard about is the same phone call as no
   * decision, so the screen shows this beside it.
   */
  notified: text("notified"),
  ...timestamps,
}, (t) => ({
  /**
   * One open request per visit. A customer tapping twice, or asking to move
   * it and then to cancel it before anybody looked, would otherwise leave
   * the office two answers to give about one morning.
   */
  pendingIdx: uniqueIndex("visit_change_request_pending_idx").on(t.visitId)
    .where(sql`${t.status} = 'pending'`),
  orgIdx: index("visit_change_request_org_idx").on(t.organizationId, t.status, t.createdAt),
  jobIdx: index("visit_change_request_job_idx").on(t.jobId),
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
