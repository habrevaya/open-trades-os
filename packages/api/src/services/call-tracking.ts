import { randomBytes } from "node:crypto";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, audit, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import * as marketingService from "./marketing";
import { emit } from "./events";
import {
  createCallTrackingProvider,
  type CallTrackingProvider, type TrackedCall, type WebhookRequest,
} from "../call-tracking/provider";

/**
 * CALLS, ATTRIBUTED TO WHAT PAID FOR THEM
 *
 * Call tracking is the only measurement most of a trades company's marketing
 * ever gets. A yard sign, a van, a mailer, a door hanger and a radio spot
 * carry no query string and set no referrer: the NUMBER is the tag, and a
 * number with a source against it is the only way any of that spend appears
 * in a report at all. `marketing_touch` was built for exactly this and
 * `telephony.logCall` has recorded one since it was written, from a user's
 * session. Nothing fed it from outside.
 *
 * This is the outside. A tracking provider posts a call, it becomes a `call`
 * row and a `marketing_touch`, and a backfill exists for the calls a failed
 * delivery lost.
 *
 * WHY THIS DOES NOT CALL `telephony.logCall`, which does nearly this.
 *
 * `logCall` is a `guardedWrite` on `message:send`, which means an actor who
 * holds it. A webhook has no actor. The only way to reach it from here would
 * be to build a synthetic actor and grant it the permission its own guard
 * checks, which is not a shortcut: it is the moment a guard stops meaning
 * anything, because every later caller in a hurry does the same. So this
 * writes inside `inTenant` with the system actor, which is the pattern the
 * inbound messaging webhook already uses for the same reason.
 *
 * It also needs to record a RICHER touch than `logCall` can. `logCall`
 * passes the tracked number alone, so every call resolves through the
 * number map or not at all. A tracked call carries the caller's utm
 * parameters, their click id, their referrer and their landing page, and
 * passing those through the same parser a website visit goes through is the
 * difference between "a call on the Google number" and "a call from this
 * campaign with this click id".
 *
 * WHAT IS DELIBERATELY NOT STORED, AND BOTH ARE REFUSALS RATHER THAN GAPS.
 *
 *   THE RECORDING. CallRail sends a link to one on every post-call webhook.
 *   `telephony.attachRecording` refuses a recording for a call that was
 *   never granted permission, and a webhook carries no evidence that anybody
 *   decided anything about recording this call under this company's own
 *   declared policy. Writing the URL from here would walk straight past the
 *   gate that file exists to be, so it is not written, and it is taken out
 *   of the kept payload as well: their player link carries its own access
 *   key, which makes it the audio rather than a reference to it.
 *
 *   THE TRANSCRIPT. Same shape, worse consequence. `telephony` redacts card
 *   numbers and security codes out of a transcript in the same statement
 *   that stores it, so there is no window in which the raw text is in the
 *   table. A transcript written in from here would be the raw text, in the
 *   table, in the backups, with somebody's card number in it. Keeping it
 *   inside the raw payload instead would be the same text in the same
 *   database under a different column name, so `storable` takes it out
 *   before anything is written.
 */

/* ------------------------------------------------------------ connecting */

/** The provider key in the catalogue, and on `integration_connection.provider`. */
export const PROVIDER = "callrail";

/**
 * Where the key and the signing secret live.
 *
 * In the deployment's secret store under names this returns, never in a
 * database row, which is the posture every other credential here takes. The
 * operator puts the values under these names and the webhook meets them
 * without either ever being a column.
 */
export const keyRefFor = (connectionId: string) =>
  `OTOS_CALL_TRACKING_KEY_${connectionId.replace(/-/g, "_").toUpperCase()}`;
export const secretRefFor = (connectionId: string) =>
  `OTOS_CALL_TRACKING_SECRET_${connectionId.replace(/-/g, "_").toUpperCase()}`;

/**
 * The token in the webhook URL.
 *
 * It identifies the connection and therefore the tenant, which the signature
 * cannot: CallRail's signing key is per company at their end, so a valid
 * signature proves a body came from a CallRail account and not which of this
 * deployment's tenants it belongs to. Same length and same generator as the
 * lead webhook's, and the resolver below refuses anything shorter than 32
 * characters so a hand-edited short token is an endpoint that receives
 * nothing rather than an endpoint anybody can post to.
 */
const newToken = () => randomBytes(32).toString("base64url");
const MIN_TOKEN_LENGTH = 32;

