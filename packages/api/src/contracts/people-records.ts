import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * M24. WHAT THE OFFICE KEEPS ABOUT A PERSON: onboarding against a checklist
 * for their role, emergency contacts, the basic facts of their employment,
 * skills with dates and evidence, continuing education toward a renewal, and
 * the skills one job asks for beyond its type.
 *
 * The roster's permissions, `user:read` and `user:write`, for everything
 * about a person as an employee. Continuing education is `compliance:*`,
 * beside the certification register. No pay amounts anywhere here.
 */

const DateString = z.string().date();
const Kind = z.enum(["document", "training", "equipment", "other"]);
const RoleName = z.enum([
  "owner", "admin", "office_manager", "branch_manager", "dispatcher", "csr", "technician", "crew_lead", "accountant", "readonly",
]);

const Progress = z.object({
  total: z.number().int(), done: z.number().int(), required: z.number().int(), requiredDone: z.number().int(),
  /** Every required line done. Somebody with no lines is not complete: nothing was asked. */
  complete: z.boolean(),
  sentence: z.string(),
});

const TemplateItem = z.object({
  id: Uuid, role: z.string().nullable(), roleId: Uuid.nullable(), roleLabel: z.string(),
  kind: z.string(), label: z.string(), required: z.boolean(), sortOrder: z.number().int(),
  /** A document the person signs themselves to do this line, and its title. */
  staffDocumentId: Uuid.nullable(), documentTitle: z.string().nullable(),
});

const Onboarding = z.object({
  lines: z.array(z.object({
    id: Uuid, kind: z.string(), label: z.string(), required: z.boolean(),
    doneAt: z.string().datetime().nullable(), doneBy: z.string().nullable(), note: z.string().nullable(),
    companyAssetId: Uuid.nullable(), doneByUserId: Uuid.nullable(),
    /** Done by the person signing this document, which ticks it. */
    staffDocumentId: Uuid.nullable(),
  })),
  progress: Progress,
});

const Contact = z.object({
  id: Uuid, name: z.string(), relationship: z.string().nullable(), phone: z.string(),
  alternatePhone: z.string().nullable(), note: z.string().nullable(), priority: z.number().int(),
});

const EmploymentType = z.enum(["full_time", "part_time", "seasonal", "temporary", "contractor"]);
const PayType = z.enum(["hourly", "salary", "piece_rate", "commission_only"]);
const Employment = z.object({
  jobTitle: z.string().nullable(), startedOn: z.string(), endedOn: z.string().nullable(),
  employmentType: EmploymentType, payType: PayType, payrollReference: z.string().nullable(),
});

const SkillRecord = z.object({
  id: Uuid, skill: z.string(), since: z.string(), evidence: z.string(), recordedBy: z.string().nullable(),
  endedOn: z.string().nullable(), endedReason: z.string().nullable(),
  /** The last day the record stands. Null does not expire. */
  expiresOn: z.string().nullable(),
  renewalLeadDays: z.number().int(),
  expiry: z.object({
    state: z.enum(["none", "current", "expiring", "expired"]),
    daysRemaining: z.number().int().nullable(),
    sentence: z.string(),
  }),
});
const Skills = z.object({
  current: z.array(z.object({ skill: z.string(), record: SkillRecord.nullable() })),
  orphaned: z.array(SkillRecord),
  ended: z.array(SkillRecord),
});

const CeProgress = z.object({
  required: z.string().nullable(), logged: z.string(), remaining: z.string().nullable(),
  met: z.boolean().nullable(), since: z.string().nullable(), sentence: z.string(),
});
export const CeSchema = z.object({
  entries: z.array(z.object({
    id: Uuid, certificationTypeId: Uuid, completedOn: z.string(), hours: z.string(),
    course: z.string(), provider: z.string().nullable(), evidence: z.string().nullable(),
    /** Only approved hours count toward a renewal. A person's own wait as pending for the office. */
    status: z.enum(["pending", "approved", "declined"]),
    selfLogged: z.boolean(),
    declineReason: z.string().nullable(),
    /** Photographs of the certificate kept with it. */
    certificates: z.number().int(),
  })),
  progress: z.array(z.object({
    certificationTypeId: Uuid, name: z.string(),
    holding: z.object({ issuedOn: z.string().nullable(), expiresOn: z.string().nullable() }).nullable(),
    /** Counts approved hours only. */
    progress: CeProgress,
    /** Hours a person logged that wait for the office and are not counted yet. */
    pendingHours: z.string(),
  })),
});
const Ce = CeSchema;

