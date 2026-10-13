import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { comms, files as fileRules, marketplaces as mp, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import { ConflictError, inTenant, type ServiceContext } from "./context";
import * as files from "./files";
import { emit } from "./events";
import * as email from "./email";
import * as leadEmails from "./lead-emails";
import type { InboundAttachment, InboundEmail, InboundFeedback, WebhookRequest } from "../email/provider";

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
 *      is kept only as text (`html_text`), with its tags, scripts and styles
 *      gone: nothing here renders a customer's HTML, because a page that did
 *      would be running whatever they sent.
 *   6. THE FILES, fetched from the provider before the transaction (an HTTP
 *      call never holds a database connection open) and kept in the
 *      company's own file store, attached to the message: only the types
 *      kept everywhere here, decided from the bytes, never a program, and no
 *      more than core's `EMAIL_ATTACHMENTS` limits. The rest are named in the
 *      thread with the reason.
 *   7. AN AUTOMATIC REPLY is kept in the thread and announced to nothing. An
 *      out of office answering an invoice is not the customer writing back,
 *      and a workflow that answered it would start two machines emailing
 *      each other all weekend.
 */

export type InboundEmailOutcome =
  | { kind: "message"; messageId: string; conversationId: string; matchedBy: "token" | "address"; automatic: boolean }
  /** Sent to the company's lead inbox: a marketplace's lead email, read into a lead offer. */
  | { kind: "lead_email"; outcome: leadEmails.LeadEmailOutcome }
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
      /**
       * An email to the lead inbox (`leads+TOKEN@` the receiving domain) is a
       * marketplace's lead notice somebody forwarded, not a customer writing
       * in a thread. The token has to be this company's, so a forwarded email
       * cannot be aimed at another company that shares the domain.
       */
      const replyDomain = email.replyDomainOf(connection.settings ?? {});
      /**
       * A mailbox's forwarding rule keeps the original To line, so the lead
       * inbox is often only in the envelope headers the receiving server
       * adds; those are read too.
       */
      const envelope = ["delivered-to", "x-original-to", "x-forwarded-to", "envelope-to"]
        .map((name) => message.headers[name]).filter((value): value is string => typeof value === "string");
      const leadToken = mp.leadInboxTokenIn([...message.to, ...message.cc, ...envelope], replyDomain);
      if (leadToken && await leadEmails.organizationForToken(db, leadToken) === connection.organizationId) {
        return {
          kind: "recorded",
          outcome: { kind: "lead_email", outcome: await leadEmails.receive(db, connection.organizationId, message) },
        };
      }
      /** A lead email's files are not wanted, so they are fetched only for a reply. */
      message = { ...message, attachments: await fetchAttachments(inbound, message) };
      return {
        kind: "recorded",
        outcome: await store(db, connection.organizationId, message, { replyDomain }),
      };
    }
  }
  return email.receive(db, connection, request);
}

/**
 * The bytes of the files worth fetching, one at a time and each no larger
 * than a file may be. The rest keep only their names. A file that could not
 * be fetched does not hold the reply back: the customer's words are kept and
 * the thread says the file is still at the provider.
 */
async function fetchAttachments(
  inbound: Extract<InboundFeedback, { kind: "webhook" }>, message: InboundEmail,
): Promise<InboundAttachment[]> {
  const plan = fileRules.planEmailAttachments(message.attachments);
  const out: InboundAttachment[] = [];
  for (const [i, attachment] of message.attachments.entries()) {
    if (!plan[i]!.fetch || !inbound.fetchAttachment) { out.push(attachment); continue; }
    const fetched = await inbound.fetchAttachment(message.providerMessageId, attachment, fileRules.EMAIL_ATTACHMENTS.maxFileBytes);
    out.push(fetched.ok
      ? { ...attachment, bytes: fetched.bytes, size: fetched.size ?? fetched.bytes.length }
      : fetched.tooLarge
        ? { ...attachment, size: fileRules.EMAIL_ATTACHMENTS.maxFileBytes + 1 }
        : { ...attachment, unavailable: fetched.message });
  }
  return out;
}

