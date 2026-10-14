import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ConflictError, inTenant, type RequestMeta } from "./context";
import * as base from "./agents";
import { chatReader, chatTranscript, disclosure, handOff, inbound, answerChat } from "./agent-chat";
import { companyOf } from "./agent-facts";
import { sessionFor, type PortalSession } from "./portal-sign-in";
import { throttle } from "./website-tracking";
import type { AiDeps } from "./ai";

/**
 * A SIGNED IN CUSTOMER CHATTING WITH THE COMPANY FROM THEIR ACCOUNT (M05, M27)
 *
 * The same conversation the office answers in the inbox: a chat conversation
 * on the customer's record, read and answered there like a website chat, with
 * the office's reply reaching the customer's open page.
 *
 * WHO IS WRITING IS THE SIGN IN, NEVER WHAT IS TYPED. The conversation is made
 * on the customer the sign in names (and the contact, when a contact signed in
 * as them), so nobody types a name and nothing is matched by a phone number or
 * guessed from the words. One conversation per customer, or per contact signed
 * in as them, kept and carried on each time they come back.
 *
 * THE ASSISTANT ANSWERS ONLY WHERE THE COMPANY SAID SO, with its own switch
 * ("Customers signed in to their account" on the chat assistant's settings),
 * off until somebody turns it on, and only while the chat assistant itself is
 * on with a person to act as, exactly as on the website. It opens by saying it
 * is automated, it hands over on the same rules, and once a person has the
 * conversation it stays out of it for good: a customer who comes back next
 * month is answered by the office. With the assistant off, every message goes
 * straight to the office: unread in the inbox, and a task when the
 * conversation goes from read to unread, so it is noticed once rather than
 * once a message.
 *
 * Throttled per customer, twelve a minute and sixty an hour, because a sign in
 * on a phone left in a pocket should not be able to fill the inbox.
 */

const LIMITS = { perMinute: 12, perHour: 60 } as const;

export interface PortalChatView {
  /** Whether the automated assistant answers here, so the page can say who will answer. */
  assistant: boolean;
  /** Null before the customer has written anything. */
  status: "open" | "handed_off" | "closed" | null;
  bookingTaken: boolean;
  messages: { id: string; from: "visitor" | "assistant" | "person"; text: string; at: string }[];
}

/** The address a customer's account chat is kept under: their own, or the contact's signed in as them. */
const addressOf = (session: PortalSession) =>
  session.contact ? `portal:${session.customerId}:${session.contact.id}` : `portal:${session.customerId}`;

async function assistantOn(tx: Database, organizationId: string): Promise<boolean> {
  const settings = await base.settingWithin(tx, organizationId, "chat");
  return settings.enabled && settings.chat.portal && settings.runAsUserId !== null;
}

async function find(tx: Database, session: PortalSession) {
  const [row] = await tx.select({ conversation: schema.conversation, chat: schema.aiChatSession })
    .from(schema.conversation)
    .innerJoin(schema.aiChatSession, eq(schema.aiChatSession.conversationId, schema.conversation.id))
    .where(and(
      eq(schema.conversation.channel, "webchat"),
      eq(schema.conversation.externalAddress, addressOf(session)),
      eq(schema.conversation.customerId, session.customerId),
      isNull(schema.conversation.deletedAt),
      eq(schema.aiChatSession.channel, "portal"),
    ))
    .orderBy(desc(schema.conversation.createdAt))
    .limit(1);
  return row ?? null;
}

/** The customer's chat as they see it, or an empty one before they have written. */
export async function read(db: Database, input: { token: string; after?: string | undefined }): Promise<PortalChatView> {
  const session = await sessionFor(db, input.token);
  const organizationId = session.grant.organizationId;
  return inTenant(chatReader(db, organizationId), async (tx) => {
    const assistant = await assistantOn(tx, organizationId);
    const found = await find(tx, session);
    if (!found) return { assistant, status: null, bookingTaken: false, messages: [] };
    return { assistant, ...(await chatTranscript(tx, found.chat, input.after)) };
  });
}

/**
 * The customer's message, and the assistant's answer when it answers here.
 *
 * The message is written first, in its own transaction, so it is in the inbox
 * whatever happens to the answer.
 */
