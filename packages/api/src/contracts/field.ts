import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, PageRequest, pageOf, Timestamps } from "./common";

export const OperationKind = z.enum([
  "visit.en_route", "visit.arrive", "visit.start", "visit.complete",
  "visit.pause", "visit.note",
  "timeclock.punch_in", "timeclock.punch_out",
  "service_report.set_field", "service_report.submit", "visit.checklist_item",
  "visit.add_line", "equipment.record",
  "attachment.attach", "signature.capture",
]);

export const OperationStatus = z.enum([
  "accepted", "applied", "conflicted", "rejected", "superseded", "held",
]);

/**
 * One write from the field.
 *
 * A named intent, never a row diff. The difference only shows when the world
 * moved while the phone was offline, and then it is the whole difference: a
 * diff overwrites what happened in the meantime and destroys the evidence that
 * there was a disagreement.
 */
export const FieldOperationInput = z.object({
  /** Generated on the device and stable across retries. This is the
   *  idempotency key, and a client that regenerates it will clock its
   *  technician in four times from one tap. */
  clientId: Uuid,
  /** Monotonic per device, from one, never skipping. Gaps are how the server
   *  knows an operation is missing rather than simply not sent yet. */
  sequence: z.number().int().min(1),
  kind: OperationKind,
  subjectId: Uuid.optional(),
  /** When it happened by the device's clock. Clamped server side, and what
   *  the device claimed is kept either way. */
  occurredAt: z.string().datetime(),
  payload: z.record(z.unknown()).default({}),
  latitude: z.string().max(32).optional(),
  longitude: z.string().max(32).optional(),
  accuracyMeters: z.number().int().min(0).max(100_000).optional(),
});

export const OperationResult = z.object({
  clientId: Uuid,
  status: OperationStatus,
  /** Present when the operation applied but disagreed with the server's state.
   *  The device shows this; a person resolves it. */
  conflict: z.string().nullable(),
  /** Present when it could not be applied. Never swallowed: the device is told. */
  rejection: z.string().nullable(),
  /** The server's resolved occurrence time, which may differ from what was
   *  sent if the device's clock was wrong. */
  occurredAt: z.string().datetime(),
  clamped: z.enum(["future", "reordered"]).nullable(),
});

/**
 * The whole day, in one request.
 *
 * Batched rather than one call per operation, because the connection that
 * comes back is a van on a highway and forty round trips will not all
 * complete. Partial success is the normal outcome and the response says
 * per operation what happened.
 */
export const syncOperations = defineRoute({
  method: "post",
  path: "/v1/field/sync",
  summary: "Submit queued field operations",
  description:
    "Idempotent by clientId. Operations behind a gap in the device's sequence are held, not rejected, because the missing one usually arrives on the next attempt.",
  module: "M11",
  permissions: ["field:sync"],
  idempotent: true,
  input: z.object({
    deviceId: Uuid,
    operations: z.array(FieldOperationInput).min(1).max(500),
  }),
  output: z.object({
    results: z.array(OperationResult),
    /** Sequences the server is waiting on before it can apply the rest. */
    awaiting: z.array(z.number().int()),
    /** Bumped when the device's slice of the schedule changed, so the client
     *  knows to pull rather than diffing what it already has. */
    snapshotRevision: z.number().int(),
  }),
});

export const registerDevice = defineRoute({
  method: "post",
  path: "/v1/field/devices",
  summary: "Register a phone",
  module: "M11",
  permissions: ["field:sync"],
  idempotent: true,
  input: z.object({
    installationId: z.string().min(8).max(200),
    label: z.string().max(100).optional(),
    platform: z.enum(["ios", "android"]).optional(),
    appVersion: z.string().max(40).optional(),
    osVersion: z.string().max(40).optional(),
    pushToken: z.string().max(500).optional(),
  }),
  output: z.object({
    deviceId: Uuid,
    /** Where the device should resume from. A reinstall that kept its
     *  installation id picks up its old sequence rather than starting at one
     *  and colliding with everything it already sent. */
    lastSequence: z.number().int(),
  }),
});

