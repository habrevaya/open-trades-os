import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { comms as c, files as f } from "@opentradesos/core";
/**
 * Never used by name. `thread` returns a type from core's comms module, and
 * without an import of it here the compiler cannot write that type down
 * (TS2742) and refuses the file. The underscore is what tells lint that
 * nothing reads it.
 */
import type { comms as _commsTypes } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, clean, decodeCursor, paginate, scopeOf,
  NotFoundError, ConflictError, type ServiceContext,
} from "./context";
import { conversationScopeFilter, customerScopeFilter } from "./scope";
import { sendability, sendTransactional, refusal } from "./comms-send";
import * as email from "./email";
import * as files from "./files";

/**
 * THE INBOX
 *
 * A customer replies to an appointment reminder and somebody has to see it.
 * Inbound messages were being stored, threaded and acted on for STOP, and
 * nothing read them back, which is the fifth time this codebase has built a
 * capability nobody could reach.
 *
 * Reading is guarded by `message:read` rather than by `customer:read`,
 * deliberately. A conversation is not a property of a customer record: it
 * contains what somebody said, which is a different and more sensitive thing
 * than their address, and the people who should answer the phone are not
 * always the people who maintain the book.
 */

export interface ThreadSummary {
  id: string;
  externalAddress: string;
  customerId: string | null;
  customerName: string | null;
  status: string;
  channel: string;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  /** Whether the last thing said came from them. The only sort that matters. */
  awaitingReply: boolean;
  unread: number;
}

export async function threads(
  ctx: ServiceContext,
  input: {
    limit?: number; cursor?: string; status?: "open" | "closed";
    /** One customer's threads, for their page and for "everything we have said to them". */
    customerId?: string;
  } = {},
) {
  const limit = input.limit ?? 50;
  return guardedRead(ctx, "message:read", async (tx) => {
    const cursor = decodeCursor(input.cursor);

    const rows = await tx.select({
      conversation: schema.conversation,
      customerName: schema.customer.name,
    })
      .from(schema.conversation)
      .leftJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
      .where(and(
        isNull(schema.conversation.deletedAt),
        /**
         * Scope, not permission. A technician holds `message:read` because
         * they text customers from the field; that is not a reason to hand
         * them every conversation the company has had.
         */
        conversationScopeFilter(scopeOf(ctx, "conversation"), ctx.actor),
        input.status ? eq(schema.conversation.status, input.status) : undefined,
        input.customerId ? eq(schema.conversation.customerId, input.customerId) : undefined,
        cursor ? lt(schema.conversation.lastMessageAt, new Date(cursor)) : undefined,
      ))
      /**
       * Newest activity first, and nulls last. A thread with no messages is
       * a conversation somebody opened and never used, and sorting it to the
       * top because its timestamp is null would put the empty ones in front
       * of the ones waiting for an answer.
       */
      .orderBy(sql`${schema.conversation.lastMessageAt} desc nulls last`)
      .limit(limit + 1);

    const page = paginate(rows, limit, (r) =>
      (r.conversation.lastMessageAt ?? r.conversation.createdAt).toISOString());

    const ids = page.data.map((r) => r.conversation.id);
    /**
     * `= any($1::uuid[])`, with the ids bound as ONE parameter.
     *
     * `sql.param` is load bearing: drizzle spreads a bare array in a template
     * into one placeholder per element, so `any(${ids})` becomes
     * `any($1, $2, $3)` and Postgres answers "malformed array literal".
     *
     * Not an `in (...)` list built by joining the ids into the string. These
     * come from a row this query just read, so it is not an injection today,
     * and building SQL by concatenating values is a habit rather than an
     * incident: the next person writing this pattern takes the ids from a
     * query parameter and nothing about the shape looks different.
     *
     * `distinct on` gives the newest message per conversation in one pass,
     * which is the only fact the list needs beyond the conversation row: did
     * the last thing said come from them.
     */
    const lastDirections = ids.length === 0 ? [] : await tx.execute<{
      conversation_id: string; direction: string; unread: number;
    }>(sql`
      select distinct on (m.conversation_id)
        m.conversation_id,
        m.direction::text as direction,
        (select count(*)::int from public.message u
          where u.conversation_id = m.conversation_id
            and u.direction = 'inbound' and u.read_at is null) as unread
      from public.message m
      where m.conversation_id = any(${sql.param(ids)}::uuid[])
      order by m.conversation_id, m.created_at desc
    `);

    const state = new Map(lastDirections.map((r) => [r.conversation_id, r]));

    return {
      ...page,
      data: page.data.map(({ conversation, customerName }): ThreadSummary => ({
        id: conversation.id,
        externalAddress: conversation.externalAddress,
        customerId: conversation.customerId,
        customerName,
        status: conversation.status,
        channel: conversation.channel,
        lastMessageAt: conversation.lastMessageAt,
        lastMessagePreview: conversation.lastMessagePreview,
        awaitingReply: state.get(conversation.id)?.direction === "inbound",
        unread: state.get(conversation.id)?.unread ?? 0,
      })),
    };
  });
}

