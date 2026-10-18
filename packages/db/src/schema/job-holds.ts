import { pgTable, pgEnum, uuid, text, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared";
import { organization, user } from "./tenancy";
import { job, jobStatus } from "./work";
import { purchaseOrder } from "./inventory";
import { task } from "./automation";

/**
 * WHY A JOB IS ON HOLD
 *
 * `on_hold` was a status and nothing more. A job waiting on a compressor and a
 * job waiting on the customer to clear the attic looked the same on the board,
 * and the first time fix rate, whose plumbing and electrical definitions
 * EXCLUDE "jobs held for a part order" (and, for an electrician, "or an
 * inspection"), could not tell them apart. So a hold is a record with a
 * reason from a fixed list, and a part hold names the purchase order the part
 * is on, which is what makes "held for a part order" a fact rather than a
 * claim.
 *
 *   part         waiting on a part, on a purchase order this hold names
 *   inspection   waiting on the city or the utility to inspect
 *   customer     waiting on the customer: a decision, access, a payment
 *   weather      waiting on the weather
 *   other        anything else, said in the note
 *
 * A fixed list rather than words, for the reason a cancellation got one: the
 * figure reads the code, and words are never read for a reason ("part" might
 * be the part the customer is buying themselves).
 */
export const jobHoldReason = pgEnum("job_hold_reason", ["part", "inspection", "customer", "weather", "other"]);

export const jobHold = pgTable("job_hold", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  reason: jobHoldReason("reason").notNull(),
  /**
   * The order the part is on. Required for a `part` hold and only there.
   * Restrict, because a hold that named an order is the record of why the
   * job waited, and deleting the order must not quietly turn it into a hold
   * on nothing.
   */
  purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrder.id, { onDelete: "restrict" }),
  /** What the part is, which inspection, or what "other" means. Required for `inspection` and `other`. */
  note: text("note"),
  /**
   * The status the job was in when it was held, so taking it off hold puts it
   * back where it was (booked, or under way) rather than guessing.
   */
  statusBefore: jobStatus("status_before").notNull(),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  placedByUserId: uuid("placed_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Null while the job is still held. */
  releasedAt: timestamp("released_at", { withTimezone: true }),
  releasedByUserId: uuid("released_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /**
   * The nudge the worker raised for this hold, and when. Set once, in the
   * transaction that writes the task, against a row that had none, so a pass
   * cut short and run again raises nothing twice. A nudge somebody closed
   * by hand is not raised again for the same hold: the hold is the claim, not
   * the task.
   */
  nudgedAt: timestamp("nudged_at", { withTimezone: true }),
  nudgeTaskId: uuid("nudge_task_id").references(() => task.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  jobIdx: index("job_hold_job_idx").on(t.organizationId, t.jobId),
  /**
   * ONE OPEN HOLD PER JOB. A job is on hold or it is not, and two open holds
   * would leave nobody able to say which reason took it off the board.
   */
  openIdx: uniqueIndex("job_hold_open_idx").on(t.jobId).where(sql`${t.releasedAt} is null`),
  orderIdx: index("job_hold_order_idx").on(t.purchaseOrderId).where(sql`${t.purchaseOrderId} is not null`),
}));
