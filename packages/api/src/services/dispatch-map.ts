import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, can, geo, qualification as q, routing, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, scopeOf, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { jobVisibility, technicianScopeFilter } from "./scope";
import { qualify, workSkills } from "./qualification";
import { travelMatrix, describeSource, type TravelMatrix } from "./travel-times";
import * as location from "./location";
import * as files from "./files";
import * as dispatch from "./dispatch";
import { remember, replayed } from "./once";
import { rentalDispatchOf } from "./rental-billing";
import { priorityWithin } from "./agreements";

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
 * DRIVE TIME. By road when the company has connected a routing service
 * (`services/travel-times.ts`: OSRM it hosts, Mapbox or OpenRouteService),
 * otherwise a straight line, stretched by a road factor, at an average speed
 * the company sets (`geo.driveMinutes`), and every proposal says which it
 * used. Between two stops on the same service route that has a declared
 * drive time, the operator's own figure beats both: the person who drives
 * the route knows the river has one bridge.
 *
 * THE NETWORK IS IN NO TRANSACTION. Each read loads its day inside one, then
 * asks for drive times outside it, then computes, so a routing server taking
 * its time holds no connection while it thinks.
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

/* --------------------------------------------------------- the working day */

/**
 * The shape of a working day the rebalance plans inside: when it ends, the
 * break, and how much overtime it may plan. When it starts is the travel
 * settings' `dayStartsAt`, which the optimiser already used. A technician
 * with their own hours (`technician.workday`) has those instead of the
 * company's start and end.
 */
export interface WorkdaySettings {
  dayEndsAt: string;
  /** Minutes of break. Zero is no break planned. */
  lunchMinutes: number;
  /** The earliest and latest the break may start, local time. */
  lunchEarliest: string;
  lunchLatest: string;
  /** Overtime the rebalance may plan past the end of the day. */
  maxOvertimeMinutes: number;
}

const DEFAULT_WORKDAY: WorkdaySettings = {
  dayEndsAt: "17:00", lunchMinutes: 30, lunchEarliest: "11:00", lunchLatest: "13:30", maxOvertimeMinutes: 60,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const minutesOfDay = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

async function workdayOf(tx: Database, organizationId: string): Promise<WorkdaySettings> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const held = ((row?.settings ?? {}) as Record<string, unknown>)["dispatchWorkday"] as Partial<WorkdaySettings> | undefined;
  const text = (v: unknown, d: string) => (typeof v === "string" && HHMM.test(v) ? v : d);
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : d);
  return {
    dayEndsAt: text(held?.dayEndsAt, DEFAULT_WORKDAY.dayEndsAt),
    lunchMinutes: num(held?.lunchMinutes, DEFAULT_WORKDAY.lunchMinutes),
    lunchEarliest: text(held?.lunchEarliest, DEFAULT_WORKDAY.lunchEarliest),
    lunchLatest: text(held?.lunchLatest, DEFAULT_WORKDAY.lunchLatest),
    maxOvertimeMinutes: num(held?.maxOvertimeMinutes, DEFAULT_WORKDAY.maxOvertimeMinutes),
  };
}

export async function workdaySettings(ctx: ServiceContext): Promise<WorkdaySettings> {
  return guardedRead(ctx, "visit:read", (tx) => workdayOf(tx, ctx.actor.organizationId));
}

export async function setWorkdaySettings(ctx: ServiceContext, input: Partial<WorkdaySettings>): Promise<WorkdaySettings> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const before = await workdayOf(tx, ctx.actor.organizationId);
    const travel = await travelOf(tx, ctx.actor.organizationId);
    const after: WorkdaySettings = {
      dayEndsAt: input.dayEndsAt ?? before.dayEndsAt,
      lunchMinutes: input.lunchMinutes ?? before.lunchMinutes,
      lunchEarliest: input.lunchEarliest ?? before.lunchEarliest,
      lunchLatest: input.lunchLatest ?? before.lunchLatest,
      maxOvertimeMinutes: input.maxOvertimeMinutes ?? before.maxOvertimeMinutes,
    };
    for (const t of [after.dayEndsAt, after.lunchEarliest, after.lunchLatest]) {
      if (!HHMM.test(t)) throw new ConflictError("A time of day is HH:MM.");
    }
    if (minutesOfDay(after.dayEndsAt) <= minutesOfDay(travel.dayStartsAt)) {
      throw new ConflictError(`The day has to end after it starts, at ${travel.dayStartsAt}.`);
    }
    if (!(Number.isInteger(after.lunchMinutes) && after.lunchMinutes >= 0 && after.lunchMinutes <= 120)) {
      throw new ConflictError("A break is between none and two hours.");
    }
    if (minutesOfDay(after.lunchEarliest) > minutesOfDay(after.lunchLatest)) {
      throw new ConflictError("The earliest a break may start has to be before the latest.");
    }
    if (!(Number.isInteger(after.maxOvertimeMinutes) && after.maxOvertimeMinutes >= 0 && after.maxOvertimeMinutes <= 480)) {
      throw new ConflictError("Overtime the plan may use is between none and eight hours.");
    }
    await tx.update(schema.organization).set({
      settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ dispatchWorkday: after })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "dispatch.workday_set", "organization", ctx.actor.organizationId, before, after);
    return after;
  });
}

/* ------------------------------------------------------------- the day */

export const UNDER_WAY = ["en_route", "working"] as const;
export const FINISHED = ["completed", "no_show", "completed_after_cancellation"] as const;
export const NOT_STOPS = ["cancelled"] as const;

type Precision = geo.GeocodePrecision;

