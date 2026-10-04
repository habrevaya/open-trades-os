import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { emit } from "./events";
import * as telephony from "./telephony";
/**
 * The barrel rather than the seam, so the Whisper adapter is registered by
 * whatever reaches this service: the worker has no route of its own to
 * import it from.
 */
import {
  createTranscriptionProvider, TranscriptionNotConfiguredError, type TranscriptionProvider,
} from "../voice/index";

/**
 * WRITING OUT A CALL'S AUDIO
 *
 * A recording nobody has time to listen to is a recording nobody uses. The
 * office wants to search last month's calls for "water heater", and the
 * technician on a roof wants to read the voicemail rather than play it. So
 * every recording and voicemail this product keeps is handed to the
 * company's speech to text provider, and the words come back through the
 * same gate a transcript from anywhere else does: refused if malformed, card
 * numbers destroyed before the first write (`telephony.attachTranscriptIn`).
 *
 * ONLY AUDIO THIS PRODUCT KEPT. Which means only a recording the recording
 * check allowed, or a voicemail the caller chose to leave. Nothing here
 * reaches the carrier for audio of its own accord.
 *
 * IN THE BACKGROUND, NEVER IN THE CARRIER'S WEBHOOK. Transcribing a five
 * minute call takes longer than a carrier waits for an answer, and holding a
 * database transaction across it would hold a connection for as long as the
 * provider takes. The webhook marks the call `pending` in the same
 * transaction that keeps the audio; the worker claims it, sends the bytes
 * with no transaction open, and writes the words back in a new one. A
 * recording deleted while its words were on the way is checked for at that
 * moment, and the words are thrown away.
 *
 * A CLAIM, NOT A READ. `pending` becomes `working` by a conditional update,
 * so two workers cannot both pay to transcribe one call, and a worker that
 * dies mid way leaves a row visibly `working` that the next pass puts back
 * after a quarter of an hour.
 */

const WORKING_FOR_TOO_LONG_MS = 15 * 60 * 1000;
/** A provider that has failed this many times for one call is not going to succeed on the next pass. */
const MAX_ATTEMPTS = 5;

function transcriberActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "transcriber" };
}

export type ReadSecret = (ref: string) => Promise<string>;

export interface TranscriptionDeps {
  /** Injected so no test reaches a provider and no deployment fakes one. */
  provider?: TranscriptionProvider | undefined;
  readSecret?: ReadSecret | undefined;
}

const envSecret: ReadSecret = async (ref) => {
  const value = process.env[ref];
  if (!value) throw new Error(`No secret in the environment for "${ref}"`);
  return value;
};

async function connectionOf(tx: Database, organizationId: string) {
  const [row] = await tx.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.capability, "transcription"),
      eq(schema.integrationConnection.status, "connected"),
    ))
    .orderBy(asc(schema.integrationConnection.createdAt))
    .limit(1);
  return row ?? null;
}

/** Whether this company has a speech to text provider connected. */
export async function connected(tx: Database, organizationId: string): Promise<boolean> {
  return (await connectionOf(tx, organizationId)) !== null;
}

/**
 * Put a call's newly kept audio in line to be written out, inside the
 * transaction that kept it.
 *
 * A recording wins over a voicemail: a call that has both was answered and
 * recorded and then fell to voicemail on a second leg, and the conversation
 * is the part worth reading. Nothing is queued when no provider is
 * connected, so a company that never asked for transcripts never has calls
 * sitting in a queue that nothing will drain.
 */
export async function queueFor(
  tx: Database, organizationId: string, callId: string, source: "recording" | "voicemail",
): Promise<boolean> {
  if (!(await connected(tx, organizationId))) return false;
  const [call] = await tx.select().from(schema.call).where(eq(schema.call.id, callId)).limit(1);
  if (!call) return false;
  if (source === "voicemail" && call.transcriptSource === "recording" && call.transcriptStatus !== null) return false;
  await tx.update(schema.call).set({
    transcriptStatus: "pending",
    transcriptSource: source,
    transcriptError: null,
    transcriptAttempts: 0,
    updatedAt: new Date(),
  }).where(eq(schema.call.id, callId));
  return true;
}

