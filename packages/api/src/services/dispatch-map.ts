import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { geo, qualification as q, routing, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { qualify } from "./qualification";

/**
 * THE DAY ON A MAP, AND WHAT ORDER TO DRIVE IT IN
 *
 * The board answers "who is doing what"; this answers "where", which is the
 * half of dispatching a list cannot show. A dispatcher deciding whether Ray
 * can fit one more in the afternoon is asking how far it is from his three
 * o'clock, and the board had no way to say.
 *
 * THREE READS AND NO WRITES TO A DAY. The map, a proposed order for one
 * technician, and a proposed technician for each unassigned visit are all
 * suggestions. Accepting one goes through `dispatch.reorder` or
 * `dispatch.assign`, the same calls a drag makes, so the reorder's "only
 * this technician's visits" check and the assignment's qualification check
 * apply to an accepted suggestion exactly as they do to a hand.
 *
 * WHERE A DAY STARTS. A technician's own `home_location_id` when somebody
 * set one, otherwise the company's first location, which is the yard or the
 * office for nearly every company and is said to be the company default
 * wherever it is used. A location is geocoded like a property, so a
 * company's start point is on the map as soon as its address is.
 *
 * DRIVE TIME. A straight line, stretched by a road factor, at an average
 * speed the company sets (`geo.driveMinutes`), EXCEPT between two stops on
 * the same service route that has a declared drive time, where the
 * operator's own figure is used: the person who drives the route knows the
 * river has one bridge, and the straight line does not.
 */

/* --------------------------------------------------------- travel settings */

export interface TravelSettings {
  averageKmh: number;
  roadFactor: number;
  dayStartsAt: string;
}

const DEFAULT_TRAVEL: TravelSettings = {
  averageKmh: geo.DEFAULT_DRIVE.averageKmh,
  roadFactor: geo.DEFAULT_DRIVE.roadFactor,
  dayStartsAt: "08:00",
};

/**
 * Kept in `organization.settings.dispatchTravel`, beside the quiet hours,
 * because it is one company wide choice and a table for three numbers would
 * be a table nobody joins to.
 */
async function travelOf(tx: Database, organizationId: string): Promise<TravelSettings> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const held = ((row?.settings ?? {}) as Record<string, unknown>)["dispatchTravel"] as Partial<TravelSettings> | undefined;
  return {
    averageKmh: typeof held?.averageKmh === "number" ? held.averageKmh : DEFAULT_TRAVEL.averageKmh,
    roadFactor: typeof held?.roadFactor === "number" ? held.roadFactor : DEFAULT_TRAVEL.roadFactor,
    dayStartsAt: typeof held?.dayStartsAt === "string" ? held.dayStartsAt : DEFAULT_TRAVEL.dayStartsAt,
  };
}

export async function travelSettings(ctx: ServiceContext): Promise<TravelSettings> {
  return guardedRead(ctx, "visit:read", (tx) => travelOf(tx, ctx.actor.organizationId));
}

export async function setTravelSettings(
  ctx: ServiceContext,
  input: { averageKmh?: number | undefined; roadFactor?: number | undefined; dayStartsAt?: string | undefined },
): Promise<TravelSettings> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const before = await travelOf(tx, ctx.actor.organizationId);
    const after: TravelSettings = {
      averageKmh: input.averageKmh ?? before.averageKmh,
      roadFactor: input.roadFactor ?? before.roadFactor,
      dayStartsAt: input.dayStartsAt ?? before.dayStartsAt,
    };
    if (!(after.averageKmh >= 5 && after.averageKmh <= 130)) {
      throw new ConflictError("An average speed is between 5 and 130 kilometres an hour.");
    }
    if (!(after.roadFactor >= 1 && after.roadFactor <= 3)) {
      throw new ConflictError("A road is never shorter than the straight line, and rarely three times it.");
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(after.dayStartsAt)) {
      throw new ConflictError("When the day starts is a time, HH:MM.");
    }
    await tx.update(schema.organization).set({
      settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ dispatchTravel: after })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "dispatch.travel_set", "organization", ctx.actor.organizationId, before, after);
    return after;
  });
}

/* ------------------------------------------------------------- the day */

const UNDER_WAY = ["en_route", "working"] as const;
const FINISHED = ["completed", "no_show", "completed_after_cancellation"] as const;
const NOT_STOPS = ["cancelled"] as const;

type Precision = geo.GeocodePrecision;

