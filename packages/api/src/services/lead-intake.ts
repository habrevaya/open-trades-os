import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { connectors as cat, marketing as mk, assertCan } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, NotFoundError, ConflictError,
  type ServiceContext,
} from "./context";
import * as marketingService from "./marketing";
import * as acquisition from "./acquisition";
import { resolveConnectorChannel } from "./lead-connectors";
import { afterConnect, forgetGrant } from "./ad-platforms";
import { nextNumber } from "./jobs";
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
  /**
   * Where the provider has to send its webhooks for this connection, after
   * the deployment's own public address. Null when nothing is connected or
   * the provider sends nothing back.
   */
  webhookPath: string | null;
  /** The name of the secret holding the credential. Never the value. */
  credentialRef: string | null;
  /**
   * Something the operator has to do that nothing else on the row says. Today
   * only one thing: a secret's value is still in the database from before
   * secrets moved to the store, and which name to move it to.
   */
  notice: string | null;
}

/** A secret value stored in settings by an older version, as a sentence to act on. */
export function legacySecretNotice(provider: string, settings: Record<string, unknown> | null): string | null {
  const legacy = cat.LEGACY_SECRET_SETTINGS[provider] ?? {};
  const held = Object.keys(legacy).filter((key) => settings?.[key] !== undefined);
  if (held.length === 0) return null;
  return held.map((key) =>
    `A secret is stored in this product's database as "${key}" from an earlier version. It still works, `
    + `and it should not be there: put it in your secret store and enter its name as "${legacy[key]}". `
    + `The stored copy is deleted when you do.`).join(" ");
}

/**
 * Where a connection's webhooks arrive. Messaging and email route on a token
 * in the path, because the token is a secret the provider must already hold
 * and it sits inside the URL the signature covers; payments route on the
 * connection id and verify with the signing secret.
 */
function webhookPathOf(row: typeof schema.integrationConnection.$inferSelect): string | null {
  const token = (row.settings as Record<string, unknown> | null)?.["webhookToken"];
  if (row.capability === "payments") return `/api/webhooks/payments/${row.id}`;
  if (typeof token !== "string" || token === "") return null;
  if (row.capability === "messaging") return `/api/webhooks/messaging/${token}`;
  if (row.capability === "email") return `/api/webhooks/email/${token}`;
  return null;
}

