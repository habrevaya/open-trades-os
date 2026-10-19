import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, max, notInArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { geo, holidays as holidayRules, recurrence as rc, routing, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, timezoneOf,
  type ServiceContext,
} from "./context";
import { nextNumber } from "./jobs";
import { crews as crewsInView, dispatchPeople, routes as routesInView, routeWithin } from "./people-scope";
import { shopOfCrew, shopOfPeople } from "./visit-shop";
import { connectedRouter, providerLabel, travelMatrix } from "./travel-times";
import { loadWeek } from "./business-hours";
import { loadHolidays } from "./holidays";

/**
 * ROUTES: THE THIRD CAPACITY MODEL
 *
 * Pool, pest, lawn maintenance, cleaning, gutters and snow do not sell
 * appointments. They sell a stop on a route, and their unit economics are
 * density: how many stops fit between the first and the last without running
 * into overtime. `route` and `route_stop` were in the first migration and
 * nothing had ever written either, so a company whose whole business is a
 * Tuesday route had nowhere to put it and would have run the product as a
 * list of unrelated jobs, which is exactly the system they are leaving.
 *
 * THREE THINGS THIS FILE OWES THE MODEL
 *
 *   1. The route itself: a weekday, a servicer, an ordered list of stops.
 *   2. Materialisation: turning the template into real visits for a date,
 *      ONCE, no matter how many times the timer or the dispatcher asks.
 *   3. Density: the stop time plus the travel against the working day, so an
 *      operator adding a fifteenth stop is told it will run long rather than
 *      finding out on Friday afternoon at time and a half.
 *
 * IT SITS BESIDE DISPATCH RATHER THAN REPLACING IT. Materialising produces
 * ordinary `job` and `visit` rows with `route_id`, `route_stop_id` and
 * `route_order` set, so the dispatch board already draws them, the field app
 * already syncs them and `services/dispatch.ts` can still reassign one when
 * somebody calls in sick. Nothing about technician dispatch changes.
 *
 * ON IDEMPOTENCY, which is the hard part and is not invented here.
 * `services/recurring.ts` already solved the same problem: each created job
 * carries its schedule and its date as `source_system` and `source_id`, and
 * an occurrence that already has a job is skipped rather than duplicated.
 * This follows that precedent exactly, keyed on the STOP and the date rather
 * than the route and the date, because the unit a customer notices being
 * double booked is their own house. A second invention here would mean two
 * different answers in this codebase to "has this already been created", and
 * the day they disagree somebody gets two technicians.
 *
 * ON PERMISSIONS. A route stop is recurring work sold to a customer at a
 * price per stop, which is what `services/recurring.ts` is, so it uses the
 * same pair: `job:read` to look and `job:write` to change. There is no
 * `route:*` in the catalogue and inventing one is not an option.
 */

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

/**
 * The weekday of a calendar date, 0 for Sunday, matching `route.day_of_week`
 * and JS `getDay()`.
 *
 * Read in UTC from a bare `YYYY-MM-DD`, which is correct precisely BECAUSE no
 * timezone is involved: the date string is already a calendar date rather
 * than an instant, and parsing it in the company's zone would be converting a
 * thing that is not an instant into one. The second of October is a Friday
 * everywhere.
 */
function weekdayOf(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new ConflictError(`${date} is not a calendar date.`);
  return new Date(parsed).getUTCDay();
}

/* ----------------------------------------------------------------- routes */

export interface RouteInput {
  name: string;
  /** 0 is Sunday, matching JS getDay() and the column's own comment. */
  dayOfWeek: number;
  technicianId?: string | null | undefined;
  crewId?: string | null | undefined;
  territoryId?: string | null | undefined;
  targetStopCount?: number | null | undefined;
  /** When the servicer starts the route, local time, "HH:MM". */
  startsAt?: string | null | undefined;
  travelMinutesBetweenStops?: number | null | undefined;
  color?: string | null | undefined;
}

/**
 * Define a route.
 *
 * EXACTLY ONE SERVICER, and both halves of that are refusals worth having. A
 * route with neither a technician nor a crew materialises visits nobody is
 * responsible for, which looks on the board exactly like work that has not
 * been assigned yet and will sit there. A route with both has two, and every
 * question after that point, density, overtime, whose day this is, has two
 * answers.
 *
 * The weekday is required even though the column is nullable. A route is a
 * weekday: "the Tuesday route" is how the business talks about it, and a row
 * without one cannot be materialised, cannot be checked for density against a
 * working day, and cannot be refused when somebody asks for it on a Thursday.
 */
export async function create(ctx: ServiceContext, input: RouteInput) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const name = input.name.trim();
    if (name === "") throw new ConflictError("A route needs a name.");

    if (!Number.isInteger(input.dayOfWeek) || input.dayOfWeek < 0 || input.dayOfWeek > 6) {
      throw new ConflictError("A weekday is 0 for Sunday through 6 for Saturday.");
    }

    const technicianId = input.technicianId ?? null;
    const crewId = input.crewId ?? null;
    if (technicianId && crewId) {
      throw new ConflictError(
        "A route is served by a technician or by a crew, not both. With two servicers "
        + "every question about the day has two answers.",
      );
    }
    if (!technicianId && !crewId) {
      throw new ConflictError(
        "A route needs somebody to serve it. Visits from a route with no servicer land on "
        + "the board looking exactly like work nobody has got to yet.",
      );
    }

    if (technicianId) {
      /**
       * Somebody this person dispatches: a route for another branch's
       * technician or crew is one they could not see afterwards, and is
       * refused exactly as an id that is not there, so the answer does not
       * say whether it is.
       */
      const [found] = await tx.select({ id: schema.technician.id }).from(schema.technician)
        .where(and(
          eq(schema.technician.id, technicianId),
          eq(schema.technician.organizationId, ctx.actor.organizationId),
          eq(schema.technician.active, true),
          dispatchPeople(ctx),
        )).limit(1);
      if (!found) throw new ConflictError("That technician is not active in this company.");
    }
    if (crewId) {
      const [found] = await tx.select({ id: schema.crew.id }).from(schema.crew)
        .where(and(
          eq(schema.crew.id, crewId),
          eq(schema.crew.organizationId, ctx.actor.organizationId),
          eq(schema.crew.active, true),
          crewsInView(ctx),
        )).limit(1);
      if (!found) throw new ConflictError("That crew is not active in this company.");
    }

    if (input.travelMinutesBetweenStops !== null && input.travelMinutesBetweenStops !== undefined
        && input.travelMinutesBetweenStops < 0) {
      throw new ConflictError("Travel between stops cannot be negative.");
    }

    const [row] = await tx.insert(schema.route).values({
      organizationId: ctx.actor.organizationId,
      name,
      dayOfWeek: input.dayOfWeek,
      technicianId,
      crewId,
      territoryId: input.territoryId ?? null,
      targetStopCount: input.targetStopCount ?? null,
      startsAt: input.startsAt ?? null,
      travelMinutesBetweenStops: input.travelMinutesBetweenStops ?? null,
      color: input.color ?? null,
    }).returning();

    await audit(tx, ctx, "route.created", "route", row!.id, null, row!);
    return row!;
  });
}

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "job:read", async (tx) => {
    /** Whoever runs a route decides whose it is: a branch manager's are their people's and crews'. */
    const routes = await tx.select().from(schema.route)
      .where(and(
        eq(schema.route.organizationId, ctx.actor.organizationId),
        routesInView(ctx),
      ))
      .orderBy(asc(schema.route.dayOfWeek), asc(schema.route.name));

    const counts = await tx.select({
      routeId: schema.routeStop.routeId,
      stops: sql<number>`count(*)::int`,
    }).from(schema.routeStop)
      .where(and(
        eq(schema.routeStop.organizationId, ctx.actor.organizationId),
        eq(schema.routeStop.active, true),
      ))
      .groupBy(schema.routeStop.routeId);

    const byRoute = new Map(counts.map((c) => [c.routeId, Number(c.stops)]));

    return routes.map((route) => ({
      id: route.id,
      name: route.name,
      dayOfWeek: route.dayOfWeek,
      dayName: route.dayOfWeek === null ? null : DAY_NAMES[route.dayOfWeek] ?? null,
      technicianId: route.technicianId,
      crewId: route.crewId,
      territoryId: route.territoryId,
      targetStopCount: route.targetStopCount,
      startsAt: route.startsAt,
      travelMinutesBetweenStops: route.travelMinutesBetweenStops,
      stopCount: byRoute.get(route.id) ?? 0,
      active: route.active,
    }));
  });
}

