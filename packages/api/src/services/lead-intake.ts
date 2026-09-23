import { and, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { connectors as cat } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, NotFoundError, ConflictError, inTenant,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";
import * as marketingService from "./marketing";
import {
  createLeadSource, createSpendSource, registeredLeadSources, registeredSpendSources,
  type InboundLead, type WebhookRequest,
} from "../marketing/index";

/**
 * LEADS ARRIVING FROM OUTSIDE
 *
 * `lead_source_connector` and `lead_offer` were in the schema with a comment
 * describing the whole loop: "authenticate, receive an offer, accept or
 * decline against REAL capacity, materialize customer, property and job,
 * sync status both directions, reconcile the payout", and saying "Angi,
 * Thumbtack, Networx, home warranty networks, manufacturer dealer programs
 * and Neighbrium all fit it". Neither table had a single writer.
 *
 * WHY AN OFFER IS NOT A JOB
 *
 * The temptation is to create the job on arrival, because it is fewer tables
 * and the dispatch board fills up. It is wrong for a reason specific to this
 * market: a marketplace lead is an OFFER, it costs money to accept, it
 * expires in minutes, and a contractor at capacity has to be able to decline
 * without that decision being a cancelled job on their own board. Creating
 * the job first means declining is a deletion, and a deleted job takes the
 * evidence of the decision with it.
 *
 * So an offer is stored as an offer, with what was paid for it and what was
 * promised back, and accepting is the thing that materialises work.
 */

/* ------------------------------------------------------------ connectors */

export interface ConnectorView {
  key: string;
  label: string;
  capability: string;
  auth: string;
  flows: string[];
  state: string;
  purpose: string;
  setup: string;
  limitation: string;
  /** Whether THIS company has it connected, as opposed to whether it exists. */
  connected: boolean;
  connectionStatus: string | null;
  lastError: string | null;
}

/**
 * Every connector the product knows, and whether this company has it on.
 *
 * Two different questions, answered as two fields, because collapsing them
 * is the exact mistake the catalogue exists to prevent. `state` says whether
 * an adapter exists at all; `connected` says whether this company set it up.
 * A screen that showed one checkbox could only be lying about one of them.
 */
export async function catalogue(ctx: ServiceContext): Promise<ConnectorView[]> {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const rows = await tx.select().from(schema.integrationConnection)
      .where(and(
        eq(schema.integrationConnection.organizationId, ctx.actor.organizationId),
        isNull(schema.integrationConnection.deletedAt),
      ));
    const byProvider = new Map(rows.map((row) => [row.provider, row]));

    return cat.CONNECTORS.map((spec) => {
      const connection = byProvider.get(spec.key);
      return {
        key: spec.key,
        label: spec.label,
        capability: spec.capability,
        auth: spec.auth,
        flows: [...spec.flows],
        state: spec.state,
        purpose: spec.purpose,
        setup: spec.setup,
        limitation: spec.limitation,
        connected: connection?.status === "connected",
        connectionStatus: connection?.status ?? null,
        lastError: connection?.lastError ?? null,
      };
    });
  });
}

/**
 * Turn a connector on for this company.
 *
 * Refuses anything the catalogue calls `declared`, and that refusal is the
 * point of the whole file. Letting an operator connect a provider with no
 * adapter behind it produces a settings screen that says Google Ads is
 * connected, a spend report with no Google spend in it, and an owner
 * concluding that Google is a free channel. The error says which it is.
 */