export const webhookPath = (token: string) => `/api/webhooks/call-tracking/${token}`;

export interface ConnectInput {
  /** `ACC8154...`, the identifier in the URL of their dashboard. */
  accountId: string;
  /** Narrows everything to one company in a multi-company account. */
  companyId?: string | undefined;
  accountLabel?: string | undefined;
}

interface ConnectionSettings {
  accountId?: string;
  companyId?: string;
  webhookToken?: string;
  /** Where the signing key for the webhook is expected in the secret store. */
  webhookSecretRef?: string;
  baseUrl?: string;
}

function shapeConnection(row: typeof schema.integrationConnection.$inferSelect) {
  const settings = (row.settings ?? {}) as ConnectionSettings;
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    accountLabel: row.accountLabel,
    accountId: settings.accountId ?? null,
    companyId: settings.companyId ?? null,
    /** The half of the URL this product knows. The host is the deployment's own. */
    webhookPath: settings.webhookToken ? webhookPath(settings.webhookToken) : null,
    /** Where the two secrets are expected to be found. Never the secrets. */
    apiKeyRef: row.credentialRef,
    signingSecretRef: settings.webhookSecretRef ?? null,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
  };
}

/**
 * Turn it on, and hand over the webhook URL and the two secret names.
 *
 * Both secrets are REFERENCES rather than values, for the reason every other
 * connector here gives: a credential a support engineer can read out of a
 * table is a credential the company does not really control. The operator
 * puts the API key and the signing key into their own secret store under the
 * names returned, and nothing in this product ever holds either.
 */
export async function connect(ctx: ServiceContext, input: ConnectInput) {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const accountId = input.accountId.trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(accountId)) {
      throw new ConflictError(
        "That does not look like a CallRail account id. It is the identifier in the URL of "
        + "your CallRail dashboard, and without the right one every backfill reads an empty list.",
      );
    }

    const [row] = await tx.insert(schema.integrationConnection).values({
      organizationId: ctx.actor.organizationId,
      capability: "telephony",
      provider: PROVIDER,
      status: "connected",
      accountLabel: input.accountLabel?.trim() || "CallRail",
      settings: {
        accountId,
        ...(input.companyId ? { companyId: input.companyId.trim() } : {}),
        webhookToken: newToken(),
      } satisfies ConnectionSettings,
    }).onConflictDoUpdate({
      target: [
        schema.integrationConnection.organizationId,
        schema.integrationConnection.capability,
        schema.integrationConnection.provider,
      ],
      set: {
        status: "connected",
        accountLabel: input.accountLabel?.trim() || "CallRail",
        lastError: null,
        updatedAt: new Date(),
      },
    }).returning();

    /**
     * The credential names are derived from the connection's own id, which
     * does not exist until the row does. A second statement rather than a
     * cleverer one: computing them from anything available beforehand would
     * mean two connections in one organization sharing a secret name.
     *
     * The token is only written on the INSERT path above, so reconnecting an
     * existing connection keeps the URL already configured at CallRail.
     * Replacing it silently would leave a webhook posting at a dead URL, and
     * the first evidence would be missing calls nobody can get back.
     */
    const settings = (row!.settings ?? {}) as ConnectionSettings;
    const [linked] = await tx.update(schema.integrationConnection).set({
      credentialRef: row!.credentialRef ?? keyRefFor(row!.id),
      settings: {
        ...settings,
        accountId,
        ...(input.companyId ? { companyId: input.companyId.trim() } : {}),
        webhookToken: settings.webhookToken ?? newToken(),
        webhookSecretRef: settings.webhookSecretRef ?? secretRefFor(row!.id),
      } satisfies ConnectionSettings,
      updatedAt: new Date(),
    }).where(eq(schema.integrationConnection.id, row!.id)).returning();

    await audit(tx, ctx, "call_tracking.connected", "integration_connection", row!.id, null, {
      provider: PROVIDER, accountId,
    });

    return shapeConnection(linked!);
  });
}

export async function connection(ctx: ServiceContext) {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const row = await loadConnection(tx, ctx.actor.organizationId);
    return shapeConnection(row);
  });
}

async function loadConnection(tx: Database, organizationId: string) {
  const [row] = await tx.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.capability, "telephony"),
      eq(schema.integrationConnection.provider, PROVIDER),
      isNull(schema.integrationConnection.deletedAt),
    )).limit(1);
  if (!row) throw new NotFoundError("CallRail connection");
  return row;
}

