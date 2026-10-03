import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { comms, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import { emit } from "./events";
import * as email from "./email";
import type { InboundEmail, WebhookRequest } from "../email/provider";

/**
 * A REPLY TO AN EMAIL, INTO THE THREAD IT ANSWERS
 *
 * Every email this product sends carries a Reply-To with its thread's token
 * in it (`reply+TOKEN@` the company's reply domain), and the company's
 * provider receives mail for that domain and posts each one here, signed.
 * The token decides the thread, not the sender's address: a customer who
 * replies from their work account instead of the home one still lands in the
 * conversation they are answering, and a stranger who happens to know the
 * customer's address does not land in it.
 *
 * In this order, and each step is a reason the next one can be trusted:
 *
 *   1. THE SIGNATURE, before the body is read for anything. An unverified
 *      endpoint lets anybody on the internet put words in a customer's
 *      mouth, in a thread the office will act on.
 *   2. ONCE. The provider retries a delivery it did not see acknowledged,
 *      and a retry is the same email, not a second one.
 *   3. NOT OUR OWN. Mail from the company's own sending address is its own
 *      message coming back (a forwarding loop, an alias), never a customer.
 *   4. THE THREAD, by token; by the sender's address when there is no token,
 *      which is somebody writing to the reply address fresh, a lead.
 *   5. THE WORDS, with the quoted history cut off, as plain text. The HTML
 *      is not kept: nothing here renders a customer's HTML, because a page
 *      that did would be running whatever they sent.
 *   6. AN AUTOMATIC REPLY is kept in the thread and announced to nothing. An
 *      out of office answering an invoice is not the customer writing back,
 *      and a workflow that answered it would start two machines emailing
 *      each other all weekend.
 */

export type InboundEmailOutcome =
  | { kind: "message"; messageId: string; conversationId: string; matchedBy: "token" | "address"; automatic: boolean }
  | { kind: "duplicate"; messageId: string }
  | { kind: "ignored"; reason: "own_address" | "no_sender" };

export type ReceiveOutcome =
  | { kind: "rejected"; reason: "unknown_token" | "not_supported" | "bad_signature" | "unparseable" | "body_unavailable" }
  | { kind: "recorded"; outcome: email.EventOutcome | InboundEmailOutcome };

function inboundActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "inbound-email" };
}

/**
 * Everything the email webhook receives: a delivery receipt, a bounce, or a
 * reply. One endpoint and one secret for all three, which is how the
 * provider sends them.
 */
export async function receiveByToken(
  db: Database,
  input: { token: string; url: string; headers: Record<string, string>; rawBody: string },
  readSecret?: email.ReadSecret,
): Promise<ReceiveOutcome> {
  const connection = await email.resolveWebhook(db, input.token, ...(readSecret ? [readSecret] : []));
  if (!connection) return { kind: "rejected", reason: "unknown_token" };
  const request: WebhookRequest = { url: input.url, headers: input.headers, body: input.rawBody };

  const inbound = connection.provider.inbound;
  const { delivery } = connection.provider;
  if (inbound?.kind === "webhook" && delivery.kind === "webhook") {
    if (!delivery.verify(request)) return { kind: "rejected", reason: "bad_signature" };
    const arrived = inbound.parse(request);
    if (arrived) {
      let message = arrived;
      if (message.text === null && message.html === null) {
        const body = await inbound.fetchBody(message.providerMessageId);
        /**
         * The words could not be fetched. A 503 has the provider deliver it
         * again later, which is the remedy for a provider having a bad
         * minute; storing a reply with no words would be a customer who said
         * nothing.
         */
        if (!body.ok) return { kind: "rejected", reason: "body_unavailable" };
        message = { ...message, text: body.text, html: body.html, headers: { ...message.headers, ...body.headers } };
      }
      return {
        kind: "recorded",
        outcome: await store(db, connection.organizationId, message, {
          replyDomain: email.replyDomainOf(connection.settings ?? {}),
        }),
      };
    }
  }
  return email.receive(db, connection, request);
}

/**
 * Store one reply. Exported for a provider that delivers in some other
 * shape, and for the tests, which drive it with an email already parsed.
 */