export async function thread(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "message:read", async (tx) => {
    const [conversation] = await tx.select().from(schema.conversation)
      .where(and(
        eq(schema.conversation.id, input.id),
        isNull(schema.conversation.deletedAt),
        // Out of scope reads as missing. "You may not see this" answers the
        // question the caller was not allowed to ask.
        conversationScopeFilter(scopeOf(ctx, "conversation"), ctx.actor),
      ))
      .limit(1);
    if (!conversation) throw new NotFoundError("Conversation");

    const messages = await tx.select().from(schema.message)
      .where(eq(schema.message.conversationId, input.id))
      .orderBy(schema.message.createdAt);

    const [customer] = conversation.customerId
      ? await tx.select().from(schema.customer)
          .where(eq(schema.customer.id, conversation.customerId)).limit(1)
      : [];

    /**
     * Whether a reply is currently allowed, and why not when it is not.
     *
     * Answered here rather than only on send, because a screen that offers a
     * reply box and then refuses the send has wasted somebody's typing and
     * taught them that the guard is an obstacle. The send checks again
     * regardless: this is the courtesy, that is the rule.
     */
    const decision = await replyDecision(tx, conversation);

    return {
      conversation,
      customer: customer ? clean(ctx, "customer", customer) : null,
      messages: messages.map((m) => clean(ctx, "message", m)),
      canReply: decision.allowed,
      /**
       * The reason in words, from the one function that has a sentence for
       * every refusal. The screen used to keep its own map, keyed on two
       * names `canSend` has never returned, so a customer who withdrew
       * consent showed the generic line.
       */
      ...(decision.allowed ? {} : { blockedReason: decision.reason, blockedExplanation: decision.explanation }),
    };
  });
}

/**
 * Mark what has been seen.
 *
 * On the thread rather than per message, because a person who opened the
 * conversation read what was in it, and asking them to tick each one is a
 * chore they will stop doing within a week.
 */
export async function markRead(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "message:read", async (tx) => {
    await tx.update(schema.message)
      .set({ readAt: new Date() })
      .where(and(
        eq(schema.message.conversationId, input.id),
        eq(schema.message.direction, "inbound"),
        isNull(schema.message.readAt),
        // Only for a thread this actor can actually see, or marking read is a
        // way to touch rows they cannot read.
        sql`exists (
          select 1 from public.conversation c
          where c.id = ${schema.message.conversationId}
            and ${conversationScopeFilter(scopeOf(ctx, "conversation"), ctx.actor) ?? sql`true`}
        )`,
      ));
  });
}

/**
 * Whether a reply may go on this thread, by the gate for its channel.
 *
 * An email thread is answered by email, under the email rules (the do not
 * email list, a connected provider); a text thread by text, under STOP and
 * the rest. Asking the text gate about an email address answered a
 * question nobody asked.
 */
async function replyDecision(tx: Database, conversation: typeof schema.conversation.$inferSelect):
  Promise<{ allowed: true } | { allowed: false; reason: string; explanation: string }> {
  if (conversation.channel === "webchat") {
    const [session] = await tx.select({ status: schema.aiChatSession.status }).from(schema.aiChatSession)
      .where(eq(schema.aiChatSession.conversationId, conversation.id)).limit(1);
    return session && session.status !== "closed"
      ? { allowed: true }
      : { allowed: false, reason: "chat_closed", explanation: "This website chat has ended, so a reply has nowhere to go." };
  }
  if (conversation.channel === "email") {
    const decision = await email.emailability(tx, conversation.organizationId, conversation.externalAddress, "transactional");
    if (decision.allowed && decision.sender) return { allowed: true };
    const reason = decision.allowed ? "channel_not_registered" : decision.reason;
    return { allowed: false, reason, explanation: email.refusal(reason) };
  }
  const decision = await sendability(tx, conversation.organizationId, conversation.externalAddress);
  return decision.allowed
    ? { allowed: true }
    : { allowed: false, reason: decision.reason ?? "refused", explanation: refusal(decision.reason) };
}