export async function connect(
  ctx: ServiceContext,
  input: { provider: string; accountLabel?: string; settings?: Record<string, unknown>; credentialRef?: string },
) {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const spec = cat.connector(input.provider);
    if (!spec) {
      throw new NotFoundError(`Connector "${input.provider}"`);
    }
    if (spec.state !== "built") {
      throw new ConflictError(
        `${spec.label} is named in this product and is not built yet, so connecting it would move no data. `
        + `What it will do: ${spec.purpose} `
        + `What it needs when it exists: ${spec.setup}`,
      );
    }

    const [row] = await tx.insert(schema.integrationConnection).values({
      organizationId: ctx.actor.organizationId,
      capability: spec.capability as typeof schema.capability.enumValues[number],
      provider: spec.key,
      status: "connected",
      accountLabel: input.accountLabel ?? spec.label,
      credentialRef: input.credentialRef ?? null,
      settings: input.settings ?? {},
    }).onConflictDoUpdate({
      target: [
        schema.integrationConnection.organizationId,
        schema.integrationConnection.capability,
        schema.integrationConnection.provider,
      ],
      set: {
        status: "connected",
        accountLabel: input.accountLabel ?? spec.label,
        credentialRef: input.credentialRef ?? null,
        settings: input.settings ?? {},
        lastError: null,
        updatedAt: new Date(),
      },
    }).returning();

    await audit(tx, ctx, "connector.connected", "integration_connection", row!.id, null, {
      provider: spec.key,
    });
    return { id: row!.id, provider: spec.key, status: row!.status };
  });
}

export async function disconnect(ctx: ServiceContext, provider: string) {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const [row] = await tx.update(schema.integrationConnection)
      .set({ status: "disconnected", updatedAt: new Date() })
      .where(and(
        eq(schema.integrationConnection.organizationId, ctx.actor.organizationId),
        eq(schema.integrationConnection.provider, provider),
        isNull(schema.integrationConnection.deletedAt),
      )).returning();
    if (!row) throw new NotFoundError("Connection");

    await audit(tx, ctx, "connector.disconnected", "integration_connection", row.id, null, { provider });
    return { provider, status: row.status };
  });
}

/* ------------------------------------------------------------ spend files */

/**
 * Load a spend export through the adapter for its format.
 *
 * The parse and the write are separate on purpose. The adapter turns bytes
 * into rows and touches no database; the service applies the catalogue
 * check, the manual-versus-imported rule and the idempotency. A parser that
 * wrote its own rows would have to be trusted with all three, and there will
 * eventually be eight of them.
 */
export async function importSpendFile(
  ctx: ServiceContext,
  input: { provider: string; source: string; text: string },
) {
  const adapter = createSpendSource(input.provider);
  const parsed = adapter.parse({ text: input.text, settings: { source: input.source } });
  if (!parsed.ok) throw new ConflictError(parsed.reason);

  const result = await marketingService.importSpend(ctx, {
    origin: input.provider,
    rows: parsed.rows.map((row) => ({
      source: row.source,
      campaign: row.campaign,
      spentOn: row.spentOn,
      amount: row.amount,
      impressions: row.impressions,
      clicks: row.clicks,
      externalId: row.externalId,
    })),
  });

  return {
    accepted: result.accepted,
    refused: result.refused,
    /**
     * Reported separately from refusals. A line this could not read and a
     * row the service rejected are different problems with different fixes,
     * and merging them sends somebody to the wrong one.
     */
    skipped: parsed.skipped,
  };
}

/* ------------------------------------------------------------ lead intake */

export interface IntakeOutcome {
  accepted: boolean;
  offerId: string | null;
  duplicate: boolean;
  reason: string | null;
}

/**
 * A lead arriving on the webhook.
 *
 * Takes a Database rather than a ServiceContext, like every other public
 * intake path in this codebase: the caller is a marketplace with a signing
 * secret, not a user with a session, and the tenant comes from the token in
 * the URL.
 *
 * A REFUSAL IS RETURNED, NOT THROWN. A sender that gets a 500 retries, and a
 * lead this cannot parse will fail identically every time: the retries are
 * pure noise and the sender eventually disables the endpoint. A refusal with
 * a reason lets the endpoint answer 200 for "I have this and it is not
 * usable" and keeps the row so somebody can see what arrived.
 */
