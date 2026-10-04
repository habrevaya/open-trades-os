import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { CustomFieldListFilter } from "./custom-fields";

/**
 * PEOPLE, AND THE DOOR
 *
 * `membership.active` decides whether a sign in succeeds: the login path
 * looks for an active membership and refuses when there is none. Nothing in
 * this product could set it to false.
 *
 * An employee who left on Friday kept a working password, their existing
 * sessions, and every permission their role carried. The only way to stop
 * them was to delete the user row, which takes the audit trail of everything
 * they ever did with it, so in practice nobody did.
 */
export const setMembershipActive = defineRoute({
  method: "post",
  path: "/v1/memberships/{membershipId}/active",
  summary: "Offboard somebody, or bring them back",
  description:
    "Deactivated, not deleted: every job they ran and every timeclock entry they closed points at them, and 'who was on site' has to have an answer years later. Existing sessions are revoked in the same transaction, because flipping the flag alone leaves anybody already signed in signed in for days, and an offboarding that takes effect on Thursday is not an offboarding.",
  module: "M01",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({
    membershipId: Uuid,
    active: z.boolean(),
    reason: z.string().max(500).optional(),
  }),
  output: z.object({
    id: Uuid,
    active: z.boolean(),
    /** How many live sessions were ended. Zero on a reactivation. */
    sessionsRevoked: z.number().int(),
  }),
});


/**
 * M24. CERTIFICATIONS, AND THE REFUSAL THEY MAKE POSSIBLE.
 *
 * `job_type.required_skills` and `crew.skills` are lists of opaque strings,
 * and `services/crews.ts` refuses a crew whose list does not contain one the
 * work needs. That is the only qualification check in this product and the
 * most it can ever say is that a string is missing.
 *
 * These routes are what make those strings real: a certification type says
 * which skills it grants, a person holds one with an issue date, an expiry
 * and a status, and `getSkillStanding` answers whether a named group of
 * people covers a set of required skills today, naming the certification and
 * the date when they do not.
 *
 * NO FILE GOES THROUGH ANY OF THESE. The certificate itself is a document,
 * documents belong to M23, and the evidence attaches through the existing
 * `attachment` path with entity_type `person_certification`.
 */

const CertificationStatus = z.enum(["active", "suspended", "revoked"]);

const HeldCertification = z.object({
  id: Uuid,
  technicianId: Uuid,
  technicianName: z.string(),
  certificationTypeId: Uuid,
  code: z.string(),
  name: z.string(),
  authority: z.string().nullable(),
  grantsSkills: z.array(z.string()),
  reference: z.string().nullable(),
  issuedOn: z.string().date().nullable(),
  expiresOn: z.string().date().nullable(),
  status: CertificationStatus,
  statusReason: z.string().nullable(),
  /** Computed against the day asked about, never a stored column. */
  current: z.boolean(),
  /** Why it does not count today. Null when it does. */
  lapseReason: z.enum(["expired", "suspended", "revoked"]).nullable(),
  verifiedAt: z.string().datetime().nullable(),
  verifiedByUserId: Uuid.nullable(),
});

export const listPeople = defineRoute({
  method: "get",
  path: "/v1/people",
  summary: "Everybody who works here",
  description:
    "Memberships and the technician profile attached to each, which is the list an office manager maintains, with each person's name and email, so a technician in another system can be matched to the technician id a visit names. The name and email come through a function that answers for this company's members only, because a user row is visible to that user alone under row level security and a join to it returned the caller's own address and nobody else's. No certifications, because a licence number against a named person is a compliance record and this is guarded by user:read. No technician.skills either: that column exists and nothing in this product has ever written one, so returning it would put an empty array on every person and teach whoever read it that nobody is qualified for anything.",
  module: "M24",
  permissions: ["user:read"],
  input: z.object({
    /** Exact, case insensitive. For matching a person from another system. */
    email: z.string().max(320).optional(),
    /** Technicians whose own field holds a value; somebody who is not a technician has none. */
    ...CustomFieldListFilter,
  }),
  output: z.object({
    people: z.array(z.object({
      membershipId: Uuid,
      userId: Uuid,
      name: z.string().nullable(),
      email: z.string(),
      role: z.string(),
      active: z.boolean(),
      technicianId: Uuid.nullable(),
      displayName: z.string().nullable(),
      technicianActive: z.boolean().nullable(),
      /** The technician's own fields (M29), or null for somebody who is not a technician. */
      customFields: z.record(z.unknown()).nullable(),
    })),
  }),
});

