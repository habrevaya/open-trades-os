/**
 * SEVERAL DAYS, REBALANCED: WORK MOVED TO ANOTHER DAY
 *
 * `rebalance` plans one day across everybody. It cannot help the Tuesday
 * that has eleven calls for three people while Thursday has four, because
 * nothing it may do takes a visit off Tuesday. This proposes moving visits
 * between days, but only the visits that may move and only to the days they
 * may move to: a visit whose customer agreed to any day in a range (an
 * agreement's tune up due "in the first half of May"), or whose customer
 * named the days of the week that suit them.
 *
 * STILL A PROPOSAL, applied by a person. A visit moved to another day is a
 * customer who has to be told, so the service applies it through the same
 * path a customer's own request to move uses, which tells them.
 *
 * THE SAME CONSTRAINTS, IN THE SAME ORDER, on every day: who may do the
 * work (skills and time off, which differ by day), arrival windows, the
 * overtime limit, lunch, then overtime, then driving. A visit is moved to
 * another day only when that keeps a promise or a limit the plan would
 * otherwise break, places work no day could otherwise take, cuts overtime,
 * or saves at least `minDayMoveSavingMinutes` of driving. That is a higher
 * bar than moving a visit between two people on one day, because the
 * customer is the one whose plans change.
 *
 * A WINDOW'S ONLINE CEILING HOLDS. A move into a window the company sells
 * online counts against how many it will sell there (`DayOption.ceiling`),
 * the same limit a customer moving their own visit meets, so a rebalance
 * cannot fill a Thursday morning past what the company said it takes.
 *
 * HOW. Each day is first rebalanced on its own. Then each visit that may
 * move is tried on every other day it may go to, at the cheapest place on
 * each person's day there, and the best move that is worth it is taken.
 * Repeated until nothing moves. Each day is then rebalanced once more with
 * what it now holds, so the order on a day that gained a visit is the one
 * the single day planner would choose. Deterministic: days in date order,
 * visits by day then id, people by id, first improvement per visit.
 */

import type { PlanStop, Travel } from "./index.js";
import {
  evaluateShift, rebalance,
  type RebalanceDay, type RebalanceResult, type RebalanceTechnician, type Unplaced,
} from "./rebalance.js";

export interface DayToPlan {
  /** YYYY-MM-DD. */
  date: string;
  /** Each person working that day, with their visits as the day stands now. */
  technicians: RebalanceTechnician[];
  travel: Travel;
}

/** One day a visit may be on, with its window and who may take it there. */
export interface DayOption {
  date: string;
  /** The visit's arrival window on that day, in that day's minutes. */
  stop: PlanStop;
  /** Per technician working that day: null when they may, the sentence why not when they may not. */
  refusals: Record<string, string | null>;
  /**
   * A limit on how many visits may be moved INTO the slot this option puts
   * the visit in: online booking's per window ceiling, less what that
   * window already holds. Options sharing a `key` share the limit. Absent
   * when nothing limits it. Never applies to the day a visit is already on.
   */
  ceiling?: { key: string; remaining: number } | undefined;
  /**
   * The arrival window this day would put the visit in, when a share of it
   * is held for members and this visit's customer is not let into it:
   * `room` is how many more such visits the window takes before the hold.
   * Absent when nothing is held from this visit there.
   */
  held?: { key: string; room: number } | undefined;
}

export interface DaysVisit {
  id: string;
  /** The day it is on now. */
  date: string;
  /** Locked by the office: stays on its day, with whoever has it. */
  locked: boolean;
  /** Every day it may be on, the day it is on now included. */
  options: DayOption[];
  /** A member whose plan promised priority, placed first in an unassigned pile. */
  priority?: boolean | undefined;
}

export interface DayMove {
  visitId: string;
  fromDate: string;
  toDate: string;
  /** Null when it had nobody. */
  fromTechnicianId: string | null;
  toTechnicianId: string;
}

