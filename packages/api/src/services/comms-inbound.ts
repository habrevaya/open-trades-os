import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { comms, type Actor, SYSTEM_USER_ID } from "@opentradesos/core";
import { inTenant, ConflictError, type ServiceContext } from "./context";
import * as files from "./files";
import { emit } from "./events";
import type { InboundMessage, MessagingProvider, WebhookRequest } from "../comms/provider";
import { recordDelivery } from "./comms-outbox";
import { threadFor } from "./comms-send";
import { createProvider } from "../comms/provider";
import { readerFor } from "../secrets/store";

/**
 * WHAT ARRIVES
 *
 * An inbound text is three different things at once and they have to be
 * handled in this order:
 *
 *   1. A COMPLIANCE EVENT. "STOP" is legally binding and must take effect
 *      before anything else looks at the message. Storing it first and acting
 *      on it later leaves a window in which a queued reminder still goes out.
 *   2. A RECORD. It belongs in the thread whether or not anybody reads it.
 *   3. A PROMPT for a person, which is the inbox, and is the only part a
 *      human is involved in.
 *
 * The whole thing is worthless without step zero: proving the request came
 * from the carrier. An unverified endpoint lets anyone on the internet forge
 * a STOP from a customer, or forge a message an operator will act on.
 */

export type InboundOutcome =
  | { kind: "rejected"; reason: "bad_signature" | "unparseable" | "unknown_number" }
  | { kind: "delivery"; recorded: boolean }
  | { kind: "message"; messageId: string; conversationId: string; intent: comms.InboundIntent };

function inboundActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: [],
    agentId: "inbound",
  };
}

/**
 * Handle one webhook.
 *
 * The organization is resolved from the number the message arrived ON, not
 * from anything in the request. A tenant id in a URL or a header is a thing
 * an attacker chooses.
 */
export async function receive(
  db: Database,
  provider: MessagingProvider,
  request: WebhookRequest,
  organizationId: string,
): Promise<InboundOutcome> {
  /**
   * Before parsing, not after. Parsing attacker-controlled input is a smaller
   * risk than acting on it, but it is not zero, and there is no reason to.
   */
  if (!provider.verify(request)) return { kind: "rejected", reason: "bad_signature" };

  const delivery = provider.parseDelivery(request);
  if (delivery) {
    return { kind: "delivery", recorded: await recordDelivery(db, organizationId, delivery) };
  }

  const inbound = provider.parseInbound(request);
  if (!inbound) return { kind: "rejected", reason: "unparseable" };

  return store(db, organizationId, inbound, await fetchPictures(provider, inbound));
}

/**
 * What came with a picture message, fetched from the carrier.
 *
 * Before the transaction opens, for the reason the call recordings give: a
 * transaction held across a download is a connection held for as long as the
 * carrier takes. Ten at most, which is the most a carrier will put in one
 * message. A failed fetch is not a failed message: the words are stored
 * either way, and the thread says the picture could not be fetched.
 */
export type FetchedMedia =
  | { url: string; ok: true; bytes: Uint8Array; contentType: string }
  | { url: string; ok: false; contentType: string; why: string };

async function fetchPictures(provider: MessagingProvider, inbound: InboundMessage): Promise<FetchedMedia[] | null> {
  if (inbound.media.length === 0 || !provider.fetchMedia) return null;
  const fetched: FetchedMedia[] = [];
  for (const item of inbound.media.slice(0, 10)) {
    const result = await provider.fetchMedia(item.url);
    fetched.push(result.ok
      ? { url: item.url, ok: true, bytes: result.bytes, contentType: result.contentType }
      : { url: item.url, ok: false, contentType: item.contentType, why: result.message });
  }
  return fetched;
}

