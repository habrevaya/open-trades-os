import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * DOCUMENTS, REGULATORY SUBMISSIONS AND THE FIGURES THAT MOVE
 *
 * NONE OF THESE ENDPOINTS SAYS ANYBODY IS COMPLIANT, and the summaries below
 * are worded to make that visible to somebody reading the generated OpenAPI
 * document rather than the service. "You are compliant" is a claim about the
 * complete set of things a business must hold, and this product holds only the
 * rows somebody put in it: it has the numerator and no access to the
 * denominator, which depends on trade, jurisdiction, licence class, contract
 * and insurer. So every output here is a fact about a row that the code can
 * defend, and there is no verdict field anywhere in this file.
 *
 * The posture is the one `recording_policy` takes in the comms schema: the
 * software holds the operator to what they declared and does not decide
 * whether the declaration was right, which "is a question for them and their
 * counsel".
 *
 * Two permissions, split the way the catalogue already describes them.
 * `document:read` and `document:write` are the filing cabinet: registering a
 * certificate, renewing it, withdrawing it. `compliance:read` and
 * `compliance:write` are the regulatory record: what was filed with an
 * authority, what came back, and which published figures the operator is
 * working to. Filing a certificate of insurance does not entitle somebody to
 * mark a statutory filing as accepted.
 */

const ExpiryStanding = z.enum(["expired", "act_now", "upcoming", "current", "no_expiry"]);

const SubmissionState = z.enum([
  "due", "prepared", "submitted", "acknowledged", "rejected", "resubmitted", "waived",
]);

/** ISO 8601 calendar date. A date rather than a timestamp: an expiry is a day. */
const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

const ComplianceDocument = z.object({
  id: Uuid,
  kind: z.string(),
  name: z.string(),
  reference: z.string().nullable(),
  issuerName: z.string().nullable(),
  jurisdiction: z.string().nullable(),
  subjectType: z.string().nullable(),
  subjectId: Uuid.nullable(),
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  noticeDays: z.number().int(),
  requiredForWork: z.boolean(),
  state: z.enum(["active", "superseded", "withdrawn"]),
  supersedesId: Uuid.nullable(),
  notes: z.string().nullable(),
  /**
   * Worked out from the expiry date against the clock on every read, never
   * stored. A stored status is only correct while some sweep is running, and
   * a compliance screen whose failure mode is "everything looks current" is
   * the one failure mode that must not exist here.
   */
  standing: ExpiryStanding,
  daysUntilExpiry: z.number().int().nullable(),
  actBy: z.string().nullable(),
  /** One sentence about this document. Never a sentence about the business. */
  statement: z.string(),
});

const RegulatorySubmission = z.object({
  id: Uuid,
  kind: z.string(),
  authorityName: z.string(),
  jurisdiction: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  state: SubmissionState,
  dueOn: z.string().nullable(),
  route: z.string().nullable(),
  submittedAt: z.date().nullable(),
  acknowledgementReference: z.string().nullable(),
  acknowledgedAt: z.date().nullable(),
  rejectedAt: z.date().nullable(),
  rejectionReason: z.string().nullable(),
  supersedesId: Uuid.nullable(),
  overdue: z.boolean(),
  daysUntilDue: z.number().int().nullable(),
  statement: z.string(),
});

const RegulatoryConstant = z.object({
  key: z.string(),
  jurisdiction: z.string(),
  value: z.string(),
  unit: z.string().nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  basis: z.string().nullable(),
});

/* ------------------------------------------------------ document register */

export const listComplianceDocuments = defineRoute({
  method: "get",
  path: "/v1/compliance/documents",
  summary: "Documents on file and when each one runs out",
  description:
    "An inventory of what the operator put here, soonest expiry first, with documents that do not expire last. It cannot say whether the set is complete: which documents a business must hold depends on trade, jurisdiction, contract and insurer, and nothing in this product knows any of that. Replaced and withdrawn documents are excluded unless asked for, because the question is usually what is in force now, and kept rather than deleted because what was held on a past date is what gets asked about later.",
  module: "M23",
  permissions: ["document:read"],
  input: z.object({
    subjectType: z.string().max(60).optional(),
    subjectId: Uuid.optional(),
    kind: z.string().max(60).optional(),
    includeReplaced: z.boolean().optional(),
    /** Narrows to what needs attention, including everything already expired. */
    withinDays: z.number().int().min(0).max(3650).optional(),
  }),
  output: z.object({ documents: z.array(ComplianceDocument) }),
});

