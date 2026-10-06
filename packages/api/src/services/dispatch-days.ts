import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, geo, recurrence, routing, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as dm from "./dispatch-map";
import { crews as scopedCrews } from "./people-scope";
import * as dispatch from "./dispatch";
import * as crews from "./crews";
import { crewRefusals } from "./crews";
import { onlineCeilings } from "./booking";
import { announce, sideOf } from "./visit-notices";
import { officeMoved } from "./visit-changes";
import { remember, replayed } from "./once";
import { roomOutsideHold } from "./booking";
import { closedDates } from "./holidays";

/**
 * SEVERAL DAYS, REBALANCED: WORK MOVED TO ANOTHER DAY
 *
 * "Rebalance the day" plans one day across everybody and cannot take a
 * visit off it. This proposes the next few days together and may move a
 * visit to another of them, but only a visit whose customer agreed to it:
 * a range of days set on the visit, or the window of the agreement visit it
 * delivers ("a tune up in the first half of May"), or the days of the week
 * the customer said suit them. Never onto today and never off it, because a
 * customer expecting somebody this afternoon has not agreed to Thursday,
 * and never onto a day the company is closed: a weekday its hours keep
 * closed, or a date its holiday list does. Core decides
 * (`routing.rebalanceDays`), with the same constraints the single day
 * planner keeps.
 *
 * SHOWN AS EACH DAY BEFORE AND AFTER, and applied by a person: the visits
 * moved to another day go there through the same assignment a drag uses,
 * so skills and time off are checked again on the new day, and each
 * customer is told through the same path an answer to their own request to
 * move uses (`visitChanges.officeMoved`). In one transaction, refused when
 * any day of the range has changed since the proposal was made.
 */

const MOVABLE = new Set(["unassigned", "scheduled", "dispatched"]);
const MIN_DAYS = 2;
const MAX_DAYS = 7;

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** The days, besides its own, a visit may be moved to, and on what grounds. */
export function daysFor(
  v: dm.DayVisit,
  own: string,
  range: readonly string[],
  context: { today: string; open: ReadonlySet<number> | null; closed?: ReadonlySet<string> | undefined },
): { dates: string[]; because: "range" | "weekdays" | null } {
  if (v.locked || !MOVABLE.has(v.status) || own <= context.today) return { dates: [], because: null };
  const candidates = range.filter((d) => d !== own && d > context.today
    && (context.open === null || context.open.has(weekday(d)))
    && !context.closed?.has(d));
  const suits = (d: string) => v.preferredDays.length === 0 || v.preferredDays.includes(weekday(d));
  if (v.movable) {
    const { from, until } = v.movable;
    return {
      dates: candidates.filter((d) => (from === null || d >= from) && (until === null || d <= until) && suits(d)),
      because: "range",
    };
  }
  if (v.preferredDays.length > 0) return { dates: candidates.filter(suits), because: "weekdays" };
  return { dates: [], because: null };
}

/** The visit's window moved to another day, at the same wall clock times. */
function windowOn(v: dm.DayVisit, from: dm.Day, date: string, zone: string): { start: Date; end: Date | null } {
  const minutes = dm.minutesFrom(from.origin, v.windowStart!);
  const start = time.instantOfLocal(date, minutes, zone);
  const end = v.windowEnd ? new Date(start.getTime() + (v.windowEnd.getTime() - v.windowStart!.getTime())) : null;
  return { start, end };
}

function rangeOf(from: string, days: number): string[] {
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    throw new ConflictError(`Rebalance between ${MIN_DAYS} and ${MAX_DAYS} days at once.`);
  }
  return Array.from({ length: days }, (_, i) => recurrence.addDays(from, i));
}

/** The weekdays the company is open, or null when it has declared no hours at all. */
async function openDaysOf(tx: Database): Promise<Set<number> | null> {
  const hours = await tx.select().from(schema.businessHours);
  if (hours.length === 0) return null;
  return new Set(hours.filter((h) => h.opensAt !== null && h.closesAt !== null && !h.closed).map((h) => h.dayOfWeek));
}

const basisOfDays = (days: dm.Day[]) =>
  createHash("sha256").update(days.map((d) => `${d.date}:${dm.basisOf(d)}`).join("|")).digest("hex").slice(0, 32);

async function loadRange(tx: Database, ctx: ServiceContext, dates: string[]) {
  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  const days: dm.Day[] = [];
  for (const date of dates) days.push(await dm.loadDay(tx, ctx.actor.organizationId, date, dm.dayScopeOf(ctx)));
  return {
    zone, days, today: time.dateIn(new Date(), zone), open: await openDaysOf(tx),
    closed: dates.length === 0 ? new Set<string>()
      : await closedDates(tx, ctx.actor.organizationId, dates[0]!, dates[dates.length - 1]!),
  };
}