/** The stops, in the order they are driven. */
export async function stops(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const route = await routeWithin(tx, ctx, input.id);
    return listStops(tx, route.id);
  });
}

/* ------------------------------------------------------------------ stops */

export interface StopInput {
  routeId: string;
  propertyId: string;
  estimatedMinutes?: number | undefined;
  /** Days between visits, counted from the last one ACTUALLY serviced. */
  intervalDays?: number | null | undefined;
  pricePerStop?: string | null | undefined;
  /** The first date this stop is due. Null means due whenever the route runs. */
  firstDueOn?: string | null | undefined;
}

/**
 * Add a stop to the end of a route.
 *
 * ONE STOP PER PROPERTY PER ROUTE. The same house twice on one route is two
 * visits on one day to one address, which is a double booking written into
 * the template: every materialisation forever produces the pair, and the
 * customer sees two vans or, worse, gets billed twice at a price per stop.
 *
 * The sequence is allocated here rather than accepted from the caller, so
 * there is no way to create two stops numbered four. `reorder` is how the
 * order changes, and it renumbers the whole route in one statement for the
 * reason the dispatch board gives about a half renumbered day.
 */
export async function addStop(ctx: ServiceContext, input: StopInput) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const route = await routeWithin(tx, ctx, input.routeId);

    const [property] = await tx.select({ id: schema.property.id }).from(schema.property)
      .where(and(
        eq(schema.property.id, input.propertyId),
        eq(schema.property.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!property) throw new NotFoundError("Property");

    const [already] = await tx.select({ id: schema.routeStop.id }).from(schema.routeStop)
      .where(and(
        eq(schema.routeStop.routeId, route.id),
        eq(schema.routeStop.propertyId, input.propertyId),
      )).limit(1);
    if (already) {
      throw new ConflictError(
        "That property is already a stop on this route. Two stops at one address means two "
        + "visits on the same day, every week, and two charges at a price per stop.",
      );
    }

    const minutes = input.estimatedMinutes ?? 20;
    if (minutes <= 0) {
      throw new ConflictError("A stop takes some time. Zero minutes makes every density figure a lie.");
    }
    if (input.intervalDays !== null && input.intervalDays !== undefined && input.intervalDays < 1) {
      throw new ConflictError("Days between visits is at least one.");
    }

    const [{ highest } = { highest: null }] = await tx
      .select({ highest: max(schema.routeStop.sequence) })
      .from(schema.routeStop)
      .where(and(
        eq(schema.routeStop.routeId, route.id),
      ));

    const [row] = await tx.insert(schema.routeStop).values({
      organizationId: ctx.actor.organizationId,
      routeId: route.id,
      propertyId: input.propertyId,
      sequence: (highest ?? 0) + 1,
      estimatedMinutes: minutes,
      intervalDays: input.intervalDays ?? null,
      pricePerStop: input.pricePerStop ?? null,
      /**
       * Written here so the column means something from the moment the stop
       * exists. `next_due_on` left null until the first completion is a
       * column every "what is due" query reads as "never", which is how a new
       * customer waits a cycle for their first visit.
       */
      nextDueOn: input.firstDueOn ?? null,
    }).returning();

    await audit(tx, ctx, "route_stop.added", "route_stop", row!.id, null, row!);
    return row!;
  });
}

/**
 * The order of the route, set in one call.
 *
 * THE WHOLE LIST, and every active stop has to be in it. The same argument
 * `services/dispatch.ts` makes for reordering a technician's day, with one
 * more refusal on top: a partial list would renumber the stops it names and
 * leave the rest where they were, which produces two stops numbered four and
 * a driver going back across the territory for one of them.
 */
export async function reorder(
  ctx: ServiceContext, input: { id: string; stopIds: string[] },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const route = await routeWithin(tx, ctx, input.id);
    const current = await listStops(tx, route.id);
    const active = current.filter((s) => s.active);

    const seen = new Set<string>();
    for (const id of input.stopIds) {
      if (seen.has(id)) {
        throw new ConflictError("That order names the same stop twice.");
      }
      seen.add(id);
    }

    const theirs = new Set(active.map((s) => s.id));
    const foreign = input.stopIds.filter((id) => !theirs.has(id));
    if (foreign.length > 0) {
      throw new ConflictError(
        `${foreign.length} of those stops are not active stops on this route.`,
      );
    }

    const missing = active.filter((s) => !seen.has(s.id));
    if (missing.length > 0) {
      throw new ConflictError(
        `That order leaves out ${missing.length} of this route's stops. Send the whole route: `
        + "renumbering part of it leaves two stops sharing a number.",
      );
    }

    for (const [index, stopId] of input.stopIds.entries()) {
      await tx.update(schema.routeStop)
        .set({ sequence: index + 1, updatedAt: new Date() })
        .where(eq(schema.routeStop.id, stopId));
    }

    await audit(tx, ctx, "route.reordered", "route", route.id, null, { stops: input.stopIds.length });
    return { id: route.id, ordered: input.stopIds.length };
  });
}

/** Take a stop off the route, or put it back, without losing its history. */
export async function setStopActive(
  ctx: ServiceContext, input: { id: string; active: boolean },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const stop = await stopWithin(tx, ctx, input.id);

    await tx.update(schema.routeStop)
      .set({ active: input.active, updatedAt: new Date() })
      .where(eq(schema.routeStop.id, stop.id));

    await audit(tx, ctx, input.active ? "route_stop.resumed" : "route_stop.paused",
      "route_stop", stop.id, { active: stop.active }, { active: input.active });

    return { id: stop.id, active: input.active };
  });
}

/**
 * The technician was really there.
 *
 * The load bearing call for the cadence the schema comment on
 * `route_stop.interval_days` insists on: recurrence anchored to COMPLETION,
 * not to the calendar. A pool stop is every seven days from when it was
 * actually serviced, and a rain day moves the whole series along instead of
 * losing a visit out of the month. `services/recurring.ts` takes the same
 * position for the same reason, and this refuses a backdated completion for
 * the same reason it does: the series counts forward from this date, so
 * moving it back silently reschedules everything after it.
 */
export async function recordServiced(
  ctx: ServiceContext, input: { id: string; servicedOn: string },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const stop = await stopWithin(tx, ctx, input.id);

    if (stop.lastServicedOn && input.servicedOn < stop.lastServicedOn) {
      throw new ConflictError(
        `This stop was last serviced on ${stop.lastServicedOn}. Recording ${input.servicedOn} `
        + "would pull every future visit backwards.",
      );
    }

    const nextDueOn = stop.intervalDays
      ? rc.addDays(input.servicedOn, stop.intervalDays)
      : null;

    await tx.update(schema.routeStop).set({
      lastServicedOn: input.servicedOn,
      nextDueOn,
      updatedAt: new Date(),
    }).where(eq(schema.routeStop.id, stop.id));

    return { id: stop.id, lastServicedOn: input.servicedOn, nextDueOn };
  });
}

