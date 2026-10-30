import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, comms, customerPortal as cp, type Actor } from "@opentradesos/core";
import { audit, inTenant, type ServiceContext } from "./context";
import * as email from "./email";
import { sendTransactional, quietHoursFor } from "./comms-send";
import { settingsWithin } from "./portal-settings";
import { preferenceOf } from "./statement-delivery";
import { portalBase } from "../lib/portal-base";

/**
 * TELLING A CUSTOMER THE OFFICE ANSWERED THEIR CHAT (M05)
 *
 * A reply written in the inbox reached the customer's open chat page and
 * nothing else: a customer who had closed the page found it only by coming
 * back. So when somebody in the office answers a chat from a customer's
 * account, the customer is told once, by the way they would rather hear from
 * the company, with a link to their account's chat. The reply is not in the
 * message: a text sits on a lock screen, and the conversation is behind their
 * own sign in.
 *
 * ONCE UNTIL THEY READ IT. `customer_notified_at` is set when they are told,
 * and nobody is told again until `customer_read_at` (the last time the chat
 * was open) has moved past it. Five replies in a row are one notice.
 *
 * NOT WHEN THEY ARE LOOKING. A chat page asks every few seconds, so a customer
 * who read it a moment ago has the reply on their screen already.
 *
 * THROUGH THE GATES EVERYTHING ELSE GOES THROUGH. A text is `sendTransactional`
 * (consent, STOP, the company's number) and never in the company's quiet hours;
 * an email is `email.queueIn`. Whichever the customer prefers is tried first and
 * the other is the fallback, because a text held back at night should still
 * reach a customer who also has an email address. A contact who signed in as
 * themselves is told at their OWN number or address, never the customer's:
 * the chat is theirs, and the account's owner is not owed a notice about it.
 *
 * HELD BY QUIET HOURS, SENT WHEN THEY END. A notice that could only go by text
 * (no email address, or the email could not go either) and was stopped by the
 * company's quiet hours is not dropped: it is kept (`customer_notice_held_at`)
 * and the worker sends it once the hours end. Everything above is asked again
 * then, not remembered: the customer's consent, STOP and number as they are
 * that morning, the setting as it is, and whether they have read the chat. A
 * customer who read it meanwhile, who closed it, or whose company turned the
 * notice off is told nothing; a notice more than two days old is dropped,
 * because an answer that old is not news. It is still once until they read it,
 * and still never more than one waiting per conversation.
 *
 * NEVER AN ERROR FOR THE PERSON REPLYING. Whatever happens to the notice, the
 * reply is sent: a failure is written on the chat (`customer_notice`) in words,
 * where the inbox shows it, and the customer's account page still marks the
 * unread reply. A notice that could not go is not retried by itself, except
 * the one quiet hours held; the next reply tries again.
 */

/** A customer who had the chat open this recently is looking at it. */
export const PRESENT_SECONDS = 30;

type Conversation = typeof schema.conversation.$inferSelect;

/** Where and how this conversation's customer would be told. */
async function recipientOf(tx: Database, conversation: Conversation) {
  if (conversation.contactId) {
    const [contact] = await tx.select({
      name: schema.contact.name, email: schema.contact.email, phone: schema.contact.phone,
      preferredChannel: schema.contact.preferredChannel,
    }).from(schema.contact).where(eq(schema.contact.id, conversation.contactId)).limit(1);
    if (!contact) return null;
    return {
      name: contact.name,
      email: (contact.email ?? "").trim() || null,
      phone: (contact.phone ?? "").trim() || null,
      prefersText: contact.preferredChannel === "sms",
    };
  }
  if (!conversation.customerId) return null;
  const [customer] = await tx.select({ name: schema.customer.name, email: schema.customer.email })
    .from(schema.customer).where(eq(schema.customer.id, conversation.customerId)).limit(1);
  if (!customer) return null;
  const preference = await preferenceOf(tx, conversation.customerId);
  return {
    name: customer.name,
    email: (customer.email ?? "").trim() || null,
    phone: preference.phone,
    prefersText: preference.prefersText,
  };
}

/**
 * Tell the customer of this conversation that the office answered, if they are
 * owed a notice. Called inside the transaction that wrote the reply, by the
 * `message:send` guard that wrote it; does nothing for any chat that is not a
 * customer's account chat.
 */
export async function tellOfReply(tx: Database, ctx: ServiceContext, conversation: Conversation, now = new Date()): Promise<void> {
  if (conversation.internalAddress !== "portal") return;
  try {
    await tx.transaction(async (savepoint) => {
      await attempt(savepoint as unknown as Database, ctx, conversation, now, "reply");
    });
  } catch (error) {
    /** The reply stands. What went wrong is on the chat, in words, for whoever opens it. */
    await tx.update(schema.aiChatSession).set({
      customerNotice: `Not told: ${error instanceof Error ? error.message : "something went wrong"}`.slice(0, 500),
      updatedAt: now,
    }).where(eq(schema.aiChatSession.conversationId, conversation.id));
  }
}

/** A notice held longer than this is dropped rather than sent: an answer that old is not news. */
export const HELD_LONGEST_HOURS = 48;

