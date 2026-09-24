import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { reviews as rv } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, NotFoundError, ConflictError,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * REVIEWS AND REPUTATION
 *
 * For a local trades company the listing is worth more than the website: a
 * homeowner searching "AC repair near me" sees a rating and the reply under
 * the worst review before they see anything the company wrote about itself.
 *
 * `packages/core/src/reviews` is twelve hundred lines that knew when to ask,
 * who to ring instead, what a rating actually is, and which reply is owed by
 * when. It had no tables and no callers.
 *
 * THE ONE THING THIS FILE MUST NEVER LEARN HOW TO DO
 *
 * Ask only the customers who will say something nice. That is review gating,
 * every major platform prohibits it, and it is what gets a listing's reviews
 * wiped. It is also trivially easy to build by accident: one predicted
 * rating and a `where predicted >= 4` and the product is doing it.
 *
 * Core defends against that with `REQUEST_INPUTS`, a declared list of every
 * fact the ask decision may read, enforced by a test that proxies the input
 * and fails if anything outside the list is touched. This file defends
 * against it by having nowhere to put such a number: there is no column, and
 * `factsFor` below builds the input from exactly those fields.
 *
 * WHAT IS BUILT AND WHAT IS NOT
 *
 * No review platform connector exists. The catalogue says so. Reviews are
 * entered by hand today, and that is not a placeholder: a company with forty
 * reviews and a work list telling them which three are owed a reply is
 * better off than one waiting for an API.
 */

/* --------------------------------------------------------------- policy */

/**
 * The company's own service standard, in the shape core takes.
 *
 * REFUSED rather than defaulted when no policy is set, like the overtime
 * policy. Every number here is a decision about how a company talks to its
 * customers: how soon after a visit, how often at most, how late in the
 * evening. A guessed default produces messages going out at nine at night
 * to somebody who had four jobs that week, and nothing on any screen would
 * say the product chose that.
 */
export async function policyFor(tx: Database, organizationId: string) {
  const [row] = await tx.select().from(schema.reviewPolicy)
    .where(and(
      eq(schema.reviewPolicy.organizationId, organizationId),
      eq(schema.reviewPolicy.active, true),
      isNull(schema.reviewPolicy.deletedAt),
    )).limit(1);

  if (!row) {
    throw new ConflictError(
      "No review policy is set for this company. Set one before asking anybody for a review: "
      + "every number in it is a decision about how you talk to your customers, and a guessed default "
      + "sends messages at nine at night to somebody who had four jobs that week.",
    );
  }
  return row;
}

const requestPolicy = (row: typeof schema.reviewPolicy.$inferSelect): rv.RequestPolicy => ({
  timeZone: row.timeZone,
  delayMinutes: row.delayMinutes,
  customerCooldownDays: row.customerCooldownDays,
  requirePaid: row.requirePaid,
  maxJobAgeDays: row.maxJobAgeDays,
  earliestHour: row.earliestHour,
  latestHour: row.latestHour,
});

const responsePolicy = (row: typeof schema.reviewPolicy.$inferSelect): rv.ResponsePolicy => ({
  timeZone: row.timeZone,
  businessDays: row.businessDays,
  openHour: row.openHour,
  closeHour: row.closeHour,
  /**
   * The company's bands, falling back to core's starting point when nobody
   * has edited them. Worth contrasting with the platform policies below,
   * which ship no defaults at all: the difference is whose rule it is.
   * Being wrong about your own service standard costs a reply sent a day
   * late. Being wrong about somebody else's rule costs the listing.
   */
  bands: row.bands.length > 0 ? row.bands : rv.DEFAULT_RESPONSE_BANDS,
});

export interface PolicyInput {
  timeZone: string;
  delayMinutes?: number | undefined;
  customerCooldownDays?: number | undefined;
  requirePaid?: boolean | undefined;
  maxJobAgeDays?: number | undefined;
  earliestHour?: number | undefined;
  latestHour?: number | undefined;
  recoverAtOrBelow?: number | undefined;
  sameDayAtOrBelow?: number | undefined;
  businessDays?: number[] | undefined;
  openHour?: number | undefined;
  closeHour?: number | undefined;
  bands?: rv.ResponseBand[] | undefined;
  halfLifeDays?: number | undefined;
}