/** The capabilities whose inbound webhooks are routed by a token in the path. */
const TOKEN_ROUTED = new Set(["messaging", "email"]);

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
        webhookPath: connection && connection.status === "connected" ? webhookPathOf(connection) : null,
        credentialRef: connection?.credentialRef ?? null,
        notice: connection
          ? legacySecretNotice(spec.key, connection.settings as Record<string, unknown> | null)
          : null,
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
  input: {
    provider: string; accountLabel?: string; settings?: Record<string, unknown>; credentialRef?: string;
    /**
     * Keep what the connection already holds and change only what is sent.
     *
     * The API replaces, which is what a caller holding the whole settings
     * object wants. A settings screen does not hold it: it never shows the
     * values back (a webhook token is a credential), so replacing would make
     * changing the label wipe the token Twilio is calling, and every webhook
     * after that is refused. Merged with jsonb `||`, so a key sent replaces
     * that key and nothing else.
     */
    keepExisting?: boolean;
  },
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

    /**
     * Only keys this provider reads, and never a secret's value. The column
     * is plain jsonb; `credentialRef` and every `...Ref` setting hold the
     * NAME of a secret in the deployment's store. A key that once held a
     * value is refused with the name of the key that replaced it.
     */
    if (input.credentialRef && cat.looksLikeSecretValue(input.credentialRef)) {
      throw new ConflictError(
        "The credential is the NAME your deployment keeps the secret under, and that looks like the "
        + "secret itself. Nothing was saved. Put the value in your secret store and send its name.",
      );
    }
    const checked = cat.checkConnectorSettings(spec.key, input.settings ?? {});
    if (!checked.ok) throw new ConflictError(checked.reason);

    /**
     * A legacy secret value is removed the moment its replacement name is
     * set, so the copy in the database does not outlive the move.
     */
    const legacy = cat.LEGACY_SECRET_SETTINGS[spec.key] ?? {};
    const superseded = Object.entries(legacy)
      .filter(([, replacement]) => (input.settings ?? {})[replacement] !== undefined)
      .map(([key]) => key);
    const merged = superseded.reduce(
      (acc, key) => sql`${acc} - ${key}::text`,
      sql`${schema.integrationConnection.settings}`,
    );

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
      set: input.keepExisting
        ? {
          status: "connected",
          ...(input.accountLabel ? { accountLabel: input.accountLabel } : {}),
          ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
          settings: sql`(${merged}) || ${JSON.stringify(input.settings ?? {})}::jsonb`,
          lastError: null,
          updatedAt: new Date(),
        }
        : {
          status: "connected",
          accountLabel: input.accountLabel ?? spec.label,
          credentialRef: input.credentialRef ?? null,
          settings: input.settings ?? {},
          lastError: null,
          updatedAt: new Date(),
        },
    }).returning();

    /**
     * A messaging or email connection with no webhook token can send and
     * never hear back: replies, delivery receipts and bounces all route on
     * the token, and the docs used to ask the operator to invent one of at
     * least 32 characters by hand. One is minted here when none is set, and
     * an existing one is never replaced, because the provider is already
     * calling it.
     */
    let connected = row!;
    const held = (connected.settings ?? {}) as Record<string, unknown>;
    if (TOKEN_ROUTED.has(spec.capability) && typeof held["webhookToken"] !== "string") {
      [connected] = await tx.update(schema.integrationConnection).set({
        settings: { ...held, webhookToken: randomBytes(32).toString("base64url") },
        updatedAt: new Date(),
      }).where(eq(schema.integrationConnection.id, connected.id)).returning() as [typeof connected];
    }

    /**
     * An ad platform that signs in through OAuth waits in `pending` until
     * somebody has, rather than reading "connected" with nothing able to
     * pull. Its settings are checked there too.
     */
    connected = await afterConnect(tx, connected);

    await audit(tx, ctx, "connector.connected", "integration_connection", connected.id, null, {
      provider: spec.key,
    });
    return { id: connected.id, provider: spec.key, status: connected.status };
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
    /** An ad platform's sealed grant goes with it, so a switched off Google is not a kept Google token. */
    await forgetGrant(tx, row.id);

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
  input: {
    provider: string; source?: string | undefined; text: string;
    channelId?: string | undefined; campaignId?: string | undefined;
  },
) {
  /**
   * The channel or campaign named for the whole file decides its key, so a
   * company that set up "Google Ads: Spring AC tune up" uploads the export
   * against that and nothing else.
   */
  const declared = input.channelId || input.campaignId
    ? await guardedRead(ctx, "adspend:read", (tx) => acquisition.resolveDeclared(tx, ctx.actor.organizationId, {
      channelId: input.channelId, campaignId: input.campaignId,
    }))
    : null;
  const source = declared?.sourceKey ?? input.source ?? "";
  const adapter = createSpendSource(input.provider);
  const parsed = adapter.parse({ text: input.text, settings: { source } });
  if (!parsed.ok) throw new ConflictError(parsed.reason);

  const result = await marketingService.importSpend(ctx, {
    origin: input.provider,
    rows: parsed.rows.map((row) => ({
      source: row.source,
      ...(declared ? { channelId: declared.channelId, campaignId: declared.campaignId } : {}),
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
      /**
       * WHO TO RING. The adapter has always parsed these and this insert never
       * wrote them, so the open offers list showed an address with no name and
       * no number on it, and accepting an offer had nobody to create.
       */
      contactName: input.lead.contactName,
      contactPhone: input.lead.contactPhone,
      contactEmail: input.lead.contactEmail,
      notes: input.lead.notes,
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
    /**
     * Credited to the CONNECTOR'S CHANNEL, never to the sender's free text.
     *
     * This passed the connector's own name ("angi") straight to the touch, the
     * touch refused anything outside the catalogue, and the lead the
     * marketplace had been paid for was rolled back with it: the documented
     * example connector could not receive a single lead. The channel is
     * resolved from the company's list when the connector is set up, and for
     * a connector made before that, from its name through the alias list,
     * landing on the marketplace channel when nothing matches, because a lead
     * webhook is a marketplace until somebody says otherwise.
     *
     * The touch carries the caller's number and the offer as its anonymous
     * thread, so accepting the offer stitches it to the customer it becomes,
     * and the lead counts as a person in the meantime.
     */
    const [connector] = await tx.select({
      source: schema.leadSourceConnector.source,
      channelId: schema.leadSourceConnector.channelId,
    }).from(schema.leadSourceConnector)
      .where(eq(schema.leadSourceConnector.id, input.connectorId)).limit(1);
    const channel = await resolveConnectorChannel(tx, input.organizationId, {
      source: connector?.source ?? input.lead.source,
      channelId: connector?.channelId ?? null,
    });
    await marketingService.recordDeclaredTouch(tx, input.organizationId, {
      at: new Date(),
      source: channel.sourceKey,
      channelId: channel.channelId,
      callerE164: mk.callerKey(input.lead.contactPhone),
      visitorId: offerThread(offer!.id),
    });

    return { accepted: true, offerId: offer!.id, duplicate: false, reason: null };
  });
}

/** The anonymous thread a lead offer's touch carries until it is accepted. */
export const offerThread = (offerId: string) => `lead_offer:${offerId}`;

function offerView(
  offer: typeof schema.leadOffer.$inferSelect,
  connector: string,
  now: number,
) {
  return {
    id: offer.id,
    connector,
    status: offer.status,
    contactName: offer.contactName,
    contactPhone: offer.contactPhone,
    contactEmail: offer.contactEmail,
    notes: offer.notes,
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
    customerId: offer.customerId,
    jobId: offer.jobId,
    decidedAt: offer.decidedAt,
    declineReason: offer.declineReason,
  };
}

/** What is on the table, soonest to expire first, and what was decided lately. */
export async function openOffers(ctx: ServiceContext, input: { include?: "open" | "all" | undefined } = {}) {
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
        ...(input.include === "all" ? [] : [eq(schema.leadOffer.status, "offered")]),
      ))
      .orderBy(asc(schema.leadOffer.status), schema.leadOffer.expiresAt, desc(schema.leadOffer.createdAt))
      .limit(200);

    const now = Date.now();
    return rows.map(({ offer, connector }) => offerView(offer, connector, now));
  });
}