export async function store(
  db: Database,
  organizationId: string,
  inbound: InboundMessage,
  /**
   * The pictures, fetched. Null when the carrier cannot hand them over, in
   * which case they are kept by the carrier's link only, as they always were.
   */
  pictures: readonly FetchedMedia[] | null = null,
): Promise<InboundOutcome> {
  const ctx: ServiceContext = { actor: inboundActor(organizationId), db };
  const intent = comms.inboundIntent(inbound.body);

  return inTenant(ctx, async (tx) => {
    const [number] = await tx.select().from(schema.phoneNumber)
      .where(and(
        eq(schema.phoneNumber.e164, inbound.to),
        isNull(schema.phoneNumber.releasedAt),
      ))
      .limit(1);
    if (!number) return { kind: "rejected", reason: "unknown_number" } as const;

    /**
     * STOP first, and in the same transaction as the message.
     *
     * Suppression beats consent, beats a template, beats a workflow. Writing
     * the message and handling the opt out afterwards leaves a window, and
     * the window is exactly when the queued reminder goes out to somebody who
     * just asked you to stop.
     */
    if (intent === "stop") {
      await tx.insert(schema.suppression).values({
        organizationId,
        address: inbound.from,
        channel: "sms",
        reason: `inbound: ${inbound.body.trim().slice(0, 100)}`,
      }).onConflictDoNothing();

      /**
       * AND RECORDED AS A WITHDRAWAL, not only as a suppression.
       *
       * The suppression is what stops the sending, and on its own it is
       * enough to stop it. What it is not is an answer to "did this person
       * consent": a marketing grant from a web form stays the current
       * consent row forever after a STOP, so the consent history says yes
       * while the customer has plainly said no. Somebody reading that record
       * a year later, or exporting it, gets the opposite of the truth.
       *
       * Written for marketing rather than for every purpose, because
       * transactional messages are implied by work in flight and a STOP does
       * not cancel the job. The suppression covers those, absolutely and at
       * the channel, which is where a carrier level opt out belongs.
       */
      await tx.update(schema.communicationConsent)
        .set({ supersededAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(schema.communicationConsent.organizationId, organizationId),
          eq(schema.communicationConsent.address, inbound.from),
          eq(schema.communicationConsent.channel, "sms"),
          eq(schema.communicationConsent.purpose, "marketing"),
          isNull(schema.communicationConsent.supersededAt),
        ));

      await tx.insert(schema.communicationConsent).values({
        organizationId,
        address: inbound.from,
        channel: "sms",
        purpose: "marketing",
        state: "revoked",
        method: "sms_reply",
        proofText: inbound.body.trim().slice(0, 500),
      });
    }

    /**
     * START lifts it, and only the suppression this channel created. A
     * customer who texts START is asking to hear from you again, and refusing
     * because they once said stop is the kind of thing that ends up in a
     * complaint from the other direction.
     */
    if (intent === "start") {
      await tx.update(schema.suppression)
        .set({ liftedAt: new Date() })
        .where(and(
          eq(schema.suppression.address, inbound.from),
          eq(schema.suppression.channel, "sms"),
          isNull(schema.suppression.liftedAt),
        ));
    }

    const conversationId = await threadFor(tx, {
      organizationId,
      address: inbound.from,
      phoneNumberId: number.id,
    });

    /**
     * Each picture kept as a stored file, which is what lets the inbox show
     * it to somebody with no login at the carrier. Kept by what the bytes
     * ARE: a file that is not a picture or a document this product keeps
     * (a video, a contact card) is named in the thread and not stored,
     * rather than served from this product's own address as whatever it
     * claimed to be.
     */
    const media: (typeof schema.message.$inferInsert)["media"] = [];
    const keptFiles: { storageKey: string; contentType: string; sizeBytes: number }[] = [];
    for (const item of pictures ?? inbound.media.map((m) => ({ url: m.url, ok: false as const, contentType: m.contentType, why: "" }))) {
      if (!item.ok) {
        media.push({
          url: item.url, contentType: item.contentType,
          ...(pictures ? { refused: `The picture could not be fetched from the carrier: ${item.why}` } : {}),
        });
        continue;
      }
      try {
        const { file } = await files.put(tx, organizationId, { bytes: item.bytes, claimedType: item.contentType });
        media.push({ url: item.url, contentType: file.contentType, bytes: file.sizeBytes, storageKey: file.storageKey });
        keptFiles.push({ storageKey: file.storageKey, contentType: file.contentType, sizeBytes: file.sizeBytes });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        media.push({
          url: item.url, contentType: item.contentType,
          refused: `A ${describeType(item.contentType)} came with this text, and only pictures and PDFs are kept here.`,
        });
      }
    }

    const [stored] = await tx.insert(schema.message).values({
      organizationId,
      conversationId,
      direction: "inbound",
      channel: inbound.media.length > 0 ? "mms" : "sms",
      purpose: "transactional",
      fromAddress: inbound.from,
      toAddress: inbound.to,
      body: inbound.body,
      media,
      status: "received",
      providerMessageId: inbound.providerMessageId,
    }).returning({ id: schema.message.id });

    for (const file of keptFiles) {
      await files.attach(tx, organizationId, {
        entityType: "message", entityId: stored!.id, storageKey: file.storageKey,
        contentType: file.contentType, sizeBytes: file.sizeBytes,
      });
    }

    await tx.update(schema.conversation).set({
      lastMessageAt: new Date(),
      lastMessagePreview: (inbound.body.trim() || (inbound.media.length > 0 ? "Picture" : "")).slice(0, 200),
      /**
       * Reopened. A customer replying to a closed thread is not starting an
       * unrelated conversation, and a reply that lands in a closed thread is
       * a reply nobody sees.
       */
      status: "open",
      updatedAt: new Date(),
    }).where(eq(schema.conversation.id, conversationId));

    /**
     * WHAT A WORKFLOW WAITS FOR.
     *
     * The builder offered "when a customer texts in" and this path emitted
     * nothing, so an automation routing after-hours replies to a task never
     * ran once.
     *
     * The INTENT rides on the payload, because a STOP and a question are
     * both inbound messages and no workflow wants to reply to the first
     * one. A condition on `intent` is the difference between an automation
     * that helps and one that texts somebody who just asked you to stop.
     */
    await emit(tx, ctx, {
      name: "message.received", entityType: "conversation", entityId: conversationId,
      payload: {
        messageId: stored!.id,
        conversationId,
        from: inbound.from,
        body: inbound.body,
        intent,
        channel: inbound.media.length > 0 ? "mms" : "sms",
      },
    });

    return { kind: "message", messageId: stored!.id, conversationId, intent } as const;
  });
}