export async function setPolicy(ctx: ServiceContext, input: PolicyInput) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const bands: rv.ResponseBand[] = input.bands ?? rv.DEFAULT_RESPONSE_BANDS.map((b) => ({ ...b }));
    const proposed: rv.ResponsePolicy = {
      timeZone: input.timeZone,
      businessDays: input.businessDays ?? [1, 2, 3, 4, 5],
      openHour: input.openHour ?? 8,
      closeHour: input.closeHour ?? 17,
      bands,
    };

    /**
     * Checked by core before it is stored. `checkResponsePolicy` catches
     * the things that make a work list wrong rather than merely odd: bands
     * that do not cover every rating, a band that closes before it opens,
     * business hours that describe no hours at all.
     */
    const verdict = rv.checkResponsePolicy(proposed);
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const values = {
      organizationId: ctx.actor.organizationId,
      timeZone: input.timeZone,
      delayMinutes: input.delayMinutes ?? 120,
      customerCooldownDays: input.customerCooldownDays ?? 90,
      requirePaid: input.requirePaid ?? true,
      maxJobAgeDays: input.maxJobAgeDays ?? 14,
      earliestHour: input.earliestHour ?? 9,
      latestHour: input.latestHour ?? 19,
      recoverAtOrBelow: input.recoverAtOrBelow ?? 3,
      sameDayAtOrBelow: input.sameDayAtOrBelow ?? 2,
      businessDays: proposed.businessDays as number[],
      openHour: proposed.openHour,
      closeHour: proposed.closeHour,
      /**
       * Spread into a mutable array. Core's `DEFAULT_RESPONSE_BANDS` is
       * `readonly`, which drizzle's insert type will not take, and the
       * readonly is right where it lives: nothing should be able to edit
       * the shipped defaults in place.
       */
      bands: bands.map((band) => ({ ...band })),
      halfLifeDays: input.halfLifeDays ?? 365,
      active: true,
    };

    const [row] = await tx.insert(schema.reviewPolicy).values(values)
      .onConflictDoUpdate({
        target: [schema.reviewPolicy.organizationId],
        targetWhere: sql`active and deleted_at is null`,
        set: { ...values, updatedAt: new Date() },
      }).returning();

    await audit(tx, ctx, "review_policy.set", "review_policy", row!.id, null, row!);
    return row!;
  });
}

/* ------------------------------------------------------------- platforms */

/**
 * What the operator says a platform allows.
 *
 * Declared, never shipped. A table of a platform's rules compiled into this
 * product is somebody else's rule, it goes stale without anybody noticing,
 * and in a self hosted deployment it can never be corrected in the field. An
 * operator who read Google's policy this quarter knows more than a constant
 * written last year.
 */
export async function platforms(tx: Database, organizationId: string): Promise<rv.PlatformPolicy[]> {
  const rows = await tx.select().from(schema.reviewPlatform)
    .where(and(
      eq(schema.reviewPlatform.organizationId, organizationId),
      eq(schema.reviewPlatform.active, true),
      isNull(schema.reviewPlatform.deletedAt),
    ));

  return rows.map((row) => ({
    platform: row.platform,
    prohibits: row.prohibits as rv.Prohibition[],
    note: row.note,
  }));
}

export const listPlatforms = (ctx: ServiceContext) =>
  guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await tx.select().from(schema.reviewPlatform)
      .where(and(
        eq(schema.reviewPlatform.organizationId, ctx.actor.organizationId),
        isNull(schema.reviewPlatform.deletedAt),
      ))
      .orderBy(schema.reviewPlatform.displayName);
    return rows.map((row) => ({
      platform: row.platform,
      displayName: row.displayName,
      reviewUrl: row.reviewUrl,
      prohibits: row.prohibits,
      note: row.note,
      active: row.active,
    }));
  });

