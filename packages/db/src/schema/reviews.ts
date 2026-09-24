import { pgTable, pgEnum, uuid, text, boolean, integer, jsonb, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared";
import { organization, user, technician } from "./tenancy";
import { customer } from "./crm";
import { job } from "./work";

/**
 * REVIEWS AND REPUTATION
 *
 * For a local trades company the listing is worth more than the website. A
 * homeowner searching "AC repair near me" sees a rating and a reply under
 * the worst review before they see anything the company wrote about itself.
 *
 * `packages/core/src/reviews` is twelve hundred lines that knew how to
 * decide when to ask, who to ring instead, what a rating actually is, and
 * which reply is owed by when. It had no tables and no callers.
 *
 * WHAT THIS SCHEMA REFUSES TO HOLD, AND WHY IT IS THE MOST IMPORTANT PART
 *
 * There is no predicted rating on a job, no satisfaction score, and no flag
 * derived from one. Core's `REQUEST_INPUTS` declares the complete set of
 * facts the ask decision may read, enforced by a test, and none of them is a
 * guess about how happy somebody is.
 *
 * The reason is that the obvious feature, asking only the customers you
 * think will say something nice, is review gating. Every major platform
 * prohibits it, it is the thing that gets a listing's reviews wiped, and it
 * is trivially easy to build by accident: one `predictedRating` column and a
 * `where predicted >= 4` and the product is doing it. So the column does not
 * exist, and a schema with nowhere to put the number is harder to add later
 * than a policy saying not to.
 */

/**
 * Where a review lives, as the OPERATOR names it.
 *
 * Free text rather than an enum, and this is deliberate. A platform enum in
 * a self hosted product goes stale the moment somebody uses a regional
 * directory nobody here has heard of, and the fix would be a migration they
 * cannot ship. The catalogue of platform RULES is separate and is declared
 * by the operator too, for the same reason: see core's section 5, which
 * ships no default platform policies at all.
 */
export const reviewRequestState = pgEnum("review_request_state", [
  /** Decided and waiting for its send window. */
  "queued",
  "sent",
  /** The customer left a review we can tie back to this request. */
  "converted",
  /** Withheld by the policy, with the reason kept. */
  "withheld",
  "failed",
]);

/**
 * THE COMPANY'S OWN SERVICE STANDARD
 *
 * One row per organization, holding the three policies core takes: when to
 * ask, who to ring rather than ask again, and which reply is owed by when.
 *
 * All three are DATA rather than code, like every other policy in this
 * schema. A response band is a number of hours and a reason; it is never a
 * rule somebody can express as a function, because a stored function is a
 * remote code execution surface with a friendly name.
 */
export const reviewPolicy = pgTable("review_policy", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),

  /** Every hour below is a wall clock hour in this zone. */
  timeZone: text("time_zone").notNull(),

  /* --- when to ask ----------------------------------------------------- */
  /**
   * How long after the technician LEAVES, not after the office closes the
   * job. Those differ by up to a day, and asking about a visit somebody
   * remembers from this morning is a different message from asking about
   * one they have to look up.
   */
  delayMinutes: integer("delay_minutes").notNull().default(120),
  /**
   * Never ask the same person more often than this, however many jobs they
   * give us. A commercial customer with four properties produces four
   * completed jobs in a week, and four requests in a week is how a good
   * customer learns to filter the company's address.
   */
  customerCooldownDays: integer("customer_cooldown_days").notNull().default(90),
  requirePaid: boolean("require_paid").notNull().default(true),
  /**
   * Past this age, no ask at all. A request about a job from two months ago
   * reads as a mailshot because it is one: the only reason it is going out
   * is that somebody turned the feature on and it swept the back catalogue.
   * That sweep is also the fastest way to trip a platform's bulk
   * solicitation rule.
   */
  maxJobAgeDays: integer("max_job_age_days").notNull().default(14),
  earliestHour: integer("earliest_hour").notNull().default(9),
  latestHour: integer("latest_hour").notNull().default(19),

  /* --- who to ring ----------------------------------------------------- */
  /** At or below this, a human owes them a conversation. */
  recoverAtOrBelow: integer("recover_at_or_below").notNull().default(3),
  /** At or below this, it is today's problem rather than tomorrow's. */
  sameDayAtOrBelow: integer("same_day_at_or_below").notNull().default(2),

  /* --- when to reply --------------------------------------------------- */
  /** 0 for Sunday through 6 for Saturday. */
  businessDays: jsonb("business_days").$type<number[]>().notNull().default([1, 2, 3, 4, 5]),
  openHour: integer("open_hour").notNull().default(8),
  closeHour: integer("close_hour").notNull().default(17),
  /**
   * Ascending by rating, covering 1 through 5. Each band carries its own
   * reason, shown on the work list, because "reply within four hours" with
   * no why is a rule somebody quietly stops following.
   */
  bands: jsonb("bands").$type<{
    upToRating: number;
    withinHours: number;
    businessHoursOnly: boolean;
    priority: number;
    reason: string;
  }[]>().notNull().default([]),

  /**
   * How long a review takes to count half as much in the recency weighted
   * average. Exponential rather than a cutoff, because a cutoff makes the
   * average jump on the day an old review falls out of it and somebody asks
   * why the rating dropped on a day nothing happened.
   */
  halfLifeDays: integer("half_life_days").notNull().default(365),

  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  activeIdx: uniqueIndex("review_policy_active_idx")
    .on(t.organizationId)
    .where(sql`${t.active} and ${t.deletedAt} is null`),
}));

