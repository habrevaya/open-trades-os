import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { agents as a, comms, money as m, SYSTEM_USER_ID } from "@opentradesos/core";
import {
  inTenant, ConflictError, NotFoundError, type RequestMeta, type ServiceContext,
} from "./context";
import * as booking from "./booking";
import * as base from "./agents";
import { companyFor, throttle } from "./website-tracking";
import { companyOf, servicesAndWindows, hoursOf, serviceAreaOf, bookItems } from "./agent-facts";
import { sendTransactional, quietHoursFor } from "./comms-send";
import type { AiDeps } from "./ai";

/**
 * THE CHAT AGENT, ON THE WEBSITE AND BY TEXT
 *
 * A visitor on the company's own website opens the chat, or a customer texts
 * the company's number, and the agent answers from the facts the company gave
 * it: its services and the prices it publishes, where it works, its hours and
 * its own questions and answers. It can offer the same windows the booking page
 * offers and take a booking request, which the office confirms like any other.
 *
 * FIVE THINGS IT ALWAYS DOES, in code rather than in the prompt:
 *
 *   It SAYS IT IS AUTOMATED, first, on every chat and the first text of every
 *   conversation, before the model has said anything.
 *
 *   It HANDS OVER when the customer asks for a person, decided by
 *   `wantsAPerson` before the model is asked, and when it has taken its limit
 *   of turns, and whenever the model is unsure or cannot be reached.
 *
 *   It QUOTES NO PRICE THE COMPANY DID NOT PUBLISH. A reply naming any other
 *   amount is not sent; the conversation goes to a person instead.
 *
 *   It STAYS OUT of a text conversation a person in the office is already in,
 *   and sends nothing by text in the company's quiet hours or to anybody whose
 *   consent says no: texts go through `sendTransactional`, the one gate every
 *   text in this product goes through.
 *
 *   Every word is in the inbox, on the conversation, where a person taking
 *   over reads it and answers. Answering a website chat from the inbox reaches
 *   the visitor's open chat.
 */

const LIMITS = { perAddress: 30, perSession: 12, perCompany: 2000, startPerAddress: 10 } as const;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** The words every chat opens with, before anything a model wrote. */
export const disclosure = (company: string) =>
  `You are chatting with ${company}'s automated assistant. It can answer questions and take a booking request, and a person can take over at any time: just ask.`;

const textDisclosure = (company: string) =>
  `This is ${company}'s automated assistant. Reply PERSON at any time to reach someone in the office.`;

/** The actor the public side reads settings as. It may read and write nothing else. */
const reader = (db: Database, organizationId: string): ServiceContext => ({
  actor: { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: base.agentId("chat") },
  db,
});

/* ------------------------------------------------------------- the widget */

export async function widgetConfig(db: Database, input: { companyKey: string }, meta?: RequestMeta) {
  await throttle(db, `chat:config:${meta?.ip ?? "unknown"}`, 120);
  const org = await companyFor(db, input.companyKey);
  return inTenant(reader(db, org.id), async (tx) => {
    const settings = await base.settingWithin(tx, org.id, "chat");
    const company = await companyOf(tx, org.id, new Date());
    const on = settings.enabled && settings.chat.web && settings.runAsUserId !== null;
    return {
      enabled: on,
      companyName: company.name,
      greeting: on ? settings.chat.greeting : null,
      disclosure: disclosure(company.name),
    };
  });
}

interface SessionRow { session: typeof schema.aiChatSession.$inferSelect; organizationId: string }

async function sessionFor(db: Database, companyKey: string, token: string): Promise<SessionRow> {
  const org = await companyFor(db, companyKey);
  const row = await inTenant(reader(db, org.id), async (tx) => {
    const [found] = await tx.select().from(schema.aiChatSession)
      .where(and(eq(schema.aiChatSession.tokenHash, hash(token)), eq(schema.aiChatSession.channel, "web"))).limit(1);
    return found ?? null;
  });
  /** Missing and somebody else's look the same: this token opens nothing here. */
  if (!row) throw new NotFoundError("Chat");
  return { session: row, organizationId: org.id };
}