export async function setPlatform(
  ctx: ServiceContext,
  input: { platform: string; displayName: string; reviewUrl?: string | null; prohibits: string[]; note: string },
) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const existing = await platforms(tx, ctx.actor.organizationId);
    const proposed: rv.PlatformPolicy[] = [
      ...existing.filter((p) => p.platform !== input.platform.trim()),
      {
        platform: input.platform.trim(),
        prohibits: input.prohibits as rv.Prohibition[],
        note: input.note,
      },
    ];

    /**
     * The whole catalogue is checked, not the one row, because the failures
     * core looks for are properties of the SET: a duplicated platform,
     * where the answer would depend on read order, and a prohibition
     * outside the declared list, which would silently match nothing and
     * read as permission.
     */
    const verdict = rv.checkPlatformPolicies(proposed);
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const [row] = await tx.insert(schema.reviewPlatform).values({
      organizationId: ctx.actor.organizationId,
      platform: input.platform.trim(),
      displayName: input.displayName,
      reviewUrl: input.reviewUrl ?? null,
      prohibits: input.prohibits,
      note: input.note,
      active: true,
    }).onConflictDoUpdate({
      target: [schema.reviewPlatform.organizationId, schema.reviewPlatform.platform],
      targetWhere: isNull(schema.reviewPlatform.deletedAt),
      set: {
        displayName: input.displayName,
        reviewUrl: input.reviewUrl ?? null,
        prohibits: input.prohibits,
        note: input.note,
        active: true,
        updatedAt: new Date(),
      },
    }).returning();

    await audit(tx, ctx, "review_platform.set", "review_platform", row!.id, null, row!);
    return { platform: row!.platform, displayName: row!.displayName, prohibits: row!.prohibits };
  });
}

/* --------------------------------------------------------- asking, or not */

/**
 * Everything the decision is allowed to know about a job, and nothing else.
 *
 * This function is the enforcement point in the service layer. It builds
 * core's `JobFacts` from named columns, so adding an input to the decision
 * means editing this function and core's `REQUEST_INPUTS` list, in a file
 * whose header explains which inputs are forbidden and why.
 *
 * There is no satisfaction score to read even if somebody wanted to.
 */
async function factsFor(
  tx: Database,
  organizationId: string,
  jobId: string,
): Promise<rv.JobFacts> {
  const [job] = await tx.select({
    id: schema.job.id,
    customerId: schema.job.customerId,
    status: schema.job.status,
    completedAt: schema.job.completedAt,
    parentJobId: schema.job.parentJobId,
  }).from(schema.job)
    .where(and(eq(schema.job.id, jobId), eq(schema.job.organizationId, organizationId)))
    .limit(1);
  if (!job) throw new NotFoundError("Job");

  /**
   * The technician's departure, not the office closing the job. Those
   * differ by up to a day in practice, and asking about a visit somebody
   * remembers from this morning is a different message from asking about
   * one they have to look up.
   */
  const [lastVisit] = await tx.select({ completedAt: schema.visit.completedAt })
    .from(schema.visit)
    .where(and(
      eq(schema.visit.jobId, jobId),
      inArray(schema.visit.status, ["completed", "completed_after_cancellation"]),
    ))
    .orderBy(desc(schema.visit.completedAt))
    .limit(1);

  const [invoice] = await tx.select({ balance: schema.invoice.balance })
    .from(schema.invoice)
    .where(and(
      eq(schema.invoice.organizationId, organizationId),
      eq(schema.invoice.jobId, jobId),
    )).limit(1);

  /**
   * A callback is a job whose parent is this one. Unresolved means it is
   * still open: the customer's defining experience of this work is that we
   * came back, and it is not over.
   */
  const [callback] = await tx.select({
    id: schema.job.id,
    completedAt: schema.job.completedAt,
    status: schema.job.status,
  }).from(schema.job)
    .where(and(
      eq(schema.job.organizationId, organizationId),
      eq(schema.job.parentJobId, jobId),
    ))
    .orderBy(desc(schema.job.createdAt))
    .limit(1);

  const [customer] = await tx.select({
    doNotService: schema.customer.doNotService,
  }).from(schema.customer)
    .where(eq(schema.customer.id, job.customerId)).limit(1);

  const [consent] = await tx.select({ id: schema.communicationConsent.id })
    .from(schema.communicationConsent)
    .where(and(
      eq(schema.communicationConsent.organizationId, organizationId),
      eq(schema.communicationConsent.customerId, job.customerId),
      eq(schema.communicationConsent.purpose, "marketing"),
      eq(schema.communicationConsent.state, "revoked"),
    )).limit(1);

  const sent = await tx.select({
    jobId: schema.reviewRequest.jobId,
    sentAt: schema.reviewRequest.sentAt,
  }).from(schema.reviewRequest)
    .where(and(
      eq(schema.reviewRequest.organizationId, organizationId),
      eq(schema.reviewRequest.customerId, job.customerId),
      eq(schema.reviewRequest.state, "sent"),
    ));

  /**
   * An open complaint is an obligation somebody raised against this job and
   * has not closed. The obligation table is the product's one primitive for
   * that, so this reads it rather than inventing a second flag.
   */
  const [complaint] = await tx.select({ id: schema.obligation.id })
    .from(schema.obligation)
    .where(and(
      eq(schema.obligation.organizationId, organizationId),
      eq(schema.obligation.entityType, "job"),
      eq(schema.obligation.entityId, jobId),
      inArray(schema.obligation.state, ["open", "breached"]),
    )).limit(1);

  return {
    jobId: job.id,
    customerId: job.customerId,
    /**
     * `completedAt`, not `status === "completed"`.
     *
     * The status moves ON past completed: a job whose invoice has been paid
     * reads `paid`, and a status check would withhold every paid job as
     * "not completed", which is every job this feature exists for. The
     * timestamp is the fact about the work; the status is where the job is
     * in its life.
     */
    completed: job.completedAt !== null,
    paid: invoice ? Number(invoice.balance) <= 0 : false,
    technicianLeftAt: lastVisit?.completedAt ?? null,
    callback: callback
      ? { resolvedAt: callback.completedAt }
      : null,
    complaintOpen: Boolean(complaint),
    /**
     * Two different things, both meaning do not ask. A revoked marketing
     * consent is the customer's instruction; `doNotService` is the
     * company's own decision about the relationship, and asking somebody
     * for a public review after deciding not to work for them again is a
     * bad idea for reasons nobody needs explained.
     */
    optedOut: Boolean(consent) || Boolean(customer?.doNotService),
    requests: sent
      .filter((r): r is { jobId: string; sentAt: Date } => r.sentAt !== null)
      .map((r) => ({ jobId: r.jobId, sentAt: r.sentAt })),
  };
}

