import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * FRESH WATER, BY TRUCK AND DAY (M22)
 *
 * What a truck's tank says it used on a day, read by the driver on the phone
 * (`truck.water`) or typed by the office here. The trash bin trade's fresh
 * water per stop divides it by the stops completed that day by whoever had
 * the truck, per truck, because one truck drifting upward is a nozzle or a
 * burner going.
 */
export const TruckWaterDay = z.object({
  assetId: Uuid,
  label: z.string(),
  onDay: z.string().date(),
  /** Stops completed that day by whoever had the truck checked out. */
  stops: z.number().int(),
  /** Gallons of fresh water read for the day, or null when nobody read it. */
  gallons: z.string().nullable(),
  /** `phone` or `office`, for a day that has a reading. */
  source: z.string().nullable(),
  /** Gallons a stop, to one place, for a day with both. */
  perStop: z.string().nullable(),
});

export const TruckWaterReading = z.object({
  id: Uuid,
  assetId: Uuid,
  onDay: z.string().date(),
  gallons: z.string(),
  source: z.string(),
  recordedAt: z.string().datetime(),
  note: z.string().nullable(),
});

export const listTruckWater = defineRoute({
  method: "get",
  path: "/v1/truck-water",
  summary: "Each truck's days: the stops its driver completed and the fresh water read",
  description:
    "A day with stops or with a reading, for every company vehicle someone had checked out. The same truck days the trade scorecard's fresh water per stop counts: a day with stops and no reading is not read, never no water.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({ from: z.string().date(), to: z.string().date() }),
  output: z.object({ days: z.array(TruckWaterDay) }),
});

export const recordTruckWater = defineRoute({
  method: "put",
  path: "/v1/assets/{assetId}/water/{day}",
  summary: "Record the fresh water a truck used on a day",
  description:
    "Gallons, read off the tank gauge or the fill meter. One figure per truck per day: recording it again replaces it, and between two readings of a day the later one stands (a phone that synced late with an older reading does not undo a correction). Refused for anything but a vehicle in the fleet that day, for a day still to come, and for more than a truck uses in a day.",
  module: "M22",
  permissions: ["asset:write"],
  input: z.object({
    assetId: Uuid,
    day: z.string().date(),
    gallons: z.string().max(20),
    note: z.string().max(500).nullable().optional(),
  }),
  output: TruckWaterReading,
});

export const removeTruckWater = defineRoute({
  method: "delete",
  path: "/v1/assets/{assetId}/water/{day}",
  summary: "Take off a day's water reading",
  description:
    "For a reading made on the wrong truck. The day is then not read, which fresh water per stop counts beside the figure rather than as no water. On the audit log.",
  module: "M22",
  permissions: ["asset:write"],
  input: z.object({ assetId: Uuid, day: z.string().date() }),
  output: z.object({ ok: z.literal(true) }),
});

export const truckWaterRoutes = { listTruckWater, recordTruckWater, removeTruckWater } as const;
