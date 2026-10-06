import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, like, notInArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, ads, time, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";
import * as acquisition from "./acquisition";
import * as leadIntake from "./lead-intake";
import {
  AuthorizationLostError, PlatformRefusedError, createAdsAdapter, exchangeCode, parseOAuthClient, seal,
  sealingKey, tokenSource, unseal, SealingKeyMissingError, SealedUnderAnotherKeyError,
  type AdsAdapter, type HttpTransport, type OAuthClient, type PulledLead,
} from "../ads/index";

/**
 * THE AD PLATFORMS: SIGNING IN, PULLING, AND KEEPING TRACK
 *
 * Google Ads, Local Services, Meta, Google Analytics and the Business Profile
 * are ordinary connections: connected, changed and disconnected through the
 * connector service every integration uses, with settings and secret names
 * checked by core. What this file adds is everything a connection to an ad
 * platform needs that no other integration did.
 *
 *   A SIGN IN. A person presses "Sign in with Google", grants access on
 *   Google's own screen, and comes back. The grant is sealed and kept
 *   (`sealed_credential`); the connection waits in `pending` until it exists.
 *
 *   PULLS ON A CLOCK. Spend into the ordinary spend rows, Local Services leads
 *   into the ordinary lead inbox. Each pull is a `sync_run` row with what it
 *   read, what it wrote and why it stopped, which is the history the status
 *   screen shows and the clock the worker reads.
 *
 *   A MAP from the platform's campaigns to the company's tracking campaigns,
 *   found by name when it can be and chosen by a person when it cannot.
 *
 * Conversions sent back are `ad-conversions.ts`, and reviews read and
 * answered are `review-sync.ts`; both lean on the sign in and the adapter
 * built here.
 */

export type SecretReader = (ref: string) => Promise<string>;

export interface AdsDeps {
  /** The platform's HTTP, which every test replaces with a fake. */
  transport?: HttpTransport | undefined;
  readSecret?: SecretReader | undefined;
  /** Where `PUBLIC_URL` and the sealing key are read from. */
  env?: Record<string, string | undefined> | undefined;
  now?: (() => Date) | undefined;
}

const envSecret: SecretReader = async (ref) => {
  const value = process.env[ref];
  if (!value) throw new ConflictError(`No secret in the environment for "${ref}".`);
  return value;
};

const transportOf = (deps: AdsDeps): HttpTransport =>
  deps.transport ?? (globalThis.fetch as unknown as HttpTransport);
const nowOf = (deps: AdsDeps) => (deps.now ?? (() => new Date()))();

/** The worker's actor: what background ad work needs and nothing else. */
export function adsActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["adspend:read", "adspend:write", "review:respond", "integration:read"],
    agentId: "ad-platforms",
  };
}

const systemCtx = (db: Database, organizationId: string): ServiceContext => ({ actor: adsActor(organizationId), db });

export type Connection = typeof schema.integrationConnection.$inferSelect;

const settingsOf = (row: Connection) => (row.settings ?? {}) as Record<string, unknown>;
const text = (settings: Record<string, unknown>, key: string) => {
  const value = settings[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

/* ------------------------------------------------------------- connecting */

/**
 * What a newly saved connection to an ad platform still needs.
 *
 * Called by the connector service after it writes the row. A provider that
 * signs in through OAuth is left `pending` until a grant exists or the
 * operator named their own token as the credential: a connection that says
 * "connected" with nobody signed in is a settings screen saying spend is
 * being pulled while nothing is.
 */
export async function afterConnect(tx: Database, row: Connection): Promise<Connection> {
  if (!ads.isAdsProvider(row.provider)) return row;
  const settings = settingsOf(row);
  const mode = settings["personalData"];
  if (mode !== undefined && !(ads.PERSONAL_DATA_MODES as readonly unknown[]).includes(mode)) {
    throw new ConflictError(`"personalData" is one of ${ads.PERSONAL_DATA_MODES.join(", ")}.`);
  }
  const spec = ads.PROVIDERS[row.provider];
  if (spec.oauth === null) {
    if (!row.credentialRef) {
      const [updated] = await tx.update(schema.integrationConnection)
        .set({ status: "pending", lastError: "Enter the name of the secret holding the Measurement Protocol API secret.", updatedAt: new Date() })
        .where(eq(schema.integrationConnection.id, row.id)).returning();
      return updated!;
    }
    return row;
  }
  if (row.credentialRef) return row;
  const [grant] = await tx.select({ id: schema.sealedCredential.id }).from(schema.sealedCredential)
    .where(eq(schema.sealedCredential.connectionId, row.id)).limit(1);
  if (grant) return row;
  const [updated] = await tx.update(schema.integrationConnection)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(schema.integrationConnection.id, row.id)).returning();
  return updated!;
}

/**
 * Disconnecting forgets the grant, so a company that turned Google off is not
 * a company whose Google token still sits here. The access the person granted
 * is still listed in their Google account until they remove it there, which
 * the screen says.
 */
export async function forgetGrant(tx: Database, connectionId: string): Promise<void> {
  await tx.delete(schema.sealedCredential).where(eq(schema.sealedCredential.connectionId, connectionId));
}

/** Where a person comes back to after the platform's consent screen. Registered with the platform as is. */
export function signInReturnAddress(env: Record<string, string | undefined> = process.env): string {
  const base = env["PUBLIC_URL"] || env["AUTH_URL"];
  if (!base) {
    throw new ConflictError(
      "Set PUBLIC_URL to this deployment's address first. The platform sends the person back to it after they sign in, "
      + "and it has to match the return address registered with the platform exactly.",
    );
  }
  return `${base.replace(/\/+$/, "")}/settings/integrations/oauth`;
}

const hashState = (state: string) => createHash("sha256").update(state).digest("hex");

async function connectionByProvider(tx: Database, organizationId: string, provider: string): Promise<Connection> {
  const [row] = await tx.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.provider, provider),
      isNull(schema.integrationConnection.deletedAt),
    )).limit(1);
  if (!row || row.status === "disconnected") {
    throw new ConflictError("Save the connection's settings first, then sign in.");
  }
  return row;
}

async function oauthClientFor(row: Connection, readSecret: SecretReader): Promise<OAuthClient> {
  const ref = text(settingsOf(row), "oauthClientRef");
  if (!ref) {
    throw new ConflictError("Enter the name of the secret holding the OAuth client (clientId and clientSecret) first.");
  }
  try {
    return parseOAuthClient(await readSecret(ref));
  } catch (error) {
    throw new ConflictError((error as Error).message);
  }
}

