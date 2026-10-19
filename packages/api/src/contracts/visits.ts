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

/** Who called a visit off: the customer, or the company itself. */
export const CancelledBy = z.enum(["customer", "company"]);

/**
 * Why the company called a day off: rain or weather, crew short, equipment, or
 * something else (which says what in `note`). The company's own cancellations
 * only: a reason with `by: "customer"` is refused. Left out, a company
 * cancellation is recorded with no reason given.
 */
export const CancelReasonCode = z.enum(["weather", "crew_short", "equipment", "other"]);
export const CancelReasonInput = z.object({
  code: CancelReasonCode,
  note: z.string().trim().max(500).optional(),
});

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
      /** The last answer to each field the report recorded, in words. */
      readings: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })).optional(),
    })),
    inspections: z.array(z.object({
      id: Uuid, performedOn: z.string().nullable(), result: z.string().nullable(), programme: z.string().nullable(),
    })),
    changes: z.array(z.object({
      id: Uuid, kind: z.string(), status: z.string(), reason: z.string().nullable(), requestedStart: At,
      createdAt: z.string(), decidedAt: At, response: z.string().nullable(),
    })),
    siblings: z.array(z.object({ id: Uuid, sequence: z.number().int(), status: z.string(), windowStart: At })),
    /**
     * Who called it off and when they asked, on a cancelled visit, with the
     * notice window it was judged by and whether that made it late. Null on a
     * visit not called off; `by` null on one cancelled with nobody saying who.
     */
    cancellation: z.object({
      by: CancelledBy.nullable(),
      at: At,
      noticeHours: z.number().int().nullable(),
      late: z.boolean().nullable(),
      /** Why the company called it off, when it did and said. Never present on a customer's cancellation. */
      reason: z.object({ code: CancelReasonCode, label: z.string(), note: z.string().nullable(), words: z.string() }).nullable().optional(),
    }).nullable(),
  }),
});

/* --------------------------------------------------- calling a visit off */

const Cancelled = z.object({
  id: Uuid,
  status: z.string(),
  cancelledBy: CancelledBy,
  cancelledAt: z.string().datetime(),
  /** The company's notice window when it was called off, frozen on the visit. */
  cancelNoticeHours: z.number().int(),
  /** The customer called it off with less notice than the window asks for. Null with no window. */
  late: z.boolean().nullable(),
  /** Why the company called it off, when it did and said; null otherwise. */
  reason: z.object({ code: CancelReasonCode, label: z.string(), note: z.string().nullable(), words: z.string() }).nullable(),
});

export const cancelVisit = defineRoute({
  method: "post",
  path: "/v1/visits/{id}/cancelled",
  summary: "Call off one visit, saying who asked",
  description:
    "Cancels a visit nobody has started (or one on the way), takes it off the route, tells whoever was on it not to go, and closes any request of the customer's still waiting on it. `by` is required: the customer, or the company itself (weather, staffing), because cleaning's cancellation rate counts the customer's and leaves the company's out. `askedAt` is when they asked, if earlier than now: never later than now and never before the visit was booked. The company's notice window is frozen on the visit with it. `reason` says why, for the company's own cancellations only (rain or weather, crew short, equipment, or something else with its words in `note`): the visit's page shows it, and the cancellation records the scorecard opens read it. It is refused with `by: \"customer\"`, and a company cancellation sent without one is recorded as no reason given. A visit being worked, or done, is refused.",
  module: "M09",
  permissions: ["visit:reschedule"],
  idempotent: true,
  input: z.object({ id: Uuid, by: CancelledBy, askedAt: z.string().datetime().optional(), reason: CancelReasonInput.optional() }),
  output: Cancelled,
});

const Notice = z.object({
  /** Hours before a visit's window a customer must cancel by for it not to be late. */
  hours: z.number().int(),
});

export const getCancellationNotice = defineRoute({
  method: "get",
  path: "/v1/cancellation-notice",
  summary: "How much notice the company asks a customer to give before cancelling",
  module: "M09",
  permissions: ["settings:read"],
  input: z.object({}),
  output: Notice,
});

export const setCancellationNotice = defineRoute({
  method: "patch",
  path: "/v1/cancellation-notice",
  summary: "Set how much notice a customer must give before cancelling",
  description:
    "Whole hours, from none to a month (720). A customer cancellation with less notice than this before the visit's window counts as late on cleaning's cancellation rate. A visit already called off keeps the window it was called off under, so changing this does not move past figures.",
  module: "M09",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ hours: z.number().int().min(0).max(720) }),
  output: Notice,
});

export const visitRoutes = { getVisit, cancelVisit, getCancellationNotice, setCancellationNotice } as const;
