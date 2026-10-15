import { eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { comms, customerPortal as cp } from "@opentradesos/core";
import { audit, type ServiceContext } from "./context";
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
 * NEVER AN ERROR FOR THE PERSON REPLYING. Whatever happens to the notice, the
 * reply is sent: a failure is written on the chat (`customer_notice`) in words,
 * where the inbox shows it, and the customer's account page still marks the
 * unread reply. A notice that could not go is not retried by itself; the next
 * reply tries again.
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
      await attempt(savepoint as unknown as Database, ctx, conversation, now);
    });
  } catch (error) {
    /** The reply stands. What went wrong is on the chat, in words, for whoever opens it. */
    await tx.update(schema.aiChatSession).set({
      customerNotice: `Not told: ${error instanceof Error ? error.message : "something went wrong"}`.slice(0, 500),
      updatedAt: now,
    }).where(eq(schema.aiChatSession.conversationId, conversation.id));
  }
}

async function attempt(tx: Database, ctx: ServiceContext, conversation: Conversation, now: Date): Promise<void> {
  /** Locked, so two replies written at the same moment are one notice. */
  const [chat] = await tx.select().from(schema.aiChatSession)
    .where(eq(schema.aiChatSession.conversationId, conversation.id)).limit(1).for("update");
  if (!chat || chat.channel !== "portal") return;

  const record = async (notice: string, told: boolean) => {
    await tx.update(schema.aiChatSession).set({
      customerNotice: notice.slice(0, 500),
      ...(told ? { customerNotifiedAt: now } : {}),
      updatedAt: now,
    }).where(eq(schema.aiChatSession.id, chat.id));
    await audit(tx, ctx, "portal.chat_reply_noticed", "conversation", conversation.id, null, { told, notice });
  };

  const settings = await settingsWithin(tx, conversation.organizationId);
  if (!settings.chatReplyNotice) return record("Not told: reply notices are turned off in your customer portal settings.", false);

  /** Told once, until they have read it. */
  if (chat.customerNotifiedAt && !(chat.customerReadAt && chat.customerReadAt >= chat.customerNotifiedAt)) return;

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

  const byText = async (): Promise<{ sent: boolean; why: string }> => {
    if (!who.phone) return { sent: false, why: "no mobile number to text." };
    const quiet = await quietHoursFor(tx, conversation.organizationId, now);
    if (quiet.window && comms.inQuietHours(quiet.localHour, quiet.window)) {
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
  return record(`Not told. ${missed.join(" ")}`, false);
}
