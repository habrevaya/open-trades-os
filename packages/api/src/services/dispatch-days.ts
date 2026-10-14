import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, holidays as holidayRules, recurrence, routing, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as dm from "./dispatch-map";
import * as dispatch from "./dispatch";
import * as crews from "./crews";
import { crewRefusals } from "./crews";
import { onlineCeilings } from "./booking";
import { announce, sideOf } from "./visit-notices";
import { officeMoved } from "./visit-changes";
import { remember, replayed } from "./once";
import { roomOutsideHold } from "./booking";
import { closedDates } from "./holidays";
import { weeksByBranch } from "./business-hours";

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
 * and never onto a day the visit's branch is closed: a weekday its week (or
 * the company's, where it keeps none) keeps closed, or a date its holiday
 * list does. Core decides
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

/**
 * The hours a visit would have on a date: its own window where it is, and the
 * same times of day where it would go. Null for a visit with no window to move,
 * which is then held to the careful reading of any leave that day.
 */
function visitHoursOn(v: dm.DayVisit, from: dm.Day, date: string, zone: string): { start: Date; end: Date } | null {
  if (!v.windowStart) return null;
  const moved = date === from.date ? { start: v.windowStart, end: v.windowEnd } : windowOn(v, from, date, zone);
  return time.visitSpan(moved.start, moved.end, v.estimatedDurationMinutes);
}

function rangeOf(from: string, days: number): string[] {
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    throw new ConflictError(`Rebalance between ${MIN_DAYS} and ${MAX_DAYS} days at once.`);
  }
  return Array.from({ length: days }, (_, i) => recurrence.addDays(from, i));
}

const basisOfDays = (days: dm.Day[]) =>
  createHash("sha256").update(days.map((d) => `${d.date}:${dm.basisOf(d)}`).join("|")).digest("hex").slice(0, 32);

async function loadRange(tx: Database, ctx: ServiceContext, dates: string[]) {
  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  const days: dm.Day[] = [];
  for (const date of dates) days.push(await dm.loadDay(tx, ctx.actor.organizationId, date, dm.dayScopeOf(ctx)));
  /**
   * The dates each branch is shut: the company's holidays and the branch's
   * own, so a visit in Houston is not moved onto Houston's day off and an
   * Austin visit still may be.
   */
  const branches = [...new Set([null, ...days.flatMap((d) => d.visits.map((v) => v.branchId))])];
  const closedBy = new Map<string | null, Set<string>>();
  for (const branchId of branches) {
    closedBy.set(branchId, dates.length === 0 ? new Set<string>()
      : await closedDates(tx, ctx.actor.organizationId, dates[0]!, dates[dates.length - 1]!, branchId));
  }
  /**
   * And the weekdays each branch opens: its own week, or the company's where
   * it keeps none, so a Houston visit may go to Houston's Saturday and an
   * Austin one, whose branch is shut on Saturdays, may not. Null where no
   * week is declared at all, which closes no weekday.
   */
  const weekOf = await weeksByBranch(tx, ctx.actor.organizationId);
  return {
    zone, days, today: time.dateIn(new Date(), zone),
    openOf: (v: dm.DayVisit): ReadonlySet<number> | null => holidayRules.openWeekdays(weekOf(v.branchId).week),
    closedOf: (v: dm.DayVisit): ReadonlySet<string> => closedBy.get(v.branchId) ?? closedBy.get(null)!,
  };
}

/** Whether the planner may move this visit at all: one person's plannable work, or a planned crew's. */
const movableOn = (day: dm.Day, v: dm.DayVisit, crews: ReadonlySet<string>) =>
  v.crewId === null ? dm.plannable(day, v) : dm.crewPlannable(v) && crews.has(v.crewId);

/**
 * A visit with several people on it, as the planner sees it: every one of
 * them planned on its day. It is counted on each of their days and moves
 * only with all of them, to a day every one of them can take.
 */
const isTeam = (v: dm.DayVisit) => v.crewId === null && v.technicianIds.length > 1;

