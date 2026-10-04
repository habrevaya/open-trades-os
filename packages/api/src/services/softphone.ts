import { and, eq, gt, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { voice } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { baseOf, carrierFor, DEFAULT_DEPS, voiceWebhookPath, type VoiceDeps } from "./voice-carrier";
import { voiceAccessToken } from "../voice/access-token";
import { readerFor } from "../secrets/store";

/**
 * THE BROWSER PHONE
 *
 * Somebody in the office rings a customer from the office app, with the
 * company's number showing, and answers the company's calls there when they
 * are in a ring group and have "Take calls here" on. The carrier's browser
 * library does the audio; this file is what lets it: the one time setup on
 * the company's Twilio account, the short lived pass each browser registers
 * with, and the heartbeat that says a browser is there to ring.
 *
 * WHAT IS NEEDED ON THE ACCOUNT. An API key, made in the Twilio console, its
 * SID typed on the settings screen and its secret put in this deployment's
 * secret store under a name the screen is given, the way every other
 * credential here works. The application calls are placed through is made by
 * this product on the company's account, pointed at its own webhook.
 *
 * WHO MAY. `call:place`, held by the office roles and not by technicians, who
 * text from the field and ring from their own phones. The pass carries the
 * person's identity and nothing else; every call it places comes back to the
 * webhook, which checks again that the person is still a member who may.
 */

export interface SoftphoneSettings {
  apiKeySid: string;
  /** The NAME of the secret holding the API key's secret, never the secret. */
  apiKeySecretRef: string;
  applicationSid: string;
  /** The company number calls are placed from, shown to the person called. */
  callerIdNumberId: string;
}

export function softphoneSettings(settings: Record<string, unknown>): SoftphoneSettings | null {
  const raw = settings["softphone"];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = (key: string) => (typeof r[key] === "string" && r[key] !== "" ? r[key] as string : null);
  const apiKeySid = text("apiKeySid");
  const apiKeySecretRef = text("apiKeySecretRef");
  const applicationSid = text("applicationSid");
  const callerIdNumberId = text("callerIdNumberId");
  if (!apiKeySid || !apiKeySecretRef || !applicationSid || !callerIdNumberId) return null;
  return { apiKeySid, apiKeySecretRef, applicationSid, callerIdNumberId };
}

/** The company number a browser call shows, when it is still one the company holds and answers here. */
export async function callerIdNumber(tx: Database, organizationId: string, settings: SoftphoneSettings) {
  const [number] = await tx.select().from(schema.phoneNumber)
    .where(and(
      eq(schema.phoneNumber.organizationId, organizationId),
      eq(schema.phoneNumber.id, settings.callerIdNumberId),
      isNull(schema.phoneNumber.releasedAt),
    )).limit(1);
  return number && number.providerNumberId ? number : null;
}

export interface SetupInput {
  apiKeySid: string;
  apiKeySecretRef: string;
  callerIdNumberId: string;
}

/**
 * Turn browser calling on, or change it.
 *
 * Everything this product can refuse is checked before the carrier is asked:
 * a key SID in the wrong form, a secret name that holds nothing here, a
 * number the company does not answer here (the carrier only shows a number
 * on a call when it is on the same account). Then the application is made, or
 * pointed again, on the company's own account.
 */
export async function setup(ctx: ServiceContext, input: SetupInput, deps: VoiceDeps = DEFAULT_DEPS) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const apiKeySid = input.apiKeySid.trim();
    if (!/^SK[0-9a-fA-F]{32}$/.test(apiKeySid)) {
      throw new ConflictError("An API key SID starts with SK and is followed by 32 letters and digits. It is on the key's page in the Twilio console.");
    }
    const ref = input.apiKeySecretRef.trim();
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(ref)) {
      throw new ConflictError("Name the secret in capitals, like TWILIO_API_KEY_SECRET: the name it is stored under, never the secret itself.");
    }
    try {
      await (deps.readSecret ?? readerFor(tx, ctx.actor.organizationId))(ref);
    } catch {
      throw new ConflictError(`Nothing is stored under ${ref} in this company's secrets yet. Add the API key's secret there first (Settings, Integrations shows where).`);
    }
    const [number] = await tx.select().from(schema.phoneNumber)
      .where(and(
        eq(schema.phoneNumber.organizationId, ctx.actor.organizationId),
        eq(schema.phoneNumber.id, input.callerIdNumberId),
        isNull(schema.phoneNumber.releasedAt),
      )).limit(1);
    if (!number) throw new NotFoundError("Phone number");
    if (!number.providerNumberId) {
      throw new ConflictError(
        `${number.e164} is not answered here, so the phone company would not show it on a call. Answer it here on Settings, Phone menus first, or choose another.`,
      );
    }

    const carrier = await carrierFor(tx, ctx.actor.organizationId, deps);
    const before = softphoneSettings(carrier.settings);
    const base = baseOf(deps);
    const saved = await carrier.provider.saveApplication({
      applicationSid: before?.applicationSid ?? null,
      label: "OpenTradesOS browser phone",
      voiceUrl: `${base}${voiceWebhookPath(carrier.token, "softphone")}`,
      statusUrl: `${base}${voiceWebhookPath(carrier.token, "status")}`,
    });
    if (!saved.ok) throw new ConflictError(`Twilio would not set up browser calling: ${saved.message}`);

    const softphone: SoftphoneSettings = {
      apiKeySid, apiKeySecretRef: ref, applicationSid: saved.applicationSid, callerIdNumberId: number.id,
    };
    await tx.update(schema.integrationConnection).set({
      settings: { ...carrier.settings, softphone },
      updatedAt: new Date(),
    }).where(eq(schema.integrationConnection.id, carrier.connectionId));
    await audit(tx, ctx, "softphone.set_up", "integration_connection", carrier.connectionId,
      before ? { ...before } : null, { ...softphone });
    return { ready: true as const, applicationSid: saved.applicationSid, callerId: number.e164 };
  });
}

