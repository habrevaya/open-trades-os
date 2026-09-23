import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { comms } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, clean, decodeCursor, paginate, scopeOf,
  NotFoundError, ConflictError, type ServiceContext,
} from "./context";
import { conversationScopeFilter } from "./scope";
import { sendability, refusal, threadFor } from "./comms-send";

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
  input: { limit?: number; cursor?: string; status?: "open" | "closed" } = {},
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
      ...(decision.allowed ? {} : { blockedReason: decision.reason }),
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

    return clean(ctx, "message", message!);
  });
}