/**
 * Start a sign in: the address to send the person to.
 *
 * Refused before anybody leaves for the platform when this deployment could
 * not keep what comes back (no sealing key), or has no OAuth client to sign in
 * with, because a consent screen that ends in "and then it could not be
 * saved" is a person granting access to nothing.
 */
export async function startSignIn(
  ctx: ServiceContext, input: { provider: string }, deps: AdsDeps = {},
): Promise<{ url: string; expiresAt: string }> {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const again = await replayed<{ url: string; expiresAt: string }>(tx, ctx, "oauth_authorization");
    if (again) return again;
    if (!ads.isAdsProvider(input.provider)) throw new NotFoundError(`Connector "${input.provider}"`);
    const spec = ads.PROVIDERS[input.provider];
    if (!spec.oauth) {
      throw new ConflictError(`${spec.label} has no sign in. It takes an API secret, named on the settings screen.`);
    }
    const env = deps.env ?? process.env;
    try {
      if (!sealingKey(env)) throw new SealingKeyMissingError();
    } catch (error) {
      throw new ConflictError((error as Error).message);
    }
    const row = await connectionByProvider(tx, ctx.actor.organizationId, input.provider);
    const client = await oauthClientFor(row, deps.readSecret ?? envSecret);
    const redirectUri = signInReturnAddress(env);

    const state = randomBytes(32).toString("base64url");
    const now = nowOf(deps);
    const expiresAt = new Date(now.getTime() + ads.AUTHORIZATION_MINUTES * 60_000);
    const [authorization] = await tx.insert(schema.oauthAuthorization).values({
      organizationId: ctx.actor.organizationId,
      connectionId: row.id,
      provider: input.provider,
      stateHash: hashState(state),
      userId: ctx.actor.userId,
      expiresAt,
    }).returning({ id: schema.oauthAuthorization.id });

    const url = ads.authorizeUrl({
      family: spec.oauth,
      endpoint: text(settingsOf(row), "authUrl"),
      clientId: client.clientId,
      redirectUri,
      scopes: spec.scopes,
      state,
    });
    const answer = { url, expiresAt: expiresAt.toISOString() };
    await audit(tx, ctx, "connector.sign_in_started", "integration_connection", row.id, null, { provider: input.provider });
    await remember(tx, ctx, "oauth_authorization", authorization!.id, answer);
    return answer;
  });
}

/**
 * Finish a sign in: trade the code for a grant, seal it, and connect.
 *
 * In three steps rather than one transaction, because the middle one is an
 * HTTP request to the platform and a transaction held open across somebody
 * else's network is a lock held for as long as they take. The state is
 * consumed FIRST, in its own commit, so the same return cannot be replayed
 * while the trade is in flight.
 *
 * A return carrying `error` (the person pressed Cancel, or the platform
 * refused) consumes the state too and writes the reason on the connection.
 */
export async function finishSignIn(
  ctx: ServiceContext,
  input: { state: string; code?: string | undefined; error?: string | undefined },
  deps: AdsDeps = {},
): Promise<{ provider: string; status: string; accountLabel: string | null }> {
  const now = nowOf(deps);
  const env = deps.env ?? process.env;

  const claimed = await guardedWrite(ctx, "integration:write", async (tx) => {
    const [row] = await tx.select().from(schema.oauthAuthorization)
      .where(eq(schema.oauthAuthorization.stateHash, hashState(input.state))).limit(1);
    if (!row) throw new ConflictError("This sign in was not started here. Start it again from Settings, Integrations.");
    if (row.userId !== ctx.actor.userId) {
      throw new ConflictError("This sign in was started by somebody else. Start your own from Settings, Integrations.");
    }
    if (row.consumedAt) {
      const [connection] = await tx.select().from(schema.integrationConnection)
        .where(eq(schema.integrationConnection.id, row.connectionId)).limit(1);
      /** The browser coming back twice (a refresh, a double redirect) after it already worked. */
      if (connection?.status === "connected") {
        return { done: true as const, provider: row.provider, status: connection.status, accountLabel: connection.accountLabel };
      }
      throw new ConflictError("This sign in has already been used. Start it again from Settings, Integrations.");
    }
    if (row.expiresAt.getTime() < now.getTime()) {
      throw new ConflictError("This sign in took longer than a quarter of an hour and has lapsed. Start it again.");
    }
    await tx.update(schema.oauthAuthorization).set({ consumedAt: now, updatedAt: now })
      .where(eq(schema.oauthAuthorization.id, row.id));
    const connection = await connectionByProvider(tx, ctx.actor.organizationId, row.provider);
    return { done: false as const, authorization: row, connection };
  });
  if (claimed.done) return { provider: claimed.provider, status: claimed.status, accountLabel: claimed.accountLabel };

  const { connection, authorization } = claimed;
  const spec = ads.PROVIDERS[authorization.provider as ads.AdsProvider];

  const fail = async (message: string): Promise<never> => {
    await inTenant(ctx, async (tx) => {
      await tx.update(schema.integrationConnection).set({ lastError: message, updatedAt: new Date() })
        .where(eq(schema.integrationConnection.id, connection.id));
      await audit(tx, ctx, "connector.sign_in_failed", "integration_connection", connection.id, null, { message });
    });
    throw new ConflictError(message);
  };

  if (input.error || !input.code) {
    return fail(`${spec.label} did not grant access (${(input.error ?? "no code came back").slice(0, 80)}). Nothing was changed; sign in again to connect.`);
  }

  let grant;
  try {
    const client = await oauthClientFor(connection, deps.readSecret ?? envSecret);
    grant = await exchangeCode({
      family: spec.oauth!,
      scopes: spec.scopes,
      client,
      code: input.code,
      redirectUri: signInReturnAddress(env),
      tokenUrl: text(settingsOf(connection), "tokenUrl"),
      transport: transportOf(deps),
      now,
    });
  } catch (error) {
    return fail((error as Error).message);
  }

  const key = sealingKey(env);
  if (!key) return fail(new SealingKeyMissingError().message);
  const sealed = seal(grant.credential, connection.id, key);

  return inTenant(ctx, async (tx) => {
    await tx.insert(schema.sealedCredential).values({
      organizationId: ctx.actor.organizationId,
      connectionId: connection.id,
      sealedToken: sealed.sealed,
      keyFingerprint: sealed.fingerprint,
      scopes: grant.scopes,
      grantedAt: now,
      grantedByUserId: ctx.actor.userId,
      expiresAt: grant.expiresAt,
    }).onConflictDoUpdate({
      target: [schema.sealedCredential.connectionId],
      set: {
        sealedToken: sealed.sealed, keyFingerprint: sealed.fingerprint, scopes: grant.scopes,
        grantedAt: now, grantedByUserId: ctx.actor.userId, expiresAt: grant.expiresAt,
        rotatedAt: null, updatedAt: now,
      },
    });
    const [updated] = await tx.update(schema.integrationConnection).set({
      status: "connected",
      lastError: null,
      expiresAt: grant.expiresAt,
      scopes: grant.scopes,
      updatedAt: now,
    }).where(eq(schema.integrationConnection.id, connection.id)).returning();
    /** What was granted, never the grant. */
    await audit(tx, ctx, "connector.signed_in", "integration_connection", connection.id, null, {
      provider: connection.provider, scopes: grant.scopes, expiresAt: grant.expiresAt,
    });
    return { provider: connection.provider, status: updated!.status, accountLabel: updated!.accountLabel };
  });
}

