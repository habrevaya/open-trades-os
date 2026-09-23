import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, Timestamps } from "./common";

/**
 * CALLS, AND THE TWO GATES AROUND THEM
 *
 * These routes exist so that the recording decision and the redaction pass
 * are reachable from outside the web app. A provider webhook, a self hosted
 * dialler and an agent all have to go through the same two gates the screens
 * do, and a capability that only exists behind a form is a capability the
 * integration will route around.
 *
 * Nothing here decides what the law is. `POST /v1/recording-policies` stores
 * what the OPERATOR declared, in their words, and the refusals quote them
 * back. A place with no declaration resolves to `unknown`, which is treated
 * as all party and announcement required.
 */

export const ConsentRule = z.enum(["one_party", "all_party", "unknown"]);
export const CallPartyRole = z.enum(["caller", "callee", "agent", "third_party"]);
export const CallStatus = z.enum([
  "ringing", "in_progress", "completed", "no_answer", "busy", "failed",
  "voicemail", "abandoned",
]);
export const RecordingRefusal = z.enum([
  "policy_rejected", "no_parties", "party_declined",
  "announcement_not_played", "consent_missing",
]);

export const RecordingPolicy = z.object({
  jurisdiction: z.string(),
  rule: ConsentRule,
  /**
   * Separate from the rule rather than derived from it, because the two move
   * independently: an operator may choose to announce everywhere.
   */
  announcementRequired: z.boolean(),
  note: z.string(),
});

export const Call = z.object({
  id: Uuid,
  direction: z.enum(["inbound", "outbound"]),
  fromE164: z.string(),
  toE164: z.string(),
  receivedOnE164: z.string().nullable(),
  customerId: Uuid.nullable(),
  contactId: Uuid.nullable(),
  jobId: Uuid.nullable(),
  answeredByUserId: Uuid.nullable(),
  status: CallStatus,
  startedAt: z.string().datetime().nullable(),
  answeredAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  durationSeconds: z.number().int().nullable(),
  ringSeconds: z.number().int().nullable(),
  /** The rule that GOVERNED this call, resolved when recording was asked for. */
  recordingConsent: ConsentRule.nullable(),
  recordingStartedAt: z.string().datetime().nullable(),
  /**
   * Why there is no recording. Published because "nobody turned it on", "the
   * provider dropped the file" and "the customer said no" are three
   * different facts and a null URL is all three.
   */
  recordingRefusal: RecordingRefusal.nullable(),
  announcementPlayedAt: z.string().datetime().nullable(),
  recordingUrl: z.string().nullable(),
  recordingDeletedAt: z.string().datetime().nullable(),
  /** Already redacted. There is no route that returns the provider's raw text. */
  transcript: z.string().nullable(),
  transcriptRedactedAt: z.string().datetime().nullable(),
  transcriptRedactionCounts: z.record(z.string(), z.number().int()).nullable(),
  disposition: z.string().nullable(),
  attributionSource: z.string().nullable(),
}).merge(Timestamps);

export const listRecordingPolicies = defineRoute({
  method: "get",
  path: "/v1/recording-policies",
  summary: "List declared recording policies",
  module: "M18",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ policies: z.array(RecordingPolicy) }),
});

export const setRecordingPolicy = defineRoute({
  method: "post",
  path: "/v1/recording-policies",
  summary: "Declare or amend the recording rule for one place",
  description:
    "The whole resulting catalogue is validated, not just this row: a duplicated jurisdiction and a rule outside the catalogue are properties of the set, and the second would behave like the most permissive option.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    jurisdiction: z.string().min(1).max(100),
    rule: ConsentRule,
    announcementRequired: z.boolean(),
    note: z.string().min(1).max(2000),
  }),
  output: RecordingPolicy,
});

export const removeRecordingPolicy = defineRoute({
  method: "delete",
  path: "/v1/recording-policies/{jurisdiction}",
  summary: "Withdraw a declaration",
  description:
    "Loosens nothing. With no policy for a place, every party in it resolves to unknown, which is treated as all party and announcement required.",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({ jurisdiction: z.string().min(1).max(100) }),
  output: z.object({ jurisdiction: z.string() }),
});