export interface Place {
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

export interface DayVisit {
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
  /** Locked by the office: stays with whoever has it, in its place. */
  locked: boolean;
  /** Sent to a crew rather than to people, which the crew model does through `visit.crew_id`. */
  crewId: string | null;
  customerId: string;
  /**
   * The days the customer agreed this visit may happen on, inclusive: the
   * visit's own when the office set them, otherwise the window of the
   * agreement visit it delivers. Null when nobody agreed a range.
   */
  movable: { from: string | null; until: string | null } | null;
  /** The days of the week that suit the customer, 0 for Sunday. Empty is any day. */
  preferredDays: number[];
  /** What the stop does to a roll off truck: a drop, a collection, a swap, or nothing. */
  truckWork: routing.TruckWork;
}

interface Start {
  locationId: string;
  name: string;
  place: Place | null;
  isCompanyDefault: boolean;
}

export interface Day {
  date: string;
  zone: string;
  origin: Date;
  travel: TravelSettings;
  workday: WorkdaySettings;
  technicians: {
    id: string; displayName: string; color: string | null; skills: string[];
    timeOff: boolean; start: Start | null;
    /** Their own hours, when they are not the company's. */
    hours: { startsAt: string; endsAt: string } | null;
  }[];
  crews: {
    id: string; name: string; color: string | null; start: Start | null;
    members: { technicianId: string; isLead: boolean }[];
  }[];
  visits: DayVisit[];
  routeMinutes: Map<string, number>;
}

/**
 * WHAT ONE PERSON MAY SEE OF A DAY: the visits on jobs their visit scope
 * reaches, and the people their scope reaches plus anybody on one of those
 * visits. The board applies the same two conditions (`dispatch.board`), so
 * a branch manager's map, suggestions and rebalance are of their branch's
 * day and cannot place, propose or move another branch's work.
 *
 * Required rather than defaulted, so a new reader of a day has to say whose
 * day it is reading.
 */
export interface DayScope { visits: SQL | undefined; people: SQL | undefined }

export function dayScopeOf(ctx: ServiceContext): DayScope {
  const scope = scopeOf(ctx, "visit");
  return {
    visits: jobVisibility(scope, ctx.actor, sql`${schema.job.id}`),
    people: technicianScopeFilter(scope, ctx.actor),
  };
}

/**
 * Everything the reads need about one day, in a handful of queries. Shared
 * with the multi day rebalance (`dispatch-days.ts`), which loads each day
 * of its range with it, so a day there is the same day as here.
 * The same window and the same `isLate` rule as `dispatch.board`, so the map
 * and the board cannot disagree about which visits are on the day or late.
 */
export async function loadDay(tx: Database, organizationId: string, date: string, scope: DayScope): Promise<Day> {
  const zone = await timezoneOf(tx, organizationId);
  const { start: dayStart, end: dayEnd } = time.dayBoundsIn(date, zone);
  const travel = await travelOf(tx, organizationId);
  const workday = await workdayOf(tx, organizationId);
  const now = new Date();

  const people = await tx.select({
    id: schema.technician.id,
    displayName: schema.technician.displayName,
    color: schema.technician.color,
    skills: schema.technician.skills,
    homeLocationId: schema.technician.homeLocationId,
    workday: schema.technician.workday,
    inScope: scope.people ? sql<boolean>`${scope.people}` : sql<boolean>`true`,
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
    jobTypeCode: schema.jobType.code,
    capacityModel: schema.jobType.capacityModel,
    requiredSkills: schema.jobType.requiredSkills,
    jobSkills: schema.job.requiredSkills,
    droppedSkills: schema.job.droppedSkills,
    customerId: schema.customer.id,
    customerName: schema.customer.name,
    preferredDays: schema.customer.preferredDays,
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
      scope.visits,
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

  /**
   * Crews with work today, and their people. A crew's day starts where the
   * crew is based, or where its lead's does, or the company's first location.
   */
  const crewIds = [...new Set(rows.map((r) => r.visit.crewId).filter((id): id is string => id !== null))];
  const crewRows = crewIds.length === 0 ? [] : await tx.select().from(schema.crew)
    .where(inArray(schema.crew.id, crewIds)).orderBy(asc(schema.crew.name));
  const crewMembers = crewIds.length === 0 ? [] : await tx.select({
    crewId: schema.crewMember.crewId, technicianId: schema.crewMember.technicianId, isLead: schema.crewMember.isLead,
  }).from(schema.crewMember).where(inArray(schema.crewMember.crewId, crewIds));

  /**
   * The window of the agreement visit a job delivers, which is the range of
   * days the member was sold: "a tune up in the first half of May".
   */
  const jobIds = [...new Set(rows.map((r) => r.visit.jobId))];
  const owed = jobIds.length === 0 ? [] : await tx.select({
    jobId: schema.agreementVisit.jobId,
    from: schema.agreementVisit.windowStartOn,
    until: schema.agreementVisit.windowEndOn,
  }).from(schema.agreementVisit).where(inArray(schema.agreementVisit.jobId, jobIds));
  const owedWindow = new Map(owed.filter((o) => o.jobId && (o.from || o.until)).map((o) => [o.jobId!, { from: o.from, until: o.until }]));

  const done = new Set<string>(["completed", "cancelled", "no_show", "completed_after_cancellation"]);
  /** The people on the day: those in scope, and anybody on a visit in it. */
  const onVisibleWork = new Set(assignments.map((a) => a.technicianId));
  const crewPeople = new Set(crewMembers.map((m) => m.technicianId));
  return {
    date, zone, origin: dayStart, travel, routeMinutes, workday,
    technicians: people.filter((p) => p.inScope || onVisibleWork.has(p.id) || crewPeople.has(p.id)).map((p) => ({
      id: p.id, displayName: p.displayName, color: p.color, skills: p.skills ?? [],
      timeOff: offToday.has(p.id), start: startOf(p.homeLocationId),
      hours: p.workday && HHMM.test(p.workday.startsAt) && HHMM.test(p.workday.endsAt) ? p.workday : null,
    })),
    crews: crewRows.map((c) => {
      const members = crewMembers.filter((m) => m.crewId === c.id)
        .sort((a, b) => Number(b.isLead) - Number(a.isLead))
        .map((m) => ({ technicianId: m.technicianId, isLead: m.isLead }));
      const leadHome = people.find((p) => p.id === members.find((m) => m.isLead)?.technicianId)?.homeLocationId ?? null;
      return { id: c.id, name: c.name, color: c.color, start: startOf(c.homeLocationId ?? leadHome), members };
    }),
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
      requiredSkills: workSkills(r.requiredSkills, r.jobSkills, r.droppedSkills),
      place: placeOf(r.property),
      technicianIds: assigned.get(r.visit.id) ?? [],
      isLate: Boolean(r.visit.windowEnd && r.visit.windowEnd < now && !done.has(r.visit.status)),
      locked: r.visit.dispatchLocked,
      crewId: r.visit.crewId,
      customerId: r.customerId,
      movable: r.visit.movableFrom || r.visit.movableUntil
        ? { from: r.visit.movableFrom, until: r.visit.movableUntil }
        : owedWindow.get(r.visit.jobId) ?? null,
      preferredDays: (r.preferredDays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      truckWork: truckWorkOf(r.visit.rentalEvent, r.capacityModel, r.jobTypeCode),
    })),
  };
}

/**
 * What a stop does to a roll off truck. The leg the hire records when it
 * has one (`visit.rental_event`), otherwise the dumpster pack's job type
 * for rental work: a delivery is a drop before the hire exists to say so.
 */
export function truckWorkOf(
  rentalEvent: string | null, capacityModel: string | null, jobTypeCode: string | null,
): routing.TruckWork {
  const leg = rentalEvent ?? (capacityModel === "asset_rental" ? jobTypeCode : null);
  switch (leg) {
    case "delivery": return "drop";
    case "pickup": return "pickup";
    case "swap": return "swap";
    case "dump-return": return "dump_return";
    default: return "none";
  }
}

/** A technician's visits in the order they will drive them: route order, then window. */
export const routeOf = (day: Day, technicianId: string): DayVisit[] =>
  day.visits.filter((v) => v.technicianIds.includes(technicianId));

export const iso = (d: Date | null) => d?.toISOString() ?? null;

/* -------------------------------------------------------------- the map */

export async function map(ctx: ServiceContext, input: { date: string }) {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const day = await loadDay(tx, ctx.actor.organizationId, input.date, dayScopeOf(ctx));
    const connected = async (capability: "maps" | "routing") => {
      const [row] = await tx.select({ provider: schema.integrationConnection.provider })
        .from(schema.integrationConnection)
        .where(and(
          eq(schema.integrationConnection.capability, capability),
          eq(schema.integrationConnection.status, "connected"),
          isNull(schema.integrationConnection.deletedAt),
        ))
        .orderBy(asc(schema.integrationConnection.createdAt)).limit(1);
      return row?.provider ?? null;
    };

    const position = (place: Place | null) => place
      ? { lat: place.lat, lng: place.lng, precision: place.precision, source: place.source }
      : null;

    /**
     * Where people are, only for somebody who dispatches, and only on
     * today's map: a pin from this morning drawn on next Tuesday's day is
     * not where anybody will be.
     */
    const isToday = time.dateIn(new Date(), day.zone) === day.date;
    const everybody = can(ctx.actor, "visit:dispatch") && isToday
      ? await location.latestWithin(tx, ctx.actor.organizationId)
      : null;
    /** Only the vans of people on this person's day: another branch's are not theirs to watch. */
    const onDay = new Set(day.technicians.map((t) => t.id));
    const live = everybody
      ? { ...everybody, positions: everybody.positions.filter((p) => onDay.has(p.technicianId)) }
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
      crews: day.crews.map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        start: c.start ? { locationId: c.start.locationId, name: c.start.name, position: position(c.start.place) } : null,
        memberIds: c.members.map((m) => m.technicianId),
        route: day.visits
          .filter((v) => v.crewId === c.id && !(NOT_STOPS as readonly string[]).includes(v.status))
          .map((v) => v.id),
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
        crewId: v.crewId,
        locked: v.locked,
        position: position(v.place),
      })),
      unplaced: day.visits.filter((v) => v.place === null).map((v) => v.id),
      travel: day.travel,
      geocoder: await connected("maps"),
      routing: await connected("routing"),
      live,
    };
  });
}