/* ------------------------------------------------------------ the adapter */

/**
 * The adapter for one connection, with its token source and its secrets.
 *
 * The grant is the sealed one when a person signed in here, or the secret the
 * operator named as the connection's credential when they keep their own (a
 * Google refresh token from their own vault, a Meta system user token). A
 * Google token handed back in place of a sealed one is resealed at once.
 */
export async function adapterFor(db: Database, row: Connection, deps: AdsDeps = {}): Promise<AdsAdapter> {
  if (!ads.isAdsProvider(row.provider)) throw new NotFoundError(`Ad platform "${row.provider}"`);
  const spec = ads.PROVIDERS[row.provider];
  const settings = settingsOf(row);
  const readSecret = deps.readSecret ?? envSecret;
  const transport = transportOf(deps);
  const env = deps.env ?? process.env;

  const secrets: Record<string, string> = {};
  const developerRef = text(settings, "developerTokenRef");
  if (developerRef) secrets["developerToken"] = await readSecret(developerRef);
  if (row.provider === "ga4" && row.credentialRef) secrets["apiSecret"] = await readSecret(row.credentialRef);

  let token = null;
  if (spec.oauth) {
    const client = spec.oauth !== "meta" ? await oauthClientFor(row, readSecret) : null;
    let credential: string;
    let expiresAt: Date | null = row.expiresAt ?? null;
    let sealedHere = false;
    if (row.credentialRef) {
      credential = await readSecret(row.credentialRef);
      expiresAt = null;
    } else {
      const [grant] = await inTenant(systemCtx(db, row.organizationId), (tx) =>
        tx.select().from(schema.sealedCredential).where(eq(schema.sealedCredential.connectionId, row.id)).limit(1));
      if (!grant) throw new AuthorizationLostError(`Nobody has signed in with ${ads.OAUTH_LABEL[spec.oauth]} for ${spec.label} yet.`);
      const key = sealingKey(env);
      if (!key) throw new AuthorizationLostError(new SealingKeyMissingError().message);
      try {
        credential = unseal(grant.sealedToken, row.id, key);
      } catch (error) {
        if (error instanceof SealedUnderAnotherKeyError) throw new AuthorizationLostError(error.message);
        throw error;
      }
      expiresAt = grant.expiresAt;
      sealedHere = true;
    }
    token = tokenSource({
      family: spec.oauth,
      credential,
      expiresAt,
      client,
      tokenUrl: text(settings, "tokenUrl"),
      transport,
      ...(deps.now ? { now: deps.now } : {}),
      onRotated: async (next) => {
        if (!sealedHere) {
          console.warn(`[ads] ${spec.label} handed back a new token for a credential kept in the deployment's own store; update it there.`);
          return;
        }
        const key = sealingKey(env)!;
        const resealed = seal(next, row.id, key);
        await inTenant(systemCtx(db, row.organizationId), (tx) =>
          tx.update(schema.sealedCredential).set({
            sealedToken: resealed.sealed, keyFingerprint: resealed.fingerprint, rotatedAt: new Date(), updatedAt: new Date(),
          }).where(eq(schema.sealedCredential.connectionId, row.id)));
      },
    });
  }

  return createAdsAdapter(row.provider, { settings, token, secrets, transport });
}

/* ------------------------------------------------------------ one pull */

export type Entity = "spend" | "leads" | "reviews" | "conversions" | "analytics" | "adjustments";

export interface PullOutcome {
  provider: string;
  entity: Entity;
  read: number;
  written: number;
  /** Null when it worked. */
  error: string | null;
  /** True when the grant is gone and a person has to sign in again. */
  needsSignIn: boolean;
}

/**
 * Run one pull for one connection, as a `sync_run` with its outcome.
 *
 * The row is written first, so the clock moves even when the pull throws: a
 * platform that is down is asked again at the next cadence, not on every
 * five second tick. A lost grant marks the connection `needs_reauth`, which
 * takes it out of the worker's list entirely until a person signs in again,
 * because a dead refresh token asked every few minutes is how a client id gets
 * throttled for every company on the deployment.
 */
export async function runPull(
  db: Database,
  row: Connection,
  entity: Entity,
  work: () => Promise<{ read: number; written: number; cursor?: string | null }>,
): Promise<PullOutcome> {
  const ctx = systemCtx(db, row.organizationId);
  const [run] = await inTenant(ctx, (tx) => tx.insert(schema.syncRun).values({
    organizationId: row.organizationId,
    connectionId: row.id,
    direction: entity === "conversions" || entity === "adjustments" ? "outbound" : "inbound",
    entityType: entity,
  }).returning({ id: schema.syncRun.id }));

  try {
    const done = await work();
    await inTenant(ctx, async (tx) => {
      await tx.update(schema.syncRun).set({
        finishedAt: new Date(), recordsRead: done.read, recordsWritten: done.written,
        ...(done.cursor !== undefined ? { cursor: done.cursor } : {}), updatedAt: new Date(),
      }).where(eq(schema.syncRun.id, run!.id));
      await tx.update(schema.integrationConnection).set({ lastError: null, lastCheckedAt: new Date() })
        .where(and(eq(schema.integrationConnection.id, row.id), eq(schema.integrationConnection.status, "connected")));
    });
    return { provider: row.provider, entity, read: done.read, written: done.written, error: null, needsSignIn: false };
  } catch (error) {
    const message = (error as Error).message.slice(0, 1000);
    const lost = error instanceof AuthorizationLostError;
    await inTenant(ctx, async (tx) => {
      await tx.update(schema.syncRun).set({ finishedAt: new Date(), error: message, updatedAt: new Date() })
        .where(eq(schema.syncRun.id, run!.id));
      await tx.update(schema.integrationConnection).set({
        lastError: message, lastCheckedAt: new Date(), ...(lost ? { status: "needs_reauth" as const } : {}),
      }).where(eq(schema.integrationConnection.id, row.id));
    });
    return { provider: row.provider, entity, read: 0, written: 0, error: message, needsSignIn: lost };
  }
}