interface Place {
  lat: number;
  lng: number;
  precision: Precision | null;
  source: string | null;
}

const placeOf = (row: {
  latitude: string | null; longitude: string | null;
  locationPrecision: Precision | null; locationSource: string | null;
}): Place | null => {
  const at = geo.parseLatLng(row.latitude, row.longitude);
  return at ? { ...at, precision: row.locationPrecision, source: row.locationSource } : null;
};

interface DayVisit {
  id: string;
  jobId: string;
  jobNumber: number;
  summary: string;
  customerName: string;
  propertyId: string;
  address: string;
  status: string;
  windowStart: Date | null;
  windowEnd: Date | null;
  estimatedDurationMinutes: number;
  routeOrder: number | null;
  routeId: string | null;
  arrivedAt: Date | null;
  jobTypeId: string | null;
  requiredSkills: string[];
  place: Place | null;
  /** Lead first. */
  technicianIds: string[];
  isLate: boolean;
}

interface Start {
  locationId: string;
  name: string;
  place: Place | null;
  isCompanyDefault: boolean;
}

interface Day {
  date: string;
  zone: string;
  origin: Date;
  travel: TravelSettings;
  technicians: {
    id: string; displayName: string; color: string | null; skills: string[];
    timeOff: boolean; start: Start | null;
  }[];
  visits: DayVisit[];
  routeMinutes: Map<string, number>;
}

/**
 * Everything the three reads need about one day, in a handful of queries.
 * The same window and the same `isLate` rule as `dispatch.board`, so the map
 * and the board cannot disagree about which visits are on the day or late.
 */
async function loadDay(tx: Database, organizationId: string, date: string): Promise<Day> {
  const zone = await timezoneOf(tx, organizationId);
  const { start: dayStart, end: dayEnd } = time.dayBoundsIn(date, zone);
  const travel = await travelOf(tx, organizationId);
  const now = new Date();

  const people = await tx.select({
    id: schema.technician.id,
    displayName: schema.technician.displayName,
    color: schema.technician.color,
    skills: schema.technician.skills,
    homeLocationId: schema.technician.homeLocationId,
  }).from(schema.technician)
    .where(and(eq(schema.technician.organizationId, organizationId), eq(schema.technician.active, true)))
    .orderBy(asc(schema.technician.displayName));

  const locations = await tx.select().from(schema.location)
    .where(and(eq(schema.location.organizationId, organizationId), eq(schema.location.active, true)))
    .orderBy(asc(schema.location.createdAt), asc(schema.location.id));
  const companyDefault = locations[0] ?? null;
  const startOf = (homeLocationId: string | null): Start | null => {
    const own = homeLocationId ? locations.find((l) => l.id === homeLocationId) : undefined;
    const chosen = own ?? companyDefault;
    if (!chosen) return null;
    return { locationId: chosen.id, name: chosen.name, place: placeOf(chosen), isCompanyDefault: !own };
  };

  const off = await tx.select({ technicianId: schema.timeOff.technicianId }).from(schema.timeOff)
    .where(and(
      eq(schema.timeOff.organizationId, organizationId),
      eq(schema.timeOff.approved, true),
      lte(schema.timeOff.startsAt, dayEnd),
      gte(schema.timeOff.endsAt, dayStart),
    ));
  const offToday = new Set(off.map((o) => o.technicianId));

  const rows = await tx.select({
    visit: schema.visit,
    jobNumber: schema.job.number,
    summary: schema.job.summary,
    jobTypeId: schema.job.jobTypeId,
    requiredSkills: schema.jobType.requiredSkills,
    customerName: schema.customer.name,
    property: {
      id: schema.property.id,
      addressLine1: schema.property.addressLine1,
      city: schema.property.city,
      latitude: schema.property.latitude,
      longitude: schema.property.longitude,
      locationPrecision: schema.property.locationPrecision,
      locationSource: schema.property.locationSource,
    },
  }).from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
    .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
    .leftJoin(schema.jobType, eq(schema.jobType.id, schema.job.jobTypeId))
    .where(and(
      eq(schema.visit.organizationId, organizationId),
      gte(schema.visit.windowStart, dayStart),
      lte(schema.visit.windowStart, dayEnd),
    ))
    .orderBy(asc(schema.visit.routeOrder), asc(schema.visit.windowStart), asc(schema.visit.id));

  const ids = rows.map((r) => r.visit.id);
  const assignments = ids.length === 0 ? [] : await tx.select({
    visitId: schema.visitAssignment.visitId,
    technicianId: schema.visitAssignment.technicianId,
    isLead: schema.visitAssignment.isLead,
  }).from(schema.visitAssignment).where(inArray(schema.visitAssignment.visitId, ids));
  const assigned = new Map<string, string[]>();
  for (const a of [...assignments].sort((x, y) => Number(y.isLead) - Number(x.isLead))) {
    assigned.set(a.visitId, [...(assigned.get(a.visitId) ?? []), a.technicianId]);
  }

  const routeIds = [...new Set(rows.map((r) => r.visit.routeId).filter((id): id is string => id !== null))];
  const routes = routeIds.length === 0 ? [] : await tx.select({
    id: schema.route.id, minutes: schema.route.travelMinutesBetweenStops,
  }).from(schema.route).where(inArray(schema.route.id, routeIds));
  const routeMinutes = new Map(routes.filter((r) => r.minutes !== null).map((r) => [r.id, r.minutes!]));

  const done = new Set<string>(["completed", "cancelled", "no_show", "completed_after_cancellation"]);
  return {
    date, zone, origin: dayStart, travel, routeMinutes,
    technicians: people.map((p) => ({
      id: p.id, displayName: p.displayName, color: p.color, skills: p.skills ?? [],
      timeOff: offToday.has(p.id), start: startOf(p.homeLocationId),
    })),
    visits: rows.map((r) => ({
      id: r.visit.id,
      jobId: r.visit.jobId,
      jobNumber: r.jobNumber,
      summary: r.summary,
      customerName: r.customerName,
      propertyId: r.property.id,
      address: [r.property.addressLine1, r.property.city].filter(Boolean).join(", "),
      status: r.visit.status,
      windowStart: r.visit.windowStart,
      windowEnd: r.visit.windowEnd,
      estimatedDurationMinutes: r.visit.estimatedDurationMinutes,
      routeOrder: r.visit.routeOrder,
      routeId: r.visit.routeId,
      arrivedAt: r.visit.arrivedAt,
      jobTypeId: r.jobTypeId,
      requiredSkills: r.requiredSkills ?? [],
      place: placeOf(r.property),
      technicianIds: assigned.get(r.visit.id) ?? [],
      isLate: Boolean(r.visit.windowEnd && r.visit.windowEnd < now && !done.has(r.visit.status)),
    })),
  };
}