/** A picture somebody chose to send, as bytes. What it is is decided from the bytes. */
export interface Picture {
  bytes: Uint8Array;
  fileName?: string | undefined;
}

/**
 * A person replying, by hand.
 *
 * Goes through the SAME consent decision as an automated send. A human
 * pressing send is not an exemption: the customer who replied STOP said it to
 * the company, not to the workflow, and an inbox that quietly bypasses the
 * suppression list is how a company ends up explaining itself to a regulator
 * over a message somebody sent personally.
 *
 * Transactional, because a reply in an open conversation is a reply. Anything
 * marketing has to be sent as marketing and needs its own consent.
 *
 * By the thread's own channel: a text thread is answered by text, with any
 * pictures as a picture message, and an email thread by email, with any
 * pictures attached.
 */
export async function reply(ctx: ServiceContext, input: { id: string; body: string; pictures?: readonly Picture[] | undefined }) {
  const body = input.body.trim();
  const pictures = input.pictures ?? [];
  if (body === "" && pictures.length === 0) throw new ConflictError("An empty message is not a reply");

  return guardedWrite(ctx, "message:send", async (tx) => {
    const [conversation] = await tx.select().from(schema.conversation)
      .where(and(
        eq(schema.conversation.id, input.id),
        isNull(schema.conversation.deletedAt),
        conversationScopeFilter(scopeOf(ctx, "conversation"), ctx.actor),
      ))
      .limit(1);
    if (!conversation) throw new NotFoundError("Conversation");

    const repeat = await sentBefore(tx, ctx);
    if (repeat) return clean(ctx, "message", repeat);

    if (conversation.channel === "email") {
      await takeOverChat(tx, conversation.id);
      return replyByEmail(tx, ctx, conversation, body, pictures);
    }
    if (conversation.channel === "webchat") return replyInChat(tx, ctx, conversation, body, pictures);
    await takeOverChat(tx, conversation.id);

    const decision = await sendability(tx, conversation.organizationId, conversation.externalAddress);
    if (!decision.allowed) throw new ConflictError(refusal(decision.reason));

    const media = pictures.length > 0 ? await keepPictures(tx, ctx, decision.from!, pictures) : [];

    const [message] = await tx.insert(schema.message).values({
      organizationId: conversation.organizationId,
      conversationId: conversation.id,
      direction: "outbound",
      channel: media.length > 0 ? "mms" : "sms",
      purpose: "transactional",
      fromAddress: decision.from!.e164,
      toAddress: conversation.externalAddress,
      body,
      media,
      // Queued. The outbox hands it to the carrier; claiming sent here would
      // make the log say something the company cannot stand behind.
      status: "queued",
      sentByUserId: ctx.actor.userId,
    }).returning();

    for (const picture of media) {
      await files.attach(tx, ctx.actor.organizationId, {
        entityType: "message", entityId: message!.id, storageKey: picture.storageKey!,
        contentType: picture.contentType, sizeBytes: picture.bytes ?? 0, uploadedByUserId: ctx.actor.userId,
      });
    }

    await tx.update(schema.conversation).set({
      lastMessageAt: new Date(),
      lastMessagePreview: (body || "Picture").slice(0, 200),
      status: "open",
      updatedAt: new Date(),
    }).where(eq(schema.conversation.id, conversation.id));

    await rememberSend(tx, ctx, message!.id);
    return clean(ctx, "message", message!);
  });
}

/**
 * A person answering a website chat, from the inbox.
 *
 * The visitor's open chat reads the conversation, so the reply is written as
 * sent: there is no carrier between the inbox and the widget, and no consent
 * question either, because the visitor opened the chat and is waiting in it.
 * Answering takes the chat over from the automated assistant.
 */
async function replyInChat(
  tx: Database, ctx: ServiceContext, conversation: typeof schema.conversation.$inferSelect,
  body: string, pictures: readonly Picture[],
) {
  if (pictures.length > 0) throw new ConflictError("A website chat takes words only. Send the picture by text or email instead.");
  const decision = await replyDecision(tx, conversation);
  if (!decision.allowed) throw new ConflictError(decision.explanation);
  await takeOverChat(tx, conversation.id);
  const [message] = await tx.insert(schema.message).values({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    direction: "outbound",
    channel: "webchat",
    purpose: "transactional",
    fromAddress: "website",
    toAddress: conversation.externalAddress,
    body,
    status: "sent",
    sentByUserId: ctx.actor.userId,
  }).returning();
  await tx.update(schema.conversation).set({
    lastMessageAt: new Date(), lastMessagePreview: body.slice(0, 200), status: "open", updatedAt: new Date(),
  }).where(eq(schema.conversation.id, conversation.id));
  await rememberSend(tx, ctx, message!.id);
  return clean(ctx, "message", message!);
}