type Media = NonNullable<(typeof schema.message.$inferInsert)["media"]>;

/**
 * What each file on a reply becomes: kept as a stored file, or named with the
 * reason it was not. The limits are decided again here from what arrived,
 * not trusted from the fetch, so a provider that delivers in some other shape
 * (or a test) is held to them too.
 */
async function keepAttachments(
  tx: Database, organizationId: string, attachments: readonly InboundAttachment[],
): Promise<{ media: Media; kept: { storageKey: string; contentType: string; sizeBytes: number; name: string }[] }> {
  const plan = fileRules.planEmailAttachments(attachments);
  const media: Media = [];
  const kept: { storageKey: string; contentType: string; sizeBytes: number; name: string }[] = [];
  let bytesKept = 0;
  for (const [i, attachment] of attachments.entries()) {
    const name = fileRules.displayName(attachment.fileName);
    const step = plan[i]!;
    if (!step.fetch) { media.push({ url: "", contentType: attachment.contentType, name, refused: step.refused }); continue; }
    if (!attachment.bytes) {
      media.push({
        url: "", contentType: attachment.contentType, name,
        refused: attachment.unavailable
          ? `${name} came with this email and could not be fetched (${attachment.unavailable}). It is in the email at your provider.`
          : `${name} came with this email and is not kept here. It is in the email at your provider.`,
      });
      continue;
    }
    const verdict = fileRules.checkEmailAttachment(
      { fileName: attachment.fileName, contentType: attachment.contentType, bytes: attachment.bytes },
      { bytesAlreadyKept: bytesKept },
    );
    if (!verdict.ok) { media.push({ url: "", contentType: attachment.contentType, name, refused: verdict.reason }); continue; }
    try {
      const { file } = await files.put(tx, organizationId, {
        bytes: attachment.bytes, claimedType: attachment.contentType, maxBytes: fileRules.EMAIL_ATTACHMENTS.maxFileBytes,
      });
      bytesKept += file.sizeBytes;
      media.push({ url: "", contentType: file.contentType, bytes: file.sizeBytes, storageKey: file.storageKey, name });
      kept.push({ storageKey: file.storageKey, contentType: file.contentType, sizeBytes: file.sizeBytes, name });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      media.push({ url: "", contentType: attachment.contentType, name, refused: `${name} came with this email and was not kept. ${error.message}` });
    }
  }
  return { media, kept };
}

/** The HTML's words as plain text, or null for none; never the HTML itself. */
function htmlAsText(html: string | null): string | null {
  if (!html) return null;
  const text = comms.textFromHtml(html).trim();
  return text === "" ? null : text.slice(0, 100_000);
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
    /**
     * Written down however it was recognised, so the thread can tell an out
     * of office from the customer later (its subject is not the one a reply
     * should answer under).
     */
    if (automatic && !kept["auto-submitted"]) kept["auto-submitted"] = "auto-replied";

    const { media, kept: keptFiles } = await keepAttachments(tx, organizationId, arrived.attachments);

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
      /** Never the HTML: its words, as text, so nothing can render it. */
      htmlText: htmlAsText(arrived.html),
      headers: kept,
      /**
       * Every file that came with it: the kept ones with their storage key
       * and name, the others named with the reason, so the thread never
       * shows nothing where a photograph was.
       */
      media,
      status: "received",
      providerMessageId: arrived.providerMessageId,
      /** An automatic reply is read already, so it never sits in the unread count. */
      readAt: automatic ? now : null,
    }).returning({ id: schema.message.id });

    for (const file of keptFiles) {
      await files.attach(tx, organizationId, {
        entityType: "message", entityId: stored!.id, storageKey: file.storageKey, kind: "email_attachment",
        fileName: file.name, contentType: file.contentType, sizeBytes: file.sizeBytes,
      });
    }

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
