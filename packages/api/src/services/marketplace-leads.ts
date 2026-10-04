import { randomBytes } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, connectors as cat, marketplaces as mp, marketing as mk, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";
import * as acquisition from "./acquisition";
import { resolveConnectorChannel } from "./lead-connectors";
import { receiveLead, createLeadSource } from "./lead-intake";
import {
  AuthorizationLostError, PlatformRefusedError, PlatformUnavailableError, createMarketplace,
  type HttpTransport, type MarketplaceAdapter, type MarketplaceLead, type MarketplaceMessage, type MarketplacePlatform,
} from "../marketplaces/index";
import "../marketing/index";

/**
 * LEADS FROM THE MARKETPLACES, AND TALKING TO THE CUSTOMER THROUGH THEM
 *
 * The generic lead webhook took a JSON post signed the way this product signs
 * things, and no marketplace signs that way. So Angi and Thumbtack leads were
 * typed in from the marketplace's screen, Yelp's were not seen at all, and a
 * reply to a Thumbtack customer meant leaving this product for Thumbtack's.
 *
 * Each marketplace now posts to the same endpoint the generic webhook does,
 * routed by the connector's token, verified and read by its own adapter:
 *
 *   ANGI and THUMBTACK post the lead with a password the company chose.
 *   YELP posts only that something happened, and the lead and its messages
 *   are read back from Yelp with the company's token.
 *
 * and every lead lands the same way: an offer in the lead inbox, a touch on
 * the connector's channel and tracking campaign, and what the marketplace
 * charged recorded as spend. Thumbtack's and Yelp's customer messages are the
 * lead's own thread, and a reply written here goes back through the platform,
 * because a customer whose number the platform withholds can only be reached
 * that way.
 *
 * Every platform's API needs that platform's approval of the operator as a
 * partner first. Until it comes, the same leads arrive by email
 * (`lead-emails.ts`).
 */

export type SecretReader = (ref: string) => Promise<string>;

export interface MarketplaceDeps {
  /** The platform's HTTP, which every test replaces with a fake. */
  transport?: HttpTransport | undefined;
  readSecret?: SecretReader | undefined;
}

const envSecret: SecretReader = async (ref) => {
  const value = process.env[ref];
  if (!value) throw new ConflictError(`No secret in the environment for "${ref}".`);
  return value;
};

const PLATFORMS: readonly MarketplacePlatform[] = ["angi", "thumbtack", "yelp"];
const isPlatform = (value: string): value is MarketplacePlatform => (PLATFORMS as readonly string[]).includes(value);

function intakeActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "lead-intake" };
}

/* ---------------------------------------------------------------- setup */

export interface MarketplaceSetup {
  platform: string;
  displayName?: string | undefined;
  channelId?: string | undefined;
  campaignId?: string | undefined;
  /** Thumbtack's and Yelp's id for the business, which every post is checked against. */
  businessId?: string | undefined;
  /** The NAME of the secret holding the platform's API token. */
  apiTokenRef?: string | undefined;
  /** The NAME of the secret holding the password Angi or Thumbtack posts with. */
  webhookSecretRef?: string | undefined;
}

/**
 * Set a marketplace up: a lead source of its kind, and the connection that
 * holds its business id and the names of its secrets.
 *
 * One per marketplace per company. Setting one up again changes it, and keeps
 * its address, because the platform is already posting to that address.
 *
 * For Angi and Thumbtack a password is minted and returned ONCE: the operator
 * keeps it in the secret store under the name they gave, and gives the same
 * value to the platform as the password it posts with. Nothing reads it back.
 */
export interface MarketplaceConnected {
  id: string;
  platform: string;
  displayName: string;
  channelId: string | null;
  campaignId: string | null;
  webhookPath: string;
  webhookSecretRef: string | null;
  password: string | null;
  replies: boolean;
  needsApproval: boolean;
  approval: string;
}