export interface RequestOutcome {
  jobId: string;
  asked: boolean;
  requestId: string | null;
  sendAt: Date | null;
  readyNow: boolean;
  withheld: string | null;
  explanation: string | null;
  /** True when the reason will pass on its own: an unpaid invoice, a callback still open. */
  clearsOnItsOwn: boolean | null;
}

/**
 * Decide whether to ask about one job, and write down the answer either way.
 *
 * A WITHHELD request is a row, and that is not bookkeeping. A system that
 * only records what it sent cannot answer "why did this customer never get
 * asked", and the answer is almost always worth knowing: an open complaint
 * nobody closed, a callback still running, an opt out from three years ago.
 */
export async function requestFor(ctx: ServiceContext, input: { jobId: string; platform?: string }) {
  return guardedWrite(ctx, "review:respond", async (tx): Promise<RequestOutcome> => {
    const policyRow = await policyFor(tx, ctx.actor.organizationId);
    const facts = await factsFor(tx, ctx.actor.organizationId, input.jobId);
    const decision = rv.decideRequest(facts, requestPolicy(policyRow), new Date());

    /**
     * The platform's own rules are checked BEFORE anything is queued, not
     * before it is sent. A queued request that will be refused at send time
     * is a row somebody sees on a screen as pending, and pending is a
     * promise.
     */
    if (decision.ask && input.platform) {
      const catalogue = rv.checkPlatformPolicies(await platforms(tx, ctx.actor.organizationId));
      if (!catalogue.ok) throw new ConflictError(catalogue.reason);

      const verdict = rv.checkPlannedRequest({
        platform: input.platform,
        /**
         * All four declared as false, and none of them is a field somebody
         * can set. This product does not offer an incentive, does not send
         * in bulk, does not ask on site, and sends under the company's own
         * identity. They are passed explicitly rather than omitted so that
         * a future feature which changed one of them has to come here and
         * say so.
         */
        offersIncentive: false,
        isBulkSend: false,
        askedOnSite: false,
        sentByThirdParty: false,
      }, catalogue.byPlatform);

      if (!verdict.ok) throw new ConflictError(verdict.reason);
    }

    const values = decision.ask
      ? {
          organizationId: ctx.actor.organizationId,
          jobId: facts.jobId,
          customerId: facts.customerId,
          platform: input.platform ?? null,
          state: "queued" as const,
          sendAt: decision.sendAt,
          withheldReason: null,
          withheldDetail: null,
        }
      : {
          organizationId: ctx.actor.organizationId,
          jobId: facts.jobId,
          customerId: facts.customerId,
          platform: input.platform ?? null,
          state: "withheld" as const,
          sendAt: null,
          withheldReason: decision.withheld,
          withheldDetail: decision.explanation,
        };

    const [row] = await tx.insert(schema.reviewRequest).values(values)
      .onConflictDoUpdate({
        /**
         * One request per job, and re-deciding updates it. A job whose
         * invoice has since been paid should stop reading "withheld:
         * unpaid" the moment somebody asks again.
         */
        target: [schema.reviewRequest.jobId],
        targetWhere: isNull(schema.reviewRequest.deletedAt),
        set: { ...values, updatedAt: new Date() },
      }).returning();

    return decision.ask
      ? {
          jobId: facts.jobId, asked: true, requestId: row!.id,
          sendAt: decision.sendAt, readyNow: decision.readyNow,
          withheld: null, explanation: null, clearsOnItsOwn: null,
        }
      : {
          jobId: facts.jobId, asked: false, requestId: row!.id,
          sendAt: null, readyNow: false,
          withheld: decision.withheld, explanation: decision.explanation,
          clearsOnItsOwn: decision.clearsOnItsOwn,
        };
  });
}