/* ------------------------------------------------------------------ crews */

/**
 * A crew, planned across the days like a person. Its key in the planner is
 * `crew:` and its id, so one plan holds people and crews and a visit can
 * never be handed between the two: crew work is offered only to crews and
 * one person's work only to people. Handing a crew's visit to a person is
 * a drag on the board, where somebody decides it.
 */
interface PlannedCrew {
  id: string;
  name: string;
  color: string | null;
  start: dm.Place | null;
}

const CREW = "crew:";
const crewKey = (id: string) => `${CREW}${id}`;
const holderOf = (key: string): { technicianId: string | null; crewId: string | null } =>
  key.startsWith(CREW) ? { technicianId: null, crewId: key.slice(CREW.length) } : { technicianId: key, crewId: null };

/** A crew's visit the planner may move: on the map, nobody on it by name, and not started. */
export function crewPlannable(v: dm.DayVisit): boolean {
  return v.crewId !== null
    && v.place !== null
    && v.truckWork === "none"
    && v.technicianIds.length === 0
    && !(dm.NOT_STOPS as readonly string[]).includes(v.status)
    && !(dm.UNDER_WAY as readonly string[]).includes(v.status)
    && !(dm.FINISHED as readonly string[]).includes(v.status)
    && v.status !== "no_show";
}

/**
 * The crews a multi day plan considers: every active crew with work in the
 * range, and every active crew with somebody on it this person's board
 * shows, so a branch manager plans their own branch's crews. A crew's day
 * starts where it is based, or where its lead's does, or the company's
 * first location, as the map draws it.
 */
async function crewsOver(tx: Database, ctx: ServiceContext, days: dm.Day[]): Promise<PlannedCrew[]> {
  const organizationId = ctx.actor.organizationId;
  /**
   * Only this person's own crews are planned: another branch's crew on one
   * of this branch's visits keeps that visit and is offered no more
   * (`people-scope.ts`).
   */
  const crews = await tx.select().from(schema.crew)
    .where(and(eq(schema.crew.organizationId, organizationId), eq(schema.crew.active, true), scopedCrews(ctx)))
    .orderBy(asc(schema.crew.name));
  if (crews.length === 0) return [];
  const members = await tx.select({
    crewId: schema.crewMember.crewId, technicianId: schema.crewMember.technicianId, isLead: schema.crewMember.isLead,
    home: schema.technician.homeLocationId,
  }).from(schema.crewMember)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.crewMember.technicianId))
    .where(inArray(schema.crewMember.crewId, crews.map((c) => c.id)));
  const locations = await tx.select().from(schema.location)
    .where(and(eq(schema.location.organizationId, organizationId), eq(schema.location.active, true)))
    .orderBy(asc(schema.location.createdAt), asc(schema.location.id));
  const placeOfLocation = (id: string | null): dm.Place | null => {
    const row = (id ? locations.find((l) => l.id === id) : undefined) ?? locations[0];
    const at = row ? geo.parseLatLng(row.latitude, row.longitude) : null;
    return at && row ? { ...at, precision: row.locationPrecision, source: row.locationSource } : null;
  };
  const seen = new Set(days.flatMap((d) => d.technicians.map((t) => t.id)));
  const working = new Set(days.flatMap((d) => d.visits.map((v) => v.crewId).filter((id): id is string => id !== null)));
  return crews
    .filter((c) => working.has(c.id) || members.some((m) => m.crewId === c.id && seen.has(m.technicianId)))
    .filter((c) => members.some((m) => m.crewId === c.id))
    .map((c) => {
      const lead = members.find((m) => m.crewId === c.id && m.isLead);
      return { id: c.id, name: c.name, color: c.color, start: placeOfLocation(c.homeLocationId ?? lead?.home ?? null) };
    });
}

/**
 * A crew's day as the planner plans it, the way `dm.rebalanceTechnicians`
 * plans a person's: work under way or finished first and not planned, the
 * company's working day and lunch around the rest.
 */
