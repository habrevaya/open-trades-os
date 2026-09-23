import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { telephony, transcript as tr } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, NotFoundError, ConflictError,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * CALLS, RECORDING PERMISSION, AND WHAT A TRANSCRIPT IS ALLOWED TO CONTAIN
 *
 * `packages/core/src/telephony` and `packages/core/src/transcript` between
 * them decide whether a call may be recorded and destroy the card numbers
 * people read aloud on the phone. Both were complete, both were exported
 * from the barrel, and neither had a single production caller. The `call`
 * table was in the same state: a column named `recording_consent` under a
 * comment promising that "an operator answering a question about a 2024 call
 * needs to know what the system did then", written by nothing, on a table
 * nothing inserted into.
 *
 * That combination is worse than an absent feature. A schema that carries
 * `recording_consent` and `recording_deleted_at` reads, to anybody reviewing
 * it, as a system that gates recording and can destroy one on request. It
 * did neither. There was no path by which a call could be refused, and no
 * path by which a card number spoken aloud would be removed before the
 * transcript was stored, searched and quoted back.
 *
 * THE ORDER THE TWO GATES RUN IN, AND WHY IT IS NOT NEGOTIABLE.
 *
 *   1. `mayRecord` runs BEFORE a recording exists. `attachRecording` refuses
 *      a URL for a call that was never granted permission, so the refusal
 *      cannot be discovered after the audio is already stored. A gate that
 *      runs after the fact is not a gate, it is a report.
 *   2. `redactTranscript` runs BEFORE the first write, in the same statement
 *      that stores the transcript. There is no window in which the raw text
 *      is in the table, because "we redact it on a schedule" means the card
 *      number is in the database, in its backups, and in whatever read it
 *      during the window.
 *
 * WHAT THIS FILE DOES NOT DO. It never decides what the law is. Every rule
 * it applies comes from `recording_policy`, which holds what the OPERATOR
 * declared, in their words, and the refusals quote them back. Where the
 * operator has declared nothing, the call resolves to `unknown`, which core
 * treats as all-party and announcement-required. The cost of that is a
 * recording that was not made; the cost of the other default is one that
 * should not exist.
 */

/* --------------------------------------------------------------- policies */

const policyRow = (row: typeof schema.recordingPolicy.$inferSelect): telephony.JurisdictionPolicy => ({
  jurisdiction: row.jurisdiction,
  rule: row.rule as telephony.ConsentRule,
  announcementRequired: row.announcementRequired,
  note: row.note,
});

/** Everything the operator has declared, in the shape core takes. */
export async function policies(tx: Database, organizationId: string): Promise<telephony.JurisdictionPolicy[]> {
  const rows = await tx.select().from(schema.recordingPolicy)
    .where(and(
      eq(schema.recordingPolicy.organizationId, organizationId),
      isNull(schema.recordingPolicy.deletedAt),
    ))
    .orderBy(schema.recordingPolicy.jurisdiction);
  return rows.map(policyRow);
}

export const listPolicies = (ctx: ServiceContext) =>
  guardedRead(ctx, "settings:read", (tx) => policies(tx, ctx.actor.organizationId));

export interface PolicyInput {
  jurisdiction: string;
  rule: string;
  announcementRequired: boolean;
  note: string;
}

/**
 * Declare or amend the rule for one place.
 *
 * The whole resulting catalogue is checked, not just the row being written,
 * because two of the three failures core looks for are properties of the SET
 * rather than of any single row: a duplicated jurisdiction, where the answer
 * would depend on read order, and a rule value outside the catalogue, which
 * would fall through every comparison and behave like the most permissive
 * option. Checking the row alone would let the second row through.
 */
