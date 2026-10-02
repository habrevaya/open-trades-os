import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

const IsoDate = z.string().date();

/**
 * INSPECTIONS AND THE DEFICIENCY BACKLOG, ON THE API
 *
 * `services/inspections.ts` was reachable only from `/inspections`, which for the
 * half of this trade that runs on inspections is the wrong way round: a fire,
 * backflow or boiler contractor's whole operation is the loop from an inspection to
 * a deficiency to a proposal to a work order, and that loop had no surface. A
 * handheld tool could not file what it found, an auditor's export could not read
 * the backlog, and the MCP server had no tool for "what is outstanding at this
 * address".
 *
 * THE OUTCOME IS NOT AN INPUT, and that is the one thing this contract must not
 * let a caller do. A technician says what they saw; whether that adds up to a pass
 * is a conclusion drawn from the template. Accepting an outcome would let a half
 * finished inspection be filed as a pass, which is the single most dangerous
 * artefact this module can produce: that report goes in a compliance file, is
 * handed to a buyer and is shown to an insurer, and it asserts that somebody looked
 * at things nobody looked at.
 *
 * So the request carries answers and the response carries the verdict, with the
 * sentence core wrote for it rather than one reassembled at the edge.
 */

export const Severity = z.enum(["critical", "major", "minor", "advisory"]);

export const DeficiencyStatus = z.enum([
  "open", "quoted", "approved", "scheduled", "corrected", "declined", "deferred", "void",
]);

/**
 * One answer to one checkpoint.
 *
 * `at` and `by` come from the device rather than from a clock here, because an
 * inspection filed on Tuesday for work done on Monday has to say Monday. A finding
 * with no author is a finding nobody can ask about.
 */
export const RecordedAnswer = z.object({
  itemKey: z.string().min(1).max(60),
  value: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pass_fail"), passed: z.boolean() }),
    z.object({ kind: z.literal("reading"), raw: z.union([z.string(), z.number()]).nullable() }),
    z.object({ kind: z.literal("photo"), photoIds: z.array(Uuid) }),
    z.object({ kind: z.literal("note"), text: z.string().max(2000) }),
    z.object({ kind: z.literal("count"), count: z.number().int() }),
    /**
     * Not applicable, WITH A REASON, and the field is `why` because that is what
     * core calls it.
     *
     * Required, and a blank one is treated as no answer at all. Not applicable is
     * the most convenient way in any inspection product to make a skipped item
     * look like a completed one: one tap, and the item leaves the outstanding
     * list. Making somebody type why costs three seconds and leaves a record a
     * person can read back.
     */
    z.object({ kind: z.literal("not_applicable"), why: z.string().min(1).max(500) }),
  ]),
  at: z.string().datetime(),
  by: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
  photoIds: z.array(Uuid).optional(),
  /**
   * Which machine this answer was about, and optional on purpose. Half the
   * checkpoints on a real programme are about the property rather than a unit:
   * "is the gas meter accessible" has no machine, and forcing one would mean
   * inventing an equipment row for the building.
   */
  equipmentId: Uuid.optional(),
});

export const listInspectionPrograms = defineRoute({
  method: "get",
  path: "/v1/inspection-programs",
  summary: "The inspection programmes this company runs",
  description:
    "Each with the standard it is performed under as text that is never interpreted as a rule, who receives the report, how often, and its version. An inspection records the version it was performed under, because a report in a compliance file has to keep meaning what it meant.",
  module: "M33",
  permissions: ["compliance:read"],
  input: z.object({}),
  output: z.object({
    programs: z.array(z.object({
      id: Uuid,
      name: z.string(),
      standard: z.string().nullable(),
      reportAudience: z.string(),
      authorityName: z.string().nullable(),
      frequencyMonths: z.number().int().nullable(),
      version: z.number().int(),
      checkpointCount: z.number().int(),
    })),
  }),
});

export const recordInspection = defineRoute({
  method: "post",
  path: "/v1/inspections",
  summary: "File what was found",
  description:
    "The outcome is NOT an input. The answers go in and the verdict comes back, computed from the template, so a half finished inspection cannot be filed as a pass. `incomplete` comes back as `partial` rather than `fail`, because they are different facts and a compliance file needs to tell them apart: a failed inspection says the thing is wrong, a partial one says nobody has finished looking.",
  module: "M33",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    programId: Uuid,
    propertyId: Uuid,
    customerId: Uuid,
    answers: z.array(RecordedAnswer).min(1),
    jobId: Uuid.nullish(),
    visitId: Uuid.nullish(),
    inspectorName: z.string().max(200).nullish(),
    inspectorLicense: z.string().max(120).nullish(),
    performedOn: IsoDate.optional(),
  }),
  output: z.object({
    id: Uuid,
    result: z.string(),
    /** Core's own sentence, not one reassembled here. */
    statement: z.string(),
    complete: z.boolean(),
    unanswered: z.array(z.string()),
    /** Optional items nobody opened. They do not hold up completeness. */
    optionalSkipped: z.array(z.string()),
    counts: z.record(z.number().int()),
    nextDueOn: IsoDate.nullable(),
    deficiencies: z.number().int(),
  }),
});

export const listDeficiencies = defineRoute({
  method: "get",
  path: "/v1/inspection-deficiencies",
  summary: "Everything found and not yet put right",
  description:
    "Worst and most overdue first. The ageing is measured against a supplied instant rather than whenever the request happened to arrive, because a backlog report has to be reproducible: one measured against the clock says something different every time it is run for the same month end. A deficiency is a record rather than a note on a job, which is why it survives the job closing, ages, reports and converts.",
  module: "M33",
  permissions: ["compliance:read"],
  input: z.object({
    propertyId: Uuid.optional(),
    customerId: Uuid.optional(),
    /** Settled findings are left out unless asked for, which is the daily view. */
    includeSettled: z.boolean().optional(),
    now: z.string().datetime().optional(),
  }),
  output: z.object({
    deficiencies: z.array(z.object({
      id: Uuid,
      status: DeficiencyStatus,
      /** The authority's vocabulary, which trade packs ship and forms use. */
      recordedSeverity: Severity,
      description: z.string(),
      recommendedAction: z.string().nullable(),
      equipmentId: Uuid.nullable(),
      address: z.string(),
      foundOn: IsoDate.nullable(),
      /** The deadline the severity carries. Null for a recommendation. */
      correctByOn: IsoDate.nullable(),
      ageDays: z.number().int(),
      overdue: z.boolean(),
      /** Core's sentence about where this one stands. */
      statement: z.string(),
    })),
  }),
});

export const setDeficiencyStatus = defineRoute({
  method: "post",
  path: "/v1/inspection-deficiencies/{id}/status",
  summary: "Move a finding along",
  description:
    "The states that END it need a reason, and declining needs one most of all: a customer who declined a safety finding is the single sentence somebody will want in writing later, and a blank there is the record that was not kept.",
  module: "M33",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    status: DeficiencyStatus,
    reason: z.string().max(2000).optional(),
    jobId: Uuid.nullish(),
    on: IsoDate.optional(),
  }),
  output: z.object({ id: Uuid, status: DeficiencyStatus }),
});

export const inspectionRoutes = {
  listInspectionPrograms, recordInspection, listDeficiencies, setDeficiencyStatus,
} as const;