async function messagingConnection(tx: Database, organizationId: string) {
  const [row] = await tx.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.capability, "messaging"),
      eq(schema.integrationConnection.provider, "twilio"),
      eq(schema.integrationConnection.status, "connected"),
      isNull(schema.integrationConnection.deletedAt),
    )).limit(1);
  return row ?? null;
}

export interface SoftphoneStatus {
  ready: boolean;
  /** Why it is not, in words, when it is not. */
  reason: string | null;
  callerId: string | null;
  /** Whether this person's browser is taking calls right now. */
  takingCalls: boolean;
}

/** Whether this person can use the browser phone, and whether they are taking calls in it. */
export async function status(ctx: ServiceContext): Promise<SoftphoneStatus> {
  return guardedRead(ctx, "call:place", async (tx) => {
    const row = await messagingConnection(tx, ctx.actor.organizationId);
    const settings = row ? softphoneSettings((row.settings ?? {}) as Record<string, unknown>) : null;
    const number = settings ? await callerIdNumber(tx, ctx.actor.organizationId, settings) : null;
    const [presence] = await tx.select().from(schema.softphonePresence)
      .where(and(
        eq(schema.softphonePresence.organizationId, ctx.actor.organizationId),
        eq(schema.softphonePresence.userId, ctx.actor.userId),
      )).limit(1);
    const reason = !row
      ? "Twilio is not connected. An owner connects it under Settings, Integrations."
      : !settings
        ? "Browser calling is not set up. An owner sets it up on Settings, Phone menus."
        : !number
          ? "The number calls are placed from is no longer answered here. An owner chooses another on Settings, Phone menus."
          : null;
    return {
      ready: reason === null,
      reason,
      callerId: number?.e164 ?? null,
      takingCalls: presence ? voice.isOnline(presence.lastSeenAt, presence.available, new Date()) : false,
    };
  });
}

/**
 * A pass for this person's browser, good for an hour.
 *
 * Minted for the person asking and nobody else, and only while browser
 * calling is set up. It lets the browser register to be rung and place calls
 * through the company's application; it is not a key to the account, and
 * what each call may do is decided again by the webhook when the call is made.
 */
