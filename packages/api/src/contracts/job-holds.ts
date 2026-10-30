import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { JobStatus } from "./jobs";

/**
 * WHY A JOB IS ON HOLD
 *
 * A hold is a record with a reason from a fixed list, and a part hold names
 * the purchase order the part is on. The plumbing and electrical first time
 * fix rates leave out "jobs held for a part order" (an electrician's "or an
 * inspection"), and they read this, never the words in a note.
 */
export const HoldReason = z.enum(["part", "inspection", "customer", "weather", "other"]);

export const JobHold = z.object({
  id: Uuid,
  jobId: Uuid,
  reason: HoldReason,
  /** The reason as an owner says it: "Waiting on a part". */
  reasonLabel: z.string(),
  purchaseOrderId: Uuid.nullable(),
  /** Null for a reader without `po:read`, who is told an order was named and not which. */
  purchaseOrderNumber: z.number().int().nullable(),
  purchaseOrderStatus: z.string().nullable(),
  note: z.string().nullable(),
  /** Where the job goes back to when it comes off hold. */
  statusBefore: JobStatus,
  placedAt: z.string().datetime(),
  placedByName: z.string().nullable(),
  /** Null while the job is still held. */
  releasedAt: z.string().datetime().nullable(),
});

const Holds = z.object({ data: z.array(JobHold) });

export const listJobHolds = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}/holds",
  summary: "Why a job is, or was, on hold",
  description: "Every hold the job has had, oldest first. The open one has no `releasedAt`.",
  module: "M10",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: Holds,
});

export const placeJobHold = defineRoute({
  method: "post",
  path: "/v1/jobs/{id}/holds",
  summary: "Put a job on hold, saying why",
  description:
    "Moves a booked job, or one under way, to on hold with a reason from a fixed list. A part hold names the purchase order the part is on (and needs `po:read` to name it); an inspection, or anything else, says which in `note`. A job already on hold for a reason is refused: take it off hold first. A job moved to on hold before reasons existed can be given one here, and goes back to booked when it comes off.",
  module: "M10",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    reason: HoldReason,
    purchaseOrderId: Uuid.optional(),
    note: z.string().max(2000).optional(),
    /**
     * The part a technician asked for from the field (`GET /v1/jobs/{id}/part-requests`) that this
     * hold answers. Only with `reason: "part"`, once per request: the request names the hold and
     * the office task it raised is finished.
     */
    partRequestId: Uuid.optional(),
  }),
  output: Holds,
});

export const PartRequest = z.object({
  id: Uuid,
  jobId: Uuid,
  visitId: Uuid.nullable(),
  /** The part in the technician's words. */
  part: z.string(),
  note: z.string().nullable(),
  requestedAt: z.string().datetime(),
  /** Who asked, by their name on the team. */
  requestedBy: z.string().nullable(),
  /** The office task it raised, and that task's status. */
  taskId: Uuid.nullable(),
  taskStatus: z.string().nullable(),
  /** The hold the office placed from it. Null until then. */
  holdId: Uuid.nullable(),
  /** The order the hold names. Null before a hold, and for a reader without `po:read`. */
  purchaseOrderId: Uuid.nullable(),
  purchaseOrderNumber: z.number().int().nullable(),
});

export const listJobPartRequests = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}/part-requests",
  summary: "Parts a technician asked for from the field",
  description:
    "Every part asked for on the job from the phone (`part.request` in the field queue), oldest first, each with the office task it raised and, once the office put the job on hold for it, the hold and the order. A technician never places a hold; the office does, from the task, with `partRequestId` on `POST /v1/jobs/{id}/holds`.",
  module: "M10",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: z.object({ data: z.array(PartRequest) }),
});

export const releaseJobHold = defineRoute({
  method: "post",
  path: "/v1/job-holds/{id}/released",
  summary: "Take a job off hold",
  description:
    "Closes the hold and puts the job back in the status it was held from. A job somebody already moved off hold some other way only has its hold closed (an ordinary status change closes it too).",
  module: "M10",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Holds,
});

const HoldNudge = z.object({
  /** How many days on hold before the office is nudged. Null: off. */
  days: z.number().int().min(1).max(90).nullable(),
});

export const getJobHoldNudge = defineRoute({
  method: "get",
  path: "/v1/job-hold-nudge",
  summary: "How long a job may stay on hold before the office is nudged",
  module: "M10",
  permissions: ["settings:read"],
  input: z.object({}),
  output: HoldNudge,
});

export const setJobHoldNudge = defineRoute({
  method: "patch",
  path: "/v1/job-hold-nudge",
  summary: "Set how long a job may stay on hold before the office is nudged",
  description:
    "Whole days from 1 to 90, counted in the company's own calendar, or null to turn it off (it is off until a company turns it on). When a hold has lasted that long the worker raises one task in the office queue about the job, naming the job, the reason it is held and how long; ending the hold closes it. One task per hold: a task somebody closed by hand is not raised again for the same hold. Holds already past the new number are nudged on the next pass, and tasks already raised stay where they are.",
  module: "M10",
  permissions: ["settings:write"],
  idempotent: true,
  input: HoldNudge,
  output: HoldNudge,
});

export const jobHoldRoutes = { listJobHolds, placeJobHold, releaseJobHold, getJobHoldNudge, setJobHoldNudge, listJobPartRequests } as const;
