import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * REVIEWS AND REPUTATION
 *
 * For a local trades company the listing is worth more than the website. A
 * homeowner sees a rating and the reply under the worst review before they
 * see anything the company wrote about itself.
 *
 * THE FEATURE THIS API DOES NOT HAVE, AND WILL NOT
 *
 * There is no endpoint that takes a predicted rating, a satisfaction score,
 * or any flag derived from one, and none of the inputs below could carry
 * such a thing. Asking only the customers you think will say something nice
 * is review gating: every major platform prohibits it and it is what gets a
 * listing's reviews wiped. It is also trivially easy to build by accident,
 * which is why the defence is an absent field rather than a policy.
 *
 * `POST /v1/reviews/requests` decides from facts about the WORK: was it
 * finished, was it paid, is a complaint open, did we have to come back, have
 * we asked this person recently. Nothing about how happy they seemed.
 *
 * NO RATING IS PUBLISHED WITHOUT ITS CAVEAT. Three numbers come back and
 * each carries what it is wrong about, because a rating shown without one is
 * the thing that gets painted on the side of a truck.
 */

export const Prohibition = z.enum([
  "incentives", "bulk_requests", "templated_replies",
  "solicitation_on_site", "third_party_sending",
]);

export const ResponseBand = z.object({
  /** The highest rating this band covers, inclusive. */
  upToRating: z.number().int().min(1).max(5),
  withinHours: z.number().int().min(1).max(8760),
  /** A one star wants a reply from somebody who can resolve it, and there is nobody in the building at two on a Sunday. */
  businessHoursOnly: z.boolean(),
  priority: z.number().int(),
  /** Why this clock and not another. Shown on the work list, because a rule with no why is one people stop following. */
  reason: z.string().min(1).max(1000),
});

export const ReviewPolicy = z.object({
  timeZone: z.string(),
  delayMinutes: z.number().int(),
  customerCooldownDays: z.number().int(),
  requirePaid: z.boolean(),
  maxJobAgeDays: z.number().int(),
  earliestHour: z.number().int(),
  latestHour: z.number().int(),
  recoverAtOrBelow: z.number().int(),
  sameDayAtOrBelow: z.number().int(),
  businessDays: z.array(z.number().int()),
  openHour: z.number().int(),
  closeHour: z.number().int(),
  bands: z.array(ResponseBand),
  halfLifeDays: z.number().int(),
});

export const setReviewPolicy = defineRoute({
  method: "put",
  path: "/v1/reviews/policy",
  summary: "The company's own service standard",
  description:
    "Refused when the bands do not cover every rating, because a review outside them is skipped by the work list rather than guessed at. Everything else has a default, since being wrong about your own standard costs a reply sent a day late.",
  module: "M20",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    timeZone: z.string().min(1).max(100),
    /** From the technician LEAVING, not from the office closing the job. */
    delayMinutes: z.number().int().min(0).max(10080).optional(),
    /** However many jobs they give us. Four requests in a week is how a good customer learns to filter the address. */
    customerCooldownDays: z.number().int().min(0).max(3650).optional(),
    requirePaid: z.boolean().optional(),
    /** Past this, no ask at all: a request about a two month old job reads as a mailshot because it is one. */
    maxJobAgeDays: z.number().int().min(1).max(365).optional(),
    earliestHour: z.number().int().min(0).max(23).optional(),
    latestHour: z.number().int().min(0).max(23).optional(),
    recoverAtOrBelow: z.number().int().min(1).max(5).optional(),
    sameDayAtOrBelow: z.number().int().min(1).max(5).optional(),
    businessDays: z.array(z.number().int().min(0).max(6)).optional(),
    openHour: z.number().int().min(0).max(23).optional(),
    closeHour: z.number().int().min(0).max(23).optional(),
    bands: z.array(ResponseBand).optional(),
    halfLifeDays: z.number().int().min(1).max(3650).optional(),
  }),
  output: ReviewPolicy,
});

export const ReviewPlatform = z.object({
  platform: z.string(),
  displayName: z.string(),
  reviewUrl: z.string().nullable(),
  /** What the OPERATOR says this platform forbids. Never shipped by this product. */
  prohibits: z.array(z.string()),
  note: z.string(),
  active: z.boolean(),
});

export const listReviewPlatforms = defineRoute({
  method: "get",
  path: "/v1/reviews/platforms",
  summary: "What the operator says each platform allows",
  module: "M20",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ platforms: z.array(ReviewPlatform) }),
});