/* ------------------------------------------------------------- the seams */

export type ReadSecret = (ref: string) => Promise<string>;

const secretFromEnvironment: ReadSecret = async (ref) => {
  const value = process.env[ref];
  if (!value) {
    throw new ConflictError(
      `No call tracking credential in the environment under "${ref}". The connection points `
      + "at that name and nothing is set there, so nothing can be read from the provider.",
    );
  }
  return value;
};

export interface CallTrackingDeps {
  readSecret: ReadSecret;
  /** Injected so a test never reaches CallRail and a deployment never fakes one. */
  provider?: CallTrackingProvider | undefined;
}

const DEFAULT_DEPS: CallTrackingDeps = { readSecret: secretFromEnvironment };

async function providerFor(
  row: typeof schema.integrationConnection.$inferSelect,
  deps: CallTrackingDeps,
): Promise<CallTrackingProvider> {
  if (deps.provider) return deps.provider;
  const key = await deps.readSecret(row.credentialRef ?? keyRefFor(row.id));
  return createCallTrackingProvider(row.provider, (row.settings ?? {}) as Record<string, unknown>, key);
}

/**
 * Does the key work, and whose account is it.
 *
 * Guarded by `integration:write` rather than by the read permission, because
 * it SPENDS something: CallRail allows a thousand requests an hour against
 * the operator's own account, and a check anybody holding read could trigger
 * is a check somebody's dashboard can refresh in a loop.
 */
export async function check(ctx: ServiceContext, deps: CallTrackingDeps = DEFAULT_DEPS) {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const row = await loadConnection(tx, ctx.actor.organizationId);
    const outcome = await (await providerFor(row, deps)).checkCredential();

    await tx.update(schema.integrationConnection).set({
      status: outcome.ok ? "connected" : "error",
      lastCheckedAt: new Date(),
      /**
       * Cleared on success, in the same statement. A stale error beside a
       * working connection is read as a working connection with a problem,
       * and somebody spends an afternoon on it.
       */
      lastError: outcome.ok ? null : `${outcome.code}: ${outcome.message}`,
      updatedAt: new Date(),
    }).where(eq(schema.integrationConnection.id, row.id));

    return outcome.ok
      ? { ok: true as const, accountId: outcome.accountId, accountName: outcome.accountName }
      : { ok: false as const, code: outcome.code, message: outcome.message, retryable: outcome.retryable };
  });
}

/* ---------------------------------------------------------- the webhook */

export interface WebhookConnection {
  connectionId: string;
  organizationId: string;
  provider: CallTrackingProvider;
  /** The signing key, read from the secret store for THIS connection. */
  secret: string;
}

/**
 * Which tenant a delivery belongs to.
 *
 * From the secret in the URL, and from nothing else. Not from a header, not
 * from a field in the body naming a company, and not from the tracking
 * number: the first two are things an attacker chooses, and a company's
 * tracking number is printed on their van.
 *
 * Resolved before any tenant context exists, because the token is what
 * establishes one. Nothing about the request is trusted until the signature
 * has been checked against the secret this returns.
 */
export async function resolveWebhook(
  db: Database,
  token: string,
  deps: CallTrackingDeps = DEFAULT_DEPS,
): Promise<WebhookConnection | null> {
  /**
   * A token short enough to guess is not a token. Refusing here rather than
   * trusting whatever is in the settings means a deployment that hand-edits
   * a weak one receives nothing instead of serving an open endpoint.
   */
  if (token.length < MIN_TOKEN_LENGTH) return null;

  const [row] = await db.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.capability, "telephony"),
      eq(schema.integrationConnection.status, "connected"),
      isNull(schema.integrationConnection.deletedAt),
      sql`${schema.integrationConnection.settings} ->> 'webhookToken' = ${token}`,
    )).limit(1);

  if (!row) return null;

  const settings = (row.settings ?? {}) as ConnectionSettings;
  return {
    connectionId: row.id,
    organizationId: row.organizationId,
    provider: await providerFor(row, deps),
    secret: await deps.readSecret(settings.webhookSecretRef ?? secretRefFor(row.id)),
  };
}

export type ReceiveOutcome =
  | { kind: "rejected"; reason: "bad_signature" | "unparseable" }
  | { kind: "recorded"; callId: string; touchId: string | null; duplicate: boolean };

