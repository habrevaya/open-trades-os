import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { comms, SYSTEM_USER_ID, type Actor, type Permission } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, type ServiceContext,
} from "./context";
import { claim } from "./comms-outbox";
import { readerFor } from "../secrets/store";
import {
  createEmailProvider, EmailProviderNotConfiguredError,
  type EmailEvent, type EmailProvider, type ProviderSecrets, type WebhookRequest,
} from "../email/provider";

/**
 * SENDING EMAIL
 *
 * The SMS outbox, one channel over, and deliberately the same shape: queue a
 * row, claim it before the provider is called, record what came back. The
 * reasoning in `comms-outbox.ts` applies unchanged and is not repeated here.
 * What follows is only what email does differently, because those differences
 * are where a mail system goes wrong.
 *
 * CONSENT. Email reuses `comms.canSend` rather than reimplementing it, and
 * that is a decision with a cost worth stating.
 *
 * Under CAN-SPAM, US commercial email needs NO prior opt in. It needs a
 * working unsubscribe, a physical postal address, and honest headers. So
 * requiring a granted consent row before a marketing email is STRICTER THAN
 * US LAW, and this product does it anyway, for three reasons. It is what
 * Canada (CASL) and the EU (GDPR plus ePrivacy) require, and a self hosted
 * product cannot know which of those its operator is under. It is what Gmail
 * and Yahoo's bulk sender rules effectively enforce through complaint rate
 * whatever the statute says. And the alternative is two consent models in one
 * codebase, where the SMS one is the strict one and the email one is the
 * loose one, and every future feature has to remember which channel it is on.
 *
 * Transactional email is implied by the work, exactly as a transactional text
 * is: an invoice, an estimate and an appointment confirmation go without a
 * consent row, and an explicit revocation or a suppression still stops them.
 *
 * THE UNSUBSCRIBE. A marketing email is refused without an unsubscribe URL,
 * and the header goes on for real. The URL is still the caller's to supply,
 * and `services/unsubscribe.ts` is now what serves one: a token addressed page
 * where GET describes and POST acts, so a link prefetcher, a corporate mail
 * scanner or a chat client rendering a preview cannot opt somebody out. This
 * paragraph used to say the product hosted no such page, which it did not when
 * the gate was written and does now.
 *
 * What is NOT closed, and the reason this note still exists: nothing checks
 * that the URL handed in points at that page. A caller can satisfy the gate
 * with any string, including a 404, so a company can still look compliant,
 * pass its own check and keep emailing people who asked it to stop.
 *
 * THE SUPPRESSION LIST is the existing `suppression` table, not a new one. It
 * already keys on address plus channel plus purpose, already has the partial
 * unique indexes that make a live blanket suppression singular, and is
 * already what `canSend` consults. A second table for email would be a second
 * place to forget to check, which is the failure `comms-send.ts` exists to
 * prevent.
 */

/** Everything this module does is about one channel. Named once. */
const CHANNEL = "email" as const;

/**
 * The worker's authority, stated rather than assumed.
 *
 * `comms-outbox.ts` gives its worker no grants and skips the permission check
 * by calling `inTenant` directly. That works and it means the outbox's
 * authority is invisible: nothing in the code says what a background sender is
 * allowed to do. Here the worker holds exactly two named permissions and every
 * path goes through `guardedWrite` or `guardedRead`, so removing `message:send`
 * from this list stops the sender, which is what an operator reading it would
 * expect it to mean.
 */
const WORKER_GRANTS: Permission[] = ["message:send", "message:read"];

function workerActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: WORKER_GRANTS,
    agentId: "email-outbox",
  };
}

const workerContext = (db: Database, organizationId: string): ServiceContext =>
  ({ actor: workerActor(organizationId), db });

/* ------------------------------------------------------- sending identity */

export interface EmailSender {
  connectionId: string;
  provider: string;
  fromAddress: string;
  fromName: string | null;
  /**
   * Domains the operator says they have verified with their provider, from
   * the connection settings. Empty means they have declared nothing.
   */
  verifiedDomains: string[];
  credentialRef: string | null;
  settings: Record<string, unknown>;
  /**
   * The domain replies come back on, when the operator set one up with
   * their provider: every email then carries `reply+TOKEN@` this as its
   * Reply-To, and a reply lands in the thread it answers. Null otherwise,
   * and a reply goes wherever the From address goes, as it always did.
   */
  replyDomain: string | null;
}

function stringSetting(settings: Record<string, unknown>, key: string): string | null {
  const value = settings[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Which connection this company's email leaves through, and what it sends as.
 *
 * One connected email provider per organization, which is what the unique
 * index on `integration_connection` already allows per provider and what an
 * operator means when they connect one. A company with two would be a company
 * whose customers hear from two different From addresses at random, so the
 * oldest connected one wins and the choice is deterministic rather than
 * whatever the planner returned.
 */
export async function senderFor(
  tx: Database,
  organizationId: string,
): Promise<EmailSender | null> {
  const [connection] = await tx.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.capability, CHANNEL),
      eq(schema.integrationConnection.status, "connected"),
    ))
    .orderBy(asc(schema.integrationConnection.createdAt))
    .limit(1);

  if (!connection) return null;

  const fromAddress = stringSetting(connection.settings, "fromAddress");
  /**
   * A connection with no From address cannot send, and saying so here rather
   * than defaulting to something is deliberate. Every plausible default is a
   * guess at a domain the operator may not control, and mail from a domain
   * you do not control is what gets a sending reputation destroyed.
   */
  if (!fromAddress) return null;

  const declared = connection.settings["verifiedDomains"];
  return {
    connectionId: connection.id,
    provider: connection.provider,
    fromAddress,
    fromName: stringSetting(connection.settings, "fromName"),
    verifiedDomains: Array.isArray(declared)
      ? declared.filter((d): d is string => typeof d === "string").map((d) => d.toLowerCase())
      : [],
    credentialRef: connection.credentialRef,
    settings: connection.settings,
    replyDomain: replyDomainOf(connection.settings),
  };
}

