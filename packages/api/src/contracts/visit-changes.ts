import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * A CUSTOMER ASKING TO MOVE OR CANCEL A VISIT, AND THE OFFICE ANSWERING
 *
 * Two routes on the customer's side, reached by the link they hold like every
 * other portal route: the subject comes from the grant, and a visit id in the
 * request only narrows within what the grant already reaches. Three on the
 * office's side, behind the permission that moves visits on the board.
 *
 * It is a request and never a move. Approving is what moves the visit.
 */

const Token = z.string().min(20).max(200);

/**
 * `proposed` is the office offering a different time and waiting for the
 * customer; `accepted` and `turned_down` are the customer's answer to it.
 */
const Status = z.enum(["pending", "approved", "declined", "superseded", "proposed", "accepted", "turned_down"]);

const Slot = z.object({
  date: z.string().date(),
  arrivalWindowId: Uuid,
  label: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  remaining: z.number().int(),
});

const RequestView = z.object({
  id: Uuid,
  visitId: Uuid,
  jobId: Uuid,
  kind: z.enum(["reschedule", "cancel"]),
  status: Status,
  reason: z.string().nullable(),
  requestedDate: z.string().date().nullable(),
  requestedStart: z.string().datetime().nullable(),
  requestedEnd: z.string().datetime().nullable(),
  previousStart: z.string().datetime().nullable(),
  previousEnd: z.string().datetime().nullable(),
  /** What the office said back, sent to the customer as written. */
  response: z.string().nullable(),
  /** `queued` when the customer was told, otherwise why they could not be. */
  notified: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
  /** The time the office offered instead, when it did. */
  proposedDate: z.string().date().nullable(),
  proposedStart: z.string().datetime().nullable(),
  proposedEnd: z.string().datetime().nullable(),
  /** When the customer answered the offer, and what they said with it. */
  answeredAt: z.string().datetime().nullable(),
  answer: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const getPortalVisitChange = defineRoute({
  method: "get",
  path: "/v1/portal/visit-change",
  summary: "What a customer can do about a coming visit",
  description:
    "From a job link or the customer's account link. Whether the visit can still be changed, any request already waiting on it, and the windows it could move to: exactly the windows online booking offers for that kind of work, with the company's notice period, open days, per window limit and service area applied.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({
    token: Token,
    /** Which visit, on an account link. A job link reaches its next visit without one. */
    visitId: Uuid.optional(),
    from: z.string().date().optional(),
    days: z.number().int().min(1).max(60).optional(),
  }),
  output: z.object({
    organizationName: z.string(),
    visit: z.object({
      id: Uuid,
      jobNumber: z.number().int(),
      summary: z.string(),
      windowStart: z.string().datetime(),
      windowEnd: z.string().datetime().nullable(),
      status: z.string(),
    }),
    pending: z.object({
      id: Uuid,
      kind: z.enum(["reschedule", "cancel"]),
      requestedStart: z.string().datetime().nullable(),
      requestedEnd: z.string().datetime().nullable(),
      createdAt: z.string().datetime(),
    }).nullable(),
    decided: z.object({
      kind: z.enum(["reschedule", "cancel"]),
      status: z.string(),
      response: z.string().nullable(),
      decidedAt: z.string().datetime().nullable(),
    }).nullable(),
    /** A different time the office offered, waiting for the customer's yes or no. Nothing has moved. */
    proposal: z.object({
      id: Uuid,
      requestedStart: z.string().datetime().nullable(),
      requestedEnd: z.string().datetime().nullable(),
      proposedStart: z.string().datetime(),
      proposedEnd: z.string().datetime().nullable(),
      response: z.string().nullable(),
      open: z.boolean(),
    }).nullable(),
    canChange: z.boolean(),
    changeBlockedBy: z.string().nullable(),
    rescheduleBlockedBy: z.string().nullable(),
    timezone: z.string(),
    slots: z.array(Slot),
  }),
});

