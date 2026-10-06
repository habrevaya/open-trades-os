import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { DriveSource, RebalancedDay, Workday } from "./dispatch-map";

/**
 * SEVERAL DAYS REBALANCED, AND WHAT A CUSTOMER AGREED TO
 *
 * A proposal that may move a visit to another day of the range, only one
 * whose customer agreed to it (a range of days on the visit, the window of
 * the agreement visit it delivers, or the days of the week that suit them),
 * shown as each day before and after and applied by a person. And the two
 * things a customer agrees to, set from the office.
 */

const DayMove = z.object({
  visitId: Uuid,
  customerName: z.string(),
  fromDate: z.string().date(),
  toDate: z.string().date(),
  fromTechnicianId: Uuid.nullable(),
  fromName: z.string().nullable(),
  toTechnicianId: Uuid,
  toName: z.string(),
  /** The window on the new day: the same wall clock times. */
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime().nullable(),
  /** `range` when the customer agreed a range of days, `weekdays` when they named the days that suit them. */
  because: z.enum(["range", "weekdays"]),
});

export const getMultiDayRebalance = defineRoute({
  method: "get",
  path: "/v1/dispatch/rebalance/days",
  summary: "Propose several days rebalanced, moving visits between days where the customer agreed",
  description:
    "A proposal, never a change. Each day of the range is rebalanced as `GET /v1/dispatch/rebalance` does, and a visit may also move to another day of the range: only one whose customer agreed (a range of days on the visit, the window of the agreement visit it delivers, or their preferred days of the week), never onto or off today, never onto a day the company is closed, and only when that keeps a window or a limit, places work no day could take, cuts overtime, or saves at least fifteen minutes of driving. Each day is shown before and after. Applying it is `POST /v1/dispatch/rebalance/days/apply` with `basis` and `apply`.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({ from: z.string().date(), days: z.number().int().min(2).max(7).default(5) }),
  output: z.object({
    from: z.string().date(),
    days: z.number().int(),
    /** The days this was proposed from. Applying is refused once any of them has changed. */
    basis: z.string(),
    changed: z.boolean(),
    /** Visits that may go to another day of the range at all, and on what grounds. */
    movable: z.array(z.object({ visitId: Uuid, customerName: z.string(), because: z.enum(["range", "weekdays"]) })),
    /** Visits that would move to another day: each is a customer who will be told. */
    dayMoves: z.array(DayMove),
    /** Visits that stay on their day with somebody else. */
    moves: z.array(z.object({
      visitId: Uuid,
      customerName: z.string(),
      date: z.string().date(),
      fromTechnicianId: Uuid.nullable(),
      fromName: z.string().nullable(),
      toTechnicianId: Uuid,
      toName: z.string(),
    })),
    /** Each day as it is and as it would be. */
    perDay: z.array(z.object({
      date: z.string().date(),
      visitsBefore: z.number().int(),
      visitsAfter: z.number().int(),
      driveBeforeMinutes: z.number().int(),
      driveAfterMinutes: z.number().int(),
      overtimeBeforeMinutes: z.number().int(),
      overtimeAfterMinutes: z.number().int(),
      technicians: z.array(z.object({
        technicianId: Uuid,
        displayName: z.string(),
        color: z.string().nullable(),
        timeOff: z.boolean(),
        before: RebalancedDay,
        after: RebalancedDay,
      })),
      unplaced: z.array(z.object({ visitId: Uuid, customerName: z.string(), reason: z.string() })),
      leftOut: z.array(z.object({ technicianId: Uuid, displayName: z.string(), reason: z.string() })),
    })),
    /** Every visit planned, so a screen can name the stops. */
    visits: z.array(z.object({
      visitId: Uuid,
      customerName: z.string(),
      date: z.string().date(),
      locked: z.boolean(),
      windowStart: z.string().datetime().nullable(),
      windowEnd: z.string().datetime().nullable(),
    })),
    driveBeforeMinutes: z.number().int(),
    driveAfterMinutes: z.number().int(),
    overtimeBeforeMinutes: z.number().int(),
    overtimeAfterMinutes: z.number().int(),
    /** Ready for the apply call. */
    apply: z.object({
      dayMoves: z.array(z.object({ visitId: Uuid, toDate: z.string().date(), technicianId: Uuid })),
      moves: z.array(z.object({ visitId: Uuid, technicianId: Uuid })),
      orders: z.array(z.object({ date: z.string().date(), technicianId: Uuid, visitIds: z.array(Uuid) })),
    }),
    workday: Workday,
    ...DriveSource,
  }),
});

export const applyMultiDayRebalance = defineRoute({
  method: "post",
  path: "/v1/dispatch/rebalance/days/apply",
  summary: "Apply several rebalanced days somebody looked at",
  description:
    "Moves each visit to its new day at the same wall clock times and puts it on the person proposed through the assignment a drag uses, so skills and time off are checked again on the new day; tells the people on it through the visit's notices and each customer by text or email through the same path an answer to their own request to move uses, overtaking any request of theirs still waiting; then assigns the visits that change person on their own day and sets each changed day's order. One transaction: a refusal anywhere leaves every day as it was. A move the customer did not agree to is refused, and so is the whole apply once any day of the range has changed since `basis` was taken.",
  module: "M09",
  permissions: ["visit:dispatch", "visit:reschedule"],
  idempotent: true,
  input: z.object({
    from: z.string().date(),
    days: z.number().int().min(2).max(7),
    basis: z.string().min(1).max(100),
    dayMoves: z.array(z.object({ visitId: Uuid, toDate: z.string().date(), technicianId: Uuid })).max(200),
    moves: z.array(z.object({ visitId: Uuid, technicianId: Uuid })).max(400),
    orders: z.array(z.object({ date: z.string().date(), technicianId: Uuid, visitIds: z.array(Uuid).max(60) })).max(400),
  }),
  output: z.object({
    ok: z.literal(true),
    movedDays: z.number().int(),
    moved: z.number().int(),
    reordered: z.number().int(),
    /** Each customer whose visit moved day, and whether they were told: `queued`, or why not in words. */
    told: z.array(z.object({ visitId: Uuid, notified: z.string() })),
  }),
});

export const setVisitMovable = defineRoute({
  method: "put",
  path: "/v1/visits/{id}/movable",
  summary: "Record the days the customer agreed a visit may happen on",
  description:
    "Inclusive, in the company's calendar; null at an end is open at that end, and both null clears it. Read by the multi day rebalance, which may move the visit to another day inside it (and inside the customer's preferred days of the week, when they have named any). Setting it moves nothing.",
  module: "M09",
  permissions: ["visit:reschedule"],
  input: z.object({ id: Uuid, from: z.string().date().nullable(), until: z.string().date().nullable() }),
  output: z.object({ id: Uuid, movableFrom: z.string().date().nullable(), movableUntil: z.string().date().nullable() }),
});

export const setCustomerPreferredDays = defineRoute({
  method: "put",
  path: "/v1/customers/{id}/preferred-days",
  summary: "Record the days of the week that suit a customer",
  description:
    "0 for Sunday through 6 for Saturday; an empty list is any day. The multi day rebalance may move one of their visits to another of these days, and to no other, and tells them when it does.",
  module: "M09",
  permissions: ["customer:write"],
  input: z.object({ id: Uuid, days: z.array(z.number().int().min(0).max(6)).max(7) }),
  output: z.object({ id: Uuid, preferredDays: z.array(z.number().int()) }),
});

export const dispatchDaysRoutes = {
  getMultiDayRebalance, applyMultiDayRebalance, setVisitMovable, setCustomerPreferredDays,
} as const;
