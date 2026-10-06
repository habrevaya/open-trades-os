import { z } from "zod";
import { defineRoute } from "../lib/define";
import { MoneyString, Uuid } from "./common";
import { RegisterLine } from "./payroll";

/**
 * M24 AND M17. A PERSON'S OWN RECORD, AND WHAT THE OFFICE ASKS THEM TO SIGN
 *
 * The `/v1/me` routes take no person: each is the signed in user's own
 * membership in this company, resolved from the session, so there is no id
 * to change to read somebody else's. Their record and what they do to it is
 * `profile:own`; their pay statements are `payroll:own`. Both are in every
 * preset. Anybody else's record stays `user:read`, at `/v1/people/{membershipId}`.
 *
 * The `/v1/staff-documents` routes are the office's side: the words people
 * sign, who was asked and who signed, under the roster's `user:read` and
 * `user:write`.
 */

const DateTime = z.string().datetime();

const Contact = z.object({
  id: Uuid, name: z.string(), relationship: z.string().nullable(), phone: z.string(),
  alternatePhone: z.string().nullable(), note: z.string().nullable(), priority: z.number().int(),
});

const OnboardingLine = z.object({
  id: Uuid, kind: z.string(), label: z.string(), required: z.boolean(),
  doneAt: DateTime.nullable(), doneBy: z.string().nullable(), note: z.string().nullable(),
  companyAssetId: Uuid.nullable(), doneByUserId: Uuid.nullable(),
  /** Done by signing this document rather than by a tick. */
  staffDocumentId: Uuid.nullable(),
});

const Onboarding = z.object({
  lines: z.array(OnboardingLine),
  progress: z.object({
    total: z.number().int(), done: z.number().int(), required: z.number().int(), requiredDone: z.number().int(),
    complete: z.boolean(), sentence: z.string(),
  }),
});

const OwnDocument = z.object({
  requestId: Uuid,
  documentId: Uuid,
  title: z.string(),
  /** The words, to read before signing. */
  body: z.string(),
  askedAt: DateTime,
  signedAt: DateTime.nullable(),
  signedVia: z.enum(["typed", "drawn"]).nullable(),
  signerName: z.string().nullable(),
});

const Certification = z.object({
  id: Uuid,
  code: z.string(),
  name: z.string(),
  authority: z.string().nullable(),
  reference: z.string().nullable(),
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  status: z.string(),
  current: z.boolean(),
  lapseReason: z.enum(["expired", "suspended", "revoked"]).nullable(),
  verifiedAt: DateTime.nullable(),
});

export const getMyRecord = defineRoute({
  method: "get",
  path: "/v1/me",
  summary: "Your own staff record",
  description:
    "The facts of your employment, the people to ring if you are hurt, your onboarding, the documents you were asked to sign, and, for somebody who goes out to jobs, your certifications with when each runs out and the continuing education toward each renewal. Never anybody else's: there is no person to name.",
  module: "M24",
  permissions: ["profile:own"],
  input: z.object({}),
  output: z.object({
    membershipId: Uuid,
    name: z.string(),
    email: z.string(),
    roleLabel: z.string(),
    branchName: z.string().nullable(),
    locationName: z.string().nullable(),
    technicianId: Uuid.nullable(),
    employment: z.object({
      jobTitle: z.string().nullable(), startedOn: z.string(), endedOn: z.string().nullable(),
      employmentType: z.string(), payType: z.string(), payrollReference: z.string().nullable(),
    }).nullable(),
    emergencyContacts: z.array(Contact),
    onboarding: Onboarding,
    documents: z.array(OwnDocument),
    certifications: z.array(Certification),
    continuingEducation: z.object({
      entries: z.array(z.object({
        id: Uuid, certificationTypeId: Uuid, completedOn: z.string(), hours: z.string(),
        course: z.string(), provider: z.string().nullable(), evidence: z.string().nullable(),
      })),
      progress: z.array(z.object({
        certificationTypeId: Uuid, name: z.string(),
        holding: z.object({ issuedOn: z.string().nullable(), expiresOn: z.string().nullable() }).nullable(),
        progress: z.object({
          required: z.string().nullable(), logged: z.string(), remaining: z.string().nullable(),
          met: z.boolean().nullable(), since: z.string().nullable(), sentence: z.string(),
        }),
      })),
    }).nullable(),
  }),
});

export const addMyEmergencyContact = defineRoute({
  method: "post",
  path: "/v1/me/emergency-contacts",
  summary: "Add somebody to ring if you are hurt",
  module: "M24",
  permissions: ["profile:own"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(200), relationship: z.string().max(100).nullable().optional(),
    phone: z.string().min(3).max(40), alternatePhone: z.string().max(40).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  }),
  output: z.object({ contacts: z.array(Contact) }),
});

export const removeMyEmergencyContact = defineRoute({
  method: "post",
  path: "/v1/me/emergency-contacts/{id}/remove",
  summary: "Take one of your emergency contacts off",
  description: "Only your own. Removing one already removed answers with your list.",
  module: "M24",
  permissions: ["profile:own"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ contacts: z.array(Contact) }),
});