/**
 * A person writing in a conversation the automated assistant is answering
 * takes it over. From then on the assistant stays quiet, because two voices
 * answering one customer is worse than either.
 */
async function takeOverChat(tx: Database, conversationId: string): Promise<void> {
  await tx.update(schema.aiChatSession).set({
    status: "handed_off",
    handedOffAt: sql`coalesce(${schema.aiChatSession.handedOffAt}, now())`,
    handoffReason: sql`coalesce(${schema.aiChatSession.handoffReason}, 'A person replied.')`,
    updatedAt: new Date(),
  }).where(and(eq(schema.aiChatSession.conversationId, conversationId), eq(schema.aiChatSession.status, "open")));
}

/**
 * Keep the pictures and give the carrier somewhere to fetch them from.
 *
 * A carrier sends a picture message by fetching each picture from a URL it
 * is given, at the moment it sends, with no login. So each picture is kept
 * as a stored file and given an address under the carrier's own webhook
 * path, ending in a random key of its own: the webhook token says which
 * company, the key says which picture, and neither can be guessed. The
 * address only answers for a week, which is far longer than a carrier
 * takes to send and far shorter than forever.
 *
 * Checked before anything is kept: what the bytes are (never what the file
 * claimed to be), and what a carrier will actually deliver, because a
 * picture over the limit is accepted by the API and then quietly dropped.
 */
async function keepPictures(
  tx: Database, ctx: ServiceContext,
  from: { capabilities: { mms?: boolean } | null },
  pictures: readonly Picture[],
) {
  const sniffed = pictures.map((picture) => ({ picture, verdict: f.checkFile(picture.bytes) }));
  for (const { verdict } of sniffed) if (!verdict.ok) throw new ConflictError(verdict.reason);
  const checked = c.checkPictures(sniffed.map(({ picture, verdict }) => ({
    contentType: verdict.ok ? verdict.contentType : "", sizeBytes: picture.bytes.length,
  })));
  if (!checked.ok) throw new ConflictError(checked.reason);
  if (from.capabilities?.mms === false) {
    throw new ConflictError("The number your texts go from cannot send pictures. Send the words alone, or use a number that can.");
  }

  const base = process.env["PUBLIC_URL"]?.replace(/\/$/, "");
  if (!base) {
    throw new ConflictError("PUBLIC_URL is not set, so the carrier would have nowhere to fetch the picture from. Set it to this installation's public address.");
  }
  const [connection] = await tx.select({ settings: schema.integrationConnection.settings })
    .from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, ctx.actor.organizationId),
      eq(schema.integrationConnection.capability, "messaging"),
      eq(schema.integrationConnection.status, "connected"),
    )).limit(1);
  const token = (connection?.settings as Record<string, unknown> | undefined)?.["webhookToken"];
  if (typeof token !== "string" || token.length < 32) {
    throw new ConflictError("Your texting connection has no webhook address yet, so pictures cannot be sent. Reconnect it under Settings, Integrations.");
  }

  const kept: { url: string; contentType: string; bytes: number; storageKey: string; publicKey: string }[] = [];
  for (const { picture } of sniffed) {
    const { file } = await files.put(tx, ctx.actor.organizationId, {
      bytes: picture.bytes, uploadedByUserId: ctx.actor.userId,
    });
    const publicKey = randomBytes(24).toString("base64url");
    kept.push({
      url: `${base}/api/webhooks/messaging/${token}/media/${publicKey}`,
      contentType: file.contentType, bytes: file.sizeBytes, storageKey: file.storageKey, publicKey,
    });
  }
  return kept;
}

/**
 * An email thread answered by email, through the email gate and outbox.
 *
 * The subject follows the thread ("Re:" the last one), and the reply goes
 * out with the thread's own reply address, so the customer's answer to it
 * comes back here too.
 */
