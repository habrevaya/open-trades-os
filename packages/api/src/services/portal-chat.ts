import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { customerPortal as cp } from "@opentradesos/core";
import { ConflictError, NotFoundError, inTenant, type RequestMeta } from "./context";
import * as base from "./agents";
import { chatReader, chatTranscript, disclosure, handOff, inbound, answerChat } from "./agent-chat";
import { companyOf } from "./agent-facts";
import { sessionFor, type PortalSession } from "./portal-sign-in";
import { throttle } from "./website-tracking";
import { attach, bytesOf, decode, put } from "./files";
import { files } from "@opentradesos/core";
import { countUpload } from "./portal-files";
import { unreadAnswers } from "./portal-chat-notice";
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
 *
 * PICTURES, up to three in a message, from the customer and from the office.
 * The customer's are held to the customer upload rules and the same twenty an
 * hour as a file added to a job (`checkChatPicture` in core), and a message with
 * one goes to a person: the assistant cannot see a picture, so it does not
 * answer one. The office's go through the inbox's reply, kept as stored files.
 * Neither is ever served by its storage key: the page asks for message and
 * position, and the message has to be in the customer's own conversation.
 *
 * WHAT THE CUSTOMER HAS SEEN. Opening the chat, or writing in it, marks it
 * read (`customer_read_at`). A reply from the office newer than that is an
 * unread one: the account page marks it, and the notice that tells the
 * customer is sent once until they read it (`portal-chat-notice.ts`).
 */

const LIMITS = { perMinute: 12, perHour: 60 } as const;

export interface PortalChatView {
  /** Whether the automated assistant answers here, so the page can say who will answer. */
  assistant: boolean;
  /** Null before the customer has written anything. */
  status: "open" | "handed_off" | "closed" | null;
  bookingTaken: boolean;
  messages: {
    id: string; from: "visitor" | "assistant" | "person"; text: string; at: string;
    /** Pictures that came with the message, by position, for the page to ask for. */
    pictures: PortalChatPicture[];
  }[];
}

export interface PortalChatPicture {
  index: number;
  contentType: string;
  name: string | null;
  /** A browser can draw it. A phone's HEIC is kept and offered to open instead. */
  shown: boolean;
}

/** What a customer's own pictures in the chat are filed as, to count what one has sent today. */
export const CHAT_PICTURE_KIND = "chat_picture";

/** The pictures on these messages, by position, for the view. Nothing refused or not kept. */
async function picturesOf(tx: Database, ids: string[]): Promise<Map<string, PortalChatPicture[]>> {
  const found = new Map<string, PortalChatPicture[]>();
  if (ids.length === 0) return found;
  const rows = await tx.select({ id: schema.message.id, media: schema.message.media }).from(schema.message)
    .where(and(inArray(schema.message.id, ids), sql`jsonb_array_length(${schema.message.media}) > 0`));
  for (const row of rows) {
    found.set(row.id, row.media.flatMap((item, index) => item.storageKey
      ? [{
        index, contentType: item.contentType, name: item.name ?? null,
        shown: cp.CHAT_PICTURES.shownInPage.includes(item.contentType),
      }]
      : []));
  }
  return found;
}

