import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { automation, reviews as rv, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import { inTenant, ConflictError, type ServiceContext } from "./context";
import { sendTransactional } from "./comms-send";
import * as email from "./email";
import * as reviews from "./reviews";
import { render } from "../lib/render";

/**
 * SENDING A REVIEW ASK: ONE SEND, TWO CALLERS
 *
 * The recommended automation sends the ask from a run, and the worker sends the
 * ask for a request the office queued by hand (`POST /v1/reviews/requests`,
 * whose answer was "later"). Both come through `deliverRequest`, so a text and
 * an email go through the same consent and suppression gate, say the same
 * thing, and mark the request the same way. A second implementation of the send
 * is the one that forgets a gate.
 *
 * THE CHANNEL IS A CHOICE. By text, by email, or by text first and then email:
 * the email goes only when the text could not (no number on the customer, or a
 * number that has not agreed to texts, or no number this company may text from),
 * never as well as it. One ask per job is the module's rule, and a second
 * message because the first worked would break it.
 *
 * THE WORKER'S TURN IS NOT A SEPARATE DECISION. Before it sends, it puts the
 * job to `reviews.requestWithin` again, now: the company's quiet hours, the
 * cooldown, an open complaint, a callback, an opt out. A request queued at
 * noon for six in the evening is judged at six in the evening, so a customer
 * who opted out, or a complaint opened, in between is not asked, and a worker
 * that was down until nine at night waits for the morning rather than texting at
 * nine at night. Consent is the same gate every other message goes through.
 *
 * ONLY THE OFFICE'S REQUESTS. A request an automation queued is sent by that
 * automation's own run, in its own words, when its wait is over. The worker
 * leaves those alone so the two cannot race to send the same ask in different
 * words.
 */

type RequestRow = typeof schema.reviewRequest.$inferSelect;

export type AskChannel = automation.ReviewAskChannel;

export interface AskWording {
  sms: string;
  emailSubject: string;
  emailBody: string;
}

export type DeliveryOutcome =
  /** Queued to the outbox on this channel, and the request marked sent. */
  | { kind: "sent"; channel: "sms" | "email"; messageId: string }
  /** Every channel tried refused it, and the request is marked failed with why. */
  | { kind: "refused"; refused: string }
  /** Not due, or already gone: nothing was done. */
  | { kind: "not_queued"; because: string }
  /** The request cannot go anywhere: no link for its review site, or no words. */
  | { kind: "cannot_send"; reason: string };

/** The wording a send step's configuration carries, or the default words for what it leaves out. */
export function wordingOf(config: Record<string, unknown>): AskWording {
  const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() !== "" ? value : fallback);
  const channel = config["channel"];
  return {
    sms: text(config["body"], automation.REVIEW_ASK_WORDING.sms),
    emailSubject: text(config["subject"], automation.REVIEW_ASK_WORDING.emailSubject),
    /** A single channel email keeps its words in `body`; text first then email keeps them in `emailBody`. */
    emailBody: text(channel === "email" ? config["body"] : config["emailBody"], automation.REVIEW_ASK_WORDING.emailBody),
  };
}

export function channelOf(config: Record<string, unknown>): AskChannel {
  return automation.isReviewAskChannel(config["channel"]) ? config["channel"] : automation.DEFAULT_REVIEW_ASK_CHANNEL;
}

/**
 * The send itself, shared by the ask and its one reminder: the text and/or the
 * email in the order the channel says, each through the consent and
 * suppression gate every message goes through, stopping at the first that is
 * queued. It writes nothing about the request: the caller says what happened.
 */
async function sendAsk(
  tx: Database,
  ctx: ServiceContext,
  request: Pick<RequestRow, "platform" | "customerId">,
  input: { channel: AskChannel; wording: AskWording },
): Promise<
  | { kind: "sent"; channel: "sms" | "email"; messageId: string }
  | { kind: "refused"; refused: string }
  | { kind: "cannot_send"; reason: string }