/* ---------------------------------------------------------- materialising */

export interface MaterialiseResult {
  routeId: string;
  date: string;
  created: { stopId: string; jobId: string; visitId: string; propertyId: string; sequence: number }[];
  /** Stops that already had a visit for this date. Not an error: a timer runs this. */
  alreadyThere: number;
  /** Stops whose own cadence does not fall on this date, with when they are next due. */
  notDue: { stopId: string; dueOn: string }[];
}

/**
 * Turn the route into a day's work.
 *
 * IDEMPOTENT BY CONSTRUCTION, and the construction is `recurring.ts`'s, not a
 * new one. Each job carries `source_system = "route_stop"` and
 * `source_id = "<stopId>:<date>"`, and a stop that already has a job for that
 * date is counted rather than created again. Running this twice in a minute,
 * which is exactly what a retried timer does, must not put two technicians on
 * one pool, and the customer is the person who finds out if it does.
 *
 * THE PAIR IS THE IDENTITY, stop and date. Keying on the route and the date
 * would make the second stop look like a duplicate of the first; keying on
 * the stop alone would make next week look like a duplicate of this week.
 *
 * REFUSED ON THE WRONG WEEKDAY. A route is a weekday, and materialising the
 * Tuesday route onto a Thursday is somebody mistyping a date. Creating the
 * work anyway puts forty stops on a day the servicer is already committed
 * elsewhere, and the only way back is deleting forty jobs by hand.
 */
export async function materialise(
  ctx: ServiceContext, input: { id: string; date: string },
): Promise<MaterialiseResult> {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const route = await routeWithin(tx, ctx, input.id);
    if (!route.active) {
      throw new ConflictError("That route is paused, so nothing should be created from it.");
    }

    const weekday = weekdayOf(input.date);
    if (route.dayOfWeek !== null && route.dayOfWeek !== weekday) {
      throw new ConflictError(
        `${route.name} runs on ${DAY_NAMES[route.dayOfWeek] ?? "an unset weekday"} and `
        + `${input.date} is a ${DAY_NAMES[weekday]}.`,
      );
    }

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const { start: dayStart, end: dayEnd } = time.dayBoundsIn(input.date, zone);

    const all = await listStops(tx, route.id);
    const active = all.filter((s) => s.active);

    /**
     * Every job this route has ever produced, read once. The alternative is a
     * query per stop, and a forty stop route run by a timer every morning is
     * forty round trips to answer a question one answers.
     */
    const existing = await tx.select({ ref: schema.job.sourceId })
      .from(schema.job)
      .where(and(
        eq(schema.job.organizationId, ctx.actor.organizationId),
        eq(schema.job.sourceSystem, "route_stop"),
      ));
    const seen = new Set(existing.map((e) => e.ref).filter((r): r is string => r !== null));

    const created: MaterialiseResult["created"] = [];
    const notDue: { stopId: string; dueOn: string }[] = [];
    let alreadyThere = 0;
    const shop = route.crewId ? await shopOfCrew(tx, route.crewId)
      : route.technicianId ? await shopOfPeople(tx, [route.technicianId]) : null;

    for (const stop of active) {
      const ref = `${stop.id}:${input.date}`;
      if (seen.has(ref)) { alreadyThere += 1; continue; }

      /**
       * The stop's own cadence, anchored to completion.
       *
       * A route runs every Tuesday and a stop on it may be fortnightly. The
       * next date is counted from when the technician was ACTUALLY there,
       * which is what `last_serviced_on` holds, because a calendar rule
       * silently skips the rain week and the customer is short a visit by the
       * quarter. A stop with no interval is due whenever the route runs,
       * which is the weekly case and the common one.
       */
      if (stop.intervalDays && stop.lastServicedOn) {
        const dueOn = rc.addDays(stop.lastServicedOn, stop.intervalDays);
        if (input.date < dueOn) { notDue.push({ stopId: stop.id, dueOn }); continue; }
      }

      const [property] = await tx.select({
        customerId: schema.customerProperty.customerId,
      }).from(schema.customerProperty)
        .where(and(
          eq(schema.customerProperty.propertyId, stop.propertyId),
          /**
           * A link that has ended is a previous owner. Billing a route stop
           * to the person who sold the house is the kind of invoice that
           * takes a phone call and a credit note to undo.
           */
          isNull(schema.customerProperty.endedOn),
        ))
        .orderBy(desc(schema.customerProperty.isPrimary))
        .limit(1);

      if (!property) {
        /**
         * Refused rather than skipped, and loudly. A stop whose property has
         * no customer cannot be billed for, and a route that quietly produced
         * thirty nine of forty visits every week would be short one invoice
         * forever with nothing on any screen saying which one.
         */
        throw new ConflictError(
          `Stop ${stop.sequence} on ${route.name} is at a property with no customer on it, `
          + "so the work could never be invoiced. Attach the property to a customer first.",
        );
      }

      const number = await nextNumber(tx, ctx.actor.organizationId, "job");
      const [job] = await tx.insert(schema.job).values({
        organizationId: ctx.actor.organizationId,
        number,
        customerId: property.customerId,
        propertyId: stop.propertyId,
        territoryId: route.territoryId,
        status: "scheduled",
        summary: `${route.name}, stop ${stop.sequence}`,
        sourceSystem: "route_stop",
        sourceId: ref,
      }).returning({ id: schema.job.id });

      const [visit] = await tx.insert(schema.visit).values({
        organizationId: ctx.actor.organizationId,
        jobId: job!.id,
        sequence: 1,
        /**
         * Scheduled rather than unassigned. A route HAS a servicer, which is
         * why `create` refuses one without, and a board showing forty route
         * visits in the unassigned pile every Tuesday morning is a board
         * nobody can use.
         */
        status: "scheduled",
        /**
         * The whole working day in the company's zone, the same choice
         * `services/recurring.ts` makes. A route stop has a date and a place
         * in a sequence, not a promised arrival time, and inventing 09:00
         * publishes a window nobody offered the customer.
         */
        windowStart: dayStart,
        windowEnd: dayEnd,
        estimatedDurationMinutes: stop.estimatedMinutes,
        routeId: route.id,
        routeStopId: stop.id,
        /** The sequence IS the route order. That is what the board draws. */
        routeOrder: stop.sequence,
        crewId: route.crewId,
        /** The shop of whoever runs the route (`visit-shop.ts`). */
        locationId: shop,
      }).returning({ id: schema.visit.id });

      /**
       * A technician route assigns through `visit_assignment`, which is the
       * same table `services/dispatch.ts` reads, so these visits appear in
       * the right column of the existing board and can be reassigned by the
       * existing endpoint when somebody calls in sick. A crew route sets
       * `visit.crew_id` instead and writes no assignment, which is the rule
       * the schema states: exactly one of the two is set.
       */
      if (route.technicianId) {
        await tx.insert(schema.visitAssignment).values({
          organizationId: ctx.actor.organizationId,
          visitId: visit!.id,
          technicianId: route.technicianId,
          isLead: true,
        });
      }

      created.push({
        stopId: stop.id, jobId: job!.id, visitId: visit!.id,
        propertyId: stop.propertyId, sequence: stop.sequence,
      });
      seen.add(ref);
    }

    if (created.length > 0) {
      await audit(tx, ctx, "route.materialised", "route", route.id, null, {
        date: input.date, created: created.length, alreadyThere, notDue: notDue.length,
      });
    }

    return { routeId: route.id, date: input.date, created, alreadyThere, notDue };
  });
}

