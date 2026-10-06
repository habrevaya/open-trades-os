import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, PageRequest, pageOf, Timestamps, ExternalRef, ExternalLookup } from "./common";
import { CustomFieldListFilter } from "./custom-fields";

/**
 * WHOSE PRICE GOVERNS.
 *
 * Published as a bare string while nothing wrote it, so a generated client
 * had a field that was always the literal "price_book". The five values are
 * the segments where our price book is not the authority, named in the
 * schema's own comment: a commercial contract rate card, a warranty network
 * schedule, a manufacturer labour allowance, an insurance price list, or a
 * bid we submitted.
 *
 * Cost tracking stays ours regardless, which is what keeps margin reporting
 * honest on work we did not price.
 */
export const PriceSource = z.enum([
  "price_book", "rate_card", "warranty_schedule",
  "manufacturer_allowance", "insurance_schedule", "bid",
]);

export const JobStatus = z.enum([
  "lead", "estimating", "scheduled", "in_progress", "on_hold",
  "completed", "invoiced", "paid", "cancelled",
]);

export const VisitStatus = z.enum([
  "unassigned", "scheduled", "dispatched", "en_route", "working",
  "completed", "cancelled", "no_show", "completed_after_cancellation",
]);

export const PartyRole = z.enum([
  "requester", "site_contact", "approver", "bill_to", "payer", "referrer", "owner",
]);

export const CoverageSource = z.enum([
  "customer", "agreement", "parts_warranty", "labour_warranty", "our_warranty",
  "home_warranty", "insurance", "goodwill", "no_charge_callback", "contract",
]);

/**
 * A visit is what gets dispatched. A job is what gets invoiced.
 *
 * One job has many visits and that is the normal case, not an edge case: a
 * diagnostic trip, a parts return trip and a two day install are one job. The
 * window is a WINDOW, because contractors promise "between one and four" and
 * storing a single timestamp is what produces the angry review.
 */
export const Visit = z.object({
  id: Uuid,
  jobId: Uuid,
  sequence: z.number().int(),
  status: VisitStatus,
  windowStart: z.string().datetime().nullable(),
  windowEnd: z.string().datetime().nullable(),
  estimatedDurationMinutes: z.number().int(),
  routeOrder: z.number().int().nullable(),
  technicianIds: z.array(Uuid),
  crewId: Uuid.nullable(),
  dispatchedAt: z.string().datetime().nullable(),
  arrivedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  technicianNotes: z.string().nullable(),
  /** What the customer reads about the visit on their account, as the office chose to share it. */
  customerNotes: z.string().nullable(),
  customerNotesSharedAt: z.string().datetime().nullable(),
  externalRef: ExternalRef.nullable(),
}).merge(Timestamps);

export const Job = z.object({
  id: Uuid,
  number: z.number().int(),
  /**
   * The branch's code printed in front of the number ("AUS-1042"), when the
   * company prints branch codes and this was made in a branch with one.
   * Written once, when it was made: see `/v1/branch-numbering`.
   */
  numberPrefix: z.string().nullable().optional(),
  status: JobStatus,
  summary: z.string(),
  description: z.string().nullable(),
  /** The customer's own words at intake. Worth keeping verbatim. */
  customerComplaint: z.string().nullable(),
  customerId: Uuid,
  propertyId: Uuid,
  jobTypeId: Uuid.nullable(),
  territoryId: Uuid.nullable(),
  equipmentId: Uuid.nullable(),
  /** A key from the lead source catalogue, for the screens that show one word. */
  leadSource: z.string().nullable(),
  /** `manual` when somebody chose it, `derived` when the attribution filled it, `imported` from a migration. */
  leadSourceOrigin: z.string().nullable().optional(),
  /** The channel and tracking campaign the job is credited to. */
  channelId: Uuid.nullable().optional(),
  acquisitionCampaignId: Uuid.nullable().optional(),
  isWarranty: z.boolean(),
  parentJobId: Uuid.nullable(),
  /** Whose price governs. See the commercial schema. */
  priceSource: PriceSource,
  purchaseOrderNumber: z.string().nullable(),
  costCode: z.string().nullable(),
  total: MoneyString.nullable(),
  tags: z.array(z.string()),
  customFields: z.record(z.unknown()),
  /**
   * The branch (business unit) this job belongs to, or null for none. A
   * branch scoped person sees only their branch's jobs, so a job with none is
   * seen by the people who see the whole company.
   */
  businessUnitId: Uuid.nullable().optional(),
  visits: z.array(Visit),
  /** Redacted unless the caller holds job.cost:read. */
  cost: MoneyString.nullable().optional(),
  grossMargin: MoneyString.nullable().optional(),
  externalRef: ExternalRef.nullable(),
}).merge(Timestamps);

