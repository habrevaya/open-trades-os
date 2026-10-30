import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, time, type Actor } from "@opentradesos/core";
import {
  audit, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { emit } from "./events";
import { fire } from "./workflow-runner";

/**
 * AN ESTIMATE PAST ITS DATE IS MARKED EXPIRED, BY THE WORKER
 *
 * `expires_on` was a date the proposal printed under "Good until" and the
 * pipeline was meant to honour, and nothing ever acted on it: `expired` was a
 * status only an estimate migrated from another system could arrive with, so a
 * quote that went out in March was "sent" in October and sat in the unsold
 * list as work the company could still close.
 *
 * THE COMPANY'S DAY, NOT UTC'S. "Good until the 30th" means through the end of
 * the 30th where the company is. Compared against the UTC date, an estimate
 * for a company in Austin would expire at seven in the evening on the 30th,
 * with the customer's last evening still ahead of them. It is expired on the
 * company's first moment of the 31st.
 *
 * ONLY WHAT IS OPEN. A `sent` or `viewed` estimate is one the customer was
 * given and has not answered. A draft has not gone anywhere, so its date has
 * not started running; approved, declined and converted are decisions, and an
 * estimate the customer said yes to does not stop being agreed because the
 * date on the paper passed. They are never selected, so they are never
 * touched.
 *
 * IDEMPOTENT BECAUSE OF THE WHERE CLAUSE. The update selects only the open
 * statuses, so an estimate it already marked is not selected again, a pass
 * repeated or run by two workers marks each estimate once, and the audit line
 * is written for the rows that actually changed.
 *
 * WHAT EXPIRED DOES, said where the rules are: it leaves the unsold pipeline,
 * it is the label on every screen, and financing is not offered on it.
 * Nothing else is taken away. An expiry date is a nudge and not a cliff
 * (`DECIDABLE` in `estimates.ts`): a customer who says yes to a quote a week
 * late is still saying yes, and the office can still record it.
 */

/** What the worker acts as here: it reads and writes estimates and nothing else. */
function workerActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["estimate:read", "estimate:write"],
    agentId: "estimate-expiry",
  };
}

/** The statuses an estimate has when the customer has it and has not answered. */
export const OPEN_STATUSES = ["sent", "viewed"] as const;

export interface ExpiredEstimate { id: string; number: number; expiresOn: string }

/**
 * Mark this company's estimates past their date as expired, as of `now` in the
 * company's own calendar. Returns the ones it changed.
 */
export async function expireFor(
  db: Database, organizationId: string, now: Date = new Date(),
): Promise<ExpiredEstimate[]> {
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  return inTenant(ctx, async (tx) => expireWithin(tx, ctx, now));
}

/** The same, inside a transaction that is already in the tenant. */
export async function expireWithin(tx: Database, ctx: ServiceContext, now: Date): Promise<ExpiredEstimate[]> {
  const today = time.dateIn(now, await timezoneOf(tx, ctx.actor.organizationId));
  const changed = await tx.update(schema.estimate)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(
      eq(schema.estimate.organizationId, ctx.actor.organizationId),
      inArray(schema.estimate.status, [...OPEN_STATUSES]),
      isNotNull(schema.estimate.expiresOn),
      lt(schema.estimate.expiresOn, today),
    ))
    .returning({
      id: schema.estimate.id, number: schema.estimate.number, expiresOn: schema.estimate.expiresOn,
    });

  for (const row of changed) {
    await audit(tx, ctx, "estimate.expired", "estimate", row.id,
      { status: "open" }, { status: "expired", expiresOn: row.expiresOn, on: today });
  }
  return changed.map((row) => ({ id: row.id, number: row.number, expiresOn: row.expiresOn! }));
}

/** When this process last went round, so the worker's few second loop does not ask a date question every few seconds. */
let lastPass: number | null = null;

export interface ExpiryPassResult { organizationId: string; expired: ExpiredEstimate[]; failed: string | null }

/**
 * The worker's pass over every company holding an open estimate with a date.
 * One company's failure is recorded and the pass goes on, as the task pass does.
 */