/** The transcript the page shows: the shared one, with each message's pictures. */
async function viewOf(tx: Database, chat: typeof schema.aiChatSession.$inferSelect, after?: string | undefined) {
  const transcript = await chatTranscript(tx, chat, after);
  const pictures = await picturesOf(tx, transcript.messages.map((m) => m.id));
  return { ...transcript, messages: transcript.messages.map((m) => ({ ...m, pictures: pictures.get(m.id) ?? [] })) };
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

/**
 * The customer's chat as they see it, or an empty one before they have written.
 *
 * Asking for it is reading it: the chat is marked read as of the moment the
 * transcript was taken (the database's clock, the one the messages carry), so a
 * reply written a moment later is still unread.
 */
export async function read(db: Database, input: { token: string; after?: string | undefined }): Promise<PortalChatView> {
  const session = await sessionFor(db, input.token);
  const organizationId = session.grant.organizationId;
  return inTenant(chatReader(db, organizationId), async (tx) => {
    const assistant = await assistantOn(tx, organizationId);
    const found = await find(tx, session);
    if (!found) return { assistant, status: null, bookingTaken: false, messages: [] };
    await tx.update(schema.aiChatSession).set({ customerReadAt: sql`now()` })
      .where(eq(schema.aiChatSession.id, found.chat.id));
    return { assistant, ...(await viewOf(tx, found.chat, input.after)) };
  });
}

/**
 * How many answers from the office the customer has not seen, for the mark on
 * their account page. Asking does not mark anything read.
 */
export async function unreadReplies(db: Database, input: { token: string }): Promise<{ unread: number }> {
  const session = await sessionFor(db, input.token);
  return inTenant(chatReader(db, session.grant.organizationId), async (tx) => {
    const found = await find(tx, session);
    if (!found) return { unread: 0 };
    return { unread: await unreadAnswers(tx, found.conversation.id, found.chat.customerReadAt) };
  });
}

/**
 * One picture from the customer's own chat, for their page: by the message and
 * its position, and only a message in the conversation this sign in names. A
 * message of another customer's, a position with nothing kept and a made up id
 * are the same not found.
 */
export async function picture(
  db: Database, input: { token: string; messageId: string; index: number },
): Promise<{ bytes: Buffer; contentType: string; name: string | null }> {
  const session = await sessionFor(db, input.token);
  return inTenant(chatReader(db, session.grant.organizationId), async (tx) => {
    const found = await find(tx, session);
    if (!found) throw new NotFoundError("Picture");
    const [message] = await tx.select({ media: schema.message.media }).from(schema.message)
      .where(and(eq(schema.message.id, input.messageId), eq(schema.message.conversationId, found.conversation.id)))
      .limit(1);
    const item = message?.media[input.index];
    if (!item?.storageKey) throw new NotFoundError("Picture");
    const [file] = await tx.select().from(schema.storedFile)
      .where(and(
        eq(schema.storedFile.organizationId, session.grant.organizationId),
        eq(schema.storedFile.storageKey, item.storageKey),
        isNull(schema.storedFile.deletedAt),
      )).limit(1);
    if (!file) throw new NotFoundError("Picture");
    return { bytes: await bytesOf(file), contentType: file.contentType, name: item.name ?? null };
  });
}

/**
 * The customer's message, and the assistant's answer when it answers here.
 *
 * The message is written first, in its own transaction, so it is in the inbox
 * whatever happens to the answer.
 */
export async function say(
  db: Database, input: { token: string; text: string; pictures?: readonly PortalChatPictureInput[] | undefined },
  meta?: RequestMeta, deps: AiDeps = base.DEFAULT_AGENT_DEPS,
): Promise<PortalChatView> {
  const session = await sessionFor(db, input.token);
  const organizationId = session.grant.organizationId;
  await throttle(db, `portal-chat:${organizationId}:${session.customerId}`, LIMITS.perMinute);
  await throttle(db, `portal-chat-hour:${organizationId}:${session.customerId}`, LIMITS.perHour, 3600);
  const text = input.text.trim();
  const sent = input.pictures ?? [];
  if (text === "" && sent.length === 0) throw new ConflictError("Type a message or choose a picture first.");
  /**
   * Counted before anything is looked at, one for each picture, against the
   * hour a file added to a job counts against, so a refused picture counts too.
   */
  for (let i = 0; i < sent.length; i += 1) await countUpload(db, organizationId, session.customerId);
  const pictures = sent.map((p) => ({ fileName: p.fileName, contentType: p.contentType, bytes: decode(p.bytes) }));

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
      if (seen) return { chatId: found.chat.id, next: "nothing" as const, reason: "" };
      await tx.insert(schema.integrationEvent).values({
        organizationId, direction: "inbound", provider: "webchat", eventType: "chat.message",
        idempotencyKey: key, status: "succeeded", entityType: "ai_chat_session", entityId: found.chat.id,
      });
    }

    /**
     * The pictures are checked before the message is written, one after the
     * other against what is left of the message and of the day, and any one
     * refused refuses the whole message: nothing is half sent, and what the
     * customer typed stays on their screen.
     */
    const kept: { url: string; contentType: string; bytes: number; storageKey: string; name: string }[] = [];
    if (pictures.length > 0) {
      const [today] = await tx.select({ total: sql<string>`coalesce(sum(${schema.attachment.sizeBytes}), 0)::text` })
        .from(schema.attachment)
        .where(and(
          eq(schema.attachment.kind, CHAT_PICTURE_KIND),
          eq(schema.attachment.uploadedByCustomerId, session.customerId),
          isNull(schema.attachment.deletedAt),
          gt(schema.attachment.createdAt, sql`now() - interval '1 day'`),
        ));
      let bytesToday = Number(today?.total ?? 0);
      let bytesInMessage = 0;
      for (const picture of pictures) {
        const verdict = cp.checkChatPicture(picture, { filesInMessage: kept.length, bytesInMessage, bytesToday });
        if (!verdict.ok) throw new ConflictError(verdict.reason);
        const { file } = await put(tx, organizationId, { bytes: picture.bytes, claimedType: picture.contentType, maxBytes: cp.CHAT_PICTURES.maxMessageBytes });
        kept.push({
          url: "", contentType: file.contentType, bytes: file.sizeBytes, storageKey: file.storageKey,
          name: files.downloadName(picture.fileName, verdict.extension),
        });
        bytesInMessage += picture.bytes.length;
        bytesToday += picture.bytes.length;
      }
    }

    const wasUnread = found.conversation.unreadCount > 0;
    const messageId = await inbound(tx, organizationId, found.chat, text, kept);
    for (const picture of kept) {
      await attach(tx, organizationId, {
        entityType: "message", entityId: messageId, storageKey: picture.storageKey, kind: CHAT_PICTURE_KIND,
        fileName: picture.name, contentType: picture.contentType, sizeBytes: picture.bytes,
        uploadedByUserId: null, uploadedByCustomerId: session.customerId, uploadedByContactId: session.contact?.id ?? null,
      });
    }
    if (found.chat.status === "handed_off" && !wasUnread) {
      const who = session.contact ? `${session.contact.name} (for ${session.customerName})` : session.customerName;
      await tx.insert(schema.task).values({
        organizationId,
        title: `${who} wrote from their account`,
        body: `${(text || "A picture").slice(0, 500)}\n\nOpen the conversation in the inbox to answer.`,
        priority: "high",
        entityType: "conversation",
        entityId: found.conversation.id,
      });
    }
    if (found.chat.status !== "open") return { chatId: found.chat.id, next: "nothing" as const, reason: "" };
    /** The assistant cannot see a picture, so it does not answer a message that has one. */
    if (kept.length > 0) {
      return { chatId: found.chat.id, next: "hand_off" as const, reason: "The customer sent a picture, which the assistant cannot see." };
    }
    return assistant
      ? { chatId: found.chat.id, next: "answer" as const, reason: "" }
      : { chatId: found.chat.id, next: "hand_off" as const, reason: "The assistant was turned off for customer accounts." };
  });

  if (outcome.next === "answer") await answerChat(db, organizationId, outcome.chatId, deps);
  if (outcome.next === "hand_off") {
    /** A person has it now: the assistant was turned off for accounts after this chat began, or the message has a picture. */
    await inTenant(chatReader(db, organizationId), async (tx) => {
      const [chat] = await tx.select().from(schema.aiChatSession).where(eq(schema.aiChatSession.id, outcome.chatId)).limit(1);
      if (chat) await handOff(tx, organizationId, chat, outcome.reason);
    });
  }
  return read(db, { token: input.token });
}

/** A picture as the customer sent it. The name and type are the browser's word; what it is comes from the bytes. */
export interface PortalChatPictureInput {
  fileName: string;
  contentType?: string | undefined;
  /** Base64, as every other upload in the product takes it. */
  bytes: string;
}

export const handlers = {
  getPortalChat: (db: Database, input: { token: string; after?: string | undefined }) => read(db, input),
  sayInPortalChat: (
    db: Database, input: { token: string; text: string; pictures?: readonly PortalChatPictureInput[] | undefined },
    meta?: RequestMeta,
  ) => say(db, input, meta),
  getPortalChatUnread: (db: Database, input: { token: string }) => unreadReplies(db, input),
  getPortalChatPicture: async (db: Database, input: { token: string; messageId: string; index: number }) => {
    const found = await picture(db, input);
    return { contentType: found.contentType, fileName: found.name, bytes: found.bytes.toString("base64") };
  },
} as const;
