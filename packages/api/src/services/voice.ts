import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, can, voice, type Actor, type telephony as tel } from "@opentradesos/core";
import {
  audit, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as phoneNumbers from "./phone-numbers";
import * as callTracking from "./call-tracking";
import * as telephony from "./telephony";
import * as files from "./files";
import * as phoneMenus from "./phone-menus";
import * as onCall from "./on-call";
import * as transcription from "./transcription";
import * as voiceAgent from "./voice-agent";
import * as callQueues from "./call-queues";
import * as softphone from "./softphone";
import { memberActor } from "./session";
import { emit } from "./events";
import { leaseForCall } from "./website-tracking";
import { readerFor } from "../secrets/store";
import {
  DEFAULT_DEPS, baseOf, carrierFor, relayBaseOf, voiceWebhookPath, webhooksFor, type VoiceDeps,
} from "./voice-carrier";
/**
 * The barrel rather than the seam, so the Twilio adapter is registered by
 * whatever reaches this service: the settings screen buying a number has no
 * route of its own to import it, and an empty registry would read as
 * "Twilio is not connected" to somebody whose Twilio is connected.
 */
import {
  createVoiceProvider, voiceCapableProviders,
  type AvailableNumber, type VoiceProvider, type WebhookRequest,
} from "../voice/index";

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

export {
  DEFAULT_DEPS, voiceWebhookPath, webhooksFor, type ReadSecret, type VoiceDeps,
} from "./voice-carrier";

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
  if (number.adoptedAt) {
    /**
     * A number the company brought with it is NEVER released at the
     * carrier: that would give it away. Its calls go back to wherever they
     * went before it was answered here, and then it is released here only.
     */
    await stopAnswering(ctx, { id: number.id }, deps);
  } else if (number.providerNumberId) {
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

/* ------------------------------------------------- numbers already held */

/**
 * ANSWER A NUMBER THE COMPANY ALREADY HAS.
 *
 * The number on the van has been the company's for twenty years and is
 * already on its Twilio account, because that is where its texts go. Buying
 * a new one to get a phone menu would mean repainting the van. So the
 * number is found on the company's own account and its CALLS are pointed
 * here; its texts are left exactly where they were.
 *
 * Where its calls went before is written down first, so stopping (or
 * releasing it here) puts them back rather than leaving a number that rings
 * nowhere. A number Twilio does not hold is refused in words: it is with
 * another carrier, and the answer is to move it, which is between the
 * company and the carriers.
 */
export async function answerHere(ctx: ServiceContext, input: { id: string }, deps: VoiceDeps = DEFAULT_DEPS) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [row] = await tx.select().from(schema.phoneNumber)
      .where(and(eq(schema.phoneNumber.organizationId, ctx.actor.organizationId), eq(schema.phoneNumber.id, input.id)))
      .limit(1);
    if (!row) throw new NotFoundError("Phone number");
    if (row.releasedAt) throw new ConflictError("That number has been released.");
    /** Already answered here, bought or adopted: a retry, answered with the number. */
    if (row.providerNumberId) return phoneNumbers.shapeOf(row);

    const carrier = await carrierFor(tx, ctx.actor.organizationId, deps);
    const found = await carrier.provider.findNumber(row.e164);
    if (!found.ok) throw new ConflictError(`Twilio would not look the number up: ${found.message}`);
    if (!found.found) {
      throw new ConflictError(
        `Your Twilio account does not hold ${row.e164}. A number with another phone company has to be moved to Twilio before its calls can be answered here.`,
      );
    }
    const hooks = webhooksFor(baseOf(deps), carrier.token);
    const ours = (value: string | null) => value !== null && value.includes("/api/webhooks/voice/");
    const pointed = await carrier.provider.pointCalls({
      providerNumberId: found.providerNumberId, voiceUrl: hooks.voiceUrl, statusUrl: hooks.statusUrl,
    });
    if (!pointed.ok) throw new ConflictError(`Twilio would not point the number's calls here: ${pointed.message}`);

    const [after] = await tx.update(schema.phoneNumber).set({
      providerNumberId: found.providerNumberId,
      connectionId: carrier.connectionId,
      adoptedAt: new Date(),
      previousVoiceUrl: ours(found.voiceUrl) ? null : found.voiceUrl,
      previousStatusUrl: ours(found.statusUrl) ? null : found.statusUrl,
      updatedAt: new Date(),
    }).where(eq(schema.phoneNumber.id, row.id)).returning();
    await audit(tx, ctx, "phone_number.answered_here", "phone_number", row.id, row, after!);
    return phoneNumbers.shapeOf(after!);
  });
}

/**
 * Stop answering an adopted number here, and put its calls back.
 *
 * Only for a number that was adopted. One bought here has nowhere to go
 * back to: releasing it is the way to stop paying for it.
 */