export const logCall = defineRoute({
  method: "post",
  path: "/v1/calls",
  summary: "Record that a call happened",
  description:
    "Takes no recording fields on purpose. At the moment a provider webhook fires, nobody has decided anything about recording, and accepting a URL here would make the permission check optional in the one place it matters.",
  module: "M18",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({
    direction: z.enum(["inbound", "outbound"]),
    fromE164: z.string().min(1).max(32),
    toE164: z.string().min(1).max(32),
    status: CallStatus,
    receivedOnE164: z.string().max(32).optional(),
    customerId: Uuid.optional(),
    contactId: Uuid.optional(),
    jobId: Uuid.optional(),
    startedAt: z.string().datetime().optional(),
    answeredAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
    durationSeconds: z.number().int().min(0).optional(),
    ringSeconds: z.number().int().min(0).optional(),
    disposition: z.string().max(100).optional(),
    providerCallId: z.string().max(200).optional(),
  }),
  output: Call,
});

export const listCalls = defineRoute({
  method: "get",
  path: "/v1/calls",
  summary: "List calls",
  module: "M18",
  permissions: ["message:read"],
  input: z.object({
    customerId: Uuid.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ calls: z.array(Call) }),
});

export const getCall = defineRoute({
  method: "get",
  path: "/v1/calls/{id}",
  summary: "Get a call",
  module: "M18",
  permissions: ["message:read"],
  input: z.object({ id: Uuid }),
  output: Call,
});

export const decideRecording = defineRoute({
  method: "post",
  path: "/v1/calls/{id}/recording-decision",
  summary: "Ask whether this call may be recorded",
  description:
    "Ask BEFORE the first byte. The strictest party's jurisdiction governs the whole call, a party whose location is unknown makes the whole call unknown, and a party who declined ends it. Both outcomes are written to the call.",
  module: "M18",
  permissions: ["message:send"],
  /**
   * Idempotent because asking the same question about the same call twice
   * has the same answer and leaves the same row: the decision is a pure
   * function of the parties and the policy table, and both are inputs.
   */
  idempotent: true,
  input: z.object({
    id: Uuid,
    parties: z.array(z.object({
      role: CallPartyRole,
      jurisdiction: z.string().max(100).optional(),
      /**
       * Three states, not two. True is agreement, false is a refusal, and
       * absent is silence. Folding silence into false would lose the
       * difference between somebody who said no, which ends the question,
       * and somebody nobody has asked yet.
       */
      consented: z.boolean().optional(),
    })).min(1),
    announcementPlayed: z.boolean(),
  }),
  output: z.object({
    permitted: z.boolean(),
    governing: ConsentRule,
    announcementRequired: z.boolean(),
    /** What still has to happen, or why it is already settled. */
    message: z.string(),
    refusal: RecordingRefusal.nullable(),
  }),
});

export const attachRecording = defineRoute({
  method: "post",
  path: "/v1/calls/{id}/recording",
  summary: "Store where the audio lives",
  description:
    "Refused unless the recording decision for this call already said yes. A gate that runs after the audio is stored is not a gate, it is a report.",
  module: "M18",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({ id: Uuid, recordingUrl: z.string().min(1).max(2000) }),
  output: Call,
});

export const deleteRecording = defineRoute({
  method: "delete",
  path: "/v1/calls/{id}/recording",
  summary: "Destroy the recording",
  description:
    "Clears the address in the same statement that stamps the deletion. Works on a call whose audio has not arrived yet, which is the common case: the customer asks on the call, the webhook lands minutes later, and the attach is then refused.",
  module: "M18",
  permissions: ["message:send"],
  input: z.object({ id: Uuid, reason: z.string().min(1).max(500) }),
  output: Call,
});

export const attachTranscript = defineRoute({
  method: "post",
  path: "/v1/calls/{id}/transcript",
  summary: "Store a transcript, redacted",
  description:
    "Malformed provider output is refused rather than repaired, because a transcript that was quietly straightened out gets believed. Card numbers and security codes are removed BEFORE the write, not on a schedule: the raw text is never bound into a statement.",
  module: "M18",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    segments: z.array(z.object({
      speaker: z.string(),
      startMs: z.number(),
      endMs: z.number(),
      text: z.string(),
      confidence: z.number(),
    })).min(1),
  }),
  output: z.object({
    call: Call,
    redacted: z.boolean(),
    countsByCategory: z.record(z.string(), z.number().int()),
    /**
     * False when anything about the transcription is doubtful. An agent
     * acting on a low confidence transcript is acting on a guess about what
     * a customer said.
     */
    actOnAutomatically: z.boolean(),
    meanConfidence: z.number(),
  }),
});

export const telephonyRoutes = {
  listRecordingPolicies, setRecordingPolicy, removeRecordingPolicy,
  logCall, listCalls, getCall,
  decideRecording, attachRecording, deleteRecording, attachTranscript,
} as const;