export async function token(ctx: ServiceContext, deps: VoiceDeps = DEFAULT_DEPS, now: Date = new Date()) {
  return guardedRead(ctx, "call:place", async (tx) => {
    const row = await messagingConnection(tx, ctx.actor.organizationId);
    const connection = (row?.settings ?? {}) as Record<string, unknown>;
    const settings = row ? softphoneSettings(connection) : null;
    if (!row || !settings) {
      throw new ConflictError("Browser calling is not set up. An owner sets it up on Settings, Phone menus.");
    }
    if (!(await callerIdNumber(tx, ctx.actor.organizationId, settings))) {
      throw new ConflictError("The number calls are placed from is no longer answered here. An owner chooses another on Settings, Phone menus.");
    }
    const accountSid = typeof connection["accountSid"] === "string" ? connection["accountSid"] : "";
    // The company's own secret, never a variable with the bare name.
    const secret = await (deps.readSecret ?? readerFor(tx, ctx.actor.organizationId))(settings.apiKeySecretRef);
    const identity = voice.softphoneIdentity(ctx.actor.userId);
    const minted = voiceAccessToken({
      accountSid, apiKeySid: settings.apiKeySid, apiKeySecret: secret, identity,
      applicationSid: settings.applicationSid, incoming: true, ttlSeconds: 3600, now,
    });
    return { token: minted.token, identity, expiresAt: minted.expiresAt.toISOString() };
  });
}

/**
 * "Take calls here", on or off, and the heartbeat while it is on.
 *
 * Written for the person asking only. Off is written too, rather than left to
 * go stale, so a person who turns it off at five stops being rung at five and
 * not two minutes later.
 */
export async function presence(ctx: ServiceContext, input: { available: boolean }, now: Date = new Date()) {
  return guardedWrite(ctx, "call:place", async (tx) => {
    await tx.insert(schema.softphonePresence).values({
      organizationId: ctx.actor.organizationId, userId: ctx.actor.userId, available: input.available, lastSeenAt: now,
    }).onConflictDoUpdate({
      target: [schema.softphonePresence.organizationId, schema.softphonePresence.userId],
      set: { available: input.available, lastSeenAt: now, updatedAt: now },
    });
    return { takingCalls: input.available };
  });
}

/**
 * The company number a call from the browser is placed from, read inside the
 * carrier's webhook. Null when browser calling is not set up, or the number
 * is no longer answered here.
 */
export async function callerIdFor(tx: Database, organizationId: string) {
  const row = await messagingConnection(tx, organizationId);
  const settings = row ? softphoneSettings((row.settings ?? {}) as Record<string, unknown>) : null;
  return settings ? callerIdNumber(tx, organizationId, settings) : null;
}

/**
 * The people whose browsers can be rung now, for a ring group's call.
 *
 * Read inside the carrier's webhook. Fresh heartbeats only, and only while
 * browser calling is still set up: a browser cannot register without its
 * pass, so a company that switched it off has nobody online.
 */
export async function onlineUsers(tx: Database, organizationId: string, now: Date): Promise<Set<string>> {
  const row = await messagingConnection(tx, organizationId);
  if (!row || !softphoneSettings((row.settings ?? {}) as Record<string, unknown>)) return new Set();
  const rows = await tx.select({ userId: schema.softphonePresence.userId }).from(schema.softphonePresence)
    .where(and(
      eq(schema.softphonePresence.organizationId, organizationId),
      eq(schema.softphonePresence.available, true),
      gt(schema.softphonePresence.lastSeenAt, new Date(now.getTime() - voice.PRESENCE_SECONDS * 1000)),
    ));
  return new Set(rows.map((r) => r.userId));
}

export const handlers = {
  getSoftphone: (ctx: ServiceContext) => status(ctx),
  setUpSoftphone: (ctx: ServiceContext, input: SetupInput) => setup(ctx, input),
  mintSoftphoneToken: (ctx: ServiceContext) => token(ctx),
  setSoftphonePresence: (ctx: ServiceContext, input: { available: boolean }) => presence(ctx, input),
} as const;