/**
 * One delivery.
 *
 * The signature is checked BEFORE the body is parsed into anything this
 * product acts on, which is the order every webhook here uses: parsing
 * attacker-controlled input is a smaller risk than acting on it and there is
 * no reason to take either.
 *
 * A body that verifies and is not a call answers `unparseable`, which the
 * route turns into a 200. CallRail posts text messages and form submissions
 * at the same endpoint and treats a non-2xx as a failure, and their
 * documentation says plainly that repeated failures can disable the
 * integration altogether. Answering an error to a shape we simply do not
 * want is how a company loses its call tracking.
 */
export async function receive(
  db: Database,
  connection: WebhookConnection,
  request: WebhookRequest,
  now: Date = new Date(),
): Promise<ReceiveOutcome> {
  const proof = connection.provider.proof;

  if (proof.kind === "signature") {
    if (!proof.verify(request, connection.secret, () => now.getTime())) {
      return { kind: "rejected", reason: "bad_signature" };
    }
  }
  /**
   * There is no `else` that accepts quietly. A provider declaring
   * `unguessable_url` has said in its own shape that it offers nothing to
   * check, the catalogue says so in its limitation, and the endpoint's
   * safety is then the token in the path and the route says that too. What
   * there is not, anywhere, is a `verify` that returns true and lets a
   * reader believe something was proved.
   */

  const call = connection.provider.parseCall(request);
  if (!call) return { kind: "rejected", reason: "unparseable" };

  return record(db, connection.organizationId, call, now);
}

/* ------------------------------------------------------------- the write */

function webhookActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: [],
    agentId: "call-tracking",
  };
}

/**
 * Store one tracked call, once.
 *
 * TWO IDEMPOTENCY GUARDS, and they close different holes.
 *
 * The first is the unique index on the provider's own id, which is what
 * catches the ordinary case: CallRail sends several webhooks about one call,
 * a pre-call when it rings and a post-call when the recording has attached
 * and a modified one every time somebody tags it afterwards, and the row is
 * upserted rather than inserted.
 *
 * The second is the natural key, the tracking number plus the caller's
 * number plus the second it started, and it exists because of something this
 * code cannot see from here. CallRail's v3 endpoints return a masked id and
 * the worked example of a webhook body in their own documentation carries a
 * bare numeric one. If a deployment is sent one identity by webhook and the
 * other by backfill, the index alone would let the same call in twice, the
 * duration on each would be right, and every count of calls in the business
 * would quietly be too high. Checking the natural key first costs one
 * indexed read and closes it.
 */
/**
 * Where a call came from, when it is not the call tracking provider.
 *
 * The company's own tracking numbers record their calls through this same
 * function, so a call on a native number and a call reported by CallRail
 * become the same rows by the same path, and the funnel cannot tell them
 * apart. `system` names the carrier on the row; `attribution` is set for a
 * call on a website pool number, where the visit that showed the number is
 * the attribution rather than the number itself.
 */
export interface RecordSource {
  system: string;
  attribution?: {
    query: string | null;
    referrer: string | null;
    landingPath: string | null;
    visitorId: string | null;
  } | undefined;
}