/* ---------------------------------------------------------------- density */

/** `closed` when the date asked about is one the route's branch (or the company) is shut. */
export type DayBasis = "overtime_policy" | "business_hours" | "closed" | "unknown";

/** Where the drive time in a density figure came from. */
export type TravelSource = "declared" | "road" | "none";

export interface Density {
  routeId: string;
  routeName: string;
  dayOfWeek: number | null;
  stopCount: number;
  targetStopCount: number | null;
  overTarget: boolean | null;
  serviceMinutes: number;
  /** Null when there is no drive time to give: none declared and no road network to ask. Null is not zero. */
  travelMinutes: number | null;
  /** Service plus travel. A FLOOR when some of the drive is unknown, see `travelComplete`. */
  totalMinutes: number;
  /** Kept for callers that read it: true only when the route's own declared drive time was used. */
  travelDeclared: boolean;
  /**
   * `declared` from the route's own drive time between stops, `road` from
   * the company's routing service, `none` when there is neither.
   */
  travelSource: TravelSource;
  /** Whether every leg of the drive is in the figure. When false the total is a floor. */
  travelComplete: boolean;
  /** The drive in a sentence, saying where it came from and what it leaves out. */
  travelNote: string;
  /** The minute at which this day starts costing overtime, and where that came from. */
  overtimeAfterMinutes: number | null;
  dayBasis: DayBasis;
  /** The date asked about, or null for the weekday's template. */
  on: string | null;
  /** The holiday on that date, by name, when the list says something about it. */
  holiday: string | null;
  /** Why nothing fits that date, in a sentence, when the route's branch is shut then. Null otherwise. */
  closedOn: string | null;
  /** How many minutes the route's branch is open that date or weekday, or null when nothing says. */
  openMinutes: number | null;
  /** Stops left out because their own cadence does not fall on the date asked about. Zero for the template. */
  notDueCount: number;
  /**
   * On a date, the visits already on the servicer's day (made from the route,
   * moved onto it on the board, or other work of theirs), counted as they
   * are now. Zero for the template.
   */
  madeVisits: number;
  /** On a date, the servicer's own day: their hours, their leave and what is left. Null for the template. */
  servicer: ServicerDay | null;
  /**
   * On a date, whether the day's work fits the hours the servicer has left:
   * false when refused (see `refusedBecause`), true when it fits with the
   * whole drive counted, null when it cannot be said. Null for the template.
   */
  fits: boolean | null;
  /** Why the date is refused, in a sentence: closed, the servicer off, or more work than hours. */
  refusedBecause: string | null;
  minutesOverThreshold: number | null;
  /**
   * TRUE, FALSE OR NULL, and null is a real answer rather than a missing one.
   * Null means the question cannot be answered from what the company has
   * declared, which is a different thing from a day that fits.
   */
  runsIntoOvertime: boolean | null;
  explanation: string;
}

export interface ServicerDay {
  name: string;
  kind: "technician" | "crew";
  /** `own` for a person's own working hours, `company` for the hours kept that date, null when neither says. */
  hoursFrom: "own" | "company" | null;
  startsAt: string | null;
  endsAt: string | null;
  /** Minutes of approved leave inside those hours (for a crew, when every member is off). */
  leaveMinutes: number;
  /** The hours less the leave. Null when no hours are known. */
  availableMinutes: number | null;
  offAllDay: boolean;
  /** A crew's members with leave that day, by name. */
  membersOff: string[];
}

