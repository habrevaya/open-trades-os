import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { recurrence as rc, time } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, NotFoundError, ConflictError, timezoneOf,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";
import { nextNumber } from "./jobs";

/**
 * RECURRING WORK
 *
 * A pool route, a quarterly pest treatment, a commercial filter change. Work
 * that comes back on a cadence, billed per visit or on a contract, run by
 * companies who have never sold anybody a membership.
 *
 * `packages/core/src/recurrence` is the module that knows how to do this,
 * and its header explains why there are four models rather than one:
 * research across the systems people migrate FROM found four genuinely
 * different ones, and reconstructing the wrong one silently drifts every
 * future date. A maintenance visit that slides a week each cycle is
 * invisible for a year and then the customer says nobody came.
 *
 * It had no callers. `recurring_schedule` had no writers, and could not have
 * had any: it carried a cadence, a horizon and an exception list with
 * nothing on it saying whose pool it was.
 *
 * THE MODEL THAT EARNS THE OTHER THREE
 *
 * `anchored_to_completion` is the one a cadence-only system gets wrong.
 * Weekly means seven days from when the technician was actually there, not
 * every Tuesday forever. A rain day shifts the whole series; a calendar rule
 * silently skips that week and the customer is short a visit by the quarter.
 *
 * It also means only ONE future occurrence is knowable. The date after next
 * depends on when next actually completes, and materialising a year of them
 * is the lie that makes a route drift. This service therefore creates
 * exactly one job ahead for that model, and core is what decides that rather
 * than a condition here.
 *
 * EVERYTHING IS A CALENDAR DATE, NEVER AN INSTANT. A visit due on the 15th
 * is due on the 15th in the customer's town. Putting that through a timezone
 * is how it becomes the 14th for half the country twice a year.
 */

const toSpec = (row: typeof schema.recurringSchedule.$inferSelect): rc.RecurrenceSpec => ({
  model: row.model,
  startsOn: row.startsOn,
  ...(row.endsOn ? { endsOn: row.endsOn } : {}),
  ...(row.intervalDays ? { intervalDays: row.intervalDays } : {}),
  ...(row.anchorMonths.length > 0 ? { anchorMonths: row.anchorMonths } : {}),
  ...(row.lastOccurredOn ? { lastOccurredOn: row.lastOccurredOn } : {}),
  exceptions: row.exceptions,
  horizonMonths: row.horizonMonths,
});

export interface ScheduleInput {
  label: string;
  customerId: string;
  propertyId: string;
  summary: string;
  model: typeof schema.recurrenceModel.enumValues[number];
  startsOn: string;
  /**
   * `| undefined` on every optional, not just `| null`. Under
   * `exactOptionalPropertyTypes` a zod `.optional().nullable()` produces
   * all three, and an absent key is a real state a field typed
   * `string | null` cannot receive.
   */
  endsOn?: string | null | undefined;
  intervalDays?: number | null | undefined;
  anchorMonths?: number[] | undefined;
  jobTypeId?: string | null | undefined;
  estimatedDurationMinutes?: number | null | undefined;
  horizonMonths?: number | undefined;
}

/**
 * Set up a recurring job.
 *
 * The model's own requirements are checked here rather than left to produce
 * an empty series later. A `rule` schedule with neither an interval nor
 * anchor months generates nothing, and a schedule that generates nothing
 * looks identical on every screen to one whose work is simply not due yet.
 */