export async function record(
  db: Database,
  organizationId: string,
  call: TrackedCall,
  now: Date = new Date(),
  source: RecordSource = { system: PROVIDER },
): Promise<ReceiveOutcome> {
  const ctx: ServiceContext = { actor: webhookActor(organizationId), db };

  return inTenant(ctx, async (tx): Promise<ReceiveOutcome> => {
    const providerCallId = `${source.system}:${call.externalId}`;

    /**
     * The tracking number as this company holds it, its channel and campaign
     * now, who rang if we know them, and whether they have rung before. One
     * function shared with `telephony.logCall`, so the two writers of inbound
     * calls cannot disagree about any of it.
     *
     * A CallRail number the office never recorded here is not an error: the
     * call is still a call, and the touch below resolves to `unknown` rather
     * than to a channel, which is the honest answer and is the one that puts
     * the number on the worklist.
     *
     * The caller is MATCHED rather than created: a tracked call is an
     * enquiry, and creating a customer from one would fill the CRM with every
     * wrong number and every supplier who rang the tracking line. The call
     * log offers "create a customer and a job from this call" for the ones
     * that are real, and the stitching in `marketing.identifyCaller` gives
     * that customer this call when they are.
     */
    const known = call.direction === "inbound"
      ? await marketingService.inboundCallFacts(tx, organizationId, {
        fromE164: call.customerNumber,
        receivedOnE164: call.trackingNumber,
        at: call.startedAt,
        providerSaysFirst: call.firstCall,
      })
      : null;
    const customer = known?.customerId ? { id: known.customerId } : undefined;

    /** The natural key window: the same second, allowing for a rounding difference. */
    const from = new Date(call.startedAt.getTime() - 1000);
    const until = new Date(call.startedAt.getTime() + 1000);

    const [existing] = await tx.select({ id: schema.call.id })
      .from(schema.call)
      .where(and(
        eq(schema.call.organizationId, organizationId),
        eq(schema.call.fromE164, call.direction === "inbound" ? call.customerNumber : call.trackingNumber),
        eq(schema.call.toE164, call.direction === "inbound" ? call.trackingNumber : call.customerNumber),
        gte(schema.call.startedAt, from),
        lte(schema.call.startedAt, until),
      )).limit(1);

    const facts = {
      /**
       * Rewritten on every repeat, not only on the first sight of the call.
       * A post-call delivery carries the duration and the outcome that a
       * pre-call one could not, and a modified one carries whatever somebody
       * changed afterwards. Keeping only the first version would leave every
       * call in the system at zero seconds and ringing.
       */
      startedAt: call.startedAt,
      status: statusOf(call),
      answeredAt: call.answered ? call.startedAt : null,
      endedAt: call.durationSeconds !== null
        ? new Date(call.startedAt.getTime() + call.durationSeconds * 1000)
        : null,
      durationSeconds: call.durationSeconds,
      ...(known?.phoneNumberId ? { phoneNumberId: known.phoneNumberId } : {}),
      /**
       * Only ever SET from here, never cleared. A repeat delivery about a call
       * the office has since turned into a customer and a job must not undo
       * that link because the caller's number is not the one on the account.
       */
      ...(customer ? { customerId: customer.id } : {}),
      /**
       * Their own word for the source, verbatim and unmapped. Not folded
       * into this product's closed catalogue by anything on the way in: an
       * adapter guessing which of our keys "Google Organic" means is how a
       * whole channel lands under the wrong one. The touch below resolves
       * the source properly, through the same parser a website visit uses.
       */
      attributionSource: call.utm.source ?? null,
      updatedAt: now,
    };

    if (existing) {
      await tx.update(schema.call).set(facts).where(eq(schema.call.id, existing.id));
      if (missedOn(call)) await emitMissed(tx, ctx, existing.id);
      return { kind: "recorded", callId: existing.id, touchId: null, duplicate: true };
    }

    const inserted = await tx.insert(schema.call).values({
      organizationId,
      direction: call.direction,
      fromE164: call.direction === "inbound" ? call.customerNumber : call.trackingNumber,
      toE164: call.direction === "inbound" ? call.trackingNumber : call.customerNumber,
      receivedOnE164: call.trackingNumber,
      providerCallId,
      /**
       * What they sent, minus the recording and the transcript. See
       * `storable`: keeping the whole body is what makes a field mapping
       * mistake recoverable a month later, and keeping those two parts of
       * it would be a way around the refusals at the top of this file.
       */
      sourceSystem: source.system,
      sourceId: call.externalId,
      sourcePayload: storable(call.raw),
      /**
       * Decided on the first sight of the call and not on a repeat, when an
       * earlier delivery of this same call would make it look like a second.
       */
      firstTimeCaller: known?.firstTimeCaller ?? null,
      /** The number's channel and campaign at the time, kept with the call. */
      channelId: known?.channelId ?? null,
      acquisitionCampaignId: known?.campaignId ?? null,
      ...facts,
    }).onConflictDoNothing({
      target: [schema.call.organizationId, schema.call.providerCallId],
      /**
       * The index is PARTIAL, and Postgres will not infer a partial index
       * from the column list alone: without the predicate repeated here the
       * statement fails with "no unique or exclusion constraint matching the
       * ON CONFLICT specification". Drizzle spells this `where` on a
       * do-nothing and `targetWhere` on a do-update, which is a trap worth
       * a line of comment rather than an afternoon.
       */
      where: sql`${schema.call.providerCallId} is not null`,
    }).returning({ id: schema.call.id });

    /**
     * NOTHING COMING BACK IS THE ANSWER, not an error.
     *
     * `onConflictDoNothing` returns no row when the index refused the
     * insert, which is exactly "this call is already here": another worker
     * won the race, or the provider has sent a second webhook about the same
     * call. An `onConflictDoUpdate` would have returned a row either way and
     * left "did anything new happen" unanswerable, and the consequence of
     * guessing is a second marketing touch for one phone call, which is a
     * second lead on the report somebody moves a budget with.
     */
    const fresh = inserted[0];
    if (!fresh) {
      const [existingById] = await tx.select({ id: schema.call.id })
        .from(schema.call)
        .where(and(
          eq(schema.call.organizationId, organizationId),
          eq(schema.call.providerCallId, providerCallId),
        )).limit(1);

      if (existingById) {
        await tx.update(schema.call).set(facts).where(eq(schema.call.id, existingById.id));
        if (missedOn(call)) await emitMissed(tx, ctx, existingById.id);
        return { kind: "recorded", callId: existingById.id, touchId: null, duplicate: true };
      }
      /**
       * Refused by the index and not findable by the id it was refused for.
       * Only reachable if the row was deleted between the two statements, so
       * saying so beats returning a call id that names nothing.
       */
      throw new ConflictError(
        `A call under ${providerCallId} was refused as a duplicate and is no longer there. Nothing was recorded.`,
      );
    }

    let touchId: string | null = null;
    if (call.direction === "inbound") {
      /**
       * INBOUND ONLY. An outbound call is the company ringing the customer,
       * and counting it as a marketing touch credits the channel on
       * whichever number the office happened to dial out from.
       */
      const visit = source.attribution;
      const visitorId = visit
        ? visit.visitorId
        : call.personId ? `${source.system}:${call.personId}` : null;
      const touch = await marketingService.recordTouch(tx, organizationId, visit ? {
        /**
         * A call on a website pool number: the visit that was shown the
         * number is what the call is credited to, through the same parser
         * its landing page went through, and the visitor id is the visit's,
         * so the pages they read before ringing join this call's history.
         * No session for the call (the pool ran dry, or the number was
         * written down days ago) leaves the visit empty, which reads as
         * direct: somebody rang a number from the website and nothing says
         * how they reached it.
         */
        at: call.startedAt,
        customerId: customer?.id ?? null,
        callId: fresh.id,
        callerE164: known?.callerE164 ?? null,
        query: visit.query,
        referrer: visit.referrer,
        landingPath: visit.landingPath,
        visitorId,
      } : {
        at: call.startedAt,
        customerId: customer?.id ?? null,
        callId: fresh.id,
        callerE164: known?.callerE164 ?? null,
        trackedNumber: call.trackingNumber,
        /**
         * Their attribution, rendered as the query string a website visit
         * would have arrived with, so it goes through the SAME ladder of
         * evidence: a utm pair that resolves beats a click id, which beats
         * the tracked number, which beats the referrer. Writing a second
         * resolution here would be a second opinion about what a source is,
         * and the two would disagree within a quarter.
         */
        query: queryFrom(call),
        referrer: call.referrer,
        landingPath: call.landingPath,
        /**
         * Their id for the person across calls, forms and texts, kept as the
         * anonymous thread. It is what lets the calls somebody made before
         * they were a customer be stitched onto them the moment they become
         * one, which is the whole reason `identify` exists.
         */
        visitorId,
      });
      touchId = touch.id;

      /**
       * And stitch backwards. Somebody who rang three times before booking
       * has three touches against the person id and no customer; the moment
       * one of those calls matches a customer record, all of them belong to
       * that customer. Without this the first two belong to nobody and the
       * third belongs to the customer, which is last touch attribution by
       * accident rather than by choice.
       */
      if (customer?.id && visitorId) {
        await marketingService.identify(tx, organizationId, { visitorId, customerId: customer.id });
      }
    }

    if (missedOn(call)) await emitMissed(tx, ctx, fresh.id);
    return { kind: "recorded", callId: fresh.id, touchId, duplicate: false };
  });
}