export async function stopAnswering(ctx: ServiceContext, input: { id: string }, deps: VoiceDeps = DEFAULT_DEPS) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [row] = await tx.select().from(schema.phoneNumber)
      .where(and(eq(schema.phoneNumber.organizationId, ctx.actor.organizationId), eq(schema.phoneNumber.id, input.id)))
      .limit(1);
    if (!row) throw new NotFoundError("Phone number");
    if (!row.providerNumberId) return phoneNumbers.shapeOf(row);
    if (!row.adoptedAt) {
      throw new ConflictError("This number was bought here, so its calls have nowhere to go back to. Release it to stop paying for it.");
    }
    const carrier = await carrierFor(tx, ctx.actor.organizationId, deps);
    const restored = await carrier.provider.pointCalls({
      providerNumberId: row.providerNumberId,
      voiceUrl: row.previousVoiceUrl ?? "",
      statusUrl: row.previousStatusUrl ?? "",
    });
    /** Gone from the account already: there is nothing left to point, and nothing here should still claim it. */
    if (!restored.ok && restored.code !== "20404" && restored.code !== "404") {
      throw new ConflictError(`Twilio would not put the number's calls back: ${restored.message} Nothing was changed here.`);
    }
    const [after] = await tx.update(schema.phoneNumber).set({
      providerNumberId: null, adoptedAt: null, previousVoiceUrl: null, previousStatusUrl: null,
      updatedAt: new Date(),
    }).where(eq(schema.phoneNumber.id, row.id)).returning();
    await audit(tx, ctx, "phone_number.no_longer_answered_here", "phone_number", row.id, row, after!);
    return phoneNumbers.shapeOf(after!);
  });
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
  const secret = row.credential_ref
    ? await (deps.readSecret ?? readerFor(db, row.organization_id))(row.credential_ref)
    : "";
  return {
    connectionId: row.connection_id,
    organizationId: row.organization_id,
    token,
    provider: deps.provider ?? createVoiceProvider(row.provider, row.settings, secret),
  };
}

export const STEPS = [
  "incoming", "connect", "whisper", "dialed", "voicemail-done", "voicemail", "recording", "status", "menu",
  /** The phone assistant's conversation is over: put the caller through, or say goodbye. */
  "agent-done",
  /** A waiting line: each turn of the music, how the caller left, and the person answering. */
  "queue-wait", "queue-done", "queue-answer", "queue-connect",
  /** A call somebody placed from the browser, the question put to the person called, and how it ended. */
  "softphone", "softphone-consent", "softphone-dialed",
] as const;
export type Step = (typeof STEPS)[number];

export type VoiceReply = { status: number; twiml: string | null };

function voiceActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "voice" };
}

const reply = (verbs: voice.Verb[]): VoiceReply => ({ status: 200, twiml: voice.twiml(verbs) });
const empty: VoiceReply = { status: 200, twiml: voice.twiml([]) };

/**
 * A step's address, with what the next request needs to know carried in its
 * query string: which menu, which attempt, which member of a ring group, how
 * many destinations the call has been through. The query is part of the URL
 * the carrier signs, so a step somebody edits by hand fails the signature
 * like a forged body does.
 */
type StepUrl = (step: Step, query?: Record<string, string | number>) => string;

/**
 * How many destinations a call may pass through before it goes to voicemail
 * regardless: a menu sending to a group whose no answer goes to another
 * menu. Every loop a person could save is refused when they save it; this is
 * the backstop for the one nobody thought of, and it ends in a message the
 * caller can leave rather than in a caller going round for ever.
 */
const MAX_HOPS = 8;

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
  const query = new URL(request.url).searchParams;

  const base = baseOf(deps);
  const url: StepUrl = (s, params) => {
    const search = params && Object.keys(params).length > 0
      ? `?${new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])))}`
      : "";
    return `${base}${voiceWebhookPath(connection.token, s)}${search}`;
  };
  const ctx: ServiceContext = { actor: voiceActor(connection.organizationId), db };
  const wire: Wire = { connection, deps, url, now };

  switch (step) {
    case "incoming": return incoming(db, ctx, form, wire);
    case "connect": return connect(ctx, form, wire);
    case "whisper": return whisper(ctx, form);
    case "dialed": return dialed(ctx, form, query, wire);
    case "menu": return menuStep(ctx, form, query, wire);
    case "voicemail-done": return reply([{ verb: "hangup" }]);
    case "voicemail": return keepAudio(ctx, connection, form, "voicemail");
    case "recording": return keepAudio(ctx, connection, form, "recording");
    case "status": return status(ctx, form, now);
    case "agent-done": return agentDone(ctx, form, query, wire);
    case "queue-wait": return queueWait(ctx, form, query, wire);
    case "queue-done": return queueDone(ctx, form, query, wire);
    case "queue-answer": return queueAnswer(ctx, form, query, wire);
    case "queue-connect": return queueConnect(ctx, form, query, now);
    case "softphone": return softphoneCall(db, ctx, form, wire);
    case "softphone-consent": return softphoneConsent(ctx, form, query, wire);
    case "softphone-dialed": return softphoneDialed(ctx, form, now);
    default: return empty;
  }
}

/** What every step after the first carries: the carrier, the seams, the step addresses and the clock. */
interface Wire {
  connection: VoiceConnection;
  deps: VoiceDeps;
  url: StepUrl;
  now: Date;
}