/** Requests whose send window has arrived. What a worker drains. */
export async function due(ctx: ServiceContext, now = new Date()) {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const rows = await tx.select().from(schema.reviewRequest)
      .where(and(
        eq(schema.reviewRequest.organizationId, ctx.actor.organizationId),
        eq(schema.reviewRequest.state, "queued"),
        lte(schema.reviewRequest.sendAt, now),
      ))
      .orderBy(asc(schema.reviewRequest.sendAt));

    return rows.map((row) => ({
      id: row.id, jobId: row.jobId, customerId: row.customerId,
      platform: row.platform, sendAt: row.sendAt,
    }));
  });
}

/** Mark one as gone out. */
export async function markSent(ctx: ServiceContext, input: { id: string; messageId?: string }) {
  return guardedWrite(ctx, "review:respond", async (tx) => {
    const [row] = await tx.update(schema.reviewRequest).set({
      state: "sent",
      sentAt: new Date(),
      messageId: input.messageId ?? null,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.reviewRequest.id, input.id),
      eq(schema.reviewRequest.organizationId, ctx.actor.organizationId),
      eq(schema.reviewRequest.state, "queued"),
    )).returning();

    if (!row) {
      throw new ConflictError(
        "That request is not queued, so it has either gone already or was withheld. Sending it now would be the second ask.",
      );
    }
    return { id: row.id, sentAt: row.sentAt };
  });
}

/** Why people were not asked, grouped. A worklist rather than a log. */
export async function withheld(ctx: ServiceContext, limit = 50) {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const rows = await tx.select({
      reason: schema.reviewRequest.withheldReason,
      count: sql<number>`count(*)::int`,
    }).from(schema.reviewRequest)
      .where(and(
        eq(schema.reviewRequest.organizationId, ctx.actor.organizationId),
        eq(schema.reviewRequest.state, "withheld"),
      ))
      .groupBy(schema.reviewRequest.withheldReason)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);

    return rows.map((row) => ({ reason: row.reason ?? "unknown", count: row.count }));
  });
}

/* ------------------------------------------------- reviews that exist */

const toCore = (row: typeof schema.review.$inferSelect): rv.Review => ({
  id: row.id,
  platform: row.platform,
  rating: row.rating,
  postedAt: row.postedAt,
  respondedAt: row.respondedAt,
  ...(row.technicianId ? { technicianId: row.technicianId } : {}),
});

export interface ReviewInput {
  platform: string;
  rating: number;
  postedAt: Date;
  externalId?: string | null;
  authorName?: string | null;
  body?: string | null;
  jobId?: string | null;
  customerId?: string | null;
  technicianId?: string | null;
}

/**
 * Record a review that exists in the world.
 *
 * Entered by hand today, because no review platform connector is built and
 * the catalogue says so. That is not a placeholder: a company with forty
 * reviews and a work list telling them which three are owed a reply is
 * better off than one waiting for an API.
 *
 * The recovery clock is set HERE, on the way in, rather than computed on
 * every read. It is the one derived value in this file that is stored, and
 * the reason is that it is a commitment rather than a calculation: "somebody
 * will ring this customer today" is a promise made at the moment the review
 * landed, and recomputing it from a policy somebody edited last week would
 * quietly move a deadline that was already missed.
 */