export const getComplianceSummary = defineRoute({
  method: "get",
  path: "/v1/compliance/documents/summary",
  summary: "How many documents are expired, due to be renewed, or neither",
  description:
    "Counts, deliberately, and no verdict. There is no overall status field and there will not be one: a single word assembled from these numbers would assert that the documents a business is required to hold are all present, which is a legal conclusion drawn from a set this register does not know the size of. A company with nothing on file produces the same zeroes as a company with everything.",
  module: "M23",
  permissions: ["document:read"],
  input: z.object({}),
  output: z.object({
    expired: z.number().int(),
    actNow: z.number().int(),
    upcoming: z.number().int(),
    noExpiry: z.number().int(),
    expiredAndRequiredForWork: z.number().int(),
  }),
});

export const listWorkBlockingDocuments = defineRoute({
  method: "get",
  path: "/v1/compliance/documents/blocking",
  summary: "Subjects carrying a lapsed document the operator marked as required for work",
  description:
    "The fact a dispatch board needs, and not the decision. It does not look at jobs and does not say a job cannot be dispatched: whether a particular job needs a particular licence is a judgement about the work and the jurisdiction. It says that this technician, asset or company holds a document the operator themselves flagged as required, and that it lapsed on a given date.",
  module: "M23",
  permissions: ["document:read"],
  input: z.object({}),
  output: z.object({
    subjects: z.array(z.object({
      subjectType: z.string().nullable(),
      subjectId: Uuid.nullable(),
      documents: z.array(ComplianceDocument),
    })),
  }),
});

export const registerComplianceDocument = defineRoute({
  method: "post",
  path: "/v1/compliance/documents",
  summary: "Put a document on file and its renewal in the work queue",
  description:
    "The expiry becomes an obligation, due at the end of the day the operator's own notice period points at and escalating on the expiry itself, so the renewal appears in the same queue as every other approaching deadline rather than on a screen somebody has to remember to open. A document with no expiry raises nothing, because inventing a date would put a false deadline in a real queue. Supplying a storage key that names no stored file is refused: a certificate link that opens nothing is worse than no link, because it gets relied on.",
  module: "M23",
  permissions: ["document:write"],
  idempotent: true,
  input: z.object({
    kind: z.string().min(1).max(60),
    name: z.string().min(1).max(200),
    reference: z.string().max(120).nullable().optional(),
    issuerName: z.string().max(200).nullable().optional(),
    jurisdiction: z.string().max(80).nullable().optional(),
    subjectType: z.string().max(60).nullable().optional(),
    subjectId: Uuid.nullable().optional(),
    issuedOn: CalendarDate.nullable().optional(),
    expiresOn: CalendarDate.nullable().optional(),
    /** The operator's own renewal lead time. Not a claim about any authority. */
    noticeDays: z.number().int().min(0).max(730).optional(),
    requiredForWork: z.boolean().optional(),
    notes: z.string().max(2000).nullable().optional(),
    /** A key already in the file store, from the upload endpoint. */
    storageKey: z.string().max(400).nullable().optional(),
  }),
  output: ComplianceDocument,
});

export const renewComplianceDocument = defineRoute({
  method: "post",
  path: "/v1/compliance/documents/{id}/renew",
  summary: "Record the replacement for a document",
  description:
    "A new row that supersedes the old one, never an edit. Editing the expiry in place answers when it runs out and destroys what was held in March, which is the question an insurer or a general contractor in a dispute actually asks. The old document's renewal obligation is cancelled rather than satisfied: it stopped being owed because the thing it was attached to was replaced.",
  module: "M23",
  permissions: ["document:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    kind: z.string().min(1).max(60),
    name: z.string().min(1).max(200),
    reference: z.string().max(120).nullable().optional(),
    issuerName: z.string().max(200).nullable().optional(),
    jurisdiction: z.string().max(80).nullable().optional(),
    issuedOn: CalendarDate.nullable().optional(),
    expiresOn: CalendarDate.nullable().optional(),
    noticeDays: z.number().int().min(0).max(730).optional(),
    requiredForWork: z.boolean().optional(),
    notes: z.string().max(2000).nullable().optional(),
    storageKey: z.string().max(400).nullable().optional(),
  }),
  output: ComplianceDocument,
});

