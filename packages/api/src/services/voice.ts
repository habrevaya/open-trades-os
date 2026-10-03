import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, voice, type Actor } from "@opentradesos/core";
import {
  audit, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as phoneNumbers from "./phone-numbers";
import * as callTracking from "./call-tracking";
import * as telephony from "./telephony";
import * as files from "./files";
import { leaseForCall } from "./website-tracking";
import {
  createVoiceProvider, voiceCapableProviders,
  type AvailableNumber, type NumberWebhooks, type VoiceProvider, type WebhookRequest,
} from "../voice/provider";

/**
 * TRACKING NUMBERS THAT THIS PRODUCT ANSWERS
 *
 * Until now a tracking number was typed in by hand and its calls arrived
 * only as records from CallRail. This is the other way: the company buys the
 * number from its own Twilio account on the settings screen, the number is
 * pointed at this product's webhooks as it is bought, and every call to it
 * rings here first. The answer is a short set of instructions: optionally ask
 * the caller whether the call may be recorded, tell the person answering
 * which channel and campaign the call came from, and ring the office, or the
 * after hours number, or voicemail.
 *
 * THE SAME CALL ROWS AS CALLRAIL. A call on a native number is recorded by
 * `callTracking.record`, the function the CallRail webhook uses, so its touch,
 * its channel and campaign at the time, its first time caller flag and the
 * funnel all come from one code path. A call on a website pool number is
 * recorded with the visit that was shown the number as its attribution.
 *
 * WHY THE WEBHOOK WRITES WITH THE SYSTEM ACTOR AND NO GRANTS. A carrier has no
 * session. The recording decision and the attachment are the same functions
 * the guarded routes call (`telephony.decideRecordingIn`, `attachRecordingIn`),
 * reached inside the tenant transaction rather than through a synthetic actor
 * holding `message:send`, for the reason `call-tracking.ts` gives: an actor
 * built to pass a guard is the moment the guard stops meaning anything.
 *
 * RECORDING, IN ORDER, AND ONLY FORWARD. The caller hears the question before
 * anything is recorded. Pressing 1 is the only yes. The recording check runs
 * with the operator's own declared policies; only a yes adds recording to the
 * dial. When the carrier reports the finished recording it is fetched, kept
 * as a stored file, attached through the same gate, and the carrier's copy is
 * deleted, so the recording lives in one place and deleting it here deletes
 * it. A recording for a call that was not allowed one, or whose recording was
 * deleted on the call, is deleted at the carrier and never kept.
 */

/* ------------------------------------------------------------- the seams */

export type ReadSecret = (ref: string) => Promise<string>;

export interface VoiceDeps {
  readSecret: ReadSecret;
  /** Injected so no test reaches Twilio and no deployment fakes one. */
  provider?: VoiceProvider | undefined;
  /** The deployment's public address, which every webhook URL is built from. */
  publicBase?: string | undefined;
}

const secretFromEnvironment: ReadSecret = async (ref) => {
  const value = process.env[ref];
  if (!value) {
    throw new ConflictError(
      `No carrier credential in the environment under "${ref}". The Twilio connection names that secret and nothing is set there.`,
    );
  }
  return value;
};

export const DEFAULT_DEPS: VoiceDeps = { readSecret: secretFromEnvironment };

function baseOf(deps: VoiceDeps): string {
  const base = deps.publicBase ?? process.env["PUBLIC_URL"];
  if (!base) {
    throw new ConflictError(
      "PUBLIC_URL is not set, so there is no address to point a number's calls at. Set it to this installation's public address.",
    );
  }
  return base.replace(/\/$/, "");
}

export const voiceWebhookPath = (token: string, step?: string) =>
  `/api/webhooks/voice/${token}${step ? `/${step}` : ""}`;

export function webhooksFor(base: string, token: string): NumberWebhooks {
  return {
    voiceUrl: `${base}${voiceWebhookPath(token)}`,
    statusUrl: `${base}${voiceWebhookPath(token, "status")}`,
    smsUrl: `${base}/api/webhooks/messaging/${token}`,
  };
}

interface Carrier {
  connectionId: string;
  token: string;
  provider: VoiceProvider;
}

/**
 * The company's carrier account, for calls.
 *
 * The messaging connection, because it is the same Twilio account and the
 * same credential: its settings hold the Account SID, its `credentialRef`
 * names the auth token, and its webhook token is the secret in every URL a
 * number is pointed at.
 */
async function carrierFor(tx: Database, organizationId: string, deps: VoiceDeps): Promise<Carrier> {
  const [row] = await tx.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.capability, "messaging"),
      eq(schema.integrationConnection.status, "connected"),
      isNull(schema.integrationConnection.deletedAt),
    ));
  if (!row || !voiceCapableProviders().includes(row.provider)) {
    throw new ConflictError(
      "Connect your Twilio account under Settings, Integrations first. Numbers are bought from your own account, "
      + "and calls are routed through the same connection your texts use.",
    );
  }
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const token = typeof settings["webhookToken"] === "string" ? settings["webhookToken"] : "";
  if (token.length < 32) throw new ConflictError("The Twilio connection has no webhook address yet. Reconnect it.");
  const provider = deps.provider
    ?? createVoiceProvider(row.provider, settings, row.credentialRef ? await deps.readSecret(row.credentialRef) : "");
  return { connectionId: row.id, token, provider };
}