/** When this connection last started a pull of this kind, successful or not. */
async function lastRun(tx: Database, connectionId: string, entity: Entity, successfulOnly = false) {
  const [run] = await tx.select().from(schema.syncRun)
    .where(and(
      eq(schema.syncRun.connectionId, connectionId),
      eq(schema.syncRun.entityType, entity),
      ...(successfulOnly ? [isNull(schema.syncRun.error), sql`${schema.syncRun.finishedAt} is not null`] : []),
    ))
    .orderBy(desc(schema.syncRun.startedAt)).limit(1);
  return run ?? null;
}

/* ----------------------------------------------------------------- spend */

/** The origin a pulled spend row carries: the API it came through, so Google Ads and Local Services pulls of one account cannot both write a day. */
const originOf = (provider: string) =>
  provider === "meta_ads" || provider === "meta_lead_ads" ? "meta_ads" : provider === "bing_ads" ? "bing_ads" : "google_ads";

/**
 * Pull a connection's spend into the ordinary spend rows.
 *
 * Every day in the window is written again, and a row the platform no longer
 * reports for a day it was asked about is taken out, because "the platform
 * credited that money back" and "this product still counts it" cannot both be
 * true. A row is found again by the platform's campaign and the day, never by
 * the campaign's name, so renaming a campaign in Google does not double last
 * week.
 *
 * Money in a currency other than the company's is refused whole, with the
 * reason, rather than written beside dollars as though it were dollars.
 */
export async function pullSpend(db: Database, row: Connection, deps: AdsDeps = {}): Promise<PullOutcome> {
  const org = row.organizationId;
  const ctx = systemCtx(db, org);
  const provider = row.provider as ads.AdsProvider;
  const now = nowOf(deps);
  const window = await inTenant(ctx, async (tx) => {
    const zone = await timezoneOf(tx, org);
    const last = await lastRun(tx, row.id, "spend", true);
    return ads.spendWindow({ today: time.dateIn(now, zone), lastThrough: last?.cursor ?? null });
  });

  return runPull(db, row, "spend", async () => {
    const adapter = await adapterFor(db, row, deps);
    if (!adapter.pullSpend) return { read: 0, written: 0 };
    const pulled = await adapter.pullSpend(window);

    return inTenant(ctx, async (tx) => {
      const [company] = await tx.select({ currency: schema.organization.currency })
        .from(schema.organization).where(eq(schema.organization.id, org)).limit(1);
      const currency = company?.currency ?? "USD";
      const foreign = pulled.find((p) => p.currency.toUpperCase() !== currency.toUpperCase());
      if (foreign) {
        throw new PlatformRefusedError(
          `This ${ads.PROVIDERS[provider].label} account bills in ${foreign.currency} and the company keeps its books in ${currency}. `
          + "Nothing was pulled, because adding the two together would be wrong in every total.",
        );
      }

      /* The platform's campaigns, found or added, and matched to ours where the names agree. */
      const ours = await tx.select({
        id: schema.acquisitionCampaign.id, name: schema.acquisitionCampaign.name, utm: schema.acquisitionCampaign.utmCampaign,
      }).from(schema.acquisitionCampaign)
        .where(and(eq(schema.acquisitionCampaign.organizationId, org), isNull(schema.acquisitionCampaign.archivedAt)));
      const known = new Map((await tx.select().from(schema.adPlatformCampaign)
        .where(eq(schema.adPlatformCampaign.connectionId, row.id))).map((c) => [c.externalId, c]));

      const byCampaign = new Map<string, (typeof pulled)[number]>();
      for (const p of pulled) {
        const seen = byCampaign.get(p.campaignId);
        if (!seen || p.day > seen.day) byCampaign.set(p.campaignId, p);
      }
      for (const [campaignId, latest] of byCampaign) {
        const existing = known.get(campaignId);
        if (existing) {
          const [updated] = await tx.update(schema.adPlatformCampaign).set({
            name: latest.campaignName,
            channelType: latest.channelType,
            source: ads.sourceOfPlatformCampaign(provider, latest.channelType),
            lastSpentOn: existing.lastSpentOn && existing.lastSpentOn > latest.day ? existing.lastSpentOn : latest.day,
            updatedAt: new Date(),
          }).where(eq(schema.adPlatformCampaign.id, existing.id)).returning();
          known.set(campaignId, updated!);
        } else {
          const matched = ads.matchCampaign(latest.campaignName, ours);
          const [created] = await tx.insert(schema.adPlatformCampaign).values({
            organizationId: org,
            connectionId: row.id,
            provider,
            accountId: latest.accountId,
            externalId: campaignId,
            name: latest.campaignName,
            channelType: latest.channelType,
            source: ads.sourceOfPlatformCampaign(provider, latest.channelType),
            acquisitionCampaignId: matched,
            mappedBy: matched ? "matched" : null,
            lastSpentOn: latest.day,
          }).returning();
          known.set(campaignId, created!);
        }
      }

      const origin = originOf(provider);
      const seen: string[] = [];
      let written = 0;
      for (const p of pulled) {
        const campaign = known.get(p.campaignId)!;
        const place = await placementOf(tx, org, campaign);
        const externalId = ads.spendKey(p.accountId, p.campaignId, p.day);
        seen.push(externalId);
        await writeSpend(tx, org, { origin, externalId, label: p.campaignName, day: p.day, place, row: p });
        written += 1;
      }

      /** Days asked about where the platform now reports nothing for a campaign it reported before. */
      const accounts = [...new Set(pulled.map((p) => p.accountId))];
      const account = accounts[0] ?? (provider === "bing_ads" ? text(settingsOf(row), "accountId")?.replace(/\D/g, "") : undefined)
        ?? text(settingsOf(row), "customerId")?.replace(/\D/g, "")
        ?? text(settingsOf(row), "adAccountId")?.replace(/\D/g, "");
      if (account) {
        await tx.update(schema.adSpend).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(schema.adSpend.organizationId, org),
          eq(schema.adSpend.origin, origin),
          isNull(schema.adSpend.deletedAt),
          gte(schema.adSpend.spentOn, window.from),
          lte(schema.adSpend.spentOn, window.to),
          like(schema.adSpend.externalId, `${account}:%`),
          ...(seen.length > 0 ? [notInArray(schema.adSpend.externalId, seen)] : []),
        ));
      }

      await audit(tx, ctx, "ad_spend.pulled", "integration_connection", row.id, null, {
        provider, from: window.from, to: window.to, rows: written,
      });
      return { read: pulled.length, written, cursor: window.to };
    });
  });
}