const count = (value: string | null, max: number): number => {
  const parsed = Number(value ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : 0;
};

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

type CallRow = typeof schema.call.$inferSelect;
type NumberRow = typeof schema.phoneNumber.$inferSelect;

/**
 * Where the call goes now, from core's router, with the hours the company
 * keeps online: the number's phone menu when it has one, otherwise the
 * forward it has always had.
 */
async function routeOf(tx: Database, organizationId: string, number: NumberRow, knownCustomer: boolean, now: Date) {
  const rows = await tx.select().from(schema.businessHours);
  const hours = voice.businessHoursFrom(rows, await timezoneOf(tx, organizationId));
  if (number.menuId) {
    const menu = await phoneMenus.loadMenu(tx, organizationId, number.menuId);
    if (menu) {
      const directory = await phoneMenus.directoryFor(tx, organizationId);
      return voice.routeToMenu({
        menu, dialled: number.e164, hours, knownCustomer, now, describe: voice.describeIn(directory),
      });
    }
  }
  return voice.routeCall({ number, dialled: number.e164, hours, knownCustomer, now });
}

const voicemailVerbs = (url: StepUrl): voice.Verb[] => [
  { verb: "say", text: voice.VOICEMAIL_PROMPT },
  { verb: "record", action: url("voicemail-done"), recordingCallback: url("voicemail"), maxSeconds: 120 },
  { verb: "hangup" },
];

/**
 * Add a sentence to "Where it went".
 *
 * The router's sentence says where the call was sent; what happened after
 * (nobody was on call, a member of the group had no number) is appended,
 * because the question the line answers ("why did this go to voicemail")
 * is usually answered by the second sentence, not the first.
 */
async function note(tx: Database, call: CallRow, sentence: string) {
  const routed = [call.routedBecause, sentence].filter(Boolean).join(" ").slice(0, 2000);
  call.routedBecause = routed;
  await tx.update(schema.call).set({ routedBecause: routed, updatedAt: new Date() })
    .where(eq(schema.call.id, call.id));
}

interface Answer {
  verbs: voice.Verb[];
  /** Whether the call ended at voicemail, which is when a missed call is announced. */
  voicemail: boolean;
}

interface Leg {
  tx: Database;
  ctx: ServiceContext;
  call: CallRow;
  number: NumberRow;
  url: StepUrl;
  now: Date;
  wire: Wire;
}

const legOf = (tx: Database, ctx: ServiceContext, call: CallRow, number: NumberRow, wire: Wire): Leg =>
  ({ tx, ctx, call, number, url: wire.url, now: wire.now, wire });

/**
 * Ring these numbers, with what the number is set to do on every dial: the
 * whisper, and recording only when the recording check already said yes for
 * this call. Read off the call row rather than passed in, so a dial three
 * destinations down a menu records exactly when the first one would have.
 */
function dialVerb(leg: Leg, numbers: readonly string[], timeoutSeconds: number, query: Record<string, string | number>): voice.Verb {
  const recording = leg.call.recordingStartedAt !== null && leg.call.recordingDeletedAt === null;
  /**
   * A browser in the dial always has the whisper step, said or silent,
   * because that step is where the call learns which person picked up.
   */
  const browser = numbers.some(voice.isClientAddress);
  return {
    verb: "dial",
    to: numbers.length === 1 ? numbers[0]! : numbers,
    action: leg.url("dialed", query),
    timeoutSeconds,
    ...(leg.number.whisper || browser ? { whisperUrl: leg.url("whisper") } : {}),
    ...(recording ? { recordingCallback: leg.url("recording") } : {}),
  };
}

/** A menu, read and waited on. A key press and silence both come back to `menu`. */
function menuVerbs(leg: Leg, menu: voice.PhoneMenu, attempt: number, hops: number, say: string | null): voice.Verb[] {
  const query = { m: menu.id, t: attempt, ...(hops > 0 ? { h: hops } : {}) };
  return [
    ...(say ? [{ verb: "say" as const, text: say }] : []),
    {
      verb: "gather", action: leg.url("menu", query), numDigits: 1,
      timeoutSeconds: menu.timeoutSeconds, say: voice.menuPrompt(menu),
    },
    { verb: "redirect", url: leg.url("menu", query) },
  ];
}

/**
 * Send the call to one destination.
 *
 * Everything that can fail at call time (a person who has since lost their
 * number, nobody on the rota tonight, a group with nobody left to ring)
 * fails towards voicemail or the group's own fallback, with the reason
 * appended to "Where it went". Dead air is never an answer: a caller hearing
 * nothing concludes the number is disconnected.
 */
async function answer(leg: Leg, to: tel.RoutingDestination, hops: number): Promise<Answer> {
  const voicemail = (): Answer => ({ verbs: voicemailVerbs(leg.url), voicemail: true });
  const org = leg.ctx.actor.organizationId;
  if (hops > MAX_HOPS) {
    await note(leg.tx, leg.call, `It went through ${hops} destinations without anybody answering, so it went to voicemail.`);
    return voicemail();
  }
  const query: Record<string, number> = hops > 0 ? { h: hops } : {};

  switch (to.kind) {
    case "voicemail":
      return voicemail();

    case "queue": {
      const queue = await callQueues.loadQueue(leg.tx, org, to.id);
      if (!queue) {
        await note(leg.tx, leg.call, "The waiting line it was sent to has been deleted, so it went to voicemail.");
        return voicemail();
      }
      await leg.tx.update(schema.call).set({
        queueId: queue.id, queuedAt: leg.now, queueRungAt: null, queueRings: 0, queueResult: null, updatedAt: leg.now,
      }).where(eq(schema.call.id, leg.call.id));
      const q = { q: queue.id, ...query };
      return {
        verbs: [{
          verb: "enqueue", queue: voice.carrierQueueName(queue.id),
          waitUrl: leg.url("queue-wait", q), action: leg.url("queue-done", q),
        }],
        voicemail: false,
      };
    }

    case "agent": {
      const begun = await voiceAgent.begin(leg.tx, org, leg.call, {
        webhookToken: leg.wire.connection.token,
        actionUrl: leg.url("agent-done", hops > 0 ? { h: hops } : {}),
        relayBase: relayBaseOf(leg.wire.deps),
      });
      if (!begun.ok) {
        await note(leg.tx, leg.call, begun.why);
        return answer(leg, begun.to, hops + 1);
      }
      await note(leg.tx, leg.call, "The phone assistant answered.");
      return { verbs: [begun.verb], voicemail: false };
    }

    case "forward":
      return { verbs: [dialVerb(leg, [to.e164], 20, query)], voicemail: false };

    case "ivr": {
      const menu = await phoneMenus.loadMenu(leg.tx, org, to.menu);
      if (!menu) {
        await note(leg.tx, leg.call, "The menu it was sent to has been deleted, so it went to voicemail.");
        return voicemail();
      }
      return { verbs: menuVerbs(leg, menu, 1, hops, null), voicemail: false };
    }

    case "person": {
      const directory = await phoneMenus.directoryFor(leg.tx, org);
      const person = directory.people.get(to.userId);
      if (!person?.phone) {
        await note(leg.tx, leg.call, `${person?.name ?? "The person it was sent to"} has no number to ring, so it went to voicemail.`);
        return voicemail();
      }
      return { verbs: [dialVerb(leg, [person.phone], 20, query)], voicemail: false };
    }

    case "on_call_rota": {
      const shift = await onCall.coveringAt(leg.tx, org, leg.now, to.id === voice.COMPANY_ROTA ? null : to.id);
      if (!shift) {
        await note(leg.tx, leg.call, "Nobody was on call, so it went to voicemail.");
        return voicemail();
      }
      const [member] = await leg.tx.select({ userId: schema.membership.userId })
        .from(schema.technician)
        .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
        .where(eq(schema.technician.id, shift.technicianId)).limit(1);
      const directory = await phoneMenus.directoryFor(leg.tx, org);
      const phone = member ? directory.people.get(member.userId)?.phone : null;
      if (!phone) {
        await note(leg.tx, leg.call, `${shift.technicianName} was on call and has no number to ring, so it went to voicemail.`);
        return voicemail();
      }
      await note(leg.tx, leg.call, `${shift.technicianName} was on call.`);
      return { verbs: [dialVerb(leg, [phone], 25, query)], voicemail: false };
    }

    case "ring_group": {
      const group = await phoneMenus.loadRingGroup(leg.tx, org, to.id);
      if (!group) {
        await note(leg.tx, leg.call, "The ring group it was sent to has been deleted, so it went to voicemail.");
        return voicemail();
      }
      const online = await softphone.onlineUsers(leg.tx, org, leg.now);
      const plan = voice.ringPlan(group, await phoneMenus.directoryFor(leg.tx, org), online);
      if (plan.skipped.length > 0) {
        await note(leg.tx, leg.call, `Not rung: ${plan.skipped.map((s) => `${s.label} ${s.why}`).join("; ")}.`);
      }
      if (plan.steps.length === 0) {
        await note(leg.tx, leg.call, `Nobody in the ${group.name} ring group could be rung.`);
        return answer(leg, group.noAnswerTo, hops + 1);
      }
      return {
        verbs: [dialVerb(leg, plan.steps[0]!.numbers, group.ringSeconds, { g: group.id, i: 0, ...query })],
        voicemail: false,
      };
    }

    default:
      return voicemail();
  }
}

/**
 * Past the recording question, or straight away for a number that does not
 * ask it: route, and answer.
 */
async function proceed(leg: Leg): Promise<VoiceReply> {
  const routed = await routeOf(leg.tx, leg.ctx.actor.organizationId, leg.number, Boolean(leg.call.customerId), leg.now);
  const answered = await answer(leg, routed.destination, 0);
  return reply(answered.verbs);
}

async function incoming(
  db: Database, ctx: ServiceContext, form: Record<string, string>, wire: Wire,
): Promise<VoiceReply> {
  const { url, now } = wire;
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
    if (!call) return reply([{ verb: "hangup" }]);
    const routed = await routeOf(tx, org, found.number, Boolean(call.customerId), now);
    await tx.update(schema.call).set({
      ...(recorded.duplicate ? {} : { status: "ringing" as const }),
      routedBecause: routed.why,
      updatedAt: now,
    }).where(eq(schema.call.id, recorded.callId));
    call.routedBecause = routed.why;

    /** Nobody to ask on the way to a voicemail box: the caller is not put through to anybody. */
    if (routed.destination.kind === "voicemail") return reply(voicemailVerbs(url));
    if (found.number.recordCalls) {
      /**
       * The question, then a redirect for the caller who answers it with
       * silence. Both reach `connect`: with Digits=1 the caller agreed, and
       * without it they did not. Asked once, before any menu, so a caller
       * passed between three destinations is asked one question, and every
       * dial after it records or does not by the same answer.
       */
      return reply([
        { verb: "gather", action: url("connect"), numDigits: 1, timeoutSeconds: 6, say: voice.RECORDING_QUESTION },
        { verb: "redirect", url: url("connect") },
      ]);
    }
    const answered = await answer(legOf(tx, ctx, call, found.number, wire), routed.destination, 0);
    return reply(answered.verbs);
  });
}

