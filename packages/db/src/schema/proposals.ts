import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { pk } from "./_shared";
import { organization, user } from "./tenancy";
import { estimate } from "./billing";
import { portalGrant } from "./portal";
import { message } from "./comms";

/**
 * AN ESTIMATE PUT IN FRONT OF THE CUSTOMER
 *
 * Sending an estimate used to issue a link and hand it back to whoever
 * pressed the button, and that was all: the contract offered email and text
 * as channels and delivered neither, so the office copied the link into its
 * own phone and nothing in the product knew it had gone anywhere.
 *
 * One row per attempt, in the shape `invoice_delivery` already has, because
 * the question is the same one: did the customer get it. The message the
 * attempt became is joined rather than copied, because `services/email.ts`
 * and the outbox own what a provider says happened to it afterwards, and a
 * copy of that status here is the stale one on the day somebody reads it.
 *
 * Append only. An attempt is something that happened, so nothing updates one
 * after it is written except to record the message or the refusal it ended
 * in, and nothing deletes one.
 */
export const estimateDeliveryChannel = pgEnum("estimate_delivery_channel", ["email", "sms", "link"]);

export const estimateDelivery = pgTable("estimate_delivery", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  estimateId: uuid("estimate_id").notNull().references(() => estimate.id, { onDelete: "cascade" }),
  channel: estimateDeliveryChannel("channel").notNull(),
  /** The address or number it went to. Null for a link handed over by hand. */
  destination: text("destination"),
  /** The outbound email or text, which is also the line in the conversation thread. */
  messageId: uuid("message_id").references(() => message.id, { onDelete: "set null" }),
  /** The approval link this attempt carried, so it can be withdrawn on its own. */
  portalGrantId: uuid("portal_grant_id").references(() => portalGrant.id, { onDelete: "set null" }),
  /** Why the transport refused, in its own words: they replied STOP, no address, no sender. */
  error: text("error"),
  sentByUserId: uuid("sent_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  estimateIdx: index("estimate_delivery_estimate_idx").on(t.estimateId, t.createdAt),
}));
/**
 * A TEXT TO TELL A CUSTOMER THEY WERE GIVEN LONGER, HELD FOR THE MORNING.
 *
 * Giving a customer longer can tell them by text, and a text is not sent in
 * the company's quiet hours. Rather than lose it, the words are kept here and
 * the worker sends it once the hours are over: `waiting` until then, `sent`
 * when it went, `refused` when the send was tried and the customer could not
 * be texted any more (they replied STOP), `cancelled` when it no longer made
 * sense (the customer answered, the date moved again, the office sent the
 * estimate by hand, or another held text replaced it). One waiting per
 * estimate, so a text is never held twice.
 */
export const estimateHeldTextState = pgEnum("estimate_held_text_state", ["waiting", "sent", "refused", "cancelled"]);

export const estimateHeldText = pgTable("estimate_held_text", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  estimateId: uuid("estimate_id").notNull().references(() => estimate.id, { onDelete: "cascade" }),
  state: estimateHeldTextState("state").notNull().default("waiting"),
  /** The company's words for the line above the link, as they read when the date moved. */
  note: text("note").notNull(),
  /** The good until date the words name. A text is only sent while the estimate still has this date. */
  expiresOn: date("expires_on").notNull(),
  /** The link in the text works at least until this moment. */
  linkUntil: timestamp("link_until", { withTimezone: true }).notNull(),
  heldByUserId: uuid("held_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** When it was sent, refused or cancelled. */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  /** Why it was refused or cancelled, in words for the office. */
  reason: text("reason"),
  /** The delivery row the morning's send wrote. */
  deliveryId: uuid("delivery_id").references(() => estimateDelivery.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  estimateIdx: index("estimate_held_text_estimate_idx").on(t.estimateId, t.createdAt),
  oneWaiting: uniqueIndex("estimate_held_text_one_waiting_idx").on(t.estimateId).where(sql`${t.state} = 'waiting'`),
}));


