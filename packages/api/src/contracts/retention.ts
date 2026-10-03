import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * RETENTION: THE RULES, A PREVIEW, HOLDS AND THE PURGE
 *
 * The trade packs seed retention rules with purging OFF. A company reads a
 * rule here, looks at the preview of exactly what it would remove, puts holds
 * on anything somebody may still ask for, and only then turns purging on.
 * The worker then purges once a day, and every record removed leaves an audit
 * line naming the rule and the date it became due.
 *
 * `compliance:read` to look and `compliance:write` to change a rule, place or
 * release a hold, or run the purge, which on the presets is the owner and the
 * administrator: the job that destroys records belongs to the people who can
 * answer for it.
 */

const Policy = z.object({
  id: Uuid,
  name: z.string(),
  entityType: z.string(),
  entityKind: z.string().nullable(),
  clockStart: z.string(),
  retainMonths: z.number().int(),
  /** The rule read back as a sentence. */
  sentence: z.string(),
  basis: z.string().nullable(),
  tradePackId: z.string().nullable(),
  /** Off unless somebody here turned it on. Off means the rule only marks, never removes. */
  purgeAllowed: z.boolean(),
  active: z.boolean(),
  /** Whether this product can act on the records the rule is about at all. */
  actsOn: z.boolean(),
  actsOnWhy: z.string().nullable(),
  /** How a record's kind is decided for this type, when the rule names a kind. */
  kindRule: z.string().nullable(),
});

const Decision = z.object({
  entityType: z.string(),
  id: Uuid,
  label: z.string(),
  state: z.enum(["due", "held", "not_yet", "no_clock", "kept"]),
  why: z.string(),
  policyId: Uuid,
  purgeableFrom: z.string().nullable(),
});

const Run = z.object({
  id: Uuid,
  trigger: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  purged: z.number().int(),
  held: z.number().int(),
  failed: z.number().int(),
  failures: z.array(z.object({ entityType: z.string(), entityId: z.string(), reason: z.string() })),
});

export const listRetentionPolicies = defineRoute({
  method: "get",
  path: "/v1/compliance/retention/rules",
  summary: "The retention rules, and which of them may purge",
  description: "Each read back as a sentence, with whether this product can act on the records it is about.",
  module: "M23",
  permissions: ["compliance:read"],
  input: z.object({}),
  output: z.object({ policies: z.array(Policy) }),
});

export const updateRetentionPolicy = defineRoute({
  method: "patch",
  path: "/v1/compliance/retention/rules/{id}",
  summary: "Change a retention rule's period, or let it purge",
  description:
    "The clock start is not changeable: it comes from the rule the policy cites. Turning `purgeAllowed` on is what lets the daily purge remove the records the preview lists; read the preview first.",
  module: "M23",
  permissions: ["compliance:write"],
  input: z.object({
    id: Uuid,
    retainMonths: z.number().int().min(1).max(1200).optional(),
    purgeAllowed: z.boolean().optional(),
    active: z.boolean().optional(),
  }),
  output: Policy,
});

export const previewRetentionPurge = defineRoute({
  method: "get",
  path: "/v1/compliance/retention/preview",
  summary: "What a purge would remove today, rule by rule",
  description:
    "From the same function the purge uses, so what this lists is what goes. Where two rules cover one record the longer wins, a rule with purging off keeps it outright, a hold keeps it, and a record whose clock cannot be worked out is kept.",
  module: "M23",
  permissions: ["compliance:read"],
  input: z.object({
    policyId: Uuid.optional(),
    /** How many records to list per rule. Counts are always complete. */
    sample: z.number().int().min(0).max(200).optional(),
  }),
  output: z.object({
    rules: z.array(z.object({
      policy: Policy,
      counts: z.object({ due: z.number().int(), held: z.number().int(), notYet: z.number().int(), kept: z.number().int() }),
      records: z.array(Decision),
      summary: z.string(),
    })),
  }),
});

const Hold = z.object({
  id: Uuid, entityType: z.string(), entityId: Uuid, reason: z.string(),
  placedAt: z.string(), releasedAt: z.string().nullable(), releaseNote: z.string().nullable(),
});

export const listRetentionHolds = defineRoute({
  method: "get",
  path: "/v1/compliance/retention/holds",
  summary: "Records kept whatever their age",
  module: "M23",
  permissions: ["compliance:read"],
  input: z.object({ includeReleased: z.boolean().optional() }),
  output: z.object({ holds: z.array(Hold) }),
});

export const placeRetentionHold = defineRoute({
  method: "post",
  path: "/v1/compliance/retention/holds",
  summary: "Keep a record whatever its age",
  description:
    "For a dispute, a claim or an inspector's letter. Honoured by the purge and by the recordings sweep. A record already held keeps its one hold.",
  module: "M23",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    entityType: z.enum(["incident_report", "safety_meeting", "service_report", "inspection", "call_recording"]),
    entityId: Uuid,
    reason: z.string().min(1).max(1000),
  }),
  output: z.object({ id: Uuid, placedAt: z.string() }),
});

export const releaseRetentionHold = defineRoute({
  method: "post",
  path: "/v1/compliance/retention/holds/{id}/release",
  summary: "Release a hold",
  description: "The hold is kept as history with when and why it was released. Releasing twice changes nothing.",
  module: "M23",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({ id: Uuid, note: z.string().max(1000).optional() }),
  output: z.object({ releasedAt: z.string() }),
});

export const runRetentionPurge = defineRoute({
  method: "post",
  path: "/v1/compliance/retention/purges",
  summary: "Purge now",
  description:
    "The pass the worker runs once a day, run now. Only rules with purging on act; every record removed has an audit line naming the rule. A retry with the same key returns the pass the first call made.",
  module: "M23",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({}),
  output: Run,
});

export const listRetentionPurgeRuns = defineRoute({
  method: "get",
  path: "/v1/compliance/retention/purges",
  summary: "Purge passes, newest first, with what each removed and what it could not",
  module: "M23",
  permissions: ["compliance:read"],
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({ runs: z.array(Run) }),
});

export const retentionRoutes = {
  listRetentionPolicies, updateRetentionPolicy, previewRetentionPurge, listRetentionHolds,
  placeRetentionHold, releaseRetentionHold, runRetentionPurge, listRetentionPurgeRuns,
} as const;