/**
 * The reply domain, when it is one. A typed value that is not a domain is
 * ignored rather than used, because a Reply-To on a domain nothing receives
 * for bounces every reply back to the customer.
 */
export function replyDomainOf(settings: Record<string, unknown>): string | null {
  const typed = stringSetting(settings, "replyDomain");
  if (!typed) return null;
  const checked = comms.checkReplyDomain(typed);
  return checked.ok ? checked.domain : null;
}

/**
 * The thread's reply token, minted the first time anything is sent on it.
 *
 * Minted rather than derived from the conversation id, so it can be
 * replaced if it ever leaks (a customer forwarding the email to a stranger
 * hands them a way into the thread) without changing the thread.
 */
export async function replyTokenFor(tx: Database, conversationId: string): Promise<string> {
  const minted = randomBytes(24).toString("base64url");
  const [row] = await tx.update(schema.conversation)
    .set({ replyToken: sql`coalesce(${schema.conversation.replyToken}, ${minted})` })
    .where(eq(schema.conversation.id, conversationId))
    .returning({ token: schema.conversation.replyToken });
  return row?.token ?? minted;
}

const domainOf = (address: string): string => (address.split("@")[1] ?? "").toLowerCase();

/**
 * Whether this company may send email at all, as `canSend` means it.
 *
 * For SMS, `channelRegistered` is a fact a carrier asserts and we store: the
 * brand and campaign were approved or they were not. EMAIL HAS NO SUCH FACT
 * we can read without calling the provider, so this is weaker and the
 * difference is worth being blunt about. It answers two things only: is there
 * a connected provider with a From address, and if the operator has declared
 * which domains they verified, is the From one of them. It does NOT prove SPF,
 * DKIM or DMARC are in place. An operator who gets those wrong will find out
 * from their bounce rate, not from here.
 *
 * The declared list is opt in because the generic SMTP path has no concept of
 * a verified domain at all. Requiring one would make the adapter that exists
 * to free a self hoster from vendors the one adapter they cannot use.
 */
function channelRegistered(sender: EmailSender | null): boolean {
  if (!sender) return false;
  if (sender.verifiedDomains.length === 0) return true;
  return sender.verifiedDomains.includes(domainOf(sender.fromAddress));
}

/* -------------------------------------------------------------- decisions */

export type EmailPurpose = "transactional" | "marketing";

/**
 * Whether this address can be emailed right now, and what to send as.
 *
 * Exported for the same reason `sendability` is on the SMS side: a screen
 * that wants to grey out a button has to ask the same question the sender
 * asks, and asking it twice in two ways is how the answers diverge.
 */
export async function emailability(
  tx: Database,
  organizationId: string,
  address: string,
  purpose: EmailPurpose,
) {
  const sender = await senderFor(tx, organizationId);
  const normalized = normalizeAddress(address);

  const consents = await tx.select().from(schema.communicationConsent)
    .where(and(
      eq(schema.communicationConsent.organizationId, organizationId),
      eq(schema.communicationConsent.address, normalized),
      isNull(schema.communicationConsent.supersededAt),
    ));

  const suppressions = await tx.select().from(schema.suppression)
    .where(and(
      eq(schema.suppression.organizationId, organizationId),
      eq(schema.suppression.address, normalized),
      isNull(schema.suppression.liftedAt),
    ));

  const decision = comms.canSend({
    channel: CHANNEL,
    purpose,
    consents: consents.map((c) => ({
      /**
       * The row id rides along on the record `canSend` hands back, so the
       * message can record WHICH consent permitted it. `ConsentRecord` in
       * core has no id, because core is pure and knows nothing about rows,
       * and `currentConsent` returns the same object it was given, so the id
       * survives the round trip. Without this the `consent_id` column on
       * every email would be null and an audit could not answer the only
       * question it is for.
       */
      id: c.id,
      channel: c.channel as comms.Channel,
      purpose: c.purpose as comms.Purpose,
      state: c.state as comms.ConsentState,
      capturedAt: c.capturedAt,
      supersededAt: c.supersededAt,
    })),
    suppressions: suppressions.map((s) => ({
      channel: s.channel as comms.Channel,
      purpose: s.purpose as comms.Purpose | null,
      liftedAt: s.liftedAt,
    })),
    channelRegistered: channelRegistered(sender),
  });

  return { ...decision, sender };
}

/**
 * The refusal in words an operator can act on.
 *
 * Every reason `canSend` can return has a line here, including
 * `consent_revoked`. The SMS version of this function answers "revoked",
 * which `canSend` has never returned, so a withdrawn consent falls through to
 * its default branch and an operator is shown the raw enum value.
 */
export function refusal(reason: string | undefined): string {
  switch (reason) {
    case "suppressed":
      return "This address is on the do-not-email list. It bounced, complained, or asked to stop.";
    case "consent_revoked":
      return "They withdrew consent for email.";
    case "no_consent":
      return "No marketing consent on record for this address.";
    case "channel_not_registered":
      return "No email provider is connected with a From address, or the From address is not on "
        + "the verified domain list. Connect one before sending.";
    case "quiet_hours":
      return "Outside the hours this customer may be contacted.";
    default:
      return reason ? `Cannot send: ${reason}` : "Cannot email this address.";
  }
}

/**
 * Lowercased and trimmed, and nothing cleverer than that.
 *
 * The local part of an address is case sensitive per RFC 5321 and no
 * significant mail host has treated it that way in twenty years, so matching
 * a suppression case sensitively would let "STOP@example.com" through after
 * "stop@example.com" asked not to be written to. Dots and plus tags are left
 * alone on purpose: stripping them is a Gmail convention, and applying it to
 * every domain silently merges addresses that are genuinely different people.
 */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/* ----------------------------------------------------------------- queue */