export interface DayOutcome {
  date: string;
  before: RebalanceDay[];
  after: RebalanceDay[];
  /** Visits on this day the plan could not place, after the moves. */
  unplaced: Unplaced[];
  visitsBefore: number;
  visitsAfter: number;
  driveBefore: number;
  driveAfter: number;
  overtimeBefore: number;
  overtimeAfter: number;
}

export interface DaysResult {
  days: DayOutcome[];
  /** Every visit whose day or person changes, visits that had nobody included. */
  moves: { visitId: string; fromDate: string; toDate: string; from: string | null; to: string }[];
  /** The ones whose day changes: each is a customer to tell. */
  dayMoves: DayMove[];
  driveBefore: number;
  driveAfter: number;
  overtimeBefore: number;
  overtimeAfter: number;
  changed: boolean;
}

interface Cost {
  refused: number;
  late: number;
  lateMinutes: number;
  overLimit: number;
  lunchLate: number;
  unplaced: number;
  overtime: number;
  drive: number;
}

const FIELDS: (keyof Cost)[] = ["refused", "late", "lateMinutes", "overLimit", "lunchLate", "unplaced", "overtime", "drive"];
const HARD: (keyof Cost)[] = ["refused", "late", "lateMinutes", "overLimit", "lunchLate"];
const zero = (): Cost => ({ refused: 0, late: 0, lateMinutes: 0, overLimit: 0, lunchLate: 0, unplaced: 0, overtime: 0, drive: 0 });
const add = (...costs: Cost[]): Cost => {
  const out = zero();
  for (const c of costs) for (const f of FIELDS) out[f] += c[f];
  return out;
};
const compare = (a: Cost, b: Cost, fields = FIELDS): number => {
  for (const f of fields) if (a[f] !== b[f]) return a[f] - b[f];
  return 0;
};

/**
 * Whether moving a visit to another day is worth telling its customer.
 * Anything that keeps a promise or a limit is; then placing work nobody
 * could take; then less overtime; otherwise only a real saving in driving.
 */
function worthMovingDay(now: Cost, was: Cost, minSaving: number): boolean {
  const hard = compare(now, was, HARD);
  if (hard !== 0) return hard < 0;
  if (now.unplaced !== was.unplaced) return now.unplaced < was.unplaced;
  if (now.overtime !== was.overtime) return now.overtime < was.overtime;
  return was.drive - now.drive >= minSaving;
}