async function providerFor(db: Database, organizationId: string, deps: TranscriptionDeps): Promise<TranscriptionProvider | null> {
  if (deps.provider) return deps.provider;
  const ctx: ServiceContext = { actor: transcriberActor(organizationId), db };
  const row = await inTenant(ctx, (tx) => connectionOf(tx, organizationId));
  if (!row) return null;
  const secret = row.credentialRef ? await (deps.readSecret ?? envSecret)(row.credentialRef) : "";
  return createTranscriptionProvider(row.provider, (row.settings ?? {}) as Record<string, unknown>, secret);
}

export interface PassOutcome {
  done: number;
  failed: number;
  retrying: number;
}

/**
 * Write out what is waiting, a few calls at a time.
 *
 * A few rather than all, because each one is a network request that can
 * take a minute, and one company's backlog of a thousand imported calls
 * must not hold the worker while every other company's texts wait.
 */
export async function transcribePending(
  db: Database, organizationId: string, deps: TranscriptionDeps = {}, limit = 5,
  only?: string | undefined,
): Promise<PassOutcome> {
  const ctx: ServiceContext = { actor: transcriberActor(organizationId), db };
  const outcome: PassOutcome = { done: 0, failed: 0, retrying: 0 };

  await inTenant(ctx, (tx) => tx.update(schema.call)
    .set({ transcriptStatus: "pending", updatedAt: new Date() })
    .where(and(
      eq(schema.call.transcriptStatus, "working"),
      lt(schema.call.updatedAt, new Date(Date.now() - WORKING_FOR_TOO_LONG_MS)),
    )));

  const waiting = await inTenant(ctx, (tx) => tx.select({ id: schema.call.id }).from(schema.call)
    .where(and(
      eq(schema.call.organizationId, organizationId),
      eq(schema.call.transcriptStatus, "pending"),
      only ? eq(schema.call.id, only) : undefined,
    ))
    .orderBy(asc(schema.call.updatedAt))
    .limit(limit));
  if (waiting.length === 0) return outcome;

  const provider = await providerFor(db, organizationId, deps).catch((error: unknown) => {
    if (error instanceof TranscriptionNotConfiguredError) return null;
    throw error;
  });
  /** Disconnected since the audio was queued: the calls wait, and go when one is connected again. */
  if (!provider) return outcome;

  for (const { id } of waiting) {
    const claimed = await inTenant(ctx, async (tx) => {
      const [row] = await tx.update(schema.call)
        .set({ transcriptStatus: "working", transcriptAttempts: sql`${schema.call.transcriptAttempts} + 1`, updatedAt: new Date() })
        .where(and(eq(schema.call.id, id), eq(schema.call.transcriptStatus, "pending")))
        .returning();
      if (!row) return null;
      const key = row.transcriptSource === "voicemail"
        ? row.voicemailStorageKey
        : row.recordingDeletedAt ? null : row.recordingStorageKey;
      if (!key) {
        await tx.update(schema.call).set({
          transcriptStatus: null, transcriptError: null, updatedAt: new Date(),
        }).where(eq(schema.call.id, id));
        return null;
      }
      const [file] = await tx.select().from(schema.storedFile)
        .where(and(eq(schema.storedFile.storageKey, key), isNull(schema.storedFile.deletedAt))).limit(1);
      return file ? { call: row, file } : null;
    });
    if (!claimed) continue;

    const source = claimed.call.transcriptSource === "voicemail" ? "voicemail" : "recording";
    const result = await provider.transcribe({
      bytes: new Uint8Array(claimed.file.bytes),
      contentType: claimed.file.contentType,
      fileName: `${source}.${claimed.file.contentType === "audio/wav" ? "wav" : "mp3"}`,
      speaker: source === "voicemail" ? "caller" : "call",
    });

    await inTenant(ctx, async (tx) => {
      const [now] = await tx.select().from(schema.call).where(eq(schema.call.id, id)).limit(1);
      /**
       * Deleted while the words were on the way. They are thrown away rather
       * than written, which would put back exactly what somebody deleted.
       */
      if (!now || now.transcriptStatus !== "working"
        || (source === "recording" && (now.recordingDeletedAt || !now.recordingStorageKey))) {
        if (now?.transcriptStatus === "working") {
          await tx.update(schema.call).set({ transcriptStatus: null, updatedAt: new Date() })
            .where(eq(schema.call.id, id));
        }
        return;
      }

      if (!result.ok) {
        const again = result.retryable && now.transcriptAttempts < MAX_ATTEMPTS;
        await tx.update(schema.call).set({
          transcriptStatus: again ? "pending" : "failed",
          transcriptError: result.message.slice(0, 500),
          updatedAt: new Date(),
        }).where(eq(schema.call.id, id));
        if (again) outcome.retrying += 1;
        else outcome.failed += 1;
        return;
      }

      try {
        await telephony.attachTranscriptIn(tx, ctx, { callId: id, segments: result.segments, source });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        /**
         * Refused by the gate: malformed output, or a call that may no longer
         * have a transcript. Written on the call in the gate's own words, so
         * the screen says why there is no transcript rather than nothing.
         */
        await tx.update(schema.call).set({
          transcriptStatus: "failed", transcriptError: error.message.slice(0, 500), updatedAt: new Date(),
        }).where(eq(schema.call.id, id));
        outcome.failed += 1;
        return;
      }
      await emit(tx, ctx, {
        name: "call.transcribed", entityType: "call", entityId: id,
        payload: { callId: id, source },
      });
      outcome.done += 1;
    });
  }
  return outcome;
}