/**
 * Whether a tracked call is a missed one: inbound, finished (it has a
 * duration, which a pre-call webhook does not), and nobody answered.
 * A voicemail is a missed call too: nobody picked up, somebody has to ring
 * them back, and the voicemail is only what they said while waiting.
 */
const missedOn = (call: TrackedCall): boolean =>
  call.direction === "inbound" && call.durationSeconds !== null && !call.answered;

/**
 * Tell the workflows a call was missed, once per call.
 *
 * Once, because the same call is reported several times (CallRail's
 * modified webhooks, a backfill over the same window, the carrier's dial
 * result and then its status callback), and a missed call text back that
 * fired on each would text the caller three times. The event itself is the
 * record that it fired, so the check is a read of the event log.
 *
 * Shared by both ways a call arrives, so "missed" means one thing.
 */
export async function emitMissed(tx: Database, ctx: ServiceContext, callId: string): Promise<boolean> {
  const [already] = await tx.select({ id: schema.domainEvent.id }).from(schema.domainEvent)
    .where(and(
      eq(schema.domainEvent.organizationId, ctx.actor.organizationId),
      eq(schema.domainEvent.name, "call.missed"),
      eq(schema.domainEvent.entityId, callId),
    )).limit(1);
  if (already) return false;

  const [call] = await tx.select().from(schema.call).where(eq(schema.call.id, callId)).limit(1);
  if (!call || call.direction !== "inbound") return false;

  await emit(tx, ctx, {
    name: "call.missed", entityType: "call", entityId: call.id,
    payload: {
      callId: call.id,
      from: call.fromE164,
      to: call.receivedOnE164,
      startedAt: (call.startedAt ?? call.createdAt).toISOString(),
      status: call.status,
      customerId: call.customerId,
      channelId: call.channelId,
      campaignId: call.acquisitionCampaignId,
    },
  });
  return true;
}

