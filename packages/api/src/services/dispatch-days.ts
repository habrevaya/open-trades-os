import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, recurrence, routing, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as dm from "./dispatch-map";
import * as dispatch from "./dispatch";
import { announce, sideOf } from "./visit-notices";
import { officeMoved } from "./visit-changes";
import { remember, replayed } from "./once";

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
 * and never onto a day the company is closed. Core decides
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
  context: { today: string; open: ReadonlySet<number> | null },
): { dates: string[]; because: "range" | "weekdays" | null } {
  if (v.locked || !MOVABLE.has(v.status) || own <= context.today) return { dates: [], because: null };
  const candidates = range.filter((d) => d !== own && d > context.today
    && (context.open === null || context.open.has(weekday(d))));
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
  for (const date of dates) days.push(await dm.loadDay(tx, ctx.actor.organizationId, date));
  return { zone, days, today: time.dateIn(new Date(), zone), open: await openDaysOf(tx) };
}

export async function rebalanceDays(ctx: ServiceContext, input: { from: string; days: number }) {
  /** The permission before the range, so somebody who may not read the schedule hears that first. */
  assertCan(ctx.actor, "visit:read");
  const dates = rangeOf(input.from, input.days);
  const loaded = await guardedRead(ctx, "visit:read", async (tx) => {
    const range = await loadRange(tx, ctx, dates);
    /** Asked once over every visit any day might take, per day, because skills lapse and time off is by day. */
    const everything = range.days.flatMap((d) => d.visits.filter((v) => dm.plannable(d, v)));
    const verdicts = new Map<string, Awaited<ReturnType<typeof dm.verdictsFor>>>();
    const members = new Map<string, Map<string, string>>();
    for (const day of range.days) {
      verdicts.set(day.date, await dm.verdictsFor(tx, ctx.actor.organizationId, day, everything));
      members.set(day.date, await dm.membersOn(tx, day, day.visits.filter((v) => dm.plannable(day, v) && v.technicianIds.length === 0)));
    }
    return { ...range, verdicts, members };
  });
  const { zone, days, today, open } = loaded;
  const dayOf = new Map(days.map((d) => [d.date, d]));

  const points: dm.Points = new Map();
  const plans = days.map((day) => {
    const leftOut = dm.leftOutOf(day);
    const planned = day.technicians.filter((t) => !leftOut.some((l) => l.technicianId === t.id));
    const { techs, keepFirst } = dm.rebalanceTechnicians(day, planned, points, `${day.date}:`);
    const candidates = day.visits.filter((v) => dm.plannable(day, v)
      && (v.technicianIds.length === 0 ? v.status === "unassigned" : planned.some((t) => t.id === v.technicianIds[0])));
    return { day, leftOut, planned, techs, keepFirst, candidates };
  });
  const planOf = new Map(plans.map((p) => [p.day.date, p]));

  const refusalsOn = (date: string, v: dm.DayVisit) => {
    const plan = planOf.get(date)!;
    const verdictOf = loaded.verdicts.get(date)!;
    return Object.fromEntries(plan.planned.map((t) => [t.id, dm.refusalFor(plan.day, t, v, verdictOf)]));
  };

  const grounds = new Map<string, "range" | "weekdays">();
  const visits: routing.DaysVisit[] = [];
  const byId = new Map<string, { visit: dm.DayVisit; date: string }>();
  for (const plan of plans) {
    for (const v of plan.candidates) {
      points.set(v.id, { place: v.place, routeId: v.routeId });
      byId.set(v.id, { visit: v, date: plan.day.date });
      const may = daysFor(v, plan.day.date, dates, { today, open });
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
            return {
              date,
              stop: {
                id: v.id,
                serviceMinutes: v.estimatedDurationMinutes,
                windowStart: dm.minutesFrom(other.origin, moved.start),
                windowEnd: moved.end ? dm.minutesFrom(other.origin, moved.end) : null,
              },
              refusals: refusalsOn(date, v),
            };
          }),
        ],
      });
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

  const nameOf = new Map(days.flatMap((d) => d.technicians.map((t) => [t.id, t.displayName] as const)));
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
    const orders = plan.techs
      .filter((t) => after.get(t.technicianId)!.evaluation.order.join() !== before.get(t.technicianId)!.evaluation.order.join())
      .map((t) => {
        const kept = plan.keepFirst.get(t.technicianId)!;
        const planned = new Set(after.get(t.technicianId)!.evaluation.order);
        const others = dm.routeOf(plan.day, t.technicianId)
          .filter((v) => !kept.includes(v.id) && !planned.has(v.id) && !movedAway.has(v.id)
            && !before.get(t.technicianId)!.evaluation.order.includes(v.id))
          .map((v) => v.id);
        return { date: outcome.date, technicianId: t.technicianId, visitIds: [...kept, ...after.get(t.technicianId)!.evaluation.order, ...others] };
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
      technicians: plan.planned.map((t) => ({
        technicianId: t.id,
        displayName: t.displayName,
        color: t.color,
        timeOff: t.timeOff,
        before: dm.rebalanceSummary(plan.day, before.get(t.id)!),
        after: dm.rebalanceSummary(plan.day, after.get(t.id)!),
      })),
      unplaced: outcome.unplaced.map((u) => ({ visitId: u.visitId, customerName: customer(u.visitId), reason: why(u) })),
      leftOut: plan.leftOut,
      orders,
    };
  });

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
      return {
        visitId: m.visitId,
        customerName: visit.customerName,
        fromDate: m.fromDate,
        toDate: m.toDate,
        fromTechnicianId: m.fromTechnicianId,
        fromName: m.fromTechnicianId ? nameOf.get(m.fromTechnicianId) ?? null : null,
        toTechnicianId: m.toTechnicianId,
        toName: nameOf.get(m.toTechnicianId) ?? "",
        windowStart: moved.start.toISOString(),
        windowEnd: moved.end?.toISOString() ?? null,
        because: grounds.get(m.visitId) ?? "range",
      };
    }),
    /** Visits that stay on their day with somebody else. */
    moves: result.moves.filter((m) => !dayMoveIds.has(m.visitId)).map((m) => ({
      visitId: m.visitId,
      customerName: customer(m.visitId),
      date: m.fromDate,
      fromTechnicianId: m.from,
      fromName: m.from ? nameOf.get(m.from) ?? null : null,
      toTechnicianId: m.to,
      toName: nameOf.get(m.to) ?? "",
    })),
    perDay: outcomes.map(({ orders: _orders, ...rest }) => rest),
    visits: [...byId.values()].map(({ visit, date }) => ({
      visitId: visit.id, customerName: visit.customerName, date, locked: visit.locked,
      windowStart: dm.iso(visit.windowStart), windowEnd: dm.iso(visit.windowEnd),
    })),
    driveBeforeMinutes: result.driveBefore,
    driveAfterMinutes: result.driveAfter,
    overtimeBeforeMinutes: result.overtimeBefore,
    overtimeAfterMinutes: result.overtimeAfter,
    apply: {
      dayMoves: result.dayMoves.map((m) => ({ visitId: m.visitId, toDate: m.toDate, technicianId: m.toTechnicianId })),
      moves: result.moves.filter((m) => !dayMoveIds.has(m.visitId)).map((m) => ({ visitId: m.visitId, technicianId: m.to })),
      orders: outcomes.flatMap((o) => o.orders),
    },
    workday: first.workday,
    ...dm.sourceOf(matrix),
  };
}