async function replyByEmail(
  tx: Database, ctx: ServiceContext, conversation: typeof schema.conversation.$inferSelect,
  body: string, pictures: readonly Picture[],
) {
  if (body === "") throw new ConflictError("An email needs some words as well as a picture.");
  const attachments = pictures.map((picture, index) => {
    const verdict = f.checkFile(picture.bytes);
    if (!verdict.ok) throw new ConflictError(verdict.reason);
    const name = picture.fileName?.trim().replace(/[\\/]/g, "") || `picture-${index + 1}.${verdict.extension}`;
    return { filename: name, contentType: verdict.contentType, content: Buffer.from(picture.bytes) };
  });

  const [last] = await tx.select({ subject: schema.message.subject }).from(schema.message)
    .where(and(
      eq(schema.message.conversationId, conversation.id),
      sql`${schema.message.subject} is not null`,
      /** Not an out of office's subject: the reply answers the customer, not their autoresponder. */
      sql`coalesce(${schema.message.headers} ->> 'auto-submitted', 'no') = 'no'`,
    ))
    .orderBy(desc(schema.message.createdAt)).limit(1);
  const was = (last?.subject ?? conversation.subject ?? "").trim() || "Your message";
  const subject = /^re:/i.test(was) ? was : `Re: ${was}`;

  const outcome = await email.queueIn(tx, ctx, {
    to: conversation.externalAddress,
    subject,
    text: body,
    customerId: conversation.customerId,
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  if (!outcome.queued) throw new ConflictError(outcome.explanation);
  const [message] = await tx.select().from(schema.message).where(eq(schema.message.id, outcome.messageId)).limit(1);
  await rememberSend(tx, ctx, outcome.messageId);
  return clean(ctx, "message", message!);
}

/**
 * A picture from a thread, for the screen that shows it.
 *
 * `message:read` and the conversation scope, the same as reading the thread:
 * a picture a customer sent is what they said. Only a stored file some
 * message in THIS thread points at is served, so a storage key from another
 * thread, guessed or copied, is not found.
 */
export async function picture(ctx: ServiceContext, input: { conversationId: string; storageKey: string }) {
  return guardedRead(ctx, "message:read", async (tx) => {
    const [conversation] = await tx.select({ id: schema.conversation.id }).from(schema.conversation)
      .where(and(
        eq(schema.conversation.id, input.conversationId),
        isNull(schema.conversation.deletedAt),
        conversationScopeFilter(scopeOf(ctx, "conversation"), ctx.actor),
      )).limit(1);
    if (!conversation) throw new NotFoundError("Picture");
    const [message] = await tx.select({ id: schema.message.id }).from(schema.message)
      .where(and(
        eq(schema.message.conversationId, conversation.id),
        sql`${schema.message.media} @> ${JSON.stringify([{ storageKey: input.storageKey }])}::jsonb`,
      )).limit(1);
    if (!message) throw new NotFoundError("Picture");
    const [file] = await tx.select().from(schema.storedFile)
      .where(and(eq(schema.storedFile.storageKey, input.storageKey), isNull(schema.storedFile.deletedAt))).limit(1);
    if (!file) throw new NotFoundError("Picture");
    return { bytes: await files.bytesOf(file), contentType: file.contentType, sizeBytes: file.sizeBytes };
  });
}

/**
 * Text a customer who has not texted first.
 *
 * Every conversation used to begin with the customer: the inbox could reply
 * and nothing could start one, so the office texting a customer about a
 * part that came in meant a personal phone. This goes through the same send
 * a reply and an on-my-way notice do, so consent, STOP and quiet hours are
 * decided by the same function, and it threads onto any conversation the
 * number already has.
 *
 * The customer is read inside the caller's scope first. A technician who
 * cannot see a customer cannot text them by guessing an id.
 */
export async function start(ctx: ServiceContext, input: { customerId: string; body: string }) {
  if (input.body.trim() === "") throw new ConflictError("An empty message is not a message");

  return guardedWrite(ctx, "message:send", async (tx) => {
    const [customer] = await tx.select({ id: schema.customer.id, phone: schema.customer.phone })
      .from(schema.customer)
      .where(and(
        eq(schema.customer.id, input.customerId),
        isNull(schema.customer.deletedAt),
        customerScopeFilter(scopeOf(ctx, "customer"), ctx.actor),
      ))
      .limit(1);
    if (!customer) throw new NotFoundError("Customer");
    const repeat = await sentBefore(tx, ctx);
    if (repeat) return { conversationId: repeat.conversationId!, messageId: repeat.id };
    if (!customer.phone) {
      throw new ConflictError("This customer has no phone number to text. Add one to their record first.");
    }

    const outcome = await sendTransactional(tx, {
      organizationId: ctx.actor.organizationId,
      address: customer.phone,
      body: input.body,
      customerId: customer.id,
      sentByUserId: ctx.actor.userId,
    });
    if (!outcome.sent) throw new ConflictError(outcome.explanation);
    await rememberSend(tx, ctx, outcome.messageId);
    return { conversationId: outcome.conversationId, messageId: outcome.messageId };
  });
}

/**
 * A retried send is the same send.
 *
 * A text cannot be unsent, and a client on a truck with one bar retries.
 * With an idempotency key the first send is recorded against it and a retry
 * answers with that message rather than queueing a second one.
 */
async function sentBefore(tx: Database, ctx: ServiceContext) {
  if (!ctx.idempotencyKey) return null;
  const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
    .from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
      eq(schema.integrationEvent.entityType, "message"),
    )).limit(1);
  if (!seen?.entityId) return null;
  const [message] = await tx.select().from(schema.message)
    .where(eq(schema.message.id, seen.entityId)).limit(1);
  return message ?? null;
}