async function connect(
  ctx: ServiceContext, form: Record<string, string>, wire: Wire,
): Promise<VoiceReply> {
  return inTenant(ctx, async (tx) => {
    const call = await callBySid(tx, form["CallSid"]);
    if (!call) return reply([{ verb: "hangup" }]);
    const number = await numberOf(tx, call);
    if (!number) return reply([{ verb: "say", text: voice.NOT_IN_SERVICE }, { verb: "hangup" }]);

    if (number.recordCalls) {
      const asked = voice.recordingDecision({
        callerPressedOne: form["Digits"] === "1",
        policies: await telephony.policies(tx, ctx.actor.organizationId),
      });
      try {
        await telephony.decideRecordingIn(tx, ctx, {
          callId: call.id, parties: asked.parties, announcementPlayed: true,
        });
      } catch (error) {
        /** A recording deleted on this call already: connect, and record nothing. */
        if (!(error instanceof ConflictError)) throw error;
      }
    }
    /** Read again, so the dial sees the decision just written. */
    const [decided] = await tx.select().from(schema.call).where(eq(schema.call.id, call.id)).limit(1);
    return proceed(legOf(tx, ctx, decided ?? call, number, wire));
  });
}

/**
 * A key pressed in a phone menu, or none.
 *
 * What was pressed is written on the call in order, so the call screen can
 * say "Pressed 2 for Billing" above "Where it went", and the person who
 * answers is told it by the whisper.
 */