/** "video", "contact card", or the type as given, for the sentence in the thread. */
function describeType(contentType: string): string {
  const type = contentType.toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "sound recording";
  if (type.includes("vcard")) return "contact card";
  if (type.startsWith("image/")) return "picture in a format this product does not keep";
  return `file (${contentType})`;
}

/**
 * A picture this company is sending, for the carrier to fetch.
 *
 * Public, with no session, because the carrier fetching it has none. What
 * admits the request is two secrets in its address: the messaging
 * connection's webhook token, which names the company, and the picture's own
 * random key, which names one picture on one outgoing message. Only outgoing
 * pictures are served this way, and only for a week after they were queued.
 */
export async function publicPicture(db: Database, token: string, key: string) {
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(key)) return null;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.messaging_webhook_connection(${token})`,
  );
  const organizationId = rows[0]?.organization_id;
  if (!organizationId) return null;
  const ctx: ServiceContext = { actor: inboundActor(organizationId), db };
  return inTenant(ctx, async (tx) => {
    const [message] = await tx.select({ media: schema.message.media }).from(schema.message)
      .where(and(
        eq(schema.message.organizationId, organizationId),
        eq(schema.message.direction, "outbound"),
        sql`${schema.message.createdAt} > now() - interval '7 days'`,
        sql`${schema.message.media} @> ${JSON.stringify([{ publicKey: key }])}::jsonb`,
      )).limit(1);
    const item = message?.media.find((m) => m.publicKey === key);
    if (!item?.storageKey) return null;
    const [file] = await tx.select().from(schema.storedFile)
      .where(and(
        eq(schema.storedFile.organizationId, organizationId),
        eq(schema.storedFile.storageKey, item.storageKey),
        isNull(schema.storedFile.deletedAt),
      )).limit(1);
    return file ? { bytes: await files.bytesOf(file), contentType: file.contentType } : null;
  });
}

export interface WebhookConnection {
  connectionId: string;
  organizationId: string;
  provider: MessagingProvider;
}

/**
 * Which tenant this webhook belongs to.
 *
 * From a secret in the URL, not from a header, a query parameter naming an
 * organization, or the `To` number. The first two are things an attacker
 * chooses. The third is not secret: a company's phone number is on their
 * truck, and anyone could use it to aim a forged message at a tenant they
 * picked.
 *
 * Resolved before the tenant is known, so it goes through a SECURITY DEFINER
 * function, exactly as a session does.
 */
export async function resolveWebhook(
  db: Database,
  token: string,
  /** For a test. Left out, the organization the token resolves to has its own store read. */
  readSecret?: (ref: string) => Promise<string>,
): Promise<WebhookConnection | null> {
  const rows = await db.execute<{
    connection_id: string;
    organization_id: string;
    provider: string;
    settings: Record<string, unknown>;
    credential_ref: string | null;
  }>(sql`select * from app.messaging_webhook_connection(${token})`);

  const row = rows[0];
  if (!row) return null;

  const read = readSecret ?? readerFor(db, row.organization_id);
  const secret = row.credential_ref ? await read(row.credential_ref) : "";
  return {
    connectionId: row.connection_id,
    organizationId: row.organization_id,
    provider: createProvider(row.provider, row.settings, secret),
  };
}