export async function record(ctx: ServiceContext, input: ReviewInput) {
  return guardedWrite(ctx, "review:respond", async (tx) => {
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new ConflictError("A rating is a whole number from one to five.");
    }

    const policyRow = await policyFor(tx, ctx.actor.organizationId);
    const recovery = rv.routeReply(
      {
        jobId: input.jobId ?? "",
        customerId: input.customerId ?? "",
        rating: input.rating,
        receivedAt: input.postedAt,
      },
      {
        recoverAtOrBelow: policyRow.recoverAtOrBelow,
        sameDayAtOrBelow: policyRow.sameDayAtOrBelow,
      },
    );

    const recoveryDueAt = recovery.recover
      ? new Date(input.postedAt.getTime() + (recovery.urgency === "same_day" ? 8 : 32) * 3600_000)
      : null;

    const [row] = await tx.insert(schema.review).values({
      organizationId: ctx.actor.organizationId,
      platform: input.platform,
      externalId: input.externalId ?? null,
      rating: input.rating,
      authorName: input.authorName ?? null,
      body: input.body ?? null,
      postedAt: input.postedAt,
      jobId: input.jobId ?? null,
      customerId: input.customerId ?? null,
      technicianId: input.technicianId ?? null,
      recoveryDueAt,
    }).onConflictDoUpdate({
      /**
       * Keyed on the platform's own id, so an import can run twice. A
       * review edited by its author is the same review, and inserting a
       * second copy would double it in every average.
       */
      target: [schema.review.organizationId, schema.review.platform, schema.review.externalId],
      targetWhere: sql`external_id is not null and deleted_at is null`,
      set: {
        rating: input.rating,
        authorName: input.authorName ?? null,
        body: input.body ?? null,
        postedAt: input.postedAt,
        updatedAt: new Date(),
      },
    }).returning();

    await audit(tx, ctx, "review.recorded", "review", row!.id, null, {
      platform: input.platform, rating: input.rating,
      recoveryOwed: recovery.recover,
    });

    return {
      id: row!.id,
      rating: row!.rating,
      /**
       * Returned with the row, because the caller who just typed in a one
       * star needs to be told a phone call is owed and by when. Leaving
       * them to notice it on a list later is how the call does not happen.
       */
      recoveryOwed: recovery.recover,
      recoveryUrgency: recovery.recover ? recovery.urgency : null,
      because: recovery.because,
      recoveryDueAt,
    };
  });
}

/**
 * The reply queue, in the order somebody should work it.
 *
 * Overdue first, most overdue at the top, then by deadline, then by the
 * band's priority. Sorting by rating alone would put a week old one star
 * below a fresh one; sorting by date alone would put a five star from this
 * morning above a one star from last night.
 *
 * Answered reviews are not on it. A queue that keeps showing finished work
 * is a queue people stop reading.
 */
export async function workList(ctx: ServiceContext, now = new Date()) {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const policyRow = await policyFor(tx, ctx.actor.organizationId);

    const rows = await tx.select().from(schema.review)
      .where(and(
        eq(schema.review.organizationId, ctx.actor.organizationId),
        isNull(schema.review.respondedAt),
        isNull(schema.review.deletedAt),
      ));

    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = rv.responseWorkList(rows.map(toCore), responsePolicy(policyRow), now);

    return items.map((item) => {
      const row = byId.get(item.review.id)!;
      return {
        id: item.review.id,
        platform: item.review.platform,
        rating: item.review.rating,
        authorName: row.authorName,
        /** The text, because a work list showing only a star count sends somebody to another tab. */
        body: row.body,
        postedAt: item.review.postedAt,
        dueAt: item.dueAt,
        reason: item.reason,
        overdueBy: item.overdueBy,
        overdue: item.overdueBy > 0,
        /** A separate act from the public reply, and a separate deadline. */
        recoveryDueAt: row.recoveryDueAt,
        recoveredAt: row.recoveredAt,
      };
    });
  });
}

/**
 * Post a reply.
 *
 * Refuses an empty one, and refuses one that is identical to a reply already
 * posted under another review. Templated replies are in core's PROHIBITIONS
 * with the reason stated plainly: it is visible to any prospect who scrolls,
 * which is the real cost, and some platforms treat identical replies at
 * volume as automated activity.
 */
