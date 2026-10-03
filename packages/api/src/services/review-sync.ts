import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ads } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";
import * as reviews from "./reviews";
import {
  adsActor, adapterFor, connectedRows, runPull, type AdsDeps, type Connection, type PullOutcome,
} from "./ad-platforms";
import { PlatformRefusedError } from "../ads/index";

/**
 * GOOGLE BUSINESS PROFILE REVIEWS, READ AND ANSWERED FROM HERE
 *
 * Every hour the listing's reviews are read into the ordinary review table,
 * through the same `record` a person typing one in uses, so the recovery
 * clock, the work list and the rating are the reviews module's own and not a
 * second copy of them. A reply written on the review screen is posted back to
 * Google by the next pass, or at once from "Fetch and post now".
 *
 * WHO WROTE IT IS A SUGGESTION. A reviewer chooses their own display name.
 * Core suggests the customer whose name and recently finished job fit, the
 * suggestion is shown with its reason, and only a person's "Yes, that is
 * them" ties the review to a customer and a job. Nothing here writes
 * `review.customer_id`.
 *
 * A reply already on Google (written in Google's own app, or by an earlier
 * tool) comes in as the review's reply, so the work list does not ask the
 * office to answer a review that is answered.
 */

const ctxFor = (db: Database, organizationId: string): ServiceContext => ({ actor: adsActor(organizationId), db });
const platformKey = (row: Connection) => {
  const value = (row.settings as Record<string, unknown> | null)?.["platform"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "google";
};

/** Read the listing, and post the replies that are waiting. */
export async function pullReviews(db: Database, row: Connection, deps: AdsDeps = {}): Promise<PullOutcome> {
  const ctx = ctxFor(db, row.organizationId);
  const platform = platformKey(row);
  return runPull(db, row, "reviews", async () => {
    const adapter = await adapterFor(db, row, deps);
    if (!adapter.listReviews) return { read: 0, written: 0 };
    const pulled = await adapter.listReviews();
    let written = 0;
    for (const review of pulled) {
      const recorded = await reviews.record(ctx, {
        platform,
        externalId: review.externalId,
        rating: review.rating,
        postedAt: review.createdAt,
        authorName: review.authorName,
        body: review.comment,
      });
      written += 1;
      await inTenant(ctx, async (tx) => {
        const [current] = await tx.select().from(schema.review).where(eq(schema.review.id, recorded.id)).limit(1);
        if (!current) return;
        const patch: Partial<typeof schema.review.$inferInsert> = {};
        if (review.reply) {
          if (!current.respondedAt) {
            /** Answered on Google already. The office's work list should not ask for it again. */
            patch.respondedAt = review.reply.updatedAt;
            patch.responseBody = review.reply.comment;
            patch.replyState = "posted";
            patch.replyPostedAt = review.reply.updatedAt;
          } else if (current.replyState === "pending" && current.responseBody?.trim() === review.reply.comment.trim()) {
            patch.replyState = "posted";
            patch.replyPostedAt = review.reply.updatedAt;
            patch.replyError = null;
          }
        }
        if (!current.customerId && !current.suggestedCustomerId && !current.suggestionDismissedAt) {
          const suggestion = await suggestionFor(tx, row.organizationId, { authorName: review.authorName, postedAt: review.createdAt });
          if (suggestion) {
            patch.suggestedCustomerId = suggestion.customerId;
            patch.suggestedJobId = suggestion.jobId;
            patch.suggestionReason = suggestion.because;
          }
        }
        await tx.update(schema.review).set({ connectionId: row.id, ...patch, updatedAt: new Date() })
          .where(eq(schema.review.id, recorded.id));
      });
    }
    const posted = await postPendingReplies(db, row, deps, adapter);
    return { read: pulled.length, written: written + posted };
  });
}

/** Customers with a job finished in the match window before the review, as core's candidates. */
async function suggestionFor(tx: Database, organizationId: string, review: { authorName: string | null; postedAt: Date }) {
  if (!review.authorName) return null;
  const from = new Date(review.postedAt.getTime() - ads.MATCH_WINDOW_DAYS * 86_400_000);
  const rows = await tx.select({
    customerId: schema.customer.id, customerName: schema.customer.name,
    jobId: schema.job.id, finishedAt: schema.job.completedAt,
  }).from(schema.job)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
    .where(and(
      eq(schema.job.organizationId, organizationId),
      isNull(schema.job.deletedAt),
      gte(schema.job.completedAt, from),
      lte(schema.job.completedAt, review.postedAt),
    ))
    .orderBy(desc(schema.job.completedAt)).limit(500);
  return ads.suggestReviewMatch(review, rows
    .filter((r): r is typeof r & { finishedAt: Date } => r.finishedAt !== null)
    .map((r) => ({ customerId: r.customerId, customerName: r.customerName, jobId: r.jobId, finishedAt: r.finishedAt })));
}

/**
 * Post every reply written here and not yet on Google.
 *
 * A refusal is written on the review in Google's words and not tried again by
 * itself (Google refusing a reply is about the reply). A platform that is
 * down leaves it waiting for the next pass.
 */
export async function postPendingReplies(
  db: Database, row: Connection, deps: AdsDeps = {}, adapter?: Awaited<ReturnType<typeof adapterFor>>,
): Promise<number> {
  const ctx = ctxFor(db, row.organizationId);
  const pending = await inTenant(ctx, (tx) => tx.select().from(schema.review).where(and(
    eq(schema.review.organizationId, row.organizationId),
    eq(schema.review.connectionId, row.id),
    eq(schema.review.replyState, "pending"),
  )).limit(25));
  if (pending.length === 0) return 0;
  const platform = adapter ?? await adapterFor(db, row, deps);
  if (!platform.postReply) return 0;
  let posted = 0;
  for (const review of pending) {
    if (!review.externalId || !review.responseBody) continue;
    try {
      const done = await platform.postReply(review.externalId, review.responseBody);
      posted += 1;
      await inTenant(ctx, async (tx) => {
        await tx.update(schema.review).set({ replyState: "posted", replyPostedAt: done.postedAt, replyError: null, updatedAt: new Date() })
          .where(eq(schema.review.id, review.id));
        await audit(tx, ctx, "review.reply_posted", "review", review.id, null, { platform: review.platform });
      });
    } catch (error) {
      const refused = error instanceof PlatformRefusedError;
      await inTenant(ctx, (tx) => tx.update(schema.review).set({
        ...(refused ? { replyState: "failed" } : {}),
        replyError: (error as Error).message.slice(0, 500),
        updatedAt: new Date(),
      }).where(eq(schema.review.id, review.id)));
      if (!refused) throw error;
    }
  }
  return posted;
}

/** "Fetch and post now", for the person on the review screen. */
export async function syncNow(ctx: ServiceContext, deps: AdsDeps = {}): Promise<{
  listings: { provider: string; read: number; written: number; error: string | null }[];
}> {
  type Answer = { listings: { provider: string; read: number; written: number; error: string | null }[] };
  const again = await guardedWrite(ctx, "review:respond", (tx) => replayed<Answer>(tx, ctx, "review_sync"));
  if (again) return again;
  const rows = (await connectedRows(ctx.db, ctx.actor.organizationId))
    .filter((r) => ads.isAdsProvider(r.provider) && ads.PROVIDERS[r.provider].pullsReviews);
  const listings = [];
  for (const row of rows) {
    const outcome = await pullReviews(ctx.db, row, deps);
    listings.push({ provider: row.provider, read: outcome.read, written: outcome.written, error: outcome.error });
  }
  const answer = { listings };
  await guardedWrite(ctx, "review:respond", (tx) => remember(tx, ctx, "review_sync", null, answer));
  return answer;
}

/**
 * Yes, that is them; or no, it is not.
 *
 * Yes writes the suggested customer and job onto the review, which is the
 * only path that does for a review read from a listing. No clears the
 * suggestion and remembers it was wrong, so the next read does not offer it
 * again.
 */
export async function confirmMatch(
  ctx: ServiceContext, input: { id: string; accept: boolean },
): Promise<{ id: string; customerId: string | null; jobId: string | null }> {
  return guardedWrite(ctx, "review:respond", async (tx) => {
    const again = await replayed<{ id: string; customerId: string | null; jobId: string | null }>(tx, ctx, "review_match");
    if (again) return again;
    const [row] = await tx.select().from(schema.review).where(and(
      eq(schema.review.organizationId, ctx.actor.organizationId), eq(schema.review.id, input.id),
    )).limit(1);
    if (!row) throw new NotFoundError("Review");
    if (!row.suggestedCustomerId) throw new ConflictError("There is no suggestion on this review to answer.");
    const patch = input.accept
      ? { customerId: row.suggestedCustomerId, jobId: row.suggestedJobId ?? row.jobId }
      : { suggestionDismissedAt: new Date() };
    const [after] = await tx.update(schema.review).set({
      ...patch, suggestedCustomerId: null, suggestedJobId: null, suggestionReason: null, updatedAt: new Date(),
    }).where(eq(schema.review.id, row.id)).returning();
    await audit(tx, ctx, input.accept ? "review.match_confirmed" : "review.match_dismissed", "review", row.id,
      { suggestedCustomerId: row.suggestedCustomerId }, { customerId: after!.customerId, jobId: after!.jobId });
    const answer = { id: row.id, customerId: after!.customerId, jobId: after!.jobId };
    await remember(tx, ctx, "review_match", row.id, answer);
    return answer;
  });
}

/** The suggestions waiting for a person, with who and why. */
export async function suggestions(ctx: ServiceContext) {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const rows = await tx.select({
      id: schema.review.id, authorName: schema.review.authorName, rating: schema.review.rating,
      postedAt: schema.review.postedAt, reason: schema.review.suggestionReason,
      customerId: schema.review.suggestedCustomerId, customerName: schema.customer.name, jobId: schema.review.suggestedJobId,
    }).from(schema.review)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.review.suggestedCustomerId))
      .where(and(eq(schema.review.organizationId, ctx.actor.organizationId), sql`${schema.review.suggestedCustomerId} is not null`))
      .orderBy(desc(schema.review.postedAt)).limit(100);
    return rows;
  });
}

/** Replies a listing refused or has not taken yet, so the screen can say so beside the review. */
export async function replyStates(ctx: ServiceContext) {
  return guardedRead(ctx, "review:respond", async (tx) => tx.select({
    id: schema.review.id, replyState: schema.review.replyState, replyError: schema.review.replyError,
    replyPostedAt: schema.review.replyPostedAt, platform: schema.review.platform,
  }).from(schema.review).where(and(
    eq(schema.review.organizationId, ctx.actor.organizationId),
    sql`${schema.review.replyState} is not null`,
  )).orderBy(desc(schema.review.updatedAt)).limit(200));
}
