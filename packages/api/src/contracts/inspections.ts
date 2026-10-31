import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

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

/**
 * ONE CHECKPOINT, AS A COMPANY WRITES IT.
 *
 * The same shape a trade pack declares, without the pack's defaults: what a
 * fail means has to be said for anything whose fail is a finding, because a
 * person who left the box empty has not decided that a fail is wear.
 */
export const Checkpoint = z.object({
  /** Stays the same from one version to the next, so answers and findings keep meaning the same checkpoint. */
  key: z.string().min(1).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Letters, numbers, dashes and underscores only."),
  /** The question the technician is asked, printed on the report. */
  label: z.string().min(1).max(200),
  /** The kind of equipment it is about, such as backflow-assembly. Left out for one about the whole property. */
  assetCategory: z.string().max(60).optional(),
  /** A reading rather than a pass or fail. A reading needs a unit and a range to be judged against. */
  requiresReading: z.boolean().optional(),
  unit: z.string().max(20).optional(),
  range: z.object({
    min: z.number().nullable(),
    max: z.number().nullable(),
    /** How close to either end is said to be close, which is never a fail. */
    borderlineWithin: z.number().positive().optional(),
  }).optional(),
  /** The repairs a fail suggests quoting, as codes in your own price book. Never a price. */
  remedies: z.array(z.object({
    priceBookItemKey: z.string().min(1).max(60),
    label: z.string().min(1).max(200),
    quantity: z.number().positive(),
    rationale: z.string().min(1).max(500),
  })).max(10).optional(),
  /** False for a checkpoint recorded for the record and never a finding. */
  failIsDeficiency: z.boolean().optional(),
  /** How serious a fail is, which sets the finding's deadline: critical today, major 30 days, minor 180, advisory none. */
  severityOnFail: Severity.optional(),
});

const ReportAudience = z.enum(["customer", "authority", "both"]);

const CopiedFrom = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trade_pack"), packId: z.string(), packVersion: z.number().int(), code: z.string(), name: z.string() }),
  z.object({ kind: z.literal("program"), programId: Uuid, version: z.number().int(), name: z.string() }),
]);

const ProgramSummary = z.object({
  id: Uuid,
  name: z.string(),
  standard: z.string().nullable(),
  reportAudience: z.string(),
  authorityName: z.string().nullable(),
  frequencyMonths: z.number().int().nullable(),
  version: z.number().int(),
  checkpointCount: z.number().int(),
  /** Offered to technicians. */
  active: z.boolean(),
  /** `plumbing@2` for a programme a trade pack set up; null for the company's own. */
  tradePackId: z.string().nullable(),
  /** What the company's own programme was copied from, when it was. */
  copiedFrom: CopiedFrom.nullable(),
  /** Whether an inspection can be filed against it. */
  ready: z.boolean(),
  /** What stops one being filed, in words. Empty when it is ready. */
  problems: z.array(z.string()),
});

const ProgramDefinition = {
  name: z.string().min(1).max(160),
  /** The standard it is performed under, as text. Never read as a rule. */
  standard: z.string().max(200).nullish(),
  reportAudience: ReportAudience.optional(),
  authorityName: z.string().max(160).nullish(),
  frequencyMonths: z.number().int().min(1).max(120).nullish(),
  checkpoints: z.array(Checkpoint).min(1).max(200),
  /** What changed, in the words of whoever publishes it. Kept with the version. */
  note: z.string().max(1000).nullish(),
};

export const listInspectionPrograms = defineRoute({
  method: "get",
  path: "/v1/inspection-programs",
  summary: "The inspection programmes this company runs",
  description:
    "Each with the standard it is performed under as text that is never interpreted as a rule, who receives the report, how often, and its version. An inspection records the version it was performed under, because a report in a compliance file has to keep meaning what it meant. Only those offered to technicians unless `includeRetired` is set. `ready` is false for one an inspection cannot be filed against as it stands, with `problems` saying why.",
  module: "M33",
  permissions: ["compliance:read"],
  input: z.object({ includeRetired: z.boolean().optional() }),
  output: z.object({ programs: z.array(ProgramSummary) }),
});

export const getInspectionProgram = defineRoute({
  method: "get",
  path: "/v1/inspection-programs/{id}",
  summary: "One programme, its checkpoints and every version it has had",
  description:
    "The version in force with its checkpoints, and the versions before it, newest first, each with what changed and who published it. A programme published before versions were kept lists only the version it is on.",
  module: "M33",
  permissions: ["compliance:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    program: ProgramSummary.extend({ checkpoints: z.array(Checkpoint) }),
    versions: z.array(z.object({
      version: z.number().int(),
      name: z.string(),
      /** The parts that differ from the version before: name, standard, reportAudience, authorityName, frequencyMonths, checkpoints. */
      changed: z.array(z.string()),
      note: z.string().nullable(),
      /** The trade pack version that wrote it, for one a pack set up or upgraded. */
      tradePackId: z.string().nullable(),
      publishedAt: z.string().datetime(),
      publishedBy: z.string().nullable(),
    })),
    /** How many inspections have been filed under any version of it. */
    inspections: z.number().int(),
  }),
});