/* ------------------------------------------------------- buying numbers */

/**
 * Numbers the carrier has free, by area code or town.
 *
 * `settings:write` rather than read, because it spends something: every
 * search is a request against the company's own carrier account.
 */
export async function searchNumbers(
  ctx: ServiceContext,
  input: { areaCode?: string | undefined; locality?: string | undefined; region?: string | undefined },
  deps: VoiceDeps = DEFAULT_DEPS,
): Promise<AvailableNumber[]> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const query = voice.checkNumberSearch(input);
    if (!query.ok) throw new ConflictError(query.reason);
    const { provider } = await carrierFor(tx, ctx.actor.organizationId, deps);
    const found = await provider.searchNumbers({
      areaCode: query.areaCode, locality: query.locality, region: query.region, limit: 10,
    });
    if (!found.ok) throw new ConflictError(`Twilio would not search: ${found.message}`);
    return found.numbers;
  });
}

export type BuyInput = phoneNumbers.NumberInput & { purpose: "tracking" | "pool" };

/**
 * Buy a number and put it to work, in that order, and undo the purchase if
 * the second half is refused.
 *
 * Everything this product can refuse is checked BEFORE the carrier is asked,
 * so a purchase never lands on a form error. If the insert still fails after
 * the purchase (somebody added the same number by hand a second ago), the
 * number is handed back at the carrier rather than left on the company's bill
 * with nothing here pointing at it.
 */
export async function buyNumber(ctx: ServiceContext, input: BuyInput, deps: VoiceDeps = DEFAULT_DEPS) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    if (input.purpose !== "tracking" && input.purpose !== "pool") {
      throw new ConflictError("Numbers bought here are tracking numbers or website pool numbers.");
    }
    /**
     * Already bought and held: a retry of a purchase that went through. It
     * is answered with the number rather than a second purchase attempt,
     * which the carrier would refuse and the screen would show as a failure.
     */
    const [held] = await tx.select().from(schema.phoneNumber)
      .where(and(
        eq(schema.phoneNumber.e164, input.e164.trim()),
        isNull(schema.phoneNumber.releasedAt),
        sql`${schema.phoneNumber.providerNumberId} is not null`,
      )).limit(1);
    if (held) return phoneNumbers.shapeOf(held);
    await phoneNumbers.checkNew(tx, ctx, input);
    const base = baseOf(deps);
    const carrier = await carrierFor(tx, ctx.actor.organizationId, deps);
    const bought = await carrier.provider.buyNumber({
      e164: input.e164.trim(), webhooks: webhooksFor(base, carrier.token), label: input.label ?? undefined,
    });
    if (!bought.ok) throw new ConflictError(`Twilio would not sell that number: ${bought.message}`);

    try {
      const row = await phoneNumbers.addWithin(tx, ctx, {
        ...input, e164: bought.e164, providerNumberId: bought.providerNumberId,
      });
      await tx.update(schema.phoneNumber).set({ connectionId: carrier.connectionId })
        .where(eq(schema.phoneNumber.id, row.id));
      await audit(tx, ctx, "phone_number.bought", "phone_number", row.id, null, {
        e164: bought.e164, providerNumberId: bought.providerNumberId,
      });
      return row;
    } catch (error) {
      await carrier.provider.releaseNumber(bought.providerNumberId);
      throw error;
    }
  });
}