export const JobCreate = z.object({
  /**
   * The source document's own number, kept for history. Needs
   * `data:import`. Refused if taken; the next number this company is given
   * is always past the highest one in use, imported or not.
   */
  number: z.number().int().min(1).max(2_000_000_000).optional(),
  /** Where this came from in another system. See `ExternalRef`. */
  externalRef: ExternalRef.optional(),
  customerId: Uuid,
  propertyId: Uuid,
  jobTypeId: Uuid.optional(),
  summary: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
  customerComplaint: z.string().max(5000).optional(),
  equipmentId: Uuid.optional(),
  /**
   * Where the work came from, if somebody knows: a catalogue key or anything
   * its alias list places, a channel, or a tracking campaign. Recorded as a
   * declared touch. Leave it out and the job is credited from what the
   * customer did before it (the call, the click), under the company's model.
   */
  leadSource: z.string().max(100).optional(),
  channelId: Uuid.optional(),
  campaignId: Uuid.optional(),
  /** The call this job was booked from, which links the two and credits the call. */
  callId: Uuid.optional(),
  purchaseOrderNumber: z.string().max(100).optional(),
  costCode: z.string().max(50).optional(),
  /**
   * How urgent, on the scale core declares. Zero is normal and is the
   * absence of urgency rather than a choice.
   */
  priority: z.number().int().min(0).max(2).optional(),
  tags: z.array(z.string()).default([]),
  customFields: z.record(z.unknown()).default({}),
  /**
   * The branch to put it in. Left out, it goes in the branch of the person
   * booking it, then its job type's branch, otherwise none. Somebody limited
   * to their own branch can only name that one.
   */
  businessUnitId: Uuid.optional(),
  /**
   * THE JOB THIS ONE IS A RETURN VISIT FOR.
   *
   * Published since the beginning and written by nothing, which made two
   * things impossible rather than merely absent. The callback rate, which
   * is the single number a service manager watches, had no numerator. And
   * the review request rule that withholds an ask while a callback is open
   * could never fire, so customers were asked to review work we were still
   * coming back to fix.
   */
  parentJobId: Uuid.optional(),
  /**
   * Rework we are not charging for. Separate from `parentJobId` because the
   * two come apart in both directions: a return visit for a different fault
   * is billable, and a goodwill job with no parent is not.
   */
  isWarranty: z.boolean().optional(),
  /**
   * Whose price governs. The price book is not the authority in five
   * segments, and a job priced off a commercial rate card that reported
   * `price_book` would make every margin report wrong about work we did not
   * price.
   */
  priceSource: PriceSource.optional(),
  /**
   * Parties beyond the customer. Omit entirely for residential, where the
   * customer holds every role and the degenerate case should stay simple.
   */
  parties: z.array(z.object({
    role: PartyRole,
    customerId: Uuid.optional(),
    contactId: Uuid.optional(),
    externalName: z.string().max(200).optional(),
    externalReference: z.string().max(100).optional(),
  })).optional(),
  /** Why this is free or billed elsewhere. Defaults to the customer paying. */
  coverage: z.object({
    source: CoverageSource.default("customer"),
    coversLabour: z.boolean().default(false),
    coversParts: z.boolean().default(false),
    externalReference: z.string().max(100).optional(),
    customerResponsibility: MoneyString.optional(),
  }).optional(),
  /** Schedule the first visit inline. Most bookings do. */
  visit: z.object({
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime(),
    estimatedDurationMinutes: z.number().int().min(5).max(1440).default(60),
    technicianIds: z.array(Uuid).default([]),
    /**
     * Book it into an arrival window held for members although this
     * customer is not one there that day. Without it, such a booking is
     * refused in words; with it, it is booked and the audit log says who
     * chose to.
     */
    bookAnyway: z.boolean().optional(),
    /** Where this came from in another system. See `ExternalRef`. */
    externalRef: ExternalRef.optional(),
  }).optional(),
});