async function menuStep(
  ctx: ServiceContext, form: Record<string, string>, query: URLSearchParams, wire: Wire,
): Promise<VoiceReply> {
  const { url, now } = wire;
  return inTenant(ctx, async (tx) => {
    const call = await callBySid(tx, form["CallSid"]);
    if (!call) return reply([{ verb: "hangup" }]);
    const number = await numberOf(tx, call);
    if (!number) return reply([{ verb: "say", text: voice.NOT_IN_SERVICE }, { verb: "hangup" }]);
    const leg = legOf(tx, ctx, call, number, wire);
    const hops = count(query.get("h"), MAX_HOPS + 1);
    const menu = await phoneMenus.loadMenu(tx, ctx.actor.organizationId, query.get("m") ?? "");
    if (!menu) {
      await note(tx, call, "The menu the caller was in has been deleted, so it went to voicemail.");
      return reply(voicemailVerbs(url));
    }

    const attempt = Math.max(1, count(query.get("t"), voice.MENU_ATTEMPTS));
    const choice = voice.chooseOption(menu, form["Digits"], attempt);
    if (choice.kind === "again") return reply(menuVerbs(leg, menu, choice.attempt, hops, choice.say));

    const pressed = choice.kind === "option" ? choice.option.key : (form["Digits"]?.trim() || null);
    const label = choice.kind === "option" ? choice.option.label : "No choice";
    const choices = [...(call.menuChoices ?? []), {
      menuId: menu.id, menu: menu.name, key: pressed, label, at: now.toISOString(),
    }].slice(-20);
    await tx.update(schema.call).set({ menuChoices: choices, updatedAt: now }).where(eq(schema.call.id, call.id));
    call.menuChoices = choices;
    if (choice.kind === "gave_up") await note(tx, call, choice.why);

    const answered = await answer(leg, choice.kind === "option" ? choice.option.to : choice.to, hops + 1);
    return reply(answered.verbs);
  });
}

async function whisper(ctx: ServiceContext, form: Record<string, string>): Promise<VoiceReply> {
  return inTenant(ctx, async (tx) => {
    const call = await callBySid(tx, form["ParentCallSid"] ?? form["CallSid"]);
    if (!call) return empty;
    /**
     * Who picked up: a browser by its identity, a phone by the number the
     * company rings that person on. Written here because this step is the
     * one that runs on the answering leg, before the two are connected.
     */
    const answeredBy = await whoAnswered(tx, ctx.actor.organizationId, form["To"] ?? "");
    if (answeredBy && !call.answeredByUserId) {
      await tx.update(schema.call).set({ answeredByUserId: answeredBy, updatedAt: new Date() })
        .where(eq(schema.call.id, call.id));
    }
    const number = await numberOf(tx, call);
    if (number && !number.whisper) return empty;
    const [channel] = call.channelId
      ? await tx.select({ name: schema.marketingChannel.name }).from(schema.marketingChannel)
        .where(eq(schema.marketingChannel.id, call.channelId)).limit(1)
      : [];
    const [campaign] = call.acquisitionCampaignId
      ? await tx.select({ name: schema.acquisitionCampaign.name }).from(schema.acquisitionCampaign)
        .where(eq(schema.acquisitionCampaign.id, call.acquisitionCampaignId)).limit(1)
      : [];
    const chosen = [...(call.menuChoices ?? [])].reverse().find((c) => c.key !== null);
    return reply([{
      verb: "say",
      text: voice.whisperText({
        channelName: channel?.name, campaignName: campaign?.name, recording: call.recordingStartedAt !== null,
        choice: chosen?.label ?? null,
      }),
    }]);
  });
}

/**
 * How a dial ended.
 *
 * Answered: the call is over when they hang up. Not answered: the next
 * person in a ring group that rings one after another, then the group's own
 * fallback, then voicemail; a missed call is announced only when the caller
 * ends up at voicemail, because a call the answering service picked up on
 * the group's behalf was not missed.
 */