interface Placement { source: string; channelId: string | null; campaignId: string | null }

/** Where a platform campaign's money lands: its tracking campaign when mapped, else the platform's channel. */
async function placementOf(
  tx: Database, organizationId: string, campaign: typeof schema.adPlatformCampaign.$inferSelect,
): Promise<Placement> {
  if (campaign.acquisitionCampaignId) {
    const declared = await acquisition.resolveDeclared(tx, organizationId, { campaignId: campaign.acquisitionCampaignId })
      .catch(() => null);
    if (declared) return { source: declared.sourceKey, channelId: declared.channelId, campaignId: declared.campaignId };
  }
  return {
    source: campaign.source,
    channelId: await acquisition.channelForSource(tx, organizationId, campaign.source),
    campaignId: null,
  };
}

/**
 * One pulled day, written or rewritten.
 *
 * Found by its key first. A new row takes the campaign's name as its label;
 * when another campaign already holds that label on that day (Meta allows two
 * campaigns one name), the campaign id is added to it, because the spend
 * table's own unique index is on the label and a collision there would refuse
 * the whole pull over a naming habit.
 */
async function writeSpend(tx: Database, organizationId: string, input: {
  origin: string; externalId: string; label: string; day: string; place: Placement;
  row: { amount: string; impressions: number | null; clicks: number | null; campaignId: string };
}): Promise<void> {
  const values = {
    amount: input.row.amount,
    impressions: input.row.impressions,
    clicks: input.row.clicks,
    source: input.place.source,
    channelId: input.place.channelId,
    acquisitionCampaignId: input.place.campaignId,
  };
  const [existing] = await tx.select({ id: schema.adSpend.id }).from(schema.adSpend).where(and(
    eq(schema.adSpend.organizationId, organizationId),
    eq(schema.adSpend.origin, input.origin),
    eq(schema.adSpend.externalId, input.externalId),
    isNull(schema.adSpend.deletedAt),
  )).limit(1);
  if (existing) {
    await tx.update(schema.adSpend).set({ ...values, updatedAt: new Date() }).where(eq(schema.adSpend.id, existing.id));
    return;
  }
  const [taken] = await tx.select({ id: schema.adSpend.id }).from(schema.adSpend).where(and(
    eq(schema.adSpend.organizationId, organizationId),
    eq(schema.adSpend.source, input.place.source),
    eq(schema.adSpend.campaign, input.label),
    eq(schema.adSpend.spentOn, input.day),
    eq(schema.adSpend.origin, input.origin),
    isNull(schema.adSpend.deletedAt),
  )).limit(1);
  await tx.insert(schema.adSpend).values({
    organizationId,
    ...values,
    campaign: taken ? `${input.label} (${input.row.campaignId})` : input.label,
    spentOn: input.day,
    origin: input.origin,
    externalId: input.externalId,
  });
}

/* ------------------------------------------------------- campaign mapping */

export interface PlatformCampaignView {
  id: string;
  provider: string;
  providerLabel: string;
  accountId: string;
  externalId: string;
  name: string;
  source: string;
  campaignId: string | null;
  campaignName: string | null;
  mappedBy: string | null;
  lastSpentOn: string | null;
}

export async function listPlatformCampaigns(ctx: ServiceContext): Promise<PlatformCampaignView[]> {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const rows = await tx.select({ campaign: schema.adPlatformCampaign, campaignName: schema.acquisitionCampaign.name })
      .from(schema.adPlatformCampaign)
      .leftJoin(schema.acquisitionCampaign, eq(schema.acquisitionCampaign.id, schema.adPlatformCampaign.acquisitionCampaignId))
      .where(eq(schema.adPlatformCampaign.organizationId, ctx.actor.organizationId))
      .orderBy(desc(schema.adPlatformCampaign.lastSpentOn), asc(schema.adPlatformCampaign.name))
      .limit(500);
    return rows.map(({ campaign, campaignName }) => ({
      id: campaign.id,
      provider: campaign.provider,
      providerLabel: ads.isAdsProvider(campaign.provider) ? ads.PROVIDERS[campaign.provider].label : campaign.provider,
      accountId: campaign.accountId,
      externalId: campaign.externalId,
      name: campaign.name,
      source: campaign.source,
      campaignId: campaign.acquisitionCampaignId,
      campaignName,
      mappedBy: campaign.mappedBy,
      lastSpentOn: campaign.lastSpentOn,
    }));
  });
}

/**
 * Say which tracking campaign a platform campaign is, or that it is none.
 *
 * Every spend row already pulled for it moves with it, because a mapping is a
 * statement about the campaign and not about the day somebody made it: "the
 * Google campaign called Brand IS our Spring push" is as true of last month
 * as of tomorrow.
 */