/* ---------------------------------------------------- travel between keys */

const START = "start";
const END = "end";
const YARD = "yard";

export type Points = Map<string, { place: Place | null; routeId: string | null }>;

/**
 * The drive between any two keys, in minutes: a visit id, or the start and
 * end of a day. Declared route minutes where both are stops on the same
 * route that has them; by road or the straight line otherwise, as
 * `travelMatrix` decides. Counts how often the declared figure was used, so
 * the preview can say how much of it was the company's own number.
 */
export async function travelOver(ctx: ServiceContext, day: Day, points: Points) {
  let declared = 0;
  const assumptions = { averageKmh: day.travel.averageKmh, roadFactor: day.travel.roadFactor };
  const matrix = await travelMatrix(ctx, new Map([...points].map(([key, p]) => [key, p.place ? { lat: p.place.lat, lng: p.place.lng } : null])), {
    assumptions,
    declared: (from, to) => {
      const a = points.get(from);
      const b = points.get(to);
      if (a?.routeId && a.routeId === b?.routeId && day.routeMinutes.has(a.routeId)) {
        declared += 1;
        return day.routeMinutes.get(a.routeId)!;
      }
      return null;
    },
  });
  const travel: routing.Travel = (from, to) => {
    if (from === to) return 0;
    if (!points.get(from)?.place || !points.get(to)?.place) return 0;
    return matrix.travel(from, to);
  };
  return { travel, declared: () => declared, matrix };
}

export const minutesFrom = (origin: Date, at: Date) => Math.round((at.getTime() - origin.getTime()) / 60_000);

/** A local time on the day, in minutes from local midnight. */
export const atLocal = (day: Day, hhmm: string) => minutesFrom(day.origin, time.instantOfLocal(day.date, minutesOfDay(hhmm), day.zone));

/** When the van leaves, in minutes from local midnight: the day's start, or now if that has passed. */
export function departureOf(day: Day, startsAt: string = day.travel.dayStartsAt): number {
  const startsAtInstant = time.instantOfLocal(day.date, minutesOfDay(startsAt), day.zone);
  const now = new Date();
  const from = now > startsAtInstant && time.dateIn(now, day.zone) === day.date ? now : startsAtInstant;
  return minutesFrom(day.origin, from);
}