/**
 * Apply a multi day rebalance a person looked at.
 *
 * Each visit moved to another day: its window set to the same times on the
 * new day, put on the person proposed through the assignment a drag uses
 * (skills and time off checked again, on the new day), the people on it
 * told through the visit's notices, and the customer told through the
 * visit change path. Then each changed day's order. One transaction, so a
 * refusal anywhere leaves every day as it was. A move the visit's customer
 * did not agree to is refused even when the payload asks for it.
 */
export async function applyRebalanceDays(ctx: ServiceContext, input: {
  from: string;
  days: number;
  basis: string;
  dayMoves: { visitId: string; toDate: string; technicianId: string }[];
  moves: { visitId: string; technicianId: string }[];
  orders: { date: string; technicianId: string; visitIds: string[] }[];
}) {
  assertCan(ctx.actor, "visit:dispatch");
  const dates = rangeOf(input.from, input.days);
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    assertCan(ctx.actor, "visit:reschedule");
    type Applied = { ok: true; movedDays: number; moved: number; reordered: number; told: { visitId: string; notified: string }[] };
    const prior = await replayed<Applied>(tx, ctx, "dispatch_rebalance_days");
    if (prior) return prior;

    const { zone, days, today, open } = await loadRange(tx, ctx, dates);
    if (basisOfDays(days) !== input.basis) {
      throw new ConflictError("The board has changed since this was proposed. Propose it again to see the days as they are now.");
    }
    const inner: ServiceContext = { ...ctx, db: tx };
    delete inner.idempotencyKey;

    const told: Applied["told"] = [];
    for (const move of input.dayMoves) {
      const day = days.find((d) => d.visits.some((v) => v.id === move.visitId));
      const visit = day?.visits.find((v) => v.id === move.visitId);
      if (!day || !visit || !visit.windowStart) throw new NotFoundError("Visit");
      if (!dm.plannable(day, visit) || !daysFor(visit, day.date, dates, { today, open }).dates.includes(move.toDate)) {
        throw new ConflictError(`${visit.customerName}'s visit may not be moved to ${move.toDate}: the customer has not agreed to that day.`);
      }
      const was = { start: visit.windowStart, end: visit.windowEnd };
      const before = await sideOf(tx, visit.id);
      const moved = windowOn(visit, day, move.toDate, zone);
      await tx.update(schema.visit).set({ windowStart: moved.start, windowEnd: moved.end, routeOrder: null, updatedAt: new Date() })
        .where(eq(schema.visit.id, visit.id));
      await dispatch.assign(inner, { id: visit.id, technicianIds: [move.technicianId] });
      /**
       * The assignment told anybody added or taken off. Somebody who keeps
       * it hears that it moved, which the assignment cannot see: by the
       * time it read the visit, the new day was already written.
       */
      if (before && before.technicianIds.length === 1 && before.technicianIds[0] === move.technicianId) {
        await announce(tx, inner, visit.id, before);
      }
      told.push({ visitId: visit.id, notified: await officeMoved(tx, inner, { visitId: visit.id, was }) });
    }

    for (const move of input.moves) {
      const visit = days.flatMap((d) => d.visits).find((v) => v.id === move.visitId);
      if (!visit) throw new NotFoundError("Visit");
      if (visit.locked) throw new ConflictError(`${visit.customerName}'s visit is locked, so it is not moved.`);
      await dispatch.assign(inner, { id: move.visitId, technicianIds: [move.technicianId] });
    }
    for (const order of input.orders) {
      if (order.visitIds.length === 0 || !dates.includes(order.date)) continue;
      await dispatch.reorder(inner, { technicianId: order.technicianId, date: order.date, visitIds: order.visitIds });
    }

    const answer: Applied = {
      ok: true, movedDays: input.dayMoves.length, moved: input.moves.length, reordered: input.orders.length, told,
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
    dayMoves: { visitId: string; toDate: string; technicianId: string }[];
    moves: { visitId: string; technicianId: string }[];
    orders: { date: string; technicianId: string; visitIds: string[] }[];
  }) => applyRebalanceDays(ctx, input),
  setVisitMovable: (ctx: ServiceContext, input: { id: string; from: string | null; until: string | null }) =>
    setVisitMovable(ctx, input),
  setCustomerPreferredDays: (ctx: ServiceContext, input: { id: string; days: number[] }) => setPreferredDays(ctx, input),
} as const;