export async function say(
  db: Database, input: { token: string; text: string }, meta?: RequestMeta, deps: AiDeps = base.DEFAULT_AGENT_DEPS,
): Promise<PortalChatView> {
  const session = await sessionFor(db, input.token);
  const organizationId = session.grant.organizationId;
  await throttle(db, `portal-chat:${organizationId}:${session.customerId}`, LIMITS.perMinute);
  await throttle(db, `portal-chat-hour:${organizationId}:${session.customerId}`, LIMITS.perHour, 3600);
  const text = input.text.trim();
  if (text === "") throw new ConflictError("Type a message first.");

  const outcome = await inTenant(chatReader(db, organizationId), async (tx) => {
    const assistant = await assistantOn(tx, organizationId);
    let found = await find(tx, session);
    if (!found) {
      const company = await companyOf(tx, organizationId, new Date());
      const settings = await base.settingWithin(tx, organizationId, "chat");
      const [conversation] = await tx.insert(schema.conversation).values({
        organizationId,
        channel: "webchat",
        externalAddress: addressOf(session),
        internalAddress: "portal",
        subject: "Chat from their account",
        customerId: session.customerId,
        contactId: session.contact?.id ?? null,
        status: "open",
        lastMessageAt: new Date(),
      }).returning();
      const [chat] = await tx.insert(schema.aiChatSession).values({
        organizationId,
        conversationId: conversation!.id,
        channel: "portal",
        ...(assistant
          ? {}
          : { status: "handed_off" as const, handedOffAt: new Date(), handoffReason: "The assistant does not answer in customer accounts, so a person answers." }),
      }).returning();
      if (assistant) {
        /**
         * One after the other, a millisecond apart and just before this
         * transaction's own clock, which the customer's first message is
         * written at, so the disclosure is always read first.
         */
        const [clock] = await tx.execute<{ at: string }>(sql`select now()::text as at`);
        const opened = new Date(clock!.at).getTime() - 2;
        await tx.insert(schema.message).values([disclosure(company.name), settings.chat.greeting].map((body, index) => ({
          organizationId, conversationId: conversation!.id,
          direction: "outbound" as const, channel: "webchat" as const, purpose: "transactional" as const,
          fromAddress: "portal", toAddress: conversation!.externalAddress, body, status: "sent" as const,
          createdAt: new Date(opened + index),
        })));
      }
      found = { conversation: conversation!, chat: chat! };
    }

    if (meta?.idempotencyKey) {
      /** A double tap on Send is one message, and one answer. */
      const key = `portal-chat:${found.chat.id}:${meta.idempotencyKey.slice(0, 100)}`;
      const [seen] = await tx.select({ id: schema.integrationEvent.id }).from(schema.integrationEvent)
        .where(and(eq(schema.integrationEvent.provider, "webchat"), eq(schema.integrationEvent.idempotencyKey, key)))
        .limit(1);
      if (seen) return { chatId: found.chat.id, next: "nothing" as const };
      await tx.insert(schema.integrationEvent).values({
        organizationId, direction: "inbound", provider: "webchat", eventType: "chat.message",
        idempotencyKey: key, status: "succeeded", entityType: "ai_chat_session", entityId: found.chat.id,
      });
    }

    const wasUnread = found.conversation.unreadCount > 0;
    await inbound(tx, organizationId, found.chat, text);
    if (found.chat.status === "handed_off" && !wasUnread) {
      const who = session.contact ? `${session.contact.name} (for ${session.customerName})` : session.customerName;
      await tx.insert(schema.task).values({
        organizationId,
        title: `${who} wrote from their account`,
        body: `${text.slice(0, 500)}\n\nOpen the conversation in the inbox to answer.`,
        priority: "high",
        entityType: "conversation",
        entityId: found.conversation.id,
      });
    }
    if (found.chat.status !== "open") return { chatId: found.chat.id, next: "nothing" as const };
    return { chatId: found.chat.id, next: assistant ? "answer" as const : "hand_off" as const };
  });

  if (outcome.next === "answer") await answerChat(db, organizationId, outcome.chatId, deps);
  if (outcome.next === "hand_off") {
    /** The assistant was turned off for accounts after this chat began: a person has it now. */
    await inTenant(chatReader(db, organizationId), async (tx) => {
      const [chat] = await tx.select().from(schema.aiChatSession).where(eq(schema.aiChatSession.id, outcome.chatId)).limit(1);
      if (chat) await handOff(tx, organizationId, chat, "The assistant was turned off for customer accounts.");
    });
  }
  return read(db, { token: input.token });
}

export const handlers = {
  getPortalChat: (db: Database, input: { token: string; after?: string | undefined }) => read(db, input),
  sayInPortalChat: (db: Database, input: { token: string; text: string }, meta?: RequestMeta) => say(db, input, meta),
} as const;