export const listPeopleRoster = defineRoute({
  method: "get",
  path: "/v1/roster",
  summary: "Everybody, with onboarding progress and whether anybody is on file to ring",
  module: "M24",
  permissions: ["user:read"],
  input: z.object({}),
  output: z.object({
    people: z.array(z.object({
      membershipId: Uuid, name: z.string().nullable(), email: z.string(), roleLabel: z.string(), active: z.boolean(),
      technicianId: Uuid.nullable(), startedOn: z.string().nullable(), onboarding: Progress, emergencyContacts: z.number().int(),
    })),
  }),
});

export const getPersonRecord = defineRoute({
  method: "get",
  path: "/v1/people/{membershipId}",
  summary: "One person: who they report to, onboarding, emergency contacts, employment and skills",
  description: "Certifications and continuing education are not here: they are compliance records, behind `compliance:read`, at `/v1/certifications` and `/v1/technicians/{technicianId}/continuing-education`.",
  module: "M24",
  permissions: ["user:read"],
  input: z.object({ membershipId: Uuid }),
  output: z.object({
    membershipId: Uuid, name: z.string().nullable(), email: z.string(), role: z.string(), roleLabel: z.string(),
    active: z.boolean(), technicianId: Uuid.nullable(),
    onboarding: Onboarding, emergencyContacts: z.array(Contact), employment: Employment.nullable(), skills: Skills.nullable(),
    /** Who they report to, as set on the escalation screen (`POST /v1/reporting-lines`, M34). Null when nobody is recorded. */
    reportsTo: z.object({ membershipId: Uuid, name: z.string().nullable(), email: z.string(), active: z.boolean() }).nullable(),
    /** What they were asked to sign, and whether and how they did. */
    documents: z.array(z.object({
      requestId: Uuid, documentId: Uuid, title: z.string(), askedAt: z.string().datetime(),
      signedAt: z.string().datetime().nullable(), signedVia: z.enum(["typed", "drawn"]).nullable(),
    })),
  }),
});

export const listOnboardingTemplate = defineRoute({
  method: "get",
  path: "/v1/onboarding-checklist",
  summary: "The onboarding checklist for each role",
  module: "M24",
  permissions: ["user:read"],
  input: z.object({}),
  output: z.object({ items: z.array(TemplateItem) }),
});

export const addOnboardingTemplateItem = defineRoute({
  method: "post",
  path: "/v1/onboarding-checklist",
  summary: "Add a line to a role's onboarding checklist",
  description: "A document to collect, training to give, or equipment to hand over, for a preset role (`role`) or one of the company's own (`roleId`), exactly one. A document line can name a document the person signs themselves (`staffDocumentId`): starting their onboarding asks them to sign it, and their signature ticks the line.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({
    role: RoleName.nullable().optional(), roleId: Uuid.nullable().optional(),
    kind: Kind, label: z.string().min(1).max(300), required: z.boolean().optional(),
    staffDocumentId: Uuid.nullable().optional(),
  }),
  output: TemplateItem,
});

export const removeOnboardingTemplateItem = defineRoute({
  method: "post",
  path: "/v1/onboarding-checklist/{id}/remove",
  summary: "Take a line off a role's checklist",
  description: "People already started keep their copy of it.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.boolean() }),
});

export const startOnboarding = defineRoute({
  method: "post",
  path: "/v1/people/{membershipId}/onboarding",
  summary: "Start somebody's onboarding",
  description: "Copies the checklist for their role onto them. Run again after the checklist grows and only the new lines are added; each line is copied once per person.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ membershipId: Uuid }),
  output: z.object({ added: z.number().int(), onboarding: Onboarding }),
});

export const setOnboardingLine = defineRoute({
  method: "post",
  path: "/v1/onboarding-lines/{id}",
  summary: "Tick or untick an onboarding line",
  description: "Who ticked it and when are kept. The note says what was collected or handed over; equipment can name the asset on the fleet register.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({
    id: Uuid, done: z.boolean(), note: z.string().max(500).nullable().optional(), companyAssetId: Uuid.nullable().optional(),
  }),
  output: Onboarding,
});

export const addEmergencyContact = defineRoute({
  method: "post",
  path: "/v1/people/{membershipId}/emergency-contacts",
  summary: "Add somebody to ring in an emergency",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({
    membershipId: Uuid, name: z.string().min(1).max(200), relationship: z.string().max(100).nullable().optional(),
    phone: z.string().min(3).max(40), alternatePhone: z.string().max(40).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  }),
  output: z.object({ contacts: z.array(Contact) }),
});

export const removeEmergencyContact = defineRoute({
  method: "post",
  path: "/v1/emergency-contacts/{id}/remove",
  summary: "Remove an emergency contact",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ contacts: z.array(Contact) }),
});