/** A technician's visits in the order they will drive them: route order, then window. */
const routeOf = (day: Day, technicianId: string): DayVisit[] =>
  day.visits.filter((v) => v.technicianIds.includes(technicianId));

const iso = (d: Date | null) => d?.toISOString() ?? null;

/* -------------------------------------------------------------- the map */

export async function map(ctx: ServiceContext, input: { date: string }) {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const day = await loadDay(tx, ctx.actor.organizationId, input.date);
    const [geocoder] = await tx.select({ provider: schema.integrationConnection.provider })
      .from(schema.integrationConnection)
      .where(and(
        eq(schema.integrationConnection.capability, "maps"),
        eq(schema.integrationConnection.status, "connected"),
        isNull(schema.integrationConnection.deletedAt),
      ))
      .orderBy(asc(schema.integrationConnection.createdAt)).limit(1);

    const position = (place: Place | null) => place
      ? { lat: place.lat, lng: place.lng, precision: place.precision, source: place.source }
      : null;

    return {
      date: day.date,
      timezone: day.zone,
      technicians: day.technicians.map((t) => ({
        id: t.id,
        displayName: t.displayName,
        color: t.color,
        timeOff: t.timeOff,
        start: t.start ? { locationId: t.start.locationId, name: t.start.name, position: position(t.start.place) } : null,
        startIsCompanyDefault: t.start?.isCompanyDefault ?? false,
        route: routeOf(day, t.id).filter((v) => !(NOT_STOPS as readonly string[]).includes(v.status)).map((v) => v.id),
      })),
      visits: day.visits.map((v) => ({
        id: v.id,
        jobId: v.jobId,
        jobNumber: v.jobNumber,
        summary: v.summary,
        customerName: v.customerName,
        propertyId: v.propertyId,
        address: v.address,
        status: v.status,
        windowStart: iso(v.windowStart),
        windowEnd: iso(v.windowEnd),
        estimatedDurationMinutes: v.estimatedDurationMinutes,
        routeOrder: v.routeOrder,
        isLate: v.isLate,
        technicianId: v.technicianIds[0] ?? null,
        technicianIds: v.technicianIds,
        position: position(v.place),
      })),
      unplaced: day.visits.filter((v) => v.place === null).map((v) => v.id),
      travel: day.travel,
      geocoder: geocoder?.provider ?? null,
    };
  });
}

