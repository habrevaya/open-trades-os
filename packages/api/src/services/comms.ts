import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
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
    const decision = await sendability(tx, conversation.organizationId, conversation.externalAddress);

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
      ...(decision.allowed ? {} : { blockedReason: decision.reason, blockedExplanation: refusal(decision.reason) }),
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
 */
export async function reply(ctx: ServiceContext, input: { id: string; body: string }) {
  const body = input.body.trim();
  if (body === "") throw new ConflictError("An empty message is not a reply");

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

    const decision = await sendability(tx, conversation.organizationId, conversation.externalAddress);
    if (!decision.allowed) throw new ConflictError(refusal(decision.reason));

    const [message] = await tx.insert(schema.message).values({
      organizationId: conversation.organizationId,
      conversationId: conversation.id,
      direction: "outbound",
      channel: "sms",
      purpose: "transactional",
      fromAddress: decision.from!.e164,
      toAddress: conversation.externalAddress,
      body,
      // Queued. The outbox hands it to the carrier; claiming sent here would
      // make the log say something the company cannot stand behind.
      status: "queued",
      sentByUserId: ctx.actor.userId,
    }).returning();

    await tx.update(schema.conversation).set({
      lastMessageAt: new Date(),
      lastMessagePreview: body.slice(0, 200),
      status: "open",
      updatedAt: new Date(),
    }).where(eq(schema.conversation.id, conversation.id));

    await rememberSend(tx, ctx, message!.id);
    return clean(ctx, "message", message!);
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
        return {
          id: String(m["id"]),
          direction: String(m["direction"]),
          channel: String(m["channel"]),
          status: String(m["status"]),
          body: (m["body"] ?? null) as string | null,
          createdAt: iso(m["createdAt"] as Date)!,
          readAt: iso(m["readAt"] as Date | null),
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

  replyToConversation: async (ctx: ServiceContext, input: { id: string; body: string }) => {
    const message = await reply(ctx, input) as Record<string, unknown>;
    return { messageId: String(message["id"]), status: String(message["status"]) };
  },

  startConversation: (ctx: ServiceContext, input: { customerId: string; body: string }) =>
    start(ctx, input),
} as const;