/**
 * EVERYTHING THEY SENT, MINUS THE PARTS THAT ARE THE CALL ITSELF.
 *
 * Keeping the whole body is worth a lot: a field map is always wrong about
 * something, and this is the only record of what the provider actually said
 * about a call, which is what makes a mapping mistake recoverable a month
 * later. What it must not become is a way around the two refusals at the
 * top of this file.
 *
 * The transcript fields are the obvious ones. A transcript stored here is
 * the same unredacted text in the same database as a transcript stored in
 * `call.transcript`, with somebody's spoken card number in it, and the only
 * difference is which column an export happens to read.
 *
 * The recording fields are the less obvious ones and they matter as much.
 * CallRail's player link carries its own access key in the query string,
 * which makes it the audio rather than a pointer to the audio: anybody who
 * can read this row can play a recording nobody ever decided could be kept.
 *
 * Everything else stays, because everything else is what the call was
 * attributed to, which is the whole point of the connector.
 */
const NOT_STORED = [
  "transcription", "conversational_transcript", "call_summary", "call_highlights",
  "keywords_spotted", "voice_assist_message",
  "recording", "recording_player", "recording_duration", "waveforms",
] as const;

export function storable(raw: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if ((NOT_STORED as readonly string[]).includes(key)) {
      if (value !== null && value !== "" && value !== undefined) dropped.push(key);
      continue;
    }
    kept[key] = value;
  }
  /**
   * WHICH FIELDS WERE DROPPED, AS NAMES RATHER THAN VALUES.
   *
   * Without it the row is indistinguishable from one where the provider
   * sent nothing, and somebody debugging a missing recording spends an
   * afternoon on the provider's side of a decision that was made here.
   */
  if (dropped.length > 0) kept["_not_stored"] = dropped;
  return kept;
}

/**
 * What this product calls the outcome of the call.
 *
 * A voicemail is `voicemail` rather than `no_answer`, because the two need
 * different work: somebody has to listen to one of them. An unanswered call
 * with no voicemail is the number a shop actually manages to, and collapsing
 * the pair hides it.
 */
function statusOf(call: TrackedCall): typeof schema.callStatus.enumValues[number] {
  if (call.voicemail) return "voicemail";
  if (call.answered) return "completed";
  return "no_answer";
}

/** Their attribution fields as the query string a tagged visit would carry. */
function queryFrom(call: TrackedCall): string {
  const params = new URLSearchParams();
  if (call.utm.source) params.set("utm_source", call.utm.source);
  if (call.utm.medium) params.set("utm_medium", call.utm.medium);
  if (call.utm.campaign) params.set("utm_campaign", call.utm.campaign);
  if (call.utm.term) params.set("utm_term", call.utm.term);
  if (call.utm.content) params.set("utm_content", call.utm.content);
  /**
   * The click id under the parameter name that PROVES which network it came
   * from. A gclid handed to the parser as "clickId" would be an untyped
   * string it could not use; handed to it as `gclid` it settles a bare
   * `utm_source=google` with no medium, which is the common shape.
   */
  if (call.clickId) {
    const raw = call.raw;
    const name = typeof raw["gclid"] === "string" && raw["gclid"] !== ""
      ? "gclid"
      : typeof raw["msclkid"] === "string" && raw["msclkid"] !== ""
        ? "msclkid"
        : "fbclid";
    params.set(name, call.clickId);
  }
  return params.toString();
}