async function dialed(
  ctx: ServiceContext, form: Record<string, string>, query: URLSearchParams, wire: Wire,
): Promise<VoiceReply> {
  const { url, now } = wire;
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

    const groupId = query.get("g");
    const number = groupId ? await numberOf(tx, call) : null;
    if (groupId && number) {
      const hops = count(query.get("h"), MAX_HOPS + 1);
      const leg = legOf(tx, ctx, call, number, wire);
      const group = await phoneMenus.loadRingGroup(tx, ctx.actor.organizationId, groupId);
      if (group) {
        const online = await softphone.onlineUsers(tx, ctx.actor.organizationId, now);
        const plan = voice.ringPlan(group, await phoneMenus.directoryFor(tx, ctx.actor.organizationId), online);
        const next = count(query.get("i"), voice.MAX_RING_MEMBERS) + 1;
        if (next < plan.steps.length) {
          return reply([dialVerb(leg, plan.steps[next]!.numbers, group.ringSeconds, {
            g: group.id, i: next, ...(hops > 0 ? { h: hops } : {}),
          })]);
        }
        await note(tx, call, `Nobody in the ${group.name} ring group picked up.`);
      }
      const answered = await answer(leg, group?.noAnswerTo ?? { kind: "voicemail", box: "main" }, hops + 1);
      if (answered.voicemail) await callTracking.emitMissed(tx, ctx, call.id);
      return reply(answered.verbs);
    }

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
    /**
     * A call the office placed is never a missed call: nobody rang the
     * company. Its own dial result says whether the person called picked up.
     */
    const unanswered = call.direction === "inbound" && call.answeredAt === null;
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
      await transcription.queueFor(tx, ctx.actor.organizationId, call.id, "voicemail");
      return true;
    }
    try {
      await telephony.attachRecordingIn(tx, ctx, call.id, `/marketing/calls/${call.id}/recording`, file.storageKey);
      await transcription.queueFor(tx, ctx.actor.organizationId, call.id, "recording");
      /** The event is also what brings the worker to this company, which is when the words are written out. */
      await emit(tx, ctx, { name: "call.recorded", entityType: "call", entityId: call.id, payload: { callId: call.id } });
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

/* ------------------------------------------------------ the phone assistant */

/**
 * Who picked up a leg: a browser by its identity, or a phone by the number the
 * company rings one person on. Null when it cannot be said for certain, such as
 * a number two people share or one outside the company.
 */
async function whoAnswered(tx: Database, organizationId: string, to: string): Promise<string | null> {
  const user = voice.userOfIdentity(to);
  if (user) return user;
  if (!/^\+[1-9]\d{7,14}$/.test(to)) return null;
  const rows = await tx.select({ userId: schema.answeringPhone.userId }).from(schema.answeringPhone)
    .where(and(eq(schema.answeringPhone.organizationId, organizationId), eq(schema.answeringPhone.e164, to))).limit(2);
  return rows.length === 1 ? rows[0]!.userId : null;
}

/**
 * The phone assistant's conversation is over. What the caller hears next, and
 * where they go, is what the assistant decided during the call: a goodbye, or
 * being put through. A conversation that never opened or broke off puts the
 * caller through too, with the reason written on the call.
 */
async function agentDone(
  ctx: ServiceContext, form: Record<string, string>, query: URLSearchParams, wire: Wire,
): Promise<VoiceReply> {
  return inTenant(ctx, async (tx) => {
    const call = await callBySid(tx, form["CallSid"]);
    if (!call) return reply([{ verb: "hangup" }]);
    /** The carrier says how the call stands; a caller who hung up mid conversation is not put through to anybody. */
    const gone = ["completed", "canceled", "busy", "failed", "no-answer"].includes(form["CallStatus"] ?? "");
    const after = await voiceAgent.afterRelay(tx, ctx, call, gone);
    const said: voice.Verb[] = after.say ? [{ verb: "say", text: after.say }] : [];
    if (after.then === "hang_up") return reply([...said, { verb: "hangup" }]);
    await note(tx, call, after.why);
    const number = await numberOf(tx, call);
    if (!number) return reply([...said, ...voicemailVerbs(wire.url)]);
    const hops = count(query.get("h"), MAX_HOPS + 1);
    const answered = await answer(legOf(tx, ctx, call, number, wire), after.to, hops + 1);
    if (answered.voicemail) await callTracking.emitMissed(tx, ctx, call.id);
    return reply([...said, ...answered.verbs]);
  });
}

/* ----------------------------------------------------------- waiting lines */

/**
 * Each time the hold music comes round: has the caller waited long enough,
 * what are they told about their place, and is it time to ring the group
 * again.
 *
 * The group is rung by placing calls from the company's own account to each
 * phone or browser in this round, each answered by `queue-answer`. They are
 * placed after the transaction commits, so a slow carrier holds no
 * connection, and a failure to ring one phone is written on the call rather
 * than keeping the caller from their music.
 */
async function queueWait(
  ctx: ServiceContext, form: Record<string, string>, query: URLSearchParams, wire: Wire,
): Promise<VoiceReply> {
  const org = ctx.actor.organizationId;
  const queueId = query.get("q") ?? "";
  const plan = await inTenant(ctx, async (tx) => {
    const call = await callBySid(tx, form["CallSid"]);
    if (!call) return { verbs: [{ verb: "leave" }] as voice.Verb[], ring: null };
    const queue = await callQueues.loadQueue(tx, org, queueId);
    if (!queue || call.queueId !== queue.id) return { verbs: [{ verb: "leave" }] as voice.Verb[], ring: null };
    const group = await phoneMenus.loadRingGroup(tx, org, queue.ringGroupId);
    const position = Number(form["QueuePosition"]);
    const step = voice.waitStep({
      queue, position: Number.isInteger(position) && position > 0 ? position : 1,
      waitedSeconds: Number(form["QueueTime"]), rungAt: call.queueRungAt, ringSeconds: group?.ringSeconds ?? 20,
      now: wire.now,
    });
    if (step.kind === "leave") return { verbs: [{ verb: "leave" }] as voice.Verb[], ring: null };

    let ring: { numbers: string[]; from: string; timeoutSeconds: number; callId: string } | null = null;
    if (step.ring && group) {
      const online = await softphone.onlineUsers(tx, org, wire.now);
      const round = voice.ringRound(voice.ringPlan(group, await phoneMenus.directoryFor(tx, org), online), call.queueRings);
      const from = call.receivedOnE164 ?? (await numberOf(tx, call))?.e164 ?? null;
      if (round && from) {
        ring = { numbers: round.numbers, from, timeoutSeconds: group.ringSeconds, callId: call.id };
        await tx.update(schema.call).set({
          queueRungAt: wire.now, queueRings: call.queueRings + 1, updatedAt: wire.now,
        }).where(eq(schema.call.id, call.id));
      } else if (call.queueRings === 0 && call.queueRungAt === null) {
        await note(tx, call, `Nobody in the ${group.name} ring group could be rung for the ${queue.name} waiting line.`);
        await tx.update(schema.call).set({ queueRungAt: wire.now, updatedAt: wire.now }).where(eq(schema.call.id, call.id));
      }
    }
    return {
      verbs: [
        ...(step.say ? [{ verb: "say" as const, text: step.say }] : []),
        { verb: "play" as const, url: queue.holdMusicUrl ?? voice.DEFAULT_HOLD_MUSIC },
      ] as voice.Verb[],
      ring,
    };
  });

  if (plan.ring) {
    const failed: string[] = [];
    for (const to of plan.ring.numbers) {
      const placed = await wire.connection.provider.placeCall({
        to, from: plan.ring.from, url: wire.url("queue-answer", { q: queueId }), timeoutSeconds: plan.ring.timeoutSeconds,
      });
      if (!placed.ok) failed.push(`${voice.isClientAddress(to) ? "a browser" : to} (${placed.message})`);
    }
    if (failed.length > 0) {
      const callId = plan.ring.callId;
      await inTenant(ctx, async (tx) => {
        const [call] = await tx.select().from(schema.call).where(eq(schema.call.id, callId)).limit(1);
        if (call) await note(tx, call, `Could not ring ${failed.join(", ")} for the waiting line.`);
      });
    }
  }
  return reply(plan.verbs);
}

/**
 * A person in the line's group picked up. Put them through to whoever is at
 * the front, or tell them somebody else already has the caller.
 */
async function queueAnswer(
  ctx: ServiceContext, form: Record<string, string>, query: URLSearchParams, wire: Wire,
): Promise<VoiceReply> {
  const org = ctx.actor.organizationId;
  return inTenant(ctx, async (tx) => {
    const queue = await callQueues.loadQueue(tx, org, query.get("q") ?? "");
    if (!queue) return reply([{ verb: "say", text: "That waiting line no longer exists." }, { verb: "hangup" }]);
    /**
     * Still waiting: in this line and not yet taken off hold. Read off the
     * line's own result rather than whether the call was ever answered,
     * because a caller the phone assistant spoke to first was answered
     * before they ever joined the line.
     */
    const [waiting] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.call).where(and(
      eq(schema.call.queueId, queue.id),
      isNull(schema.call.queueResult),
      sql`${schema.call.queuedAt} is not null`,
    ));
    if (!waiting || waiting.n === 0) {
      return reply([{ verb: "say", text: "Thanks. The caller has already been answered." }, { verb: "hangup" }]);
    }
    const user = await whoAnswered(tx, org, form["To"] ?? "");
    return reply([
      { verb: "say", text: `A ${queue.name} caller is waiting. Putting you through.` },
      { verb: "dialQueue", queue: voice.carrierQueueName(queue.id), url: wire.url("queue-connect", { q: queue.id, ...(user ? { u: user } : {}) }) },
    ]);
  });
}

