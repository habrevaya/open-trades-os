import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { MessageChannel, MessagePurpose } from "./messaging";

/**
 * CONVERSATIONS AND CONSENT
 *
 * The inbox had a screen and no API. Rule three of the build plan is that
 * the web app consumes the surface a third party gets, and this was the
 * place it did not: an integrator, an MCP client or an agent could not read
 * a customer's reply, answer it, or ask whether a number may be texted.
 * These are the services the screen already used, declared.
 *
 * Every send goes through the same consent decision the outbox applies, so
 * nothing here is a way around STOP, a withdrawn consent or quiet hours.
 */

const Iso = z.string().datetime();

export const ConversationSummary = z.object({
  id: Uuid,
  externalAddress: z.string(),
  customerId: Uuid.nullable(),
  customerName: z.string().nullable(),
  status: z.string(),
  channel: z.string(),
  lastMessageAt: Iso.nullable(),
  lastMessagePreview: z.string().nullable(),
  /** Whether the last thing said came from them. */
  awaitingReply: z.boolean(),
  unread: z.number().int(),
});

export const listConversations = defineRoute({
  method: "get",
  path: "/v1/conversations",
  summary: "Conversations, newest activity first",
  module: "M18",
  permissions: ["message:read"],
  input: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().max(200).optional(),
    status: z.enum(["open", "closed"]).optional(),
    /** One customer's threads. */
    customerId: Uuid.optional(),
  }),
  output: z.object({
    data: z.array(ConversationSummary), hasMore: z.boolean(), nextCursor: z.string().nullable(),
  }),
});

export const getConversation = defineRoute({
  method: "get",
  path: "/v1/conversations/{id}",
  summary: "A conversation, in order, and whether a reply may be sent",
  module: "M18",
  permissions: ["message:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    conversation: z.object({
      id: Uuid, externalAddress: z.string(), customerId: Uuid.nullable(),
      status: z.string(), channel: z.string(), lastMessageAt: Iso.nullable(),
    }),
    customer: z.object({ id: Uuid, name: z.string() }).nullable(),
    messages: z.array(z.object({
      id: Uuid, direction: z.string(), channel: z.string(), status: z.string(),
      body: z.string().nullable(), createdAt: Iso, readAt: Iso.nullable(),
    })),
    canReply: z.boolean(),
    /** Why not, as a code and in words, when a reply would be refused. */
    blockedReason: z.string().nullable(),
    blockedExplanation: z.string().nullable(),
  }),
});

export const markConversationRead = defineRoute({
  method: "post",
  path: "/v1/conversations/{id}/read",
  summary: "Mark what a conversation holds as read",
  module: "M18",
  permissions: ["message:read"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ ok: z.literal(true) }),
});

export const replyToConversation = defineRoute({
  method: "post",
  path: "/v1/conversations/{id}/messages",
  summary: "Reply in a conversation",
  description: "Queued, never sent here: the worker hands it to the carrier. Refused with the reason in words when the number may not be texted.",
  module: "M18",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({ id: Uuid, body: z.string().min(1).max(1600) }),
  output: z.object({ messageId: Uuid, status: z.string() }),
});

export const startConversation = defineRoute({
  method: "post",
  path: "/v1/conversations",
  summary: "Text a customer who has not texted first",
  description: "Threads onto the conversation the number already has, if any. The same consent decision as every other send.",
  module: "M18",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({ customerId: Uuid, body: z.string().min(1).max(1600) }),
  output: z.object({ conversationId: Uuid, messageId: Uuid }),
});

const ConsentRow = z.object({
  id: Uuid,
  channel: z.string(),
  purpose: z.string(),
  state: z.string(),
  method: z.string(),
  proofText: z.string().nullable(),
  proofReference: z.string().nullable(),
  capturedAt: Iso,
  supersededAt: Iso.nullable(),
  /** True for the row that governs a send today. */
  current: z.boolean(),
});

export const getConsent = defineRoute({
  method: "get",
  path: "/v1/consent",
  summary: "What is on record for an address, and whether it may be marketed to",
  module: "M18",
  permissions: ["message:read"],
  input: z.object({ address: z.string().min(1).max(320) }),
  output: z.object({
    history: z.array(ConsentRow),
    marketing: z.object({ allowed: z.boolean(), reason: z.string().nullable() }),
  }),
});

const ConsentInput = z.object({
  address: z.string().min(1).max(320),
  channel: MessageChannel,
  purpose: MessagePurpose,
  method: z.enum(["web_form", "verbal", "written", "sms_reply", "checkout", "imported", "api"]),
  customerId: Uuid.optional(),
  /** The exact wording presented or spoken. Required for a grant, with or instead of a reference. */
  proofText: z.string().max(2000).optional(),
  proofReference: z.string().max(500).optional(),
});

export const grantConsent = defineRoute({
  method: "post",
  path: "/v1/consent",
  summary: "Record that somebody agreed to be contacted",
  description: "Needs the wording or a reference to where it happened. A consent with no proof is not evidence of anything.",
  module: "M18",
  permissions: ["message:send"],
  idempotent: true,
  input: ConsentInput,
  output: ConsentRow,
});

export const revokeConsent = defineRoute({
  method: "post",
  path: "/v1/consent/revoke",
  summary: "Record that somebody asked not to be contacted",
  description: "Takes the address rather than a row id: the person doing this is on the phone with somebody saying stop.",
  module: "M18",
  permissions: ["message:send"],
  idempotent: true,
  input: ConsentInput,
  output: ConsentRow,
});

export const conversationRoutes = {
  listConversations, getConversation, markConversationRead, replyToConversation, startConversation,
  getConsent, grantConsent, revokeConsent,
} as const;