export async function respond(ctx: ServiceContext, input: { id: string; body: string }) {
  return guardedWrite(ctx, "review:respond", async (tx) => {
    const [existing] = await tx.select().from(schema.review)
      .where(and(
        eq(schema.review.id, input.id),
        eq(schema.review.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!existing) throw new NotFoundError("Review");
    if (existing.respondedAt) {
      throw new ConflictError("That review already has a reply. Editing it is a change on the platform, not here.");
    }

    const body = input.body.trim();
    if (body.length < 10) {
      throw new ConflictError("A reply that short says nothing. It is the only part of that conversation the company controls.");
    }

    const catalogue = rv.checkPlatformPolicies(await platforms(tx, ctx.actor.organizationId));
    if (!catalogue.ok) throw new ConflictError(catalogue.reason);

    const [duplicate] = await tx.select({ id: schema.review.id })
      .from(schema.review)
      .where(and(
        eq(schema.review.organizationId, ctx.actor.organizationId),
        eq(schema.review.responseBody, body),
      )).limit(1);

    const verdict = rv.checkPlannedReply(
      { platform: existing.platform, isTemplated: Boolean(duplicate) },
      catalogue.byPlatform,
    );
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const [row] = await tx.update(schema.review).set({
      respondedAt: new Date(),
      responseBody: body,
      respondedByUserId: ctx.actor.userId,
      updatedAt: new Date(),
    }).where(eq(schema.review.id, input.id)).returning();

    await audit(tx, ctx, "review.responded", "review", input.id, null, { platform: existing.platform });
    return { id: row!.id, respondedAt: row!.respondedAt };
  });
}

/**
 * Somebody rang the customer.
 *
 * Recorded separately from the public reply, because they are different
 * acts: one is a conversation and the other is what the next prospect
 * reads. A product that treated them as one would let a good public reply
 * close out a phone call that never happened.
 */
export async function markRecovered(ctx: ServiceContext, input: { id: string; note?: string }) {
  return guardedWrite(ctx, "review:respond", async (tx) => {
    const [row] = await tx.update(schema.review).set({
      recoveredAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.review.id, input.id),
      eq(schema.review.organizationId, ctx.actor.organizationId),
      isNull(schema.review.recoveredAt),
    )).returning();

    if (!row) throw new NotFoundError("Review awaiting a call");
    await audit(tx, ctx, "review.recovered", "review", input.id, null, { note: input.note ?? null });
    return { id: row.id, recoveredAt: row.recoveredAt };
  });
}

/**
 * Three views of the same reviews, because no single number is honest.
 *
 * The mean is what every platform shows and is wrong about TIME: a shop run
 * badly two years ago reads as mediocre forever. The recency weighted view
 * fixes that and is wrong about VOLUME: with a dozen reviews it swings on
 * one. The lower bound is wrong about how good you are, deliberately and
 * always downward, which is what makes it safe to sort by and unsafe to
 * print on a van.
 *
 * Every caveat travels with its number. A rating shown without one is the
 * thing that gets painted on the side of a truck.
 */
export async function rating(ctx: ServiceContext, input: { platform?: string } = {}) {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const policyRow = await policyFor(tx, ctx.actor.organizationId);

    const rows = await tx.select().from(schema.review)
      .where(and(
        eq(schema.review.organizationId, ctx.actor.organizationId),
        isNull(schema.review.deletedAt),
        ...(input.platform ? [eq(schema.review.platform, input.platform)] : []),
      ));

    return rv.summarise(
      rows.map(toCore),
      { halfLifeDays: policyRow.halfLifeDays },
      new Date(),
    );
  });
}

/**
 * Technicians in order, by the confidence aware figure.
 *
 * The lower bound rather than the mean, because the mean puts a technician
 * with two five stars above one with two hundred reviews averaging 4.8, and
 * the person reading this is deciding who to send to a difficult customer.
 */