/** "08:00" from minutes after midnight. */
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/** "8:00 AM" from minutes after midnight. */
const clockWords = (minutes: number) => {
  const h = Math.floor(minutes / 60) % 24;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(minutes % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
/** "HH:MM" as minutes after midnight, or null. */
const minuteOf = (value: string | null | undefined) => {
  const found = /^(\d{1,2}):(\d{2})/.exec(value ?? "");
  return found ? Number(found[1]) * 60 + Number(found[2]) : null;
};

/** A visit in one of these does not take any of the day. */
const NOT_ON_THE_DAY = ["cancelled", "no_show", "completed_after_cancellation"] as const;

/**
 * THE REAL DAY BEHIND A DATE: the visits already on the servicer's day, the
 * route's stops due that date and not yet made, and the servicer's own hours
 * and leave. Read inside the density's own transaction.
 *
 * A stop already made for the date is counted as the visit it became, where
 * that visit now is: still on the servicer's day, it is counted with its own
 * length; moved to somebody else or called off, it is not. Anything else the
 * servicer has that day (a service call, a stop added on the board) is
 * counted too, because it takes the same hours.
 */
async function realDay(
  tx: Database, organizationId: string, route: typeof schema.route.$inferSelect, on: string,
  due: Awaited<ReturnType<typeof listStops>>, kept: { openMinute: number; closeMinute: number } | null,
) {
  const zone = await timezoneOf(tx, organizationId);
  const { start: dayStart, end: dayEnd } = time.dayBoundsIn(on, zone);
  const refs = due.map((s) => `${s.id}:${on}`);
  const made = refs.length === 0 ? [] : await tx.select({ ref: schema.job.sourceId }).from(schema.job)
    .where(and(
      eq(schema.job.organizationId, organizationId), eq(schema.job.sourceSystem, "route_stop"), inArray(schema.job.sourceId, refs),
    ));
  const madeStops = new Set(made.map((m) => m.ref?.split(":")[0]));
  const unmade = due.filter((s) => !madeStops.has(s.id));

  const columns = {
    id: schema.visit.id, minutes: schema.visit.estimatedDurationMinutes, routeOrder: schema.visit.routeOrder,
    windowStart: schema.visit.windowStart, latitude: schema.property.latitude, longitude: schema.property.longitude,
  };
  const onTheDay = and(
    eq(schema.visit.organizationId, organizationId),
    gte(schema.visit.windowStart, dayStart), lt(schema.visit.windowStart, dayEnd),
    notInArray(schema.visit.status, [...NOT_ON_THE_DAY]),
  );
  const visits = route.technicianId
    ? await tx.select(columns).from(schema.visitAssignment)
      .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
      .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
      .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
      .where(and(onTheDay, eq(schema.visitAssignment.technicianId, route.technicianId)))
    : route.crewId
      ? await tx.select(columns).from(schema.visit)
        .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
        .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
        .where(and(onTheDay, eq(schema.visit.crewId, route.crewId)))
      /** Nobody runs it: the visits made from it that day, wherever they went. */
      : await tx.select(columns).from(schema.visit)
        .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
        .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
        .where(and(onTheDay, eq(schema.visit.routeId, route.id)));
  visits.sort((a, b) => (a.routeOrder ?? 1e9) - (b.routeOrder ?? 1e9)
    || (a.windowStart?.getTime() ?? 0) - (b.windowStart?.getTime() ?? 0) || a.id.localeCompare(b.id));

  /** Leave as minutes after the day's local midnight, clipped to the day. */
  const asSpan = (row: { startsAt: Date; endsAt: Date }) => ({
    start: Math.max(0, Math.round((row.startsAt.getTime() - dayStart.getTime()) / 60_000)),
    end: Math.min(1440, Math.round((row.endsAt.getTime() - dayStart.getTime()) / 60_000)),
  });
  const leaveOf = async (technicianIds: string[]) => technicianIds.length === 0 ? [] : tx.select({
    technicianId: schema.timeOff.technicianId, startsAt: schema.timeOff.startsAt, endsAt: schema.timeOff.endsAt,
  }).from(schema.timeOff)
    .where(and(
      eq(schema.timeOff.organizationId, organizationId), eq(schema.timeOff.approved, true), isNull(schema.timeOff.deletedAt),
      inArray(schema.timeOff.technicianId, technicianIds), lt(schema.timeOff.startsAt, dayEnd), gt(schema.timeOff.endsAt, dayStart),
    ));

  let servicer: (Omit<ServicerDay, "leaveMinutes" | "availableMinutes" | "offAllDay"> & { window: routing.Span | null; leave: routing.Span[] }) | null;
  const company = kept ? { start: kept.openMinute, end: kept.closeMinute } : null;
  if (!route.technicianId && !route.crewId) {
    /** A route nobody runs yet has nobody's day to fit. */
    servicer = null;
  } else if (route.technicianId) {
    const [person] = await tx.select({ name: schema.technician.displayName, workday: schema.technician.workday })
      .from(schema.technician).where(eq(schema.technician.id, route.technicianId)).limit(1);
    const own = person?.workday ? { start: minuteOf(person.workday.startsAt), end: minuteOf(person.workday.endsAt) } : null;
    const window = own && own.start !== null && own.end !== null && own.end > own.start ? { start: own.start, end: own.end } : company;
    servicer = {
      name: person?.name ?? "The technician", kind: "technician",
      hoursFrom: window === null ? null : window === company ? "company" : "own",
      startsAt: window ? hhmm(window.start) : null, endsAt: window ? hhmm(window.end) : null,
      membersOff: [], window, leave: (await leaveOf([route.technicianId])).map(asSpan),
    };
  } else {
    const [crew] = route.crewId
      ? await tx.select({ name: schema.crew.name }).from(schema.crew).where(eq(schema.crew.id, route.crewId)).limit(1) : [];
    const members = route.crewId ? await tx.select({ id: schema.technician.id, name: schema.technician.displayName })
      .from(schema.crewMember).innerJoin(schema.technician, eq(schema.technician.id, schema.crewMember.technicianId))
      .where(eq(schema.crewMember.crewId, route.crewId)) : [];
    const away = await leaveOf(members.map((m) => m.id));
    /** A crew works the company's day; it is off only when every member is off for all of it. */
    const whole = company ?? { start: 0, end: 1440 };
    const allOff = members.length > 0 && members.every((m) =>
      routing.coveredMinutes(away.filter((a) => a.technicianId === m.id).map(asSpan), whole) >= whole.end - whole.start);
    servicer = {
      name: crew?.name ?? "The crew", kind: "crew", hoursFrom: company ? "company" : null,
      startsAt: company ? hhmm(company.start) : null, endsAt: company ? hhmm(company.end) : null,
      membersOff: members.filter((m) => away.some((a) => a.technicianId === m.id)).map((m) => m.name).sort(),
      window: company, leave: allOff ? [whole] : [],
    };
  }
  return { visits, unmade, servicer };
}

/** The sentence for a date the servicer cannot take, or the day's fit in a sentence. */
function realDayWords(d: {
  servicer: ServicerDay; fits: boolean | null; overBy: number | null; totalMinutes: number; travelComplete: boolean;
  on: string; madeVisits: number; unmade: number; leave: routing.Span[];
}): { refused: string | null; note: string } {
  const s = d.servicer;
  const counted = d.madeVisits > 0
    ? `Counted from the day as it is: ${d.madeVisits} ${d.madeVisits === 1 ? "visit" : "visits"} already on it and ${d.unmade} ${d.unmade === 1 ? "stop" : "stops"} still to make.`
    : "";
  const hours = s.startsAt && s.endsAt
    ? `${s.hoursFrom === "own" ? `${s.kind === "technician" ? "their own hours" : "its hours"}` : "the hours you keep that day"}, ${clockWords(minuteOf(s.startsAt)!)} to ${clockWords(minuteOf(s.endsAt)!)}`
    : null;
  const leaveText = d.leave.length > 0
    ? ` less leave ${d.leave.map((l) => `from ${l.start <= 0 ? "the start of the day" : clockWords(l.start)} to ${l.end >= 1440 ? "the end of the day" : clockWords(l.end)}`).join(" and ")}`
    : "";
  let refused: string | null = null;
  let fit = "";
  if (s.offAllDay) {
    refused = s.kind === "technician"
      ? `${s.name} is on leave all of ${d.on}, so nothing on this route fits that day.`
      : `Everybody on ${s.name} is on leave all of ${d.on}, so nothing on this route fits that day.`;
  } else if (d.fits === false && s.availableMinutes !== null) {
    refused = `${s.name} has ${s.availableMinutes} minutes that day (${hours}${leaveText}) and the day comes to ${d.travelComplete ? "" : "at least "}${d.totalMinutes}, ${d.overBy} minutes too many.`;
  } else if (d.fits === true && s.availableMinutes !== null) {
    fit = `It fits the ${s.availableMinutes} minutes ${s.name} has that day (${hours}${leaveText}).`;
  } else if (s.availableMinutes === null) {
    fit = `Nobody has said what hours ${s.name} works that day, so whether it fits ${s.kind === "technician" ? "them" : "it"} cannot be said.`;
  } else {
    fit = `The work alone fits the ${s.availableMinutes} minutes ${s.name} has that day, but without the whole drive nobody can say whether the day does.`;
  }
  const off = s.kind === "crew" && s.membersOff.length > 0 && !s.offAllDay
    ? ` ${s.membersOff.join(", ")} ${s.membersOff.length === 1 ? "is" : "are"} on leave that day, so the crew is short.`
    : "";
  return { refused, note: [counted, refused ?? fit].filter(Boolean).join(" ") + off };
}

/**
 * Will this day fit.
 *
 * DENSITY IS THE WHOLE ECONOMICS OF A ROUTE BUSINESS. The revenue of a pool
 * route is stops per day times price per stop, and the cost is the driver's
 * day. An operator adding a fifteenth stop is making the only decision that
 * matters in their business, and today they make it by feel and discover the
 * answer on Friday at time and a half.
 *
 * THE DRIVE, in this order:
 *
 *   The route's own declared drive time between stops, when the operator
 *   gave one: the person who drives the route knows the river has one
 *   bridge, and the optimiser lets the same figure beat the road network.
 *
 *   Otherwise the company's routing service (OSRM, Mapbox or
 *   OpenRouteService, `services/travel-times.ts`) when one is connected:
 *   by road between each stop and the next in the route's order, and out
 *   from where the servicer's day starts and back when that is on the map.
 *   Only legs the service answered for count as by road. A leg it could not
 *   answer, a stop not on the map, or the extra stop being asked about
 *   (which has no address yet) leaves the figure a FLOOR, said so, rather
 *   than filled in with a straight line guess.
 *
 *   Otherwise nothing, and the total is a floor, rather than quietly
 *   treating the drive as zero and telling somebody a fifteen stop day fits.
 *
 * It does not guess the working day. The threshold comes from the overtime
 * policy's daily figure, which is the actual minute overtime begins, or
 * failing that from the declared business hours for that weekday. With
 * neither, the answer is null and the explanation names what to set.
 * `services/labor.ts` refuses to run a timesheet without a policy for the
 * same reason: every default is a position on what somebody is owed.
 *
 * `addingStopOfMinutes` answers the question as it is actually asked: not
 * "how long is my route" but "what happens if I put this customer on it".
 *
 * ASKED FOR A DATE (`on`), it is that day rather than the weekday's
 * template: the stops whose own cadence falls on it (the rule `materialise`
 * keeps), and the hours the route's branch keeps that date, so a holiday or
 * a weekday the branch keeps closed changes the answer. A closed date has no
 * working day to fit into, and says so rather than measuring against the
 * overtime threshold of a day nobody is working. A short day with no
 * overtime policy is measured against its own hours; with a policy, the
 * policy still says when overtime starts, and the short day is said beside
 * it. A date on another weekday than the route's is refused, as making it
 * would be. The route's branch is whoever runs it: the crew's, or the
 * technician's (M02's weeks and holidays).
 *
 * The road network is asked outside any transaction, as every drive time
 * is, so a routing server taking its time holds no connection.
 */
export async function density(
  ctx: ServiceContext,
  input: { id: string; addingStopOfMinutes?: number | undefined; on?: string | undefined },
): Promise<Density> {
  const on = input.on ?? null;
  const loaded = await guardedRead(ctx, "job:read", async (tx) => {
    const route = await routeWithin(tx, ctx, input.id);
    if (on !== null && route.dayOfWeek !== null && route.dayOfWeek !== weekdayOf(on)) {
      throw new ConflictError(
        `${route.name} runs on ${DAY_NAMES[route.dayOfWeek] ?? "an unset weekday"} and ${on} is a ${DAY_NAMES[weekdayOf(on)]}.`,
      );
    }
    const listed = (await listStops(tx, route.id)).filter((s) => s.active);
    /** On a date, the stops whose own cadence falls on it, by the rule `materialise` keeps. */
    const due = on === null ? listed : listed.filter((s) =>
      !(s.intervalDays && s.lastServicedOn && on < rc.addDays(s.lastServicedOn, s.intervalDays)));
    const branchId = await branchOfRoute(tx, route);
    const day = await workingDay(tx, ctx.actor.organizationId, route.dayOfWeek, branchId, on);
    const start = await servicerStart(tx, ctx.actor.organizationId, route);
    /** On a date, the day as it is: what is already on it and whose day it is. */
    const real = on === null || day.basis === "closed" ? null : await realDay(tx, ctx.actor.organizationId, route, on, due, day.hours);
    return { route, active: due, notDueCount: listed.length - due.length, day, start, real };
  });
  const { route, real } = loaded;
  /**
   * The stops counted: on a date, the visits already on the servicer's day
   * and the stops due and not yet made; for the template, the stops.
   */
  const active: { id: string; estimatedMinutes: number; latitude: string | null; longitude: string | null }[] = real
    ? [
      ...real.visits.map((v) => ({ id: v.id, estimatedMinutes: v.minutes, latitude: v.latitude, longitude: v.longitude })),
      ...real.unmade,
    ]
    : loaded.active;

  const extra = input.addingStopOfMinutes ?? 0;
  if (extra < 0) throw new ConflictError("A stop cannot take negative time.");

  const stopCount = active.length + (extra > 0 ? 1 : 0);
  const serviceMinutes = active.reduce((sum, s) => sum + s.estimatedMinutes, 0) + extra;

  const perHop = route.travelMinutesBetweenStops;
  let travelSource: TravelSource = "none";
  let travelMinutes: number | null = null;
  let travelComplete = false;
  let travelNote = "This route has no declared drive time between stops and no road network to ask, so the drive is not in the figure.";

  if (perHop !== null) {
    // Between stops, so one fewer hop than there are stops, and never below
    // zero on a route with a single stop or none.
    travelSource = "declared";
    travelMinutes = perHop * Math.max(0, stopCount - 1);
    travelComplete = true;
    travelNote = `The route's own drive time, ${perHop} minutes between stops. The drive out to the first stop and home from the last is not counted.`;
  } else if (active.length > 0 && await connectedRouter(ctx)) {
    const road = await roadTravel(ctx, active, loaded.start?.place ?? null);
    if (road.minutes !== null) {
      travelSource = "road";
      travelMinutes = road.minutes;
      travelComplete = road.complete && extra === 0;
      travelNote = road.note + (extra > 0 ? " The extra stop has no address yet, so its drive is not counted." : "");
    } else {
      travelNote = road.note;
    }
  }
  const totalMinutes = serviceMinutes + (travelMinutes ?? 0);

  const { minutes: overtimeAfterMinutes, basis: dayBasis, closedOn, holiday, openMinutes } = loaded.day;

  /** The servicer's own day against the work, on a date that is not closed. */
  const verdict = real?.servicer ? routing.realDayFit({ window: real.servicer.window, leave: real.servicer.leave, totalMinutes, travelComplete }) : null;
  const servicer: ServicerDay | null = real?.servicer && verdict ? {
    name: real.servicer.name, kind: real.servicer.kind, hoursFrom: real.servicer.hoursFrom,
    startsAt: real.servicer.startsAt, endsAt: real.servicer.endsAt, membersOff: real.servicer.membersOff,
    leaveMinutes: verdict.leaveMinutes, availableMinutes: verdict.availableMinutes, offAllDay: verdict.offAllDay,
  } : null;
  const said = real && verdict && servicer && on ? realDayWords({
    servicer, fits: verdict.fits, overBy: verdict.overBy, totalMinutes, travelComplete, on,
    madeVisits: real.visits.length, unmade: real.unmade.length, leave: real.servicer!.leave,
  }) : null;
  const fits = closedOn ? false : verdict?.fits ?? null;
  const refusedBecause = closedOn ?? said?.refused ?? null;

  const minutesOverThreshold = overtimeAfterMinutes === null
    ? null
    : totalMinutes - overtimeAfterMinutes;

  /**
   * The honest three way answer. A floor that already exceeds the threshold
   * is a real yes, because adding the unknown travel can only make it
   * worse. A floor under the threshold is a genuine unknown, and reporting
   * it as a no would be the exact claim this file must not make.
   */
  const runsIntoOvertime = overtimeAfterMinutes === null
    ? null
    : totalMinutes > overtimeAfterMinutes
      ? true
      : travelComplete ? false : null;

  return {
    routeId: route.id,
    routeName: route.name,
    dayOfWeek: route.dayOfWeek,
    stopCount,
    targetStopCount: route.targetStopCount,
    overTarget: route.targetStopCount === null ? null : stopCount > route.targetStopCount,
    serviceMinutes,
    travelMinutes,
    totalMinutes,
    travelDeclared: travelSource === "declared",
    travelSource,
    travelComplete,
    travelNote,
    overtimeAfterMinutes,
    dayBasis,
    on,
    holiday,
    closedOn,
    openMinutes,
    notDueCount: loaded.notDueCount,
    madeVisits: real?.visits.length ?? 0,
    servicer,
    fits: on === null ? null : fits,
    refusedBecause,
    minutesOverThreshold,
    runsIntoOvertime,
    explanation: explain({
      stopCount, totalMinutes, travelComplete, travelSource,
      overtimeAfterMinutes, dayBasis, runsIntoOvertime, extra, on, holiday, closedOn, openMinutes,
    }) + (said?.note ? ` ${said.note}` : ""),
  };
}

/**
 * Where the servicer's day starts: the technician's own start, the crew's
 * base or its lead's, otherwise the company's first location, the same rule
 * the dispatch map uses. Null when none is on the map.
 */
async function servicerStart(
  tx: Database, organizationId: string, route: typeof schema.route.$inferSelect,
): Promise<{ name: string; place: geo.LatLng | null } | null> {
  let home: string | null = null;
  if (route.technicianId) {
    const [t] = await tx.select({ home: schema.technician.homeLocationId }).from(schema.technician)
      .where(eq(schema.technician.id, route.technicianId)).limit(1);
    home = t?.home ?? null;
  } else if (route.crewId) {
    const [c] = await tx.select({ home: schema.crew.homeLocationId }).from(schema.crew)
      .where(eq(schema.crew.id, route.crewId)).limit(1);
    home = c?.home ?? null;
    if (!home) {
      const [lead] = await tx.select({ home: schema.technician.homeLocationId }).from(schema.crewMember)
        .innerJoin(schema.technician, eq(schema.technician.id, schema.crewMember.technicianId))
        .where(and(eq(schema.crewMember.crewId, route.crewId), eq(schema.crewMember.isLead, true))).limit(1);
      home = lead?.home ?? null;
    }
  }
  const locations = await tx.select().from(schema.location)
    .where(and(eq(schema.location.organizationId, organizationId), eq(schema.location.active, true)))
    .orderBy(asc(schema.location.createdAt), asc(schema.location.id));
  const chosen = (home ? locations.find((l) => l.id === home) : undefined) ?? locations[0];
  if (!chosen) return null;
  return { name: chosen.name, place: geo.parseLatLng(chosen.latitude, chosen.longitude) };
}

/**
 * The drive by road through the route's stops in order, out from the start
 * and back when it is on the map, counting only legs the routing service
 * answered. Null minutes when no leg was by road at all.
 */
async function roadTravel(
  ctx: ServiceContext,
  stops: readonly { id: string; latitude: string | null; longitude: string | null }[],
  start: geo.LatLng | null,
): Promise<{ minutes: number | null; complete: boolean; note: string }> {
  const points = new Map<string, geo.LatLng | null>(stops.map((s) => [s.id, geo.parseLatLng(s.latitude, s.longitude)]));
  if (start) points.set("start", start);
  const matrix = await travelMatrix(ctx, points, { assumptions: geo.DEFAULT_DRIVE });
  const keys = [...(start ? ["start"] : []), ...stops.map((s) => s.id), ...(start ? ["start"] : [])];
  let minutes = 0;
  let known = 0;
  let unknown = 0;
  for (let i = 0; i + 1 < keys.length; i++) {
    const leg = matrix.road(keys[i]!, keys[i + 1]!);
    if (leg === null) unknown += 1;
    else { minutes += leg; known += 1; }
  }
  const offMap = stops.filter((s) => points.get(s.id) === null).length;
  if (known === 0 && unknown > 0) {
    return {
      minutes: null, complete: false,
      note: matrix.failure
        ? `The routing service did not answer (${matrix.failure.replace(/\.$/, "")}), so the drive is not in the figure.`
        : "No stop on this route is on the map, so the drive cannot be asked by road.",
    };
  }
  const parts = [`By road between the stops in their order${start ? ", and out from where the day starts and back" : ""}, from ${providerLabel(matrix.provider)}.`];
  if (!start) parts.push("Where the day starts is not on the map, so the drive out and home is not counted.");
  if (offMap > 0) parts.push(`${offMap} ${offMap === 1 ? "stop is" : "stops are"} not on the map, so ${offMap === 1 ? "its legs are" : "their legs are"} not counted.`);
  else if (unknown > 0) parts.push(`${unknown} ${unknown === 1 ? "leg" : "legs"} the routing service did not answer for ${unknown === 1 ? "is" : "are"} not counted.`);
  return { minutes, complete: unknown === 0, note: parts.join(" ") };
}

/** The sentence an operator reads. Every branch says what it rests on. */
function explain(d: {
  stopCount: number; totalMinutes: number; travelComplete: boolean; travelSource: TravelSource;
  overtimeAfterMinutes: number | null; dayBasis: DayBasis;
  runsIntoOvertime: boolean | null; extra: number;
  on: string | null; holiday: string | null; closedOn: string | null; openMinutes: number | null;
}): string {
  const when = d.on ? `On ${d.on}${d.holiday ? ` (${d.holiday})` : ""}, ` : "";
  const counted = d.extra > 0
    ? `with the extra stop, ${d.stopCount} stops come to ${d.totalMinutes} minutes`
    : `${d.stopCount} stops come to ${d.totalMinutes} minutes`;
  const head = when ? `${when}${counted}` : `${counted.charAt(0).toUpperCase()}${counted.slice(1)}`;
  if (d.closedOn) return `${d.closedOn} ${head.charAt(0).toUpperCase()}${head.slice(1)}, with no working day to fit into.`;
  /**
   * A short day said beside an overtime policy: the policy still says when
   * overtime starts, and the day's own hours are what the office keeps.
   */
  const short = d.on && d.holiday && d.openMinutes !== null && d.dayBasis === "overtime_policy"
    ? ` You keep ${d.openMinutes} minutes of hours that day${d.totalMinutes > d.openMinutes ? `, which this day runs ${d.totalMinutes - d.openMinutes} minutes past` : ""}.`
    : "";
  return explainAgainst(d, head) + short;
}

function explainAgainst(d: {
  stopCount: number; totalMinutes: number; travelComplete: boolean; travelSource: TravelSource;
  overtimeAfterMinutes: number | null; dayBasis: DayBasis;
  runsIntoOvertime: boolean | null; extra: number; on: string | null;
}, head: string): string {
  const floor = d.travelComplete
    ? ""
    : d.travelSource === "none"
      ? " and that is a floor, because this route has no declared drive time between stops and no road network to ask"
      : " and that is a floor, because some of the drive could not be counted";

  if (d.overtimeAfterMinutes === null) {
    return `${head}${floor}. Whether that runs into overtime cannot be said: this company has `
      + `set neither a daily overtime threshold nor business hours for ${d.on ? "that day" : "that weekday"}.`;
  }
  const source = d.dayBasis === "overtime_policy"
    ? "the overtime policy's daily threshold"
    : d.on ? "the hours you keep that day" : "the declared business hours for that weekday";
  if (d.runsIntoOvertime === true) {
    const over = d.totalMinutes - d.overtimeAfterMinutes;
    return `${head}${floor}, which is ${over} minutes past ${d.overtimeAfterMinutes}, `
      + `${source}. This day runs into overtime.`;
  }
  if (d.runsIntoOvertime === false) {
    const spare = d.overtimeAfterMinutes - d.totalMinutes;
    return `${head}, ${spare} minutes inside ${d.overtimeAfterMinutes}, ${source}.`;
  }
  return `${head}${floor}. The stop time alone fits inside ${d.overtimeAfterMinutes}, `
    + `${source}, but without ${d.travelSource === "none" ? "a drive time" : "the whole drive"} nobody can say whether the day does.`;
}

/**
 * How long the servicer's day is before it costs overtime.
 *
 * THE OVERTIME POLICY FIRST, because its daily threshold is literally the
 * minute at which overtime begins and is a declaration somebody made on
 * purpose. Business hours are the fallback and are a weaker claim: they say
 * when the office is open, which is usually the working day and is not the
 * same statement.
 *
 * Read directly rather than through `labor.policyFor`, which THROWS when no
 * policy is set. That refusal is right for a timesheet, where a guess
 * underpays somebody, and wrong here, where the honest answer is a density
 * figure with "nobody has said when overtime starts" attached.
 */
async function workingDay(
  tx: Database, organizationId: string, dayOfWeek: number | null, branchId: string | null, on: string | null,
): Promise<{
  minutes: number | null; basis: DayBasis; closedOn: string | null; holiday: string | null; openMinutes: number | null;
  /** The hours kept that date or weekday, in minutes after local midnight, when they are known. */
  hours: { openMinute: number; closeMinute: number } | null;
}> {
  /**
   * The hours the route's branch keeps on the date, or on the weekday: its
   * own week where it keeps one, the company's otherwise, and on a date its
   * holiday list over both (M02).
   */
  const { week } = await loadWeek(tx, organizationId, branchId);
  const kept = on !== null
    ? holidayRules.hoursOnDate(on, week, await loadHolidays(tx, organizationId, branchId))
    : dayOfWeek === null || week === null
      ? { holiday: null, hours: null, known: false }
      : { holiday: null, hours: week[dayOfWeek] ?? null, known: true };
  const openMinutes = kept.hours ? kept.hours.closeMinute - kept.hours.openMinute : null;
  const holiday = kept.holiday?.name ?? null;

  if (on !== null && kept.known && kept.hours === null) {
    return {
      minutes: null, basis: "closed", holiday, openMinutes: null, hours: null,
      closedOn: kept.holiday
        ? `You are closed on ${on} for ${kept.holiday.name}.`
        : `You are closed on ${DAY_NAMES[weekdayOf(on)]}s, so ${on} is not a working day.`,
    };
  }

  const [policy] = await tx.select({
    dailyThresholdMinutes: schema.overtimePolicy.dailyThresholdMinutes,
  }).from(schema.overtimePolicy)
    .where(and(
      eq(schema.overtimePolicy.organizationId, organizationId),
      eq(schema.overtimePolicy.active, true),
      isNull(schema.overtimePolicy.deletedAt),
    )).limit(1);

  const hours = kept.hours ? { openMinute: kept.hours.openMinute, closeMinute: kept.hours.closeMinute } : null;
  if (policy?.dailyThresholdMinutes) {
    return { minutes: policy.dailyThresholdMinutes, basis: "overtime_policy", closedOn: null, holiday, openMinutes, hours };
  }
  if (openMinutes === null || openMinutes <= 0) {
    return { minutes: null, basis: "unknown", closedOn: null, holiday, openMinutes: null, hours: null };
  }
  return { minutes: openMinutes, basis: "business_hours", closedOn: null, holiday, openMinutes, hours };
}

/**
 * The branch whose hours a route keeps: its crew's, or the technician's
 * (their membership's), the same answer `people-scope.ts` gives for who runs
 * it. Null for neither, which reads the company's.
 */
async function branchOfRoute(tx: Database, route: typeof schema.route.$inferSelect): Promise<string | null> {
  if (route.crewId) {
    const [crew] = await tx.select({ branchId: schema.crew.businessUnitId }).from(schema.crew)
      .where(eq(schema.crew.id, route.crewId)).limit(1);
    return crew?.branchId ?? null;
  }
  if (route.technicianId) {
    const [person] = await tx.select({ branchId: schema.membership.businessUnitId }).from(schema.technician)
      .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
      .where(eq(schema.technician.id, route.technicianId)).limit(1);
    return person?.branchId ?? null;
  }
  return null;
}

/* ----------------------------------------------------------------- loading */

/**
 * A stop by its own id, on a route this person sees, or not found: a stop
 * is its route's, and its route is whoever runs it (`people-scope.ts`,
 * which also says why neither table is filtered on `deleted_at`).
 */
async function stopWithin(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select({ stop: schema.routeStop }).from(schema.routeStop)
    .innerJoin(schema.route, eq(schema.route.id, schema.routeStop.routeId))
    .where(and(
      eq(schema.routeStop.id, id),
      eq(schema.routeStop.organizationId, ctx.actor.organizationId),
      routesInView(ctx),
    )).limit(1);
  if (!row) throw new NotFoundError("Route stop");
  return row.stop;
}

async function listStops(tx: Database, routeId: string) {
  return tx.select({
    id: schema.routeStop.id,
    propertyId: schema.routeStop.propertyId,
    addressLine1: schema.property.addressLine1,
    latitude: schema.property.latitude,
    longitude: schema.property.longitude,
    sequence: schema.routeStop.sequence,
    estimatedMinutes: schema.routeStop.estimatedMinutes,
    intervalDays: schema.routeStop.intervalDays,
    lastServicedOn: schema.routeStop.lastServicedOn,
    nextDueOn: schema.routeStop.nextDueOn,
    pricePerStop: schema.routeStop.pricePerStop,
    active: schema.routeStop.active,
  }).from(schema.routeStop)
    .innerJoin(schema.property, eq(schema.property.id, schema.routeStop.propertyId))
    .where(and(
      eq(schema.routeStop.routeId, routeId),
    ))
    .orderBy(asc(schema.routeStop.sequence));
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listServiceRoutes: async (ctx: ServiceContext): Promise<{
    routes: {
      id: string; name: string; dayOfWeek: number | null; dayName: string | null;
      technicianId: string | null; crewId: string | null; territoryId: string | null;
      targetStopCount: number | null; startsAt: string | null;
      travelMinutesBetweenStops: number | null; stopCount: number; active: boolean;
    }[];
  }> => ({ routes: await list(ctx) }),

  createServiceRoute: async (ctx: ServiceContext, input: {
    name: string; dayOfWeek: number;
    technicianId?: string | null | undefined;
    crewId?: string | null | undefined;
    territoryId?: string | null | undefined;
    targetStopCount?: number | null | undefined;
    startsAt?: string | null | undefined;
    travelMinutesBetweenStops?: number | null | undefined;
    color?: string | null | undefined;
  }): Promise<{ id: string; name: string; dayOfWeek: number | null }> => {
    const row = await create(ctx, input);
    return { id: row.id, name: row.name, dayOfWeek: row.dayOfWeek };
  },

  listServiceRouteStops: async (ctx: ServiceContext, input: { id: string }): Promise<{
    stops: {
      id: string; propertyId: string; addressLine1: string; sequence: number;
      estimatedMinutes: number; intervalDays: number | null;
      lastServicedOn: string | null; nextDueOn: string | null;
      pricePerStop: string | null; active: boolean;
    }[];
  }> => ({ stops: await stops(ctx, input) }),

  addServiceRouteStop: async (ctx: ServiceContext, input: {
    id: string; propertyId: string;
    estimatedMinutes?: number | undefined;
    intervalDays?: number | null | undefined;
    pricePerStop?: string | null | undefined;
    firstDueOn?: string | null | undefined;
  }): Promise<{ id: string; sequence: number; estimatedMinutes: number }> => {
    const row = await addStop(ctx, {
      routeId: input.id,
      propertyId: input.propertyId,
      ...(input.estimatedMinutes !== undefined ? { estimatedMinutes: input.estimatedMinutes } : {}),
      ...(input.intervalDays !== undefined ? { intervalDays: input.intervalDays } : {}),
      ...(input.pricePerStop !== undefined ? { pricePerStop: input.pricePerStop } : {}),
      ...(input.firstDueOn !== undefined ? { firstDueOn: input.firstDueOn } : {}),
    });
    return { id: row.id, sequence: row.sequence, estimatedMinutes: row.estimatedMinutes };
  },

  reorderServiceRouteStops: (ctx: ServiceContext, input: { id: string; stopIds: string[] }):
    Promise<{ id: string; ordered: number }> => reorder(ctx, input),

  setServiceRouteStopActive: (ctx: ServiceContext, input: { id: string; active: boolean }):
    Promise<{ id: string; active: boolean }> => setStopActive(ctx, input),

  recordServiceRouteStopServiced: (ctx: ServiceContext, input: { id: string; servicedOn: string }):
    Promise<{ id: string; lastServicedOn: string; nextDueOn: string | null }> =>
      recordServiced(ctx, input),

  materialiseServiceRoute: (ctx: ServiceContext, input: { id: string; date: string }):
    Promise<MaterialiseResult> => materialise(ctx, input),

  getServiceRouteDensity: (ctx: ServiceContext, input: {
    id: string; addingStopOfMinutes?: number | undefined; on?: string | undefined;
  }): Promise<Density> => density(ctx, input),
} as const;
