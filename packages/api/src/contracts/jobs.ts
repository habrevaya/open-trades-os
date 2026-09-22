import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, PageRequest, pageOf, Timestamps } from "./common";

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
}).merge(Timestamps);

export const Job = z.object({
  id: Uuid,
  number: z.number().int(),
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
  leadSource: z.string().nullable(),
  isWarranty: z.boolean(),
  parentJobId: Uuid.nullable(),
  /** Whose price governs. See the commercial schema. */
  priceSource: z.string(),
  purchaseOrderNumber: z.string().nullable(),
  costCode: z.string().nullable(),
  total: MoneyString.nullable(),
  tags: z.array(z.string()),
  customFields: z.record(z.unknown()),
  visits: z.array(Visit),
  /** Redacted unless the caller holds job.cost:read. */
  cost: MoneyString.nullable().optional(),
  grossMargin: MoneyString.nullable().optional(),
}).merge(Timestamps);

export const JobCreate = z.object({
  customerId: Uuid,
  propertyId: Uuid,
  jobTypeId: Uuid.optional(),
  summary: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
  customerComplaint: z.string().max(5000).optional(),
  equipmentId: Uuid.optional(),
  leadSource: z.string().max(100).optional(),
  purchaseOrderNumber: z.string().max(100).optional(),
  costCode: z.string().max(50).optional(),
  tags: z.array(z.string()).default([]),
  customFields: z.record(z.unknown()).default({}),
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
  input: JobCreate.partial().omit({ visit: true, parties: true, coverage: true }).extend({
    id: Uuid,
    status: JobStatus.optional(),
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
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime(),
    estimatedDurationMinutes: z.number().int().min(5).max(1440).default(60),
    technicianIds: z.array(Uuid).default([]),
    crewId: Uuid.optional(),
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

export const jobRoutes = {
  listJobs, getJob, createJob, updateJob, scheduleVisit, completeVisit,
} as const;