export async function mapPlatformCampaign(
  ctx: ServiceContext, input: { id: string; campaignId: string | null },
): Promise<{ id: string; campaignId: string | null; moved: number }> {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    const org = ctx.actor.organizationId;
    const [before] = await tx.select().from(schema.adPlatformCampaign)
      .where(and(eq(schema.adPlatformCampaign.organizationId, org), eq(schema.adPlatformCampaign.id, input.id))).limit(1);
    if (!before) throw new NotFoundError("Platform campaign");
    if (input.campaignId) await acquisition.resolveDeclared(tx, org, { campaignId: input.campaignId });

    const [after] = await tx.update(schema.adPlatformCampaign).set({
      acquisitionCampaignId: input.campaignId,
      mappedBy: input.campaignId ? "person" : null,
      updatedAt: new Date(),
    }).where(eq(schema.adPlatformCampaign.id, input.id)).returning();

    const place = await placementOf(tx, org, after!);
    const moved = await tx.update(schema.adSpend).set({
      source: place.source, channelId: place.channelId, acquisitionCampaignId: place.campaignId, updatedAt: new Date(),
    }).where(and(
      eq(schema.adSpend.organizationId, org),
      eq(schema.adSpend.origin, originOf(before.provider)),
      like(schema.adSpend.externalId, `${before.accountId}:${before.externalId}:%`),
      isNull(schema.adSpend.deletedAt),
    )).returning({ id: schema.adSpend.id });

    await audit(tx, ctx, "ad_platform_campaign.mapped", "ad_platform_campaign", input.id,
      { campaignId: before.acquisitionCampaignId }, { campaignId: input.campaignId, rowsMoved: moved.length });
    return { id: input.id, campaignId: input.campaignId, moved: moved.length };
  });
}

/* ------------------------------------------------- leads from a platform */

/**
 * The lead source connector a platform connection's leads arrive under.
 *
 * The lead inbox is offers from lead source connectors, and a Local Services
 * lead or an instant form is one: a person who asked, read from the
 * platform rather than posted by it. Made the first time it is needed,
 * credited to the platform's channel, with no webhook token because nothing
 * posts to it.
 */
const LEAD_CONNECTOR: Partial<Record<ads.AdsProvider, { source: string; displayName: string; through: string; nameless: string }>> = {
  google_lsa: { source: "google_lsa", displayName: "Google Local Services Ads", through: "Google Local Services", nameless: "Local Services lead" },
  meta_lead_ads: { source: "meta_ads", displayName: "Meta instant forms", through: "Meta", nameless: "Instant form lead" },
};

async function platformLeadConnector(tx: Database, row: Connection): Promise<string> {
  const [existing] = await tx.select({ id: schema.leadSourceConnector.id }).from(schema.leadSourceConnector)
    .where(and(
      eq(schema.leadSourceConnector.organizationId, row.organizationId),
      eq(schema.leadSourceConnector.connectionId, row.id),
    )).limit(1);
  if (existing) return existing.id;
  const spec = LEAD_CONNECTOR[row.provider as ads.AdsProvider] ?? { source: "marketplace", displayName: row.provider, through: row.provider, nameless: "Lead" };
  const [created] = await tx.insert(schema.leadSourceConnector).values({
    organizationId: row.organizationId,
    connectionId: row.id,
    source: spec.source,
    kind: row.provider,
    channelId: await acquisition.channelForSource(tx, row.organizationId, spec.source),
    displayName: spec.displayName,
  }).returning({ id: schema.leadSourceConnector.id });
  return created!.id;
}

/**
 * Which of the company's tracking campaigns a lead's ad campaign is.
 *
 * Through the same map the spend pull keeps: the platform's campaign found by
 * its id under any connection to that platform, and when it has never been
 * seen, written there (matched by name when exactly one tracking campaign's
 * name or tag agrees) so it appears on the Ad platforms screen to be mapped
 * by a person. A mapping made there credits every later lead.
 */
async function campaignForLead(
  tx: Database, row: Connection, campaign: { id: string; name: string | null },
): Promise<string | null> {
  const family = row.provider === "meta_lead_ads" || row.provider === "meta_ads" ? ["meta_ads", "meta_lead_ads"] : [row.provider];
  const [known] = await tx.select({ id: schema.adPlatformCampaign.id, campaignId: schema.adPlatformCampaign.acquisitionCampaignId })
    .from(schema.adPlatformCampaign).where(and(
      eq(schema.adPlatformCampaign.organizationId, row.organizationId),
      eq(schema.adPlatformCampaign.externalId, campaign.id),
      inArray(schema.adPlatformCampaign.provider, family),
    ))
    .orderBy(sql`${schema.adPlatformCampaign.acquisitionCampaignId} is null`)
    .limit(1);
  if (known) return known.campaignId;
  const ours = await tx.select({
    id: schema.acquisitionCampaign.id, name: schema.acquisitionCampaign.name, utm: schema.acquisitionCampaign.utmCampaign,
  }).from(schema.acquisitionCampaign)
    .where(and(eq(schema.acquisitionCampaign.organizationId, row.organizationId), isNull(schema.acquisitionCampaign.archivedAt)));
  const matched = campaign.name ? ads.matchCampaign(campaign.name, ours) : null;
  await tx.insert(schema.adPlatformCampaign).values({
    organizationId: row.organizationId,
    connectionId: row.id,
    provider: row.provider,
    accountId: text(settingsOf(row), "pageId") ?? text(settingsOf(row), "customerId") ?? row.provider,
    externalId: campaign.id,
    name: campaign.name ?? `Campaign ${campaign.id}`,
    channelType: null,
    source: ads.sourceOfPlatformCampaign(row.provider as ads.AdsProvider, null),
    acquisitionCampaignId: matched,
    mappedBy: matched ? "matched" : null,
  }).onConflictDoNothing();
  return matched;
}

const LEAD_TYPE: Record<string, string> = { PHONE_CALL: "A call", MESSAGE: "A message", BOOKING: "A booking", FORM: "An instant form" };

/**
 * Leads a platform read or posted, into the lead inbox.
 *
 * Through the same intake a lead webhook uses, so the offer, the touch on the
 * platform's channel (and its tracking campaign, when the lead names an ad
 * campaign that is mapped) and the "same lead twice is the same lead" rule
 * are one implementation. Shared by the pull and Meta's webhook, so a lead
 * found both ways is one lead.
 */