/* ------------------------------------------------------------- backfill */

/**
 * Fetch the calls in a window and record them.
 *
 * THIS IS THE REMEDY FOR THE LIMITATION THE CATALOGUE DECLARES. CallRail
 * does not resend a webhook that failed, and says so: "CallRail does not
 * resend webhooks, so missing calls might be your first indication of a
 * problem". A deployment that was down for an hour has an hour of calls
 * that will never arrive on their own, and without this the only recovery is
 * somebody typing them in off a dashboard.
 *
 * Every call goes through exactly the same `record` as a webhook does, so a
 * backfill over a window that mostly landed is mostly no-ops rather than a
 * second copy of the week.
 */
export async function backfill(
  ctx: ServiceContext,
  input: { since: string; until: string; maxPages?: number | undefined },
  deps: CallTrackingDeps = DEFAULT_DEPS,
) {
  /**
   * The permission is checked here, once, and the writes below open their
   * own transactions through `record`. Each call is its own unit of work on
   * purpose: a backfill of a thousand calls in one transaction holds a
   * connection for minutes and loses the whole run to one bad row, where
   * this loses one row and keeps the rest.
   */
  const { row, provider } = await guardedWrite(ctx, "integration:write", async (tx) => {
    const found = await loadConnection(tx, ctx.actor.organizationId);
    return { row: found, provider: await providerFor(found, deps) };
  });

  const since = new Date(input.since);
  const until = new Date(input.until);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
    throw new ConflictError("Give a window with a start before its end.");
  }

  /**
   * A ceiling on pages, because the far end is metered: a thousand requests
   * an hour against the operator's own account, shared with everything else
   * they have pointed at it. A backfill that walked a year would spend the
   * whole budget and the failure would land on whatever ran next.
   */
  const maxPages = Math.min(input.maxPages ?? 20, 50);

  let page = 1;
  let imported = 0;
  let duplicates = 0;
  let pages = 0;
  let stoppedBecause: string | null = null;

  while (page <= maxPages) {
    const fetched = await provider.listCalls({ since, until, page });
    if (!fetched.ok) {
      /**
       * A failed page stops the run and says so rather than being skipped.
       * Carrying on past it would report a count that looks complete and is
       * missing whatever that page held, which is the shape of answer that
       * stops anybody going back for it.
       */
      stoppedBecause = `${fetched.code}: ${fetched.message}`;
      break;
    }

    pages += 1;
    for (const call of fetched.calls) {
      const outcome = await record(ctx.db, ctx.actor.organizationId, call);
      if (outcome.kind === "recorded") {
        if (outcome.duplicate) duplicates += 1;
        else imported += 1;
      }
    }

    if (!fetched.hasMore) break;
    page += 1;
    if (page > maxPages) stoppedBecause = `Stopped at the ${maxPages} page ceiling, and there was more.`;
  }

  await inTenant(ctx, async (tx) => {
    /**
     * Recorded as a sync run, which is the table that already answers "what
     * has this connection done and when". A backfill that left no trace
     * would be indistinguishable from one nobody ran.
     */
    await tx.insert(schema.syncRun).values({
      organizationId: ctx.actor.organizationId,
      connectionId: row.id,
      direction: "inbound",
      entityType: "call",
      recordsRead: imported + duplicates,
      recordsWritten: imported,
      finishedAt: new Date(),
      error: stoppedBecause,
    });
  });

  return { imported, duplicates, pages, stoppedBecause };
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  connectCallTracking: (ctx: ServiceContext, input: {
    accountId: string; companyId?: string | undefined; accountLabel?: string | undefined;
  }) => connect(ctx, input),

  getCallTrackingConnection: (ctx: ServiceContext) => connection(ctx),

  checkCallTracking: (ctx: ServiceContext) => check(ctx),

  backfillCallTracking: (ctx: ServiceContext, input: {
    since: string; until: string; maxPages?: number | undefined;
  }) => backfill(ctx, input),
} as const;