/**
 * Hand a number back here AND at the carrier.
 *
 * The carrier first. A number released here and still held at Twilio is a
 * number the company keeps paying for and that still rings into a webhook
 * that now answers "not in service". If the carrier refuses, nothing here
 * changes and the refusal says why; a number the carrier no longer has (it
 * was released in their console) is released here too.
 */
export async function releaseNumber(
  ctx: ServiceContext, input: { id: string; reason?: string | undefined }, deps: VoiceDeps = DEFAULT_DEPS,
) {
  const number = await guardedWrite(ctx, "settings:write", async (tx) => {
    const [row] = await tx.select().from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.id, input.id)).limit(1);
    if (!row) throw new NotFoundError("Phone number");
    return row;
  });
  if (number.releasedAt) {
    /** A retry of a release that went through. */
    return { id: number.id, released: true as const, nowSendingFrom: null, reason: input.reason?.trim() || null };
  }
  if (number.providerNumberId) {
    await guardedWrite(ctx, "settings:write", async (tx) => {
      const { provider } = await carrierFor(tx, ctx.actor.organizationId, deps);
      const released = await provider.releaseNumber(number.providerNumberId!);
      if (!released.ok && released.code !== "20404" && released.code !== "404") {
        throw new ConflictError(`Twilio would not release ${number.e164}: ${released.message} Nothing was released here.`);
      }
    });
  }
  return phoneNumbers.release(ctx, { id: input.id, ...(input.reason ? { reason: input.reason } : {}) });
}

/* ------------------------------------------------------------ the webhook */

export interface VoiceConnection {
  connectionId: string;
  organizationId: string;
  token: string;
  provider: VoiceProvider;
}

/**
 * Which tenant a carrier request belongs to: from the secret in the URL, by
 * the same security definer function the messaging webhook uses, never from
 * the number dialled, which is printed on the company's van.
 */
export async function resolveWebhook(db: Database, token: string, deps: VoiceDeps = DEFAULT_DEPS): Promise<VoiceConnection | null> {
  const rows = await db.execute<{
    connection_id: string; organization_id: string; provider: string;
    settings: Record<string, unknown>; credential_ref: string | null;
  }>(sql`select * from app.messaging_webhook_connection(${token})`);
  const row = rows[0];
  if (!row || !voiceCapableProviders().includes(row.provider)) return null;
  const secret = row.credential_ref ? await deps.readSecret(row.credential_ref) : "";
  return {
    connectionId: row.connection_id,
    organizationId: row.organization_id,
    token,
    provider: deps.provider ?? createVoiceProvider(row.provider, row.settings, secret),
  };
}

export const STEPS = ["incoming", "connect", "whisper", "dialed", "voicemail-done", "voicemail", "recording", "status"] as const;
export type Step = (typeof STEPS)[number];

export type VoiceReply = { status: number; twiml: string | null };

function voiceActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "voice" };
}

const reply = (verbs: voice.Verb[]): VoiceReply => ({ status: 200, twiml: voice.twiml(verbs) });
const empty: VoiceReply = { status: 200, twiml: voice.twiml([]) };

/**
 * One request from the carrier.
 *
 * The signature is checked before the body is read for anything, over the
 * public URL the carrier was given (which carries the step), so a forged
 * step is refused like a forged body.
 */
export async function handle(
  db: Database,
  connection: VoiceConnection,
  step: Step,
  request: WebhookRequest,
  deps: VoiceDeps = DEFAULT_DEPS,
  now: Date = new Date(),
): Promise<VoiceReply> {
  if (!connection.provider.verify(request)) return { status: 403, twiml: null };
  const form: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(request.body)) form[key] = value;

  const base = baseOf(deps);
  const url = (s: Step) => `${base}${voiceWebhookPath(connection.token, s)}`;
  const ctx: ServiceContext = { actor: voiceActor(connection.organizationId), db };

  switch (step) {
    case "incoming": return incoming(db, ctx, form, url, now);
    case "connect": return connect(ctx, form, url, now);
    case "whisper": return whisper(ctx, form);
    case "dialed": return dialed(ctx, form, url, now);
    case "voicemail-done": return reply([{ verb: "hangup" }]);
    case "voicemail": return keepAudio(ctx, connection, form, "voicemail");
    case "recording": return keepAudio(ctx, connection, form, "recording");
    case "status": return status(ctx, form, now);
    default: return empty;
  }
}