export const setEmploymentRecord = defineRoute({
  method: "put",
  path: "/v1/people/{membershipId}/employment",
  summary: "Set the basic facts of somebody's employment",
  description: "Start date, employment type, how they are paid and the id payroll knows them by. Never a rate or an amount: those are payroll's, behind `payroll:read`.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({
    membershipId: Uuid, jobTitle: z.string().max(200).nullable().optional(),
    startedOn: DateString, endedOn: DateString.nullable().optional(),
    employmentType: EmploymentType, payType: PayType, payrollReference: z.string().max(100).nullable().optional(),
  }),
  output: Employment,
});

export const listTechnicianSkills = defineRoute({
  method: "get",
  path: "/v1/technicians/{technicianId}/skills",
  summary: "A technician's skills, with since when and the evidence",
  module: "M24",
  permissions: ["user:read"],
  input: z.object({ technicianId: Uuid }),
  output: Skills,
});

export const recordTechnicianSkill = defineRoute({
  method: "post",
  path: "/v1/technicians/{technicianId}/skills",
  summary: "Record a skill with since when and what showed it",
  description: "Puts it on the list the assignment check reads. Evidence is required: a skill with none is the opaque string this record replaces.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({
    technicianId: Uuid, skill: z.string().min(1).max(100), since: DateString, evidence: z.string().min(1).max(1000),
    expiresOn: DateString.nullable().optional(), renewalLeadDays: z.number().int().min(0).max(730).optional(),
  }),
  output: Skills,
});

export const setTechnicianSkillExpiry = defineRoute({
  method: "post",
  path: "/v1/technician-skills/{id}/expiry",
  summary: "Give a skill record its own expiry, move it, or take it off",
  description: "The last day the record stands: good on that day and expired from the next, as a certification's is. From then the skill stays on the person's list and no longer clears the assignment check, and it is warned from `renewalLeadDays` before (30 when not given) on the list of skills to renew. `expiresOn: null` makes it not expire. Moving it is renewing it; the earlier day stays in the audit log. A day that has already passed is refused.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ id: Uuid, expiresOn: DateString.nullable(), renewalLeadDays: z.number().int().min(0).max(730).optional() }),
  output: Skills,
});

export const listExpiringTechnicianSkills = defineRoute({
  method: "get",
  path: "/v1/technician-skills/expiring",
  summary: "Skills about to run out, and the ones that have",
  description: "Open skill records with an expiry, each put on by its own notice period, or by `within` days ahead when given. Already expired ones are included and flagged, because a list that drops a skill the day it lapses is empty exactly when somebody needed it.",
  module: "M24",
  permissions: ["user:read"],
  input: z.object({ within: z.number().int().min(0).max(3650).optional() }),
  output: z.object({
    expiring: z.array(z.object({
      id: Uuid, technicianId: Uuid, technicianName: z.string(), skill: z.string(),
      expiresOn: DateString, daysRemaining: z.number().int(), renewalLeadDays: z.number().int(),
      current: z.boolean(), sentence: z.string(),
    })),
  }),
});

export const endTechnicianSkill = defineRoute({
  method: "post",
  path: "/v1/technician-skills/{id}/end",
  summary: "End a skill",
  description: "Takes it off the list the assignment check reads and keeps the record with the day and the reason.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().min(1).max(500), endedOn: DateString.optional() }),
  output: Skills,
});

export const listContinuingEducation = defineRoute({
  method: "get",
  path: "/v1/technicians/{technicianId}/continuing-education",
  summary: "Continuing education hours, and progress toward each renewal",
  description: "Hours counted from the day the current holding was issued, against the certification type's requirement, so the hours behind the last renewal do not count twice.",
  module: "M24",
  permissions: ["compliance:read"],
  input: z.object({ technicianId: Uuid }),
  output: Ce,
});

export const logContinuingEducation = defineRoute({
  method: "post",
  path: "/v1/technicians/{technicianId}/continuing-education",
  summary: "Log hours of continuing education",
  module: "M24",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({
    technicianId: Uuid, certificationTypeId: Uuid, completedOn: DateString,
    hours: z.string().regex(/^\d+(\.\d{1,2})?$/), course: z.string().min(1).max(300),
    provider: z.string().max(200).nullable().optional(), evidence: z.string().max(500).nullable().optional(),
  }),
  output: Ce,
});