async function rememberSend(tx: Database, ctx: ServiceContext, messageId: string) {
  if (!ctx.idempotencyKey) return;
  await tx.insert(schema.integrationEvent).values({
    organizationId: ctx.actor.organizationId,
    direction: "inbound", provider: "api", eventType: "message.sent_by_hand",
    idempotencyKey: ctx.idempotencyKey, status: "succeeded",
    entityType: "message", entityId: messageId,
  });
}

/* --------------------------------------------------------------- handlers */

const iso = (value: Date | string | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null;

export const handlers = {
  listConversations: async (ctx: ServiceContext, input: {
    limit?: number | undefined; cursor?: string | undefined;
    status?: "open" | "closed" | undefined; customerId?: string | undefined;
  }) => {
    const page = await threads(ctx, {
      ...(input.limit ? { limit: input.limit } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.customerId ? { customerId: input.customerId } : {}),
    });
    return {
      ...page,
      data: page.data.map((t) => ({ ...t, lastMessageAt: iso(t.lastMessageAt) })),
    };
  },

  getConversation: async (ctx: ServiceContext, input: { id: string }) => {
    const found = await thread(ctx, input);
    const c = found.conversation;
    return {
      conversation: {
        id: c.id, externalAddress: c.externalAddress, customerId: c.customerId,
        status: c.status, channel: c.channel, lastMessageAt: iso(c.lastMessageAt),
      },
      customer: found.customer
        ? { id: String(found.customer["id"]), name: String(found.customer["name"]) }
        : null,
      messages: found.messages.map((raw) => {
        const m = raw as Record<string, unknown>;
        const media = (m["media"] ?? []) as { contentType: string; storageKey?: string; refused?: string }[];
        return {
          id: String(m["id"]),
          direction: String(m["direction"]),
          channel: String(m["channel"]),
          status: String(m["status"]),
          body: (m["body"] ?? null) as string | null,
          subject: (m["subject"] ?? null) as string | null,
          fromAddress: String(m["fromAddress"] ?? ""),
          createdAt: iso(m["createdAt"] as Date)!,
          readAt: iso(m["readAt"] as Date | null),
          /** Pictures kept here by their storage key; anything not kept, with why. */
          media: media.map((item) => ({
            contentType: item.contentType,
            storageKey: item.storageKey ?? null,
            refused: item.refused ?? null,
          })),
        };
      }),
      canReply: found.canReply,
      blockedReason: found.blockedReason ?? null,
      blockedExplanation: found.blockedExplanation ?? null,
    };
  },

  markConversationRead: async (ctx: ServiceContext, input: { id: string }) => {
    await markRead(ctx, input);
    return { ok: true as const };
  },

  replyToConversation: async (ctx: ServiceContext, input: {
    id: string; body: string; pictures?: { contentBase64: string; fileName?: string | undefined }[] | undefined;
  }) => {
    const message = await reply(ctx, {
      id: input.id,
      body: input.body,
      pictures: (input.pictures ?? []).map((p) => ({
        bytes: new Uint8Array(Buffer.from(p.contentBase64, "base64")),
        ...(p.fileName ? { fileName: p.fileName } : {}),
      })),
    }) as Record<string, unknown>;
    return { messageId: String(message["id"]), status: String(message["status"]) };
  },

  startConversation: (ctx: ServiceContext, input: { customerId: string; body: string }) =>
    start(ctx, input),
} as const;