async function loadOffer(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.leadOffer)
    .where(and(eq(schema.leadOffer.organizationId, organizationId), eq(schema.leadOffer.id, id)))
    .limit(1);
  if (!row) throw new NotFoundError("Lead offer");
  return row;
}

export interface AcceptInput {
  id: string;
  /** An existing customer to put it on, when the office knows them. */
  customerId?: string | undefined;
  /** An existing property, when the offer's address is one already on file. */
  propertyId?: string | undefined;
  /** The job's summary, when the offer's own words are not the ones wanted. */
  summary?: string | undefined;
}

/**
 * ACCEPTING IS WHAT MATERIALISES WORK.
 *
 * A customer (the one named, else one already holding this phone number or
 * email, else a new one), a property (the one named, else the offer's address,
 * else the customer's primary property), and a job, all in one transaction,
 * and the job credited by the same `creditWork` every other path uses: the
 * marketplace's declared touch is stitched to the customer through the
 * offer's thread and tagged with the job, so the channel that sold the lead is
 * the channel that gets the work.
 *
 * Accepting twice returns the first acceptance. A marketplace offer is often
 * accepted from two screens in the same minute, and two jobs for one lead is
 * a van at a house twice.
 */
export async function acceptOffer(ctx: ServiceContext, input: AcceptInput) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    assertCan(ctx.actor, "customer:write");
    const offer = await loadOffer(tx, ctx.actor.organizationId, input.id);
    if (offer.status === "accepted" && offer.jobId) {
      return { offerId: offer.id, customerId: offer.customerId!, propertyId: offer.propertyId!, jobId: offer.jobId };
    }
    if (offer.status !== "offered") {
      throw new ConflictError(`This lead was ${offer.status} already, so it cannot be accepted now.`);
    }
    if (offer.expiresAt && offer.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError(
        "This offer has expired. The marketplace has most likely given it to somebody else, so accepting "
        + "it here would put a job on the board for work that is no longer yours.",
      );
    }

    const org = ctx.actor.organizationId;
    const caller = mk.callerKey(offer.contactPhone);
    let customerId = input.customerId ?? null;
    if (!customerId) {
      /**
       * An existing customer first, matched on the normalised phone or the
       * email, because the homeowner who found you on Angi this year may be
       * the one you serviced in 2023, and a second record for them splits
       * their history in two.
       */
      const candidates = await tx.select({ id: schema.customer.id, phone: schema.customer.phone, email: schema.customer.email })
        .from(schema.customer)
        .where(and(eq(schema.customer.organizationId, org), isNull(schema.customer.deletedAt)))
        .orderBy(asc(schema.customer.createdAt));
      const match = candidates.find((c) =>
        (caller && mk.callerKey(c.phone) === caller)
        || (offer.contactEmail && c.email?.toLowerCase() === offer.contactEmail.toLowerCase()));
      customerId = match?.id ?? null;
    }
    if (!customerId) {
      const [created] = await tx.insert(schema.customer).values({
        organizationId: org,
        name: offer.contactName ?? "Lead",
        phone: caller ?? offer.contactPhone,
        email: offer.contactEmail?.toLowerCase() ?? null,
      }).returning({ id: schema.customer.id });
      customerId = created!.id;
    }

    let propertyId = input.propertyId ?? null;
    if (!propertyId && offer.addressLine1 && offer.city && offer.state && offer.postalCode) {
      const [existing] = await tx.select({ id: schema.property.id }).from(schema.property)
        .where(and(
          eq(schema.property.organizationId, org),
          sql`lower(${schema.property.addressLine1}) = lower(${offer.addressLine1})`,
          eq(schema.property.postalCode, offer.postalCode),
        )).limit(1);
      propertyId = existing?.id ?? (await tx.insert(schema.property).values({
        organizationId: org,
        addressLine1: offer.addressLine1,
        city: offer.city,
        state: offer.state,
        postalCode: offer.postalCode,
      }).returning({ id: schema.property.id }))[0]!.id;
    }
    if (!propertyId) {
      const [primary] = await tx.select({ id: schema.customerProperty.propertyId })
        .from(schema.customerProperty)
        .where(and(eq(schema.customerProperty.customerId, customerId), eq(schema.customerProperty.isPrimary, true)))
        .limit(1);
      propertyId = primary?.id ?? null;
    }
    if (!propertyId) {
      throw new ConflictError(
        "This lead came with no address and the customer has none on file, so there is nowhere to send "
        + "anybody. Choose a property, or add the address to the customer first.",
      );
    }
    const [linked] = await tx.select({ id: schema.customerProperty.id }).from(schema.customerProperty)
      .where(and(eq(schema.customerProperty.customerId, customerId), eq(schema.customerProperty.propertyId, propertyId)))
      .limit(1);
    if (!linked) {
      await tx.insert(schema.customerProperty).values({
        organizationId: org, customerId, propertyId, role: "owner", isPrimary: true,
      });
    }

    const [connector] = await tx.select({ displayName: schema.leadSourceConnector.displayName })
      .from(schema.leadSourceConnector).where(eq(schema.leadSourceConnector.id, offer.connectorId)).limit(1);
    const number = await nextNumber(tx, org, "job");
    const [job] = await tx.insert(schema.job).values({
      organizationId: org,
      number,
      customerId,
      propertyId,
      status: "lead",
      summary: input.summary?.trim() || offer.serviceRequested || `Lead from ${connector?.displayName ?? "a marketplace"}`,
      description: offer.notes,
      customerComplaint: offer.notes,
    }).returning({ id: schema.job.id });

    await marketingService.identify(tx, org, { visitorId: offerThread(offer.id), customerId });
    await marketingService.creditWork(tx, org, { jobId: job!.id });

    await tx.update(schema.leadOffer).set({
      status: "accepted",
      customerId,
      propertyId,
      jobId: job!.id,
      decidedAt: new Date(),
      decidedBy: ctx.actor.userId,
      updatedAt: new Date(),
    }).where(eq(schema.leadOffer.id, offer.id));

    await audit(tx, ctx, "lead_offer.accepted", "lead_offer", offer.id,
      { status: offer.status }, { status: "accepted", customerId, propertyId, jobId: job!.id });

    return { offerId: offer.id, customerId, propertyId, jobId: job!.id };
  });
}