export async function receiveLead(
  db: Database,
  input: { connectorId: string; organizationId: string; lead: InboundLead },
): Promise<IntakeOutcome> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;

    const [existing] = await tx.select({ id: schema.leadOffer.id })
      .from(schema.leadOffer)
      .where(and(
        eq(schema.leadOffer.connectorId, input.connectorId),
        eq(schema.leadOffer.externalId, input.lead.externalId),
      )).limit(1);

    if (existing) {
      /**
       * A sender that did not get a 200 sends the identical body again, and
       * that is the ordinary case rather than an attack. Reporting it as a
       * duplicate and answering 200 is what stops a retry storm turning into
       * four identical jobs on a board.
       */
      return { accepted: true, offerId: existing.id, duplicate: true, reason: null };
    }

    const [offer] = await tx.insert(schema.leadOffer).values({
      organizationId: input.organizationId,
      connectorId: input.connectorId,
      externalId: input.lead.externalId,
      status: "offered",
      payload: input.lead.raw,
      serviceRequested: input.lead.serviceRequested,
      addressLine1: input.lead.addressLine1,
      city: input.lead.city,
      state: input.lead.state,
      postalCode: input.lead.postalCode,
      estimatedValue: input.lead.estimatedValue,
      expiresAt: input.lead.expiresAt,
    }).returning({ id: schema.leadOffer.id });

    /**
     * The touch is recorded now, while the offer is still an offer.
     *
     * Not when it is accepted. A marketplace lead that was declined still
     * cost something and still tells an owner that the channel is producing
     * work they cannot take, which is a different problem from a channel
     * producing nothing and needs a different answer.
     */
    await marketingService.recordDeclaredTouch(tx, input.organizationId, {
      at: new Date(),
      source: input.lead.source,
    });

    return { accepted: true, offerId: offer!.id, duplicate: false, reason: null };
  });
}

/** What is on the table, soonest to expire first. */
export async function openOffers(ctx: ServiceContext) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const rows = await tx.select({
      offer: schema.leadOffer,
      connector: schema.leadSourceConnector.displayName,
    }).from(schema.leadOffer)
      .innerJoin(
        schema.leadSourceConnector,
        eq(schema.leadSourceConnector.id, schema.leadOffer.connectorId),
      )
      .where(and(
        eq(schema.leadOffer.organizationId, ctx.actor.organizationId),
        eq(schema.leadOffer.status, "offered"),
      ))
      .orderBy(schema.leadOffer.expiresAt);

    const now = Date.now();
    return rows.map(({ offer, connector }) => ({
      id: offer.id,
      connector,
      serviceRequested: offer.serviceRequested,
      addressLine1: offer.addressLine1,
      city: offer.city,
      state: offer.state,
      postalCode: offer.postalCode,
      estimatedValue: offer.estimatedValue,
      expiresAt: offer.expiresAt,
      /**
       * Computed against the clock, never read from the status. An expired
       * offer whose sweep has not run is still expired, and a board that
       * showed it as live would have somebody accept work the marketplace
       * has already given to a competitor.
       */
      expired: offer.expiresAt ? offer.expiresAt.getTime() <= now : false,
      secondsLeft: offer.expiresAt
        ? Math.max(0, Math.round((offer.expiresAt.getTime() - now) / 1000))
        : null,
    }));
  });
}

/** Which adapters are actually registered. Read by the catalogue test. */
export const registeredAdapters = (): string[] =>
  [...registeredSpendSources(), ...registeredLeadSources()];

export { createLeadSource, type WebhookRequest };

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listConnectors: async (ctx: ServiceContext, input: { capability?: string | undefined }): Promise<{
    connectors: ConnectorView[];
  }> => {
    const all = await catalogue(ctx);
    return {
      connectors: input.capability
        ? all.filter((c) => c.capability === input.capability)
        : all,
    };
  },

  connectConnector: (ctx: ServiceContext, input: {
    provider: string; accountLabel?: string | undefined;
    credentialRef?: string | undefined; settings: Record<string, unknown>;
  }) => connect(ctx, {
    provider: input.provider,
    ...(input.accountLabel ? { accountLabel: input.accountLabel } : {}),
    ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
    settings: input.settings,
  }),

  disconnectConnector: (ctx: ServiceContext, input: { provider: string }) =>
    disconnect(ctx, input.provider),

  importSpendFile: (ctx: ServiceContext, input: {
    provider: string; source: string; text: string;
  }) => importSpendFile(ctx, input),

  listLeadOffers: async (ctx: ServiceContext): Promise<{
    offers: {
      id: string; connector: string; serviceRequested: string | null;
      addressLine1: string | null; city: string | null; state: string | null;
      postalCode: string | null; estimatedValue: string | null;
      expiresAt: Date | null; expired: boolean; secondsLeft: number | null;
    }[];
  }> => ({ offers: await openOffers(ctx) }),
} as const;