export const requestPortalVisitChange = defineRoute({
  method: "post",
  path: "/v1/portal/visit-change",
  summary: "Ask to move or cancel a visit",
  description:
    "Never moves anything. Writes a request the office approves or declines, raises it in the office queue, and checks a move against the windows online booking would offer at this moment. A cancellation needs a reason. Sending the same request again returns the first one; a different one while one is waiting is refused.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({
    token: Token,
    visitId: Uuid.optional(),
    kind: z.enum(["reschedule", "cancel"]),
    requestedDate: z.string().date().optional(),
    arrivalWindowId: Uuid.optional(),
    reason: z.string().max(1000).optional(),
  }),
  output: RequestView,
});

export const listVisitChangeRequests = defineRoute({
  method: "get",
  path: "/v1/visit-change-requests",
  summary: "Customers' requests to move or cancel visits",
  description: "Newest first. `status=pending` is the list somebody owes an answer to.",
  module: "M05",
  permissions: ["visit:read"],
  input: z.object({
    status: Status.optional(),
    jobId: Uuid.optional(),
  }),
  output: z.object({
    requests: z.array(RequestView.extend({
      customerId: Uuid,
      customerName: z.string(),
      jobNumber: z.number().int(),
      jobSummary: z.string(),
      visitStatus: z.string(),
      taskId: Uuid.nullable(),
    })),
  }),
});

export const approveVisitChangeRequest = defineRoute({
  method: "post",
  path: "/v1/visit-change-requests/{id}/approve",
  summary: "Move or cancel the visit as the customer asked",
  description:
    "A move re-checks that the window is still open, takes the visit off the day it was assigned to, puts it back on the board unassigned at its new time, and tells the customer. A cancellation cancels the visit and tells the customer. Either closes the request's task in the office queue. The customer is told by text where they can be texted and by email otherwise, and `notified` says which, or why neither.",
  module: "M05",
  permissions: ["visit:reschedule"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: RequestView.extend({ assignmentsRemoved: z.number().int() }),
});

export const declineVisitChangeRequest = defineRoute({
  method: "post",
  path: "/v1/visit-change-requests/{id}/decline",
  summary: "Say no, and tell the customer why",
  description:
    "The visit stays where it was. `response` is sent to the customer as written, so it is worth something they can act on.",
  module: "M05",
  permissions: ["visit:reschedule"],
  idempotent: true,
  input: z.object({ id: Uuid, response: z.string().max(1000).optional() }),
  output: RequestView,
});

export const answerPortalVisitChangeProposal = defineRoute({
  method: "post",
  path: "/v1/portal/visit-change/answer",
  summary: "Take or turn down the time the office offered",
  description:
    "From the same link the customer asked from, or the link the office's offer was sent with. Yes moves the visit to the offered time, takes it off whoever had it and puts it on the board for that day; no leaves it where it was. Either raises a task in the office queue. The same answer twice returns the first.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({
    token: Token,
    visitId: Uuid.optional(),
    accept: z.boolean(),
    /** Anything the customer wants to say with it. */
    answer: z.string().max(1000).optional(),
  }),
  output: RequestView,
});

export const listVisitChangeTimes = defineRoute({
  method: "get",
  path: "/v1/visit-change-requests/{id}/times",
  summary: "The times the office could offer instead",
  description:
    "The windows online booking would offer for the visit's work, with this request's own hold and the visit left out of the count. Empty for a cancellation, an answered request, or work not booked online.",
  module: "M05",
  permissions: ["visit:read"],
  input: z.object({ id: Uuid, from: z.string().date().optional(), days: z.number().int().min(1).max(60).optional() }),
  output: z.object({ slots: z.array(Slot) }),
});

export const proposeVisitChangeTime = defineRoute({
  method: "post",
  path: "/v1/visit-change-requests/{id}/propose",
  summary: "Offer the customer a different time",
  description:
    "Nothing moves. The customer is sent the time with a link to say yes or no, by text where they can be texted and by email otherwise, and the time is held against its window while they decide. `response` is sent to them as written. Only for a request to move a visit, and only a time online booking would offer.",
  module: "M05",
  permissions: ["visit:reschedule"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    date: z.string().date(),
    arrivalWindowId: Uuid,
    response: z.string().max(1000).optional(),
  }),
  output: RequestView,
});

export const visitChangeRoutes = {
  getPortalVisitChange, requestPortalVisitChange, answerPortalVisitChangeProposal,
  listVisitChangeRequests, approveVisitChangeRequest, declineVisitChangeRequest,
  listVisitChangeTimes, proposeVisitChangeTime,
} as const;