export const stopOf = (day: Day, v: DayVisit): routing.PlanStop => ({
  id: v.id,
  serviceMinutes: v.estimatedDurationMinutes,
  windowStart: v.windowStart ? minutesFrom(day.origin, v.windowStart) : null,
  windowEnd: v.windowEnd ? minutesFrom(day.origin, v.windowEnd) : null,
});

export const sourceOf = (matrix: TravelMatrix) => ({ driveSource: matrix.source, driveNote: describeSource(matrix) });

/**
 * Where a technician's plan starts and when: after the last work already
 * under way or finished that is on the map, at the later of its finish and
 * the start of the day, because that is where the van actually is.
 */
export function startingPoint(day: Day, technicianId: string, stops: DayVisit[], startsAt?: string) {
  const technician = day.technicians.find((t) => t.id === technicianId)!;
  const locked = stops.filter((v) =>
    (UNDER_WAY as readonly string[]).includes(v.status) || (FINISHED as readonly string[]).includes(v.status));
  let departAt = departureOf(day, startsAt);
  const lastLocked = [...locked].reverse().find((v) => v.place !== null);
  const home = technician.start?.place ?? null;
  let start: { place: Place | null; routeId: string | null } = { place: home, routeId: null };
  if (lastLocked) {
    start = { place: lastLocked.place, routeId: lastLocked.routeId };
    if ((UNDER_WAY as readonly string[]).includes(lastLocked.status)) {
      const begun = lastLocked.arrivedAt ?? new Date();
      departAt = Math.max(departAt, minutesFrom(day.origin, begun) + lastLocked.estimatedDurationMinutes);
    }
  }
  const end = { place: home ?? lastLocked?.place ?? null, routeId: null };
  return { technician, locked, lastLocked, departAt, start, end };
}

/* -------------------------------------------------------------- optimise */

export async function optimise(ctx: ServiceContext, input: { date: string; technicianId: string }) {
  const { day, truck } = await guardedRead(ctx, "visit:read", async (tx) => ({
    day: await loadDay(tx, ctx.actor.organizationId, input.date, dayScopeOf(ctx)),
    truck: await rentalDispatchOf(tx, ctx.actor.organizationId),
  }));
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
  const { locked, lastLocked, departAt, start, end } = startingPoint(day, technician.id, stops);
  const movable = stops.filter((v) => !locked.includes(v));
  const placed = movable.filter((v) => v.place !== null);
  const unplaced = movable.filter((v) => v.place === null);

  const points: Points = new Map();
  for (const v of stops) points.set(v.id, { place: v.place, routeId: v.routeId });
  points.set(START, start);
  points.set(END, end);
  /** Where a roll off truck tips a full can and loads an empty: where the driver's day starts. */
  points.set(YARD, { place: technician.start?.place ?? null, routeId: null });
  const startKnown = start.place !== null;

  const { travel, declared, matrix } = await travelOver(ctx, day, points);
  const plan: routing.DayPlan = {
    start: START, end: END, departAt, travel,
    stops: placed.map((v) => stopOf(day, v)),
  };
  /** A visit the office locked keeps its place; everything else is ordered around it. */
  const pinned = new Set(placed.filter((v) => v.locked).map((v) => v.id));

  /**
   * A DRIVER'S DAY WITH CONTAINERS ON IT is ordered by what is on the
   * truck (`routing/truck.ts`): a drop needs an empty on board, a
   * collection needs room, and the runs to the yard between are counted.
   * Only when the yard is on the map, because a run to somewhere unknown
   * cannot be measured; the proposal says so when it is not.
   */
  const containers = placed.some((v) => v.truckWork !== "none");
  const yardKnown = technician.start?.place != null;
  const byTruck = containers && yardKnown;
  const truckPlan: routing.TruckPlan | null = byTruck ? {
    ...plan,
    stops: placed.map((v) => ({ ...stopOf(day, v), work: v.truckWork })),
    yard: YARD,
    capacity: truck.containersPerTruck,
    yardMinutes: truck.yardMinutes,
    load: locked.length > 0 ? loadAfter(locked.map((v) => v.truckWork), truck.containersPerTruck) : null,
  } : null;
  const truckResult = truckPlan ? routing.optimiseTruck(truckPlan, placed.map((v) => v.id), { pinned }) : null;
  const result: routing.Proposal = truckResult ?? routing.optimise(plan, placed.map((v) => v.id), { pinned });
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
    pinned: [...pinned],
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
    truck: containers ? {
      byTruck,
      note: byTruck
        ? `Ordered by what is on the truck: ${truck.containersPerTruck === 1 ? "one container" : `${truck.containersPerTruck} containers`} at a time, ${truck.yardMinutes} minutes at the yard to tip and load.`
        : `Not ordered by what is on the truck, because where ${technician.displayName}'s day starts, the yard, is not on the map.`,
      containersPerTruck: truck.containersPerTruck,
      yardMinutes: truck.yardMinutes,
      /** Runs in the middle of the day; the one at the end to tip the last can is not a choice. */
      currentYardRuns: truckResult ? truckResult.current.yardRuns.filter((r) => r.beforeId !== null).length : null,
      yardRuns: (truckResult?.proposed.yardRuns ?? []).map((r) => ({
        afterVisitId: r.afterId,
        beforeVisitId: r.beforeId,
        tipped: r.tipped,
        loaded: r.loaded,
        arriveAt: clockOf(day, r.arriveAt),
      })),
      startLoad: truckResult ? truckResult.proposed.startLoad : null,
    } : null,
    ...sourceOf(matrix),
  };
}

/**
 * What is on the truck after the stops already done today, walked from an
 * empty truck at the yard: each drop took an empty, each collection a full
 * can, and a stop the truck could not have served means it went back to
 * the yard first. A guess at the morning is the best there is: the phone
 * does not record what was loaded.
 */