export async function store(
  db: Database,
  organizationId: string,
  arrived: InboundEmail,
  options: { replyDomain: string | null },
): Promise<InboundEmailOutcome> {
  const ctx: ServiceContext = { actor: inboundActor(organizationId), db };
  const sender = comms.bareAddress(arrived.from);
  if (!sender.includes("@")) return { kind: "ignored", reason: "no_sender" };

  return inTenant(ctx, async (tx) => {
    /**
     * Serialised on the provider's id, so two deliveries of one email that
     * arrive together cannot both pass the check below and both insert.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`inbound-email:${organizationId}:${arrived.providerMessageId}`}))`);
    const [seen] = await tx.select({ id: schema.message.id }).from(schema.message)
      .where(and(
        eq(schema.message.organizationId, organizationId),
        eq(schema.message.channel, "email"),
        eq(schema.message.direction, "inbound"),
        eq(schema.message.providerMessageId, arrived.providerMessageId),
      )).limit(1);
    if (seen) return { kind: "duplicate", messageId: seen.id } as const;

    const ours = await email.senderFor(tx, organizationId);
    if (ours && comms.bareAddress(ours.fromAddress) === sender) return { kind: "ignored", reason: "own_address" } as const;

    const token = comms.replyTokenIn([...arrived.to, ...arrived.cc], options.replyDomain);
    const [byToken] = token
      ? await tx.select({ id: schema.conversation.id }).from(schema.conversation)
        .where(and(
          eq(schema.conversation.organizationId, organizationId),
          eq(schema.conversation.channel, "email"),
          eq(schema.conversation.replyToken, token),
        )).limit(1)
      : [];
    const recipient = comms.bareAddress(arrived.to[0] ?? ours?.fromAddress ?? "");
    const conversationId = byToken?.id ?? await email.threadFor(tx, {
      organizationId,
      address: sender,
      internalAddress: recipient,
      subject: arrived.subject.trim() || "(no subject)",
    });

    const text = arrived.text ?? (arrived.html ? comms.textFromHtml(arrived.html) : "");
    const { reply } = comms.stripQuotedReply(text);
    const automatic = comms.isAutomaticReply(arrived.headers);
    const now = new Date();

    const kept: Record<string, string> = {};
    for (const name of ["message-id", "in-reply-to", "auto-submitted"]) {
      if (arrived.headers[name]) kept[name] = arrived.headers[name]!.slice(0, 500);
    }

    const [stored] = await tx.insert(schema.message).values({
      organizationId,
      conversationId,
      direction: "inbound",
      channel: "email",
      purpose: "transactional",
      fromAddress: sender,
      toAddress: recipient,
      subject: arrived.subject.trim() || null,
      body: reply,
      headers: kept,
      /**
       * The names of the files that came with it, so the thread can say a
       * photograph was attached rather than showing nothing where it was.
       * The files themselves are not fetched; see the module doc.
       */
      media: arrived.attachments.map((a) => ({
        url: "", contentType: a.contentType,
        refused: `${a.fileName} came with this email and is not kept here. It is in the email at your provider.`,
      })),
      status: "received",
      providerMessageId: arrived.providerMessageId,
      /** An automatic reply is read already, so it never sits in the unread count. */
      readAt: automatic ? now : null,
    }).returning({ id: schema.message.id });

    if (!automatic) {
      await tx.update(schema.conversation).set({
        lastMessageAt: now,
        lastMessagePreview: (reply || arrived.subject).slice(0, 200),
        /** Reopened: a reply landing in a closed thread is a reply nobody sees. */
        status: "open",
        updatedAt: now,
      }).where(eq(schema.conversation.id, conversationId));

      await emit(tx, ctx, {
        name: "message.received", entityType: "conversation", entityId: conversationId,
        payload: {
          messageId: stored!.id, conversationId, from: sender, body: reply, channel: "email",
          subject: arrived.subject,
        },
      });
    }

    return {
      kind: "message", messageId: stored!.id, conversationId,
      matchedBy: byToken ? "token" : "address", automatic,
    } as const;
  });
}
