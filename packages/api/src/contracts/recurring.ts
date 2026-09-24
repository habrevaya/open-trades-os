import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * RECURRING WORK
 *
 * A pool route, a quarterly pest treatment, a commercial filter change.
 * Distinct from an agreement's included visits, which have their own table:
 * this is work a company runs without having sold anybody a membership.
 *
 * FOUR MODELS, NOT ONE, and the API publishes all four because
 * reconstructing the wrong one silently drifts every future date. A
 * maintenance visit that slides a week each cycle is invisible for a year
 * and then the customer says nobody came.
 *
 * The one that matters is `anchored_to_completion`: weekly means seven days
 * from when the technician was ACTUALLY there, not every Tuesday forever, so
 * a rain day shifts the whole series rather than losing a visit out of the
 * quarter. It follows that only ONE future occurrence is knowable, and this
 * API returns one for that model rather than pretending otherwise.
 *
 * EVERY DATE HERE IS A CALENDAR DATE. A visit due on the 15th is due on the
 * 15th in the customer's town, and running that through a timezone is how it
 * becomes the 14th for half the country twice a year.
 */

export const RecurrenceModel = z.enum([
  /** A rule plus an anchor. Occurrences computed, calendar style. */
  "rule",
  /** Every future occurrence exists as a real row, editable individually. */
  "materialized",
  /** Counted from when the last one actually completed. Pool, pest, lawn, bins. */
  "anchored_to_completion",
  /** No rule at all. The office rebooks by hand each cycle. */
  "manual",
]);

export const RecurringSchedule = z.object({
  id: Uuid,
  label: z.string(),
  customerId: Uuid.nullable(),
  customerName: z.string().nullable(),
  propertyId: Uuid.nullable(),
  summary: z.string(),
  model: RecurrenceModel,
  intervalDays: z.number().int().nullable(),
  anchorMonths: z.array(z.number().int()),
  startsOn: z.string().date(),
  endsOn: z.string().date().nullable(),
  /** When the technician was really there. The field the anchored model turns on. */
  lastOccurredOn: z.string().date().nullable(),
  nextDueOn: z.string().date().nullable(),
  active: z.boolean(),
  /** How many occurrences have been skipped or moved. */
  exceptions: z.number().int(),
});

export const listRecurringSchedules = defineRoute({
  method: "get",
  path: "/v1/recurring-schedules",
  summary: "Recurring work, soonest due first",
  module: "M09",
  permissions: ["job:read"],
  input: z.object({}),
  output: z.object({ schedules: z.array(RecurringSchedule) }),
});

export const createRecurringSchedule = defineRoute({
  method: "post",
  path: "/v1/recurring-schedules",
  summary: "Set up recurring work",
  description:
    "A rule with neither an interval nor anchor months is refused, because it would generate nothing, and a schedule that generates nothing looks identical on every screen to one whose work is simply not due yet.",
  module: "M09",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    label: z.string().min(1).max(200),
    customerId: Uuid,
    propertyId: Uuid,
    summary: z.string().min(1).max(500),
    model: RecurrenceModel,
    startsOn: z.string().date(),
    endsOn: z.string().date().nullable().optional(),
    /** Required for the anchored model: it is the whole of that model. */
    intervalDays: z.number().int().min(1).max(3650).nullable().optional(),
    /** 1 through 12. A heating tune up belongs in autumn whenever it was sold. */
    anchorMonths: z.array(z.number().int().min(1).max(12)).optional(),
    jobTypeId: Uuid.nullable().optional(),
    estimatedDurationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
    /**
     * How far ahead work is created. Bounded on purpose: an unbounded series
     * fills a dispatch board with rows nobody will look at for three years,
     * and no horizon at all leaves it empty next week.
     */
    horizonMonths: z.number().int().min(1).max(60).optional(),
  }),
  output: z.object({ id: Uuid, label: z.string(), nextDueOn: z.string().date().nullable() }),
});

