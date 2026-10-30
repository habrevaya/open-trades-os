import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { customerPortal as cp, SYSTEM_USER_ID, time, type Actor } from "@opentradesos/core";
import {
  ConflictError, NotFoundError, audit, inTenant, timezoneOf, type RequestMeta, type ServiceContext,
} from "./context";
import { close as closeAnyConversation } from "./conversation-close";
import { settingsWithin } from "./portal-settings";
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
 * THE CUSTOMER CAN CLOSE THEIR CHAT. Closing ends that conversation: the inbox
 * shows it as closed and says the customer closed it (`customer_closed_at`),
 * the office can no longer reply into it (a reply would have nowhere to go),
 * and the next thing the customer writes opens a new conversation. Closing
 * hides nothing from the office: what they wrote stays unread, with its task,
 * until a person opens it, because a customer who writes "the furnace is out"
 * and closes the page must not drop out of the office's sight. The customer's
 * page starts empty again, and the old conversation is theirs no more to read.
 *
 * THE OFFICE CAN CLOSE IT TOO, and so can a rule. "Close this chat" in the inbox
 * (`closeFromOffice`) ends the conversation the same way, but the customer's page
 * says the company closed it and keeps showing them what was said, because an
 * answer they have not yet seen must not vanish with the close. The company can
 * also choose a number of quiet days (`chatIdleCloseDays` in the portal settings,
 * off until chosen): the worker then closes a chat the company wrote last in and
 * the customer has not written to for that long (`idleClosePass`). A chat the
 * customer wrote last in is never closed that way, because a customer waiting on
 * an answer is not an idle one. Neither tells the customer by text or email; they
 * see it the next time they open the chat. A chat has one closer.
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
  /**
   * Who closed it, when it is closed: the customer (the page is empty), or the
   * company (a person, or the quiet chat rule), in which case the page still
   * shows what was said and says the company closed it.
   */
  closedBy?: "customer" | "office" | "idle" | null;
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
    /** A chat the customer closed shows as closed and empty until they write again. */
    if (found.chat.status === "closed" && !found.chat.officeClosedAt) {
      return { assistant, status: "closed" as const, closedBy: "customer" as const, bookingTaken: false, messages: [] };
    }
    /**
     * A chat the company closed still shows what was said, and is read as it is
     * opened: the answer that came just before the close is the one they have
     * not seen yet.
     */
    await tx.update(schema.aiChatSession).set({ customerReadAt: sql`now()` })
      .where(eq(schema.aiChatSession.id, found.chat.id));
    return {
      assistant,
      ...(found.chat.status === "closed" ? { closedBy: found.chat.officeCloseKind ?? "office" } : {}),
      ...(await viewOf(tx, found.chat, input.after)),
    };
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
    /** A chat that was closed stays closed: what they write now opens a new conversation. */
    if (found?.chat.status === "closed") found = null;
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

/**
 * The customer closes their chat.
 *
 * Ends the conversation they have open, whoever has it (the assistant or a
 * person), and says so to the office: the conversation is closed in the inbox,
 * `customer_closed_at` is when, and the audit line names the sign in (and the
 * contact, when a contact signed in as the customer). Nothing the office has not
 * read is marked read, and no task is closed. A notice that quiet hours were
 * holding is dropped, because there is nothing left to tell them about.
 *
 * Closing a chat that is already closed, or before one was started, changes
 * nothing, so a double tap and a retry are the same close.
 */
export async function close(
  db: Database, input: { token: string },
): Promise<PortalChatView> {
  const session = await sessionFor(db, input.token);
  const organizationId = session.grant.organizationId;
  await throttle(db, `portal-chat-close:${organizationId}:${session.customerId}`, LIMITS.perMinute);
  await inTenant(chatReader(db, organizationId), async (tx) => {
    const found = await find(tx, session);
    if (!found || found.chat.status === "closed") return;
    const now = new Date();
    const wasHeld = found.chat.customerNoticeHeldAt !== null;
    await tx.update(schema.aiChatSession).set({
      status: "closed",
      customerClosedAt: now,
      /** Closing is the last thing they did in it, so the office's answers up to now are not owed a notice. */
      customerReadAt: now,
      writing: null,
      customerNoticeHeldAt: null,
      ...(wasHeld ? { customerNotice: "Not told: the customer closed the chat." } : {}),
      updatedAt: now,
    }).where(eq(schema.aiChatSession.id, found.chat.id));
    await tx.update(schema.conversation).set({ status: "closed", updatedAt: now })
      .where(eq(schema.conversation.id, found.conversation.id));
    await audit(tx, {
      ...chatReader(db, organizationId), portalGrantId: session.grant.grantId, portalContactId: session.contact?.id ?? null,
    }, "portal.chat_closed", "conversation", found.conversation.id, { status: found.chat.status }, { status: "closed" });
  });
  return read(db, input);
}

/**
 * A person in the office closes a conversation: since the inbox could close
 * any kind, this is `conversation-close.ts`'s close, kept under the name the
 * account chat's callers have always used. A chat from a customer's account
 * keeps its audit line (`portal.chat_closed_by_office`), the customer's page
 * says in words that the company closed it, and nothing the office has not
 * read is marked read.
 */