export const setReviewPlatform = defineRoute({
  method: "post",
  path: "/v1/reviews/platforms",
  summary: "Declare what a platform forbids",
  description:
    "Declared, never shipped. A table of a platform's rules compiled into this product is somebody else's rule, it goes stale without anybody noticing, and in a self hosted deployment it can never be corrected in the field. A platform with no row is refused outright.",
  module: "M20",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    platform: z.string().min(1).max(50),
    displayName: z.string().min(1).max(200),
    reviewUrl: z.string().max(2000).nullable().optional(),
    prohibits: z.array(Prohibition),
    /** The operator's own words, with the date they checked. */
    note: z.string().min(1).max(2000),
  }),
  output: z.object({
    platform: z.string(), displayName: z.string(), prohibits: z.array(z.string()),
  }),
});

export const WithheldReason = z.enum([
  "customer_opted_out", "already_asked_for_this_job", "job_not_completed",
  "departure_time_unknown", "job_not_paid", "complaint_open",
  "callback_unresolved", "job_too_old", "customer_asked_recently",
]);

export const requestReview = defineRoute({
  method: "post",
  path: "/v1/reviews/requests",
  summary: "Decide whether to ask about one job",
  description:
    "Decides from facts about the WORK: finished, paid, complaint open, did we come back, have we asked this person recently. Nothing about how happy they seemed, because that is review gating. A withheld request is still a row, so 'why did this customer never get asked' has an answer.",
  module: "M20",
  permissions: ["review:respond"],
  idempotent: true,
  input: z.object({
    jobId: Uuid,
    /** Checked against what the operator declared before anything is queued. */
    platform: z.string().max(50).optional(),
  }),
  output: z.object({
    jobId: Uuid,
    asked: z.boolean(),
    requestId: Uuid.nullable(),
    /** The instant it may go out, inside the sending window. */
    sendAt: z.string().datetime().nullable(),
    readyNow: z.boolean(),
    withheld: WithheldReason.nullable(),
    explanation: z.string().nullable(),
    /** True when the reason passes on its own: an unpaid invoice, a callback still open. */
    clearsOnItsOwn: z.boolean().nullable(),
  }),
});

export const listDueRequests = defineRoute({
  method: "get",
  path: "/v1/reviews/requests/due",
  summary: "Requests whose send window has arrived",
  module: "M20",
  permissions: ["review:respond"],
  input: z.object({}),
  output: z.object({
    requests: z.array(z.object({
      id: Uuid, jobId: Uuid, customerId: Uuid,
      platform: z.string().nullable(),
      sendAt: z.string().datetime().nullable(),
    })),
  }),
});

export const markRequestSent = defineRoute({
  method: "post",
  path: "/v1/reviews/requests/{id}/sent",
  summary: "Mark a request as gone out",
  description:
    "Refuses anything not queued, because sending a request that already went is the second ask, and a second ask is how a good customer learns to filter the company's address.",
  module: "M20",
  permissions: ["review:respond"],
  idempotent: true,
  input: z.object({ id: Uuid, messageId: Uuid.optional() }),
  output: z.object({ id: Uuid, sentAt: z.string().datetime().nullable() }),
});

export const listWithheld = defineRoute({
  method: "get",
  path: "/v1/reviews/requests/withheld",
  summary: "Why people were not asked, grouped",
  description:
    "A worklist rather than a log. An open complaint nobody closed and a callback still running are both things somebody can act on today.",
  module: "M20",
  permissions: ["review:respond"],
  input: z.object({}),
  output: z.object({
    reasons: z.array(z.object({ reason: z.string(), count: z.number().int() })),
  }),
});

export const recordReview = defineRoute({
  method: "post",
  path: "/v1/reviews",
  summary: "Record a review that exists",
  description:
    "Entered by hand today: no review platform connector is built and the catalogue says so. That is not a placeholder, because a company with forty reviews and a work list naming the three owed a reply is better off than one waiting for an API. The response says whether a phone call is owed and by when, so the person who just typed in a one star is told rather than left to notice it later.",
  module: "M20",
  permissions: ["review:respond"],
  idempotent: true,
  input: z.object({
    platform: z.string().min(1).max(50),
    rating: z.number().int().min(1).max(5),
    postedAt: z.string().datetime(),
    externalId: z.string().max(200).nullable().optional(),
    authorName: z.string().max(200).nullable().optional(),
    body: z.string().max(10000).nullable().optional(),
    jobId: Uuid.nullable().optional(),
    customerId: Uuid.nullable().optional(),
    technicianId: Uuid.nullable().optional(),
  }),
  output: z.object({
    id: Uuid,
    rating: z.number().int(),
    /** Whether a human owes this customer a conversation. */
    recoveryOwed: z.boolean(),
    recoveryUrgency: z.enum(["same_day", "next_business_day"]).nullable(),
    because: z.string(),
    recoveryDueAt: z.string().datetime().nullable(),
  }),
});