function crewDay(day: dm.Day, crew: PlannedCrew, points: dm.Points, prefix: string) {
  const stops = day.visits.filter((v) => v.crewId === crew.id && !(dm.NOT_STOPS as readonly string[]).includes(v.status));
  const locked = stops.filter((v) =>
    (dm.UNDER_WAY as readonly string[]).includes(v.status) || (dm.FINISHED as readonly string[]).includes(v.status));
  const lastLocked = [...locked].reverse().find((v) => v.place !== null);
  let departAt = dm.departureOf(day);
  if (lastLocked && (dm.UNDER_WAY as readonly string[]).includes(lastLocked.status)) {
    departAt = Math.max(departAt, dm.minutesFrom(day.origin, lastLocked.arrivedAt ?? new Date()) + lastLocked.estimatedDurationMinutes);
  }
  const key = crewKey(crew.id);
  points.set(`start:${prefix}${key}`, lastLocked ? { place: lastLocked.place, routeId: lastLocked.routeId } : { place: crew.start, routeId: null });
  points.set(`end:${prefix}${key}`, { place: crew.start ?? lastLocked?.place ?? null, routeId: null });
  const lunch = day.workday.lunchMinutes > 0
    ? { minutes: day.workday.lunchMinutes, earliest: dm.atLocal(day, day.workday.lunchEarliest), latest: dm.atLocal(day, day.workday.lunchLatest) }
    : null;
  const tech: routing.RebalanceTechnician = {
    technicianId: key,
    start: `start:${prefix}${key}`,
    end: `end:${prefix}${key}`,
    departAt,
    shift: {
      endsAt: dm.atLocal(day, day.workday.dayEndsAt),
      maxOvertimeMinutes: day.workday.maxOvertimeMinutes,
      lunch: lunch && departAt <= lunch.latest ? lunch : null,
    },
    order: stops.filter(crewPlannable).map((v) => v.id),
  };
  return { tech, keep: locked.map((v) => v.id), stops };
}

/** Whether the planner may move this visit at all: one person's plannable work, or a planned crew's. */
const movableOn = (day: dm.Day, v: dm.DayVisit, crews: ReadonlySet<string>) =>
  v.crewId === null ? dm.plannable(day, v) : crewPlannable(v) && crews.has(v.crewId);