export function closeFromOffice(ctx: ServiceContext, input: { id: string }) {
  return closeAnyConversation(ctx, input);
}

/* ------------------------------------------------------ chats gone quiet */

/** What the worker acts as here: it closes chats and writes the audit line, and nothing else. */
function idleActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "portal-chat-idle" };
}

/** The most one pass closes for one company; the rest wait for the next pass. */
const IDLE_CLOSES_PER_PASS = 200;

/**
 * Close this company's account chats that have gone quiet, as of `now`.
 *
 * Only when the company chose a number of days. A chat is quiet when the last
 * thing in it is the company's (the assistant's or a person's) and that was
 * written at or before the day that many company days back: a chat where the
 * customer wrote last is waiting for an answer, not idle, and is never closed
 * here. Returns the conversations it closed.
 */
export async function closeIdleIn(tx: Database, ctx: ServiceContext, now = new Date()): Promise<string[]> {
  const organizationId = ctx.actor.organizationId;
  const days = (await settingsWithin(tx, organizationId)).chatIdleCloseDays;
  if (days === null) return [];
  const zone = await timezoneOf(tx, organizationId);
  const today = time.dateIn(now, zone);
  /** Written on or before this day has been quiet the days: the first instant after it is the bound. */
  const quietBefore = time.startOfDayIn(time.addDays(today, 1 - days), zone);
  const due = await tx.execute<{ chat_id: string; conversation_id: string }>(sql`
    select s.id as chat_id, s.conversation_id
      from public.ai_chat_session s
      join public.conversation c on c.id = s.conversation_id
      cross join lateral (
        select m.direction::text as direction, m.created_at
          from public.message m
         where m.conversation_id = s.conversation_id
         order by m.created_at desc, m.id desc limit 1
      ) last
     where s.organization_id = ${organizationId}::uuid
       and s.channel = 'portal'
       and s.status <> 'closed'
       and c.deleted_at is null
       and last.direction = 'outbound'
       and last.created_at < ${quietBefore.toISOString()}::timestamptz
       and (c.reopened_at is null or c.reopened_at < ${quietBefore.toISOString()}::timestamptz)
     order by last.created_at
     limit ${IDLE_CLOSES_PER_PASS}`);
  const closed: string[] = [];
  for (const row of due) {
    /** The claim: only the pass whose update lands closes it and writes the line. */
    const [claimed] = await tx.update(schema.aiChatSession).set({
      status: "closed", officeClosedAt: now, officeClosedByUserId: null, officeCloseKind: "idle", writing: null, updatedAt: now,
    }).where(and(eq(schema.aiChatSession.id, row.chat_id), sql`${schema.aiChatSession.status} <> 'closed'`))
      .returning({ id: schema.aiChatSession.id });
    if (!claimed) continue;
    await tx.update(schema.conversation).set({ status: "closed", updatedAt: now })
      .where(eq(schema.conversation.id, row.conversation_id));
    await audit(tx, ctx, "portal.chat_closed_idle", "conversation", row.conversation_id,
      { status: "open" }, { status: "closed", closedBy: "idle", quietDays: days });
    closed.push(row.conversation_id);
  }
  return closed;
}

export interface IdleClosePassResult { organizationId: string; closed: number; failed: string | null }

let lastIdlePass: number | null = null;

/**
 * Every company that chose a number of quiet days and has an account chat that
 * could be due, once a minute at most per process: it is counted in days, and
 * nothing gains from asking more often. One company's failure is kept to that
 * company.
 */
export async function idleClosePass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean; force?: boolean } = {},
): Promise<IdleClosePassResult[]> {
  const at = (options.now ?? new Date()).getTime();
  if (!options.force && lastIdlePass !== null && at - lastIdlePass < 60_000 && at >= lastIdlePass) return [];
  lastIdlePass = at;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.portal_chat_idle_organizations(${options.limit ?? 200})`,
  );
  const results: IdleClosePassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    const ctx: ServiceContext = { actor: idleActor(row.organization_id), db };
    try {
      const closed = await inTenant(ctx, (tx) => closeIdleIn(tx, ctx, options.now ?? new Date()));
      results.push({ organizationId: row.organization_id, closed: closed.length, failed: null });
    } catch (error) {
      results.push({ organizationId: row.organization_id, closed: 0, failed: (error as Error).message });
    }
  }
  return results;
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
  closePortalChat: (db: Database, input: { token: string }) => close(db, input),
  closeConversation: (ctx: ServiceContext, input: { id: string }) => closeFromOffice(ctx, input),
  getPortalChatUnread: (db: Database, input: { token: string }) => unreadReplies(db, input),
  getPortalChatPicture: async (db: Database, input: { token: string; messageId: string; index: number }) => {
    const found = await picture(db, input);
    return { contentType: found.contentType, fileName: found.name, bytes: found.bytes.toString("base64") };
  },
} as const;