export const listPendingContinuingEducation = defineRoute({
  method: "get",
  path: "/v1/continuing-education/pending",
  summary: "Hours people logged themselves that wait for the office",
  description: "Every self-logged entry nobody has answered, oldest first, with how many photographs of the certificate came with it. The photograph is read at `/certifications/continuing-education/{id}/certificate` by whoever reads the register.",
  module: "M24",
  permissions: ["compliance:read"],
  input: z.object({}),
  output: z.object({
    pending: z.array(z.object({
      id: Uuid, technicianId: Uuid, technicianName: z.string(),
      certificationTypeId: Uuid, certificationName: z.string(),
      completedOn: z.string(), hours: z.string(), course: z.string(),
      provider: z.string().nullable(), evidence: z.string().nullable(),
      certificates: z.number().int(), loggedAt: z.string().datetime(),
    })),
  }),
});

export const approveContinuingEducation = defineRoute({
  method: "post",
  path: "/v1/continuing-education/{id}/approve",
  summary: "Count a person's own hours toward their renewal",
  description: "The office has looked at the certificate. Only approved hours are counted. Approving hours already approved answers with the same list; a declined entry is not approved afterwards, the person logs it again.",
  module: "M24",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Ce,
});

export const declineContinuingEducation = defineRoute({
  method: "post",
  path: "/v1/continuing-education/{id}/decline",
  summary: "Turn a person's own hours down, with the reason they will read",
  description: "The hours stay on the person's record as declined with the reason and are never counted. Hours already approved cannot be declined; remove them instead.",
  module: "M24",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().trim().min(1).max(500) }),
  output: Ce,
});

export const removeContinuingEducation = defineRoute({
  method: "post",
  path: "/v1/continuing-education/{id}/remove",
  summary: "Remove hours logged in error",
  module: "M24",
  permissions: ["compliance:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Ce,
});

const JobSkills = z.object({
  id: Uuid,
  /** What the job asks for beyond its type. */
  skills: z.array(z.string()),
  /** What its type asks for, dropped or not. */
  typeSkills: z.array(z.string()),
  /** The type's skills this job dropped, each with why, who and when. */
  dropped: z.array(z.object({
    skill: z.string(), reason: z.string(), droppedAt: z.string().datetime(), droppedBy: z.string().nullable(),
  })),
  /** What is checked for whoever is sent: the type's less the dropped, plus the job's own. */
  checked: z.array(z.string()),
});

export const getJobSkills = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}/required-skills",
  summary: "The skills a job needs: its type's, and its own",
  module: "M24",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: JobSkills,
});

export const setJobSkills = defineRoute({
  method: "put",
  path: "/v1/jobs/{id}/required-skills",
  summary: "Set the skills this one job needs beyond its type",
  description: "Replaces the job's own list; the type's still apply and are not repeated here. Checked from then on wherever the type's are: assigning on the board or through the API, booking a visit, a crew, and the suggestions.",
  module: "M24",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, skills: z.array(z.string().max(100)).max(50) }),
  output: JobSkills,
});

export const dropJobSkill = defineRoute({
  method: "post",
  path: "/v1/jobs/{id}/dropped-skills",
  summary: "Drop one of the job type's skills for this one job, with a reason",
  description: "The skill is no longer asked of whoever is sent on this job: not on the board, at booking, for a crew or in the suggestions. Only a skill the job's type asks for can be dropped, and the reason is kept and shown wherever the job's skills are read, and in the audit entry of each assignment made while it stands. Needs visit:assign_unqualified as well as job:write, because it lets people be sent without the skill with no override at the moment they are sent. Dropping a skill already dropped changes nothing.",
  module: "M10",
  permissions: ["job:write", "visit:assign_unqualified"],
  idempotent: true,
  input: z.object({ id: Uuid, skill: z.string().trim().min(1).max(100), reason: z.string().trim().min(5).max(500) }),
  output: JobSkills,
});

export const restoreJobSkill = defineRoute({
  method: "post",
  path: "/v1/jobs/{id}/dropped-skills/restore",
  summary: "Ask for a dropped skill on this job again",
  description: "Takes the skill off the job's dropped list so it is checked again. Tightens the check, so it needs only job:write. Restoring a skill that is not dropped changes nothing.",
  module: "M10",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, skill: z.string().trim().min(1).max(100) }),
  output: JobSkills,
});

export const peopleRecordRoutes = {
  listPeopleRoster, getPersonRecord, listOnboardingTemplate, addOnboardingTemplateItem, removeOnboardingTemplateItem,
  startOnboarding, setOnboardingLine, addEmergencyContact, removeEmergencyContact, setEmploymentRecord,
  listTechnicianSkills, recordTechnicianSkill, setTechnicianSkillExpiry, listExpiringTechnicianSkills, endTechnicianSkill,
  listContinuingEducation, logContinuingEducation, listPendingContinuingEducation, approveContinuingEducation,
  declineContinuingEducation, removeContinuingEducation,
  getJobSkills, setJobSkills, dropJobSkill, restoreJobSkill,
} as const;