export const listJobs = defineRoute({
  method: "get",
  path: "/v1/jobs",
  summary: "List jobs",
  module: "M10",
  permissions: ["job:read"],
  input: PageRequest.extend({
    q: z.string().max(200).optional(),
    status: z.array(JobStatus).optional(),
    customerId: Uuid.optional(),
    propertyId: Uuid.optional(),
    technicianId: Uuid.optional(),
    scheduledFrom: z.string().datetime().optional(),
    scheduledTo: z.string().datetime().optional(),
    /**
     * One branch, or `none` for jobs nobody has put in a branch. Narrows what
     * the caller's own scope already lets them see; never widens it.
     */
    businessUnitId: z.union([Uuid, z.literal("none")]).optional(),
    /** Find by where it came from. See `ExternalRef`. */
    ...ExternalLookup,
    ...CustomFieldListFilter,
  }),
  output: pageOf(Job.omit({ visits: true }).extend({
    customerName: z.string(),
    propertyAddress: z.string(),
    nextVisitAt: z.string().datetime().nullable(),
  })),
});

export const getJob = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}",
  summary: "Get a job",
  module: "M10",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: Job,
});

export const createJob = defineRoute({
  method: "post",
  path: "/v1/jobs",
  summary: "Create a job",
  module: "M10",
  permissions: ["job:write"],
  idempotent: true,
  input: JobCreate,
  output: Job,
});

export const updateJob = defineRoute({
  method: "patch",
  path: "/v1/jobs/{id}",
  summary: "Update a job",
  module: "M10",
  permissions: ["job:write"],
  input: JobCreate.partial().omit({
    visit: true, parties: true, coverage: true, number: true, externalRef: true, callId: true,
  }).extend({
    id: Uuid,
    status: JobStatus.optional(),
    /** Null clears the job's lead source; a value is checked against the channel list. */
    leadSource: z.string().max(100).nullable().optional(),
    /**
     * Move the job to another branch, or out of every branch with null. Only
     * somebody who sees the whole company may move work out of their own.
     */
    businessUnitId: Uuid.nullable().optional(),
    channelId: Uuid.nullable().optional(),
    campaignId: Uuid.nullable().optional(),
    /**
     * When the work was finished, sent with `status: "completed"` and only
     * then. Omit for now. A completion more than a week back is history and
     * needs `data:import`, because "what was finished in March" is what
     * commission and technician reports are built on.
     */
    completedAt: z.string().datetime().optional(),
    /**
     * With `status: "cancelled"` only: cancel the job's visits still to come
     * as well, and tell their technicians. Visits under way or finished, and
     * any whose window has already passed, are left as they are. Needs
     * `visit:reschedule` as well.
     */
    cancelVisits: z.boolean().optional(),
  }),
  output: Job,
});