type Outcome = "told" | "held" | "not_told" | "waiting" | "nothing";

/** How many answers from the office the customer has not seen, as of the last time they had the chat open. */
export async function unreadAnswers(tx: Database, conversationId: string, readAt: Date | null): Promise<number> {
  const [row] = await tx.select({ unread: sql<number>`count(*)::int` }).from(schema.message)
    .where(and(
      eq(schema.message.conversationId, conversationId),
      eq(schema.message.direction, "outbound"),
      isNotNull(schema.message.sentByUserId),
      readAt ? gt(schema.message.createdAt, readAt) : undefined,
    ));
  return row?.unread ?? 0;
}

/**
 * One try at telling the customer.
 *
 * `reply` is a person's answer being written; `release` is the worker coming
 * back to a notice that quiet hours held. Both go through the same gates and
 * the same send: release only asks first whether the notice is still wanted.
 */
async function attempt(
  tx: Database, ctx: ServiceContext, conversation: Conversation, now: Date, mode: "reply" | "release",
): Promise<Outcome> {
  /** Locked, so two replies written at the same moment are one notice. */
  const [chat] = await tx.select().from(schema.aiChatSession)
    .where(eq(schema.aiChatSession.conversationId, conversation.id)).limit(1).for("update");
  if (!chat || chat.channel !== "portal") return "nothing";

  /**
   * Whatever the outcome, a notice no longer waits unless this try is the one
   * that holds it again.
   */
  const record = async (notice: string, told: boolean, hold = false): Promise<Outcome> => {
    await tx.update(schema.aiChatSession).set({
      customerNotice: notice.slice(0, 500),
      ...(told ? { customerNotifiedAt: now } : {}),
      customerNoticeHeldAt: hold ? now : null,
      updatedAt: now,
    }).where(eq(schema.aiChatSession.id, chat.id));
    await audit(tx, ctx, "portal.chat_reply_noticed", "conversation", conversation.id, null, {
      told, held: hold, notice, ...(mode === "release" ? { released: true } : {}),
    });
    return told ? "told" : hold ? "held" : "not_told";
  };

  if (mode === "release") {
    if (!chat.customerNoticeHeldAt) return "nothing";
    if (now.getTime() - chat.customerNoticeHeldAt.getTime() > HELD_LONGEST_HOURS * 3_600_000) {
      return record("Not told: your quiet hours ended more than two days after the answer, which is too late for a notice to help.", false);
    }
    if (chat.status === "closed" && !chat.officeClosedAt) return record("Not told: the customer closed the chat.", false);
    /** Closed by a person after answering: the link still shows them the answer, so they are told. Closed for going quiet: that answer is old news. */
    if (chat.status === "closed" && chat.officeCloseKind === "idle") return record("Not told: the chat was closed because it went quiet.", false);
    if (await unreadAnswers(tx, conversation.id, chat.customerReadAt) === 0) {
      return record("Not told: they read the chat before your quiet hours ended.", false);
    }
    const quiet = await quietHoursFor(tx, conversation.organizationId, now);
    if (quiet.window && comms.inQuietHours(quiet.localHour, quiet.window)) return "waiting";
  }

  const settings = await settingsWithin(tx, conversation.organizationId);
  if (!settings.chatReplyNotice) return record("Not told: reply notices are turned off in your customer portal settings.", false);

  /** Told once, until they have read it. */
  if (chat.customerNotifiedAt && !(chat.customerReadAt && chat.customerReadAt >= chat.customerNotifiedAt)) {
    /** Whoever told them since has already done what a held notice was waiting to do. */
    if (chat.customerNoticeHeldAt) {
      await tx.update(schema.aiChatSession).set({ customerNoticeHeldAt: null, updatedAt: now })
        .where(eq(schema.aiChatSession.id, chat.id));
    }
    return "nothing";
  }

  if (chat.customerReadAt && now.getTime() - chat.customerReadAt.getTime() < PRESENT_SECONDS * 1000) {
    return record("Not told: they had the chat open and see the answer there.", false);
  }

  const who = await recipientOf(tx, conversation);
  if (!who) return record("Not told: the customer is no longer on file.", false);

  const [org] = await tx.select({ name: schema.organization.name, slug: schema.organization.slug })
    .from(schema.organization).where(eq(schema.organization.id, conversation.organizationId)).limit(1);
  const words = cp.chatReplyMessage({
    companyName: org?.name ?? "",
    customerName: who.name,
    url: `${portalBase()}/portal/${encodeURIComponent(org?.slug ?? "")}/account/chat`,
  });

  /** Whether a text was stopped by quiet hours, which is the one reason a notice waits. */
  let quietStopped = false;
  const byText = async (): Promise<{ sent: boolean; why: string }> => {
    if (!who.phone) return { sent: false, why: "no mobile number to text." };
    const quiet = await quietHoursFor(tx, conversation.organizationId, now);
    if (quiet.window && comms.inQuietHours(quiet.localHour, quiet.window)) {
      quietStopped = true;
      return { sent: false, why: "it is inside your quiet hours, so no text went." };
    }
    const sent = await sendTransactional(tx, {
      organizationId: conversation.organizationId, address: who.phone, body: words.text,
      customerId: conversation.customerId,
    });
    return sent.sent ? { sent: true, why: "" } : { sent: false, why: sent.explanation };
  };
  const byEmail = async (): Promise<{ sent: boolean; why: string }> => {
    if (!who.email) return { sent: false, why: "no email address to write to." };
    const sent = await email.queueIn(tx, ctx, {
      to: who.email, subject: words.subject, text: words.email, customerId: conversation.customerId,
      purpose: "transactional",
    });
    return sent.queued ? { sent: true, why: "" } : { sent: false, why: sent.explanation };
  };

  const order = who.prefersText
    ? [["text", byText], ["email", byEmail]] as const
    : [["email", byEmail], ["text", byText]] as const;
  const missed: string[] = [];
  for (const [name, send] of order) {
    const outcome = await send();
    if (outcome.sent) {
      return record(`Told by ${name}${missed.length > 0 ? ` (${missed.join(" ")})` : ""}.`, true);
    }
    missed.push(`Not ${name === "text" ? "texted" : "emailed"}: ${outcome.why}`);
  }
  /**
   * Nobody could be told, and a text was stopped only by the hours: wait for
   * them to end. Anything else (no number, a STOP, no connection) will not be
   * different later, so it is not kept.
   */
  if (quietStopped && who.phone) {
    return record(`Waiting for your quiet hours to end. ${missed.join(" ")} The text goes then, unless they read the chat first.`, false, true);
  }
  return record(`Not told. ${missed.join(" ")}`, false);
}