/** The chat as the visitor sees it: their words, the assistant's and a person's, and nothing internal. */
async function transcript(tx: Database, session: typeof schema.aiChatSession.$inferSelect, after?: string | undefined) {
  const rows = await tx.select().from(schema.message)
    .where(and(
      eq(schema.message.conversationId, session.conversationId),
      after ? gt(schema.message.createdAt, new Date(after)) : undefined,
    ))
    .orderBy(asc(schema.message.createdAt), asc(schema.message.id));
  return {
    status: session.status,
    bookingTaken: session.bookingRequestId !== null,
    messages: rows.map((row) => ({
      id: row.id,
      from: row.direction === "inbound" ? "visitor" as const : row.sentByUserId ? "person" as const : "assistant" as const,
      text: row.body ?? "",
      at: row.createdAt.toISOString(),
    })),
  };
}

/**
 * Open a chat.
 *
 * Refused while the agent is off, so a stale widget on a cached page cannot
 * open a conversation nobody is answering. The token is returned once and
 * only its hash is kept.
 */
export async function start(db: Database, input: { companyKey: string; visitorId?: string | undefined }, meta?: RequestMeta) {
  await throttle(db, `chat:start:${meta?.ip ?? "unknown"}`, LIMITS.startPerAddress);
  const org = await companyFor(db, input.companyKey);
  await throttle(db, `chat:company:${org.id}`, LIMITS.perCompany);
  const token = randomBytes(32).toString("base64url");
  const out = await inTenant(reader(db, org.id), async (tx) => {
    const settings = await base.settingWithin(tx, org.id, "chat");
    if (!settings.enabled || !settings.chat.web || !settings.runAsUserId) {
      throw new ConflictError("Chat is not available right now. Please call or book online.");
    }
    const company = await companyOf(tx, org.id, new Date());
    const [conversation] = await tx.insert(schema.conversation).values({
      organizationId: org.id,
      channel: "webchat",
      externalAddress: `webchat:${randomBytes(9).toString("base64url")}`,
      internalAddress: "website",
      subject: "Website chat",
      status: "open",
      lastMessageAt: new Date(),
      lastMessagePreview: settings.chat.greeting.slice(0, 200),
    }).returning();
    const [session] = await tx.insert(schema.aiChatSession).values({
      organizationId: org.id,
      conversationId: conversation!.id,
      channel: "web",
      tokenHash: hash(token),
      visitorId: input.visitorId?.slice(0, 64) ?? null,
    }).returning();
    /** One after the other, a millisecond apart, so the disclosure is always read first. */
    const opened = Date.now();
    await tx.insert(schema.message).values([disclosure(company.name), settings.chat.greeting].map((body, index) => ({
      organizationId: org.id, conversationId: conversation!.id,
      direction: "outbound" as const, channel: "webchat" as const, purpose: "transactional" as const,
      fromAddress: "website", toAddress: conversation!.externalAddress, body, status: "sent" as const,
      createdAt: new Date(opened + index),
    })));
    return transcript(tx, session!);
  });
  return { token, ...out };
}

export async function read(db: Database, input: { companyKey: string; token: string; after?: string | undefined }, meta?: RequestMeta) {
  await throttle(db, `chat:read:${meta?.ip ?? "unknown"}`, 240);
  const { session, organizationId } = await sessionFor(db, input.companyKey, input.token);
  return inTenant(reader(db, organizationId), (tx) => transcript(tx, session, input.after));
}

/**
 * A visitor's message, and the agent's answer to it.
 *
 * The visitor's words are written first, in their own transaction, so they
 * are in the inbox whatever happens next: a model that cannot be reached
 * leaves a message for a person rather than a message lost.
 */
