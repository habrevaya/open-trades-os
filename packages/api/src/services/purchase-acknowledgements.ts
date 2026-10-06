import { asc, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { inventory as inv, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { remember, replayed } from "./once";

/**
 * WHAT THE VENDOR SAID BACK, WRITTEN DOWN BY HAND
 *
 * A vendor's reply to an order is an email or a call: "got it, we will ship
 * by the 14th, our reference is SO-5541". Somebody reads it and records it
 * here: when, the promise date, their reference and what else they said. NO
 * EMAIL IS PARSED. A model or a pattern guessing a date out of a reply would be
 * a date a buyer trusts and nobody wrote, and the one thing a promise date is
 * for is to be held to.
 *
 * The first reply moves a sent order to acknowledged, which core already
 * allows and the reorder engine already counts as on order. Every reply is kept
 * with the promise it replaced, so a date that has moved twice says so. The
 * promise does not overwrite what the buyer asked for (`expected_at`, "wanted
 * by", which the order's PDF says): the reorder suggestions read the promise
 * when there is one, due at the end of that day in the company's calendar, so
 * their "late" and this list's "past its promise" are one fact.
 *
 * AND WHAT NEEDS A CALL. `followUpFor` in core names the two kinds: an order
 * nobody answered for the company's own number of days, and an order past its
 * promise with something still owed. The purchasing list shows them first.
 *
 * `po:write` to record, because it changes what the company expects and when;
 * `po:read` to read.
 */

/* ------------------------------------------------------------- settings */

export async function acknowledgeAfterDaysWithin(tx: Database, organizationId: string): Promise<number> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const blob = ((row?.settings ?? {}) as Record<string, unknown>)["purchasing"];
  const days = blob && typeof blob === "object" ? (blob as Record<string, unknown>)["acknowledgeAfterDays"] : undefined;
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= inv.MAX_ACKNOWLEDGE_AFTER_DAYS
    ? days : inv.DEFAULT_ACKNOWLEDGE_AFTER_DAYS;
}

export interface PurchasingSettings { acknowledgeAfterDays: number }

export async function getSettings(ctx: ServiceContext): Promise<PurchasingSettings> {
  return guardedRead(ctx, "po:read", async (tx) => ({
    acknowledgeAfterDays: await acknowledgeAfterDaysWithin(tx, ctx.actor.organizationId),
  }));
}

/** Ring a vendor who has not answered after this many days. 1 to 30, whole days. */
export async function setSettings(ctx: ServiceContext, input: { acknowledgeAfterDays: number }): Promise<PurchasingSettings> {
  return guardedWrite(ctx, "po:write", async (tx) => {
    const days = input.acknowledgeAfterDays;
    if (!Number.isInteger(days) || days < 1 || days > inv.MAX_ACKNOWLEDGE_AFTER_DAYS) {
      throw new ConflictError(`Say a whole number of days from 1 to ${inv.MAX_ACKNOWLEDGE_AFTER_DAYS}.`);
    }
    const before = await acknowledgeAfterDaysWithin(tx, ctx.actor.organizationId);
    await tx.update(schema.organization).set({
      settings: sql`${schema.organization.settings} || ${JSON.stringify({ purchasing: { acknowledgeAfterDays: days } })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "purchasing.settings", "organization", ctx.actor.organizationId,
      { acknowledgeAfterDays: before }, { acknowledgeAfterDays: days });
    return { acknowledgeAfterDays: days };
  });
}

/* ---------------------------------------------------------- recording it */

export interface ReplyInput {
  /** The day they promised it by, as the company's calendar day. */
  promisedOn?: string | null | undefined;
  /** Their own number for the order. */
  reference?: string | null | undefined;
  /** What else they said. */
  note?: string | null | undefined;
}

export interface ReplyView {
  id: string;
  promisedOn: string | null;
  previousPromisedOn: string | null;
  reference: string | null;
  note: string | null;
  recordedByName: string | null;
  recordedAt: string;
}

type Order = typeof schema.purchaseOrder.$inferSelect;

/**
 * Write one reply and move the order to match, inside the caller's
 * transaction. Used by the call below and by the status button that says the
 * vendor confirmed with nothing else, so that button leaves the same record
 * behind a reply typed with a date.
 */
export async function writeReply(
  tx: Database, ctx: ServiceContext, order: Order, input: ReplyInput,
): Promise<void> {
  const promisedOn = input.promisedOn ?? null;
  const [self] = await tx.select({ name: schema.user.name, email: schema.user.email }).from(schema.user)
    .where(eq(schema.user.id, ctx.actor.userId)).limit(1);
  const now = new Date();

  await tx.insert(schema.purchaseOrderAcknowledgement).values({
    organizationId: ctx.actor.organizationId,
    purchaseOrderId: order.id,
    promisedOn,
    previousPromisedOn: order.promisedOn,
    reference: input.reference?.trim() ? input.reference.trim().slice(0, 100) : null,
    note: input.note?.trim() ? input.note.trim().slice(0, 1000) : null,
    recordedByUserId: ctx.actor.userId,
    recordedByName: self?.name ?? self?.email ?? null,
  });

  await tx.update(schema.purchaseOrder).set({
    status: order.status === "submitted" ? "acknowledged" : order.status,
    acknowledgedAt: order.acknowledgedAt ?? now,
    ...(promisedOn ? { promisedOn } : {}),
    ...(input.reference?.trim() ? { vendorReference: input.reference.trim().slice(0, 100) } : {}),
    updatedAt: now,
  }).where(eq(schema.purchaseOrder.id, order.id));
}

/**
 * Record what the vendor said, from their reply.
 *
 * A sent order, one they have already answered and one part delivered can each
 * take a reply; a draft was never sent and a finished or cancelled order has
 * nothing left to promise. At least one thing has to be said unless this is
 * the first reply, which may be just "they confirmed". A promise date before
 * the day the order was sent is refused as a slip.
 */
export async function record(
  ctx: ServiceContext, input: ReplyInput & { id: string },
): Promise<{ id: string; status: string; promisedOn: string | null; acknowledgedAt: string }> {
  return guardedWrite(ctx, "po:write", async (tx) => {
    type Answer = { id: string; status: string; promisedOn: string | null; acknowledgedAt: string };
    const seen = await replayed<Answer>(tx, ctx, "purchase_order.acknowledged");
    if (seen) return seen;

    const [order] = await tx.select().from(schema.purchaseOrder)
      .where(eq(schema.purchaseOrder.id, input.id)).limit(1).for("update");
    if (!order) throw new NotFoundError("Purchase order");
    const status = order.status as inv.PurchaseOrderStatus;
    if (status === "draft") {
      throw new ConflictError("This order has not been sent to the vendor yet, so there is no reply to write down. Send it first.");
    }
    if (status === "received" || status === "cancelled") {
      throw new ConflictError(`This order is ${inv.PURCHASE_ORDER_STATUS[status].label.toLowerCase()}, so there is nothing left for the vendor to promise.`);
    }

    const promisedOn = input.promisedOn?.trim() || null;
    const reference = input.reference?.trim() || null;
    const note = input.note?.trim() || null;
    if (promisedOn !== null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(promisedOn) || Number.isNaN(Date.parse(`${promisedOn}T00:00:00Z`))) {
        throw new ConflictError("Say the day they promised it by.");
      }
      const zone = await timezoneOf(tx, ctx.actor.organizationId);
      const sentOn = order.submittedAt ? time.dateIn(order.submittedAt, zone) : null;
      if (sentOn !== null && promisedOn < sentOn) {
        throw new ConflictError(`That is before the order was sent on ${sentOn}. Check the date they gave.`);
      }
      if (promisedOn > time.addDays(time.dateIn(new Date(), zone), 366)) {
        throw new ConflictError("That is more than a year away. Check the date they gave.");
      }
    }
    if (status !== "submitted" && promisedOn === null && reference === null && note === null) {
      throw new ConflictError("They have already answered this one. Say what is new: a promise date, their reference or what they said.");
    }

    await writeReply(tx, ctx, order, { promisedOn, reference, note });
    await audit(tx, ctx, "purchase_order.acknowledged", "purchase_order", order.id,
      { status, promisedOn: order.promisedOn }, { status: status === "submitted" ? "acknowledged" : status, promisedOn, reference });

    const [after] = await tx.select().from(schema.purchaseOrder).where(eq(schema.purchaseOrder.id, order.id)).limit(1);
    const answer: Answer = {
      id: order.id, status: after!.status, promisedOn: after!.promisedOn, acknowledgedAt: after!.acknowledgedAt!.toISOString(),
    };
    await remember(tx, ctx, "purchase_order.acknowledged", order.id, answer);
    return answer;
  });
}

/** Every reply on an order, oldest first. */
export async function repliesWithin(tx: Database, orderId: string): Promise<ReplyView[]> {
  const rows = await tx.select().from(schema.purchaseOrderAcknowledgement)
    .where(eq(schema.purchaseOrderAcknowledgement.purchaseOrderId, orderId))
    .orderBy(asc(schema.purchaseOrderAcknowledgement.createdAt), asc(schema.purchaseOrderAcknowledgement.id));
  return rows.map((r) => ({
    id: r.id, promisedOn: r.promisedOn, previousPromisedOn: r.previousPromisedOn, reference: r.reference,
    note: r.note, recordedByName: r.recordedByName, recordedAt: r.createdAt.toISOString(),
  }));
}

/** The call to make about one order, or null, for the list and the order's own page. */
export async function followUpWithin(
  tx: Database, organizationId: string, order: Pick<Order, "status" | "submittedAt" | "promisedOn">,
  vendorName: string, outstanding: boolean,
): Promise<inv.FollowUp | null> {
  const zone = await timezoneOf(tx, organizationId);
  return inv.followUpFor({
    status: order.status as inv.PurchaseOrderStatus,
    vendorName,
    submittedOn: order.submittedAt ? time.dateIn(order.submittedAt, zone) : null,
    promisedOn: order.promisedOn,
    outstanding,
    today: time.dateIn(new Date(), zone),
    acknowledgeAfterDays: await acknowledgeAfterDaysWithin(tx, organizationId),
  });
}

export const handlers = {
  recordPurchaseOrderAcknowledgement: (ctx: ServiceContext, input: ReplyInput & { id: string }) => record(ctx, input),
  getPurchasingSettings: (ctx: ServiceContext) => getSettings(ctx),
  setPurchasingSettings: (ctx: ServiceContext, input: { acknowledgeAfterDays: number }) => setSettings(ctx, input),
} as const;