/* ------------------------------------------------- when quiet hours end */

/** What the worker acts as here: it reads and writes chats and sends notices, and nothing else. */
function workerActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: ["message:send"], agentId: "portal-chat-notice" };
}

export interface ReleaseResult {
  organizationId: string;
  /** Told, now that the hours ended. */
  told: number;
  /** Dropped: read meanwhile, closed, switched off, too old, or no way to reach them now. */
  dropped: number;
  /** Still inside the quiet hours, kept for a later pass. */
  waiting: number;
  error: string | null;
}

/**
 * Send this company's held notices whose quiet hours have ended.
 *
 * Each notice is its own savepoint: one customer's failure is written on their
 * chat and the rest go on. A notice that cannot be sent for a reason that will
 * not change (no number, a STOP) is dropped with the reason on the chat, not
 * retried every pass.
 */
export async function releaseFor(
  db: Database, organizationId: string, options: { now?: Date; limit?: number } = {},
): Promise<ReleaseResult> {
  const now = options.now ?? new Date();
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  const result: ReleaseResult = { organizationId, told: 0, dropped: 0, waiting: 0, error: null };
  const held = await inTenant(ctx, (tx) => tx.select({ conversationId: schema.aiChatSession.conversationId })
    .from(schema.aiChatSession)
    .where(and(eq(schema.aiChatSession.organizationId, organizationId), isNotNull(schema.aiChatSession.customerNoticeHeldAt)))
    .orderBy(asc(schema.aiChatSession.customerNoticeHeldAt))
    .limit(options.limit ?? 50));
  for (const { conversationId } of held) {
    try {
      const outcome = await inTenant(ctx, async (tx) => {
        const [conversation] = await tx.select().from(schema.conversation)
          .where(eq(schema.conversation.id, conversationId)).limit(1);
        return conversation ? attempt(tx, ctx, conversation, now, "release") : "nothing" as const;
      });
      if (outcome === "told") result.told += 1;
      else if (outcome === "waiting" || outcome === "held") result.waiting += 1;
      else result.dropped += 1;
    } catch (error) {
      /** Written where the office reads it; the notice is dropped rather than tried again every pass. */
      await inTenant(ctx, (tx) => tx.update(schema.aiChatSession).set({
        customerNotice: `Not told: ${error instanceof Error ? error.message : "something went wrong"}`.slice(0, 500),
        customerNoticeHeldAt: null, updatedAt: now,
      }).where(eq(schema.aiChatSession.conversationId, conversationId)));
      result.dropped += 1;
      result.error = (error as Error).message;
    }
  }
  return result;
}

/** When this process last looked, so the worker's few second loop does not ask every few seconds. */
let lastPass: number | null = null;

/**
 * The worker's pass over every company holding a notice that quiet hours
 * stopped. Once a minute at most per process: a window that ends on the hour
 * gains nothing from being looked at every five seconds. One company's failure
 * is kept to that company.
 */
export async function releasePass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean; force?: boolean } = {},
): Promise<ReleaseResult[]> {
  const at = (options.now ?? new Date()).getTime();
  if (!options.force && lastPass !== null && at - lastPass < 60_000 && at >= lastPass) return [];
  lastPass = at;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.held_chat_notice_organizations(${options.limit ?? 200})`,
  );
  const results: ReleaseResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    try {
      results.push(await releaseFor(db, row.organization_id, options.now ? { now: options.now } : {}));
    } catch (error) {
      results.push({ organizationId: row.organization_id, told: 0, dropped: 0, waiting: 0, error: (error as Error).message });
    }
  }
  return results;
}