export function rebalanceDays(input: {
  days: readonly DayToPlan[];
  visits: readonly DaysVisit[];
  /** The least driving a move between people on one day must save. */
  minMoveSavingMinutes?: number;
  /** The least driving a move to another day must save on its own. */
  minDayMoveSavingMinutes?: number;
  maxPasses?: number;
}): DaysResult {
  const minDayMove = input.minDayMoveSavingMinutes ?? 15;
  const maxPasses = input.maxPasses ?? 20;
  const days = [...input.days].sort((a, b) => a.date.localeCompare(b.date));
  const dayByDate = new Map(days.map((d) => [d.date, d]));
  const visits = [...input.visits].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const visitById = new Map(visits.map((v) => [v.id, v]));
  const optionOf = (visitId: string, date: string) => visitById.get(visitId)?.options.find((o) => o.date === date);

  /** The day each visit is on in the working plan. */
  const dayOf = new Map(visits.map((v) => [v.id, v.date]));
  const membersOf = (date: string) => visits.filter((v) => dayOf.get(v.id) === date);

  const solve = (date: string, orders?: Map<string, string[]>): RebalanceResult => {
    const day = dayByDate.get(date)!;
    const members = membersOf(date);
    const here = new Set(members.map((v) => v.id));
    return rebalance({
      technicians: day.technicians.map((t) => ({
        ...t,
        order: (orders?.get(t.technicianId) ?? t.order).filter((id) => here.has(id)),
      })),
      visits: members.map((v) => {
        const option = optionOf(v.id, date)!;
        return { stop: option.stop, locked: v.locked, refusals: option.refusals, priority: v.priority };
      }),
      travel: day.travel,
      ...(input.minMoveSavingMinutes !== undefined ? { minMoveSavingMinutes: input.minMoveSavingMinutes } : {}),
    });
  };

  /** Where everything is to begin with, before anything moves. */
  const originalTech = new Map<string, string>();
  for (const day of days) {
    for (const t of day.technicians) for (const id of t.order) if (visitById.has(id)) originalTech.set(id, t.technicianId);
  }

  /* 1. Each day on its own. */
  const first = new Map(days.map((d) => [d.date, solve(d.date)]));
  const routes = new Map(days.map((d) => [d.date, new Map(first.get(d.date)!.after.map((a) => [a.technicianId, [...a.evaluation.order]]))]));
  const unplacedNow = new Set<string>();
  for (const [, result] of first) for (const u of result.unplaced) unplacedNow.add(u.visitId);

  const costOf = (date: string, technicianId: string, order: readonly string[]): Cost => {
    const day = dayByDate.get(date)!;
    const t = day.technicians.find((x) => x.technicianId === technicianId)!;
    const stops = order.map((id) => optionOf(id, date)!.stop);
    const e = evaluateShift({ start: t.start, end: t.end, departAt: t.departAt, stops, travel: day.travel }, order, t.shift);
    return {
      refused: order.filter((id) => optionOf(id, date)!.refusals[technicianId] !== null).length,
      late: e.late.length,
      lateMinutes: e.lateMinutes,
      overLimit: e.overLimitMinutes,
      lunchLate: e.lunch?.lateBy ?? 0,
      unplaced: 0,
      overtime: e.overtimeMinutes,
      drive: e.driveMinutes,
    };
  };

  /**
   * Which ceiling each visit moved to another day is using, so a window's
   * limit counts the visits in it now, not every visit that ever passed
   * through it on the way somewhere else.
   */
  const usingCeiling = new Map<string, string>();
  const used = (key: string) => [...usingCeiling.values()].filter((k) => k === key).length;
  const fits = (visitId: string, option: DayOption) => {
    if (!option.ceiling) return true;
    const already = usingCeiling.get(visitId) === option.ceiling.key ? 1 : 0;
    return used(option.ceiling.key) - already < option.ceiling.remaining;
  };

  /**
   * THE HOLD FOR MEMBERS, KEPT. A visit moved to another day takes room in
   * that day's arrival window like a booking does, so it may not take the
   * share held for members from somebody who is not one: each held window
   * takes only as many moved visits as it has room for outside the hold.
   */
  const heldUse = new Map<string, number>();
  const heldBy = new Map<string, string>();
  const fitsHold = (option: DayOption) => !option.held || (heldUse.get(option.held.key) ?? 0) < option.held.room;

  /* 2. Each visit that may move, tried on the other days it may go to. */
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (const v of visits) {
      if (v.locked) continue;
      const here = dayOf.get(v.id)!;
      const elsewhere = v.options.filter((o) => o.date !== here && dayByDate.has(o.date) && fitsHold(o))
        .sort((a, b) => a.date.localeCompare(b.date));
      if (elsewhere.length === 0) continue;

      const hereRoutes = routes.get(here)!;
      const owner = [...hereRoutes.entries()].find(([, order]) => order.includes(v.id))?.[0] ?? null;
      if (owner === null && !unplacedNow.has(v.id)) continue;
      const fromWas = owner ? costOf(here, owner, hereRoutes.get(owner)!) : { ...zero(), unplaced: 1 };
      const fromOrder = owner ? hereRoutes.get(owner)!.filter((id) => id !== v.id) : [];
      const fromNow = owner ? costOf(here, owner, fromOrder) : zero();

      let best: { date: string; technicianId: string; order: string[]; now: Cost; was: Cost } | null = null;
      for (const option of elsewhere) {
        if (option.date !== v.date && !fits(v.id, option)) continue;
        const there = routes.get(option.date)!;
        const people = [...there.keys()].sort();
        for (const technicianId of people) {
          if (option.refusals[technicianId] !== null || !(technicianId in option.refusals)) continue;
          const current = there.get(technicianId)!;
          const toWas = costOf(option.date, technicianId, current);
          for (let position = 0; position <= current.length; position++) {
            const order = [...current.slice(0, position), v.id, ...current.slice(position)];
            const now = add(fromNow, costOf(option.date, technicianId, order));
            const was = add(fromWas, toWas);
            if (!worthMovingDay(now, was, minDayMove)) continue;
            const gain = (c: Cost, w: Cost) => {
              const d = zero();
              for (const f of FIELDS) d[f] = c[f] - w[f];
              return d;
            };
            if (!best || compare(gain(now, was), gain(best.now, best.was)) < 0) {
              best = { date: option.date, technicianId, order, now, was };
            }
          }
        }
      }
      if (!best) continue;
      if (owner) hereRoutes.set(owner, fromOrder);
      unplacedNow.delete(v.id);
      const was = heldBy.get(v.id);
      if (was !== undefined) {
        heldUse.set(was, (heldUse.get(was) ?? 1) - 1);
        heldBy.delete(v.id);
      }
      const takes = optionOf(v.id, best.date)?.held;
      if (takes) {
        heldUse.set(takes.key, (heldUse.get(takes.key) ?? 0) + 1);
        heldBy.set(v.id, takes.key);
      }
      routes.get(best.date)!.set(best.technicianId, best.order);
      dayOf.set(v.id, best.date);
      const ceiling = best.date === v.date ? undefined : optionOf(v.id, best.date)?.ceiling;
      if (ceiling) usingCeiling.set(v.id, ceiling.key);
      else usingCeiling.delete(v.id);
      moved = true;
    }
    if (!moved) break;
  }

  /* 3. Each day again, with what it now holds. */
  const outcomes: DayOutcome[] = [];
  const finalTech = new Map<string, string>();
  for (const day of days) {
    const result = solve(day.date, routes.get(day.date)!);
    for (const a of result.after) for (const id of a.evaluation.order) finalTech.set(id, a.technicianId);
    const before = first.get(day.date)!.before;
    const sum = (list: RebalanceDay[], f: (d: RebalanceDay) => number) => list.reduce((n, d) => n + f(d), 0);
    outcomes.push({
      date: day.date,
      before,
      after: result.after,
      unplaced: result.unplaced,
      visitsBefore: visits.filter((v) => v.date === day.date).length,
      visitsAfter: membersOf(day.date).length,
      driveBefore: sum(before, (d) => d.evaluation.driveMinutes),
      driveAfter: sum(result.after, (d) => d.evaluation.driveMinutes),
      overtimeBefore: sum(before, (d) => d.evaluation.overtimeMinutes),
      overtimeAfter: sum(result.after, (d) => d.evaluation.overtimeMinutes),
    });
  }

  const moves: DaysResult["moves"] = [];
  const dayMoves: DayMove[] = [];
  for (const v of visits) {
    const to = finalTech.get(v.id);
    if (!to) continue;
    const from = originalTech.get(v.id) ?? null;
    const toDate = dayOf.get(v.id)!;
    if (from === to && toDate === v.date) continue;
    moves.push({ visitId: v.id, fromDate: v.date, toDate, from, to });
    if (toDate !== v.date) dayMoves.push({ visitId: v.id, fromDate: v.date, toDate, fromTechnicianId: from, toTechnicianId: to });
  }
  const total = (f: (d: DayOutcome) => number) => outcomes.reduce((n, d) => n + f(d), 0);
  const changed = moves.length > 0 || outcomes.some((d) =>
    d.after.some((a, i) => a.evaluation.order.join() !== d.before[i]?.evaluation.order.join()));

  return {
    days: outcomes,
    moves,
    dayMoves,
    driveBefore: total((d) => d.driveBefore),
    driveAfter: total((d) => d.driveAfter),
    overtimeBefore: total((d) => d.overtimeBefore),
    overtimeAfter: total((d) => d.overtimeAfter),
    changed,
  };
}