/** Said on the caller's side as they are taken off hold: the moment they were answered, and by whom. */
async function queueConnect(
  ctx: ServiceContext, form: Record<string, string>, query: URLSearchParams, now: Date,
): Promise<VoiceReply> {
  return inTenant(ctx, async (tx) => {
    const call = await callBySid(tx, form["CallSid"]);
    if (!call) return empty;
    const user = query.get("u");
    await tx.update(schema.call).set({
      status: voice.laterStatus(call.status, "in_progress"),
      answeredAt: call.answeredAt ?? now,
      /** Off hold: the carrier's own word for how they left the line follows when the call ends. */
      queueResult: "bridged",
      ...(user && /^[0-9a-f-]{36}$/i.test(user) && !call.answeredByUserId ? { answeredByUserId: user } : {}),
      updatedAt: now,
    }).where(eq(schema.call.id, call.id));
    return empty;
  });
}

/**
 * The caller left the line: answered, gave up, or waited as long as the line
 * keeps anybody and goes where it overflows to, usually voicemail.
 */
async function queueDone(
  ctx: ServiceContext, form: Record<string, string>, query: URLSearchParams, wire: Wire,
): Promise<VoiceReply> {
  return inTenant(ctx, async (tx) => {
    const call = await callBySid(tx, form["CallSid"]);
    if (!call) return reply([{ verb: "hangup" }]);
    const queue = await callQueues.loadQueue(tx, ctx.actor.organizationId, query.get("q") ?? "");
    const waited = Number(form["QueueTime"]);
    const outcome = voice.queueOutcome(form["QueueResult"], Number.isFinite(waited) ? waited : 0);
    await tx.update(schema.call).set({
      queueResult: (form["QueueResult"] ?? "unknown").slice(0, 40), updatedAt: wire.now,
    }).where(eq(schema.call.id, call.id));
    if (outcome.kind === "answered") return reply([{ verb: "hangup" }]);
    if (outcome.kind === "gone") {
      await note(tx, call, outcome.why);
      await tx.update(schema.call).set({ status: voice.laterStatus(call.status, "abandoned"), updatedAt: wire.now })
        .where(eq(schema.call.id, call.id));
      await callTracking.emitMissed(tx, ctx, call.id);
      return reply([{ verb: "hangup" }]);
    }
    await note(tx, call, queue ? outcome.why : "The waiting line was deleted while the caller waited, so it went to voicemail.");
    const number = await numberOf(tx, call);
    if (!number) return reply(voicemailVerbs(wire.url));
    const hops = count(query.get("h"), MAX_HOPS + 1);
    const answered = await answer(legOf(tx, ctx, call, number, wire), queue?.overflowTo ?? { kind: "voicemail", box: "main" }, hops + 1);
    if (answered.voicemail) await callTracking.emitMissed(tx, ctx, call.id);
    return reply(answered.verbs);
  });
}

/* --------------------------------------------------------- the browser phone */

/**
 * Somebody pressed Call in the office app. The carrier asks here what to do,
 * naming the person's browser and the number they typed.
 *
 * Checked again here, whatever the pass said an hour ago: the person is still
 * an active member who may place calls, the number is one a phone can dial
 * and not an emergency number, and browser calling is still set up. Then the
 * call is logged the way every call is, matched to a customer by the number,
 * and dialled from the company's number. On a number set to record calls the
 * person called is asked first, as a caller is asked on the way in, and
 * recording starts only on their yes.
 */