export const withdrawComplianceDocument = defineRoute({
  method: "post",
  path: "/v1/compliance/documents/{id}/withdraw",
  summary: "Take a document out of force, with a reason",
  description:
    "For a document that was revoked, issued in error, or is no longer the operator's. The reason is required for the same reason declining a deficiency needs one: a withdrawn licence with no sentence beside it is indistinguishable from somebody tidying up, and the difference is the entire value of the record later.",
  module: "M23",
  permissions: ["document:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    reason: z.string().min(1).max(500),
  }),
  output: ComplianceDocument,
});

/* -------------------------------------------------- regulatory submissions */

export const listDeclaredSubmissions = defineRoute({
  method: "get",
  path: "/v1/compliance/submissions/declared",
  summary: "What this company's trade pack says it has to produce, and for whom",
  description:
    "Read from the trade pack rather than from a table, so a pack release that corrects an authority's name corrects it everywhere instead of only for companies set up afterwards. A pack declares a cadence and deliberately no due date offset: when a filing is due is a statutory fact that differs by jurisdiction and moves, and software that computed one would be telling a contractor what the law requires.",
  module: "M23",
  permissions: ["compliance:read"],
  input: z.object({}),
  output: z.object({
    submissions: z.array(z.object({
      kind: z.string(),
      label: z.string(),
      authorityName: z.string(),
      jurisdiction: z.string(),
      cadence: z.string(),
      route: z.string().nullable(),
      notes: z.string().nullable(),
    })),
  }),
});

export const listRegulatorySubmissions = defineRoute({
  method: "get",
  path: "/v1/compliance/submissions",
  summary: "The filing calendar: what is owed and what is late",
  description:
    "Overdue is worked out from the due date against the clock rather than read from the state column, so a sweep that is not running delays a stamp and never hides a deadline. Acknowledged, waived and superseded filings are excluded unless asked for, and the exclusion is written as NOT IN rather than as a list of live states, so a state added later shows up as work rather than vanishing.",
  module: "M23",
  permissions: ["compliance:read"],
  input: z.object({
    includeSettled: z.boolean().optional(),
    kind: z.string().max(80).optional(),
  }),
  output: z.object({ submissions: z.array(RegulatorySubmission) }),
});

export const openRegulatorySubmission = defineRoute({
  method: "post",
  path: "/v1/compliance/submissions",
  summary: "Open a filing that is owed for a period",
  description:
    "The due date is supplied and never computed, because a filing deadline is a statutory fact and deriving one from a cadence would be this software stating when the law says to file. Idempotent on the kind and the period, which is what the period is for: two people opening the same quarter get one filing. For a kind the trade pack declares, the authority, jurisdiction and route come from the pack and stating them here is refused, because the same fact in two places means a pack correction never reaches the row.",
  module: "M23",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    kind: z.string().min(1).max(80),
    dueOn: CalendarDate,
    periodStart: CalendarDate.nullable().optional(),
    periodEnd: CalendarDate.nullable().optional(),
    /** Only for a kind no trade pack declares. Refused otherwise. */
    authorityName: z.string().max(200).optional(),
    jurisdiction: z.string().max(80).optional(),
    route: z.enum(["portal", "api", "sftp", "email", "mail", "in_person"]).optional(),
  }),
  output: RegulatorySubmission,
});