/**
 * Write out one call's audio now, from the call screen.
 *
 * For a call whose transcript failed, or whose audio was kept before the
 * provider was connected. `message:send`, the permission that attaches a
 * transcript by hand: this is the same act, done by the provider.
 */
export async function transcribeNow(ctx: ServiceContext, callId: string, deps: TranscriptionDeps = {}) {
  const queued = await guardedWrite(ctx, "message:send", async (tx) => {
    const [call] = await tx.select().from(schema.call)
      .where(and(eq(schema.call.organizationId, ctx.actor.organizationId), eq(schema.call.id, callId))).limit(1);
    if (!call) throw new NotFoundError("Call");
    if (call.transcriptStatus === "pending" || call.transcriptStatus === "working") return true;
    const source = call.recordingStorageKey && !call.recordingDeletedAt
      ? "recording" as const
      : call.voicemailStorageKey ? "voicemail" as const : null;
    if (!source) {
      throw new ConflictError("There is no recording or voicemail kept for this call, so there is nothing to write out.");
    }
    if (!deps.provider && !(await connected(tx, ctx.actor.organizationId))) {
      throw new ConflictError("No speech to text is connected. Connect one under Settings, Integrations first.");
    }
    if (deps.provider) {
      await tx.update(schema.call).set({
        transcriptStatus: "pending", transcriptSource: source, transcriptError: null, transcriptAttempts: 0,
        updatedAt: new Date(),
      }).where(eq(schema.call.id, call.id));
      return true;
    }
    return queueFor(tx, ctx.actor.organizationId, call.id, source);
  });
  if (queued) await transcribePending(ctx.db, ctx.actor.organizationId, deps, 1, callId);
  return guardedWrite(ctx, "message:send", async (tx) => {
    const [call] = await tx.select({
      id: schema.call.id, transcriptStatus: schema.call.transcriptStatus, transcriptError: schema.call.transcriptError,
    }).from(schema.call).where(eq(schema.call.id, callId)).limit(1);
    return { id: callId, status: call?.transcriptStatus ?? null, error: call?.transcriptError ?? null };
  });
}

/** Whether calls are being written out, for the settings screen. */
export async function status(ctx: ServiceContext) {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const row = await connectionOf(tx, ctx.actor.organizationId);
    return { connected: row !== null, provider: row?.provider ?? null };
  });
}

export const handlers = {
  transcribeCall: (ctx: ServiceContext, input: { id: string }) => transcribeNow(ctx, input.id),
} as const;