export async function say(
  db: Database, input: { companyKey: string; token: string; text: string },
  meta?: RequestMeta, deps: AiDeps = base.DEFAULT_AGENT_DEPS,
) {
  await throttle(db, `chat:say:${meta?.ip ?? "unknown"}`, LIMITS.perAddress);
  const { session, organizationId } = await sessionFor(db, input.companyKey, input.token);
  await throttle(db, `chat:session:${session.id}`, LIMITS.perSession);
  const text = input.text.trim();
  if (text === "") throw new ConflictError("Type a message first.");
  if (session.status === "closed") throw new ConflictError("This chat has ended. Start a new one.");

  const replay = await inTenant(reader(db, organizationId), async (tx) => {
    if (meta?.idempotencyKey) {
      /** A double tap on Send on one bar of signal is one message, and one answer. */
      const key = `chat:${session.id}:${meta.idempotencyKey.slice(0, 100)}`;
      const [seen] = await tx.select({ id: schema.integrationEvent.id }).from(schema.integrationEvent)
        .where(and(eq(schema.integrationEvent.provider, "webchat"), eq(schema.integrationEvent.idempotencyKey, key)))
        .limit(1);
      if (seen) return true;
      await tx.insert(schema.integrationEvent).values({
        organizationId, direction: "inbound", provider: "webchat", eventType: "chat.message",
        idempotencyKey: key, status: "succeeded", entityType: "ai_chat_session", entityId: session.id,
      });
    }
    await inbound(tx, organizationId, session, text);
    return false;
  });
  if (!replay) await answer(db, organizationId, session.id, deps);
  const [fresh] = await inTenant(reader(db, organizationId), (tx) =>
    tx.select().from(schema.aiChatSession).where(eq(schema.aiChatSession.id, session.id)).limit(1));
  return inTenant(reader(db, organizationId), (tx) => transcript(tx, fresh!));
}

async function inbound(tx: Database, organizationId: string, session: typeof schema.aiChatSession.$inferSelect, text: string) {
  const [conversation] = await tx.select().from(schema.conversation)
    .where(eq(schema.conversation.id, session.conversationId)).limit(1);
  await tx.insert(schema.message).values({
    organizationId, conversationId: session.conversationId,
    direction: "inbound", channel: "webchat", purpose: "transactional",
    fromAddress: conversation!.externalAddress, toAddress: "website",
    body: text.slice(0, 4000), status: "received",
  });
  await tx.update(schema.conversation).set({
    lastMessageAt: new Date(), lastMessagePreview: text.slice(0, 200),
    /** Unread for a person only once a person has it; the assistant answering is not the office's to read. */
    unreadCount: session.status === "handed_off" ? sql`${schema.conversation.unreadCount} + 1` : schema.conversation.unreadCount,
    status: "open", updatedAt: new Date(),
  }).where(eq(schema.conversation.id, session.conversationId));
  await tx.update(schema.aiChatSession).set({ lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.aiChatSession.id, session.id));
}

/* ------------------------------------------------------------- answering */

type Reply =
  | { kind: "reply"; text: string }
  | { kind: "handoff"; reason: string; text: string };

const HANDOFF_TEXT = "Thanks. I have passed this to someone in the office, and they will get back to you here as soon as they can.";

/**
 * The agent's turn in one chat, on either channel.
 *
 * Runs as the person on the agent's settings: a website visitor has no
 * session, and the agent's authority is that person's, never the system's.
 * Returns what to say and does not say it: the website writes it to the chat,
 * a text goes through the consent gate.
 */