export async function create(ctx: ServiceContext, input: ScheduleInput) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const anchors = input.anchorMonths ?? [];

    if (input.model === "rule" && anchors.length === 0 && !input.intervalDays) {
      throw new ConflictError(
        "A rule needs either a number of days between visits or the months to pin them to. "
        + "With neither it would generate nothing, which looks exactly like work that is not due yet.",
      );
    }
    if (input.model === "anchored_to_completion" && !input.intervalDays) {
      throw new ConflictError(
        "Work measured from the last completion needs to know how many days. "
        + "That is the whole model: seven days from when the technician was actually there.",
      );
    }
    for (const month of anchors) {
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new ConflictError(`${month} is not a month. Anchor months are 1 through 12.`);
      }
    }
    if (input.endsOn && input.endsOn < input.startsOn) {
      throw new ConflictError("That schedule ends before it starts.");
    }

    const [property] = await tx.select({ id: schema.property.id })
      .from(schema.property)
      .where(eq(schema.property.id, input.propertyId)).limit(1);
    if (!property) throw new NotFoundError("Property");

    const spec: rc.RecurrenceSpec = {
      model: input.model,
      startsOn: input.startsOn,
      ...(input.endsOn ? { endsOn: input.endsOn } : {}),
      ...(input.intervalDays ? { intervalDays: input.intervalDays } : {}),
      ...(anchors.length > 0 ? { anchorMonths: anchors } : {}),
      horizonMonths: input.horizonMonths ?? 12,
    };

    const [row] = await tx.insert(schema.recurringSchedule).values({
      organizationId: ctx.actor.organizationId,
      label: input.label,
      customerId: input.customerId,
      propertyId: input.propertyId,
      jobTypeId: input.jobTypeId ?? null,
      summary: input.summary,
      estimatedDurationMinutes: input.estimatedDurationMinutes ?? null,
      model: input.model,
      startsOn: input.startsOn,
      endsOn: input.endsOn ?? null,
      intervalDays: input.intervalDays ?? null,
      anchorMonths: anchors,
      horizonMonths: input.horizonMonths ?? 12,
      /**
       * Computed from the spec rather than defaulted to the start date. A
       * seasonal schedule created in January is not due in January, and a
       * `next_due_on` that said so would put it at the top of every list of
       * work that is due.
       */
      nextDueOn: rc.nextOccurrence(spec, rc.addDays(input.startsOn, -1)),
    }).returning();

    await audit(tx, ctx, "recurring_schedule.created", "recurring_schedule", row!.id, null, row!);
    return row!;
  });
}

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const rows = await tx.select({
      schedule: schema.recurringSchedule,
      customerName: schema.customer.name,
    }).from(schema.recurringSchedule)
      .leftJoin(schema.customer, eq(schema.customer.id, schema.recurringSchedule.customerId))
      .where(and(
        eq(schema.recurringSchedule.organizationId, ctx.actor.organizationId),
        isNull(schema.recurringSchedule.deletedAt),
      ))
      .orderBy(asc(schema.recurringSchedule.nextDueOn));

    return rows.map(({ schedule, customerName }) => ({
      id: schedule.id,
      label: schedule.label,
      customerId: schedule.customerId,
      customerName,
      propertyId: schedule.propertyId,
      summary: schedule.summary,
      model: schedule.model,
      intervalDays: schedule.intervalDays,
      anchorMonths: schedule.anchorMonths,
      startsOn: schedule.startsOn,
      endsOn: schedule.endsOn,
      lastOccurredOn: schedule.lastOccurredOn,
      nextDueOn: schedule.nextDueOn,
      active: schedule.active,
      exceptions: schedule.exceptions.length,
    }));
  });
}

/**
 * What this schedule would produce, without producing it.
 *
 * A preview rather than a side effect, because the commonest mistake setting
 * one of these up is an anchor month or an interval that means something
 * different from what somebody had in mind, and finding that out by
 * generating a year of jobs onto a dispatch board is an afternoon of
 * deleting them.
 */
export async function preview(
  ctx: ServiceContext,
  input: { id: string; from?: string; to?: string },
) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const row = await load(tx, ctx.actor.organizationId, input.id);
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const from = input.from ?? time.dateIn(new Date(), zone);
    const to = input.to ?? rc.addMonths(from, row.horizonMonths);

    return {
      scheduleId: row.id,
      occurrences: rc.occurrencesBetween(toSpec(row), from, to),
      /**
       * Said out loud, because it is the property of this model people are
       * most surprised by and the reason a preview looks short.
       */
      onlyOneKnowable: row.model === "anchored_to_completion",
    };
  });
}