async function callBySid(tx: Database, sid: string | undefined) {
  if (!sid) return null;
  const [row] = await tx.select().from(schema.call)
    .where(eq(schema.call.providerCallId, `twilio:${sid}`)).limit(1);
  return row ?? null;
}

async function numberOf(tx: Database, call: { phoneNumberId: string | null; receivedOnE164: string | null }) {
  const [row] = await tx.select().from(schema.phoneNumber)
    .where(call.phoneNumberId
      ? eq(schema.phoneNumber.id, call.phoneNumberId)
      : and(eq(schema.phoneNumber.e164, call.receivedOnE164 ?? ""), isNull(schema.phoneNumber.releasedAt)))
    .limit(1);
  return row ?? null;
}

/** Where the call goes now, from core's router, with the hours the company keeps online. */
async function routeOf(
  tx: Database, organizationId: string, number: typeof schema.phoneNumber.$inferSelect,
  knownCustomer: boolean, now: Date,
) {
  const rows = await tx.select().from(schema.businessHours);
  const hours = voice.businessHoursFrom(rows, await timezoneOf(tx, organizationId));
  return voice.routeCall({ number, dialled: number.e164, hours, knownCustomer, now });
}

const voicemailVerbs = (url: (s: Step) => string): voice.Verb[] => [
  { verb: "say", text: voice.VOICEMAIL_PROMPT },
  { verb: "record", action: url("voicemail-done"), recordingCallback: url("voicemail"), maxSeconds: 120 },
  { verb: "hangup" },
];

async function incoming(
  db: Database, ctx: ServiceContext, form: Record<string, string>, url: (s: Step) => string, now: Date,
): Promise<VoiceReply> {
  const sid = form["CallSid"];
  const from = form["From"] ?? "";
  const to = form["To"] ?? "";
  if (!sid || !to) return reply([{ verb: "hangup" }]);
  const org = ctx.actor.organizationId;

  const found = await inTenant(ctx, async (tx) => {
    const [number] = await tx.select().from(schema.phoneNumber)
      .where(and(eq(schema.phoneNumber.e164, to), isNull(schema.phoneNumber.releasedAt))).limit(1);
    if (!number) return null;
    const lease = number.purpose === "pool" ? await leaseForCall(tx, org, number.id, now) : null;
    return { number, lease };
  });
  if (!found) return reply([{ verb: "say", text: voice.NOT_IN_SERVICE }, { verb: "hangup" }]);

  /**
   * Through the CallRail path, so the call and its touch are the same rows
   * any tracked call becomes. Answered and duration are unknown at the ring,
   * which is exactly what a pre-call webhook from a tracking provider says
   * too, and what keeps this from counting as missed before anybody tried.
   */
  const recorded = await callTracking.record(db, org, {
    externalId: sid,
    direction: "inbound",
    trackingNumber: to,
    customerNumber: from,
    businessNumber: null,
    startedAt: now,
    durationSeconds: null,
    answered: false,
    voicemail: false,
    customerName: null,
    utm: {},
    clickId: null,
    referrer: null,
    landingPath: null,
    personId: null,
    firstCall: null,
    raw: { CallSid: sid, From: from, To: to, Direction: form["Direction"] ?? "inbound" },
  }, now, {
    system: "twilio",
    ...(found.number.purpose === "pool" ? {
      attribution: {
        query: found.lease?.landingQuery ?? null,
        referrer: found.lease?.referrer ?? null,
        landingPath: found.lease?.landingPath ?? null,
        visitorId: found.lease?.visitorId ?? null,
      },
    } : {}),
  });
  if (recorded.kind !== "recorded") return reply([{ verb: "hangup" }]);

  return inTenant(ctx, async (tx) => {
    const [call] = await tx.select().from(schema.call).where(eq(schema.call.id, recorded.callId)).limit(1);
    const routed = await routeOf(tx, org, found.number, Boolean(call?.customerId), now);
    await tx.update(schema.call).set({
      ...(recorded.duplicate ? {} : { status: "ringing" as const }),
      routedBecause: routed.why,
      updatedAt: now,
    }).where(eq(schema.call.id, recorded.callId));

    if (routed.destination.kind !== "forward") return reply(voicemailVerbs(url));
    if (found.number.recordCalls) {
      /**
       * The question, then a redirect for the caller who answers it with
       * silence. Both reach `connect`: with Digits=1 the caller agreed, and
       * without it they did not.
       */
      return reply([
        { verb: "gather", action: url("connect"), numDigits: 1, timeoutSeconds: 6, say: voice.RECORDING_QUESTION },
        { verb: "redirect", url: url("connect") },
      ]);
    }
    return reply([dialTo(routed.destination.e164, found.number, url, false)]);
  });
}

