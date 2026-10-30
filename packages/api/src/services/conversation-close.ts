import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  ConflictError, NotFoundError, audit, guardedWrite, scopeOf, type ServiceContext,
} from "./context";
import { conversationScopeFilter } from "./scope";

/**
 * CLOSING AND REOPENING ANY CONVERSATION (M05, M18)
 *
 * The office could close only a chat from a customer's account, and a closed
 * one stayed closed: the customer writing again made a new conversation and
 * nobody could bring the old one back. A website visitor's chat, a text
 * thread and an email thread could not be closed at all, so the inbox had no
 * way to say "this one is done".
 *
 * Now a person who may send closes any conversation they can see, and reopens
 * any closed one, and it is the SAME conversation either way: closing keeps
 * every message, reopening puts it back in the inbox as it was.
 *
 * WHAT CLOSED MEANS, by kind:
 *   A text or email thread: it leaves the open inbox. A customer writing again
 *     reopens it by itself, as it always did, and so does a reply from the
 *     office.
 *   A chat (a website visitor's, an account's, the assistant's over text): the
 *     chat has ended. A visitor cannot write into it and a reply from the
 *     office is refused, in words, until it is reopened.
 *
 * WHO CLOSED IT is kept on the conversation (`closed_at`, `closed_by_user_id`)
 * and, for a chat, on the chat as it always was, so the inbox can say "Dana
 * closed this on Tuesday" for every kind.
 *
 * REOPENING a chat puts it back as it was before it was closed: with a person
 * (handed off) when a person had it, open otherwise. Whoever closed it, the
 * customer, a person or the quiet chat rule: a person reopening is a person
 * choosing to talk to them again, and the quiet chat rule leaves it alone
 * until it has been quiet again since. A chat the customer closed from their
 * account shows to them again when reopened, with what was said; they are not
 * told that it was.
 *
 * A thread marked as spam is neither closed nor reopened here: that is a
 * different decision, and closing it would lose it.
 *
 * Closing a closed conversation and reopening an open one change nothing, so a
 * double click and a retry are the same act.
 */

export type ClosedBy = "customer" | "office" | "idle";

export interface Closing {
  id: string;
  closedBy: ClosedBy;
  closedByName: string | null;
  closedAt: string;
}

export interface Reopening {
  id: string;
  status: "open";
  /** When a person last reopened it, or null if nobody has. */
  reopenedAt: string | null;
  /** Who had closed it, when it was closed: null when it was not closed. */
  previouslyClosedBy: ClosedBy | null;
}

/** A person's name, from the company's people. */
export async function nameOfPerson(tx: Database, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [row] = await tx.execute<{ name: string | null; email: string }>(
    sql`select name, email from app.organization_people() where user_id = ${userId}::uuid`,
  );
  return row ? (row.name ?? row.email) : null;
}

async function loadScoped(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select({ conversation: schema.conversation, chat: schema.aiChatSession })
    .from(schema.conversation)
    .leftJoin(schema.aiChatSession, eq(schema.aiChatSession.conversationId, schema.conversation.id))
    .where(and(
      eq(schema.conversation.id, id),
      isNull(schema.conversation.deletedAt),
      conversationScopeFilter(scopeOf(ctx, "conversation"), ctx.actor),
    ))
    .limit(1);
  if (!row) throw new NotFoundError("Conversation");
  return row;
}

type Chat = typeof schema.aiChatSession.$inferSelect;
type Conversation = typeof schema.conversation.$inferSelect;

async function closing(tx: Database, conversation: Conversation, chat: Chat | null): Promise<Closing> {
  const by: ClosedBy = chat?.customerClosedAt ? "customer" : chat?.officeClosedAt ? (chat.officeCloseKind ?? "office") : "office";
  const at = chat?.customerClosedAt ?? chat?.officeClosedAt ?? conversation.closedAt ?? conversation.updatedAt;
  return {
    id: conversation.id,
    closedBy: by,
    closedByName: by === "office" ? await nameOfPerson(tx, chat?.officeClosedByUserId ?? conversation.closedByUserId) : null,
    closedAt: at.toISOString(),
  };
}