/**
 * The reasons an offer is turned down, as a list, because the point of
 * recording one is to count it: "outside our area" forty times is a map
 * problem and "no capacity" forty times is a hiring problem.
 */
export const DECLINE_REASONS = {
  no_capacity: "No capacity on the board",
  outside_area: "Outside where we work",
  not_our_work: "Not work we do",
  too_small: "Too small to be worth the trip",
  duplicate: "Already a customer or already booked",
  bad_lead: "Wrong number, spam or not a real enquiry",
  other: "Something else",
} as const;

export async function declineOffer(ctx: ServiceContext, input: {
  id: string; reason: keyof typeof DECLINE_REASONS; note?: string | undefined;
}) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const offer = await loadOffer(tx, ctx.actor.organizationId, input.id);
    if (offer.status === "declined") return { offerId: offer.id, status: "declined" as const };
    if (offer.status !== "offered") {
      throw new ConflictError(`This lead was ${offer.status} already, so it cannot be declined now.`);
    }
    if (!(input.reason in DECLINE_REASONS)) {
      throw new ConflictError("Choose why it is being turned down, so the reasons can be counted.");
    }
    /**
     * The touch stays. A declined lead still cost something and still says
     * the channel is producing work this company cannot take, which is a
     * different problem from a channel producing nothing.
     */
    const reason = input.note?.trim()
      ? `${input.reason}: ${input.note.trim()}`
      : input.reason;
    await tx.update(schema.leadOffer).set({
      status: "declined",
      declineReason: reason,
      decidedAt: new Date(),
      decidedBy: ctx.actor.userId,
      updatedAt: new Date(),
    }).where(eq(schema.leadOffer.id, offer.id));
    await audit(tx, ctx, "lead_offer.declined", "lead_offer", offer.id,
      { status: offer.status }, { status: "declined", reason });
    return { offerId: offer.id, status: "declined" as const };
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
    keepExisting?: boolean | undefined;
  }) => connect(ctx, {
    provider: input.provider,
    ...(input.accountLabel ? { accountLabel: input.accountLabel } : {}),
    ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
    settings: input.settings,
    ...(input.keepExisting ? { keepExisting: true } : {}),
  }),

  disconnectConnector: (ctx: ServiceContext, input: { provider: string }) =>
    disconnect(ctx, input.provider),

  importSpendFile: (ctx: ServiceContext, input: {
    provider: string; source?: string | undefined; text: string;
    channelId?: string | undefined; campaignId?: string | undefined;
  }) => importSpendFile(ctx, input),

  listLeadOffers: async (ctx: ServiceContext, input: { include?: "open" | "all" | undefined } = {}) =>
    ({ offers: await openOffers(ctx, input) }),

  acceptLeadOffer: (ctx: ServiceContext, input: AcceptInput) => acceptOffer(ctx, input),

  declineLeadOffer: (ctx: ServiceContext, input: {
    id: string; reason: keyof typeof DECLINE_REASONS; note?: string | undefined;
  }) => declineOffer(ctx, input),
} as const;