/* ---------------------------------------------------- travel between keys */

const START = "start";
const END = "end";

/**
 * The drive between any two keys, in minutes: a visit id, or the start and
 * end of a technician's day. Declared route minutes where both are stops on
 * the same route that has them; the straight line estimate otherwise.
 * Counts how often the declared figure was used, so the preview can say how
 * much of it was the company's own number.
 */
function travelFor(day: Day, points: Map<string, { place: Place | null; routeId: string | null }>) {
  let declared = 0;
  const assumptions = { averageKmh: day.travel.averageKmh, roadFactor: day.travel.roadFactor };
  const travel: routing.Travel = (from, to) => {
    if (from === to) return 0;
    const a = points.get(from);
    const b = points.get(to);
    if (!a?.place || !b?.place) return 0;
    if (a.routeId && a.routeId === b.routeId && day.routeMinutes.has(a.routeId)) {
      declared += 1;
      return day.routeMinutes.get(a.routeId)!;
    }
    return geo.driveMinutes(a.place, b.place, assumptions);
  };
  return { travel, declared: () => declared };
}

const minutesFrom = (origin: Date, at: Date) => Math.round((at.getTime() - origin.getTime()) / 60_000);

/** When the van leaves, in minutes from local midnight: the day's start, or now if that has passed. */
function departureOf(day: Day): number {
  const [h, m] = day.travel.dayStartsAt.split(":").map(Number);
  const startsAt = time.instantOfLocal(day.date, h! * 60 + m!, day.zone);
  const now = new Date();
  const from = now > startsAt && time.dateIn(now, day.zone) === day.date ? now : startsAt;
  return minutesFrom(day.origin, from);
}

const stopOf = (day: Day, v: DayVisit): routing.PlanStop => ({
  id: v.id,
  serviceMinutes: v.estimatedDurationMinutes,
  windowStart: v.windowStart ? minutesFrom(day.origin, v.windowStart) : null,
  windowEnd: v.windowEnd ? minutesFrom(day.origin, v.windowEnd) : null,
});

/* -------------------------------------------------------------- optimise */

export async function optimise(ctx: ServiceContext, input: { date: string; technicianId: string }) {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const day = await loadDay(tx, ctx.actor.organizationId, input.date);
    const technician = day.technicians.find((t) => t.id === input.technicianId);
    if (!technician) throw new NotFoundError("Technician");

    const theirs = routeOf(day, technician.id);
    const stops = theirs.filter((v) => !(NOT_STOPS as readonly string[]).includes(v.status));
    const cancelled = theirs.filter((v) => (NOT_STOPS as readonly string[]).includes(v.status));
    /**
     * Work under way or finished is not moved. The plan starts from the last
     * of it that is on the map, at the later of now and when that work will
     * be done, because that is where the van actually is.
     */
    const locked = stops.filter((v) =>
      (UNDER_WAY as readonly string[]).includes(v.status) || (FINISHED as readonly string[]).includes(v.status));
    const movable = stops.filter((v) => !locked.includes(v));
    const placed = movable.filter((v) => v.place !== null);
    const unplaced = movable.filter((v) => v.place === null);

    const points = new Map<string, { place: Place | null; routeId: string | null }>();
    for (const v of stops) points.set(v.id, { place: v.place, routeId: v.routeId });

    let departAt = departureOf(day);
    const lastLocked = [...locked].reverse().find((v) => v.place !== null);
    const home = technician.start?.place ?? null;
    if (lastLocked) {
      points.set(START, { place: lastLocked.place, routeId: lastLocked.routeId });
      if ((UNDER_WAY as readonly string[]).includes(lastLocked.status)) {
        const begun = lastLocked.arrivedAt ?? new Date();
        departAt = Math.max(departAt, minutesFrom(day.origin, begun) + lastLocked.estimatedDurationMinutes);
      }
    } else {
      points.set(START, { place: home, routeId: null });
    }
    points.set(END, { place: home ?? lastLocked?.place ?? null, routeId: null });
    const startKnown = points.get(START)!.place !== null;

    const { travel, declared } = travelFor(day, points);
    const plan: routing.DayPlan = {
      start: START, end: END, departAt, travel,
      stops: placed.map((v) => stopOf(day, v)),
    };
    const result = routing.optimise(plan, placed.map((v) => v.id));
    const summary = (e: routing.Evaluation) => ({
      order: e.order,
      driveMinutes: e.driveMinutes,
      waitMinutes: e.waitMinutes,
      lateCount: e.late.length,
      lateMinutes: e.lateMinutes,
      finishAt: new Date(day.origin.getTime() + e.finishAt * 60_000).toISOString(),
    });
    const byId = new Map(stops.map((v) => [v.id, v]));

    return {
      technicianId: technician.id,
      date: day.date,
      startKnown,
      startLabel: lastLocked
        ? `${lastLocked.customerName}, where the work under way is`
        : technician.start ? `${technician.start.name}${technician.start.isCompanyDefault ? " (the company's first location)" : ""}` : null,
      current: summary(result.current),
      proposed: summary(result.proposed),
      improved: result.improved,
      missed: result.missed.map((m) => ({
        visitId: m.id,
        customerName: byId.get(m.id)?.customerName ?? "",
        lateByMinutes: m.lateBy,
        unreachable: m.unreachable,
      })),
      locked: locked.map((v) => v.id),
      unplaced: unplaced.map((v) => v.id),
      /**
       * The whole day, because the reorder numbers what it is sent from one
       * and leaves the rest alone: sending only the moved visits would leave
       * two stops numbered one. Cancelled visits go last, where they are out
       * of the way and still accounted for.
       */
      applyOrder: [
        ...locked.map((v) => v.id),
        ...result.proposed.order,
        ...unplaced.map((v) => v.id),
        ...cancelled.map((v) => v.id),
      ],
      declaredLegs: declared(),
      travel: day.travel,
    };
  });
}