export async function setPolicy(ctx: ServiceContext, input: PolicyInput) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const jurisdiction = input.jurisdiction.trim();
    const existing = await policies(tx, ctx.actor.organizationId);
    const proposed: telephony.JurisdictionPolicy[] = [
      ...existing.filter((p) => p.jurisdiction !== jurisdiction),
      {
        jurisdiction,
        rule: input.rule as telephony.ConsentRule,
        announcementRequired: input.announcementRequired,
        note: input.note,
      },
    ];

    const verdict = telephony.checkRecordingPolicies(proposed);
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const [row] = await tx.insert(schema.recordingPolicy).values({
      organizationId: ctx.actor.organizationId,
      jurisdiction,
      rule: input.rule,
      announcementRequired: input.announcementRequired,
      note: input.note,
    }).onConflictDoUpdate({
      target: [schema.recordingPolicy.organizationId, schema.recordingPolicy.jurisdiction],
      /**
       * The unique index is partial: it covers live rows only, so a
       * withdrawn declaration does not block re-declaring the same place.
       * Postgres will not infer a partial index from the column list alone,
       * so the predicate is repeated here. Without it every upsert fails
       * with "no unique or exclusion constraint matching the ON CONFLICT
       * specification", which is at least loud.
       */
      targetWhere: isNull(schema.recordingPolicy.deletedAt),
      set: {
        rule: input.rule,
        announcementRequired: input.announcementRequired,
        note: input.note,
        updatedAt: new Date(),
        deletedAt: null,
      },
    }).returning();

    await audit(tx, ctx, "recording_policy.set", "recording_policy", row!.id, null, row!);
    return policyRow(row!);
  });
}

/**
 * Withdraw a declaration.
 *
 * Deleting a policy does not loosen anything: with no policy for a place,
 * every party in it resolves to `unknown`, which core treats as all-party
 * and announcement-required. Withdrawing a declaration makes recording
 * HARDER, which is the only safe direction for an operation whose input is
 * "I am no longer sure about this".
 */
export async function removePolicy(ctx: ServiceContext, jurisdiction: string) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [row] = await tx.update(schema.recordingPolicy)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.recordingPolicy.organizationId, ctx.actor.organizationId),
        eq(schema.recordingPolicy.jurisdiction, jurisdiction.trim()),
        isNull(schema.recordingPolicy.deletedAt),
      ))
      .returning();

    if (!row) throw new NotFoundError(`Recording policy for ${jurisdiction}`);
    await audit(tx, ctx, "recording_policy.removed", "recording_policy", row.id, row, null);
    return { jurisdiction: row.jurisdiction };
  });
}

/* ------------------------------------------------------------------ calls */

export interface LogCallInput {
  direction: "inbound" | "outbound";
  fromE164: string;
  toE164: string;
  status: typeof schema.callStatus.enumValues[number];
  receivedOnE164?: string | null;
  customerId?: string | null;
  contactId?: string | null;
  jobId?: string | null;
  answeredByUserId?: string | null;
  startedAt?: Date | null;
  answeredAt?: Date | null;
  endedAt?: Date | null;
  durationSeconds?: number | null;
  ringSeconds?: number | null;
  disposition?: string | null;
  attributionSource?: string | null;
  providerCallId?: string | null;
}

/**
 * Record that a call happened.
 *
 * Deliberately takes no recording fields. A call is logged from a provider
 * webhook that fires when the leg starts, and at that moment nobody has
 * decided anything about recording; letting this function accept a
 * `recordingUrl` would make the permission check optional in exactly the
 * place it matters. Recording arrives through `decideRecording` and
 * `attachRecording`, in that order, or not at all.
 */
export async function logCall(ctx: ServiceContext, input: LogCallInput) {
  return guardedWrite(ctx, "message:send", async (tx) => {
    const [row] = await tx.insert(schema.call).values({
      organizationId: ctx.actor.organizationId,
      direction: input.direction,
      fromE164: input.fromE164,
      toE164: input.toE164,
      receivedOnE164: input.receivedOnE164 ?? null,
      customerId: input.customerId ?? null,
      contactId: input.contactId ?? null,
      jobId: input.jobId ?? null,
      answeredByUserId: input.answeredByUserId ?? null,
      status: input.status,
      startedAt: input.startedAt ?? new Date(),
      answeredAt: input.answeredAt ?? null,
      endedAt: input.endedAt ?? null,
      durationSeconds: input.durationSeconds ?? null,
      ringSeconds: input.ringSeconds ?? null,
      disposition: input.disposition ?? null,
      attributionSource: input.attributionSource ?? null,
      providerCallId: input.providerCallId ?? null,
    }).returning();

    return row!;
  });
}