function loadAfter(works: routing.TruckWork[], capacity: number): routing.TruckLoad {
  let load: routing.TruckLoad = { empties: routing.loadFor(works, capacity), fulls: 0 };
  for (const [i, work] of works.entries()) {
    if (!routing.canServe(work, load, capacity)) load = { empties: routing.loadFor(works.slice(i), capacity), fulls: 0 };
    load = routing.afterStop(work, load);
  }
  return load;
}

/* ------------------------------------------------------------- suggestions */

/**
 * The same qualification check the assignment makes, per distinct set of
 * required skills rather than per visit, because a day of ten diagnostic
 * calls is one question asked ten times.
 */
export async function verdictsFor(tx: Database, organizationId: string, day: Day, visits: DayVisit[]) {
  const bySkills = new Map<string, Map<string, q.QualificationVerdict>>();
  const technicianIds = day.technicians.map((t) => t.id);
  for (const v of visits) {
    const key = q.normaliseSkills(v.requiredSkills).sort().join("|");
    if (!bySkills.has(key)) {
      bySkills.set(key, await qualify(tx, organizationId, { technicianIds, skills: v.requiredSkills, on: day.date }));
    }
  }
  return (v: DayVisit, technicianId: string) =>
    bySkills.get(q.normaliseSkills(v.requiredSkills).sort().join("|"))?.get(technicianId);
}

/** Why a technician may not take a visit, in one sentence, or null when they may. */
export function refusalFor(
  day: Day, t: Day["technicians"][number], v: DayVisit,
  verdictOf: (v: DayVisit, technicianId: string) => q.QualificationVerdict | undefined,
): string | null {
  if (t.timeOff) return `${t.displayName} is on approved time off on ${day.date}.`;
  if (!t.start?.place) return `Where ${t.displayName}'s day starts is not on the map, so nothing can be measured from it.`;
  const verdict = verdictOf(v, t.id);
  return verdict && !verdict.qualified ? verdict.refusal : null;
}

/**
 * Which of these visits a plan's priority dispatch covers, by visit, with
 * the plan's name: the board's rule (`agreements.priorityWithin`), so a
 * member first on the board is first in a suggestion too.
 */
export async function membersOn(tx: Database, day: Day, visits: DayVisit[]): Promise<Map<string, string>> {
  return priorityWithin(tx, visits.map((v) => ({
    key: v.id, customerId: v.customerId, propertyId: v.propertyId,
    on: v.windowStart ? time.dateIn(v.windowStart, day.zone) : day.date,
  })));
}

export async function suggestions(ctx: ServiceContext, input: { date: string }) {
  const { day, verdictOf, members } = await guardedRead(ctx, "visit:read", async (tx) => {
    const day = await loadDay(tx, ctx.actor.organizationId, input.date, dayScopeOf(ctx));
    const open = day.visits.filter((v) => v.technicianIds.length === 0 && v.status === "unassigned" && v.place !== null);
    return {
      day,
      verdictOf: await verdictsFor(tx, ctx.actor.organizationId, day, open),
      members: await membersOn(tx, day, open),
    };
  });
  const open = day.visits.filter((v) => v.technicianIds.length === 0 && v.status === "unassigned");
  const placedOpen = open.filter((v) => v.place !== null);

  const points: Points = new Map();
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

  /** Members whose plan promised priority are suggested first, as they are first on the board. */
  const visits: routing.OpenVisit[] = placedOpen.map((v) => ({
    stop: stopOf(day, v),
    refusals: Object.fromEntries(day.technicians.map((t) => [t.id, refusalFor(day, t, v, verdictOf)])),
    priority: members.has(v.id),
  }));

  const { travel, matrix } = await travelOver(ctx, day, points);
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
        /** The plan that put this visit first, when one did. */
        member: members.get(s.visitId) ?? null,
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
    ...sourceOf(matrix),
  };
}

/* ------------------------------------------------------------ rebalancing */

/**
 * A fingerprint of who has what on the day, and in what state. A proposal
 * carries the one it was made from, and applying it is refused when the
 * board no longer matches: a proposal made before somebody dragged a card is
 * a proposal about a different day.
 */
export function basisOf(day: Day): string {
  const lines = day.visits
    .map((v) => `${v.id}:${v.technicianIds.join(",")}:${v.crewId ?? ""}:${v.status}:${v.locked ? 1 : 0}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32);
}

/**
 * The technicians a rebalance leaves out, with their work where it is, and
 * why in a sentence.
 *
 * Somebody whose day has no start on the map: nothing about their day can
 * be measured, and moving work onto it or off it would be a guess. And a
 * driver whose day carries containers: that day is ordered by what is on
 * the truck, which the rebalance's arithmetic does not know, so it is left
 * to "Optimise route" rather than reordered as if the truck were a van.
 */
export function leftOutOf(day: Day): { technicianId: string; displayName: string; reason: string }[] {
  const out: { technicianId: string; displayName: string; reason: string }[] = [];
  for (const t of day.technicians) {
    if (!t.start?.place) {
      out.push({ technicianId: t.id, displayName: t.displayName, reason: `Where ${t.displayName}'s day starts is not on the map.` });
    } else if (routeOf(day, t.id).some((v) => v.truckWork !== "none" && !(NOT_STOPS as readonly string[]).includes(v.status))) {
      out.push({
        technicianId: t.id, displayName: t.displayName,
        reason: `${t.displayName}'s day has containers on it, so it is ordered by what is on the truck: use Optimise route on the board.`,
      });
    }
  }
  return out;
}

/** Which of a technician's visits the rebalance may plan, and which it leaves where they are. */
export function plannable(day: Day, v: DayVisit): boolean {
  return v.place !== null
    && v.crewId === null
    && v.truckWork === "none"
    && v.technicianIds.length <= 1
    && !(NOT_STOPS as readonly string[]).includes(v.status)
    && !(UNDER_WAY as readonly string[]).includes(v.status)
    && !(FINISHED as readonly string[]).includes(v.status)
    && v.status !== "no_show";
}

export const clockOf = (day: Day, minutes: number) => new Date(day.origin.getTime() + minutes * 60_000).toISOString();

