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
  "payment.collect",
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
    "Idempotent by clientId. Operations behind a gap in the device's sequence are held, not rejected, because the missing one usually arrives on the next attempt, and a held operation sent again is applied once the gap is filled or declared in `skipped`.",
  module: "M11",
  permissions: ["field:sync"],
  idempotent: true,
  input: z.object({
    deviceId: Uuid,
    operations: z.array(FieldOperationInput).min(1).max(500),
    /**
     * Sequences this device numbered and will never send: the phone died
     * between numbering an operation and writing it, or the technician
     * discarded one that never got through. Without this the operations
     * after such a number were held for ever. Send the numbers the last
     * response listed in `awaiting` that the device does not hold.
     */
    skipped: z.array(z.number().int().min(1)).max(500).optional(),
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
  /** The job's longer description, when the office wrote one. */
  description: z.string().nullable(),
  customerComplaint: z.string().nullable(),
  /** What technicians have already written on this visit, oldest first. */
  technicianNotes: z.string().nullable(),
  /**
   * When somebody said they had arrived. The visit stays `en_route` until work
   * starts, because that is the state machine core reasons about, so this is
   * the only way a phone can show "arrived" after a restart.
   */
  arrivedAt: z.string().datetime().nullable(),
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
  /**
   * What is still owed on the job's issued invoices, so the person collecting
   * on site knows the number before the customer asks. Null when nothing has
   * been invoiced yet, and for a caller who may not read invoices.
   */
  amountDue: MoneyString.nullable(),
  /**
   * The service report for this visit as the phone fills it in: the fields
   * the job type's template asks for, each with the last value recorded, and
   * the report's id once one exists. A phone that has not started one makes
   * its own id, the way it does for every other record it creates offline.
   */
  report: z.object({
    id: Uuid.nullable(),
    submitted: z.boolean(),
    fields: z.array(z.object({
      key: z.string(),
      label: z.string(),
      kind: z.string(),
      unit: z.string().nullable(),
      options: z.array(z.string()),
      required: z.boolean(),
      min: z.number().nullable(),
      max: z.number().nullable(),
      /** The newest value recorded, as text, or null when nothing has been. */
      value: z.string().nullable(),
    })),
  }),
  /** Parts and charges already recorded on this visit, from any phone or the office. */
  parts: z.array(z.object({
    id: Uuid,
    name: z.string(),
    quantity: z.string(),
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
      /**
       * The plan that promised this customer priority, when one covers this
       * job. The pile comes sorted with these first and is otherwise in the
       * order it always had.
       */
      priorityPlan: z.string().nullable(),
    })),
  }),
});

export const assignVisit = defineRoute({
  method: "post",
  path: "/v1/visits/{id}/assign",
  summary: "Put a visit on somebody's day",
  description:
    "Refused, with a sentence naming the person and the skill, when somebody being sent is not qualified for the work's required skills by their certifications or their recorded skills. A caller holding visit:assign_unqualified may send them anyway by giving a reason, which the audit log keeps beside the refusal it overrode.",
  module: "M09",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    technicianIds: z.array(Uuid).min(1).max(12),
    leadTechnicianId: Uuid.optional(),
    /** Where in the day it sits. Omitted appends to the end. */
    routeOrder: z.number().int().optional(),
    /**
     * Send them although the qualification check refused. Needs
     * visit:assign_unqualified, and a reason somebody reading the audit log
     * later would accept.
     */
    overrideQualification: z.object({ reason: z.string().trim().min(5).max(500) }).optional(),
  }),
  output: z.object({
    ok: z.literal(true),
    status: z.string(),
    /** True when a refusal was overridden to make this assignment. */
    overridden: z.boolean(),
    /** Required skills nothing could check for the people sent, said rather than hidden. */
    unknownSkills: z.array(z.string()),
  }),
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

/**
 * THE PHONE APP SIGNING IN
 *
 * Public, because nobody is signed in yet, and refused with a 401 in plain
 * words for a wrong password, a locked account, or an account that is not a
 * technician. The same password check and lockout as the sign in form.
 */
export const signInDevice = defineRoute({
  method: "post",
  path: "/v1/field/sign-in",
  summary: "Sign the phone app in",
  description:
    "Email and password in, a device token out, presented afterwards as `Authorization: Bearer otd_...`. The token is a session: it acts as the person, stops working when they are deactivated, and lasts ninety days. Only an account with a technician record and field:sync is let in. Register the device with the token next, which binds the token to it so revoking the device ends the sign in.",
  module: "M11",
  permissions: [],
  authorization: "public",
  input: z.object({
    email: z.string().email().max(320),
    password: z.string().min(1).max(500),
  }),
  output: z.object({
    /** Shown once. Only its hash is kept. */
    token: z.string(),
    expiresAt: z.string().datetime(),
    user: z.object({ id: Uuid, name: z.string().nullable(), email: z.string() }),
    organization: z.object({ id: Uuid, name: z.string(), timezone: z.string() }),
  }),
});

export const FieldDevice = z.object({
  id: Uuid,
  technicianId: Uuid,
  technicianName: z.string(),
  label: z.string().nullable(),
  platform: z.string().nullable(),
  appVersion: z.string().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
  /** A phone app token is live on it. A browser never has one. */
  signedIn: z.boolean(),
  revokedAt: z.string().datetime().nullable(),
});

export const listDevices = defineRoute({
  method: "get",
  path: "/v1/field/devices",
  summary: "Every phone the technicians use",
  module: "M11",
  permissions: ["user:read"],
  input: z.object({}),
  output: z.object({ devices: z.array(FieldDevice) }),
});