export async function rebalanceDays(ctx: ServiceContext, input: { from: string; days: number }) {
  /** The permission before the range, so somebody who may not read the schedule hears that first. */
  assertCan(ctx.actor, "visit:read");
  const dates = rangeOf(input.from, input.days);
  const loaded = await guardedRead(ctx, "visit:read", async (tx) => {
    const range = await loadRange(tx, ctx, dates);
    const crews = await crewsOver(tx, ctx, range.days);
    const crewIds = new Set(crews.filter((c) => c.start !== null).map((c) => c.id));
    /** Asked once over every visit any day might take, per day, because skills lapse and time off is by day. */
    const everything = range.days.flatMap((d) => d.visits.filter((v) => dm.plannable(d, v)));
    const verdicts = new Map<string, Awaited<ReturnType<typeof dm.verdictsFor>>>();
    const members = new Map<string, Map<string, string>>();
    for (const day of range.days) {
      verdicts.set(day.date, await dm.verdictsFor(tx, ctx.actor.organizationId, day, everything));
      members.set(day.date, await dm.membersOn(tx, day, day.visits.filter((v) =>
        movableOn(day, v, crewIds) && v.technicianIds.length === 0 && v.crewId === null)));
    }
    /** Each crew visit asked about on its own day and every day it may go to, the check a drag onto a crew makes. */
    const asks = range.days.flatMap((d) => d.visits.filter((v) => v.crewId !== null && movableOn(d, v, crewIds))
      .flatMap((v) => [d.date, ...daysFor(v, d.date, dates, { today: range.today, open: range.open, closed: range.closed }).dates]
        .map((date) => ({ jobId: v.jobId, date }))));
    const crewRefusal = await crewRefusals(tx, ctx.actor.organizationId, { crewIds: [...crewIds], asks });
    const ceilingOf = await onlineCeilings(tx, {
      organizationId: ctx.actor.organizationId, timezone: range.zone, from: dates[0]!, until: dates[dates.length - 1]!,
    });
    return { ...range, verdicts, members, crews, crewIds, crewRefusal, ceilingOf };
  });
  const { zone, days, today, open, closed, crews, crewIds } = loaded;
  const dayOf = new Map(days.map((d) => [d.date, d]));
  const planned = crews.filter((c) => crewIds.has(c.id));

  const points: dm.Points = new Map();
  const plans = days.map((day) => {
    const leftOut = dm.leftOutOf(day);
    const people = dm.plannedOf(day).filter((t) => !leftOut.some((l) => l.technicianId === t.id));
    const { techs, keepFirst } = dm.rebalanceTechnicians(day, people, points, `${day.date}:`);
    const crewDays = planned.map((c) => ({ crew: c, ...crewDay(day, c, points, `${day.date}:`) }));
    const candidates = day.visits.filter((v) => v.crewId === null
      ? dm.plannable(day, v)
        && (v.technicianIds.length === 0 ? v.status === "unassigned" : people.some((t) => t.id === v.technicianIds[0]))
      : movableOn(day, v, crewIds));
    const crewsLeftOut = crews.filter((c) => !crewIds.has(c.id) && day.visits.some((v) => v.crewId === c.id))
      .map((c) => ({ crewId: c.id, name: c.name, reason: `Where ${c.name} is based is not on the map, so its work stays where it is.` }));
    return { day, leftOut, crewsLeftOut, people, techs: [...techs, ...crewDays.map((c) => c.tech)], keepFirst, crewDays, candidates };
  });
  const planOf = new Map(plans.map((p) => [p.day.date, p]));

  /** People for one person's work, crews for a crew's: never one for the other. */
  const refusalsOn = (date: string, v: dm.DayVisit) => {
    const plan = planOf.get(date)!;
    if (v.crewId !== null) {
      return Object.fromEntries(planned.map((c) => [crewKey(c.id), loaded.crewRefusal(c.id, v.jobId, date)]));
    }
    const verdictOf = loaded.verdicts.get(date)!;
    return Object.fromEntries(plan.people.map((t) => [t.id, dm.refusalFor(plan.day, t, v, verdictOf)]));
  };

  const grounds = new Map<string, "range" | "weekdays">();
  const visits: routing.DaysVisit[] = [];
  const byId = new Map<string, { visit: dm.DayVisit; date: string }>();
  for (const plan of plans) {
    for (const v of plan.candidates) {
      points.set(v.id, { place: v.place, routeId: v.routeId });
      byId.set(v.id, { visit: v, date: plan.day.date });
      const may = daysFor(v, plan.day.date, dates, { today, open, closed });
      if (may.because && may.dates.length > 0) grounds.set(v.id, may.because);
      visits.push({
        id: v.id,
        date: plan.day.date,
        locked: v.locked,
        priority: loaded.members.get(plan.day.date)!.has(v.id),
        options: [
          { date: plan.day.date, stop: dm.stopOf(plan.day, v), refusals: refusalsOn(plan.day.date, v) },
          ...may.dates.map((date) => {
            const other = dayOf.get(date)!;
            const moved = windowOn(v, plan.day, date, zone);
            /** Online booking's per window ceiling on the new day, when the work is sold online. */
            const ceiling = loaded.ceilingOf(v.jobTypeId, moved.start);
            return {
              date,
              stop: {
                id: v.id,
                serviceMinutes: v.estimatedDurationMinutes,
                windowStart: dm.minutesFrom(other.origin, moved.start),
                windowEnd: moved.end ? dm.minutesFrom(other.origin, moved.end) : null,
              },
              refusals: refusalsOn(date, v),
              ...(ceiling ? { ceiling } : {}),
            };
          }),
        ],
      });
    }
  }

  /**
   * THE SHARE HELD FOR MEMBERS, kept on the days work moves to. A visit for
   * somebody no plan lets into the hold may move into a window on another
   * day only while that window has room outside the hold, as online booking
   * would have offered it; the planner counts each one it moves in.
   */
  const asks = visits.flatMap((v) => v.options.slice(1).map((option) => {
    const own = byId.get(v.id)!.visit;
    const moved = windowOn(own, planOf.get(byId.get(v.id)!.date)!.day, option.date, zone);
    return {
      ref: `${v.id}|${option.date}`, customerId: own.customerId, propertyId: own.propertyId,
      jobTypeId: own.jobTypeId, durationMinutes: own.estimatedDurationMinutes, windowStart: moved.start,
    };
  }));
  const rooms = await guardedRead(ctx, "visit:read", (tx) =>
    roomOutsideHold(tx, { organizationId: ctx.actor.organizationId, timezone: zone, asks }));
  for (const v of visits) {
    for (const option of v.options.slice(1)) {
      const held = rooms.get(`${v.id}|${option.date}`);
      if (held) option.held = held;
    }
  }

  /** One map of drive times for the whole range: a house is as far from the yard on Thursday as on Tuesday. */
  const first = days[0]!;
  const routeMinutes = new Map(days.flatMap((d) => [...d.routeMinutes]));
  const { travel, matrix } = await dm.travelOver(ctx, { ...first, routeMinutes }, points);
  const result = routing.rebalanceDays({
    days: plans.map((p) => ({ date: p.day.date, technicians: p.techs, travel })),
    visits,
  });

  const nameOf = new Map<string, string>([
    ...days.flatMap((d) => d.technicians.map((t) => [t.id, t.displayName] as const)),
    ...crews.map((c) => [crewKey(c.id), c.name] as const),
  ]);
  const customer = (id: string) => byId.get(id)?.visit.customerName ?? "A visit";
  const movedAway = new Set(result.dayMoves.map((m) => m.visitId));
  const dayMoveIds = new Set(result.dayMoves.map((m) => m.visitId));

  const why = (u: routing.Unplaced): string => {
    if (u.why === "locked") return "Locked with nobody on it, so it is left for the office.";
    if (u.why === "nobody_may") return u.refusals[0] ?? "Nobody may take it on any day it may go to.";
    const n = u.nearest!;
    const parts = [
      ...n.late.map((l) => l.id === u.visitId
        ? `arrive ${l.lateBy} minutes after its window closes`
        : `make ${customer(l.id)} ${l.lateBy} minutes late`),
      ...(n.overLimitMinutes > 0 ? [`run ${n.overLimitMinutes} minutes past the overtime allowed`] : []),
      ...(n.lunchLateBy > 0 ? [`push lunch ${n.lunchLateBy} minutes past its latest start`] : []),
    ];
    return `Even on ${nameOf.get(n.technicianId) ?? "anybody"}'s day, the best place for it, it would ${parts.join(" and ") || "break a promise"}.`;
  };

  const outcomes = result.days.map((outcome) => {
    const plan = planOf.get(outcome.date)!;
    const before = new Map(outcome.before.map((d) => [d.technicianId, d]));
    const after = new Map(outcome.after.map((d) => [d.technicianId, d]));
    const changedOrder = (key: string) => after.get(key)!.evaluation.order.join() !== before.get(key)!.evaluation.order.join();
    const orders = plan.techs
      .filter((t) => !t.technicianId.startsWith(CREW) && changedOrder(t.technicianId))
      .map((t) => {
        const kept = plan.keepFirst.get(t.technicianId)!;
        const placed = new Set(after.get(t.technicianId)!.evaluation.order);
        const others = dm.routeOf(plan.day, t.technicianId)
          .filter((v) => !kept.includes(v.id) && !placed.has(v.id) && !movedAway.has(v.id)
            && !before.get(t.technicianId)!.evaluation.order.includes(v.id))
          .map((v) => v.id);
        return { date: outcome.date, technicianId: t.technicianId, visitIds: [...kept, ...after.get(t.technicianId)!.evaluation.order, ...others] };
      })
      .filter((o) => o.visitIds.length > 0);
    /** A crew's day in its new order: its work under way first, then the plan, then anything the plan left where it was. */
    const crewOrders = plan.crewDays
      .filter((c) => changedOrder(c.tech.technicianId))
      .map((c) => {
        const placed = new Set(after.get(c.tech.technicianId)!.evaluation.order);
        const others = c.stops.filter((v) => !c.keep.includes(v.id) && !placed.has(v.id) && !movedAway.has(v.id)
          && !before.get(c.tech.technicianId)!.evaluation.order.includes(v.id)).map((v) => v.id);
        return { date: outcome.date, crewId: c.crew.id, visitIds: [...c.keep, ...after.get(c.tech.technicianId)!.evaluation.order, ...others] };
      })
      .filter((o) => o.visitIds.length > 0);
    return {
      date: outcome.date,
      visitsBefore: outcome.visitsBefore,
      visitsAfter: outcome.visitsAfter,
      driveBeforeMinutes: outcome.driveBefore,
      driveAfterMinutes: outcome.driveAfter,
      overtimeBeforeMinutes: outcome.overtimeBefore,
      overtimeAfterMinutes: outcome.overtimeAfter,
      technicians: plan.people.map((t) => ({
        technicianId: t.id,
        displayName: t.displayName,
        color: t.color,
        timeOff: t.timeOff,
        before: dm.rebalanceSummary(plan.day, before.get(t.id)!),
        after: dm.rebalanceSummary(plan.day, after.get(t.id)!),
      })),
      crews: plan.crewDays.map((c) => ({
        crewId: c.crew.id,
        name: c.crew.name,
        color: c.crew.color,
        before: dm.rebalanceSummary(plan.day, before.get(c.tech.technicianId)!),
        after: dm.rebalanceSummary(plan.day, after.get(c.tech.technicianId)!),
      })),
      unplaced: outcome.unplaced.map((u) => ({ visitId: u.visitId, customerName: customer(u.visitId), reason: why(u) })),
      leftOut: plan.leftOut,
      crewsLeftOut: plan.crewsLeftOut,
      orders,
      crewOrders,
    };
  });

  const named = (key: string | null) => key ? nameOf.get(key) ?? null : null;
  return {
    from: input.from,
    days: input.days,
    basis: basisOfDays(days),
    changed: result.changed,
    /** Visits that may go to another day at all, and why. */
    movable: [...grounds.entries()].map(([visitId, because]) => ({ visitId, customerName: customer(visitId), because })),
    dayMoves: result.dayMoves.map((m) => {
      const { visit, date } = byId.get(m.visitId)!;
      const moved = windowOn(visit, dayOf.get(date)!, m.toDate, zone);
      const from = m.fromTechnicianId ? holderOf(m.fromTechnicianId) : { technicianId: null, crewId: null };
      const to = holderOf(m.toTechnicianId);
      return {
        visitId: m.visitId,
        customerName: visit.customerName,
        fromDate: m.fromDate,
        toDate: m.toDate,
        fromTechnicianId: from.technicianId,
        fromCrewId: from.crewId,
        fromName: named(m.fromTechnicianId),
        toTechnicianId: to.technicianId,
        toCrewId: to.crewId,
        toName: named(m.toTechnicianId) ?? "",
        windowStart: moved.start.toISOString(),
        windowEnd: moved.end?.toISOString() ?? null,
        because: grounds.get(m.visitId) ?? "range",
      };
    }),
    /** Visits that stay on their day with somebody else. */
    moves: result.moves.filter((m) => !dayMoveIds.has(m.visitId)).map((m) => {
      const from = m.from ? holderOf(m.from) : { technicianId: null, crewId: null };
      const to = holderOf(m.to);
      return {
        visitId: m.visitId,
        customerName: customer(m.visitId),
        date: m.fromDate,
        fromTechnicianId: from.technicianId,
        fromCrewId: from.crewId,
        fromName: named(m.from),
        toTechnicianId: to.technicianId,
        toCrewId: to.crewId,
        toName: named(m.to) ?? "",
      };
    }),
    perDay: outcomes.map(({ orders: _orders, crewOrders: _crewOrders, ...rest }) => rest),
    visits: [...byId.values()].map(({ visit, date }) => ({
      visitId: visit.id, customerName: visit.customerName, date, locked: visit.locked,
      windowStart: dm.iso(visit.windowStart), windowEnd: dm.iso(visit.windowEnd),
    })),
    driveBeforeMinutes: result.driveBefore,
    driveAfterMinutes: result.driveAfter,
    overtimeBeforeMinutes: result.overtimeBefore,
    overtimeAfterMinutes: result.overtimeAfter,
    apply: {
      dayMoves: result.dayMoves.map((m) => ({ visitId: m.visitId, toDate: m.toDate, ...holderFor(m.toTechnicianId) })),
      moves: result.moves.filter((m) => !dayMoveIds.has(m.visitId)).map((m) => ({ visitId: m.visitId, ...holderFor(m.to) })),
      orders: outcomes.flatMap((o) => o.orders),
      crewOrders: outcomes.flatMap((o) => o.crewOrders),
    },
    workday: first.workday,
    ...dm.sourceOf(matrix),
  };
}