export const getInspectionProgramVersion = defineRoute({
  method: "get",
  path: "/v1/inspection-programs/{id}/versions/{version}",
  summary: "One version of a programme, as it was published",
  module: "M33",
  permissions: ["compliance:read"],
  input: z.object({ id: Uuid, version: z.coerce.number().int().min(1) }),
  output: z.object({
    id: Uuid,
    version: z.number().int(),
    current: z.boolean(),
    name: z.string(),
    standard: z.string().nullable(),
    reportAudience: z.string(),
    authorityName: z.string().nullable(),
    frequencyMonths: z.number().int().nullable(),
    checkpoints: z.array(Checkpoint),
    problems: z.array(z.string()),
  }),
});

export const listTradePackInspectionPrograms = defineRoute({
  method: "get",
  path: "/v1/inspection-programs/trade-packs",
  summary: "The programmes trade packs declare, to start your own from",
  description:
    "Every trade pack's programmes, the company's own trades first, each whole with its checkpoints and what has to be fixed before an inspection could be filed against it. Copy one by sending it, changed as you need, to `POST /v1/inspection-programs` with `copiedFrom`. `inCompany` names the company's own row of it, set up by the pack, which `replaces` can stop offering in the same step.",
  module: "M33",
  permissions: ["compliance:read"],
  input: z.object({}),
  output: z.object({
    programs: z.array(z.object({
      packId: z.string(),
      packName: z.string(),
      packVersion: z.number().int(),
      yourTrade: z.boolean(),
      code: z.string(),
      name: z.string(),
      standard: z.string().nullable(),
      reportAudience: z.string(),
      frequencyMonths: z.number().int().nullable(),
      checkpoints: z.array(Checkpoint),
      problems: z.array(z.string()),
      inCompany: z.object({ id: Uuid, offered: z.boolean() }).nullable(),
    })),
  }),
});

export const defineInspectionProgram = defineRoute({
  method: "post",
  path: "/v1/inspection-programs",
  summary: "Write a programme of your own",
  description:
    "From nothing, or from a copy of a trade pack's programme or one of your own, named in `copiedFrom` and kept with it. Refused, in words, when an inspection could not be filed against it: no checkpoints, a reading with no unit or no range, a checkpoint whose fail is a finding that does not say how serious it is. Refused when technicians are already offered a programme of the same name, unless `replaces` names that one, which then stops being offered in the same step. Version 1, offered to technicians at once.",
  module: "M33",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    ...ProgramDefinition,
    copiedFrom: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("trade_pack"), packId: z.string().min(1).max(60), code: z.string().min(1).max(60) }),
      z.object({ kind: z.literal("program"), programId: Uuid }),
    ]).optional(),
    /** A programme this one takes the place of: it stops being offered as this one starts. */
    replaces: Uuid.optional(),
  }),
  output: ProgramSummary.extend({ checkpoints: z.array(Checkpoint) }),
});

export const reviseInspectionProgram = defineRoute({
  method: "post",
  path: "/v1/inspection-programs/{id}/versions",
  summary: "Publish a new version of a programme",
  description:
    "The whole programme as it should now read; what is left out is left out of the new version. Inspections already filed keep the version they were done under, with its checkpoints, and a phone that ran the old version offline files against it. `baseVersion` is the version you changed: if somebody published another since, it is refused rather than written over theirs. A programme a trade pack set up keeps its name. Sending what the version in force already says publishes nothing.",
  module: "M33",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    baseVersion: z.number().int().min(1),
    ...ProgramDefinition,
  }),
  output: ProgramSummary.extend({ checkpoints: z.array(Checkpoint) }),
});

export const setInspectionProgramOffered = defineRoute({
  method: "put",
  path: "/v1/inspection-programs/{id}/offered",
  summary: "Offer a programme to technicians, or stop",
  description:
    "Stopping keeps the programme and every version, because the inspections done under it point at them. Offering it again is refused when an inspection could not be filed against it as it stands, or when another programme technicians are offered has its name.",
  module: "M33",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({ id: Uuid, offered: z.boolean() }),
  output: z.object({ id: Uuid, offered: z.boolean(), version: z.number().int() }),
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
    /**
     * The version the answers were given against, when the caller held one.
     * Left out, the version in force. An inspection run offline against an
     * older version is judged against that version's checkpoints and keeps it.
     */
    programVersion: z.number().int().min(1).optional(),
    propertyId: Uuid,
    customerId: Uuid,
    answers: z.array(RecordedAnswer).min(1),
    jobId: Uuid.nullish(),
    visitId: Uuid.nullish(),
    inspectorName: z.string().max(200).nullish(),
    inspectorLicense: z.string().max(120).nullish(),
    performedOn: IsoDate.optional(),
    /** Who signed the report off. Printed beside the signature line. */
    signedByName: z.string().max(200).nullish(),
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
      /** The quote it became, once somebody quoted it. */
      estimateId: Uuid.nullable(),
      /** Whether its checkpoint declared a repair to price it from. */
      hasRemedy: z.boolean(),
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
    "The states that END it need a reason, and declining needs one most of all: a customer who declined a safety finding is the single sentence somebody will want in writing later, and a blank there is the record that was not kept. With `declined`, `declineCode` says why as a code (too dear, not now, already booked with another company, something else), and stands as the reason when no words are given. Plumbing's water heater capture leaves out a unit whose finding was declined as booked with another company, and reads nothing else for that.",
  module: "M33",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    status: DeficiencyStatus,
    reason: z.string().max(2000).optional(),
    declineCode: z.enum(["price", "not_now", "booked_elsewhere", "other"]).optional(),
    jobId: Uuid.nullish(),
    on: IsoDate.optional(),
  }),
  output: z.object({ id: Uuid, status: DeficiencyStatus }),
});

