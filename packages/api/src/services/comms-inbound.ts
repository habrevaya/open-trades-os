import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { comms, type Actor, SYSTEM_USER_ID } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import type { InboundMessage, MessagingProvider, WebhookRequest } from "../comms/provider";
import { recordDelivery } from "./comms-outbox";
import { createProvider } from "../comms/provider";

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

  return store(db, organizationId, inbound);
}

export async function store(
  db: Database,
  organizationId: string,
  inbound: InboundMessage,
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

    const [stored] = await tx.insert(schema.message).values({
      organizationId,
      conversationId,
      direction: "inbound",
      channel: inbound.media.length > 0 ? "mms" : "sms",
      purpose: "transactional",
      fromAddress: inbound.from,
      toAddress: inbound.to,
      body: inbound.body,
      media: inbound.media.map((m) => ({ url: m.url, contentType: m.contentType })),
      status: "received",
      providerMessageId: inbound.providerMessageId,
    }).returning({ id: schema.message.id });

    await tx.update(schema.conversation).set({
      lastMessageAt: new Date(),
      lastMessagePreview: inbound.body.slice(0, 200),
      /**
       * Reopened. A customer replying to a closed thread is not starting an
       * unrelated conversation, and a reply that lands in a closed thread is
       * a reply nobody sees.
       */
      status: "open",
      updatedAt: new Date(),
    }).where(eq(schema.conversation.id, conversationId));

    return { kind: "message", messageId: stored!.id, conversationId, intent } as const;
  });
}

/**
 * The thread this belongs to.
 *
 * By address rather than by the provider's own threading, which keys on the
 * number pair and therefore splits a conversation the moment a company sends
 * from a pool. The customer is attached when one is recognized, and left null
 * when not: an unrecognized number texting in is a lead, and dropping it
 * because it does not match a customer row is how leads are lost.
 */
async function threadFor(tx: Database, input: {
  organizationId: string; address: string; phoneNumberId: string;
}): Promise<string> {
  const [existing] = await tx.select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(and(
      eq(schema.conversation.organizationId, input.organizationId),
      eq(schema.conversation.externalAddress, input.address),
      isNull(schema.conversation.deletedAt),
    ))
    .orderBy(desc(schema.conversation.createdAt))
    .limit(1);
  if (existing) return existing.id;

  const [customer] = await tx.select({ id: schema.customer.id })
    .from(schema.customer)
    .where(and(
      eq(schema.customer.phone, input.address),
      isNull(schema.customer.deletedAt),
    ))
    .limit(1);

  const [created] = await tx.insert(schema.conversation).values({
    organizationId: input.organizationId,
    channel: "sms",
    externalAddress: input.address,
    phoneNumberId: input.phoneNumberId,
    customerId: customer?.id ?? null,
    status: "open",
  }).returning({ id: schema.conversation.id });
  return created!.id;
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
  readSecret: (ref: string) => Promise<string>,
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

  const secret = row.credential_ref ? await readSecret(row.credential_ref) : "";
  return {
    connectionId: row.connection_id,
    organizationId: row.organization_id,
    provider: createProvider(row.provider, row.settings, secret),
  };
}