async function turn(
  db: Database, organizationId: string, sessionId: string, deps: AiDeps,
): Promise<{ reply: Reply; session: typeof schema.aiChatSession.$inferSelect } | null> {
  const acting = await base.actingAs(db, organizationId, "chat");
  const [session] = await inTenant(reader(db, organizationId), (tx) =>
    tx.select().from(schema.aiChatSession).where(eq(schema.aiChatSession.id, sessionId)).limit(1));
  if (!session || session.status !== "open") return null;
  if (!acting.ok) return { session, reply: { kind: "handoff", reason: acting.reason, text: HANDOFF_TEXT } };
  const { ctx, settings } = acting;
  const now = (deps.now ?? (() => new Date()))();

  const context = await inTenant(ctx, async (tx) => {
    const rows = await tx.select().from(schema.message)
      .where(eq(schema.message.conversationId, session.conversationId))
      .orderBy(desc(schema.message.createdAt)).limit(30);
    const turns: a.ChatTurn[] = rows.reverse().map((row) => ({
      from: row.direction === "inbound" ? "customer" as const : row.sentByUserId ? "office" as const : "assistant" as const,
      text: row.body ?? "",
    }));
    const company = await companyOf(tx, organizationId, now);
    const { services, windows } = await servicesAndWindows(tx, organizationId, company.timezone, company.today, { perService: 4 });
    const published = await bookItems(tx, organizationId, { ids: settings.chat.publicPriceItemIds, limit: 200 });
    return {
      turns, company, windows, services,
      facts: {
        hours: await hoursOf(tx, organizationId),
        serviceArea: await serviceAreaOf(tx, organizationId),
        services: services.map((s) => ({ id: s.id, name: s.publicName, description: s.publicDescription, price: s.displayPrice })),
        publicPrices: published.items.map((item) => ({ name: item.name, price: item.price })),
        faq: settings.chat.faq,
        windows,
      } satisfies a.ChatFacts,
    };
  });

  const last = [...context.turns].reverse().find((t) => t.from === "customer");
  if (last && a.wantsAPerson(last.text)) {
    return { session, reply: { kind: "handoff", reason: "The customer asked for a person.", text: HANDOFF_TEXT } };
  }
  if (session.agentTurns >= settings.limits.messagesPerChat) {
    return { session, reply: { kind: "handoff", reason: `The assistant reached its limit of ${settings.limits.messagesPerChat} replies in one chat.`, text: HANDOFF_TEXT } };
  }

  const prompt = a.chatPrompt({
    company: context.company, tone: settings.tone, channel: session.channel === "text" ? "text" : "web",
    facts: context.facts, turns: context.turns, bookingTaken: session.bookingRequestId !== null,
  });
  const result = await base.ask(acting, "chat", prompt, `chat:${session.channel}`, deps);
  if (!result.ok) {
    return { session, reply: { kind: "handoff", reason: `The assistant could not answer: ${result.reason}`, text: HANDOFF_TEXT } };
  }

  /** Every amount it would say is one the company published, or it says nothing and a person answers. */
  const allowed = [
    ...context.facts.services.flatMap((s) => (s.price ? [s.price] : [])),
    ...context.facts.publicPrices.map((p) => p.price),
  ];
  const said = String(result.input["text"] ?? "");
  const unlisted = a.unlistedPrices(said, allowed);
  if (unlisted.length > 0) {
    await inTenant(ctx, (tx) => base.note(tx, ctx, {
      agent: "chat", kind: "refused",
      detail: `A reply quoted ${unlisted.map((p) => m.format(m.round(m.money(p), 2))).join(", ")}, which is not a published price. It was not sent; a person was asked to answer.`,
    }));
    return { session, reply: { kind: "handoff", reason: "The assistant would have quoted a price you have not published.", text: HANDOFF_TEXT } };
  }

  if (result.action.name === "hand_off") {
    return {
      session,
      reply: { kind: "handoff", reason: String(result.input["reason"]), text: said || HANDOFF_TEXT },
    };
  }

  if (result.action.name === "create_booking_request") {
    if (session.bookingRequestId) {
      return { session, reply: { kind: "handoff", reason: "The customer wanted a second booking in one chat.", text: HANDOFF_TEXT } };
    }
    const input = result.input as {
      bookableServiceId: string; date: string; arrivalWindowId: string; contactName: string;
      phone?: string; email?: string; notes?: string; text: string;
      address: { line1: string; line2?: string; city: string; state: string; postalCode: string };
    };
    const open = a.openOnly([{ date: input.date, arrivalWindowId: input.arrivalWindowId }], input.bookableServiceId, context.windows);
    const email = input.email && /.+@.+\..+/.test(input.email) ? input.email : undefined;
    if (open.length === 0) {
      return { session, reply: { kind: "reply", text: "Sorry, that time is not open. Could you pick one of the other times?" } };
    }
    if (!email && !input.phone) {
      return { session, reply: { kind: "reply", text: "What is the best phone number or email to confirm the booking with?" } };
    }
    try {
      const made = await booking.createRequest(db, {
        organizationSlug: context.company.slug,
        bookableServiceId: input.bookableServiceId,
        requestedDate: input.date,
        arrivalWindowId: input.arrivalWindowId,
        contactName: input.contactName,
        ...(email ? { contactEmail: email } : {}),
        ...(input.phone ? { contactPhone: input.phone } : {}),
        addressLine1: input.address.line1,
        ...(input.address.line2 ? { addressLine2: input.address.line2 } : {}),
        city: input.address.city,
        state: input.address.state,
        postalCode: input.address.postalCode,
        ...(input.notes ? { notes: input.notes } : {}),
        intakeAnswers: {},
        utm: {},
        ...(session.visitorId ? { visitorId: session.visitorId } : {}),
      }, { idempotencyKey: `ai-chat:${session.id}` });
      await inTenant(ctx, async (tx) => {
        await tx.update(schema.aiChatSession).set({ bookingRequestId: made.request.id, updatedAt: new Date() })
          .where(eq(schema.aiChatSession.id, session.id));
        await base.note(tx, ctx, {
          agent: "chat", kind: "answered",
          detail: `Took a booking request from ${input.contactName} for ${input.date}. It is waiting in Online booking for the office to confirm.`,
        });
      });
      return { session, reply: { kind: "reply", text: input.text } };
    } catch (error) {
      if (error instanceof ConflictError) {
        return { session, reply: { kind: "reply", text: "Sorry, that time has just been taken. Could you pick another?" } };
      }
      throw error;
    }
  }

  return { session, reply: { kind: "reply", text: said } };
}