export const VisitForField = z.object({
  id: Uuid,
  jobId: Uuid,
  jobNumber: z.number().int(),
  sequence: z.number().int(),
  status: z.string(),
  summary: z.string(),
  customerComplaint: z.string().nullable(),
  windowStart: z.string().datetime().nullable(),
  windowEnd: z.string().datetime().nullable(),
  routeOrder: z.number().int().nullable(),
  estimatedDurationMinutes: z.number().int(),
  customer: z.object({
    id: Uuid,
    name: z.string(),
    phone: z.string().nullable(),
  }),
  property: z.object({
    id: Uuid,
    addressLine1: z.string(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    /** A technician must see these before they get out of the truck. */
    gateCode: z.string().nullable(),
    accessNotes: z.string().nullable(),
    hazardNotes: z.string().nullable(),
    hasDog: z.boolean(),
  }),
  checklist: z.array(z.object({
    id: z.string(),
    label: z.string(),
    required: z.boolean(),
    doneAt: z.string().datetime().nullable(),
  })),
});

/**
 * Everything the phone needs to work without a network.
 *
 * Deliberately a whole slice rather than a set of endpoints the client stitches
 * together. A phone that has to make six calls to show a job will show a job
 * six times slower on the connection this exists for, and will show half of
 * one if the third call fails.
 */
export const getFieldSnapshot = defineRoute({
  method: "get",
  path: "/v1/field/snapshot",
  summary: "The day, for offline use",
  module: "M11",
  permissions: ["field:sync"],
  input: z.object({
    deviceId: Uuid,
    /** Usually today and tomorrow. The phone cannot carry the company. */
    from: z.string().date(),
    days: z.number().int().min(1).max(7).default(2),
    /** The revision the device already holds. Unchanged means nothing to send. */
    sinceRevision: z.number().int().optional(),
  }),
  output: z.object({
    revision: z.number().int(),
    unchanged: z.boolean(),
    visits: z.array(VisitForField),
    priceBook: z.array(z.object({
      id: Uuid,
      versionId: Uuid,
      code: z.string().nullable(),
      name: z.string(),
      unitPrice: MoneyString,
      taxable: z.boolean(),
    })),
    openTimeEntry: z.object({
      id: Uuid,
      kind: z.string(),
      startedAt: z.string().datetime(),
    }).nullable(),
  }),
});

/**
 * The dispatch board.
 *
 * One query for a whole day across every technician, because that is the
 * screen: a dispatcher is not looking at one visit, they are looking for the
 * gap and the thing that is late.
 */
export const getDispatchBoard = defineRoute({
  method: "get",
  path: "/v1/dispatch/board",
  summary: "A day across every technician",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({
    date: z.string().date(),
    businessUnitId: Uuid.optional(),
    territoryId: Uuid.optional(),
  }),
  output: z.object({
    date: z.string().date(),
    technicians: z.array(z.object({
      id: Uuid,
      displayName: z.string(),
      color: z.string().nullable(),
      /** Off today, so the board shows why the column is empty rather than
       *  inviting a dispatcher to fill it. */
      timeOff: z.boolean(),
      visits: z.array(z.object({
        id: Uuid,
        jobNumber: z.number().int(),
        summary: z.string(),
        status: z.string(),
        windowStart: z.string().datetime().nullable(),
        windowEnd: z.string().datetime().nullable(),
        routeOrder: z.number().int().nullable(),
        estimatedDurationMinutes: z.number().int(),
        customerName: z.string(),
        addressLine1: z.string(),
        /** Running late against its own window, computed once here rather
         *  than by every client that renders a board. */
        isLate: z.boolean(),
      })),
    })),
    /** Not yet assigned to anyone. The pile a dispatcher works from. */
    unassigned: z.array(z.object({
      id: Uuid,
      jobNumber: z.number().int(),
      summary: z.string(),
      windowStart: z.string().datetime().nullable(),
      windowEnd: z.string().datetime().nullable(),
      estimatedDurationMinutes: z.number().int(),
      customerName: z.string(),
      addressLine1: z.string(),
      postalCode: z.string(),
    })),
  }),
});

export const assignVisit = defineRoute({
  method: "post",
  path: "/v1/visits/{id}/assign",
  summary: "Put a visit on somebody's day",
  module: "M09",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    technicianIds: z.array(Uuid).min(1).max(12),
    leadTechnicianId: Uuid.optional(),
    /** Where in the day it sits. Omitted appends to the end. */
    routeOrder: z.number().int().optional(),
  }),
  output: z.object({ ok: z.literal(true), status: z.string() }),
});

