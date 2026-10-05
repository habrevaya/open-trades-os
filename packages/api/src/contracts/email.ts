import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * EMAIL
 *
 * The channel this product named in its own connector catalogue and could
 * not use. `capability` has listed `email` since the first migration, the
 * catalogue has carried `campaign_email` as declared, and there was no seam,
 * no adapter and no sender: a company could connect an email provider in the
 * settings screen and nothing would ever leave through it.
 *
 * Two shapes of provider sit behind these routes and the difference is
 * visible in what comes back rather than hidden.
 *
 *   An API provider (Resend) signs a webhook and reports delivery, bounces
 *   and spam complaints, and those move a message's status and write to the
 *   suppression list.
 *
 *   A GENERIC SMTP RELAY reports nothing, ever. SMTP ends at the receiving
 *   server's 250 OK; a bounce arrives hours later as a separate email to a
 *   mailbox this product does not read. So `sendQueuedEmail` returns
 *   `deliveryReporting` and, when there is none, the sentence explaining it.
 *   A screen that showed an empty delivery column with no explanation would
 *   read as a bug in this product rather than as the protocol.
 *
 * SMTP is here because it is what frees a self hoster from every vendor on
 * the connector list. An operator pastes a host, a port, a username and a
 * password, the same four fields their mail client asks for, and the product
 * sends. That is the whole point of self hosting and it is not a fallback.
 */

export const EmailPurpose = z.enum(["transactional", "marketing"]);

export const QueuedEmail = z.object({
  queued: z.boolean(),
  messageId: Uuid.nullable(),
  conversationId: Uuid.nullable(),
  /** Present only on a refusal. The machine readable one. */
  reason: z.string().nullable(),
  /** Present only on a refusal. Written for the person who pressed the button. */
  explanation: z.string().nullable(),
});

export const queueEmail = defineRoute({
  method: "post",
  path: "/v1/email/messages",
  summary: "Put an email in the outbox",
  description:
    "Queued, never sent: the row says queued until a provider has accepted it, because a log that claims a send the company cannot stand behind is worse than no log. A recipient who has unsubscribed, hard bounced or complained comes back as a refusal rather than an error, since 'they asked us to stop' is an answer and throwing would roll back whatever the caller was recording. Malformed mail is refused outright: no subject, no body, or HTML with no plain text alternative. Marketing carries a one click unsubscribe link to this product's own page, which is CAN-SPAM and the Gmail and Yahoo bulk sender rules: leave `unsubscribeUrl` out and one is made for the address, or pass one this company issued for that same address. Any other URL, a 404 or another company's link included, is refused, because a link that does not reach this product's page cannot take anybody off the list.",
  module: "M18",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({
    to: z.string().email().max(320),
    subject: z.string().min(1).max(1000),
    text: z.string().max(500_000).optional(),
    html: z.string().max(2_000_000).optional(),
    replyTo: z.string().email().max(320).optional(),
    purpose: EmailPurpose.optional(),
    customerId: Uuid.optional(),
    /** Marketing only, and only a link this company issued for this address. Made when left out. */
    unsubscribeUrl: z.string().url().max(2000).optional(),
  }),
  output: QueuedEmail,
});

export const EmailMessage = z.object({
  id: Uuid,
  to: z.string(),
  from: z.string(),
  subject: z.string().nullable(),
  purpose: z.string(),
  status: z.string(),
  providerMessageId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  sentAt: z.string().nullable(),
  /**
   * Null forever on anything sent through SMTP, and that is the protocol
   * rather than a gap in the record. `sendQueuedEmail` says so in words.
   */
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
});