async function loadCall(tx: Database, organizationId: string, callId: string) {
  const [row] = await tx.select().from(schema.call)
    .where(and(eq(schema.call.id, callId), eq(schema.call.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Call");
  return row;
}

export interface RecordingDecisionInput {
  callId: string;
  parties: readonly telephony.CallParty[];
  announcementPlayed: boolean;
}

/**
 * Ask whether this call may be recorded, and write down the answer.
 *
 * Both outcomes are stored. A yes writes the governing rule and the moment
 * permission was granted; a no writes the refusal code. The second half is
 * the part systems usually skip, and it is why a row with no recording is
 * otherwise unreadable: "nobody turned recording on", "the provider dropped
 * the file" and "the customer said do not record me" all look identical on a
 * null URL, and only one of them must never be retried.
 */
export async function decideRecording(ctx: ServiceContext, input: RecordingDecisionInput) {
  return guardedWrite(ctx, "message:send", async (tx) => {
    const call = await loadCall(tx, ctx.actor.organizationId, input.callId);

    if (call.recordingDeletedAt) {
      throw new ConflictError(
        "This call's recording was deleted. Granting permission again would only invite somebody to attach another copy of the thing that was destroyed.",
      );
    }

    const decision = telephony.mayRecord({
      parties: input.parties,
      policies: await policies(tx, ctx.actor.organizationId),
      announcementPlayed: input.announcementPlayed,
    });

    const now = new Date();
    await tx.update(schema.call).set({
      recordingConsent: decision.governing,
      recordingStartedAt: decision.ok ? (call.recordingStartedAt ?? now) : null,
      recordingRefusal: decision.ok ? null : decision.reason,
      announcementPlayedAt: input.announcementPlayed ? (call.announcementPlayedAt ?? now) : null,
      updatedAt: now,
    }).where(eq(schema.call.id, call.id));

    await audit(
      tx, ctx,
      decision.ok ? "call.recording_permitted" : "call.recording_refused",
      "call", call.id, null,
      { governing: decision.governing, ...(decision.ok ? { why: decision.why } : { reason: decision.reason }) },
    );

    return decision;
  });
}

/**
 * Store where the audio lives.
 *
 * Refuses unless `decideRecording` already said yes for THIS call. The check
 * is a read of `recordingStartedAt` rather than a re-run of `mayRecord`,
 * because the parties on a finished call are no longer available to ask, and
 * a re-run that quietly resolved to `unknown` would refuse every legitimate
 * attachment. Permission is a fact with a timestamp, not something to
 * recompute.
 */
export async function attachRecording(ctx: ServiceContext, callId: string, recordingUrl: string) {
  return guardedWrite(ctx, "message:send", async (tx) => {
    const call = await loadCall(tx, ctx.actor.organizationId, callId);

    if (call.recordingDeletedAt) {
      throw new ConflictError("This call's recording was deleted. It cannot be attached again.");
    }
    if (!call.recordingStartedAt) {
      const because = call.recordingRefusal
        ? `recording was refused for this call (${call.recordingRefusal})`
        : "nobody asked whether this call could be recorded";
      throw new ConflictError(
        `There is no permission to store a recording of this call, because ${because}. `
        + "Run the recording check first: a recording attached without one is a recording nobody can say was allowed.",
      );
    }

    const [row] = await tx.update(schema.call)
      .set({ recordingUrl, updatedAt: new Date() })
      .where(eq(schema.call.id, call.id)).returning();

    await audit(tx, ctx, "call.recording_attached", "call", call.id, null, { recordingUrl });
    return row!;
  });
}

/**
 * Destroy the recording.
 *
 * The URL is cleared in the same statement that stamps the deletion, so
 * there is no state in which the row says "deleted" and still carries the
 * address of the file. `recordingStartedAt` is left alone: it is the record
 * that permission existed, and erasing it would make a lawfully recorded and
 * then deleted call indistinguishable from one that was never allowed.
 *
 * A call with no recording yet is stamped rather than refused, and that is
 * the case this function is most useful for. A customer who says "do not
 * keep a recording of this" says it ON the call, minutes before the
 * provider's webhook arrives with the file. The stamp is what makes the
 * instruction hold: `attachRecording` refuses afterwards, so the audio never
 * lands and nobody has to remember to delete it a second time.
 */
export async function deleteRecording(ctx: ServiceContext, callId: string, reason: string) {
  return guardedWrite(ctx, "message:send", async (tx) => {
    const call = await loadCall(tx, ctx.actor.organizationId, callId);
    if (call.recordingDeletedAt) return call;

    const [row] = await tx.update(schema.call).set({
      recordingUrl: null,
      recordingDeletedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.call.id, call.id)).returning();

    await audit(tx, ctx, "call.recording_deleted", "call", call.id, { recordingUrl: call.recordingUrl }, { reason });
    return row!;
  });
}

/* ------------------------------------------------------------ transcripts */

export interface AttachTranscriptInput {
  callId: string;
  segments: readonly tr.RawSegment[];
}

/**
 * Store a transcript, redacted, or store nothing.
 *
 * Two refusals and one destruction, in order:
 *
 *   1. `normalizeSegments` refuses malformed provider output rather than
 *      repairing it. Every defect has an obvious one-line repair and every
 *      repair is wrong, because a transcript is quoted back to a customer
 *      and read as the record of what somebody said. A transcript that is
 *      obviously broken gets looked at; one that was quietly straightened
 *      out gets believed.
 *   2. `redactTranscript` removes card numbers, security codes and the rest
 *      BEFORE the insert. Not after, not nightly.
 *   3. Only the redacted text is written. The raw segments are never bound
 *      into a statement, so they are not in the table, the WAL or a backup.
 *
 * The flattened `transcript` column and the `transcript_segments` array are
 * both written from the SAME redacted segments, rather than the text being
 * rendered from the raw input for readability. That would be the obvious
 * shortcut and it would put the card number back.
 */
export async function attachTranscript(ctx: ServiceContext, input: AttachTranscriptInput) {
  return guardedWrite(ctx, "message:send", async (tx) => {
    const call = await loadCall(tx, ctx.actor.organizationId, input.callId);

    const normalized = tr.normalizeSegments(input.segments);
    if (!normalized.ok) {
      throw new ConflictError(
        "This transcript was refused rather than repaired, because a transcript that was quietly straightened out gets believed: "
        + normalized.defects.map((d) => tr.describeDefect(d)).join(" "),
      );
    }

    const redacted = tr.redactTranscript(normalized.segments);
    const now = new Date();

    const [row] = await tx.update(schema.call).set({
      transcript: tr.renderForSummary(redacted.segments),
      transcriptSegments: redacted.segments.map((s) => ({
        speaker: s.speaker, startMs: s.startMs, endMs: s.endMs, text: s.text, confidence: s.confidence,
      })),
      transcriptRedactedAt: now,
      transcriptRedactionCounts: redacted.report.countsByCategory,
      updatedAt: now,
    }).where(eq(schema.call.id, call.id)).returning();

    await audit(tx, ctx, "call.transcript_attached", "call", call.id, null, {
      segments: redacted.segments.length,
      redacted: redacted.report.redacted,
      countsByCategory: redacted.report.countsByCategory,
    });

    return {
      call: row!,
      report: redacted.report,
      quality: tr.assessQuality(redacted.segments),
    };
  });
}

/* ------------------------------------------------------------------ reads */

export const callsFor = (ctx: ServiceContext, options: { customerId?: string; limit?: number } = {}) =>
  guardedRead(ctx, "message:read", async (tx) => {
    const where = options.customerId
      ? and(eq(schema.call.organizationId, ctx.actor.organizationId), eq(schema.call.customerId, options.customerId))
      : eq(schema.call.organizationId, ctx.actor.organizationId);
    return tx.select().from(schema.call).where(where)
      .orderBy(desc(schema.call.startedAt))
      .limit(Math.min(options.limit ?? 50, 200));
  });

export const callFor = (ctx: ServiceContext, callId: string) =>
  guardedRead(ctx, "message:read", (tx) => loadCall(tx, ctx.actor.organizationId, callId));

/* --------------------------------------------------------------- handlers */

/**
 * The contract shapes, which are deliberately not the service shapes.
 *
 * `decideRecording` returns core's discriminated union, which is the right
 * type to program against and the wrong one to put on the wire: a JSON
 * consumer cannot narrow on `ok` without knowing the union, and the two arms
 * carry different fields. Over HTTP it becomes one flat object where
 * `permitted` is the boolean and `refusal` is null when there is nothing to
 * fix, so a client can render it without a discriminator.
 */
export const handlers = {
  listRecordingPolicies: async (ctx: ServiceContext): Promise<{
    policies: { jurisdiction: string; rule: string; announcementRequired: boolean; note: string }[];
  }> => ({ policies: await listPolicies(ctx) }),

  setRecordingPolicy: (ctx: ServiceContext, input: PolicyInput): Promise<{
    jurisdiction: string; rule: string; announcementRequired: boolean; note: string;
  }> => setPolicy(ctx, input),

  removeRecordingPolicy: (ctx: ServiceContext, input: { jurisdiction: string }) =>
    removePolicy(ctx, input.jurisdiction),

  logCall: (ctx: ServiceContext, input: {
    direction: "inbound" | "outbound"; fromE164: string; toE164: string;
    status: typeof schema.callStatus.enumValues[number];
    receivedOnE164?: string | undefined; customerId?: string | undefined;
    contactId?: string | undefined; jobId?: string | undefined;
    startedAt?: string | undefined; answeredAt?: string | undefined; endedAt?: string | undefined;
    durationSeconds?: number | undefined; ringSeconds?: number | undefined;
    disposition?: string | undefined; providerCallId?: string | undefined;
  }) => logCall(ctx, {
    direction: input.direction,
    fromE164: input.fromE164,
    toE164: input.toE164,
    status: input.status,
    receivedOnE164: input.receivedOnE164 ?? null,
    customerId: input.customerId ?? null,
    contactId: input.contactId ?? null,
    jobId: input.jobId ?? null,
    startedAt: input.startedAt ? new Date(input.startedAt) : null,
    answeredAt: input.answeredAt ? new Date(input.answeredAt) : null,
    endedAt: input.endedAt ? new Date(input.endedAt) : null,
    durationSeconds: input.durationSeconds ?? null,
    ringSeconds: input.ringSeconds ?? null,
    disposition: input.disposition ?? null,
    providerCallId: input.providerCallId ?? null,
  }),

  listCalls: async (ctx: ServiceContext, input: { customerId?: string | undefined; limit: number }) => ({
    calls: await callsFor(ctx, {
      ...(input.customerId ? { customerId: input.customerId } : {}),
      limit: input.limit,
    }),
  }),

  getCall: (ctx: ServiceContext, input: { id: string }) => callFor(ctx, input.id),

  decideRecording: async (ctx: ServiceContext, input: {
    id: string;
    parties: readonly {
      role: "caller" | "callee" | "agent" | "third_party";
      jurisdiction?: string | undefined;
      consented?: boolean | undefined;
    }[];
    announcementPlayed: boolean;
  }): Promise<{
    permitted: boolean;
    governing: "one_party" | "all_party" | "unknown";
    announcementRequired: boolean;
    message: string;
    refusal: string | null;
  }> => {
    const decision = await decideRecording(ctx, {
      callId: input.id,
      parties: input.parties,
      announcementPlayed: input.announcementPlayed,
    });
    return {
      permitted: decision.ok,
      governing: decision.governing,
      announcementRequired: decision.announcementRequired,
      message: decision.ok ? decision.why : decision.message,
      refusal: decision.ok ? null : decision.reason,
    };
  },

  attachRecording: (ctx: ServiceContext, input: { id: string; recordingUrl: string }) =>
    attachRecording(ctx, input.id, input.recordingUrl),

  deleteRecording: (ctx: ServiceContext, input: { id: string; reason: string }) =>
    deleteRecording(ctx, input.id, input.reason),

  attachTranscript: async (ctx: ServiceContext, input: {
    id: string;
    segments: readonly { speaker: string; startMs: number; endMs: number; text: string; confidence: number }[];
  }): Promise<{
    call: typeof schema.call.$inferSelect;
    redacted: boolean;
    countsByCategory: Record<string, number>;
    actOnAutomatically: boolean;
    meanConfidence: number;
  }> => {
    const result = await attachTranscript(ctx, { callId: input.id, segments: input.segments });
    return {
      call: result.call,
      redacted: result.report.redacted,
      countsByCategory: result.report.countsByCategory,
      actOnAutomatically: result.quality.actOnAutomatically,
      meanConfidence: result.quality.meanConfidence,
    };
  },
} as const;