/**
 * Close a conversation: `message:send`, because it is the inbox's own reply
 * box that closes it, held to the same conversation scope as reading it.
 */
export function close(ctx: ServiceContext, input: { id: string }): Promise<Closing> {
  return guardedWrite(ctx, "message:send", async (tx) => {
    const { conversation, chat } = await loadScoped(tx, ctx, input.id);
    if (conversation.status === "closed") return closing(tx, conversation, chat);
    if (conversation.status === "spam") {
      throw new ConflictError("This conversation is marked as spam, so it is already out of the way. Mark it as not spam first if you want to close it.");
    }

    const now = new Date();
    const [closed] = await tx.update(schema.conversation).set({
      status: "closed", closedAt: now, closedByUserId: ctx.actor.userId, updatedAt: now,
    }).where(eq(schema.conversation.id, conversation.id)).returning();

    let after: Chat | null = null;
    if (chat && chat.status !== "closed") {
      [after = null] = await tx.update(schema.aiChatSession).set({
        status: "closed", officeClosedAt: now, officeClosedByUserId: ctx.actor.userId, officeCloseKind: "office",
        writing: null, updatedAt: now,
      }).where(eq(schema.aiChatSession.id, chat.id)).returning();
    }

    /** An account chat keeps the action name it has always had, so its history reads as it did. */
    await audit(tx, ctx, chat?.channel === "portal" ? "portal.chat_closed_by_office" : "conversation.closed_by_office",
      "conversation", conversation.id, { status: conversation.status }, { status: "closed", closedBy: "office", channel: conversation.channel });
    return closing(tx, closed!, after ?? chat);
  });
}

/**
 * Reopen a closed conversation, keeping the thread: the same messages, the
 * same customer, back in the open inbox.
 */
export function reopen(ctx: ServiceContext, input: { id: string }): Promise<Reopening> {
  return guardedWrite(ctx, "message:send", async (tx) => {
    const { conversation, chat } = await loadScoped(tx, ctx, input.id);
    if (conversation.status === "open") {
      return { id: conversation.id, status: "open" as const, reopenedAt: conversation.reopenedAt?.toISOString() ?? null, previouslyClosedBy: null };
    }
    if (conversation.status !== "closed") {
      throw new ConflictError(conversation.status === "spam"
        ? "This conversation is marked as spam, not closed. Mark it as not spam to bring it back."
        : "This conversation is not closed.");
    }
    const was = (await closing(tx, conversation, chat)).closedBy;

    const now = new Date();
    await tx.update(schema.conversation).set({
      status: "open", reopenedAt: now, reopenedByUserId: ctx.actor.userId, updatedAt: now,
    }).where(eq(schema.conversation.id, conversation.id));
    if (chat && chat.status === "closed") {
      await tx.update(schema.aiChatSession).set({
        /** Back as it was: with a person when a person had it. */
        status: chat.handedOffAt ? "handed_off" : "open",
        customerClosedAt: null, officeClosedAt: null, officeClosedByUserId: null, officeCloseKind: null,
        updatedAt: now,
      }).where(eq(schema.aiChatSession.id, chat.id));
    }
    await audit(tx, ctx, "conversation.reopened", "conversation", conversation.id,
      { status: "closed", closedBy: was }, { status: "open", channel: conversation.channel });
    return { id: conversation.id, status: "open" as const, reopenedAt: now.toISOString(), previouslyClosedBy: was };
  });
}

export const handlers = {
  closeConversation: (ctx: ServiceContext, input: { id: string }) => close(ctx, input),
  reopenConversation: (ctx: ServiceContext, input: { id: string }) => reopen(ctx, input),
} as const;