export const listEmailMessages = defineRoute({
  method: "get",
  path: "/v1/email/messages",
  summary: "What has been sent, and what happened to it",
  module: "M18",
  permissions: ["message:read"],
  input: z.object({
    status: z.enum([
      "queued", "sending", "sent", "delivered", "undelivered", "failed", "received",
    ]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({ messages: z.array(EmailMessage) }),
});

export const sendQueuedEmail = defineRoute({
  method: "post",
  path: "/v1/email/send-queued",
  summary: "Hand the queue to the provider",
  description:
    "Oldest first, and each row is claimed with a conditional update before the provider is called, so a process that dies mid send leaves a message visibly stuck rather than one that quietly goes out twice. A retryable failure goes back to the queue and a permanent one stays failed: a 451 greylisting is the normal first answer from a well configured receiver, and treating it as permanent means a self hoster's first email to every new customer fails. Session authorized rather than background only, because a fresh self hosted install has no worker running yet and 'wait for a cron you have not set up' is not an answer.",
  module: "M18",
  permissions: ["message:send"],
  /**
   * A drain, and safe to ask for twice: the outbox claims each row before it
   * sends, so a second call finds nothing left to claim. Declared anyway
   * because the rule here is that every POST carries a key, and a route that
   * is an exception by reasoning rather than by declaration is one the next
   * person has to re-derive.
   */
  idempotent: true,
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({
    /** `webhook` or `none`. `none` means nothing after this point is knowable. */
    deliveryReporting: z.string(),
    deliveryNote: z.string().optional(),
    results: z.array(z.object({
      messageId: Uuid,
      status: z.enum(["sent", "failed", "skipped"]),
      reason: z.string().optional(),
    })),
  }),
});

export const Suppression = z.object({
  address: z.string(),
  /** Null is a blanket stop: every purpose, which is what a hard bounce means. */
  purpose: z.string().nullable(),
  reason: z.string(),
  suppressedAt: z.string(),
});

export const listEmailSuppressions = defineRoute({
  method: "get",
  path: "/v1/email/suppressions",
  summary: "Who this company can no longer email, and why",
  description:
    "The reason is on every row because somebody will have to decide a year from now whether lifting one is safe, and a hard bounce, a spam complaint and an operator marking a customer do-not-contact are three different answers to that question.",
  module: "M18",
  permissions: ["message:read"],
  input: z.object({ limit: z.number().int().min(1).max(500).optional() }),
  output: z.object({ suppressions: z.array(Suppression) }),
});

export const suppressEmailAddress = defineRoute({
  method: "post",
  path: "/v1/email/suppressions",
  summary: "Stop emailing an address",
  description:
    "Guarded by message:send rather than a settings permission, because it changes who this company can contact. A reason is required: a suppression nobody can explain is a customer nobody can email and nobody can decide about.",
  module: "M18",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({
    address: z.string().email().max(320),
    reason: z.string().min(1).max(500),
    /** Omit for a blanket stop across every purpose. */
    purpose: EmailPurpose.optional(),
  }),
  output: z.object({
    address: z.string(),
    suppressed: z.boolean(),
    alreadySuppressed: z.boolean(),
  }),
});

export const liftEmailSuppression = defineRoute({
  method: "delete",
  path: "/v1/email/suppressions/{address}",
  summary: "Take an address off the do-not-email list",
  description:
    "The only way off. Lifting rather than deleting, so the record that they were suppressed and why survives: a customer who hard bounced, moved mailbox and came back is a different story from one who was never on the list.",
  module: "M18",
  permissions: ["message:send"],
  input: z.object({ address: z.string().email().max(320) }),
  output: z.object({ address: z.string(), lifted: z.number().int() }),
});

/**
 * THE PROVIDER CALLBACK, AND THE RAW BODY PROBLEM
 *
 * A Svix signature, which is what Resend uses, is an HMAC over the exact
 * bytes of the request body. The generic dispatcher in `src/http/dispatch.ts`
 * reads the body with `request.text()`, `JSON.parse`s it and keeps only the
 * object, so a handler reached through it has no bytes to verify and
 * re-serializing the object changes key order and whitespace and breaks every
 * signature. The usual response to a check that never passes is to stop
 * checking, which for email means anyone on the internet can forge a hard
 * bounce, and a forged hard bounce writes a suppression: one unauthenticated
 * POST and a company cannot email that customer again.
 *
 * So this route takes the raw body and the signing headers as EXPLICIT INPUT,
 * and the deployment's own webhook mount forwards them, exactly as
 * `apps/web/src/app/api/webhooks/messaging/[token]/route.ts` already does for
 * the carrier. A provider cannot POST here directly, which is stated rather
 * than implied: the mount is the public URL, this is what the mount calls.
 *
 * Accepting headers from the caller does not weaken anything. A forger still
 * has to produce an HMAC keyed by a secret that never leaves the deployment,
 * and the timestamp tolerance still bounds a replay of a genuine one.
 *
 * `services/email.ts` also exports `receiveByToken` directly, which is what a
 * mount should call. This route exists so the endpoint appears in the OpenAPI
 * document, the handler registry and the permission matrix rather than
 * existing only inside one framework's routing folder.
 */
/**
 * THE PROVIDER WEBHOOK IS NOT DECLARED HERE, AND THAT IS DELIBERATE.
 *
 * It was, briefly. A Svix signature is an HMAC over the exact bytes of the
 * body, and this API's dispatcher parses the body to an object before a
 * handler sees it, so the route had to take `rawBody` and `headers` as
 * ordinary input fields. That works only if something trusted forwards them,
 * which means the published route describes a call a provider cannot
 * actually make: an OpenAPI document offering an endpoint that answers
 * nobody who reads it.
 *
 * So it follows the three provider webhooks this product already has, for
 * carriers, leads and payments. Each is a thin endpoint in the deployment
 * that reads the raw bytes and calls a service function directly, and the
 * fourth of them should not be a fourth design.
 *
 * `services/email.ts` exports `receiveByToken` for that endpoint to call.
 */

export const emailRoutes = {
  queueEmail, listEmailMessages, sendQueuedEmail,
  listEmailSuppressions, suppressEmailAddress, liftEmailSuppression,
} as const;