/**
 * Each planned person's day as the rebalance plans it: where it starts and
 * ends, when the van leaves, the shift around it with lunch, and the
 * visits it may plan in the order they are in. Their work under way or
 * finished goes first in what is applied and is not planned. The keys of
 * the start and end carry `prefix`, so several days can share one map of
 * drive times without one day's start standing in for another's.
 */
export function rebalanceTechnicians(day: Day, planned: Day["technicians"], points: Points, prefix = "") {
  const techs: routing.RebalanceTechnician[] = [];
  const keepFirst = new Map<string, string[]>();
  for (const t of planned) {
    const theirs = routeOf(day, t.id);
    const stops = theirs.filter((v) => !(NOT_STOPS as readonly string[]).includes(v.status));
    const startsAt = t.hours?.startsAt ?? day.travel.dayStartsAt;
    const { locked, departAt, start, end } = startingPoint(day, t.id, stops, startsAt);
    keepFirst.set(t.id, locked.map((v) => v.id));
    points.set(`start:${prefix}${t.id}`, start);
    points.set(`end:${prefix}${t.id}`, end);
    const lunch = day.workday.lunchMinutes > 0
      ? { minutes: day.workday.lunchMinutes, earliest: atLocal(day, day.workday.lunchEarliest), latest: atLocal(day, day.workday.lunchLatest) }
      : null;
    techs.push({
      technicianId: t.id,
      start: `start:${prefix}${t.id}`,
      end: `end:${prefix}${t.id}`,
      departAt,
      shift: {
        endsAt: atLocal(day, t.hours?.endsAt ?? day.workday.dayEndsAt),
        maxOvertimeMinutes: day.workday.maxOvertimeMinutes,
        /** A break whose window has already closed by the time the van leaves is not planned. */
        lunch: lunch && departAt <= lunch.latest ? lunch : null,
      },
      /** A visit with several people on it counts on the lead's day only, and stays there. */
      order: stops.filter((v) => plannable(day, v) && v.technicianIds[0] === t.id).map((v) => v.id),
    });
  }
  return { techs, keepFirst };
}

/** The day's figures for one person, as a screen shows them before and after. */
export const rebalanceSummary = (day: Day, d: routing.RebalanceDay) => ({
  order: d.evaluation.order,
  driveMinutes: d.evaluation.driveMinutes,
  finishAt: clockOf(day, d.evaluation.finishAt),
  overtimeMinutes: d.evaluation.overtimeMinutes,
  overLimitMinutes: d.evaluation.overLimitMinutes,
  lunchAt: d.evaluation.lunch ? clockOf(day, d.evaluation.lunch.startAt) : null,
  lunchLateMinutes: d.evaluation.lunch?.lateBy ?? 0,
  late: d.evaluation.late.map((l) => ({ visitId: l.id, lateByMinutes: l.lateBy })),
  refused: d.refused,
});

export async function rebalance(ctx: ServiceContext, input: { date: string }) {
  const { day, verdictOf, members } = await guardedRead(ctx, "visit:read", async (tx) => {
    const day = await loadDay(tx, ctx.actor.organizationId, input.date, dayScopeOf(ctx));
    const candidates = day.visits.filter((v) => plannable(day, v));
    return {
      day,
      verdictOf: await verdictsFor(tx, ctx.actor.organizationId, day, candidates),
      members: await membersOn(tx, day, candidates.filter((v) => v.technicianIds.length === 0)),
    };
  });
  const visitById = new Map(day.visits.map((v) => [v.id, v]));
  const nameOf = new Map(day.technicians.map((t) => [t.id, t.displayName]));

  /** Who is left out, with their work where it is, and why: see `leftOutOf`. */
  const leftOut = leftOutOf(day);
  const planned = day.technicians.filter((t) => !leftOut.some((l) => l.technicianId === t.id));

  const points: Points = new Map();
  const { techs, keepFirst } = rebalanceTechnicians(day, planned, points);

  const candidates = day.visits.filter((v) => plannable(day, v)
    && (v.technicianIds.length === 0 ? v.status === "unassigned" : planned.some((t) => t.id === v.technicianIds[0])));
  for (const v of candidates) points.set(v.id, { place: v.place, routeId: v.routeId });

  const visits: routing.RebalanceVisit[] = candidates.map((v) => ({
    stop: stopOf(day, v),
    locked: v.locked,
    refusals: Object.fromEntries(planned.map((t) => [t.id, refusalFor(day, t, v, verdictOf)])),
    priority: members.has(v.id),
  }));

  const { travel, matrix } = await travelOver(ctx, day, points);
  const result = routing.rebalance({ technicians: techs, visits, travel });

  const summary = (d: routing.RebalanceDay) => rebalanceSummary(day, d);
  const customer = (id: string) => visitById.get(id)?.customerName ?? "A visit";

  /** What each unplaced visit would break, in a sentence. */
  const why = (u: routing.Unplaced): string => {
    if (u.why === "locked") return "Locked with nobody on it, so it is left for the office.";
    if (u.why === "nobody_may") return u.refusals[0] ?? "Nobody here may take it.";
    const n = u.nearest!;
    const name = nameOf.get(n.technicianId) ?? "anybody";
    const parts = [
      ...n.late.map((l) => l.id === u.visitId
        ? `arrive ${l.lateBy} minutes after its window closes`
        : `make ${customer(l.id)} ${l.lateBy} minutes late`),
      ...(n.overLimitMinutes > 0 ? [`run ${n.overLimitMinutes} minutes past the overtime allowed`] : []),
      ...(n.lunchLateBy > 0 ? [`push lunch ${n.lunchLateBy} minutes past its latest start`] : []),
    ];
    return `Even on ${name}'s day, the best place for it, it would ${parts.join(" and ") || "break a promise"}.`;
  };

  const after = new Map(result.after.map((d) => [d.technicianId, d]));
  const before = new Map(result.before.map((d) => [d.technicianId, d]));
  const apply = techs
    .filter((t) => after.get(t.technicianId)!.evaluation.order.join() !== before.get(t.technicianId)!.evaluation.order.join())
    .map((t) => {
      const planned = new Set(after.get(t.technicianId)!.evaluation.order);
      const others = routeOf(day, t.technicianId)
        .filter((v) => !keepFirst.get(t.technicianId)!.includes(v.id) && !planned.has(v.id)
          && !before.get(t.technicianId)!.evaluation.order.includes(v.id))
        .map((v) => v.id);
      return {
        technicianId: t.technicianId,
        visitIds: [...keepFirst.get(t.technicianId)!, ...after.get(t.technicianId)!.evaluation.order, ...others],
      };
    })
    .filter((a) => a.visitIds.length > 0);

  return {
    date: day.date,
    basis: basisOf(day),
    changed: result.changed,
    technicians: planned.map((t) => ({
      technicianId: t.id,
      displayName: t.displayName,
      color: t.color,
      timeOff: t.timeOff,
      before: summary(before.get(t.id)!),
      after: summary(after.get(t.id)!),
    })),
    moves: result.moves.map((m) => ({
      visitId: m.visitId,
      customerName: customer(m.visitId),
      fromTechnicianId: m.from,
      fromName: m.from ? nameOf.get(m.from) ?? null : null,
      toTechnicianId: m.to,
      toName: nameOf.get(m.to) ?? "",
    })),
    unplaced: result.unplaced.map((u) => ({ visitId: u.visitId, customerName: customer(u.visitId), reason: why(u) })),
    leftOut,
    /** Not planned at all: not on the map, a crew's, or several people's. Left where they are. */
    untouched: day.visits
      .filter((v) => !(NOT_STOPS as readonly string[]).includes(v.status) && !candidates.includes(v)
        && !(UNDER_WAY as readonly string[]).includes(v.status) && !(FINISHED as readonly string[]).includes(v.status))
      .map((v) => v.id),
    driveBeforeMinutes: result.driveBefore,
    driveAfterMinutes: result.driveAfter,
    driveSavedMinutes: result.driveBefore - result.driveAfter,
    overtimeBeforeMinutes: result.overtimeBefore,
    overtimeAfterMinutes: result.overtimeAfter,
    newlyAssigned: result.moves.filter((m) => m.from === null).length,
    moveAssignments: result.moves.map((m) => ({ visitId: m.visitId, technicianId: m.to })),
    visits: candidates.map((v) => ({
      visitId: v.id, customerName: v.customerName, locked: v.locked,
      windowStart: iso(v.windowStart), windowEnd: iso(v.windowEnd),
    })),
    apply,
    workday: day.workday,
    ...sourceOf(matrix),
  };
}