/** Who a planned visit goes to, as the apply call takes it: a person or a crew. */
const holderFor = (key: string): { technicianId: string } | { crewId: string } => {
  const h = holderOf(key);
  return h.crewId ? { crewId: h.crewId } : { technicianId: h.technicianId! };
};

/**
 * Apply a multi day rebalance a person looked at.
 *
 * Each visit moved to another day: its window set to the same times on the
 * new day, put on the person or crew proposed through the assignment a drag
 * uses (skills and time off checked again, on the new day, and a crew's
 * kit and people), the people on it told through the visit's notices, and
 * the customer told through the visit change path. Then each changed day's
 * order, a person's and a crew's. One transaction, so a refusal anywhere
 * leaves every day as it was. A move the visit's customer did not agree to
 * is refused even when the payload asks for it, and so is one that would
 * fill a window past what online booking sells in it, read again now.
 */
export async function applyRebalanceDays(ctx: ServiceContext, input: {
  from: string;
  days: number;
  basis: string;
  dayMoves: { visitId: string; toDate: string; technicianId?: string | undefined; crewId?: string | undefined }[];
  moves: { visitId: string; technicianId?: string | undefined; crewId?: string | undefined }[];
  orders: { date: string; technicianId: string; visitIds: string[] }[];
  crewOrders?: { date: string; crewId: string; visitIds: string[] }[] | undefined;
}) {
  assertCan(ctx.actor, "visit:dispatch");
  const dates = rangeOf(input.from, input.days);
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    assertCan(ctx.actor, "visit:reschedule");
    type Applied = { ok: true; movedDays: number; moved: number; reordered: number; told: { visitId: string; notified: string }[] };
    const prior = await replayed<Applied>(tx, ctx, "dispatch_rebalance_days");
    if (prior) return prior;

    const { zone, days, today, open, closed } = await loadRange(tx, ctx, dates);
    if (basisOfDays(days) !== input.basis) {
      throw new ConflictError("The board has changed since this was proposed. Propose it again to see the days as they are now.");
    }
    const inner: ServiceContext = { ...ctx, db: tx };
    delete inner.idempotencyKey;
    const exactlyOne = (m: { technicianId?: string | undefined; crewId?: string | undefined }) => {
      if (Boolean(m.technicianId) === Boolean(m.crewId)) throw new ConflictError("Each move goes to one person or one crew.");
    };
    const assignTo = async (visitId: string, m: { technicianId?: string | undefined; crewId?: string | undefined }) => {
      if (m.crewId) await crews.assign(inner, { id: visitId, crewId: m.crewId });
      else await dispatch.assign(inner, { id: visitId, technicianIds: [m.technicianId!] });
    };

    /** Online booking's ceiling, read now: a booking may have taken a place since the proposal. */
    const ceilingOf = await onlineCeilings(tx, {
      organizationId: ctx.actor.organizationId, timezone: zone, from: dates[0]!, until: dates[dates.length - 1]!,
    });
    const filling = new Map<string, number>();

    const told: Applied["told"] = [];
    for (const move of input.dayMoves) {
      exactlyOne(move);
      const day = days.find((d) => d.visits.some((v) => v.id === move.visitId));
      const visit = day?.visits.find((v) => v.id === move.visitId);
      if (!day || !visit || !visit.windowStart) throw new NotFoundError("Visit");
      const kindFits = visit.crewId === null ? dm.plannable(day, visit) : crewPlannable(visit);
      if (!kindFits || !daysFor(visit, day.date, dates, { today, open, closed }).dates.includes(move.toDate)) {
        throw new ConflictError(`${visit.customerName}'s visit may not be moved to ${move.toDate}: the customer has not agreed to that day.`);
      }
      const moved = windowOn(visit, day, move.toDate, zone);
      const ceiling = ceilingOf(visit.jobTypeId, moved.start);
      if (ceiling) {
        const n = (filling.get(ceiling.key) ?? 0) + 1;
        if (n > ceiling.remaining) {
          throw new ConflictError(`${visit.customerName}'s visit would fill that window on ${move.toDate} past what you take online. Propose it again.`);
        }
        filling.set(ceiling.key, n);
      }
      const was = { start: visit.windowStart, end: visit.windowEnd };
      const before = await sideOf(tx, visit.id);
      await tx.update(schema.visit).set({ windowStart: moved.start, windowEnd: moved.end, routeOrder: null, updatedAt: new Date() })
        .where(eq(schema.visit.id, visit.id));
      await assignTo(visit.id, move);
      /**
       * The assignment told anybody added or taken off. Somebody who keeps
       * it hears that it moved, which the assignment cannot see: by the
       * time it read the visit, the new day was already written.
       */
      const kept = move.crewId
        ? visit.crewId === move.crewId
        : before !== null && before.technicianIds.length === 1 && before.technicianIds[0] === move.technicianId;
      if (before && kept) await announce(tx, inner, visit.id, before);
      told.push({ visitId: visit.id, notified: await officeMoved(tx, inner, { visitId: visit.id, was }) });
    }

    for (const move of input.moves) {
      exactlyOne(move);
      const visit = days.flatMap((d) => d.visits).find((v) => v.id === move.visitId);
      if (!visit) throw new NotFoundError("Visit");
      if (visit.locked) throw new ConflictError(`${visit.customerName}'s visit is locked, so it is not moved.`);
      await assignTo(move.visitId, move);
    }
    for (const order of input.orders) {
      if (order.visitIds.length === 0 || !dates.includes(order.date)) continue;
      await dispatch.reorder(inner, { technicianId: order.technicianId, date: order.date, visitIds: order.visitIds });
    }
    /** A crew's order is its visits' route order on the day, set in one go like a person's. */
    for (const order of input.crewOrders ?? []) {
      if (order.visitIds.length === 0 || !dates.includes(order.date)) continue;
      const { start, end } = time.dayBoundsIn(order.date, zone);
      const theirs = await tx.select({ id: schema.visit.id }).from(schema.visit)
        .where(and(eq(schema.visit.crewId, order.crewId), gte(schema.visit.windowStart, start), lte(schema.visit.windowStart, end)));
      const ids = new Set(theirs.map((t) => t.id));
      if (order.visitIds.some((id) => !ids.has(id))) {
        throw new ConflictError("Some of those visits are not on that crew's day.");
      }
      for (const [index, visitId] of order.visitIds.entries()) {
        await tx.update(schema.visit).set({ routeOrder: index + 1, updatedAt: new Date() }).where(eq(schema.visit.id, visitId));
      }
    }

    const answer: Applied = {
      ok: true, movedDays: input.dayMoves.length, moved: input.moves.length,
      reordered: input.orders.length + (input.crewOrders?.length ?? 0), told,
    };
    await audit(tx, ctx, "dispatch.rebalanced_days", "organization", ctx.actor.organizationId, { basis: input.basis },
      { from: input.from, days: input.days, dayMoves: input.dayMoves, moves: input.moves });
    await remember(tx, ctx, "dispatch_rebalance_days", null, answer);
    return answer;
  });
}