export const previewRecurringSchedule = defineRoute({
  method: "get",
  path: "/v1/recurring-schedules/{id}/preview",
  summary: "What it would produce, without producing it",
  description:
    "The commonest mistake setting one of these up is an anchor month or an interval meaning something other than what somebody had in mind, and finding that out by generating a year of jobs onto a dispatch board is an afternoon of deleting them.",
  module: "M09",
  permissions: ["job:read"],
  input: z.object({
    id: Uuid,
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  output: z.object({
    scheduleId: Uuid,
    occurrences: z.array(z.object({
      date: z.string().date(),
      /** True when an exception moved this one off its natural date. */
      moved: z.boolean(),
      /** Its place in the series, kept through a move so "visit two of four" stays true. */
      sequence: z.number().int(),
    })),
    /**
     * True for the anchored model, where the date after next depends on when
     * next actually completes. Published rather than left to surprise
     * somebody by a short preview.
     */
    onlyOneKnowable: z.boolean(),
  }),
});

export const materialiseRecurringSchedule = defineRoute({
  method: "post",
  path: "/v1/recurring-schedules/{id}/materialise",
  summary: "Turn what is due into real jobs",
  description:
    "Idempotent by construction, because a timer runs it: each job carries its schedule and date as its source reference, and an occurrence that already has one is skipped. A worker running twice in a minute would otherwise put two technicians on one pool.",
  module: "M09",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** Defaults to the schedule's own horizon. */
    through: z.string().date().optional(),
  }),
  output: z.object({
    scheduleId: Uuid,
    created: z.array(z.object({ jobId: Uuid, dueOn: z.string().date() })),
    /** Occurrences that already had a job. Not an error on a timer. */
    alreadyThere: z.number().int(),
    nextDueOn: z.string().date().nullable(),
  }),
});

export const recordRecurringCompletion = defineRoute({
  method: "post",
  path: "/v1/recurring-schedules/{id}/completed",
  summary: "The visit actually happened",
  description:
    "The load bearing call for work measured from completion: the next date is counted from when the technician was really there, so a rain day shifts the whole series rather than losing a visit out of the quarter. A backdated completion is refused, because it would pull every future occurrence backwards.",
  module: "M09",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, completedOn: z.string().date() }),
  output: z.object({
    id: Uuid,
    lastOccurredOn: z.string().date(),
    nextDueOn: z.string().date().nullable(),
  }),
});

export const exceptRecurringOccurrence = defineRoute({
  method: "post",
  path: "/v1/recurring-schedules/{id}/exceptions",
  summary: "The customer declined this one, or it moves",
  description:
    "Kept rather than deleted. A customer who said no has told us something, and losing it means re-offering work they already refused. A moved occurrence keeps its place in the sequence.",
  module: "M09",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    date: z.string().date(),
    action: z.enum(["skipped", "moved", "cancelled"]),
    movedTo: z.string().date().optional(),
    reason: z.string().max(500).optional(),
  }),
  output: z.object({
    id: Uuid,
    exceptions: z.number().int(),
    nextDueOn: z.string().date().nullable(),
  }),
});

export const setRecurringScheduleActive = defineRoute({
  method: "post",
  path: "/v1/recurring-schedules/{id}/active",
  summary: "Stop or restart a series without losing its history",
  module: "M09",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, active: z.boolean() }),
  output: z.object({ id: Uuid, active: z.boolean() }),
});

export const listRecurringDue = defineRoute({
  method: "get",
  path: "/v1/recurring-schedules/due",
  summary: "Schedules with work due, for the worker that creates it",
  description:
    "A shortlist rather than the decision. Materialising recomputes from the spec, so a stale next due date delays a job by one pass and never creates a wrong one.",
  module: "M09",
  permissions: ["job:read"],
  input: z.object({ on: z.string().date().optional() }),
  output: z.object({
    schedules: z.array(z.object({ id: Uuid, nextDueOn: z.string().date().nullable() })),
  }),
});

export const recurringRoutes = {
  listRecurringSchedules, createRecurringSchedule, previewRecurringSchedule,
  materialiseRecurringSchedule, recordRecurringCompletion,
  exceptRecurringOccurrence, setRecurringScheduleActive, listRecurringDue,
} as const;