export async function expiryPass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean; force?: boolean } = {},
): Promise<ExpiryPassResult[]> {
  /**
   * Once a minute at most, per process. A date that changes meaning at the
   * company's midnight gains nothing from being looked at every few seconds,
   * and the screens read the date themselves in the meantime.
   */
  const at = (options.now ?? new Date()).getTime();
  if (!options.force && lastPass !== null && at - lastPass < 60_000 && at >= lastPass) return [];
  lastPass = at;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.estimate_expiry_organizations(${options.limit ?? 200}, ${new Date(at).toISOString().slice(0, 10)}::date)`,
  );
  const results: ExpiryPassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    try {
      results.push({
        organizationId: row.organization_id,
        expired: await expireFor(db, row.organization_id, options.now),
        failed: null,
      });
    } catch (error) {
      results.push({ organizationId: row.organization_id, expired: [], failed: (error as Error).message });
    }
  }
  return results;
}

/* ------------------------------------------------- giving the customer longer */

/** How far ahead a date may be moved: a year, past which it is a new estimate with today's prices. */
const LONGEST_EXTENSION_DAYS = 365;

export interface ExtendedEstimate {
  id: string;
  number: number;
  status: string;
  expiresOn: string;
  previousExpiresOn: string;
  /** When the link the customer was last sent stops working, or null when there is no live link to give them. */
  linkExpiresAt: string | null;
}

/**
 * GIVE THE CUSTOMER LONGER TO ANSWER.
 *
 * "Can you hold that price till the end of the month?" used to mean writing
 * the same estimate again, because an estimate has no edit. Now the office
 * moves its "Good until" date later, with a reason, and nothing else about
 * it changes: not a line, not a price, not the tax, not the terms. The
 * document the customer approves is the one they were sent, with the later
 * date on it.
 *
 * ONLY ONE NOBODY HAS ANSWERED. Sent, opened, or expired: the customer has it
 * and has not said yes or no. A draft's date has not started running, and an
 * approved, declined or converted estimate is a decision that a date does not
 * change. Only later, from today on and within a year, and only on an
 * estimate that had a date: one with none never runs out.
 *
 * AN EXPIRED ONE IS OPEN AGAIN. It goes back to opened if the customer had
 * opened it and to sent if not, so it is in the unsold list again and can be
 * financed, and the worker marks it expired again when the new date passes.
 *
 * THE CUSTOMER'S LINK WORKS AGAIN. The link the estimate was last sent with
 * is good until the end of the new date where the company is, when it would
 * have run out sooner. Never a link that was withdrawn (a later send, or a
 * send nobody received) or used up, and never the one day links a customer
 * opens from their own sign in: those are theirs to open again.
 *
 * THE FOLLOW UP DOES NOT START AGAIN BY ITSELF, BUT THE OFFICE CAN ASK FOR IT.
 * The "estimate nobody answered" sweep counts from when it was sent, so an
 * old estimate given longer would be chased the minute it was open again, on
 * the old send date. Left alone (`expiry_extended_at`) until somebody sends it
 * again, unless the office says to start it again from this day
 * (`restartFollowUp`, which the form offers by default and an API caller has
 * to ask for: a program moving a hundred dates should not text a hundred
 * customers because it forgot a flag). Then:
 *   the sweep counts its days from today (`follow_up_from`) and chases once
 *   more, however many times it chased before;
 *   the company's recommended follow up, if it has one switched on, is started
 *   afresh from today by the same runner that started it at the send, with its
 *   own wait, so the old run still waiting stops at its question and this one
 *   takes its place. Only that follow up: other automations that start from a
 *   send are not run again for a date that moved;
 *   `estimate.follow_up_restarted` is raised (not offered as a trigger).
 * A date moved again later without asking leaves the follow up stopped.
 */
export async function extend(
  ctx: ServiceContext, input: { id: string; expiresOn: string; reason: string; restartFollowUp?: boolean | undefined },
): Promise<ExtendedEstimate> {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    const reason = input.reason.trim();
    if (!reason) throw new ConflictError("Say why the customer is getting longer. It is kept with the change.");
    const [row] = await tx.select().from(schema.estimate)
      .where(eq(schema.estimate.id, input.id)).limit(1);
    if (!row) throw new NotFoundError("Estimate");

    const timezone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = time.dateIn(new Date(), timezone);

    if (row.expiresOn === input.expiresOn && row.expiryExtendedAt) {
      /** The same change again, a retry after a lost answer, is the change already made. */
      return { ...(await shapeExtended(tx, row)), previousExpiresOn: row.expiresOn };
    }
    if (row.status === "draft") {
      throw new ConflictError(`Estimate ${row.number} has not been sent, so its date has not started. Change it before sending by writing it again.`);
    }
    if (!(["sent", "viewed", "expired"] as string[]).includes(row.status)) {
      throw new ConflictError(`Estimate ${row.number} is ${row.status}, so the customer has answered and its date no longer matters.`);
    }
    if (!row.expiresOn) {
      throw new ConflictError(`Estimate ${row.number} has no end date, so it never runs out and there is nothing to extend.`);
    }
    if (input.expiresOn <= row.expiresOn) {
      throw new ConflictError(`Choose a day after ${row.expiresOn}, the day it is good until now.`);
    }
    if (input.expiresOn < today) {
      throw new ConflictError("Choose a day from today on. A day already gone would run out at once.");
    }
    if (input.expiresOn > time.addDays(today, LONGEST_EXTENSION_DAYS)) {
      throw new ConflictError("Choose a day within a year. Past that, write a new estimate with today's prices.");
    }

    const now = new Date();
    const status = row.status === "expired" ? (row.viewedAt ? "viewed" : "sent") : row.status;
    const restart = input.restartFollowUp === true;
    const [after] = await tx.update(schema.estimate).set({
      expiresOn: input.expiresOn, status, expiryExtendedAt: now, updatedAt: now,
      ...(restart ? { followUpFrom: now } : {}),
    }).where(and(eq(schema.estimate.id, row.id), inArray(schema.estimate.status, ["sent", "viewed", "expired"])))
      .returning();
    if (!after) throw new ConflictError(`Estimate ${row.number} was answered a moment ago.`);

    /** The link it was last sent with, still live, kept good until the end of the new day. */
    const link = await lastLink(tx, row.id);
    const endOfDay = time.daysFrom(input.expiresOn, 1, timezone).end;
    let linkBefore: Date | null = link?.expiresAt ?? null;
    if (link && link.expiresAt < endOfDay) {
      await tx.update(schema.portalGrant).set({ expiresAt: endOfDay, updatedAt: now })
        .where(eq(schema.portalGrant.id, link.id));
      linkBefore = link.expiresAt;
    }

    const restarted = restart ? await restartFollowUp(tx, ctx, after, now) : [];

    await audit(tx, ctx, "estimate.expiry_extended", "estimate", row.id,
      { expiresOn: row.expiresOn, status: row.status, linkExpiresAt: linkBefore?.toISOString() ?? null },
      {
        expiresOn: input.expiresOn, status, reason,
        linkExpiresAt: link ? (link.expiresAt < endOfDay ? endOfDay : link.expiresAt).toISOString() : null,
        followUpRestarted: restart, followUpRuns: restarted.length,
      });

    return { ...(await shapeExtended(tx, after)), previousExpiresOn: row.expiresOn };
  });
}

/**
 * Start the follow up again from today.
 *
 * The event carries what `estimate.sent` carries (the estimate, the customer)
 * and `restartedAt`, which is what tells the "still undecided?" question this
 * is a restart and not the first run. Only the company's recommended follow up
 * is started, by its template key, with a key of its own so a retry of the
 * same change starts it once. A company that switched it off, deleted it or
 * never had one starts nothing here: the sweep above still counts from today
 * for any automation of that kind it has.
 */
async function restartFollowUp(
  tx: Database, ctx: ServiceContext, estimate: typeof schema.estimate.$inferSelect, now: Date,
): Promise<string[]> {
  const [customer] = await tx.select({ name: schema.customer.name }).from(schema.customer)
    .where(eq(schema.customer.id, estimate.customerId)).limit(1);
  const event = await emit(tx, ctx, {
    name: "estimate.follow_up_restarted",
    entityType: "estimate",
    entityId: estimate.id,
    payload: {
      estimate: {
        id: estimate.id,
        number: estimate.number,
        title: estimate.title,
        customerId: estimate.customerId,
        sentAt: estimate.sentAt?.toISOString() ?? null,
        restartedAt: now.toISOString(),
        expiresOn: estimate.expiresOn,
      },
      customer: { id: estimate.customerId, name: customer?.name ?? "" },
    },
  });
  const followUps = await tx.select({ id: schema.workflow.id }).from(schema.workflow)
    .where(and(
      eq(schema.workflow.templateKey, "estimate_follow_up"),
      eq(schema.workflow.enabled, true),
      isNull(schema.workflow.deletedAt),
    ));
  const started: string[] = [];
  for (const workflow of followUps) {
    const run = await fire(tx, ctx, {
      workflowId: workflow.id,
      eventId: event.id,
      idempotencyKey: `follow-up-restart:${workflow.id}:${estimate.id}:${now.getTime()}`,
    });
    if (run.runId) started.push(run.runId);
  }
  return started;
}

/** The link the estimate was last sent with, while it can still be used. */
async function lastLink(tx: Database, estimateId: string) {
  const [row] = await tx.select({
    id: schema.portalGrant.id, expiresAt: schema.portalGrant.expiresAt,
    maxUses: schema.portalGrant.maxUses, useCount: schema.portalGrant.useCount,
  })
    .from(schema.estimateDelivery)
    .innerJoin(schema.portalGrant, eq(schema.portalGrant.id, schema.estimateDelivery.portalGrantId))
    .where(and(eq(schema.estimateDelivery.estimateId, estimateId), isNull(schema.portalGrant.revokedAt)))
    .orderBy(desc(schema.estimateDelivery.createdAt))
    .limit(1);
  if (!row || (row.maxUses !== null && row.useCount >= row.maxUses)) return null;
  return row;
}

async function shapeExtended(
  tx: Database, row: typeof schema.estimate.$inferSelect,
): Promise<Omit<ExtendedEstimate, "previousExpiresOn">> {
  const link = await lastLink(tx, row.id);
  return {
    id: row.id, number: row.number, status: row.status, expiresOn: row.expiresOn!,
    linkExpiresAt: link ? link.expiresAt.toISOString() : null,
  };
}

export const handlers = {
  extendEstimateExpiry: (ctx: ServiceContext, input: Parameters<typeof extend>[1]) => extend(ctx, input),
} as const;