function dialTo(
  e164: string, number: typeof schema.phoneNumber.$inferSelect, url: (s: Step) => string, recording: boolean,
): voice.Verb {
  return {
    verb: "dial",
    to: e164,
    action: url("dialed"),
    timeoutSeconds: 20,
    ...(number.whisper ? { whisperUrl: url("whisper") } : {}),
    ...(recording ? { recordingCallback: url("recording") } : {}),
  };
}

async function connect(
  ctx: ServiceContext, form: Record<string, string>, url: (s: Step) => string, now: Date,
): Promise<VoiceReply> {
  return inTenant(ctx, async (tx) => {
    const call = await callBySid(tx, form["CallSid"]);
    if (!call) return reply([{ verb: "hangup" }]);
    const number = await numberOf(tx, call);
    if (!number) return reply([{ verb: "say", text: voice.NOT_IN_SERVICE }, { verb: "hangup" }]);
    const routed = await routeOf(tx, ctx.actor.organizationId, number, Boolean(call.customerId), now);
    if (routed.destination.kind !== "forward") return reply(voicemailVerbs(url));

    let recording = false;
    if (number.recordCalls) {
      const asked = voice.recordingDecision({
        callerPressedOne: form["Digits"] === "1",
        policies: await telephony.policies(tx, ctx.actor.organizationId),
      });
      try {
        const decision = await telephony.decideRecordingIn(tx, ctx, {
          callId: call.id, parties: asked.parties, announcementPlayed: true,
        });
        recording = decision.ok;
      } catch (error) {
        /** A recording deleted on this call already: connect, and record nothing. */
        if (!(error instanceof ConflictError)) throw error;
      }
    }
    return reply([dialTo(routed.destination.e164, number, url, recording)]);
  });
}

async function whisper(ctx: ServiceContext, form: Record<string, string>): Promise<VoiceReply> {
  return inTenant(ctx, async (tx) => {
    const call = await callBySid(tx, form["ParentCallSid"] ?? form["CallSid"]);
    if (!call) return empty;
    const [channel] = call.channelId
      ? await tx.select({ name: schema.marketingChannel.name }).from(schema.marketingChannel)
        .where(eq(schema.marketingChannel.id, call.channelId)).limit(1)
      : [];
    const [campaign] = call.acquisitionCampaignId
      ? await tx.select({ name: schema.acquisitionCampaign.name }).from(schema.acquisitionCampaign)
        .where(eq(schema.acquisitionCampaign.id, call.acquisitionCampaignId)).limit(1)
      : [];
    return reply([{
      verb: "say",
      text: voice.whisperText({
        channelName: channel?.name, campaignName: campaign?.name, recording: call.recordingStartedAt !== null,
      }),
    }]);
  });
}

async function dialed(
  ctx: ServiceContext, form: Record<string, string>, url: (s: Step) => string, now: Date,
): Promise<VoiceReply> {
  return inTenant(ctx, async (tx) => {
    const call = await callBySid(tx, form["CallSid"]);
    if (!call) return reply([{ verb: "hangup" }]);
    const outcome = voice.dialOutcome(form["DialCallStatus"]);
    const talked = Number(form["DialCallDuration"] ?? 0);
    await tx.update(schema.call).set({
      status: voice.laterStatus(call.status, outcome.status),
      ...(outcome.answered && !call.answeredAt
        ? { answeredAt: new Date(now.getTime() - (Number.isFinite(talked) ? talked : 0) * 1000) }
        : {}),
      updatedAt: now,
    }).where(eq(schema.call.id, call.id));
    if (!outcome.missed) return reply([{ verb: "hangup" }]);

    await callTracking.emitMissed(tx, ctx, call.id);
    return reply(voicemailVerbs(url));
  });
}