/**
 * Apply a rebalance a person looked at.
 *
 * Through the same assignment and reorder a drag uses, inside one
 * transaction, so the qualification check refuses here exactly as it would
 * on the board and a refusal leaves the day as it was rather than half
 * moved. Refused when the board has changed since the proposal was made.
 */
export async function applyRebalance(ctx: ServiceContext, input: {
  date: string;
  basis: string;
  moves: { visitId: string; technicianId: string }[];
  orders: { technicianId: string; visitIds: string[] }[];
}) {
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    assertCan(ctx.actor, "visit:reschedule");
    const prior = await replayed<{ ok: true; moved: number; reordered: number }>(tx, ctx, "dispatch_rebalance");
    if (prior) return prior;

    const day = await loadDay(tx, ctx.actor.organizationId, input.date, dayScopeOf(ctx));
    if (basisOf(day) !== input.basis) {
      throw new ConflictError("The board has changed since this was proposed. Propose it again to see the day as it is now.");
    }
    const inner: ServiceContext = { ...ctx, db: tx };
    delete inner.idempotencyKey;
    for (const move of input.moves) {
      const visit = day.visits.find((v) => v.id === move.visitId);
      if (!visit) throw new NotFoundError("Visit");
      if (visit.locked) throw new ConflictError(`${visit.customerName}'s visit is locked, so it is not moved.`);
      await dispatch.assign(inner, { id: move.visitId, technicianIds: [move.technicianId] });
    }
    for (const order of input.orders) {
      if (order.visitIds.length === 0) continue;
      await dispatch.reorder(inner, { technicianId: order.technicianId, date: input.date, visitIds: order.visitIds });
    }
    const answer = { ok: true as const, moved: input.moves.length, reordered: input.orders.length };
    await audit(tx, ctx, "dispatch.rebalanced", "organization", ctx.actor.organizationId, { basis: input.basis },
      { date: input.date, moves: input.moves, orders: input.orders.map((o) => o.technicianId) });
    await remember(tx, ctx, "dispatch_rebalance", null, answer);
    return answer;
  });
}

/**
 * Lock a visit to whoever has it, or let it go again. The rebalance and the
 * route optimiser leave a locked visit where it is.
 */
export async function lockVisit(ctx: ServiceContext, input: { id: string; locked: boolean }) {
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    const [before] = await tx.select({ locked: schema.visit.dispatchLocked }).from(schema.visit)
      .where(and(eq(schema.visit.id, input.id), eq(schema.visit.organizationId, ctx.actor.organizationId))).limit(1);
    if (!before) throw new NotFoundError("Visit");
    if (before.locked !== input.locked) {
      await tx.update(schema.visit).set({ dispatchLocked: input.locked, updatedAt: new Date() })
        .where(eq(schema.visit.id, input.id));
      await audit(tx, ctx, input.locked ? "visit.locked" : "visit.unlocked", "visit", input.id,
        { locked: before.locked }, { locked: input.locked });
    }
    return { id: input.id, locked: input.locked };
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
  /** Their own working hours, when they are not the company's. */
  workday: { startsAt: string; endsAt: string } | null;
  /** Whether their phone shares where they are while they work, when the company shares at all. */
  shareLocation: boolean;
  /** Whether a photograph is set for customers' tracking links. */
  hasPhoto: boolean;
}