/** Write the agent's turn to a website chat. */
async function answer(db: Database, organizationId: string, sessionId: string, deps: AiDeps): Promise<void> {
  const outcome = await turn(db, organizationId, sessionId, deps);
  if (!outcome) return;
  const { session, reply } = outcome;
  await inTenant(reader(db, organizationId), async (tx) => {
    const [conversation] = await tx.select().from(schema.conversation)
      .where(eq(schema.conversation.id, session.conversationId)).limit(1);
    await tx.insert(schema.message).values({
      organizationId, conversationId: session.conversationId,
      direction: "outbound", channel: "webchat", purpose: "transactional",
      fromAddress: "website", toAddress: conversation!.externalAddress,
      body: reply.text, status: "sent",
    });
    await tx.update(schema.aiChatSession).set({
      agentTurns: sql`${schema.aiChatSession.agentTurns} + 1`, lastActivityAt: new Date(), updatedAt: new Date(),
    }).where(eq(schema.aiChatSession.id, session.id));
    await tx.update(schema.conversation).set({
      lastMessageAt: new Date(), lastMessagePreview: reply.text.slice(0, 200), updatedAt: new Date(),
    }).where(eq(schema.conversation.id, session.conversationId));
    if (reply.kind === "handoff") await handOff(tx, organizationId, session, reply.reason);
    else {
      await base.note(tx, reader(db, organizationId), { agent: "chat", kind: "answered", detail: "Answered a website chat." });
    }
  });
}

/**
 * Give a chat to a person.
 *
 * The conversation is marked unread in the inbox and a task goes on the
 * office's queue, because a handover nobody notices is a customer told
 * somebody will get back to them, and nobody does.
 */
async function handOff(tx: Database, organizationId: string, session: typeof schema.aiChatSession.$inferSelect, reason: string) {
  await tx.update(schema.aiChatSession).set({
    status: "handed_off", handedOffAt: new Date(), handoffReason: reason.slice(0, 500), updatedAt: new Date(),
  }).where(eq(schema.aiChatSession.id, session.id));
  await tx.update(schema.conversation).set({
    unreadCount: sql`${schema.conversation.unreadCount} + 1`, status: "open", updatedAt: new Date(),
  }).where(eq(schema.conversation.id, session.conversationId));
  await tx.insert(schema.task).values({
    organizationId,
    title: session.channel === "web" ? "A website chat needs a person" : "A text conversation needs a person",
    body: `${reason} Open the conversation in the inbox to answer.`,
    priority: "high",
    entityType: "conversation",
    entityId: session.conversationId,
  });
  await tx.insert(schema.aiAgentActivity).values({
    organizationId, agent: "chat", kind: "handed_off", detail: `Handed to a person: ${reason}`.slice(0, 1000),
  });
}

/* ------------------------------------------------------------------ texts */

/**
 * Answer the texts waiting for the agent, a few at a time.
 *
 * A text conversation is the agent's to answer only when nobody in the office
 * has written in it for twelve hours: a person already talking to a customer
 * is not interrupted by an assistant. Nothing is sent in quiet hours; the text
 * waits for the morning pass. Each answer goes through `sendTransactional`, so
 * a STOP or a withdrawn consent is honoured exactly as it is for a person.
 */