async function load(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.recurringSchedule)
    .where(and(
      eq(schema.recurringSchedule.id, id),
      eq(schema.recurringSchedule.organizationId, organizationId),
      isNull(schema.recurringSchedule.deletedAt),
    )).limit(1);
  if (!row) throw new NotFoundError("Recurring schedule");
  return row;
}

export interface MaterialiseResult {
  scheduleId: string;
  created: { jobId: string; dueOn: string }[];
  /** Occurrences that already had a job. Not an error: this runs on a timer. */
  alreadyThere: number;
  nextDueOn: string | null;
}

/**
 * Turn what is due into real jobs.
 *
 * Bounded by the horizon, which is the whole reason the column exists.
 * Materialising an unbounded series fills a dispatch board with rows nobody
 * will look at for three years; materialising none leaves it empty next
 * week.
 *
 * IDEMPOTENT BY CONSTRUCTION, because this is a thing a timer runs. Each
 * occurrence carries its date in the job's `sourceRef`, and a job already
 * carrying that date for this schedule is skipped rather than duplicated. A
 * worker that ran twice in a minute would otherwise put two technicians on
 * one pool.
 */
export async function materialise(
  ctx: ServiceContext,
  input: { id: string; through?: string },
): Promise<MaterialiseResult> {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const row = await load(tx, ctx.actor.organizationId, input.id);
    if (!row.active) {
      throw new ConflictError("That schedule is paused, so nothing should be created from it.");
    }
    if (!row.customerId || !row.propertyId) {
      throw new ConflictError("That schedule has no customer or property on it, so there is nobody to create work for.");
    }

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = time.dateIn(new Date(), zone);
    const through = input.through ?? rc.addMonths(today, row.horizonMonths);

    /**
     * From the start of the series, not from today. A schedule created
     * yesterday for a series starting last month still owes those
     * occurrences, and a window beginning today would silently drop them.
     */
    const occurrences = rc.occurrencesBetween(toSpec(row), row.startsOn, through);

    const existing = await tx.select({ ref: schema.job.sourceId })
      .from(schema.job)
      .where(and(
        eq(schema.job.organizationId, ctx.actor.organizationId),
        eq(schema.job.sourceSystem, "recurring_schedule"),
      ));
    const seen = new Set(existing.map((e) => e.ref).filter((r): r is string => r !== null));

    const created: { jobId: string; dueOn: string }[] = [];
    let alreadyThere = 0;

    for (const occurrence of occurrences) {
      const ref = `${row.id}:${occurrence.date}`;
      if (seen.has(ref)) { alreadyThere += 1; continue; }

      const number = await nextNumber(tx, ctx.actor.organizationId, "job");
      const [job] = await tx.insert(schema.job).values({
        organizationId: ctx.actor.organizationId,
        number,
        customerId: row.customerId,
        propertyId: row.propertyId,
        jobTypeId: row.jobTypeId,
        status: "scheduled",
        summary: row.summary || row.label,
        sourceSystem: "recurring_schedule",
        /**
         * The schedule AND the date, so the pair is the identity. Keying on
         * the schedule alone would make the second occurrence look like a
         * duplicate of the first.
         */
        sourceId: ref,
      }).returning({ id: schema.job.id });

      await tx.insert(schema.visit).values({
        organizationId: ctx.actor.organizationId,
        jobId: job!.id,
        sequence: 1,
        status: "unassigned",
        /**
         * The whole working day in the company's zone. A recurring route has
         * a date and not a time until a dispatcher gives it one, and
         * inventing 09:00 would publish an arrival window nobody promised.
         */
        windowStart: time.dayBoundsIn(occurrence.date, zone).start,
        windowEnd: time.dayBoundsIn(occurrence.date, zone).end,
        estimatedDurationMinutes: row.estimatedDurationMinutes ?? 60,
      });

      created.push({ jobId: job!.id, dueOn: occurrence.date });
      seen.add(ref);
    }

    const nextDueOn = rc.nextOccurrence(toSpec(row), today);
    await tx.update(schema.recurringSchedule)
      .set({ nextDueOn, updatedAt: new Date() })
      .where(eq(schema.recurringSchedule.id, row.id));

    if (created.length > 0) {
      await audit(tx, ctx, "recurring_schedule.materialised", "recurring_schedule", row.id, null, {
        created: created.length, through,
      });
    }

    return { scheduleId: row.id, created, alreadyThere, nextDueOn };
  });
}