export const listInspections = defineRoute({
  method: "get",
  path: "/v1/inspections",
  summary: "Inspections filed, newest first",
  module: "M33",
  permissions: ["compliance:read"],
  input: z.object({
    propertyId: Uuid.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({
    inspections: z.array(z.object({
      id: Uuid,
      programName: z.string(),
      performedOn: IsoDate.nullable(),
      result: z.string().nullable(),
      customerName: z.string(),
      address: z.string(),
      visitId: Uuid.nullable(),
      nextDueOn: IsoDate.nullable(),
    })),
  }),
});

export const getInspectionReport = defineRoute({
  method: "get",
  path: "/v1/inspections/{id}/report",
  summary: "The inspection report, rendered from the data held",
  description:
    "Every checkpoint as it was asked, what was recorded, the range a reading was judged against and what it came to, the findings with severity, code and correction date, photographs, inspector, licence, signature and next due date. Rendered from the checkpoints and answers kept with the inspection, so revising the programme later does not change what an old report says. The same facts an authority's own form asks for; there is no per authority formatter.",
  module: "M33",
  permissions: ["compliance:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    organizationName: z.string(),
    program: z.object({
      id: Uuid.nullable(),
      name: z.string(),
      standard: z.string().nullable(),
      reportAudience: z.string(),
      authorityName: z.string().nullable(),
      version: z.number().int().nullable(),
    }),
    customer: z.object({ id: Uuid, name: z.string() }),
    property: z.object({ id: Uuid, address: z.string() }),
    performedOn: IsoDate.nullable(),
    result: z.string().nullable(),
    statement: z.string().nullable(),
    inspectorName: z.string().nullable(),
    inspectorLicense: z.string().nullable(),
    nextDueOn: IsoDate.nullable(),
    submittedAt: z.string().datetime().nullable(),
    submissionReference: z.string().nullable(),
    items: z.array(z.object({
      key: z.string(),
      prompt: z.string(),
      kind: z.enum(["pass_fail", "reading"]),
      unit: z.string().nullable(),
      range: z.string().nullable(),
      answer: z.string().nullable(),
      verdict: z.enum(["pass", "borderline", "finding", "not_applicable", "not_answered"]),
      severity: z.string().nullable(),
      note: z.string().nullable(),
      by: z.string().nullable(),
      at: z.string().nullable(),
      equipmentId: z.string().nullable(),
      photos: z.array(z.object({ id: z.string(), storageKey: z.string().nullable() })),
    })),
    deficiencies: z.array(z.object({
      id: Uuid,
      severity: z.enum(["safety", "failure", "wear", "recommendation"]),
      label: z.string(),
      recordedSeverity: z.string(),
      description: z.string(),
      code: z.string().nullable(),
      correctByOn: IsoDate.nullable(),
      status: z.string(),
      estimateId: Uuid.nullable(),
    })),
    signature: z.object({
      name: z.string(),
      at: z.string().datetime().nullable(),
      storageKey: z.string().nullable(),
    }).nullable(),
    /** False for an inspection filed before its checkpoints were kept with it. */
    checkpointsKept: z.boolean(),
  }),
});

export const quoteDeficiency = defineRoute({
  method: "post",
  path: "/v1/inspection-deficiencies/{id}/quote",
  summary: "Turn a finding into a quote, in one action",
  description:
    "The repairs the checkpoint declared become the lines of a new estimate, priced from your price book by item code, with what was seen as the evidence. Refused for a finding with no observation behind it, for a repair whose code is not in the price book, and for a finding with no declared repair unless a price is given. A finding already quoted returns its estimate. Needs estimate:write as well.",
  module: "M33",
  permissions: ["compliance:write", "estimate:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** The price for correcting a finding whose checkpoint declares no repair. */
    price: MoneyString.nullish(),
  }),
  output: z.object({
    deficiencyId: Uuid,
    estimateId: Uuid,
    amount: z.string().nullable(),
    created: z.boolean(),
  }),
});

export const inspectionRoutes = {
  listInspectionPrograms, getInspectionProgram, getInspectionProgramVersion, listTradePackInspectionPrograms,
  defineInspectionProgram, reviseInspectionProgram, setInspectionProgramOffered, recordInspection, listDeficiencies, setDeficiencyStatus,
  listInspections, getInspectionReport, quoteDeficiency,
} as const;