/**
 * How the call ended, from the carrier's status callback.
 *
 * Out of order and repeated by design, so the status only ever moves forward
 * (`voice.laterStatus`). A call that ended without anybody here answering is
 * a missed call even when no dial result arrived: the caller hung up while it
 * was still ringing, which is the most missed a call can be.
 */
async function status(ctx: ServiceContext, form: Record<string, string>, now: Date): Promise<VoiceReply> {
  return inTenant(ctx, async (tx) => {
    const call = await callBySid(tx, form["CallSid"]);
    if (!call) return empty;
    const reported = voice.providerCallStatus(form["CallStatus"]);
    if (!reported || reported === "ringing" || reported === "in_progress") return empty;
    const unanswered = call.answeredAt === null;
    const next = reported === "completed" && unanswered ? "abandoned" : reported;
    const seconds = Number(form["CallDuration"]);
    await tx.update(schema.call).set({
      status: voice.laterStatus(call.status, next),
      ...(Number.isFinite(seconds) && seconds >= 0 ? {
        durationSeconds: seconds,
        endedAt: new Date((call.startedAt ?? now).getTime() + seconds * 1000),
      } : {}),
      updatedAt: now,
    }).where(eq(schema.call.id, call.id));
    if (unanswered) await callTracking.emitMissed(tx, ctx, call.id);
    return empty;
  });
}

/**
 * Keep a finished recording or voicemail, or refuse to.
 *
 * A CALL RECORDING is kept only when the recording check said yes for this
 * call and nobody has deleted it since; otherwise the carrier's copy is
 * deleted and nothing is stored. A VOICEMAIL is kept whenever there is one:
 * it is a message the caller chose to leave after being asked to, not a
 * recording of a conversation, and it is the thing somebody has to listen to.
 *
 * The bytes are fetched before the transaction opens, because a transaction
 * held open across a download is a connection held for as long as the
 * carrier takes. The carrier's copy is deleted after the transaction commits,
 * so a failure to store leaves it there for the next attempt rather than
 * nowhere.
 */
async function keepAudio(
  ctx: ServiceContext, connection: VoiceConnection, form: Record<string, string>, which: "recording" | "voicemail",
): Promise<VoiceReply> {
  const recordingId = form["RecordingSid"];
  const recordingUrl = form["RecordingUrl"];
  if (!recordingId || !recordingUrl || (form["RecordingStatus"] && form["RecordingStatus"] !== "completed")) return empty;

  const call = await inTenant(ctx, (tx) => callBySid(tx, form["ParentCallSid"] ?? form["CallSid"]));
  if (!call) return empty;
  const allowed = which === "voicemail" || (call.recordingStartedAt !== null && call.recordingDeletedAt === null);
  if (!allowed) {
    await connection.provider.deleteRecording(recordingId);
    await inTenant(ctx, (tx) => audit(tx, ctx, "call.recording_discarded", "call", call.id, null, {
      because: call.recordingDeletedAt ? "deleted on the call" : `not allowed: ${call.recordingRefusal ?? "never asked"}`,
    }));
    return empty;
  }

  const fetched = await connection.provider.fetchRecording(recordingUrl);
  if (!fetched.ok) return { status: fetched.retryable ? 503 : 200, twiml: null };

  const stored = await inTenant(ctx, async (tx) => {
    const { file } = await files.put(tx, ctx.actor.organizationId, { bytes: fetched.bytes, accept: "recordings" });
    if (which === "voicemail") {
      await tx.update(schema.call).set({
        voicemailStorageKey: file.storageKey,
        voicemailUrl: `/marketing/calls/${call.id}/voicemail`,
        status: voice.laterStatus(call.status, "voicemail"),
        updatedAt: new Date(),
      }).where(eq(schema.call.id, call.id));
      await callTracking.emitMissed(tx, ctx, call.id);
      return true;
    }
    try {
      await telephony.attachRecordingIn(tx, ctx, call.id, `/marketing/calls/${call.id}/recording`, file.storageKey);
      return true;
    } catch (error) {
      if (error instanceof ConflictError) return false;
      throw error;
    }
  }).catch((error: unknown) => {
    /** Not an MP3 or too large: kept nowhere, said in the log, and the carrier's copy left for a person. */
    if (error instanceof ConflictError) return false;
    throw error;
  });

  if (stored) await connection.provider.deleteRecording(recordingId);
  return empty;
}