const profileOf = (row: typeof schema.technician.$inferSelect): TechnicianProfile => ({
  id: row.id, displayName: row.displayName, color: row.color, active: row.active,
  skills: row.skills ?? [], homeLocationId: row.homeLocationId,
  workday: row.workday ?? null, shareLocation: row.shareLocation, hasPhoto: row.photoFileId !== null,
});

export async function technicians(ctx: ServiceContext): Promise<{
  technicians: TechnicianProfile[];
  companyStart: { locationId: string; name: string } | null;
}> {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const rows = await tx.select().from(schema.technician)
      .where(eq(schema.technician.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.technician.displayName));
    /** The same rule `loadDay` uses: the oldest active location. */
    const [first] = await tx.select({ id: schema.location.id, name: schema.location.name })
      .from(schema.location)
      .where(and(eq(schema.location.organizationId, ctx.actor.organizationId), eq(schema.location.active, true)))
      .orderBy(asc(schema.location.createdAt), asc(schema.location.id)).limit(1);
    return {
      technicians: rows.map(profileOf),
      companyStart: first ? { locationId: first.id, name: first.name } : null,
    };
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
  workday?: { startsAt: string; endsAt: string } | null | undefined;
  shareLocation?: boolean | undefined;
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

    if (input.workday) {
      if (!HHMM.test(input.workday.startsAt) || !HHMM.test(input.workday.endsAt)) {
        throw new ConflictError("Working hours are two times of day, HH:MM.");
      }
      if (minutesOfDay(input.workday.endsAt) <= minutesOfDay(input.workday.startsAt)) {
        throw new ConflictError("A working day has to end after it starts.");
      }
    }
    if (input.shareLocation !== undefined && input.shareLocation !== before.shareLocation) {
      await location.setPersonSharing(tx, ctx, input.id, input.shareLocation);
    }

    const [after] = await tx.update(schema.technician).set({
      ...(input.skills !== undefined ? { skills: q.normaliseSkills(input.skills) } : {}),
      ...(input.workday !== undefined ? { workday: input.workday } : {}),
      ...(input.shareLocation !== undefined ? { shareLocation: input.shareLocation } : {}),
      ...(input.homeLocationId !== undefined ? { homeLocationId: input.homeLocationId } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.technician.id, input.id)).returning();

    await audit(tx, ctx, "technician.profile_set", "technician", input.id,
      {
        skills: before.skills, homeLocationId: before.homeLocationId, color: before.color,
        workday: before.workday, shareLocation: before.shareLocation,
      },
      {
        skills: after!.skills, homeLocationId: after!.homeLocationId, color: after!.color,
        workday: after!.workday, shareLocation: after!.shareLocation,
      });
    return profileOf(after!);
  });
}

/** Two megabytes is a sharp phone photo; a customer's tracking page needs far less. */
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The photograph a customer sees on their tracking link, or none.
 *
 * Kept as a file like any other, decided from its bytes, and refused when it
 * is not a picture. Clearing it takes it off every tracking link at once,
 * because the link reads it each time rather than copying it.
 */
export async function setTechnicianPhoto(ctx: ServiceContext, input: { id: string; bytes: string | null }): Promise<TechnicianProfile> {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const [before] = await tx.select().from(schema.technician)
      .where(and(eq(schema.technician.id, input.id), eq(schema.technician.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!before) throw new NotFoundError("Technician");
    let fileId: string | null = null;
    if (input.bytes !== null) {
      const bytes = files.decode(input.bytes);
      const { file } = await files.put(tx, ctx.actor.organizationId, {
        bytes, maxBytes: PHOTO_MAX_BYTES, uploadedByUserId: ctx.actor.userId,
      });
      if (!file.contentType.startsWith("image/")) {
        throw new ConflictError("A technician's photo has to be a picture: a JPEG, PNG or WebP.");
      }
      fileId = file.id;
    }
    const [after] = await tx.update(schema.technician).set({ photoFileId: fileId, updatedAt: new Date() })
      .where(eq(schema.technician.id, input.id)).returning();
    await audit(tx, ctx, fileId ? "technician.photo_set" : "technician.photo_cleared", "technician", input.id,
      { photoFileId: before.photoFileId }, { photoFileId: fileId });
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
  listTechnicians: (ctx: ServiceContext) => technicians(ctx),
  updateTechnician: (ctx: ServiceContext, input: {
    id: string; skills?: string[] | undefined; homeLocationId?: string | null | undefined; color?: string | null | undefined;
    workday?: { startsAt: string; endsAt: string } | null | undefined; shareLocation?: boolean | undefined;
  }) => updateTechnician(ctx, input),
  setTechnicianPhoto: (ctx: ServiceContext, input: { id: string; bytes: string | null }) => setTechnicianPhoto(ctx, input),
  getWorkdaySettings: (ctx: ServiceContext) => workdaySettings(ctx),
  setWorkdaySettings: (ctx: ServiceContext, input: {
    dayEndsAt?: string | undefined; lunchMinutes?: number | undefined; lunchEarliest?: string | undefined;
    lunchLatest?: string | undefined; maxOvertimeMinutes?: number | undefined;
  }) => setWorkdaySettings(ctx, {
    ...(input.dayEndsAt !== undefined ? { dayEndsAt: input.dayEndsAt } : {}),
    ...(input.lunchMinutes !== undefined ? { lunchMinutes: input.lunchMinutes } : {}),
    ...(input.lunchEarliest !== undefined ? { lunchEarliest: input.lunchEarliest } : {}),
    ...(input.lunchLatest !== undefined ? { lunchLatest: input.lunchLatest } : {}),
    ...(input.maxOvertimeMinutes !== undefined ? { maxOvertimeMinutes: input.maxOvertimeMinutes } : {}),
  }),
  getRebalance: (ctx: ServiceContext, input: { date: string }) => rebalance(ctx, input),
  applyRebalance: (ctx: ServiceContext, input: {
    date: string; basis: string; moves: { visitId: string; technicianId: string }[];
    orders: { technicianId: string; visitIds: string[] }[];
  }) => applyRebalance(ctx, input),
  lockVisit: (ctx: ServiceContext, input: { id: string; locked: boolean }) => lockVisit(ctx, input),
} as const;