export async function connectMarketplace(ctx: ServiceContext, input: MarketplaceSetup): Promise<MarketplaceConnected> {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const again = await replayed<MarketplaceConnected>(tx, ctx, "lead_marketplace");
    if (again) return again;
    if (!isPlatform(input.platform)) {
      throw new ConflictError(
        `"${input.platform}" is not a marketplace with an API this product speaks to. Angi, Thumbtack and Yelp are; `
        + "anything else (Nextdoor included) arrives by forwarding its emails to the lead inbox.",
      );
    }
    const platform = input.platform;
    const spec = mp.MARKETPLACES[platform];
    const org = ctx.actor.organizationId;
    const needsApi = spec.api === "notify_then_fetch" || spec.replies;
    const posts = spec.api === "push";

    const businessId = input.businessId?.trim() || undefined;
    const apiTokenRef = input.apiTokenRef?.trim() || undefined;
    const webhookSecretRef = input.webhookSecretRef?.trim() || undefined;
    if (needsApi && !businessId) throw new ConflictError(`Enter the ${spec.label} business id. Every post is checked against it.`);
    if (needsApi && !apiTokenRef) {
      throw new ConflictError(`Enter the name of the secret holding the ${spec.label} access token. ${spec.label === "Yelp" ? "Every lead is read with it." : "Replies go back with it."}`);
    }
    if (posts && !webhookSecretRef) {
      throw new ConflictError(`Enter the name the password ${spec.label} posts with will be kept under in your secret store.`);
    }
    for (const ref of [apiTokenRef, webhookSecretRef]) {
      if (ref && cat.looksLikeSecretValue(ref)) {
        throw new ConflictError("That looks like the secret itself. Enter the NAME it is kept under in your secret store; nothing was saved.");
      }
    }
    const settings: Record<string, unknown> = {
      ...(businessId ? { businessId } : {}),
      ...(apiTokenRef && platform !== "angi" ? { apiTokenRef } : {}),
    };
    const checked = cat.checkConnectorSettings(platform, settings);
    if (!checked.ok) throw new ConflictError(checked.reason);

    const declared = input.campaignId
      ? await acquisition.resolveDeclared(tx, org, { campaignId: input.campaignId, channelId: input.channelId ?? null })
      : null;
    const channel = await resolveConnectorChannel(tx, org, { source: platform, channelId: declared?.channelId ?? input.channelId ?? null });
    if (!channel.channelId) {
      throw new ConflictError(`Every channel for ${mk.leadSourceLabel(channel.sourceKey)} is archived. Choose a channel for ${spec.label} leads.`);
    }

    const [connection] = await tx.insert(schema.integrationConnection).values({
      organizationId: org,
      capability: "lead_source",
      provider: platform,
      status: "connected",
      accountLabel: input.displayName?.trim() || spec.label,
      credentialRef: posts ? webhookSecretRef! : null,
      settings,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: {
        status: "connected",
        accountLabel: input.displayName?.trim() || spec.label,
        credentialRef: posts ? webhookSecretRef! : null,
        settings,
        lastError: null,
        updatedAt: new Date(),
      },
    }).returning();

    const [existing] = await tx.select().from(schema.leadSourceConnector).where(and(
      eq(schema.leadSourceConnector.organizationId, org),
      eq(schema.leadSourceConnector.kind, platform),
      isNull(schema.leadSourceConnector.deletedAt),
    )).limit(1);
    const values = {
      source: platform,
      kind: platform,
      channelId: channel.channelId,
      acquisitionCampaignId: declared?.campaignId ?? null,
      displayName: input.displayName?.trim() || spec.label,
      connectionId: connection!.id,
      active: true,
    };
    const [row] = existing
      ? await tx.update(schema.leadSourceConnector).set({ ...values, updatedAt: new Date() })
        .where(eq(schema.leadSourceConnector.id, existing.id)).returning()
      : await tx.insert(schema.leadSourceConnector).values({
        organizationId: org, ...values, webhookToken: randomBytes(24).toString("base64url"),
      }).returning();

    await audit(tx, ctx, existing ? "lead_marketplace.changed" : "lead_marketplace.connected", "lead_source_connector", row!.id,
      existing ? { channelId: existing.channelId, campaignId: existing.acquisitionCampaignId } : null,
      { platform, channelId: row!.channelId, campaignId: row!.acquisitionCampaignId });

    const answer: MarketplaceConnected = {
      id: row!.id,
      platform,
      displayName: row!.displayName,
      channelId: row!.channelId,
      campaignId: row!.acquisitionCampaignId,
      webhookPath: `/api/webhooks/leads/${row!.webhookToken}`,
      webhookSecretRef: posts ? webhookSecretRef! : null,
      /** Shown once, for Angi and Thumbtack: keep it under `webhookSecretRef`, and give the same to the platform. */
      password: posts ? `lhpw_${randomBytes(24).toString("base64url")}` : null,
      replies: spec.replies,
      needsApproval: spec.needsApproval,
      approval: spec.approval,
    };
    /** Remembered without the password, so a replay cannot hand it out a second time. */
    await remember(tx, ctx, "lead_marketplace", row!.id, { ...answer, password: null });
    return answer;
  });
}