export const getReviewWorkList = defineRoute({
  method: "get",
  path: "/v1/reviews/work-list",
  summary: "Which replies are owed, in the order to work them",
  description:
    "Overdue first, most overdue at the top, then by deadline, then by band priority. Sorting by rating alone puts a week old one star below a fresh one; sorting by date alone puts a five star from this morning above a one star from last night. Answered reviews are not on it.",
  module: "M20",
  permissions: ["review:respond"],
  input: z.object({}),
  output: z.object({
    items: z.array(z.object({
      id: Uuid,
      platform: z.string(),
      rating: z.number().int(),
      authorName: z.string().nullable(),
      /** The text, because a list showing only a star count sends somebody to another tab. */
      body: z.string().nullable(),
      postedAt: z.string().datetime(),
      dueAt: z.string().datetime(),
      reason: z.string(),
      overdueBy: z.number().int(),
      overdue: z.boolean(),
      /** A separate act from the public reply, with its own deadline. */
      recoveryDueAt: z.string().datetime().nullable(),
      recoveredAt: z.string().datetime().nullable(),
    })),
  }),
});

export const respondToReview = defineRoute({
  method: "post",
  path: "/v1/reviews/{id}/response",
  summary: "Post a reply",
  description:
    "Refuses a reply identical to one already posted under another review, where the operator has declared that platform forbids templated replies. The real cost is that it is visible to any prospect who scrolls.",
  module: "M20",
  permissions: ["review:respond"],
  idempotent: true,
  input: z.object({ id: Uuid, body: z.string().min(1).max(4000) }),
  output: z.object({ id: Uuid, respondedAt: z.string().datetime().nullable() }),
});

export const markReviewRecovered = defineRoute({
  method: "post",
  path: "/v1/reviews/{id}/recovered",
  summary: "Somebody rang the customer",
  description:
    "Separate from the public reply, because they are different acts: one is a conversation and the other is what the next prospect reads. Merging them would let a good reply close out a call that never happened.",
  module: "M20",
  permissions: ["review:respond"],
  idempotent: true,
  input: z.object({ id: Uuid, note: z.string().max(2000).optional() }),
  output: z.object({ id: Uuid, recoveredAt: z.string().datetime().nullable() }),
});

export const RatingCaveats = z.object({
  mean: z.string(), recentMean: z.string(), confidence: z.string(),
});

export const getRating = defineRoute({
  method: "get",
  path: "/v1/reviews/rating",
  summary: "Three views of the same reviews, because no single number is honest",
  description:
    "The mean is wrong about time: a shop run badly two years ago reads as mediocre forever. The recency weighted view is wrong about volume: on a dozen reviews one swings it. The lower bound is wrong about how good you are, deliberately and always downward, which makes it safe to sort by and unsafe to print on a van. Every caveat travels with its number.",
  module: "M20",
  permissions: ["review:respond"],
  input: z.object({ platform: z.string().max(50).optional() }),
  output: z.object({
    count: z.number().int(),
    /** Null, never zero. A business with no reviews does not have a rating of 0.0. */
    mean: z.number().nullable(),
    recentMean: z.number().nullable(),
    confidence: z.number().nullable(),
    method: z.string(),
    caveats: RatingCaveats,
  }),
});

export const getRatingByTechnician = defineRoute({
  method: "get",
  path: "/v1/reviews/by-technician",
  summary: "Technicians in order, by the confidence aware figure",
  description:
    "The lower bound rather than the mean, because the mean puts somebody with two five stars above somebody with two hundred reviews averaging 4.8, and the person reading this is deciding who to send to a difficult customer.",
  module: "M20",
  permissions: ["review:respond"],
  input: z.object({}),
  output: z.object({
    technicians: z.array(z.object({
      technicianId: Uuid,
      name: z.string(),
      count: z.number().int(),
      mean: z.number().nullable(),
      recentMean: z.number().nullable(),
      /** What the ordering uses. Never show it to a customer as the rating. */
      confidence: z.number().nullable(),
      caveats: RatingCaveats,
    })),
  }),
});

export const reviewRoutes = {
  setReviewPolicy, listReviewPlatforms, setReviewPlatform,
  requestReview, listDueRequests, markRequestSent, listWithheld,
  recordReview, getReviewWorkList, respondToReview, markReviewRecovered,
  getRating, getRatingByTechnician,
} as const;
