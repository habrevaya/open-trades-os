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
  }),
  output: Holds,
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

export const jobHoldRoutes = { listJobHolds, placeJobHold, releaseJobHold } as const;
