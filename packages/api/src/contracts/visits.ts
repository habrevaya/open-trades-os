import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * ONE VISIT, ON THE API
 *
 * The same read the visit's own screen makes, so an integration or an agent
 * asked "what happened on Tuesday's trip" gets that trip rather than the whole
 * job and a guess at which of its visits was meant.
 */
const At = z.string().nullable();

export const getVisit = defineRoute({
  method: "get",
  path: "/v1/visits/{id}",
  summary: "One visit, with what happened on it",
  description:
    "Its window and its times (dispatched, on the way, arrived, finished), who was on it, its notes and checklist, what it used by name and quantity, the units it worked and their outcomes, the service report and any inspection filed from it, what the customer asked to change, and the other visits on the same job. Time on the clock is included for a reader who may read timesheets and is null otherwise. Cost is not here: it is the job costing permission's, on the job's statement. Scoped by the visit's job, and a visit outside the reader's scope is not found.",
  module: "M10",
  permissions: ["visit:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    sequence: z.number().int(),
    status: z.string(),
    windowStart: At,
    windowEnd: At,
    estimatedDurationMinutes: z.number().int(),
    dispatchedAt: At,
    enRouteAt: At,
    arrivedAt: At,
    completedAt: At,
    technicianNotes: z.string().nullable(),
    checklist: z.array(z.object({ id: z.string(), label: z.string(), required: z.boolean(), doneAt: z.string().nullable() })),
    signed: z.boolean(),
    rentalEvent: z.string().nullable(),
    /** The days the customer agreed this visit may happen on, inclusive. Set with `PUT /v1/visits/{id}/movable`. */
    movableFrom: z.string().date().nullable(),
    movableUntil: z.string().date().nullable(),
    job: z.object({
      id: Uuid, number: z.number().int(), summary: z.string(), status: z.string(),
      customerId: Uuid, propertyId: Uuid.nullable(), equipmentId: Uuid.nullable(),
    }),
    customer: z.object({ id: Uuid, name: z.string() }).nullable(),
    property: z.object({ id: Uuid, address: z.string(), accessNotes: z.string().nullable() }).nullable(),
    team: z.array(z.object({ technicianId: Uuid, name: z.string(), isLead: z.boolean() })),
    crew: z.string().nullable(),
    used: z.array(z.object({
      id: Uuid, kind: z.string(), name: z.string(), quantity: z.string(), unitPrice: z.string(),
      nonBillableReason: z.string().nullable(), billed: z.boolean(),
    })),
    time: z.array(z.object({
      id: Uuid, kind: z.string(), technician: z.string(), startedAt: z.string(), endedAt: At, minutes: z.number().int().nullable(),
    })).nullable(),
    units: z.array(z.object({
      equipmentId: Uuid, outcome: z.string().nullable(), notes: z.string().nullable(), completedAt: At,
      category: z.string(), tag: z.string().nullable(), serialNumber: z.string().nullable(),
    })),
    reports: z.array(z.object({
      id: Uuid, summary: z.string().nullable(), skipped: z.boolean(), skipReason: z.string().nullable(),
      submittedAt: At, publishedAt: At,
    })),
    inspections: z.array(z.object({
      id: Uuid, performedOn: z.string().nullable(), result: z.string().nullable(), programme: z.string().nullable(),
    })),
    changes: z.array(z.object({
      id: Uuid, kind: z.string(), status: z.string(), reason: z.string().nullable(), requestedStart: At,
      createdAt: z.string(), decidedAt: At, response: z.string().nullable(),
    })),
    siblings: z.array(z.object({ id: Uuid, sequence: z.number().int(), status: z.string(), windowStart: At })),
  }),
});

export const visitRoutes = { getVisit } as const;
