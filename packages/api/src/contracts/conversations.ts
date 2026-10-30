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
  /** The customer closed this chat from their account. False on every other conversation. */
  closedByCustomer: z.boolean(),
  /** Who closed a closed conversation: the customer (from their account), a person in the office, or the company's quiet chat rule. Null when it is not closed, or was closed before who was kept. */
  closedBy: z.enum(["customer", "office", "idle"]).nullable(),
  /** The person, when `closedBy` is `office`. */
  closedByName: z.string().nullable(),
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
      /** An email's subject; null on a text. */
      subject: z.string().nullable(),
      /** Who it came from: on an email reply, possibly not the address the thread is with. */
      fromAddress: z.string(),
      /**
       * An inbound email's HTML part as plain text, tags and scripts gone.
       * The HTML itself is never kept. Null on a text, and on an email with
       * no HTML part.
       */
      htmlText: z.string().nullable(),
      /**
       * Pictures and files. `storageKey` is set for one kept here (the inbox
       * shows it, and downloads it at `/inbox/{id}/media/{storageKey}`);
       * `refused` says why one was not kept; `name` is the file's name as an
       * email carried it.
       */
      media: z.array(z.object({
        contentType: z.string(), storageKey: z.string().nullable(), refused: z.string().nullable(),
        name: z.string().nullable(),
      })),
    })),
    /**
     * On a chat from a customer's account: what happened when the customer was
     * told the office had answered ("Told by email.", or why nobody could be
     * told). Null on every other thread, and before anyone has answered.
     */
    customerNotice: z.string().nullable(),
    /** When the customer closed this chat from their account, or null: not closed by them, or not an account chat. */
    customerClosedAt: Iso.nullable(),
    /** When the company closed this conversation (a person, or the quiet chat rule), or null: open, or closed by the customer. */
    officeClosedAt: Iso.nullable(),
    /** When it was closed, by whoever closed it. Null when it is not closed, or was closed before who was kept. */
    closedAt: Iso.nullable(),
    /** Who closed it: `customer`, `office` or `idle`. Null when it is not closed, or was closed before who was kept. */
    closedBy: z.enum(["customer", "office", "idle"]).nullable(),
    /** The person who closed it, when `closedBy` is `office`. */
    closedByName: z.string().nullable(),
    /** When a person last reopened it, and who. Null when nobody has. */
    reopenedAt: Iso.nullable(),
    reopenedByName: z.string().nullable(),
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
  description:
    "Queued, never sent here: the worker hands it to the carrier or the mail provider. A text thread is answered by text and an email thread by email, each under its own consent rules, and refused with the reason in words when it may not go. Pictures go as a picture message on a text thread (JPEG, PNG or GIF, three at most and five megabytes together, which is what carriers deliver), as attachments on an email thread, and in a chat from a customer's account, where the customer sees them on their chat page. A website chat takes words only. A reply in a chat from a customer's account also tells the customer, by email or text and once until they read it, that the office answered.",
  module: "M18",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    body: z.string().max(1600).default(""),
    pictures: z.array(z.object({
      /** The picture's bytes, base64 encoded. What it is is read from the bytes, never from the name. */
      contentBase64: z.string().min(1).max(7_500_000),
      fileName: z.string().max(200).optional(),
    })).max(3).optional(),
  }),
  output: z.object({ messageId: Uuid, status: z.string() }),
});

export const closeConversation = defineRoute({
  method: "post",
  path: "/v1/conversations/{id}/closed",
  summary: "Close a conversation",
  description:
    "Closes any conversation the caller can see: a website visitor's chat, a customer's chat from their account, a text thread or an email thread. Every message is kept and it is the same conversation if it is reopened. A text or email thread leaves the open inbox (a customer writing again, or a reply from the office, opens it again by itself). A chat has ended: a visitor cannot write into it, a reply is refused from then on, and a customer's chat page says in words that the company closed it, still shows them what was said, and the next thing they write opens a new conversation. Who closed it and when are kept and shown in the inbox. Nothing the office has not read is marked read and no task is closed. A conversation marked as spam is not closed. Closing a conversation that is already closed changes nothing.",
  module: "M05",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    closedBy: z.enum(["customer", "office", "idle"]),
    /** The person, when `closedBy` is `office`. */
    closedByName: z.string().nullable(),
    closedAt: Iso,
  }),
});

export const reopenConversation = defineRoute({
  method: "post",
  path: "/v1/conversations/{id}/reopened",
  summary: "Reopen a closed conversation",
  description:
    "Puts a closed conversation back in the open inbox as it was, with every message: the same thread, not a new one. A chat is back with a person when a person had it. Whoever closed it (the customer, the office or the quiet chat rule), a person reopening it is choosing to talk to the customer again; the quiet chat rule leaves a reopened chat alone until it has been quiet again. A chat the customer closed from their account shows to them again. Reopening a conversation that is already open changes nothing; one marked as spam is refused.",
  module: "M05",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    status: z.literal("open"),
    /** When a person last reopened it. Null when nobody has. */
    reopenedAt: Iso.nullable(),
    /** Who had closed it. Null when it was not closed. */
    previouslyClosedBy: z.enum(["customer", "office", "idle"]).nullable(),
  }),
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
  listConversations, getConversation, markConversationRead, replyToConversation, closeConversation, reopenConversation, startConversation,
  getConsent, grantConsent, revokeConsent,
} as const;