/* ------------------------------------------------------------- suggestions */

export async function suggestions(ctx: ServiceContext, input: { date: string }) {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const day = await loadDay(tx, ctx.actor.organizationId, input.date);
    const open = day.visits.filter((v) => v.technicianIds.length === 0 && v.status === "unassigned");
    const placedOpen = open.filter((v) => v.place !== null);

    const points = new Map<string, { place: Place | null; routeId: string | null }>();
    for (const v of day.visits) points.set(v.id, { place: v.place, routeId: v.routeId });
    const departAt = departureOf(day);

    const technicianDays: routing.TechnicianDay[] = [];
    for (const t of day.technicians) {
      points.set(`start:${t.id}`, { place: t.start?.place ?? null, routeId: null });
      technicianDays.push({
        technicianId: t.id,
        start: `start:${t.id}`,
        end: `start:${t.id}`,
        departAt,
        stops: routeOf(day, t.id)
          .filter((v) => v.place !== null && !(NOT_STOPS as readonly string[]).includes(v.status))
          .map((v) => stopOf(day, v)),
      });
    }

    /**
     * The same qualification check the assignment makes, per distinct set of
     * required skills rather than per visit, because a day of ten diagnostic
     * calls is one question asked ten times.
     */
    const verdictsBySkills = new Map<string, Map<string, q.QualificationVerdict>>();
    const technicianIds = day.technicians.map((t) => t.id);
    for (const v of placedOpen) {
      const key = q.normaliseSkills(v.requiredSkills).sort().join("|");
      if (!verdictsBySkills.has(key)) {
        verdictsBySkills.set(key, await qualify(tx, ctx.actor.organizationId, {
          technicianIds, skills: v.requiredSkills, on: day.date,
        }));
      }
    }
    const verdictOf = (v: DayVisit, technicianId: string) =>
      verdictsBySkills.get(q.normaliseSkills(v.requiredSkills).sort().join("|"))?.get(technicianId);

    const visits: routing.OpenVisit[] = placedOpen.map((v) => ({
      stop: stopOf(day, v),
      refusals: Object.fromEntries(day.technicians.map((t) => {
        if (t.timeOff) return [t.id, `${t.displayName} is on approved time off on ${day.date}.`];
        if (!t.start?.place) {
          return [t.id, `Where ${t.displayName}'s day starts is not on the map, so nothing can be measured from it.`];
        }
        const verdict = verdictOf(v, t.id);
        return [t.id, verdict && !verdict.qualified ? verdict.refusal : null];
      })),
    }));

    const { travel } = travelFor(day, points);
    const proposed = routing.suggestAssignments({ technicians: technicianDays, visits, travel });
    const nameOf = new Map(day.technicians.map((t) => [t.id, t.displayName]));
    const visitById = new Map(day.visits.map((v) => [v.id, v]));

    return {
      date: day.date,
      suggestions: proposed.map((s) => {
        const visit = visitById.get(s.visitId)!;
        return {
          visitId: s.visitId,
          customerName: visit.customerName,
          technicianId: s.technicianId,
          technicianName: s.technicianId ? nameOf.get(s.technicianId) ?? null : null,
          position: s.position === null ? null : s.position + 1,
          addedDriveMinutes: s.addedDriveMinutes,
          wouldBeLate: s.makesLate.map((l) => ({ visitId: l.id, lateByMinutes: l.lateBy })),
          unknownSkills: s.technicianId ? verdictOf(visit, s.technicianId)?.unknown ?? [] : [],
          considered: s.considered.map((c) => ({
            technicianId: c.technicianId,
            technicianName: nameOf.get(c.technicianId) ?? "",
            addedDriveMinutes: c.addedDriveMinutes,
            makesLate: c.makesLate,
            refused: c.refused,
          })),
        };
      }),
      unplaced: open.filter((v) => v.place === null).map((v) => v.id),
    };
  });
}