async function softphoneCall(
  db: Database, ctx: ServiceContext, form: Record<string, string>, wire: Wire,
): Promise<VoiceReply> {
  const org = ctx.actor.organizationId;
  const sid = form["CallSid"];
  const userId = voice.userOfIdentity(form["From"] ?? form["Caller"] ?? "");
  const refuse = (text: string) => reply([{ verb: "say", text }, { verb: "hangup" }]);
  if (!sid || !userId) return refuse("This call cannot be placed.");
  const target = voice.dialable(form["To"] ?? "");
  if (!target.ok) return refuse(target.reason);

  return inTenant(ctx, async (tx) => {
    const actor = await memberActor(tx, org, userId);
    if (!actor || !can(actor, "call:place")) return refuse("You are not allowed to place calls from the browser.");
    const number = await softphone.callerIdFor(tx, org);
    if (!number) return refuse("Browser calling is not set up. Ask an owner to set it up on Settings, Phone menus.");

    const digits = target.e164.replace(/\D/g, "").slice(-10);
    const [customer] = await tx.select({ id: schema.customer.id }).from(schema.customer).where(and(
      isNull(schema.customer.deletedAt),
      sql`right(regexp_replace(coalesce(${schema.customer.phone}, ''), '[^0-9]', '', 'g'), 10) = ${digits}`,
    )).limit(1);
    const inserted = await tx.insert(schema.call).values({
      organizationId: org, direction: "outbound", phoneNumberId: number.id,
      fromE164: number.e164, toE164: target.e164, customerId: customer?.id ?? null,
      placedByUserId: userId, status: "ringing", startedAt: wire.now, providerCallId: `twilio:${sid}`,
    }).onConflictDoNothing().returning();
    const call = inserted[0] ?? await callBySid(tx, sid);
    if (!call) return refuse("This call cannot be placed.");
    if (inserted[0]) {
      await audit(tx, { ...ctx, actor }, "call.placed", "call", call.id, null, { to: target.e164, from: number.e164 });
    }
    return reply([{
      verb: "dial", to: target.e164, action: wire.url("softphone-dialed"), timeoutSeconds: 30, callerId: number.e164,
      ...(number.recordCalls ? { whisperUrl: wire.url("softphone-consent", { c: call.id, a: "ask" }) } : {}),
    }]);
  });
}

/**
 * On a call the office placed, said to the person called when they pick up:
 * may it be recorded. `ask` puts the question; `answer` is their key press.
 * Anything but 1, including nothing, connects them without recording.
 */
async function softphoneConsent(
  ctx: ServiceContext, form: Record<string, string>, query: URLSearchParams, wire: Wire,
): Promise<VoiceReply> {
  const org = ctx.actor.organizationId;
  const callId = query.get("c") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(callId)) return empty;
  const decided = await inTenant(ctx, async (tx) => {
    const [call] = await tx.select().from(schema.call)
      .where(and(eq(schema.call.organizationId, org), eq(schema.call.id, callId))).limit(1);
    if (!call || call.direction !== "outbound") return { verbs: [] as voice.Verb[], record: null };
    if (query.get("a") === "ask") {
      const [company] = await tx.select({ name: schema.organization.name }).from(schema.organization)
        .where(eq(schema.organization.id, org)).limit(1);
      return {
        verbs: [{
          verb: "gather" as const, action: wire.url("softphone-consent", { c: call.id, a: "answer" }), numDigits: 1,
          timeoutSeconds: 6, say: voice.calleeRecordingQuestion(company?.name ?? "We are"),
        }] as voice.Verb[],
        record: null,
      };
    }
    const asked = voice.recordingDecision({
      callerPressedOne: form["Digits"] === "1", policies: await telephony.policies(tx, org), outside: "callee",
    });
    try {
      await telephony.decideRecordingIn(tx, ctx, { callId: call.id, parties: asked.parties, announcementPlayed: true });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      return { verbs: [] as voice.Verb[], record: null };
    }
    const parent = call.providerCallId?.replace(/^twilio:/, "") ?? null;
    return { verbs: [] as voice.Verb[], record: asked.decision.ok && parent ? parent : null };
  });
  if (decided.record) {
    const started = await wire.connection.provider.startRecording({ callSid: decided.record, recordingCallback: wire.url("recording") });
    if (!started.ok) {
      await inTenant(ctx, (tx) => audit(tx, ctx, "call.recording_not_started", "call", callId, null, { reason: started.message }));
    }
  }
  return reply(decided.verbs);
}

/** How a call placed from the browser ended: whether the person called picked up, and for how long. */
async function softphoneDialed(ctx: ServiceContext, form: Record<string, string>, now: Date): Promise<VoiceReply> {
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
      ...(Number.isFinite(talked) && talked > 0 ? { durationSeconds: talked } : {}),
      updatedAt: now,
    }).where(eq(schema.call.id, call.id));
    return reply([{ verb: "hangup" }]);
  });
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
        /**
         * A recording somebody put a hold on stays, whatever its age: the
         * same holds the retention purge honours, so a call that is evidence
         * in a dispute is kept by both.
         */
        sql`not exists (
          select 1 from public.retention_hold h
          where h.entity_type = 'call_recording' and h.entity_id = ${schema.call.id} and h.released_at is null
        )`,
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
  menuId?: string | null | undefined;
}) => ({
  ...(input.menuId !== undefined ? { menuId: input.menuId } : {}),
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
    afterHoursForwardsToE164?: string | null | undefined; menuId?: string | null | undefined;
  }) => phoneNumbers.update(ctx, { id: input.id, ...voiceSettings(input) }),

  answerNumberHere: (ctx: ServiceContext, input: { id: string }) => answerHere(ctx, input),
  stopAnsweringNumber: (ctx: ServiceContext, input: { id: string }) => stopAnswering(ctx, input),
} as const;