export const advanceRegulatorySubmission = defineRoute({
  method: "post",
  path: "/v1/compliance/submissions/{id}/state",
  summary: "Record what happened to a filing",
  description:
    "Acknowledging requires the reference the authority gave: a confirmation number, a stamped receipt, a signed acknowledgement. Without it the row records a click rather than proof, and three years of those is a history that falls apart the first time it is tested. Note what an acknowledgement is and is not. It is a fact about receipt. It is not a finding that the contents were correct, and nothing here turns it into one. Submitting requires what was filed to be kept, because an authority may ask years later.",
  module: "M23",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /**
     * `resubmitted` is deliberately absent. A resubmission is a new filing
     * that supersedes the rejected one, so that what was rejected and what
     * the authority said about it both survive.
     */
    to: z.enum(["prepared", "submitted", "acknowledged", "rejected", "waived"]),
    reference: z.string().max(200).optional(),
    reason: z.string().max(1000).optional(),
    payload: z.record(z.unknown()).optional(),
  }),
  output: RegulatorySubmission,
});

export const resubmitRegulatorySubmission = defineRoute({
  method: "post",
  path: "/v1/compliance/submissions/{id}/resubmit",
  summary: "File a rejected submission again",
  description:
    "Creates a new filing pointing back at the rejected one and moves the old one to superseded, rather than reopening it. Only a rejected filing can be resubmitted: doing it to one that was acknowledged would put a second filing of the same period in front of an authority that already accepted the first.",
  module: "M23",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    dueOn: CalendarDate.optional(),
  }),
  output: RegulatorySubmission,
});

/* ---------------------------------------------------- regulatory constants */

export const publishRegulatoryConstant = defineRoute({
  method: "post",
  path: "/v1/compliance/constants",
  summary: "Publish the value of a figure that changes on a date",
  description:
    "A threshold, a rate, a fee or a limit, with the date it takes effect and the basis it came from. The previous value is closed rather than replaced, because a payroll export re-run for last January has to use last January's figure and a system that overwrote the number answers with this year's and shows no sign of it. This product ships no values of its own: a figure seeded here would be this software telling a contractor what a threshold is, and a wrong one would be wrong silently in every deployment until a release fixed it.",
  module: "M23",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    key: z.string().min(1).max(120),
    value: z.string().min(1).max(200),
    effectiveFrom: CalendarDate,
    jurisdiction: z.string().max(80).optional(),
    unit: z.string().max(40).nullable().optional(),
    /** Where the figure came from, so it can be re-checked rather than trusted. */
    basis: z.string().max(500).nullable().optional(),
  }),
  output: RegulatoryConstant,
});

export const getRegulatoryConstant = defineRoute({
  method: "get",
  path: "/v1/compliance/constants",
  summary: "The figure in force on a date, or why there is none",
  description:
    "Returns a result rather than failing when nothing covers the date, because 'no published figure covers that day' is the answer and the caller has to act on it. A caller that caught an error and fell back to a default would be a hardcoded constant with extra steps, which is the thing this whole table exists to prevent.",
  module: "M23",
  permissions: ["compliance:read"],
  input: z.object({
    key: z.string().min(1).max(120),
    on: CalendarDate,
    jurisdiction: z.string().max(80).optional(),
  }),
  output: z.union([
    z.object({ found: z.literal(true), constant: RegulatoryConstant }),
    z.object({
      found: z.literal(false),
      reason: z.string(),
      lastKnown: RegulatoryConstant.nullable(),
    }),
  ]),
});

export const listStaleRegulatoryConstants = defineRoute({
  method: "get",
  path: "/v1/compliance/constants/stale",
  summary: "Figures whose published window has run out",
  description:
    "A key whose latest window closed before today is a number somebody is still working to and nobody has renewed. It is a statement about this register and not about the figures themselves: it says there is no current published value here, not that what anybody is using is wrong.",
  module: "M23",
  permissions: ["compliance:read"],
  input: z.object({}),
  output: z.object({
    constants: z.array(z.object({
      key: z.string(),
      jurisdiction: z.string(),
      lastValue: z.string(),
      endedOn: z.string(),
    })),
  }),
});

export const complianceRoutes = {
  listComplianceDocuments,
  getComplianceSummary,
  listWorkBlockingDocuments,
  registerComplianceDocument,
  renewComplianceDocument,
  withdrawComplianceDocument,
  listDeclaredSubmissions,
  listRegulatorySubmissions,
  openRegulatorySubmission,
  advanceRegulatorySubmission,
  resubmitRegulatorySubmission,
  publishRegulatoryConstant,
  getRegulatoryConstant,
  listStaleRegulatoryConstants,
} as const;