export const listCertificationTypes = defineRoute({
  method: "get",
  path: "/v1/certification-types",
  summary: "What this company recognises",
  module: "M24",
  permissions: ["compliance:read"],
  input: z.object({}),
  output: z.object({
    types: z.array(z.object({
      id: Uuid,
      code: z.string(),
      name: z.string(),
      authority: z.string().nullable(),
      grantsSkills: z.array(z.string()),
      expires: z.boolean(),
      defaultValidMonths: z.number().int().nullable(),
      renewalLeadDays: z.number().int(),
      /** Continuing education hours a renewal needs, or null when it needs none. */
      ceHoursRequired: z.string().nullable(),
      active: z.boolean(),
      note: z.string().nullable(),
    })),
  }),
});

export const defineCertificationType = defineRoute({
  method: "post",
  path: "/v1/certification-types",
  summary: "Declare a certification and the work it unlocks",
  description:
    "grantsSkills names the skill strings this certification makes true, matched against job_type.required_skills by exact equality. A certification that unlocks nothing is allowed: a first aid certificate is worth an expiry date without any job type requiring it.",
  module: "M24",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    code: z.string().min(1).max(60),
    name: z.string().min(1).max(200),
    authority: z.string().max(200).nullable().optional(),
    grantsSkills: z.array(z.string().max(100)).max(50).optional(),
    /** Default true. Almost every trade certification runs out. */
    expires: z.boolean().optional(),
    defaultValidMonths: z.number().int().positive().max(600).nullable().optional(),
    renewalLeadDays: z.number().int().min(0).max(3650).optional(),
    /** Continuing education hours a renewal needs, where the authority asks for any: "16", "7.5". */
    ceHoursRequired: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  }),
  output: z.object({
    id: Uuid, code: z.string(), name: z.string(),
    expires: z.boolean(), active: z.boolean(),
  }),
});

export const updateCertificationType = defineRoute({
  method: "patch",
  path: "/v1/certification-types/{id}",
  summary: "Change a certification type, or retire it",
  description:
    "Whether it expires is deliberately not editable. Flipping that on a type with holdings reinterprets every one of them: a null expiry stops meaning 'does not run out' and starts meaning 'nobody recorded when it did', and a check that cleared this morning refuses this afternoon with no row having changed.",
  module: "M24",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    authority: z.string().max(200).nullable().optional(),
    grantsSkills: z.array(z.string().max(100)).max(50).optional(),
    defaultValidMonths: z.number().int().positive().max(600).nullable().optional(),
    renewalLeadDays: z.number().int().min(0).max(3650).optional(),
    /** Continuing education hours a renewal needs, where the authority asks for any: "16", "7.5". */
    ceHoursRequired: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    active: z.boolean().optional(),
  }),
  output: z.object({
    id: Uuid, code: z.string(), name: z.string(),
    expires: z.boolean(), active: z.boolean(),
  }),
});

export const listCertifications = defineRoute({
  method: "get",
  path: "/v1/certifications",
  summary: "What people hold",
  description:
    "Includes the lapsed and the revoked. A list showing only what is current answers 'who can work today' and silently loses the record that somebody's licence was pulled, which is the row a compliance officer came for.",
  module: "M24",
  permissions: ["compliance:read"],
  input: z.object({
    technicianId: Uuid.optional(),
    /** The day to judge currency against. Defaults to today in the company's zone. */
    on: z.string().date().optional(),
  }),
  output: z.object({ certifications: z.array(HeldCertification) }),
});