export async function ingestLeads(tx: Database, row: Connection, leads: readonly PulledLead[]): Promise<{ written: number; offers: string[] }> {
  const provider = row.provider as ads.AdsProvider;
  const connectorId = await platformLeadConnector(tx, row);
  const label = LEAD_CONNECTOR[provider]?.through ?? ads.PROVIDERS[provider]?.label ?? provider;
  let written = 0;
  const offers: string[] = [];
  for (const lead of leads) {
    const campaignId = lead.campaign ? await campaignForLead(tx, row, lead.campaign) : null;
    const outcome = await leadIntake.receiveLead(tx, {
      connectorId,
      organizationId: row.organizationId,
      campaignId,
      lead: {
        externalId: lead.externalId,
        contactName: lead.name ?? LEAD_CONNECTOR[provider]?.nameless ?? "Lead",
        contactEmail: lead.email,
        contactPhone: lead.phone,
        addressLine1: lead.address?.line1 ?? null,
        city: lead.address?.city ?? null,
        state: lead.address?.state ?? null,
        postalCode: lead.address?.postalCode ?? null,
        serviceRequested: lead.service,
        notes: `${LEAD_TYPE[lead.type] ?? "A lead"} through ${label}${lead.charged ? ", charged" : ""}`
          + `${lead.campaign?.name ? `, from the campaign ${lead.campaign.name}` : ""}.`,
        estimatedValue: null,
        expiresAt: null,
        source: LEAD_CONNECTOR[provider]?.source ?? "marketplace",
        raw: lead.raw,
      },
    });
    if (outcome.offerId) offers.push(outcome.offerId);
    if (!outcome.duplicate) written += 1;
  }
  return { written, offers };
}

/**
 * Read a platform's leads into the lead inbox: Local Services' calls,
 * messages and bookings, and Meta's instant forms. Each pull overlaps the
 * last by an hour, because a lead the platform writes a moment late must not
 * fall between two pulls; the overlap is free, since a lead read twice is
 * found by its id.
 */
export async function pullLeads(db: Database, row: Connection, deps: AdsDeps = {}): Promise<PullOutcome> {
  const ctx = systemCtx(db, row.organizationId);
  const now = nowOf(deps);
  const since = await inTenant(ctx, async (tx) => {
    const last = await lastRun(tx, row.id, "leads", true);
    const from = last?.cursor ? new Date(last.cursor) : null;
    return from && !Number.isNaN(from.getTime())
      ? new Date(from.getTime() - 3_600_000)
      : new Date(now.getTime() - 7 * 86_400_000);
  });

  return runPull(db, row, "leads", async () => {
    const adapter = await adapterFor(db, row, deps);
    if (!adapter.pullLeads) return { read: 0, written: 0 };
    const leads = await adapter.pullLeads(since);
    return inTenant(ctx, async (tx) => {
      const { written } = await ingestLeads(tx, row, leads);
      const latest = leads.reduce((max, lead) => (lead.createdAt > max ? lead.createdAt : max), since);
      return { read: leads.length, written, cursor: (latest > now ? now : latest).toISOString() };
    });
  });
}

/* --------------------------------------------------------------- read back */

/**
 * Search queries or sessions per day, into their own tables.
 *
 * The same windowing as spend (thirty days the first time, then from a few
 * days before the last pull), because Search Console publishes late and both
 * revise. Every day asked about is rewritten: a row the platform no longer
 * reports for a day it was asked about is taken out, so the figures are what
 * Google says now and never a sum of two readings.
 */
export async function pullAnalytics(db: Database, row: Connection, deps: AdsDeps = {}): Promise<PullOutcome> {
  const org = row.organizationId;
  const ctx = systemCtx(db, org);
  const now = nowOf(deps);
  const window = await inTenant(ctx, async (tx) => {
    const zone = await timezoneOf(tx, org);
    const last = await lastRun(tx, row.id, "analytics", true);
    return ads.spendWindow({
      today: time.dateIn(now, zone), lastThrough: last?.cursor ?? null, revisitDays: ads.ANALYTICS_REVISIT_DAYS,
    });
  });

  return runPull(db, row, "analytics", async () => {
    const adapter = await adapterFor(db, row, deps);
    if (!adapter.pullAnalytics) return { read: 0, written: 0 };
    const pulled = await adapter.pullAnalytics(window);
    return inTenant(ctx, async (tx) => {
      let written = 0;
      if (row.provider === "search_console") {
        await tx.delete(schema.searchQueryDay).where(and(
          eq(schema.searchQueryDay.connectionId, row.id),
          gte(schema.searchQueryDay.day, window.from), lte(schema.searchQueryDay.day, window.to),
        ));
        /** One row per day and query; a query Google repeats in a day (it should not) is added together. */
        const merged = new Map<string, { day: string; query: string; clicks: number; impressions: number; position: string | null }>();
        for (const p of pulled) {
          if (p.kind !== "search") continue;
          const key = `${p.day}\u0000${p.query}`;
          const seen = merged.get(key);
          if (seen) { seen.clicks += p.clicks; seen.impressions += p.impressions; } else merged.set(key, { ...p });
        }
        const rows = [...merged.values()];
        for (let i = 0; i < rows.length; i += 500) {
          await tx.insert(schema.searchQueryDay).values(rows.slice(i, i + 500).map((r) => ({
            organizationId: org, connectionId: row.id, day: r.day, query: r.query,
            clicks: r.clicks, impressions: r.impressions, position: r.position,
          })));
        }
        written = rows.length;
      } else {
        await tx.delete(schema.analyticsSessionDay).where(and(
          eq(schema.analyticsSessionDay.connectionId, row.id),
          gte(schema.analyticsSessionDay.day, window.from), lte(schema.analyticsSessionDay.day, window.to),
        ));
        const merged = new Map<string, { day: string; source: string; medium: string; sessions: number; engaged: number }>();
        for (const p of pulled) {
          if (p.kind !== "sessions") continue;
          const key = `${p.day}\u0000${p.source}\u0000${p.medium}`;
          const seen = merged.get(key);
          if (seen) { seen.sessions += p.sessions; seen.engaged += p.engagedSessions; }
          else merged.set(key, { day: p.day, source: p.source, medium: p.medium, sessions: p.sessions, engaged: p.engagedSessions });
        }
        const rows = [...merged.values()];
        for (let i = 0; i < rows.length; i += 500) {
          await tx.insert(schema.analyticsSessionDay).values(rows.slice(i, i + 500).map((r) => ({
            organizationId: org, connectionId: row.id, day: r.day, sessionSource: r.source, sessionMedium: r.medium,
            source: ads.sessionSource(r.source, r.medium), sessions: r.sessions, engagedSessions: r.engaged,
          })));
        }
        written = rows.length;
      }
      await audit(tx, ctx, "analytics.pulled", "integration_connection", row.id, null, {
        provider: row.provider, from: window.from, to: window.to, rows: written,
      });
      return { read: pulled.length, written, cursor: window.to };
    });
  });
}

/* ---------------------------------------------------------------- status */