export const scheduleVisit = defineRoute({
  method: "post",
  path: "/v1/jobs/{id}/visits",
  summary: "Add a visit to a job",
  module: "M09",
  permissions: ["visit:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /**
     * The window, both ends or neither. Neither is a visit nobody has put a
     * time on yet: it waits off the board, unassigned, rather than at an
     * invented hour.
     */
    windowStart: z.string().datetime().optional(),
    windowEnd: z.string().datetime().optional(),
    estimatedDurationMinutes: z.number().int().min(5).max(1440).default(60),
    technicianIds: z.array(Uuid).default([]),
    crewId: Uuid.optional(),
    /**
     * Record the visit as already cancelled: a visit the customer called off,
     * kept because it is part of the job's history. Nobody is dispatched to
     * it and it does not hold the job open. The technicians named are the
     * ones who were going to go.
     */
    status: z.literal("cancelled").optional(),
    /** Book it into time held for members anyway. See `bookAnyway` on a new job's visit. */
    bookAnyway: z.boolean().optional(),
    /** Where this came from in another system. See `ExternalRef`. */
    externalRef: ExternalRef.optional(),
  }),
  output: Visit,
});

/**
 * Completion is an intent operation rather than a status field update, so it
 * survives replay from an offline device. It carries everything that happened,
 * and a `completedOfflineAt` so a visit completed after dispatch cancelled it
 * lands in the distinguished state rather than being rejected.
 */
export const completeVisit = defineRoute({
  method: "post",
  path: "/v1/visits/{id}/complete",
  summary: "Complete a visit",
  description:
    "Accepted even if the visit was cancelled while the device was offline. The work happened; rejecting the write would destroy the labour record, photos, signature and readings.",
  module: "M10",
  permissions: ["job:complete"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    completedOfflineAt: z.string().datetime().optional(),
    technicianNotes: z.string().max(10000).optional(),
    signatureUrl: z.string().url().optional(),
    checklist: z.array(z.object({ id: z.string(), doneAt: z.string().datetime().nullable() })).optional(),
    partsUsed: z.array(z.object({
      priceBookItemId: Uuid,
      quantity: MoneyString,
    })).optional(),
  }),
  output: Visit.extend({
    /** True when the visit had been cancelled and this was accepted anyway. */
    raisedDispatchException: z.boolean(),
  }),
});

/**
 * The kinds of work this company does.
 *
 * A job's `jobTypeId` had to be an id, and nothing listed them, so a caller
 * could only set one it had found some other way.
 */
export const listJobTypes = defineRoute({
  method: "get",
  path: "/v1/job-types",
  summary: "List job types",
  module: "M10",
  permissions: ["job:read"],
  input: z.object({ includeInactive: z.boolean().default(false) }),
  output: z.object({
    data: z.array(z.object({
      id: Uuid,
      name: z.string(),
      code: z.string().nullable(),
      defaultDurationMinutes: z.number().int(),
      requiredSkills: z.array(z.string()),
      active: z.boolean(),
    })),
  }),
});

/**
 * WHAT WAS USED ON A JOB.
 *
 * Job lines have been written since the field app first recorded a part,
 * and nothing could read them back except a margin report, so the office
 * raising an invoice had to ask the technician what they had used. Listed
 * with whether each one is billed yet, because "what is still to invoice on
 * this job" is the question the invoice is answering.
 */
export const JobLine = z.object({
  id: Uuid,
  jobId: Uuid,
  visitId: Uuid.nullable(),
  kind: z.string(),
  source: z.string(),
  priceBookItemVersionId: Uuid.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  quantity: MoneyString,
  unitPrice: MoneyString,
  /** Redacted unless the caller holds job.cost:read. */
  unitCost: MoneyString.nullable().optional(),
  taxable: z.boolean(),
  /** Null until an invoice line bills it. */
  invoiceLineId: Uuid.nullable(),
  /** Set when it is deliberately not billed: warranty, goodwill, rework. */
  nonBillableReason: z.string().nullable(),
  occurredAt: z.string().datetime(),
});

export const listJobLines = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}/lines",
  summary: "List what was used on a job",
  description:
    "Parts, labour and anything else recorded against the job, from the field or the office, oldest first, each with the invoice line that billed it or null when nothing has yet.",
  module: "M10",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: z.object({ data: z.array(JobLine) }),
});

export const jobRoutes = {
  listJobs, getJob, createJob, updateJob, scheduleVisit, completeVisit, listJobTypes, listJobLines,
} as const;