export interface QueueEmailInput {
  to: string;
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
  replyTo?: string | undefined;
  purpose?: EmailPurpose | undefined;
  customerId?: string | null | undefined;
  /**
   * Where a recipient goes to stop. Required for marketing, ignored for
   * transactional: an unsubscribe link on an invoice offers a choice the
   * company cannot honour, since it still has to send the next invoice.
   */
  unsubscribeUrl?: string | undefined;
  headers?: Record<string, string> | undefined;
  /**
   * Files that go with it, kept beside the message so a retry sends the same
   * file the first attempt would have. A few hundred kilobytes at most: this
   * is a report's CSV, not a photograph library.
   */
  attachments?: { filename: string; contentType: string; content: Buffer }[] | undefined;
}

/**
 * A ceiling on what one email carries, well under what every provider takes.
 *
 * Resend refuses a message over 40MB and most receiving servers refuse far
 * less; a spreadsheet of a thousand report rows is tens of kilobytes. Anything
 * near this is a mistake in the calling code, and saying so here is better
 * than a provider refusing it at three in the morning.
 */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export type QueueOutcome =
  | { queued: true; messageId: string; conversationId: string }
  | { queued: false; reason: string; explanation: string };

/**
 * Put one email in the outbox, or say why it cannot go.
 *
 * A refusal is returned rather than thrown, for the same reason the SMS
 * sender returns one: "they asked us to stop" is an answer, not an error, and
 * throwing would roll back whatever business fact the caller was in the
 * middle of recording. Malformed input DOES throw, because an email with no
 * subject is a mistake in the calling code rather than a fact about a
 * recipient.
 *
 * QUEUED, never sent. The row says `queued` and nothing claims otherwise
 * until a provider has accepted it.
 */
export function queue(ctx: ServiceContext, input: QueueEmailInput): Promise<QueueOutcome> {
  return guardedWrite(ctx, "message:send", (tx) => queueIn(tx, ctx, input));
}

/**
 * The same, inside a transaction somebody else opened: the inbox replying to
 * an email thread, which checks its own scope and idempotency around it.
 * The caller must already have passed a `message:send` guard.
 */