export async function byTechnician(ctx: ServiceContext) {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const policyRow = await policyFor(tx, ctx.actor.organizationId);
    const rows = await tx.select({
      review: schema.review,
      name: schema.technician.displayName,
    }).from(schema.review)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.review.technicianId))
      .where(and(
        eq(schema.review.organizationId, ctx.actor.organizationId),
        isNull(schema.review.deletedAt),
      ));

    const groups = new Map<string, { name: string; reviews: rv.Review[] }>();
    for (const { review: row, name } of rows) {
      const key = row.technicianId!;
      const entry = groups.get(key) ?? { name, reviews: [] };
      entry.reviews.push(toCore(row));
      groups.set(key, entry);
    }

    const ranked = rv.rankByConfidence(
      [...groups.entries()].map(([key, entry]) => ({ key, reviews: entry.reviews })),
      { halfLifeDays: policyRow.halfLifeDays },
      new Date(),
    );

    return ranked.map((group) => ({
      technicianId: group.key,
      name: groups.get(group.key)?.name ?? "",
      count: group.view.count,
      mean: group.view.mean,
      recentMean: group.view.recentMean,
      /**
       * The number the ordering uses, published under its own name rather
       * than as "rating". It is deliberately lower than the real rating and
       * must never be shown to a customer as one.
       */
      confidence: group.view.confidence,
      caveats: group.view.caveats,
    }));
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  setReviewPolicy: (ctx: ServiceContext, input: PolicyInput) => setPolicy(ctx, input),

  listReviewPlatforms: async (ctx: ServiceContext): Promise<{
    platforms: {
      platform: string; displayName: string; reviewUrl: string | null;
      prohibits: string[]; note: string; active: boolean;
    }[];
  }> => ({ platforms: await listPlatforms(ctx) }),

  setReviewPlatform: (ctx: ServiceContext, input: {
    platform: string; displayName: string;
    reviewUrl?: string | null | undefined;
    prohibits: string[]; note: string;
  }): Promise<{ platform: string; displayName: string; prohibits: string[] }> =>
    setPlatform(ctx, { ...input, reviewUrl: input.reviewUrl ?? null }),

  requestReview: (ctx: ServiceContext, input: { jobId: string; platform?: string | undefined }) =>
    requestFor(ctx, {
      jobId: input.jobId,
      ...(input.platform ? { platform: input.platform } : {}),
    }),

  listDueRequests: async (ctx: ServiceContext): Promise<{
    requests: {
      id: string; jobId: string; customerId: string;
      platform: string | null; sendAt: Date | null;
    }[];
  }> => ({ requests: await due(ctx) }),

  markRequestSent: (ctx: ServiceContext, input: { id: string; messageId?: string | undefined }) =>
    markSent(ctx, {
      id: input.id,
      ...(input.messageId ? { messageId: input.messageId } : {}),
    }),

  listWithheld: async (ctx: ServiceContext): Promise<{
    reasons: { reason: string; count: number }[];
  }> => ({ reasons: await withheld(ctx) }),

  recordReview: (ctx: ServiceContext, input: {
    platform: string; rating: number; postedAt: string;
    externalId?: string | null | undefined;
    authorName?: string | null | undefined;
    body?: string | null | undefined;
    jobId?: string | null | undefined;
    customerId?: string | null | undefined;
    technicianId?: string | null | undefined;
  }): Promise<{
    id: string; rating: number; recoveryOwed: boolean;
    recoveryUrgency: string | null; because: string; recoveryDueAt: Date | null;
  }> => record(ctx, {
    platform: input.platform,
    rating: input.rating,
    postedAt: new Date(input.postedAt),
    externalId: input.externalId ?? null,
    authorName: input.authorName ?? null,
    body: input.body ?? null,
    jobId: input.jobId ?? null,
    customerId: input.customerId ?? null,
    technicianId: input.technicianId ?? null,
  }),

  getReviewWorkList: async (ctx: ServiceContext): Promise<{
    items: {
      id: string; platform: string; rating: number;
      authorName: string | null; body: string | null;
      postedAt: Date; dueAt: Date; reason: string;
      overdueBy: number; overdue: boolean;
      recoveryDueAt: Date | null; recoveredAt: Date | null;
    }[];
  }> => ({ items: await workList(ctx) }),

  respondToReview: (ctx: ServiceContext, input: { id: string; body: string }) =>
    respond(ctx, input),

  markReviewRecovered: (ctx: ServiceContext, input: { id: string; note?: string | undefined }) =>
    markRecovered(ctx, {
      id: input.id,
      ...(input.note ? { note: input.note } : {}),
    }),

  getRating: (ctx: ServiceContext, input: { platform?: string | undefined }): Promise<{
    count: number; mean: number | null; recentMean: number | null;
    confidence: number | null; method: string;
    caveats: { mean: string; recentMean: string; confidence: string };
  }> => rating(ctx, input.platform ? { platform: input.platform } : {}),

  getRatingByTechnician: async (ctx: ServiceContext): Promise<{
    technicians: {
      technicianId: string; name: string; count: number;
      mean: number | null; recentMean: number | null; confidence: number | null;
      caveats: { mean: string; recentMean: string; confidence: string };
    }[];
  }> => ({ technicians: await byTechnician(ctx) }),
} as const;