/**
 * The visit actually happened.
 *
 * The load bearing call for `anchored_to_completion`, and the reason that
 * model exists: `lastOccurredOn` is when the technician was REALLY there,
 * and the next date is counted from it. A rain day moves the whole series
 * along rather than losing a visit out of the quarter.
 *
 * Harmless on the other models, which ignore it and keep their calendar.
 * Recorded on all of them anyway, because "when were we last at this
 * property" is a question somebody asks regardless of how the cadence works.
 */
export async function recordCompletion(
  ctx: ServiceContext,
  input: { id: string; completedOn: string },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const row = await load(tx, ctx.actor.organizationId, input.id);

    if (row.lastOccurredOn && input.completedOn < row.lastOccurredOn) {
      /**
       * Refused rather than accepted, because the series counts forward from
       * this date. A backdated completion would pull every future occurrence
       * backwards, and on a weekly route that silently reschedules the next
       * two months.
       */
      throw new ConflictError(
        `This schedule was last completed on ${row.lastOccurredOn}. Recording ${input.completedOn} `
        + "would move every future visit backwards.",
      );
    }

    const updated = { ...row, lastOccurredOn: input.completedOn };
    const nextDueOn = rc.nextOccurrence(toSpec(updated), input.completedOn);

    await tx.update(schema.recurringSchedule).set({
      lastOccurredOn: input.completedOn,
      nextDueOn,
      updatedAt: new Date(),
    }).where(eq(schema.recurringSchedule.id, row.id));

    return { id: row.id, lastOccurredOn: input.completedOn, nextDueOn };
  });
}

/**
 * The customer declined this one, or it moves.
 *
 * Kept as an exception rather than deleted, and that is the point. A customer
 * who said no has told us something, and losing it means re-offering work
 * they already refused. A moved occurrence keeps its place in the sequence,
 * so "visit two of four" stays true on the invoice.
 */
export async function except(
  ctx: ServiceContext,
  input: { id: string; date: string; action: "skipped" | "moved" | "cancelled"; movedTo?: string; reason?: string },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const row = await load(tx, ctx.actor.organizationId, input.id);

    if (input.action === "moved" && !input.movedTo) {
      throw new ConflictError("A moved visit needs the date it moved to, otherwise it is a skip.");
    }

    const exceptions = [
      ...row.exceptions.filter((e) => e.date !== input.date),
      {
        date: input.date,
        action: input.action,
        ...(input.movedTo ? { movedTo: input.movedTo } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
    ];

    const updated = { ...row, exceptions };
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const nextDueOn = rc.nextOccurrence(toSpec(updated), time.dateIn(new Date(), zone));

    await tx.update(schema.recurringSchedule).set({
      exceptions, nextDueOn, updatedAt: new Date(),
    }).where(eq(schema.recurringSchedule.id, row.id));

    await audit(tx, ctx, "recurring_schedule.exception", "recurring_schedule", row.id, null, {
      date: input.date, action: input.action, reason: input.reason ?? null,
    });

    return { id: row.id, exceptions: exceptions.length, nextDueOn };
  });
}

/** Stop or restart a series without losing its history. */
export async function setActive(ctx: ServiceContext, input: { id: string; active: boolean }) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const row = await load(tx, ctx.actor.organizationId, input.id);
    await tx.update(schema.recurringSchedule)
      .set({ active: input.active, updatedAt: new Date() })
      .where(eq(schema.recurringSchedule.id, row.id));

    await audit(tx, ctx, input.active ? "recurring_schedule.resumed" : "recurring_schedule.paused",
      "recurring_schedule", row.id, null, {});
    return { id: row.id, active: input.active };
  });
}