> {
  const organizationId = ctx.actor.organizationId;
  const url = request.platform ? await reviews.reviewUrlFor(tx, request.platform) : null;
  if (!url) {
    return {
      kind: "cannot_send",
      reason: request.platform
        ? `no link is declared for ${request.platform}, so there is nowhere to send them`
        : "the request names no review site, so there is nowhere to send them",
    };
  }

  const [customer] = await tx.select().from(schema.customer)
    .where(eq(schema.customer.id, request.customerId)).limit(1);
  const [org] = await tx.select({ name: schema.organization.name })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const scope = {
    customer: { ...(customer ?? {}), name: customer?.name.split(" ")[0] || customer?.name || "" },
    organization: { name: org?.name ?? "" },
    review: { url, platform: request.platform },
  };

  const order: ("sms" | "email")[] = input.channel === "sms_then_email" ? ["sms", "email"]
    : input.channel === "email" ? ["email"] : ["sms"];
  const refusals: string[] = [];

  for (const channel of order) {
    const label = channel === "sms" ? "text" : "email";
    const body = render(channel === "sms" ? input.wording.sms : input.wording.emailBody, scope).trim();
    if (body === "") return { kind: "cannot_send", reason: "step has no body" };
    const address = channel === "email" ? customer?.email : customer?.phone;
    if (!address) {
      refusals.push(`customer has no ${channel === "email" ? "email address" : "phone number"}`);
      continue;
    }
    if (channel === "sms") {
      const outcome = await sendTransactional(tx, { organizationId, address, body, customerId: request.customerId });
      if (outcome.sent) return { kind: "sent", channel: "sms", messageId: outcome.messageId };
      refusals.push(`${label}: ${outcome.explanation}`);
    } else {
      const subject = render(input.wording.emailSubject, scope).trim() || "How did we do?";
      const outcome = await email.queue({ ...ctx, db: tx }, {
        to: address, subject, text: body, customerId: request.customerId,
      });
      if (outcome.queued) return { kind: "sent", channel: "email", messageId: outcome.messageId };
      refusals.push(`${label}: ${outcome.explanation}`);
    }
  }
  return { kind: "refused", refused: refusals.join("; ") };
}

/**
 * Send one queued request, and write down what happened.
 *
 * Whoever calls this has already decided it is time: the run waited for the
 * window, or the worker re-decided the request just now. What is checked here
 * is only that it is still queued and its window has arrived.
 */
export async function deliverRequest(
  tx: Database,
  ctx: ServiceContext,
  request: RequestRow,
  input: { channel: AskChannel; wording: AskWording; automationRef: string | null; now: Date },
): Promise<DeliveryOutcome> {
  if (request.state !== "queued") return { kind: "not_queued", because: "nothing is queued for this job" };
  if (request.sendAt && request.sendAt > input.now) return { kind: "not_queued", because: "it is not due yet" };

  const sent = await sendAsk(tx, ctx, request, input);
  if (sent.kind === "cannot_send") return sent;

  if (sent.kind === "refused") {
    await tx.update(schema.reviewRequest).set({
      state: "failed", withheldDetail: sent.refused, updatedAt: new Date(),
    }).where(and(eq(schema.reviewRequest.id, request.id), eq(schema.reviewRequest.state, "queued")));
    return sent;
  }
  const messageId = sent.messageId;
  const used = sent.channel;

  if (input.automationRef) {
    await tx.update(schema.message).set({ automationRef: input.automationRef })
      .where(eq(schema.message.id, messageId));
  }
  await tx.update(schema.reviewRequest).set({
    state: "sent", sentAt: new Date(), messageId, updatedAt: new Date(),
  }).where(and(eq(schema.reviewRequest.id, request.id), eq(schema.reviewRequest.state, "queued")));
  return { kind: "sent", channel: used, messageId };
}

/* ------------------------------------------------------- the worker's turn */

/** What the worker acts as here: it decides and sends review asks, and nothing else. */
function workerActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["review:respond", "message:send"],
    agentId: "review-asks",
  };
}

/**
 * How the company's own recommended automation asks, if it has installed one:
 * the channel and words on its send step, wherever it has been switched on or
 * off since. A request the office queued by hand is asked the way the company
 * has said it asks, not in words the product chose later. Without one, by text
 * in the default words.
 */
export async function askStyleFor(tx: Database): Promise<{ channel: AskChannel; wording: AskWording }> {
  const [installed] = await tx.select({ steps: schema.workflowVersion.steps })
    .from(schema.workflow)
    .innerJoin(schema.workflowVersion, eq(schema.workflowVersion.id, schema.workflow.activeVersionId))
    .where(and(eq(schema.workflow.templateKey, "review_after_paid"), isNull(schema.workflow.deletedAt)))
    .orderBy(desc(schema.workflow.createdAt))
    .limit(1);
  const step = installed?.steps.find((s) => s["kind"] === "send_review_request");
  const config = (step?.["config"] ?? {}) as Record<string, unknown>;
  return { channel: channelOf(config), wording: wordingOf(config) };
}

export interface AskPassResult {
  organizationId: string;
  sent: number;
  /** Re-decided and not asked: a rule says no now, or the window has moved on (quiet hours). */
  held: number;
  failed: number;
  /** Reminders sent on this pass. */
  reminded: number;
  error: string | null;
}

/**
 * Work one company's due list: the requests the office queued whose window has
 * arrived. Each is in its own transaction, so one customer's refusal, or a
 * review site whose link was taken away, does not stop the rest.
 */