/* ----------------------------------------------------------- housekeeping */

/**
 * Recordings past the company's retention, deleted the way a person deletes
 * one.
 *
 * Only under an active `retention_policy` for `call_recording` that allows
 * purging: this product ships no retention period of its own, for the reason
 * the compliance module gives, and a recording with no declared period is
 * kept until somebody deletes it.
 */
export async function sweepRecordings(db: Database, organizationId: string, now: Date = new Date()): Promise<number> {
  const ctx: ServiceContext = { actor: voiceActor(organizationId), db };
  return inTenant(ctx, async (tx) => {
    const [policy] = await tx.select().from(schema.retentionPolicy)
      .where(and(
        eq(schema.retentionPolicy.entityType, "call_recording"),
        eq(schema.retentionPolicy.active, true),
        eq(schema.retentionPolicy.purgeAllowed, true),
      )).limit(1);
    if (!policy) return 0;
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - policy.retainMonths);
    const due = await tx.select({ id: schema.call.id }).from(schema.call)
      .where(and(
        isNull(schema.call.recordingDeletedAt),
        sql`${schema.call.recordingStorageKey} is not null`,
        lt(sql`coalesce(${schema.call.startedAt}, ${schema.call.createdAt})`, cutoff),
      )).limit(500);
    for (const row of due) {
      await telephony.deleteRecordingIn(tx, ctx, row.id, `Past the ${policy.retainMonths} month retention in "${policy.name}".`);
    }
    return due.length;
  });
}

/* --------------------------------------------------------------- handlers */

const voiceSettings = (input: {
  whisper?: boolean | undefined; recordCalls?: boolean | undefined; routeByHours?: boolean | undefined;
  afterHoursForwardsToE164?: string | null | undefined; forwardsToE164?: string | null | undefined;
}) => ({
  ...(input.whisper !== undefined ? { whisper: input.whisper } : {}),
  ...(input.recordCalls !== undefined ? { recordCalls: input.recordCalls } : {}),
  ...(input.routeByHours !== undefined ? { routeByHours: input.routeByHours } : {}),
  ...(input.afterHoursForwardsToE164 !== undefined ? { afterHoursForwardsToE164: input.afterHoursForwardsToE164 } : {}),
  ...(input.forwardsToE164 !== undefined ? { forwardsToE164: input.forwardsToE164 } : {}),
});

export const handlers = {
  searchAvailableNumbers: async (ctx: ServiceContext, input: {
    areaCode?: string | undefined; locality?: string | undefined; region?: string | undefined;
  }) => ({ numbers: await searchNumbers(ctx, input) }),

  buyTrackingNumber: (ctx: ServiceContext, input: {
    e164: string; purpose: "tracking" | "pool"; label?: string | undefined;
    campaignId?: string | undefined; channelId?: string | undefined;
    forwardsToE164?: string | undefined; whisper?: boolean | undefined; recordCalls?: boolean | undefined;
    routeByHours?: boolean | undefined; afterHoursForwardsToE164?: string | undefined;
  }) => buyNumber(ctx, {
    e164: input.e164, purpose: input.purpose,
    ...(input.label ? { label: input.label } : {}),
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...voiceSettings(input),
  }),

  releasePhoneNumber: (ctx: ServiceContext, input: { id: string; reason?: string | undefined }) =>
    releaseNumber(ctx, input),

  setNumberRouting: (ctx: ServiceContext, input: {
    id: string; forwardsToE164?: string | null | undefined; whisper?: boolean | undefined;
    recordCalls?: boolean | undefined; routeByHours?: boolean | undefined;
    afterHoursForwardsToE164?: string | null | undefined;
  }) => phoneNumbers.update(ctx, { id: input.id, ...voiceSettings(input) }),
} as const;