/* ------------------------------------------------------------ technicians */

export interface TechnicianProfile {
  id: string;
  displayName: string;
  color: string | null;
  active: boolean;
  skills: string[];
  homeLocationId: string | null;
}

const profileOf = (row: typeof schema.technician.$inferSelect): TechnicianProfile => ({
  id: row.id, displayName: row.displayName, color: row.color, active: row.active,
  skills: row.skills ?? [], homeLocationId: row.homeLocationId,
});

export async function technicians(ctx: ServiceContext): Promise<TechnicianProfile[]> {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const rows = await tx.select().from(schema.technician)
      .where(eq(schema.technician.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.technician.displayName));
    return rows.map(profileOf);
  });
}

/**
 * Record what somebody does, where their day starts, and their colour.
 *
 * `technician.skills` existed from the first migration with a comment saying
 * it gates dispatch, and nothing in the product wrote it. Writing it is
 * `user:write`, the permission for editing the people who work here: what a
 * person is recorded as doing decides where they may be sent.
 */
export async function updateTechnician(ctx: ServiceContext, input: {
  id: string;
  skills?: string[] | undefined;
  homeLocationId?: string | null | undefined;
  color?: string | null | undefined;
}): Promise<TechnicianProfile> {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const [before] = await tx.select().from(schema.technician)
      .where(and(
        eq(schema.technician.id, input.id),
        eq(schema.technician.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!before) throw new NotFoundError("Technician");

    if (input.homeLocationId) {
      const [location] = await tx.select({ id: schema.location.id }).from(schema.location)
        .where(and(
          eq(schema.location.id, input.homeLocationId),
          eq(schema.location.organizationId, ctx.actor.organizationId),
        )).limit(1);
      if (!location) throw new NotFoundError("Location");
    }

    const [after] = await tx.update(schema.technician).set({
      ...(input.skills !== undefined ? { skills: q.normaliseSkills(input.skills) } : {}),
      ...(input.homeLocationId !== undefined ? { homeLocationId: input.homeLocationId } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.technician.id, input.id)).returning();

    await audit(tx, ctx, "technician.profile_set", "technician", input.id,
      { skills: before.skills, homeLocationId: before.homeLocationId, color: before.color },
      { skills: after!.skills, homeLocationId: after!.homeLocationId, color: after!.color });
    return profileOf(after!);
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  getDispatchMap: (ctx: ServiceContext, input: { date: string }) => map(ctx, input),
  getRouteProposal: (ctx: ServiceContext, input: { date: string; technicianId: string }) => optimise(ctx, input),
  getAssignmentSuggestions: (ctx: ServiceContext, input: { date: string }) => suggestions(ctx, input),
  getTravelSettings: (ctx: ServiceContext) => travelSettings(ctx),
  setTravelSettings: (ctx: ServiceContext, input: {
    averageKmh?: number | undefined; roadFactor?: number | undefined; dayStartsAt?: string | undefined;
  }) => setTravelSettings(ctx, input),
  listTechnicians: async (ctx: ServiceContext) => ({ technicians: await technicians(ctx) }),
  updateTechnician: (ctx: ServiceContext, input: {
    id: string; skills?: string[] | undefined; homeLocationId?: string | null | undefined; color?: string | null | undefined;
  }) => updateTechnician(ctx, input),
} as const;