/* -------------------------------------------- what the customer agreed to */

/**
 * The days a visit may happen on, as the customer agreed them, or cleared.
 * Read by the multi day rebalance and nothing else: setting it moves
 * nothing by itself.
 */
export async function setVisitMovable(ctx: ServiceContext, input: { id: string; from: string | null; until: string | null }) {
  return guardedWrite(ctx, "visit:reschedule", async (tx) => {
    const [before] = await tx.select({ from: schema.visit.movableFrom, until: schema.visit.movableUntil })
      .from(schema.visit)
      .where(and(eq(schema.visit.id, input.id), eq(schema.visit.organizationId, ctx.actor.organizationId))).limit(1);
    if (!before) throw new NotFoundError("Visit");
    if (input.from && input.until && input.until < input.from) {
      throw new ConflictError("The last day it may move to has to be on or after the first.");
    }
    await tx.update(schema.visit).set({ movableFrom: input.from, movableUntil: input.until, updatedAt: new Date() })
      .where(eq(schema.visit.id, input.id));
    await audit(tx, ctx, "visit.movable_set", "visit", input.id, before, { from: input.from, until: input.until });
    return { id: input.id, movableFrom: input.from, movableUntil: input.until };
  });
}

/** The days of the week that suit a customer, 0 for Sunday. An empty list is any day. */
export async function setPreferredDays(ctx: ServiceContext, input: { id: string; days: number[] }) {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const [before] = await tx.select({ days: schema.customer.preferredDays }).from(schema.customer)
      .where(and(eq(schema.customer.id, input.id), eq(schema.customer.organizationId, ctx.actor.organizationId))).limit(1);
    if (!before) throw new NotFoundError("Customer");
    if (input.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new ConflictError("A day of the week is 0 for Sunday through 6 for Saturday.");
    }
    const days = [...new Set(input.days)].sort((a, b) => a - b);
    await tx.update(schema.customer).set({ preferredDays: days, updatedAt: new Date() }).where(eq(schema.customer.id, input.id));
    await audit(tx, ctx, "customer.preferred_days_set", "customer", input.id, { days: before.days }, { days });
    return { id: input.id, preferredDays: days };
  });
}