export interface PlatformView {
  provider: string;
  label: string;
  status: string;
  accountLabel: string | null;
  lastError: string | null;
  signedIn: { grantedAt: string; expiresAt: string | null; scopes: string[] } | null;
  ownCredential: boolean;
  runs: { entity: string; startedAt: string; finishedAt: string | null; read: number; written: number; error: string | null }[];
  campaigns: number;
  unmapped: number;
  sends: Record<string, number>;
  /** Something a person has to do that nothing else on the row says. */
  notices: string[];
}

/** Every ad platform connection this company has, with its last pulls and what it is owed. */
export async function platforms(ctx: ServiceContext): Promise<PlatformView[]> {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const org = ctx.actor.organizationId;
    /** For the day a sign in runs out, said as the owner counts days. */
    const zone = await timezoneOf(tx, org);
    const rows = await tx.select().from(schema.integrationConnection).where(and(
      eq(schema.integrationConnection.organizationId, org),
      inArray(schema.integrationConnection.provider, ads.ADS_PROVIDERS),
      isNull(schema.integrationConnection.deletedAt),
    ));
    const out: PlatformView[] = [];
    for (const row of rows.filter((r) => r.status !== "disconnected")) {
      const provider = row.provider as ads.AdsProvider;
      const spec = ads.PROVIDERS[provider];
      const settings = settingsOf(row);
      const [grant] = await tx.select().from(schema.sealedCredential)
        .where(eq(schema.sealedCredential.connectionId, row.id)).limit(1);
      const runs = [];
      for (const entity of ["spend", "leads", "reviews", "conversions", "adjustments", "analytics"] as const) {
        const run = await lastRun(tx, row.id, entity);
        if (run) {
          runs.push({
            entity, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null,
            read: run.recordsRead, written: run.recordsWritten, error: run.error,
          });
        }
      }
      const campaigns = await tx.select({ mapped: schema.adPlatformCampaign.acquisitionCampaignId })
        .from(schema.adPlatformCampaign).where(eq(schema.adPlatformCampaign.connectionId, row.id));
      const sends = await tx.select({ state: schema.adConversionSend.state, n: sql<number>`count(*)::int` })
        .from(schema.adConversionSend)
        .where(and(eq(schema.adConversionSend.organizationId, org), eq(schema.adConversionSend.provider, provider)))
        .groupBy(schema.adConversionSend.state);

      const notices: string[] = [];
      if (row.status === "pending" && spec.oauth) {
        notices.push(`Nobody has signed in yet. Press Sign in with ${ads.OAUTH_LABEL[spec.oauth]} on Settings, Integrations.`);
      }
      if (row.status === "needs_reauth") notices.push("The platform stopped accepting the sign in. Sign in again on Settings, Integrations.");
      if (provider === "google_ads" && settings["sendConversions"] !== false && !text(settings, "conversionActionId")) {
        notices.push("No conversion action is chosen, so paid jobs are not being sent to Google Ads.");
      }
      if (provider === "meta_ads" && settings["sendConversions"] !== false && !text(settings, "pixelId")) {
        notices.push("No pixel id is entered, so booked and paid jobs are not being sent to Meta.");
      }
      if (provider === "bing_ads" && settings["sendConversions"] !== false && !text(settings, "conversionName")) {
        notices.push("No offline conversion goal is named, so paid jobs are not being sent to Microsoft Advertising.");
      }
      if (provider === "meta_lead_ads" && !text(settings, "pageId")) {
        notices.push("No Page id is entered, so no instant form leads are read.");
      }
      if (provider === "facebook_page" && !text(settings, "pageId")) {
        notices.push("No Page id is entered, so no Facebook reviews are read.");
      }
      const expires = grant?.expiresAt ?? null;
      if (expires && expires.getTime() - Date.now() < 14 * 86_400_000) {
        notices.push(`Meta's sign in runs out on ${time.dateIn(expires, zone)}. Sign in again before then.`);
      }

      out.push({
        provider,
        label: spec.label,
        status: row.status,
        accountLabel: row.accountLabel,
        lastError: row.lastError,
        signedIn: grant
          ? { grantedAt: grant.grantedAt.toISOString(), expiresAt: grant.expiresAt?.toISOString() ?? null, scopes: grant.scopes }
          : null,
        ownCredential: row.credentialRef !== null,
        runs,
        campaigns: campaigns.length,
        unmapped: campaigns.filter((c) => !c.mapped).length,
        sends: Object.fromEntries(sends.map((s) => [s.state, s.n])),
        notices,
      });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  });
}

/** A connection by provider, connected, or a refusal saying why it cannot be used. */
export async function connectedRow(db: Database, organizationId: string, provider: string): Promise<Connection> {
  return inTenant(systemCtx(db, organizationId), async (tx) => {
    const [row] = await tx.select().from(schema.integrationConnection).where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.provider, provider),
      isNull(schema.integrationConnection.deletedAt),
    )).limit(1);
    if (!row || row.status === "disconnected") throw new ConflictError("That platform is not connected.");
    if (row.status !== "connected") {
      throw new ConflictError(row.status === "pending"
        ? "Nobody has signed in for that platform yet."
        : "That platform needs somebody to sign in again first.");
    }
    return row;
  });
}

export async function connectedRows(db: Database, organizationId: string): Promise<Connection[]> {
  return inTenant(systemCtx(db, organizationId), (tx) => tx.select().from(schema.integrationConnection).where(and(
    eq(schema.integrationConnection.organizationId, organizationId),
    inArray(schema.integrationConnection.provider, ads.ADS_PROVIDERS),
    eq(schema.integrationConnection.status, "connected"),
    isNull(schema.integrationConnection.deletedAt),
  )));
}

/** Whether a pull of this kind is due for this connection, by the cadence core sets. */
export async function isDue(db: Database, row: Connection, entity: Entity, now: Date): Promise<boolean> {
  const run = await inTenant(systemCtx(db, row.organizationId), (tx) => lastRun(tx, row.id, entity));
  const cadence = entity === "spend" ? ads.CADENCE_MINUTES.spend
    : entity === "leads" ? ads.CADENCE_MINUTES.leads
      : entity === "reviews" ? ads.CADENCE_MINUTES.reviews
        : entity === "analytics" ? ads.CADENCE_MINUTES.analytics : ads.CADENCE_MINUTES.conversions;
  return ads.isDue(run?.startedAt ?? null, now, cadence);
}