export const setMyOnboardingLine = defineRoute({
  method: "post",
  path: "/v1/me/onboarding-lines/{id}",
  summary: "Tick one of your onboarding lines, or untick one you ticked",
  description:
    "Who ticked it is kept, so the office sees the lines you ticked yourself. A line the office ticked is theirs to untick, and a line that is a document is done by signing it.",
  module: "M24",
  permissions: ["profile:own"],
  idempotent: true,
  input: z.object({ id: Uuid, done: z.boolean(), note: z.string().max(500).nullable().optional() }),
  output: Onboarding,
});

export const signMyDocument = defineRoute({
  method: "post",
  path: "/v1/me/documents/{requestId}/sign",
  summary: "Sign a document you were asked to sign",
  description:
    "By typing your full name (`typedName`) or drawing your signature (`drawing`, a PNG data URL), exactly one. Kept as every signature here is: your name, your email, the moment, and a hash of the exact words you were shown; a drawing is kept as a picture beside it. Signing twice answers with the first signature, and signing ticks the onboarding line the document is.",
  module: "M24",
  permissions: ["profile:own"],
  idempotent: true,
  input: z.object({
    requestId: Uuid,
    typedName: z.string().max(200).nullable().optional(),
    drawing: z.string().max(300_000).nullable().optional(),
  }),
  output: OwnDocument,
});

export const getMyPayStatements = defineRoute({
  method: "get",
  path: "/v1/me/pay-statements",
  summary: "Your own pay statements and commission, for closed pay periods",
  description:
    "Your lines on the register for each period payroll has closed, worked out at the moment it closed, so they are the lines the payroll bureau was sent; and the commission behind them, invoice by invoice, with whether it has been paid. A year of periods at most. Open periods are not shown: they are still being corrected. `technician` is false for somebody with no place on the board, who has no hours, commission or tips here.",
  module: "M17",
  permissions: ["payroll:own"],
  input: z.object({}),
  output: z.object({
    technician: z.boolean(),
    statements: z.array(z.object({
      periodId: Uuid,
      label: z.string(),
      periodStart: DateTime,
      periodEnd: DateTime,
      closedAt: DateTime,
      statement: z.object({
        classification: z.string().nullable(),
        lines: z.array(RegisterLine),
        gross: MoneyString,
        /** What was paid back to you or allowed for a day away, with no tax taken from it. Not in `gross`. */
        nonTaxable: MoneyString,
        carriedForward: MoneyString,
        warnings: z.array(z.string()),
      }).nullable(),
      problems: z.array(z.string()),
      commissions: z.array(z.object({
        id: Uuid, invoiceNumber: z.number().int(), kind: z.string(), amount: MoneyString, explanation: z.string(),
        occurredAt: DateTime, paidAt: DateTime.nullable(),
      })),
    })),
  }),
});

/* ------------------------------------------------- the office's documents */

const DocumentSummary = z.object({
  id: Uuid, title: z.string(), retired: z.boolean(), createdAt: DateTime,
  asked: z.number().int(), signed: z.number().int(),
});

const DocumentView = z.object({
  id: Uuid,
  title: z.string(),
  body: z.string(),
  /** SHA-256 of the words, which every signature against them carries. */
  bodyHash: z.string(),
  retiredAt: DateTime.nullable(),
  createdAt: DateTime,
  requests: z.array(z.object({
    id: Uuid, membershipId: Uuid, name: z.string(), askedAt: DateTime,
    signedAt: DateTime.nullable(), signedVia: z.enum(["typed", "drawn"]).nullable(), signerName: z.string().nullable(),
  })),
});

export const listStaffDocuments = defineRoute({
  method: "get",
  path: "/v1/staff-documents",
  summary: "The documents the company asks its people to sign",
  description: "Each with how many people were asked and how many have signed. Retired ones too.",
  module: "M24",
  permissions: ["user:read"],
  input: z.object({}),
  output: z.object({ documents: z.array(DocumentSummary) }),
});

export const getStaffDocument = defineRoute({
  method: "get",
  path: "/v1/staff-documents/{id}",
  summary: "One document, and who has signed it",
  module: "M24",
  permissions: ["user:read"],
  input: z.object({ id: Uuid }),
  output: DocumentView,
});

export const createStaffDocument = defineRoute({
  method: "post",
  path: "/v1/staff-documents",
  summary: "Write a document for people to sign",
  description:
    "The words cannot be changed afterwards, because a signature is worth what the record of what was signed is worth: a new version is a new document, and the old one is retired with its signatures intact.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(100_000) }),
  output: DocumentView,
});

export const retireStaffDocument = defineRoute({
  method: "post",
  path: "/v1/staff-documents/{id}/retire",
  summary: "Stop asking anybody new to sign a document",
  description: "Whoever was already asked can still sign it, and every signature stays.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: DocumentView,
});

export const askToSignStaffDocument = defineRoute({
  method: "post",
  path: "/v1/staff-documents/{id}/requests",
  summary: "Ask people to sign a document",
  description: "It appears on their own record to read and sign. Asking somebody already asked asks once. A retired document asks nobody new.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ id: Uuid, membershipIds: z.array(Uuid).min(1).max(500) }),
  output: DocumentView,
});

export const selfServiceRoutes = {
  getMyRecord, addMyEmergencyContact, removeMyEmergencyContact, setMyOnboardingLine, signMyDocument,
  getMyPayStatements,
  listStaffDocuments, getStaffDocument, createStaffDocument, retireStaffDocument, askToSignStaffDocument,
} as const;