/**
 * Every schedule with work due, for the worker that creates it.
 *
 * Reads `next_due_on`, which is maintained on every write. The list is a
 * shortlist rather than the decision: `materialise` recomputes from the spec,
 * so a stale `next_due_on` delays a job by one pass and never creates a
 * wrong one.
 */
export async function dueNow(ctx: ServiceContext, on?: string) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = on ?? time.dateIn(new Date(), zone);

    const rows = await tx.select({ id: schema.recurringSchedule.id, nextDueOn: schema.recurringSchedule.nextDueOn })
      .from(schema.recurringSchedule)
      .where(and(
        eq(schema.recurringSchedule.organizationId, ctx.actor.organizationId),
        eq(schema.recurringSchedule.active, true),
        isNull(schema.recurringSchedule.deletedAt),
        lte(schema.recurringSchedule.nextDueOn, today),
      ))
      .orderBy(asc(schema.recurringSchedule.nextDueOn));

    return rows.map((row) => ({ id: row.id, nextDueOn: row.nextDueOn }));
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listRecurringSchedules: async (ctx: ServiceContext): Promise<{
    schedules: {
      id: string; label: string; customerId: string | null; customerName: string | null;
      propertyId: string | null; summary: string; model: string;
      intervalDays: number | null; anchorMonths: number[];
      startsOn: string; endsOn: string | null;
      lastOccurredOn: string | null; nextDueOn: string | null;
      active: boolean; exceptions: number;
    }[];
  }> => ({ schedules: await list(ctx) }),

  createRecurringSchedule: async (ctx: ServiceContext, input: {
    label: string; customerId: string; propertyId: string; summary: string;
    model: "rule" | "materialized" | "anchored_to_completion" | "manual";
    startsOn: string;
    endsOn?: string | null | undefined;
    intervalDays?: number | null | undefined;
    anchorMonths?: number[] | undefined;
    jobTypeId?: string | null | undefined;
    estimatedDurationMinutes?: number | null | undefined;
    horizonMonths?: number | undefined;
  }): Promise<{ id: string; label: string; nextDueOn: string | null }> => {
    const row = await create(ctx, input);
    return { id: row.id, label: row.label, nextDueOn: row.nextDueOn };
  },

  previewRecurringSchedule: (ctx: ServiceContext, input: {
    id: string; from?: string | undefined; to?: string | undefined;
  }): Promise<{
    scheduleId: string;
    occurrences: { date: string; moved: boolean; sequence: number }[];
    onlyOneKnowable: boolean;
  }> => preview(ctx, {
    id: input.id,
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
  }),

  materialiseRecurringSchedule: (ctx: ServiceContext, input: {
    id: string; through?: string | undefined;
  }) => materialise(ctx, {
    id: input.id,
    ...(input.through ? { through: input.through } : {}),
  }),

  recordRecurringCompletion: (ctx: ServiceContext, input: { id: string; completedOn: string }) =>
    recordCompletion(ctx, input),

  exceptRecurringOccurrence: (ctx: ServiceContext, input: {
    id: string; date: string;
    action: "skipped" | "moved" | "cancelled";
    movedTo?: string | undefined; reason?: string | undefined;
  }) => except(ctx, {
    id: input.id, date: input.date, action: input.action,
    ...(input.movedTo ? { movedTo: input.movedTo } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  }),

  setRecurringScheduleActive: (ctx: ServiceContext, input: { id: string; active: boolean }) =>
    setActive(ctx, input),

  listRecurringDue: async (ctx: ServiceContext, input: { on?: string | undefined }): Promise<{
    schedules: { id: string; nextDueOn: string | null }[];
  }> => ({ schedules: await dueNow(ctx, input.on) }),
} as const;