export async function queueIn(tx: Database, ctx: ServiceContext, input: QueueEmailInput): Promise<QueueOutcome> {
  const purpose: EmailPurpose = input.purpose ?? "transactional";
  const to = normalizeAddress(input.to);
  const subject = input.subject.trim();
  const text = input.text?.trim() ?? "";
  const html = input.html?.trim() ?? "";

  if (to === "" || !to.includes("@")) {
    throw new ConflictError("That is not an email address.");
  }
  if (subject === "") {
    /**
     * A blank subject line is one of the oldest spam signatures there is
     * and several filters score on it directly. Refusing costs a caller one
     * line; sending it costs the whole domain a little reputation each time.
     */
    throw new ConflictError("An email needs a subject. A blank one is scored as spam.");
  }
  if (text === "" && html === "") {
    throw new ConflictError("An email needs a body.");
  }
  if (html !== "" && text === "") {
    /**
     * HTML with no plain text alternative is the single strongest content
     * signal a spam filter has short of the words themselves, and it is
     * also what a screen reader and a watch face fall back to. Generating
     * the text part by stripping tags would produce something unreadable
     * and claim it was an alternative, so the caller writes it.
     */
    throw new ConflictError(
      "An HTML email needs a plain text alternative. Sending HTML alone is scored as spam "
      + "and is what anyone reading in plain text receives.",
    );
  }
  const files = input.attachments ?? [];
  const bytes = files.reduce((total, file) => total + file.content.length, 0);
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new ConflictError("The files on this email are too large to send. Keep them under 5MB together.");
  }
  if (files.some((file) => file.filename.trim() === "" || /[\\/]/.test(file.filename))) {
    // A path in a filename is a file somebody's mail client saves somewhere it should not.
    throw new ConflictError("An attachment needs a plain file name.");
  }

  if (purpose === "marketing" && !input.unsubscribeUrl) {
    /**
     * Not a style rule. CAN-SPAM requires a working opt out on commercial
     * email, and Gmail and Yahoo both require one click unsubscribe from
     * bulk senders. A marketing send without one is a compliance breach at
     * the moment it leaves, and the only place that can be stopped is here.
     */
    throw new ConflictError(
      "A marketing email needs an unsubscribe URL. Sending commercial email without a working "
      + "opt out breaks CAN-SPAM and the bulk sender rules at Gmail and Yahoo.",
    );
  }

  const decision = await emailability(tx, ctx.actor.organizationId, to, purpose);
  if (!decision.allowed || !decision.sender) {
    const reason = decision.allowed ? "channel_not_registered" : decision.reason;
    return { queued: false, reason, explanation: refusal(reason) };
  }

  const sender = decision.sender;
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  if (input.replyTo) headers["Reply-To"] = input.replyTo;
  if (purpose === "marketing" && input.unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${input.unsubscribeUrl}>`;
    /**
     * The second header is what makes the first one count. Without
     * `List-Unsubscribe-Post`, Gmail shows no unsubscribe control and the
     * recipient's only way out is the spam button, which is the outcome the
     * header exists to avoid.
     */
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const conversationId = await threadFor(tx, {
    organizationId: ctx.actor.organizationId,
    address: to,
    internalAddress: sender.fromAddress,
    subject,
    customerId: input.customerId ?? null,
  });

  /**
   * WHERE A REPLY GOES. A caller that named a Reply-To chose it, and it
   * stands. Otherwise, when the company has a reply domain, the reply
   * address carries this thread's token, so the customer pressing reply
   * puts their answer in this thread in the inbox rather than in a
   * mailbox nobody here reads.
   */
  if (!input.replyTo && sender.replyDomain) {
    headers["Reply-To"] = comms.replyAddress(await replyTokenFor(tx, conversationId), sender.replyDomain);
  }

  const [row] = await tx.insert(schema.message).values({
    organizationId: ctx.actor.organizationId,
    conversationId,
    direction: "outbound",
    channel: CHANNEL,
    purpose,
    fromAddress: sender.fromAddress,
    toAddress: to,
    subject,
    body: text === "" ? null : text,
    bodyHtml: html === "" ? null : html,
    headers,
    status: "queued",
    /**
     * Which consent row permitted this. Null when the send rests on
     * transactional implication, and that nullability is the point: a
     * marketing message with no consent id is exactly what an audit needs
     * to be able to find.
     */
    consentId: decision.allowed && decision.consent ? consentIdFor(decision.consent) : null,
    sentByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
  }).returning({ id: schema.message.id });

  const message = row!;

  if (files.length > 0) {
    await tx.insert(schema.messageAttachment).values(files.map((file) => ({
      organizationId: ctx.actor.organizationId,
      messageId: message.id,
      fileName: file.filename.trim(),
      contentType: file.contentType,
      content: file.content,
      sizeBytes: file.content.length,
    })));
  }

  await tx.update(schema.conversation).set({
    lastMessageAt: new Date(),
    lastMessagePreview: subject.slice(0, 200),
    status: "open",
    updatedAt: new Date(),
  }).where(eq(schema.conversation.id, conversationId));

  await audit(tx, ctx, "email.queued", "message", message.id, null, {
    to, subject, purpose, from: sender.fromAddress,
  });

  return { queued: true, messageId: message.id, conversationId };
}

/**
 * `canSend` hands back the consent RECORD it used rather than a row id,
 * because it is pure and knows nothing about the database. `emailability`
 * attaches the id on the way in and core passes the object through
 * untouched, so this reads it back off. It is defensive about the type
 * rather than casting, because a future change in core that copies the
 * record instead of returning it would otherwise turn a null id into a
 * silently wrong one.
 */
function consentIdFor(consent: comms.ConsentRecord & { id?: string }): string | null {
  return typeof consent.id === "string" ? consent.id : null;
}

/**
 * The thread this belongs to.
 *
 * By address, matching the SMS side, so a customer who texts and emails has
 * two threads on one timeline rather than four. Scoped to the email channel
 * because the external address for one is a phone number and for the other is
 * a mailbox, and a company whose customer's phone number is also their email
 * address does not exist.
 */
export async function threadFor(tx: Database, input: {
  organizationId: string;
  address: string;
  internalAddress: string;
  subject: string;
  customerId?: string | null;
}): Promise<string> {
  const [existing] = await tx.select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(and(
      eq(schema.conversation.organizationId, input.organizationId),
      eq(schema.conversation.channel, CHANNEL),
      eq(schema.conversation.externalAddress, input.address),
      isNull(schema.conversation.deletedAt),
    ))
    .orderBy(desc(schema.conversation.createdAt))
    .limit(1);
  if (existing) return existing.id;

  /**
   * The caller's customer wins over the lookup, for the same reason it does
   * on the SMS side: an outbound invoice already knows whose it is, and
   * matching on the address would attach the thread to whoever happens to
   * hold that mailbox on their customer record.
   */
  let customerId = input.customerId ?? null;
  if (!customerId) {
    const [found] = await tx.select({ id: schema.customer.id })
      .from(schema.customer)
      .where(and(
        eq(schema.customer.email, input.address),
        isNull(schema.customer.deletedAt),
      ))
      .limit(1);
    customerId = found?.id ?? null;
  }

  const [created] = await tx.insert(schema.conversation).values({
    organizationId: input.organizationId,
    channel: CHANNEL,
    externalAddress: input.address,
    internalAddress: input.internalAddress,
    subject: input.subject,
    customerId,
    status: "open",
  }).returning({ id: schema.conversation.id });
  return created!.id;
}

/* ----------------------------------------------------------------- flush */

export interface SendOutcome {
  messageId: string;
  status: "sent" | "failed" | "skipped";
  reason?: string;
}

export interface FlushDeps {
  /** Injected so a test never reaches a provider and a deployment never fakes one. */
  provider: EmailProvider;
}

/**
 * Send everything queued for one organization.
 *
 * Oldest first, and the row is CLAIMED before the provider is called, using
 * the same conditional update the SMS outbox uses. It is imported rather than
 * copied: two claim implementations against one table is two chances to get
 * the lock wrong, and the second one written is always the one that forgets
 * the `status = 'queued'` predicate that makes it a lock at all.
 */
export async function flush(
  db: Database,
  organizationId: string,
  deps: FlushDeps,
  limit = 50,
): Promise<SendOutcome[]> {
  const ctx = workerContext(db, organizationId);

  const pending = await guardedRead(ctx, "message:read", async (tx) =>
    tx.select({
      id: schema.message.id,
      to: schema.message.toAddress,
      from: schema.message.fromAddress,
      subject: schema.message.subject,
      body: schema.message.body,
      bodyHtml: schema.message.bodyHtml,
      headers: schema.message.headers,
    })
      .from(schema.message)
      .where(and(
        eq(schema.message.status, "queued"),
        eq(schema.message.direction, "outbound"),
        /**
         * Scoped to this channel, which the SMS outbox now does too. Without
         * it each outbox drains the other's queue and hands a customer's
         * email to a carrier as the body of a text.
         */
        eq(schema.message.channel, CHANNEL),
      ))
      .orderBy(asc(schema.message.createdAt))
      .limit(limit));

  const outcomes: SendOutcome[] = [];

  for (const row of pending) {
    const mine = await guardedWrite(ctx, "message:send", async (tx) => claim(tx, row.id));
    if (!mine) {
      outcomes.push({ messageId: row.id, status: "skipped", reason: "claimed_elsewhere" });
      continue;
    }

    /**
     * Reply-To comes back out of the stored headers and goes to the provider
     * as its own field. It is stored as a header because that is what it is,
     * and surfaced separately because every provider API models it
     * separately. Sending it in both places would put two Reply-To headers on
     * the message, which receivers resolve inconsistently.
     */
    const stored: Record<string, string> = { ...(row.headers ?? {}) };
    const replyTo = stored["Reply-To"];
    delete stored["Reply-To"];

    const files = await guardedRead(ctx, "message:read", async (tx) =>
      tx.select({
        filename: schema.messageAttachment.fileName,
        contentType: schema.messageAttachment.contentType,
        content: schema.messageAttachment.content,
      }).from(schema.messageAttachment)
        .where(eq(schema.messageAttachment.messageId, row.id))
        .orderBy(asc(schema.messageAttachment.createdAt)));

    const result = await deps.provider.send({
      to: row.to,
      from: row.from,
      subject: row.subject ?? "",
      ...(row.body ? { text: row.body } : {}),
      ...(row.bodyHtml ? { html: row.bodyHtml } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(Object.keys(stored).length > 0 ? { headers: stored } : {}),
      ...(files.length > 0 ? { attachments: files } : {}),
      reference: row.id,
    });

    await guardedWrite(ctx, "message:send", async (tx) => {
      if (result.ok) {
        await tx.update(schema.message).set({
          /**
           * `sent`, not `delivered`. The provider has accepted it and nothing
           * more is known. For an SMTP relay nothing more will EVER be known,
           * which is why the provider says so in its `delivery` field rather
           * than leaving an operator to infer it from an empty column.
           */
          status: "sent",
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(schema.message.id, row.id));
      } else {
        await tx.update(schema.message).set({
          /**
           * A retryable failure goes back to `queued`. A 451 greylisting from
           * a well configured receiver is the normal first answer to mail
           * from a domain it has not seen, and treating it as permanent
           * means a self hoster's first email to every new customer fails.
           */
          status: result.retryable ? "queued" : "failed",
          errorCode: result.code,
          errorMessage: result.message,
          updatedAt: new Date(),
        }).where(eq(schema.message.id, row.id));
      }
    });

    outcomes.push(result.ok
      ? { messageId: row.id, status: "sent" }
      : { messageId: row.id, status: "failed", reason: result.code });
  }

  return outcomes;
}

/* -------------------------------------------------------- delivery events */

/**
 * Where a status may move to.
 *
 * Callbacks arrive out of order, and a `sent` landing after a `delivered`
 * must not move the message backwards or a support screen shows "sending"
 * for mail that arrived an hour ago.
 */
const RANK: Record<string, number> = {
  queued: 0, sending: 1, sent: 2,
  delivered: 3, undelivered: 3, failed: 3, received: 3,
};

export type EventOutcome =
  | { recorded: false; reason: "unknown_message" | "out_of_order" | "no_status_change" }
  | { recorded: true; messageId: string; status: string; suppressed: boolean };

/**
 * Record a delivery, bounce or complaint.
 *
 * Matched on our own reference when the provider carried it back, and on the
 * provider's id otherwise. Both, because a callback can arrive before the
 * send's own write commits, and then the provider id is not in the table yet.
 */
export async function recordEvent(
  db: Database,
  organizationId: string,
  event: EmailEvent,
): Promise<EventOutcome> {
  const ctx = workerContext(db, organizationId);

  return guardedWrite(ctx, "message:send", async (tx): Promise<EventOutcome> => {
    const [row] = await tx.select({
      id: schema.message.id,
      status: schema.message.status,
      toAddress: schema.message.toAddress,
    })
      .from(schema.message)
      .where(and(
        eq(schema.message.channel, CHANNEL),
        event.reference
          ? eq(schema.message.id, event.reference)
          : eq(schema.message.providerMessageId, event.providerMessageId),
      ))
      .limit(1);
    if (!row) return { recorded: false, reason: "unknown_message" };

    /**
     * A COMPLAINT IS NOT A DELIVERY FAILURE, and this is the case worth
     * getting right. The message arrived. A human read enough of it to press
     * a button. Recording it as undelivered would overwrite the one true
     * fact, that it was delivered, with a false one, and would hide the only
     * signal that actually predicts a sending domain being blocked.
     *
     * So a complaint changes no status at all. It writes a suppression and
     * stops.
     */
    if (event.type === "complained") {
      /**
       * Marketing only, not a blanket stop.
       *
       * Somebody who marks a promotion as spam has not said they do not want
       * their invoice, and a company that stops sending invoices because of
       * a complaint has a worse problem than a complaint. This matches what
       * every email provider does with its own list, and a customer who
       * wants everything to stop is a blanket suppression a person writes.
       */
      const { written } = await suppressIn(tx, organizationId, {
        address: row.toAddress,
        purpose: "marketing",
        reason: "spam_complaint",
        sourceMessageId: row.id,
      });
      await audit(tx, ctx, "email.complained", "message", row.id, null, {
        address: row.toAddress, suppressed: true, newSuppression: written,
      });
      /**
       * `suppressed` is true whether or not this call wrote the row: the
       * question the caller is asking is whether the address is now on the
       * list, and a second complaint for an already suppressed address has
       * the same answer as the first.
       */
      return { recorded: true, messageId: row.id, status: row.status, suppressed: true };
    }

    /**
     * A deferral is the provider saying it is still trying. Recording it
     * would move a message backwards, and there is no status for "delayed"
     * that is not a lie in one direction or the other.
     */
    if (event.type === "deferred") return { recorded: false, reason: "no_status_change" };

    const status = event.type === "bounced"
      /**
       * `undelivered` rather than `failed`, and the distinction is the same
       * one the SMS side draws: undelivered means the receiving end refused
       * it, failed means we never got that far. A bounce is always the
       * former, because there was a conversation and it ended in a rejection.
       */
      ? "undelivered" as const
      : event.type === "delivered" ? "delivered" as const : "sent" as const;

    if ((RANK[status] ?? 0) <= (RANK[row.status] ?? 0)) {
      return { recorded: false, reason: "out_of_order" };
    }

    await tx.update(schema.message).set({
      status,
      providerMessageId: event.providerMessageId,
      ...(status === "delivered" ? { deliveredAt: new Date() } : {}),
      ...(event.code ? { errorCode: event.code } : {}),
      ...(event.message ? { errorMessage: event.message } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.message.id, row.id));

    /**
     * ONLY A PERMANENT BOUNCE SUPPRESSES. A full mailbox or a receiver having
     * a bad afternoon is a soft bounce, and suppressing on one takes a real
     * customer off this company's email for good over a transient condition
     * that nobody will ever think to look for. A hard bounce means the
     * mailbox does not exist, so the suppression is blanket: no purpose can
     * reach an address that does not resolve.
     */
    let suppressed = false;
    if (event.type === "bounced" && event.permanent === true) {
      await suppressIn(tx, organizationId, {
        address: row.toAddress,
        purpose: null,
        reason: "hard_bounce",
        sourceMessageId: row.id,
      });
      suppressed = true;
    }

    await audit(tx, ctx, `email.${event.type}`, "message", row.id, { status: row.status }, {
      status, suppressed,
    });

    return { recorded: true, messageId: row.id, status, suppressed };
  });
}

/* ----------------------------------------------------------- suppression */

export interface SuppressInput {
  address: string;
  /** Null is a blanket stop: every purpose, which is what a hard bounce means. */
  purpose: EmailPurpose | null;
  reason: string;
  sourceMessageId?: string | null;
}

/**
 * Write a suppression, inside a transaction the caller already has.
 *
 * `onConflictDoNothing` against the partial unique indexes rather than a read
 * then a write. Two bounce callbacks for the same address arrive at the same
 * time often enough to matter, and a check-then-insert loses that race and
 * fails the whole webhook on a unique violation, which the provider then
 * retries forever.
 *
 * Returns the row and whether this call is the one that wrote it. The id is
 * needed because the audit line is keyed on a uuid, and an audit entry keyed
 * on the email address would not join to anything.
 */
async function suppressIn(
  tx: Database,
  organizationId: string,
  input: SuppressInput,
): Promise<{ id: string | null; written: boolean }> {
  const address = normalizeAddress(input.address);
  const rows = await tx.insert(schema.suppression).values({
    organizationId,
    address,
    channel: CHANNEL,
    purpose: input.purpose,
    reason: input.reason,
    sourceMessageId: input.sourceMessageId ?? null,
  })
    .onConflictDoNothing()
    .returning({ id: schema.suppression.id });

  const written = rows[0];
  if (written) return { id: written.id, written: true };

  /**
   * The conflict means a live suppression already covers this address,
   * channel and purpose. Reading it back rather than returning nothing keeps
   * the caller's audit line pointing at the row that is actually in force.
   */
  const [existing] = await tx.select({ id: schema.suppression.id })
    .from(schema.suppression)
    .where(and(
      eq(schema.suppression.organizationId, organizationId),
      eq(schema.suppression.address, address),
      eq(schema.suppression.channel, CHANNEL),
      input.purpose === null
        ? isNull(schema.suppression.purpose)
        : eq(schema.suppression.purpose, input.purpose),
      isNull(schema.suppression.liftedAt),
    ))
    .limit(1);
  return { id: existing?.id ?? null, written: false };
}

/**
 * Put an address on the do-not-email list by hand.
 *
 * Guarded by `message:send` rather than a read permission, because it changes
 * who this company can contact. It is the closest real permission in the
 * catalogue: there is no `suppression:write`, and inventing one would put a
 * permission in front of a screen and a different one in front of the API.
 */
export function suppressAddress(ctx: ServiceContext, input: SuppressInput) {
  return guardedWrite(ctx, "message:send", async (tx) => {
    if (input.reason.trim() === "") {
      /**
       * A suppression with no reason is a customer nobody can email and
       * nobody can explain, and the person who finds it a year later has no
       * way to decide whether lifting it is safe.
       */
      throw new ConflictError("A suppression needs a reason. Somebody will have to read it later.");
    }
    const address = normalizeAddress(input.address);
    const { id, written } = await suppressIn(tx, ctx.actor.organizationId, input);
    if (id) {
      await audit(tx, ctx, "email.suppressed", "suppression", id, null, {
        address, purpose: input.purpose, reason: input.reason, newSuppression: written,
      });
    }
    return { address, suppressed: true, alreadySuppressed: !written };
  });
}

/** Lift one, which is the only way off the list. */
export function liftSuppression(ctx: ServiceContext, input: { address: string }) {
  return guardedWrite(ctx, "message:send", async (tx) => {
    const address = normalizeAddress(input.address);
    const rows = await tx.update(schema.suppression)
      .set({ liftedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.suppression.organizationId, ctx.actor.organizationId),
        eq(schema.suppression.address, address),
        eq(schema.suppression.channel, CHANNEL),
        isNull(schema.suppression.liftedAt),
      ))
      .returning({ id: schema.suppression.id });

    /**
     * One audit line per row, keyed on the row's uuid rather than on the
     * address. `audit_log.entity_id` is a uuid column, so an address there is
     * not merely untidy, it fails the insert and rolls the lift back with it.
     */
    for (const row of rows) {
      await audit(tx, ctx, "email.suppression_lifted", "suppression", row.id, null, { address });
    }
    return { address, lifted: rows.length };
  });
}

export function listSuppressed(ctx: ServiceContext, input: { limit?: number | undefined } = {}) {
  return guardedRead(ctx, "message:read", async (tx) => {
    const rows = await tx.select({
      address: schema.suppression.address,
      purpose: schema.suppression.purpose,
      reason: schema.suppression.reason,
      createdAt: schema.suppression.createdAt,
    })
      .from(schema.suppression)
      .where(and(
        eq(schema.suppression.organizationId, ctx.actor.organizationId),
        eq(schema.suppression.channel, CHANNEL),
        isNull(schema.suppression.liftedAt),
      ))
      .orderBy(desc(schema.suppression.createdAt))
      .limit(Math.min(input.limit ?? 100, 500));

    return rows.map((row) => ({
      address: row.address,
      purpose: row.purpose,
      reason: row.reason,
      suppressedAt: row.createdAt.toISOString(),
    }));
  });
}

/* --------------------------------------------------------------- reading */

const MESSAGE_STATUSES = [
  "queued", "sending", "sent", "delivered", "undelivered", "failed", "received",
] as const;

type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Narrowed rather than cast. A cast here would let an unrecognized status
 * reach the query as a bare string, and Postgres answers a comparison against
 * an invalid enum label with an error rather than an empty list, so a filter
 * nobody validated turns a list screen into a 500.
 */
function isMessageStatus(value: string | undefined): value is MessageStatus {
  return value !== undefined && (MESSAGE_STATUSES as readonly string[]).includes(value);
}

export function list(ctx: ServiceContext, input: {
  status?: string | undefined;
  limit?: number | undefined;
} = {}) {
  return guardedRead(ctx, "message:read", async (tx) => {
    const rows = await tx.select({
      id: schema.message.id,
      to: schema.message.toAddress,
      from: schema.message.fromAddress,
      subject: schema.message.subject,
      purpose: schema.message.purpose,
      status: schema.message.status,
      providerMessageId: schema.message.providerMessageId,
      errorCode: schema.message.errorCode,
      errorMessage: schema.message.errorMessage,
      sentAt: schema.message.sentAt,
      deliveredAt: schema.message.deliveredAt,
      createdAt: schema.message.createdAt,
    })
      .from(schema.message)
      .where(and(
        eq(schema.message.organizationId, ctx.actor.organizationId),
        eq(schema.message.channel, CHANNEL),
        ...(isMessageStatus(input.status) ? [eq(schema.message.status, input.status)] : []),
      ))
      .orderBy(desc(schema.message.createdAt))
      .limit(Math.min(input.limit ?? 50, 200));

    return rows.map((row) => ({
      id: row.id,
      to: row.to,
      from: row.from,
      subject: row.subject,
      purpose: row.purpose,
      status: row.status,
      providerMessageId: row.providerMessageId,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      sentAt: row.sentAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

/* --------------------------------------------------------------- webhook */

export interface WebhookConnection {
  connectionId: string;
  organizationId: string;
  provider: EmailProvider;
  /** The connection's settings, for what the provider does not hold: the reply domain. */
  settings?: Record<string, unknown> | undefined;
}

/**
 * Read a secret by reference.
 *
 * The default is the deployment's secret store, read for the organization the
 * connection belongs to (`readerFor`), which is what every other provider
 * path does. A test passes its own reader.
 */
export type ReadSecret = (ref: string) => Promise<string>;

const warnedLegacy = new Set<string>();

/**
 * The secrets a provider needs beyond its main credential.
 *
 * Each is named by a `...Ref` setting and read through the same reader as
 * `credentialRef`. A name whose secret cannot be read leaves that secret
 * out, so a missing webhook secret turns delivery reporting off rather than
 * stopping mail: sending does not need it.
 *
 * ONE LEGACY PATH. An earlier version stored Resend's webhook signing secret
 * itself in `settings.webhookSecret`. Dropping it on upgrade would silently
 * stop every bounce and complaint from being heard, and suppression is the
 * thing that keeps a sender's reputation, so a stored value is still used
 * when no name is set, with a warning in the log and a notice on the
 * integrations screen telling the operator where to move it. Setting the
 * name deletes the stored value, and nothing can write a new one.
 */
export async function secretsFor(
  connectionId: string,
  settings: Record<string, unknown>,
  readSecret: ReadSecret,
): Promise<ProviderSecrets> {
  const ref = settings["webhookSecretRef"];
  if (typeof ref === "string" && ref !== "") {
    try {
      return { webhookSecret: await readSecret(ref) };
    } catch (error) {
      console.warn(
        `[email] The webhook signing secret named "${ref}" could not be read, so delivery `
        + `callbacks for connection ${connectionId} cannot be verified: ${(error as Error).message}`,
      );
      return {};
    }
  }
  const legacy = settings["webhookSecret"];
  if (typeof legacy === "string" && legacy !== "") {
    if (!warnedLegacy.has(connectionId)) {
      warnedLegacy.add(connectionId);
      console.warn(
        `[email] DEPRECATED: connection ${connectionId} has its webhook signing secret stored in `
        + `the database (settings.webhookSecret). Put it in your secret store and set its name as `
        + `the webhook signing secret on Settings → Integrations; the stored copy is then deleted.`,
      );
    }
    return { webhookSecret: legacy };
  }
  return {};
}

/**
 * The connection a webhook token names, and the tenant it belongs to.
 *
 * The token is in the URL and is a secret per connection, exactly as on the
 * carrier side. It is not the sending domain or the organization slug,
 * because both of those are public and either would let anyone aim a forged
 * bounce at a tenant they chose.
 *
 * The lookup is a SECURITY DEFINER function, because the tenant is not known
 * until after it, so no row level policy keyed on the current organization
 * could match on this first read.
 */
export async function resolveWebhook(
  db: Database,
  token: string,
  /** For a test. Left out, the organization the token resolves to has its own store read. */
  readSecret?: ReadSecret,
): Promise<WebhookConnection | null> {
  const rows = await db.execute<{
    connection_id: string;
    organization_id: string;
    provider: string;
    settings: Record<string, unknown>;
    credential_ref: string | null;
  }>(sql`select * from app.email_webhook_connection(${token})`);

  const row = rows[0];
  if (!row) return null;

  const read = readSecret ?? readerFor(db, row.organization_id);
  const secret = row.credential_ref ? await read(row.credential_ref) : "";
  return {
    connectionId: row.connection_id,
    organizationId: row.organization_id,
    provider: createEmailProvider(
      row.provider, row.settings, secret,
      await secretsFor(row.connection_id, row.settings, read),
    ),
    settings: row.settings ?? {},
  };
}

export type WebhookOutcome =
  | { kind: "rejected"; reason: "unknown_token" | "not_supported" | "bad_signature" | "unparseable" }
  | { kind: "recorded"; outcome: EventOutcome };

/**
 * Handle one provider callback.
 *
 * Verification happens BEFORE parsing and before anything is written. A
 * forged hard bounce writes a suppression, so an unverified endpoint is one
 * unauthenticated POST away from a company being unable to email a customer
 * at all.
 */
export async function receive(
  db: Database,
  connection: WebhookConnection,
  request: WebhookRequest,
): Promise<WebhookOutcome> {
  const { delivery } = connection.provider;

  /**
   * A provider that reports nothing has no webhook to receive, and saying so
   * is not the same as rejecting a signature. An operator who has pointed
   * something at this URL for an SMTP connection has made a configuration
   * mistake, and "not supported" tells them that where "bad signature" would
   * send them looking for a key that does not exist.
   */
  if (delivery.kind === "none") return { kind: "rejected", reason: "not_supported" };

  if (!delivery.verify(request)) return { kind: "rejected", reason: "bad_signature" };

  const event = delivery.parse(request);
  if (!event) return { kind: "rejected", reason: "unparseable" };

  return { kind: "recorded", outcome: await recordEvent(db, connection.organizationId, event) };
}

/**
 * The same thing, starting from a token.
 *
 * Split from `receive` so a test can drive a provider directly without a
 * connection row, and so the mount point can tell an unknown token apart from
 * a bad signature and answer 404 to one and 403 to the other.
 */
export async function receiveByToken(
  db: Database,
  input: { token: string; url: string; headers: Record<string, string>; rawBody: string },
  readSecret?: ReadSecret,
): Promise<WebhookOutcome> {
  const connection = await resolveWebhook(db, input.token, readSecret);
  if (!connection) return { kind: "rejected", reason: "unknown_token" };
  return receive(db, connection, {
    url: input.url,
    headers: input.headers,
    body: input.rawBody,
  });
}

/**
 * The provider this organization sends email through.
 *
 * Resolved per organization rather than from a global environment variable,
 * because a hosted deployment serves many companies and each brings their own
 * account. The credential is fetched by reference; this layer never sees it
 * in the database.
 */
export async function providerFor(
  db: Database,
  organizationId: string,
  /** For a test. Left out, this organization's own store is read. */
  readSecret: ReadSecret = readerFor(db, organizationId),
): Promise<EmailProvider> {
  const ctx = workerContext(db, organizationId);
  const resolved = await guardedRead(ctx, "message:read", async (tx) =>
    senderFor(tx, organizationId));

  if (!resolved) throw new EmailProviderNotConfiguredError(CHANNEL);
  const secret = resolved.credentialRef ? await readSecret(resolved.credentialRef) : "";
  return createEmailProvider(
    resolved.provider, resolved.settings, secret,
    await secretsFor(resolved.connectionId, resolved.settings, readSecret),
  );
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  queueEmail: (ctx: ServiceContext, input: {
    to: string; subject: string;
    text?: string | undefined; html?: string | undefined;
    replyTo?: string | undefined;
    purpose?: EmailPurpose | undefined;
    customerId?: string | undefined;
    unsubscribeUrl?: string | undefined;
  }): Promise<QueueOutcome> => queue(ctx, {
    to: input.to,
    subject: input.subject,
    ...(input.text ? { text: input.text } : {}),
    ...(input.html ? { html: input.html } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.unsubscribeUrl ? { unsubscribeUrl: input.unsubscribeUrl } : {}),
  }),

  listEmailMessages: async (ctx: ServiceContext, input: {
    status?: string | undefined; limit?: number | undefined;
  }) => ({ messages: await list(ctx, input) }),

  /**
   * Drain the queue for the caller's own organization.
   *
   * Session authorized rather than a background-only path, because a
   * self hoster with no worker running still has to be able to make the mail
   * go, and "it is queued, wait for a cron you have not set up" is the state
   * every self hosted install starts in.
   */
  sendQueuedEmail: async (ctx: ServiceContext, input: { limit?: number | undefined }) => {
    const provider = await providerFor(ctx.db, ctx.actor.organizationId);
    const outcomes = await flush(ctx.db, ctx.actor.organizationId, { provider }, input.limit ?? 50);
    return {
      /** Named so an operator can see that an SMTP send will never say more. */
      deliveryReporting: provider.delivery.kind,
      ...(provider.delivery.kind === "none" ? { deliveryNote: provider.delivery.because } : {}),
      results: outcomes,
    };
  },

  listEmailSuppressions: async (ctx: ServiceContext, input: { limit?: number | undefined }) =>
    ({ suppressions: await listSuppressed(ctx, input) }),

  suppressEmailAddress: (ctx: ServiceContext, input: {
    address: string; reason: string; purpose?: EmailPurpose | undefined;
  }) => suppressAddress(ctx, {
    address: input.address,
    purpose: input.purpose ?? null,
    reason: input.reason,
  }),

  liftEmailSuppression: (ctx: ServiceContext, input: { address: string }) =>
    liftSuppression(ctx, input),
} as const;

/*
 * THERE WAS A `receiveEmailWebhook` HANDLER HERE AND NOTHING CALLED IT.
 *
 * A wrapper over `receiveByToken` that flattened the result, sitting in the
 * `handlers` table, which is the table the HTTP router serves from. No route named
 * it, because a provider callback is not a `/v1` route: it arrives at
 * `/api/webhooks/email/{token}` and that page calls `receiveByToken` directly,
 * which is right, since the signature is what admits the request and there is no
 * caller identity to build a context from.
 *
 * So it was dead code in the one place that implies the opposite. Removed rather
 * than routed, and `contracts.test.ts` now fails on a handler nothing serves,
 * which is how this was found.
 */