export const recordCertification = defineRoute({
  method: "post",
  path: "/v1/certifications",
  summary: "Record that somebody holds a certification",
  description:
    "Renewing is calling this again with the new dates; the old row stays, because 'was this person certified on the day they did that work' is the question these rows exist to answer. A type that expires is refused without an expiry date unless it carries a default validity and an issue date to count from.",
  module: "M24",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    technicianId: Uuid,
    certificationTypeId: Uuid,
    reference: z.string().max(120).nullable().optional(),
    issuedOn: z.string().date().nullable().optional(),
    expiresOn: z.string().date().nullable().optional(),
  }),
  output: z.object({
    id: Uuid,
    technicianId: Uuid,
    certificationTypeId: Uuid,
    issuedOn: z.string().date().nullable(),
    expiresOn: z.string().date().nullable(),
    status: CertificationStatus,
  }),
});

export const verifyCertification = defineRoute({
  method: "post",
  path: "/v1/certifications/{id}/verify",
  summary: "Somebody looked at the actual card",
  description:
    "Separate from recording it, because recording is usually an office manager typing from an email and verifying is somebody holding the licence in their hand. A company being audited is asked which of the two happened.",
  module: "M24",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({ id: Uuid, note: z.string().max(1000).nullable().optional() }),
  output: z.object({
    id: Uuid,
    verifiedAt: z.string().datetime(),
    verifiedByUserId: Uuid.nullable(),
  }),
});

export const setCertificationStatus = defineRoute({
  method: "post",
  path: "/v1/certifications/{id}/status",
  summary: "Suspend, revoke or reinstate",
  description:
    "Separate from expiry, which is computed from the date and never stored. A suspension can be lifted and a revocation cannot: a revoked certification is reissued as a new record with its own dates, so this refuses to turn one back on. A reason is required on anything but a reinstatement.",
  module: "M24",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    status: CertificationStatus,
    reason: z.string().max(1000).nullable().optional(),
  }),
  output: z.object({
    id: Uuid, status: CertificationStatus, statusReason: z.string().nullable(),
  }),
});

export const listExpiringCertifications = defineRoute({
  method: "get",
  path: "/v1/certifications/expiring",
  summary: "What is about to run out, and what already has",
  description:
    "The window is each certification type's own renewal notice period unless one is given, because a licence that takes a day of paperwork and one that takes six weeks of continuing education do not want the same warning. Already expired rows are included and flagged: a renewal list that drops a certification the moment it lapses is empty exactly when somebody needed it.",
  module: "M24",
  permissions: ["compliance:read"],
  input: z.object({ within: z.number().int().min(0).max(3650).optional() }),
  output: z.object({
    expiring: z.array(HeldCertification.extend({
      daysRemaining: z.number().int(),
      renewalLeadDays: z.number().int(),
    })),
  }),
});

export const getSkillStanding = defineRoute({
  method: "post",
  path: "/v1/people/skill-standing",
  summary: "Can these people do this work, and if not why not",
  description:
    "Four answers per skill. covered: somebody here holds a live certification. lapsed: one exists and none of them counts today, and the explanation names whose and when it went. absent: this company recognises a certification for it and nobody here holds one. uncertified: no certification type grants this skill, so this module has nothing to say about it and a caller must not read that as a clearance.",
  module: "M24",
  permissions: ["compliance:read"],
  /**
   * A POST that reads, because the question carries two arrays and a date and
   * a query string full of repeated parameters is the version of this nobody
   * can hand to a client. It changes nothing, so a retry is the same answer:
   * the contract says so rather than leaving a POST on this API that looks
   * unsafe to repeat.
   */
  idempotent: true,
  input: z.object({
    technicianIds: z.array(Uuid).max(200),
    skills: z.array(z.string().max(100)).max(50),
    on: z.string().date().optional(),
  }),
  output: z.object({
    on: z.string().date(),
    standing: z.array(z.object({
      skill: z.string(),
      state: z.enum(["covered", "lapsed", "absent", "uncertified"]),
      explanation: z.string(),
      evidence: z.array(HeldCertification),
    })),
  }),
});

/**
 * `setMembershipActive` is M01's and stays exactly where it was: the offboard
 * path is about the door rather than about qualifications, and every caller
 * naming it keeps working.
 */
export const peopleRoutes = {
  setMembershipActive,
  listPeople,
  listCertificationTypes, defineCertificationType, updateCertificationType,
  listCertifications, recordCertification, verifyCertification, setCertificationStatus,
  listExpiringCertifications, getSkillStanding,
} as const;