export const signOutDevice = defineRoute({
  method: "post",
  path: "/v1/field/devices/{id}/sign-out",
  summary: "Sign the phone app out",
  description:
    "Ends the device's token. Only the caller's own device; another person's phone is the office's decision, which is the revoke route. The device keeps its sequence, so signing in again on the same handset carries on numbering.",
  module: "M11",
  permissions: ["field:sync"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ ok: z.literal(true) }),
});

export const revokeDevice = defineRoute({
  method: "post",
  path: "/v1/field/devices/{id}/revoke",
  summary: "Take a phone away",
  description:
    "For a lost or returned phone. The device can no longer sync and its token stops working on every route at once. It does not stop the person signing in again; deactivating them does that.",
  module: "M11",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ ok: z.literal(true), revokedAt: z.string().datetime() }),
});

/**
 * A CODE INSTEAD OF A PASSWORD
 *
 * Two public calls, like the password sign in beside them. The first sends a
 * six digit code to the technician's mobile number on file, or to their email,
 * and answers the same sentence whether or not the address belongs to anybody,
 * so it cannot be used to find out who works where. The second trades the code
 * for the same device token a password gets.
 */
export const requestSignInCode = defineRoute({
  method: "post",
  path: "/v1/field/sign-in/code",
  summary: "Send the phone a sign in code",
  description:
    "Sends a six digit code by text to the mobile number the office recorded for the technician, or by email. The answer is the same whether or not the address belongs to anybody. A code lives ten minutes, dies after five wrong guesses, and only the newest one works; a person may ask three times in fifteen minutes, and an address is limited per minute.",
  module: "M11",
  permissions: [],
  authorization: "public",
  input: z.object({
    email: z.string().email().max(320),
    channel: z.enum(["sms", "email"]),
  }),
  output: z.object({
    ok: z.literal(true),
    /** What to tell the person, which never says whether the address exists. */
    message: z.string(),
  }),
});

export const signInWithCode = defineRoute({
  method: "post",
  path: "/v1/field/sign-in/verify",
  summary: "Sign the phone app in with a code",
  description:
    "The email and the code in, the same device token the password sign in gives out. Spends the code. Refused with one sentence for a wrong, expired, spent or never sent code alike, and only an account with a technician record is let in.",
  module: "M11",
  permissions: [],
  authorization: "public",
  input: z.object({
    email: z.string().email().max(320),
    code: z.string().min(1).max(20),
  }),
  output: signInDevice.output,
});

/**
 * The number a code is texted to, set by the office. Never by the person
 * asking for a code, because a sign in sent to a number the asker chose is
 * not a sign in.
 */
export const setTechnicianMobile = defineRoute({
  method: "post",
  path: "/v1/field/technicians/{id}/mobile",
  summary: "Set the number sign in codes are texted to",
  module: "M11",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** Null clears it, and the person can then only get a code by email. */
    mobilePhone: z.string().trim().min(7).max(40).nullable(),
  }),
  output: z.object({ id: Uuid, mobilePhone: z.string().nullable() }),
});

/**
 * THE PHONES, AS THE OFFICE SEES THEM
 *
 * Each technician with the phones they have signed in on, and the number a
 * code goes to. The screen behind it is `/settings/phones`.
 */
export const listFieldPeople = defineRoute({
  method: "get",
  path: "/v1/field/technicians",
  summary: "Technicians and their phones",
  module: "M11",
  permissions: ["user:read"],
  input: z.object({}),
  output: z.object({
    technicians: z.array(z.object({
      id: Uuid,
      name: z.string(),
      active: z.boolean(),
      mobilePhone: z.string().nullable(),
      devices: z.array(FieldDevice.extend({
        /** A push token is registered, so changes to their day reach this phone. */
        notifications: z.boolean(),
      })),
    })),
  }),
});

/**
 * CARD, ON SITE, THROUGH THE LINK THE CUSTOMER ALREADY GETS
 *
 * The phone never touches a card number. It asks for the job's invoice link,
 * the same one an emailed invoice carries, and either texts it to the
 * customer or hands it to the phone's share sheet so the customer pays on
 * their own phone. The payment lands when the card processor says it did,
 * exactly as it does for an emailed invoice.
 */
export const visitPaymentLink = defineRoute({
  method: "post",
  path: "/v1/visits/{id}/payment-link",
  summary: "A card payment link for the job on this visit",
  description:
    "For the technician on the visit, or anybody who may send invoices. Refused with a sentence when the job has no issued invoice with money owing, or the company has not connected card payments. With `text: true` the link is also texted to the customer's number on file, subject to the same consent rules as every other text.",
  module: "M13",
  permissions: ["payment:collect"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    text: z.boolean().default(false),
  }),
  output: z.object({
    url: z.string(),
    invoiceId: Uuid,
    invoiceNumber: z.number().int(),
    amountDue: MoneyString,
    texted: z.boolean(),
    /** Why it was not texted, in words for the person on site. Null when it was, or was not asked. */
    reason: z.string().nullable(),
  }),
});

export const fieldRoutes = {
  signInDevice, listDevices, signOutDevice, revokeDevice,
  requestSignInCode, signInWithCode, setTechnicianMobile, listFieldPeople, visitPaymentLink,
  syncOperations, registerDevice, getFieldSnapshot,
  getDispatchBoard, assignVisit, reorderRoute, sendArrivalNotice,
  listConflicts, resolveConflict,
} as const;