/** Several names in one phrase: "Ray", "Ray and Dana", "Ray, Dana and Lee". */
const together = (names: string[]) =>
  names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export async function rebalanceDays(ctx: ServiceContext, input: { from: string; days: number }) {
  /** The permission before the range, so somebody who may not read the schedule hears that first. */
  assertCan(ctx.actor, "visit:read");
  const dates = rangeOf(input.from, input.days);
  const loaded = await guardedRead(ctx, "visit:read", async (tx) => {
    const range = await loadRange(tx, ctx, dates);
    const crews = await dm.crewsOver(tx, ctx, range.days);
    const crewIds = new Set(crews.filter((c) => c.start !== null).map((c) => c.id));
    /** Asked once over every visit any day might take, per day, because skills lapse and time off is by day. */
    const everything = range.days.flatMap((d) => d.visits.filter((v) =>
      dm.plannable(d, v) || dm.teamPlannable(d, v, new Set(d.technicians.map((t) => t.id)))));
    const verdicts = new Map<string, Awaited<ReturnType<typeof dm.verdictsFor>>>();
    const members = new Map<string, Map<string, string>>();
    for (const day of range.days) {
      verdicts.set(day.date, await dm.verdictsFor(tx, ctx.actor.organizationId, day, everything));
      members.set(day.date, await dm.membersOn(tx, day, day.visits.filter((v) =>
        movableOn(day, v, crewIds) && v.technicianIds.length === 0 && v.crewId === null)));
    }
    /** Each crew visit asked about on its own day and every day it may go to, the check a drag onto a crew makes. */
    const asks = range.days.flatMap((d) => d.visits.filter((v) => v.crewId !== null && movableOn(d, v, crewIds))
      .flatMap((v) => [d.date, ...daysFor(v, d.date, dates, { today: range.today, open: range.openOf(v), closed: range.closedOf(v) }).dates]
        /** At the hours the visit would have on that day, so a crew with part of that day off is asked about those hours. */
        .map((date) => ({ jobId: v.jobId, date, window: visitHoursOn(v, d, date, range.zone) }))));
    const crewRefusal = await crewRefusals(tx, ctx.actor.organizationId, { crewIds: [...crewIds], asks });
    const ceilingOf = await onlineCeilings(tx, {
      organizationId: ctx.actor.organizationId, timezone: range.zone, from: dates[0]!, until: dates[dates.length - 1]!,
    });
    return { ...range, verdicts, members, crews, crewIds, crewRefusal, ceilingOf };
  });
  const { zone, days, today, openOf, closedOf, crews, crewIds } = loaded;
  const dayOf = new Map(days.map((d) => [d.date, d]));
  const planned = crews.filter((c) => crewIds.has(c.id));

  const points: dm.Points = new Map();
  const plans = days.map((day) => {
    const leftOut = dm.leftOutOf(day);
    const people = dm.plannedOf(day).filter((t) => !leftOut.some((l) => l.technicianId === t.id));
    const { techs, keepFirst } = dm.rebalanceTechnicians(day, people, points, `${day.date}:`);
    const crewDays = planned.map((c) => ({ crew: c, ...dm.crewDay(day, c, points, `${day.date}:`) }));
    const peopleIds = new Set(people.map((t) => t.id));
    const candidates = day.visits.filter((v) => v.crewId === null
      ? (dm.plannable(day, v)
        && (v.technicianIds.length === 0 ? v.status === "unassigned" : peopleIds.has(v.technicianIds[0]!)))
        || dm.teamPlannable(day, v, peopleIds)
      : movableOn(day, v, crewIds));
    const crewsLeftOut = crews.filter((c) => !crewIds.has(c.id) && day.visits.some((v) => v.crewId === c.id))
      .map((c) => ({ crewId: c.id, name: c.name, reason: `Where ${c.name} is based is not on the map, so its work stays where it is.` }));
    return { day, leftOut, crewsLeftOut, people, techs: [...techs, ...crewDays.map((c) => c.tech)], keepFirst, crewDays, candidates };
  });
  const planOf = new Map(plans.map((p) => [p.day.date, p]));

  /** People for one person's work, crews for a crew's: never one for the other. */
  const refusalsOn = (date: string, v: dm.DayVisit, from: dm.Day) => {
    const plan = planOf.get(date)!;
    /** The hours it has on that day: its own where it is, the same time of day where it would go. */
    const window = visitHoursOn(v, from, date, zone);
    if (v.crewId !== null) {
      return Object.fromEntries(planned.map((c) => [dm.crewKey(c.id), loaded.crewRefusal(c.id, v.jobId, date, window)]));
    }
    const verdictOf = loaded.verdicts.get(date)!;
    return Object.fromEntries(plan.people.map((t) => [t.id, dm.refusalFor(plan.day, t, v, verdictOf, window ?? undefined)]));
  };

  const grounds = new Map<string, "range" | "weekdays">();
  const visits: routing.DaysVisit[] = [];
  const byId = new Map<string, { visit: dm.DayVisit; date: string }>();
  for (const plan of plans) {
    for (const v of plan.candidates) {
      points.set(v.id, { place: v.place, routeId: v.routeId });
      byId.set(v.id, { visit: v, date: plan.day.date });
      const may = daysFor(v, plan.day.date, dates, { today, open: openOf(v), closed: closedOf(v) });
      if (may.because && may.dates.length > 0) grounds.set(v.id, may.because);
      visits.push({
        id: v.id,
        date: plan.day.date,
        locked: v.locked,
        priority: loaded.members.get(plan.day.date)!.has(v.id),
        ...(isTeam(v) ? { team: v.technicianIds } : {}),
        options: [
          { date: plan.day.date, stop: dm.stopOf(plan.day, v), refusals: refusalsOn(plan.day.date, v, plan.day) },
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
              refusals: refusalsOn(date, v, plan.day),
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
    ...crews.map((c) => [dm.crewKey(c.id), c.name] as const),
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

  /** Every visit of the range, so a shared visit moved to another day is still known as shared there. */
  const everyVisit = days.flatMap((d) => d.visits);
  const outcomes = result.days.map((outcome) => {
    const plan = planOf.get(outcome.date)!;
    const before = new Map(outcome.before.map((d) => [d.technicianId, d]));
    const after = new Map(outcome.after.map((d) => [d.technicianId, d]));
    const changedOrder = (key: string) => after.get(key)!.evaluation.order.join() !== before.get(key)!.evaluation.order.join();
    const orders = plan.techs
      .filter((t) => !t.technicianId.startsWith(dm.CREW) && changedOrder(t.technicianId))
      .map((t) => {
        const kept = plan.keepFirst.get(t.technicianId)!;
        const placed = new Set(after.get(t.technicianId)!.evaluation.order);
        const others = dm.routeOf(plan.day, t.technicianId)
          .filter((v) => !kept.includes(v.id) && !placed.has(v.id) && !movedAway.has(v.id)
            && !before.get(t.technicianId)!.evaluation.order.includes(v.id))
          .map((v) => v.id);
        return {
          date: outcome.date, technicianId: t.technicianId,
          visitIds: dm.orderedFor(everyVisit, t.technicianId, [...kept, ...after.get(t.technicianId)!.evaluation.order, ...others]),
        };
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
        timeOffWholeDay: t.timeOffWholeDay,
        timeOffHours: t.timeOffWholeDay ? [] : t.leave.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })),
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
      const from = m.fromTechnicianId ? dm.holderOf(m.fromTechnicianId) : { technicianId: null, crewId: null };
      const to = dm.holderOf(m.toTechnicianId);
      /** A team goes with all of its people, and is named by all of them. */
      const team = m.team ? together(m.team.map((id) => nameOf.get(id) ?? "")) : null;
      return {
        visitId: m.visitId,
        customerName: visit.customerName,
        fromDate: m.fromDate,
        toDate: m.toDate,
        fromTechnicianId: from.technicianId,
        fromCrewId: from.crewId,
        fromName: team ?? named(m.fromTechnicianId),
        toTechnicianId: to.technicianId,
        toTechnicianIds: m.team ?? (to.technicianId ? [to.technicianId] : []),
        toCrewId: to.crewId,
        toName: team ?? named(m.toTechnicianId) ?? "",
        windowStart: moved.start.toISOString(),
        windowEnd: moved.end?.toISOString() ?? null,
        because: grounds.get(m.visitId) ?? "range",
      };
    }),
    /** Visits that stay on their day with somebody else. */
    moves: result.moves.filter((m) => !dayMoveIds.has(m.visitId)).map((m) => {
      const from = m.from ? dm.holderOf(m.from) : { technicianId: null, crewId: null };
      const to = dm.holderOf(m.to);
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
      /** Everybody on it, lead first, when several people are; empty otherwise. */
      team: isTeam(visit) ? visit.technicianIds : [],
    })),
    driveBeforeMinutes: result.driveBefore,
    driveAfterMinutes: result.driveAfter,
    overtimeBeforeMinutes: result.overtimeBefore,
    overtimeAfterMinutes: result.overtimeAfter,
    apply: {
      dayMoves: result.dayMoves.map((m) => ({
        visitId: m.visitId, toDate: m.toDate, ...(m.team ? { technicianIds: m.team } : dm.holderFor(m.toTechnicianId)),
      })),
      moves: result.moves.filter((m) => !dayMoveIds.has(m.visitId)).map((m) => ({ visitId: m.visitId, ...dm.holderFor(m.to) })),
      orders: outcomes.flatMap((o) => o.orders),
      crewOrders: outcomes.flatMap((o) => o.crewOrders),
    },
    workday: first.workday,
    ...dm.sourceOf(matrix),
  };
}

/** A visit moved to another day: to one person, to one crew, or with the several people already on it. */
type DayMoveInput = {
  visitId: string; toDate: string;
  technicianId?: string | undefined; technicianIds?: string[] | undefined; crewId?: string | undefined;
};

/** The people a day plans: its own, less anybody left out of it (`dm.leftOutOf`). */
const plannedIdsOf = (day: dm.Day) => {
  const out = new Set(dm.leftOutOf(day).map((l) => l.technicianId));
  return new Set(dm.plannedOf(day).filter((t) => !out.has(t.id)).map((t) => t.id));
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
  dayMoves: DayMoveInput[];
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

    const { zone, days, today, openOf, closedOf } = await loadRange(tx, ctx, dates);
    if (basisOfDays(days) !== input.basis) {
      throw new ConflictError("The board has changed since this was proposed. Propose it again to see the days as they are now.");
    }
    const inner: ServiceContext = { ...ctx, db: tx };
    delete inner.idempotencyKey;
    const exactlyOne = (m: { technicianId?: string | undefined; technicianIds?: string[] | undefined; crewId?: string | undefined }) => {
      const given = [Boolean(m.technicianId), Boolean(m.technicianIds && m.technicianIds.length > 0), Boolean(m.crewId)];
      if (given.filter(Boolean).length !== 1) {
        throw new ConflictError("Each move goes to one person or one crew, or with the people already on it.");
      }
    };
    const assignTo = async (visitId: string, m: { technicianId?: string | undefined; technicianIds?: string[] | undefined; crewId?: string | undefined }) => {
      if (m.crewId) await crews.assign(inner, { id: visitId, crewId: m.crewId });
      else if (m.technicianIds) await dispatch.assign(inner, { id: visitId, technicianIds: m.technicianIds, leadTechnicianId: m.technicianIds[0]!, skipMemberHold: true });
      else await dispatch.assign(inner, { id: visitId, technicianIds: [m.technicianId!], skipMemberHold: true });
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
      /**
       * A VISIT WITH SEVERAL PEOPLE ON IT goes with every one of them or not
       * at all: the payload names them, lead first, exactly as the visit has
       * them, because the plan never splits a team or swaps one of its people.
       */
      const team = isTeam(visit);
      if (team || move.technicianIds) {
        const same = team && move.technicianIds !== undefined
          && move.technicianIds.length === visit.technicianIds.length
          && move.technicianIds.every((id, i) => id === visit.technicianIds[i]);
        if (!same) {
          throw new ConflictError(`${visit.customerName}'s visit moves only with the people already on it, all of them together.`);
        }
      }
      const kindFits = visit.crewId !== null ? dm.crewPlannable(visit)
        : team ? dm.teamPlannable(day, visit, plannedIdsOf(day)) : dm.plannable(day, visit);
      if (!kindFits || !daysFor(visit, day.date, dates, { today, open: openOf(visit), closed: closedOf(visit) }).dates.includes(move.toDate)) {
        throw new ConflictError(`${visit.customerName}'s visit may not be moved to ${move.toDate}: the customer has not agreed to that day.`);
      }
      const moved = windowOn(visit, day, move.toDate, zone);
      /**
       * EVERY PERSON IT GOES TO, ASKED AGAIN on the new day at the hours it
       * would have there: their skills that day and any leave meeting those
       * hours. The proposal asked the same, but leave approved since then is
       * not in the basis, and an assignment checks skills and not leave.
       */
      if (visit.crewId === null) {
        const target = days.find((d) => d.date === move.toDate)!;
        const going = move.technicianIds ?? (move.technicianId ? [move.technicianId] : []);
        const planned = plannedIdsOf(target);
        const verdictOf = await dm.verdictsFor(tx, ctx.actor.organizationId, target, [visit]);
        for (const id of going) {
          const person = target.technicians.find((t) => t.id === id);
          if (!person || !planned.has(id)) {
            if (team) throw new ConflictError(`${visit.customerName}'s visit cannot go to ${move.toDate}: not everybody on it is working that day.`);
            continue;
          }
          const refusal = dm.refusalFor(target, person, visit, verdictOf, moved);
          if (refusal) throw new ConflictError(refusal);
        }
      }
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
        : move.technicianIds
          ? before !== null && before.technicianIds.length === move.technicianIds.length
            && move.technicianIds.every((id) => before.technicianIds.includes(id))
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
      await dm.setCrewOrder(tx, zone, order);
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
    dayMoves: DayMoveInput[];
    moves: { visitId: string; technicianId?: string | undefined; crewId?: string | undefined }[];
    orders: { date: string; technicianId: string; visitIds: string[] }[];
    crewOrders?: { date: string; crewId: string; visitIds: string[] }[] | undefined;
  }) => applyRebalanceDays(ctx, input),
  setVisitMovable: (ctx: ServiceContext, input: { id: string; from: string | null; until: string | null }) =>
    setVisitMovable(ctx, input),
  setCustomerPreferredDays: (ctx: ServiceContext, input: { id: string; days: number[] }) => setPreferredDays(ctx, input),
} as const;