export async function answerTexts(db: Database, organizationId: string, deps: AiDeps = base.DEFAULT_AGENT_DEPS, limit = 5) {
  const now = (deps.now ?? (() => new Date()))();
  const plan = await inTenant(reader(db, organizationId), async (tx) => {
    const settings = await base.settingWithin(tx, organizationId, "chat");
    const since = await base.enabledSince(tx, organizationId, "chat");
    if (!settings.enabled || !settings.chat.text || !since) return null;
    const quiet = await quietHoursFor(tx, organizationId, now);
    if (quiet.window && comms.inQuietHours(quiet.localHour, quiet.window)) return { waiting: [] as string[], quiet: true };
    const rows = await tx.execute<{ id: string }>(sql`
      select c.id from public.conversation c
      where c.organization_id = ${organizationId} and c.deleted_at is null
        and c.channel in ('sms', 'mms')
        and (select m.direction from public.message m where m.conversation_id = c.id
             order by m.created_at desc, m.id desc limit 1) = 'inbound'
        and exists (select 1 from public.message m where m.conversation_id = c.id
                    and m.direction = 'inbound' and m.created_at > ${since.toISOString()}::timestamptz)
        and not exists (select 1 from public.message m where m.conversation_id = c.id
                    and m.direction = 'outbound' and m.sent_by_user_id is not null
                    and m.created_at > ${new Date(now.getTime() - 12 * 3600_000).toISOString()}::timestamptz)
        and not exists (select 1 from public.ai_chat_session s where s.conversation_id = c.id and s.status <> 'open')
      order by c.last_message_at asc nulls last
      limit ${limit}`);
    return { waiting: rows.map((r) => r.id), quiet: false };
  });
  if (!plan) return { answered: 0, quiet: false };

  let answered = 0;
  for (const conversationId of plan.waiting) {
    const session = await inTenant(reader(db, organizationId), async (tx) => {
      const [existing] = await tx.select().from(schema.aiChatSession)
        .where(eq(schema.aiChatSession.conversationId, conversationId)).limit(1);
      if (existing) return { row: existing, first: false };
      const [created] = await tx.insert(schema.aiChatSession).values({
        organizationId, conversationId, channel: "text",
      }).onConflictDoNothing().returning();
      return created ? { row: created, first: true } : null;
    });
    if (!session) continue;
    const outcome = await turn(db, organizationId, session.row.id, deps);
    if (!outcome) continue;
    await inTenant(reader(db, organizationId), async (tx) => {
      const [conversation] = await tx.select().from(schema.conversation)
        .where(eq(schema.conversation.id, conversationId)).limit(1);
      const company = await companyOf(tx, organizationId, now);
      const body = session.first ? `${textDisclosure(company.name)}\n\n${outcome.reply.text}` : outcome.reply.text;
      const sent = await sendTransactional(tx, {
        organizationId, address: conversation!.externalAddress, body, customerId: conversation!.customerId,
      });
      await tx.update(schema.aiChatSession).set({
        agentTurns: sql`${schema.aiChatSession.agentTurns} + 1`, lastActivityAt: new Date(), updatedAt: new Date(),
      }).where(eq(schema.aiChatSession.id, session.row.id));
      if (!sent.sent) {
        /** Consent said no. Nothing went, and the office is told rather than the customer chased. */
        await handOff(tx, organizationId, session.row, `The assistant could not text back: ${sent.explanation}`);
        return;
      }
      if (outcome.reply.kind === "handoff") await handOff(tx, organizationId, session.row, outcome.reply.reason);
      else await base.note(tx, reader(db, organizationId), { agent: "chat", kind: "answered", detail: "Answered a text." });
    });
    answered += 1;
  }
  return { answered, quiet: plan.quiet };
}

export const handlers = {
  getChatWidget: (db: Database, input: { companyKey: string }, meta?: RequestMeta) => widgetConfig(db, input, meta),
  startChat: (db: Database, input: { companyKey: string; visitorId?: string | undefined }, meta?: RequestMeta) =>
    start(db, input, meta),
  readChat: (db: Database, input: { companyKey: string; token: string; after?: string | undefined }, meta?: RequestMeta) =>
    read(db, input, meta),
  sayInChat: (db: Database, input: { companyKey: string; token: string; text: string }, meta?: RequestMeta) =>
    say(db, input, meta),
} as const;