/**
 * WHAT THE OPERATOR SAYS A PLATFORM ALLOWS
 *
 * Declared, never shipped. Core's section 5 explains why at length: a table
 * of a platform's rules is somebody else's rule, it goes stale without
 * anybody noticing, and in a self hosted product it can never be corrected
 * in the field. An operator who has read Google's policy this quarter knows
 * more than a constant compiled last year.
 *
 * A platform with NO ROW here is refused outright by core, which is the
 * only safe direction: the cost of being too careful is a request that was
 * not sent, and the cost of the other default is a rule broken on a
 * platform nobody had checked, with the penalty landing on the listing the
 * company's phone calls come from.
 */
export const reviewPlatform = pgTable("review_platform", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** The operator's own key: "google", "yelp", "checkatrade". Matched exactly. */
  platform: text("platform").notNull(),
  displayName: text("display_name").notNull(),
  /** Where the listing is, so a request can link straight to it. */
  reviewUrl: text("review_url"),
  /**
   * Which of core's PROHIBITIONS the operator says this platform enforces.
   *
   * A list of what is FORBIDDEN, not what is allowed, matching core. An
   * empty list therefore means "this platform forbids none of them", which
   * is the permissive reading and is almost never true: the strictness in
   * this design comes from a platform being UNDECLARED, which core refuses
   * outright, rather than from a declared platform with an empty list.
   *
   * Saying that here because the two are easy to confuse and the confusion
   * goes the dangerous way: somebody adding a row to get a platform
   * working, leaving this empty, and believing they have been careful.
   */
  prohibits: jsonb("prohibits").$type<string[]>().notNull().default([]),
  /** The operator's own words about what they checked and when. */
  note: text("note").notNull(),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  platformIdx: uniqueIndex("review_platform_idx")
    .on(t.organizationId, t.platform)
    .where(sql`${t.deletedAt} is null`),
}));

/**
 * AN ASK, AND WHY IT WAS OR WAS NOT MADE
 *
 * A WITHHELD request is a row, and that is the point. A system that only
 * records what it sent cannot answer "why did this customer never get
 * asked", and the answer is almost always something worth knowing: an open
 * complaint, an unresolved callback, an opt out nobody knew about.
 */
export const reviewRequest = pgTable("review_request", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  platform: text("platform"),
  state: reviewRequestState("state").notNull().default("queued"),
  /** When the policy said it may go, which is not when it went. */
  sendAt: timestamp("send_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** The message that carried it, so a reply lands in the same thread. */
  messageId: uuid("message_id"),
  /** One of core's `WithheldReason` values. Null when it was sent. */
  withheldReason: text("withheld_reason"),
  /** The refusal in words, for whoever asks why this customer was skipped. */
  withheldDetail: text("withheld_detail"),
  ...timestamps,
}, (t) => ({
  /**
   * One request per job, enforced rather than checked. The commonest way to
   * ask somebody twice is two callers racing, and a unique index is the
   * only thing that stops it.
   */
  jobIdx: uniqueIndex("review_request_job_idx").on(t.jobId).where(sql`${t.deletedAt} is null`),
  /** The cooldown lookup: everything this customer has been sent. */
  customerIdx: index("review_request_customer_idx").on(t.organizationId, t.customerId, t.sentAt),
  queueIdx: index("review_request_queue_idx").on(t.organizationId, t.state, t.sendAt),
}));

/**
 * A REVIEW THAT EXISTS IN THE WORLD
 *
 * Entered by hand, or brought in by a connector once one is built. The
 * catalogue is honest that no review platform connector exists yet, so the
 * manual path is the real path today and is not a placeholder: a company
 * with forty reviews and a work list telling them which three are owed a
 * reply is better off than one waiting for an API.
 *
 * `authorName` and `body` are what the platform shows publicly. They are
 * stored because a reply has to answer what was actually said, and a work
 * list that showed only a star count would send somebody to another tab to
 * find out what the complaint was.
 */
export const review = pgTable("review", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  /** The platform's own id, where it has one. Makes an import idempotent. */
  externalId: text("external_id"),
  /** One to five. */
  rating: integer("rating").notNull(),
  authorName: text("author_name"),
  body: text("body"),
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),

  /** Tied back where it can be. Both nullable: most reviews name neither. */
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
  /** Who did the work, when the review names them or the job does. */
  technicianId: uuid("technician_id").references(() => technician.id, { onDelete: "set null" }),

  respondedAt: timestamp("responded_at", { withTimezone: true }),
  responseBody: text("response_body"),
  respondedByUserId: uuid("responded_by_user_id").references(() => user.id, { onDelete: "set null" }),

  /**
   * Set when the recovery policy says somebody owes this customer a phone
   * call. Separate from the public reply, because they are different acts:
   * one is a conversation and the other is what the next prospect reads,
   * and a product that treated them as one would let a good public reply
   * close out a call that never happened.
   */
  recoveryDueAt: timestamp("recovery_due_at", { withTimezone: true }),
  recoveredAt: timestamp("recovered_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  externalIdx: uniqueIndex("review_external_idx")
    .on(t.organizationId, t.platform, t.externalId)
    .where(sql`${t.externalId} is not null and ${t.deletedAt} is null`),
  /** The work list: unanswered, oldest first. */
  openIdx: index("review_open_idx").on(t.organizationId, t.respondedAt, t.postedAt),
  technicianIdx: index("review_technician_idx").on(t.organizationId, t.technicianId),
}));