/* --------------------------------------------------------- the webhook */

export interface WebhookAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface WebhookInput {
  token: string;
  /** The URL the platform posted to, from the deployment's configuration. */
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  query: Record<string, string>;
}

/**
 * Everything that arrives at `/api/webhooks/leads/{token}`.
 *
 * The token decides the connector and therefore the company, and nothing
 * else about the request is believed until its kind's check has passed. The
 * answers keep to what a sender can act on: 404 for a token nobody here
 * issued or a connector switched off (the same answer for both, so tokens
 * cannot be tested against the difference), 409 for a connector whose secret
 * is not set up, 401 for a request that is not the sender's, 422 for a body
 * that will never parse, 503 when the platform could not be read back from
 * (Yelp retries), and 2xx for anything recorded, including a lead seen before.
 */
export async function receiveWebhook(db: Database, input: WebhookInput, deps: MarketplaceDeps = {}): Promise<WebhookAnswer> {
  const readSecret = deps.readSecret ?? envSecret;
  const [connector] = await db.select().from(schema.leadSourceConnector)
    .where(and(eq(schema.leadSourceConnector.webhookToken, input.token), isNull(schema.leadSourceConnector.deletedAt)))
    .limit(1);
  if (!connector || !connector.active) return { status: 404, body: { error: "not_found" } };

  const [connection] = connector.connectionId
    ? await db.select().from(schema.integrationConnection)
      .where(eq(schema.integrationConnection.id, connector.connectionId)).limit(1)
    : [];

  if (connector.kind === "webhook") return genericWebhook(db, connector, connection ?? null, input, readSecret);
  if (!isPlatform(connector.kind) || !connection || connection.status !== "connected") {
    return { status: 409, body: { error: "not_configured" } };
  }

  const settings = (connection.settings ?? {}) as Record<string, unknown>;
  const spec = mp.MARKETPLACES[connector.kind];
  /**
   * Yelp checks an address before it will post to it, by asking it to echo a
   * value back. Nothing is written and nothing is believed.
   */
  if (input.method === "GET") {
    const challenge = input.query["verification"];
    return challenge && connector.kind === "yelp"
      ? { status: 200, body: { verification: challenge.slice(0, 200) } }
      : { status: 405, body: { error: "post_only" } };
  }

  let webhookSecret: string | null = null;
  let apiToken: string | null = null;
  try {
    if (spec.api === "push") webhookSecret = await readSecret(connection.credentialRef ?? "");
    const tokenRef = typeof settings["apiTokenRef"] === "string" ? settings["apiTokenRef"] : null;
    if (tokenRef) apiToken = await readSecret(tokenRef);
  } catch {
    /** A connector whose secret is missing refuses rather than accepting unverified leads. */
    return { status: 409, body: { error: "not_configured" } };
  }

  const adapter = createMarketplace(connector.kind, {
    settings, webhookSecret, apiToken,
    transport: deps.transport ?? (globalThis.fetch as unknown as HttpTransport),
  });
  const request = { url: input.url, method: input.method, headers: input.headers, body: input.body };
  if (!adapter.verify(request)) return { status: 401, body: { error: "bad_signature" } };
  const events = adapter.parse(request);
  if (!events) return { status: 422, body: { error: `That is not a post this can read as ${spec.label}'s.` } };

  const outcome = { leads: 0, duplicates: 0, messages: 0, offers: [] as string[] };
  try {
    for (const event of events) {
      if (event.kind === "lead") {
        const result = await takeLead(db, connector, event.lead);
        if (result.offerId) outcome.offers.push(result.offerId);
        if (result.duplicate) outcome.duplicates += 1; else outcome.leads += 1;
      } else if (event.kind === "message") {
        const offerId = await offerFor(db, connector, event.message.leadExternalId);
        if (offerId && await keepMessage(db, connector.organizationId, offerId, event.message)) outcome.messages += 1;
      } else {
        const fetched = await adapter.fetchLead?.(event.leadExternalId);
        if (!fetched) continue;
        const result = await takeLead(db, connector, fetched.lead);
        if (result.offerId) {
          outcome.offers.push(result.offerId);
          if (result.duplicate) outcome.duplicates += 1; else outcome.leads += 1;
          for (const message of fetched.messages) {
            if (await keepMessage(db, connector.organizationId, result.offerId, message)) outcome.messages += 1;
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof PlatformUnavailableError || error instanceof AuthorizationLostError) {
      if (error instanceof AuthorizationLostError) await noteError(db, connection, error.message);
      return { status: 503, body: { error: "platform_unavailable", detail: error.message } };
    }
    if (error instanceof PlatformRefusedError) {
      await noteError(db, connection, error.message);
      return { status: 200, body: { received: true, refused: error.message } };
    }
    throw error;
  }
  return {
    status: outcome.leads > 0 ? 201 : 200,
    body: { received: true, ...outcome, offerId: outcome.offers[0] ?? null, duplicate: outcome.leads === 0 && outcome.duplicates > 0 },
  };
}

/** The generic signed webhook, unchanged in what it accepts and answers. */
async function genericWebhook(
  db: Database,
  connector: typeof schema.leadSourceConnector.$inferSelect,
  connection: typeof schema.integrationConnection.$inferSelect | null,
  input: WebhookInput,
  readSecret: SecretReader,
): Promise<WebhookAnswer> {
  if (input.method !== "POST") return { status: 405, body: { error: "post_only" } };
  if (!connection?.credentialRef) return { status: 409, body: { error: "not_configured" } };
  let secret: string;
  try {
    secret = await readSecret(connection.credentialRef);
  } catch {
    return { status: 409, body: { error: "not_configured" } };
  }
  const adapter = createLeadSource("lead_webhook", { fieldMap: connector.fieldMap ?? {}, source: connector.source });
  const request = { url: input.url, headers: input.headers, body: input.body };
  if (!adapter.verify(request, secret)) return { status: 401, body: { error: "bad_signature" } };
  const lead = adapter.parse(request);
  if (!lead) {
    return { status: 422, body: { error: "That lead has no name, or no phone number and no email, so there is nobody to call." } };
  }
  const outcome = await inTenant({ actor: intakeActor(connector.organizationId), db }, (tx) => receiveLead(tx, {
    connectorId: connector.id, organizationId: connector.organizationId, lead: { ...lead, source: connector.source },
  }));
  return {
    status: outcome.duplicate ? 200 : 201,
    body: { received: true, offerId: outcome.offerId, duplicate: outcome.duplicate },
  };
}

async function noteError(db: Database, connection: typeof schema.integrationConnection.$inferSelect, message: string) {
  await inTenant({ actor: intakeActor(connection.organizationId), db }, (tx) =>
    tx.update(schema.integrationConnection).set({ lastError: message.slice(0, 1000), lastCheckedAt: new Date() })
      .where(eq(schema.integrationConnection.id, connection.id)));
}

/** One marketplace lead into the inbox, with its charge, inside the company's own boundary. */
async function takeLead(db: Database, connector: typeof schema.leadSourceConnector.$inferSelect, lead: MarketplaceLead) {
  const { charge, ...inbound } = lead;
  return inTenant({ actor: intakeActor(connector.organizationId), db }, (tx) => receiveLead(tx, {
    connectorId: connector.id,
    organizationId: connector.organizationId,
    lead: { ...inbound, source: connector.source },
    charge,
  }));
}

/** The offer a platform's lead id became under this connector, or null. */
async function offerFor(db: Database, connector: typeof schema.leadSourceConnector.$inferSelect, leadExternalId: string) {
  return inTenant({ actor: intakeActor(connector.organizationId), db }, async (tx) => {
    const [offer] = await tx.select({ id: schema.leadOffer.id }).from(schema.leadOffer).where(and(
      eq(schema.leadOffer.connectorId, connector.id), eq(schema.leadOffer.externalId, leadExternalId),
    )).limit(1);
    return offer?.id ?? null;
  });
}

/**
 * One message on a lead, kept once: the platform's id for it is unique per
 * offer, so a message posted twice, or read back from Yelp on every notice,
 * is one line in the thread.
 */
export async function keepMessage(
  db: Database, organizationId: string, offerId: string, message: MarketplaceMessage,
): Promise<boolean> {
  return inTenant({ actor: intakeActor(organizationId), db }, (tx) => keepMessageIn(tx, organizationId, offerId, message));
}

export async function keepMessageIn(
  tx: Database, organizationId: string, offerId: string,
  message: { externalId: string; body: string; at: Date; from: "customer" | "business" },
): Promise<boolean> {
  const [kept] = await tx.insert(schema.leadOfferMessage).values({
    organizationId,
    offerId,
    direction: message.from === "business" ? "outbound" : "inbound",
    body: message.body,
    externalId: message.externalId,
    state: message.from === "business" ? "sent" : "received",
    at: message.at,
  }).onConflictDoNothing().returning({ id: schema.leadOfferMessage.id });
  if (!kept) return false;
  await tx.update(schema.leadOffer).set({ lastMessageAt: message.at, updatedAt: new Date() })
    .where(eq(schema.leadOffer.id, offerId));
  return true;
}

/* ---------------------------------------------------------- one offer */

/** Why a reply cannot go back through this lead's source, or null when it can. */
function cannotReply(kind: string, source: string): string | null {
  if (kind === "thumbtack" || kind === "yelp") return null;
  const platform = mp.isMarketplace(source) ? mp.MARKETPLACES[source] : null;
  if (kind === "angi" || platform?.key === "angi") return "Angi has no way to send a customer a message from outside its own app. Ring or text them.";
  if (kind === "email" && platform) {
    return `This lead was read from ${platform.label}'s email, and a reply cannot be sent back that way. Answer on ${platform.label}, or ring them.`;
  }
  return "This lead source takes no replies. Ring or text the customer.";
}

export async function offerDetail(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const [row] = await tx.select({ offer: schema.leadOffer, connector: schema.leadSourceConnector })
      .from(schema.leadOffer)
      .innerJoin(schema.leadSourceConnector, eq(schema.leadSourceConnector.id, schema.leadOffer.connectorId))
      .where(and(eq(schema.leadOffer.organizationId, ctx.actor.organizationId), eq(schema.leadOffer.id, input.id)))
      .limit(1);
    if (!row) throw new NotFoundError("Lead offer");
    const { offer, connector } = row;
    const messages = await tx.select().from(schema.leadOfferMessage)
      .where(eq(schema.leadOfferMessage.offerId, offer.id))
      .orderBy(asc(schema.leadOfferMessage.at), asc(schema.leadOfferMessage.createdAt));
    const [campaign] = connector.acquisitionCampaignId
      ? await tx.select({ name: schema.acquisitionCampaign.name }).from(schema.acquisitionCampaign)
        .where(eq(schema.acquisitionCampaign.id, connector.acquisitionCampaignId)).limit(1)
      : [];
    const [channel] = connector.channelId
      ? await tx.select({ name: schema.marketingChannel.name }).from(schema.marketingChannel)
        .where(eq(schema.marketingChannel.id, connector.channelId)).limit(1)
      : [];
    const now = Date.now();
    const why = cannotReply(connector.kind, connector.source);
    return {
      id: offer.id,
      status: offer.status,
      connector: connector.displayName,
      kind: connector.kind,
      source: connector.source,
      channelName: channel?.name ?? null,
      campaignName: campaign?.name ?? null,
      externalId: offer.externalId,
      contactName: offer.contactName,
      contactPhone: offer.contactPhone,
      contactEmail: offer.contactEmail,
      serviceRequested: offer.serviceRequested,
      notes: offer.notes,
      addressLine1: offer.addressLine1,
      city: offer.city,
      state: offer.state,
      postalCode: offer.postalCode,
      estimatedValue: offer.estimatedValue,
      charge: offer.charge,
      expiresAt: offer.expiresAt?.toISOString() ?? null,
      expired: offer.expiresAt ? offer.expiresAt.getTime() <= now : false,
      customerId: offer.customerId,
      jobId: offer.jobId,
      declineReason: offer.declineReason,
      createdAt: offer.createdAt.toISOString(),
      canReply: why === null,
      cannotReplyBecause: why,
      messages: messages.map((msg) => ({
        id: msg.id,
        direction: msg.direction,
        body: msg.body,
        state: msg.state,
        error: msg.error,
        at: msg.at.toISOString(),
      })),
    };
  });
}

/**
 * A reply to the customer, through the marketplace.
 *
 * Written down as `sending` and committed BEFORE the platform is asked, so a
 * second press finds it and a crash between the two leaves a row that says
 * so rather than a reply nobody knows went. The platform's refusal is kept on
 * the row in its words and the reply stays in the thread marked as not sent.
 */
export async function sendOfferMessage(
  ctx: ServiceContext, input: { id: string; body: string }, deps: MarketplaceDeps = {},
): Promise<{ id: string; state: string; error: string | null }> {
  const text = input.body.trim();
  if (text === "") throw new ConflictError("Write the reply first.");
  if (text.length > 2000) throw new ConflictError("Keep a reply under two thousand characters; the marketplaces cut longer ones off.");

  const claimed = await guardedWrite(ctx, "message:send", async (tx) => {
    const again = await replayed<{ id: string; state: string; error: string | null }>(tx, ctx, "lead_offer_message");
    if (again) return { replay: again };
    const [row] = await tx.select({ offer: schema.leadOffer, connector: schema.leadSourceConnector })
      .from(schema.leadOffer)
      .innerJoin(schema.leadSourceConnector, eq(schema.leadSourceConnector.id, schema.leadOffer.connectorId))
      .where(and(eq(schema.leadOffer.organizationId, ctx.actor.organizationId), eq(schema.leadOffer.id, input.id)))
      .limit(1);
    if (!row) throw new NotFoundError("Lead offer");
    const why = cannotReply(row.connector.kind, row.connector.source);
    if (why) throw new ConflictError(why);
    const [connection] = row.connector.connectionId
      ? await tx.select().from(schema.integrationConnection)
        .where(eq(schema.integrationConnection.id, row.connector.connectionId)).limit(1)
      : [];
    if (!connection || connection.status !== "connected") {
      throw new ConflictError(`${row.connector.displayName} is not connected, so a reply has nowhere to go.`);
    }
    const [message] = await tx.insert(schema.leadOfferMessage).values({
      organizationId: ctx.actor.organizationId,
      offerId: row.offer.id,
      direction: "outbound",
      body: text,
      state: "sending",
      sentByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    }).returning({ id: schema.leadOfferMessage.id });
    await audit(tx, ctx, "lead_offer.reply_started", "lead_offer", row.offer.id, null, { messageId: message!.id });
    return { messageId: message!.id, offer: row.offer, connector: row.connector, connection };
  });
  if ("replay" in claimed && claimed.replay) return claimed.replay;

  const { connector, connection, offer, messageId } = claimed;
  let state = "sent";
  let error: string | null = null;
  let externalId: string | null = null;
  try {
    const settings = (connection.settings ?? {}) as Record<string, unknown>;
    const tokenRef = typeof settings["apiTokenRef"] === "string" ? settings["apiTokenRef"] : null;
    const apiToken = tokenRef ? await (deps.readSecret ?? envSecret)(tokenRef) : null;
    const adapter: MarketplaceAdapter = createMarketplace(connector.kind, {
      settings, webhookSecret: null, apiToken,
      transport: deps.transport ?? (globalThis.fetch as unknown as HttpTransport),
    });
    if (!adapter.sendMessage) throw new PlatformRefusedError(`${connector.displayName} takes no replies.`);
    externalId = (await adapter.sendMessage(offer.externalId, text)).externalId;
  } catch (failure) {
    state = "failed";
    error = (failure as Error).message.slice(0, 1000);
  }

  return guardedWrite(ctx, "message:send", async (tx) => {
    const now = new Date();
    await tx.update(schema.leadOfferMessage).set({
      state, error, externalId, at: now, updatedAt: now,
    }).where(eq(schema.leadOfferMessage.id, messageId));
    if (state === "sent") {
      await tx.update(schema.leadOffer).set({ lastMessageAt: now, updatedAt: now }).where(eq(schema.leadOffer.id, offer.id));
    }
    await audit(tx, ctx, state === "sent" ? "lead_offer.replied" : "lead_offer.reply_failed", "lead_offer", offer.id, null,
      { messageId, ...(error ? { error } : {}) });
    const answer = { id: messageId, state, error };
    await remember(tx, ctx, "lead_offer_message", messageId, answer);
    return answer;
  });
}

/* ---------------------------------------------------------------- handlers */

export const handlers = {
  connectLeadMarketplace: (ctx: ServiceContext, input: MarketplaceSetup) => connectMarketplace(ctx, input),
  getLeadOffer: (ctx: ServiceContext, input: { id: string }) => offerDetail(ctx, input),
  sendLeadOfferMessage: (ctx: ServiceContext, input: { id: string; body: string }) => sendOfferMessage(ctx, input),
} as const;
