import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * THE TIMES A CONTAINER'S TURNAROUND IS MADE OF (M22)
 *
 * When a full can was emptied at the facility, the moment a can was put down
 * on a site, and the periods a can was out for repair or held because a
 * customer asked. The dumpster pack's turnaround is hours from the first to
 * the second, leaving out a can that spent any of them in the third. The
 * driver records the first two on the phone (`haul.time`); the office records
 * or corrects them here.
 */

export const ContainerHold = z.object({
  id: Uuid,
  assetId: Uuid,
  assetIdentifier: z.string(),
  kind: z.enum(["repair", "customer"]),
  /** Null only for a repair already running when this history began: since when, nobody knows. */
  startsAt: z.string().datetime().nullable(),
  /** Null while it is still running. */
  endsAt: z.string().datetime().nullable(),
  reason: z.string(),
  customerId: Uuid.nullable(),
  customerName: z.string().nullable(),
});

export const recordRentalTip = defineRoute({
  method: "put",
  path: "/v1/rentals/{id}/tipped-at",
  summary: "Record when a haul's load was emptied at the facility",
  description:
    "The moment the full can was tipped, typed when the ticket arrives or corrected; null clears it. Not the pickup, which includes the drive and the queue at the gate, and not the scale ticket's weighbridge time. Refused when still to come, before the delivery, on a day before the collection, or after the can was already on its next site, so a turnaround cannot run backwards. The driver records the same from the phone. On the audit log.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ id: Uuid, tippedAt: z.string().datetime().nullable() }),
  output: z.object({ id: Uuid, tippedAt: z.string().datetime().nullable() }),
});

export const recordRentalDrop = defineRoute({
  method: "put",
  path: "/v1/rentals/{id}/delivered-at",
  summary: "Record the time a can was put down",
  description:
    "For a delivery recorded as a day: the moment on that day the can was dropped. Only on the day already recorded, because the day is what the hire bills and a time cannot move it. A can left by a swap moves the swap with it. Refused before the can's last tip. On the audit log.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ id: Uuid, deliveredAt: z.string().datetime() }),
  output: z.object({ id: Uuid, deliveredAt: z.string().datetime(), deliveredTimeKnown: z.boolean() }),
});

export const listContainerHolds = defineRoute({
  method: "get",
  path: "/v1/container-holds",
  summary: "When containers were out for repair or held for a customer",
  description:
    "Each period, newest first, with its start and end. A repair is opened by tagging a can out (or collecting it with `backInService` false) and closed by putting it back in service; a customer hold is opened and ended here. The turnaround between pickup and redelivery leaves out a can that spent any of its turnaround in one.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({
    assetId: Uuid.optional(),
    /** Only those still running. */
    open: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  output: z.object({ data: z.array(ContainerHold) }),
});

export const holdContainer = defineRoute({
  method: "post",
  path: "/v1/rentable-assets/{id}/holds",
  summary: "Hold a container for a customer who asked",
  description:
    "From `startsAt` (or now), until `endsAt` when it has already ended. A hold still running keeps a can in the yard, so it is refused for a can on a site; one that has ended is history and can be recorded after the fact. Two customer holds on one can at once are refused. Delivering the can ends a running hold. On the audit log.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    reason: z.string().min(1).max(500),
    customerId: Uuid.nullable().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().nullable().optional(),
  }),
  output: ContainerHold,
});

export const endContainerHold = defineRoute({
  method: "post",
  path: "/v1/container-holds/{id}/end",
  summary: "End a customer hold",
  description:
    "At `endsAt` or now. A repair is not ended here: it ends when the can is put back in service. Refused for a hold already ended. On the audit log.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ id: Uuid, endsAt: z.string().datetime().optional() }),
  output: ContainerHold,
});

export const haulTimeRoutes = {
  recordRentalTip, recordRentalDrop, listContainerHolds, holdContainer, endContainerHold,
} as const;