export async function askDueFor(
  db: Database, organizationId: string, options: { now?: Date; limit?: number } = {},
): Promise<AskPassResult> {
  const now = options.now ?? new Date();
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  const result: AskPassResult = { organizationId, sent: 0, held: 0, failed: 0, reminded: 0, error: null };

  const queued = await inTenant(ctx, async (tx) => ({
    style: await askStyleFor(tx),
    rows: await tx.select().from(schema.reviewRequest).where(and(
      eq(schema.reviewRequest.organizationId, organizationId),
      eq(schema.reviewRequest.state, "queued"),
      eq(schema.reviewRequest.source, "office"),
      isNull(schema.reviewRequest.deletedAt),
      sql`${schema.reviewRequest.sendAt} <= ${now.toISOString()}::timestamptz`,
    )).orderBy(asc(schema.reviewRequest.sendAt)).limit(options.limit ?? 50),
  }));

  for (const row of queued.rows) {
    try {
      const outcome = await inTenant(ctx, async (tx) => {
        /** Decided again, now, by the one function the office and the automation use. */
        const decided = await reviews.requestWithin(tx, organizationId, {
          jobId: row.jobId, source: "office", ...(row.platform ? { platform: row.platform } : {}),
        }, now);
        if (!decided.asked || !decided.readyNow) return { held: true as const };
        const [fresh] = await tx.select().from(schema.reviewRequest)
          .where(eq(schema.reviewRequest.id, row.id)).limit(1);
        if (!fresh) return { held: true as const };
        return { delivery: await deliverRequest(tx, ctx, fresh, {
          channel: queued.style.channel, wording: queued.style.wording, automationRef: null, now,
        }) };
      });
      if ("held" in outcome) result.held += 1;
      else if (outcome.delivery.kind === "sent") result.sent += 1;
      else if (outcome.delivery.kind === "not_queued") result.held += 1;
      else {
        result.failed += 1;
        if (outcome.delivery.kind === "cannot_send") {
          /** Nothing will change on its own, so it is marked rather than tried again every pass. */
          await inTenant(ctx, (tx) => tx.update(schema.reviewRequest).set({
            state: "failed", withheldDetail: (outcome.delivery as { reason: string }).reason, updatedAt: new Date(),
          }).where(and(eq(schema.reviewRequest.id, row.id), eq(schema.reviewRequest.state, "queued"))));
        }
      }
    } catch (error) {
      result.failed += 1;
      result.error = (error as Error).message;
      /**
       * A refusal on the merits (the review site's own rules, which no longer
       * allow this ask) will not change by being tried again, so it is written on
       * the request. Anything else (the database for a moment) leaves it queued
       * for the next pass.
       */
      if (error instanceof ConflictError) {
        await inTenant(ctx, (tx) => tx.update(schema.reviewRequest).set({
          state: "failed", withheldDetail: error.message.slice(0, 500), updatedAt: new Date(),
        }).where(and(eq(schema.reviewRequest.id, row.id), eq(schema.reviewRequest.state, "queued"))));
      }
    }
  }
  try {
    result.reminded = await remindDueFor(db, organizationId, { now, ...(options.limit ? { limit: options.limit } : {}) });
  } catch (error) {
    result.error = (error as Error).message;
  }
  return result;
}

/* --------------------------------------------------------- the one reminder */

/**
 * Send the one reminder for asks that went unanswered, for a company that has
 * turned reminders on (`review_policy.reminder_after_days`).
 *
 * For each sent ask old enough, with no reminder yet, the facts are read and
 * core's `decideReminder` says yes, not yet, or no for good:
 *
 *   NOT YET (a complaint or callback still open, outside the sending hours):
 *   nothing is written, and the next pass looks again.
 *
 *   NO FOR GOOD (the customer opted out, a review came in that is or may be
 *   theirs): the request is marked so it is never looked at again, with the
 *   reason in words. A reminder to somebody who has answered is the one mistake
 *   worth a missed nudge.
 *
 *   YES: the request is CLAIMED first, with an update that only lands while no
 *   reminder is recorded, and only the pass whose update landed sends. Two
 *   workers, or a worker that dies and starts again, send it once. The send is
 *   the ask's own, through the same consent and suppression gate, the way the
 *   company asks (its automation's channel, or text) and in the reminder's own
 *   words. A refusal (no number, replied STOP) is written on the request and is
 *   final: one reminder, ever.
 *
 * A REVIEW SINCE THE ASK is any live review tied to this customer, or to this
 * job, or suspected to be theirs and not dismissed, posted after the ask went
 * out, on any platform. Only that one exists is read, never what it says or
 * how many stars it gave.
 */