/**
 * Reorder a technician's day in one call.
 *
 * A board reorders by drag, which moves one card and renumbers the rest. Sent
 * as one list rather than a sequence of moves so the server never holds a
 * half-renumbered day, which is what produces two stops numbered four.
 */
export const reorderRoute = defineRoute({
  method: "post",
  path: "/v1/dispatch/route",
  summary: "Set the order of a technician's day",
  module: "M09",
  permissions: ["visit:reschedule"],
  idempotent: true,
  input: z.object({
    technicianId: Uuid,
    date: z.string().date(),
    visitIds: z.array(Uuid).min(1).max(60),
  }),
  output: z.object({ ok: z.literal(true), ordered: z.number().int() }),
});

export const sendArrivalNotice = defineRoute({
  method: "post",
  path: "/v1/visits/{id}/on-my-way",
  summary: "Tell the customer the technician is coming",
  description:
    "Recorded as its own row rather than a flag, because a company that sends two has a problem worth seeing, and because the question later is how long before arrival it actually went out.",
  module: "M18",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /**
     * SMS only, and narrowed on purpose.
     *
     * This accepted "email" for as long as it sent nothing at all, which cost
     * nothing because both values did the same thing: nothing. Now that it
     * sends, an accepted value with no sender behind it would queue a text to
     * somebody who asked for an email, or silently drop it. The enum stays a
     * single value rather than becoming a plain string, so the day email is
     * built the change is visible in this file.
     */
    channel: z.enum(["sms"]).default("sms"),
    etaMinutes: z.number().int().min(0).max(480).optional(),
    includeTracking: z.boolean().default(true),
  }),
  output: z.object({
    ok: z.literal(true),
    /** Whether a message was actually queued to the customer. */
    sent: z.boolean(),
    /** Whether an earlier notice for this visit had already gone out. */
    alreadySent: z.boolean(),
    trackingUrl: z.string().url().nullable(),
    /**
     * Why they will not hear from us, in words for the person in the van.
     * Null when the message was queued.
     */
    reason: z.string().nullable(),
  }),
});

export const Conflict = z.object({
  id: Uuid,
  kind: OperationKind,
  subjectId: Uuid.nullable(),
  technicianId: Uuid,
  technicianName: z.string(),
  conflict: z.string(),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  payload: z.record(z.unknown()),
}).merge(Timestamps);

/**
 * The queue of things a person has to look at.
 *
 * Every conflict here is a real disagreement between what a technician did and
 * what the office believed, and leaving them unresolved is how a cancelled job
 * gets invoiced.
 */
export const listConflicts = defineRoute({
  method: "get",
  path: "/v1/field/conflicts",
  summary: "Field operations that need a person",
  module: "M11",
  permissions: ["visit:read"],
  input: PageRequest.extend({ includeResolved: z.boolean().default(false) }),
  output: pageOf(Conflict),
});

export const resolveConflict = defineRoute({
  method: "post",
  path: "/v1/field/conflicts/{id}/resolve",
  summary: "Mark a conflict dealt with",
  module: "M11",
  permissions: ["visit:write"],
  idempotent: true,
  input: z.object({ id: Uuid, note: z.string().max(1000).optional() }),
  output: z.object({ ok: z.literal(true) }),
});

export const fieldRoutes = {
  syncOperations, registerDevice, getFieldSnapshot,
  getDispatchBoard, assignVisit, reorderRoute, sendArrivalNotice,
  listConflicts, resolveConflict,
} as const;