/** What a customer and their visits have agreed to, for the screens that set it. */
export async function preferredDays(ctx: ServiceContext, input: { id: string }): Promise<number[]> {
  return guardedRead(ctx, "customer:read", async (tx) => {
    const [row] = await tx.select({ days: schema.customer.preferredDays }).from(schema.customer)
      .where(eq(schema.customer.id, input.id)).limit(1);
    if (!row) throw new NotFoundError("Customer");
    return row.days ?? [];
  });
}

export const handlers = {
  getMultiDayRebalance: (ctx: ServiceContext, input: { from: string; days: number }) => rebalanceDays(ctx, input),
  applyMultiDayRebalance: (ctx: ServiceContext, input: {
    from: string; days: number; basis: string;
    dayMoves: { visitId: string; toDate: string; technicianId?: string | undefined; crewId?: string | undefined }[];
    moves: { visitId: string; technicianId?: string | undefined; crewId?: string | undefined }[];
    orders: { date: string; technicianId: string; visitIds: string[] }[];
    crewOrders?: { date: string; crewId: string; visitIds: string[] }[] | undefined;
  }) => applyRebalanceDays(ctx, input),
  setVisitMovable: (ctx: ServiceContext, input: { id: string; from: string | null; until: string | null }) =>
    setVisitMovable(ctx, input),
  setCustomerPreferredDays: (ctx: ServiceContext, input: { id: string; days: number[] }) => setPreferredDays(ctx, input),
} as const;