export async function remindDueFor(
  db: Database, organizationId: string, options: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };

  const candidates = await inTenant(ctx, async (tx) => {
    const [policy] = await tx.select().from(schema.reviewPolicy).where(and(
      eq(schema.reviewPolicy.organizationId, organizationId),
      eq(schema.reviewPolicy.active, true),
      isNull(schema.reviewPolicy.deletedAt),
    )).limit(1);
    if (!policy || policy.reminderAfterDays === null) return null;
    const cutoff = new Date(now.getTime() - policy.reminderAfterDays * 86_400_000);
    const rows = await tx.select().from(schema.reviewRequest).where(and(
      eq(schema.reviewRequest.organizationId, organizationId),
      eq(schema.reviewRequest.state, "sent"),
      isNull(schema.reviewRequest.reminderAt),
      isNull(schema.reviewRequest.deletedAt),
      lte(schema.reviewRequest.sentAt, cutoff),
    )).orderBy(asc(schema.reviewRequest.sentAt)).limit(options.limit ?? 50);
    return { policy, rows, style: await askStyleFor(tx) };
  });
  if (!candidates) return 0;

  let sent = 0;
  for (const row of candidates.rows) {
    try {
      const done = await inTenant(ctx, async (tx) => {
        const sentAt = row.sentAt!;
        const since = await tx.select({
          customerId: schema.review.customerId, jobId: schema.review.jobId,
          suggestedCustomerId: schema.review.suggestedCustomerId, suggestedJobId: schema.review.suggestedJobId,
          dismissed: schema.review.suggestionDismissedAt,
        }).from(schema.review).where(and(
          eq(schema.review.organizationId, organizationId),
          isNull(schema.review.deletedAt),
          gte(schema.review.postedAt, sentAt),
        )).limit(2000);
        /** Tied to them, or suspected to be theirs and not said to be wrong. Only that one exists is read. */
        const theirs = since.some((r) =>
          r.customerId === row.customerId || r.jobId === row.jobId
          || (r.dismissed === null && (r.suggestedCustomerId === row.customerId || r.suggestedJobId === row.jobId)));
        const job = await reviews.factsFor(tx, organizationId, row.jobId);
        const decision = rv.decideReminder({
          jobId: row.jobId, customerId: row.customerId, askedAt: sentAt, reminded: row.reminderAt !== null,
          reviewSince: theirs, optedOut: job.optedOut, complaintOpen: job.complaintOpen, callback: job.callback,
        }, {
          timeZone: candidates.policy.timeZone, reminderAfterDays: candidates.policy.reminderAfterDays,
          earliestHour: candidates.policy.earliestHour, latestHour: candidates.policy.latestHour,
        }, now);

        if (!decision.remind) {
          if (decision.clearsOnItsOwn) return false;
          await tx.update(schema.reviewRequest).set({
            reminderAt: now, reminderDetail: `Not sent: ${decision.explanation}`, updatedAt: now,
          }).where(and(eq(schema.reviewRequest.id, row.id), isNull(schema.reviewRequest.reminderAt)));
          return false;
        }
        if (!decision.readyNow) return false;

        /** The claim comes first: only the pass that lands it sends. */
        const [claimed] = await tx.update(schema.reviewRequest).set({ reminderAt: now, updatedAt: now })
          .where(and(
            eq(schema.reviewRequest.id, row.id), eq(schema.reviewRequest.state, "sent"), isNull(schema.reviewRequest.reminderAt),
          )).returning({ id: schema.reviewRequest.id });
        if (!claimed) return false;

        const outcome = await sendAsk(tx, ctx, row, {
          channel: candidates.style.channel,
          /** The company's own words when it changed them on Settings, Review policy; ours otherwise. */
          wording: reviews.reminderWording(candidates.policy),
        });
        if (outcome.kind === "sent") {
          await tx.update(schema.reviewRequest).set({ reminderMessageId: outcome.messageId, updatedAt: new Date() })
            .where(eq(schema.reviewRequest.id, row.id));
          return true;
        }
        const why = outcome.kind === "refused" ? outcome.refused : outcome.reason;
        await tx.update(schema.reviewRequest).set({ reminderDetail: `Not sent: ${why}`, updatedAt: new Date() })
          .where(eq(schema.reviewRequest.id, row.id));
        return false;
      });
      if (done) sent += 1;
    } catch {
      /** Left for the next pass: nothing was claimed, because the claim and the send are one transaction. */
    }
  }
  return sent;
}

/**
 * The worker's pass over every company with an office request due. One
 * company's failure is kept to that company, as the other passes do.
 */
export async function askPass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean } = {},
): Promise<AskPassResult[]> {
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.review_ask_organizations(${options.limit ?? 200}, ${(options.now ?? new Date()).toISOString()}::timestamptz)`,
  );
  const results: AskPassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    try {
      results.push(await askDueFor(db, row.organization_id, options.now ? { now: options.now } : {}));
    } catch (error) {
      results.push({ organizationId: row.organization_id, sent: 0, held: 0, failed: 0, reminded: 0, error: (error as Error).message });
    }
  }
  return results;
}
