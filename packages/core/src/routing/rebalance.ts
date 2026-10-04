/**
 * THE WHOLE DAY, REBALANCED ACROSS EVERYBODY
 *
 * `optimise` orders one technician's day and `suggestAssignments` places the
 * unassigned pile one visit at a time. Neither moves work that is already on
 * somebody's day, so a morning where Ray has six calls on the east side and
 * Dana has two on the west and one on the east stays that way however long
 * the dispatcher stares at it. This proposes the day as a whole: who takes
 * what, and in what order, with the drive saved against the day as it is.
 *
 * STILL A PROPOSAL. Nothing here writes anything, and the screen applies it
 * only when a person presses the button, through the same assignment and
 * reorder paths a drag uses, so every check a drag gets (skills, time off,
 * the reorder's own day) applies to an accepted proposal too.
 *
 * WHAT IT RESPECTS, HARDEST FIRST, and the order is the objective:
 *
 *   1. Who may do the work. A visit is never put on the day of somebody the
 *      caller refused (skills, time off), and a visit already on such a
 *      person's day counts against the plan until it moves.
 *   2. Arrival windows, exactly as `optimise` treats them.
 *   3. The overtime limit: back at the end of the day no later than the end
 *      of the shift plus the overtime the company allows.
 *   4. Lunch: a break of so many minutes, started inside its window. Taken
 *      at the first gap between stops once the window has opened, or in a
 *      wait outside a customer's window when it fits there, and waited for
 *      when the next job would otherwise run past the latest start.
 *   5. Overtime inside the allowance, which is allowed and still a cost.
 *   6. Drive time, which is what is minimised once all of the above hold.
 *
 * LOCKED WORK STAYS PUT. A visit the dispatcher locked keeps its technician
 * and its order among that technician's other locked visits; other work can
 * be placed before or after it. Work under way or finished is not passed in
 * at all, as with `optimise`: the day starts where the van is.
 *
 * MOVING WORK BETWEEN PEOPLE HAS A COST THE NUMBERS DO NOT SEE. Both
 * technicians get a notice, and the customer may have been told a name. So a
 * visit is moved to somebody else only when that keeps a promise the current
 * plan breaks, cuts overtime, or saves at least `minMoveSavingMinutes` of
 * driving; three minutes saved is not worth a phone buzzing twice.
 *
 * Deterministic, like `optimise`: technicians in id order, stops in the order
 * they are in, first improvement taken. The same day in gives the same
 * proposal out, which is what lets a dispatcher trust the preview.
 */

import type { DayPlan, PlanStop, Travel } from "./index.js";

export interface Lunch {
  minutes: number;
  /** The earliest and latest a break may START, in the plan's minutes. */
  earliest: number;
  latest: number;
}

export interface Shift {
  /** When the working day ends: back at the end key by here, or what follows is overtime. */
  endsAt: number;
  /** Overtime the plan may use past `endsAt`. Finishing later than both together breaks the limit. */
  maxOvertimeMinutes: number;
  lunch: Lunch | null;
}

export interface ShiftArrival {
  id: string;
  arriveAt: number;
  startAt: number;
  leaveAt: number;
  lateBy: number;
}

export interface ShiftEvaluation {
  order: string[];
  driveMinutes: number;
  waitMinutes: number;
  finishAt: number;
  arrivals: ShiftArrival[];
  late: { id: string; lateBy: number }[];
  lateMinutes: number;
  /** When the break starts and how far past its latest start. Null when the day ends before lunch is due. */
  lunch: { startAt: number; lateBy: number } | null;
  overtimeMinutes: number;
  /** Minutes past the end of the shift plus the overtime allowed. */
  overLimitMinutes: number;
}

/**
 * Walk one technician's day in a given order, with the shift around it.
 *
 * The same arithmetic as `evaluate`, plus the break and the end of the day,
 * so the two cannot disagree about when somebody arrives anywhere on a day
 * with no lunch and no end.
 */
export function evaluateShift(plan: DayPlan, order: readonly string[], shift: Shift): ShiftEvaluation {
  const byId = new Map(plan.stops.map((s) => [s.id, s]));
  const L = shift.lunch;
  let at = plan.start;
  let clock = plan.departAt;
  let drive = 0;
  let wait = 0;
  let lunch: { startAt: number; lateBy: number } | null = null;
  const take = (start: number) => {
    lunch = { startAt: start, lateBy: L ? Math.max(0, start - L.latest) : 0 };
    clock = start + (L?.minutes ?? 0);
  };
  const arrivals: ShiftArrival[] = [];

  for (const id of order) {
    const stop = byId.get(id);
    if (!stop) throw new RangeError(`${id} is not a stop in this plan.`);
    const leg = plan.travel(at, id);

    let lunchInWait = false;
    if (L && !lunch) {
      if (clock >= L.earliest) {
        take(clock);
      } else {
        const arrive = clock + leg;
        const begin = stop.windowStart !== null && arrive < stop.windowStart ? stop.windowStart : arrive;
        /** A wait outside a customer's window is free time, and the best place for a break. */
        const inWait = Math.max(arrive, L.earliest);
        if (inWait <= L.latest && inWait + L.minutes <= begin) lunchInWait = true;
        else if (begin + stop.serviceMinutes > L.latest) take(L.earliest);
      }
    }

    drive += leg;
    const arriveAt = clock + leg;
    const startAt = stop.windowStart !== null && arriveAt < stop.windowStart ? stop.windowStart : arriveAt;
    let waited = startAt - arriveAt;
    if (lunchInWait && L) {
      lunch = { startAt: Math.max(arriveAt, L.earliest), lateBy: 0 };
      waited -= L.minutes;
    }
    wait += waited;
    const lateBy = stop.windowEnd !== null && arriveAt > stop.windowEnd ? arriveAt - stop.windowEnd : 0;
    const leaveAt = startAt + stop.serviceMinutes;
    arrivals.push({ id, arriveAt, startAt, leaveAt, lateBy });
    clock = leaveAt;
    at = id;
  }

  /** A day still going once the break window has opened takes it before the drive home. */
  if (L && !lunch && order.length > 0 && clock >= L.earliest) take(clock);

  const home = order.length === 0 ? 0 : plan.travel(at, plan.end);
  drive += home;
  const finishAt = clock + home;
  const late = arrivals.filter((a) => a.lateBy > 0).map((a) => ({ id: a.id, lateBy: a.lateBy }));
  const worked = order.length > 0;
  return {
    order: [...order],
    driveMinutes: drive,
    waitMinutes: wait,
    finishAt,
    arrivals,
    late,
    lateMinutes: late.reduce((n, l) => n + l.lateBy, 0),
    lunch,
    overtimeMinutes: worked ? Math.max(0, finishAt - shift.endsAt) : 0,
    overLimitMinutes: worked ? Math.max(0, finishAt - shift.endsAt - shift.maxOvertimeMinutes) : 0,
  };
}

/* ------------------------------------------------------------- the cost */

interface Cost {
  refused: number;
  late: number;
  lateMinutes: number;
  overLimit: number;
  lunchLate: number;
  overtime: number;
  drive: number;
  finish: number;
}

const FIELDS: (keyof Cost)[] = ["refused", "late", "lateMinutes", "overLimit", "lunchLate", "overtime", "drive", "finish"];
const HARD: (keyof Cost)[] = ["refused", "late", "lateMinutes", "overLimit", "lunchLate"];

const zero = (): Cost => ({ refused: 0, late: 0, lateMinutes: 0, overLimit: 0, lunchLate: 0, overtime: 0, drive: 0, finish: 0 });
const add = (a: Cost, b: Cost): Cost => {
  const out = zero();
  for (const f of FIELDS) out[f] = a[f] + b[f];
  return out;
};
/** Negative when `a` is better, lexicographically in the order the header gives. */
const compare = (a: Cost, b: Cost, fields = FIELDS): number => {
  for (const f of fields) if (a[f] !== b[f]) return a[f] - b[f];
  return 0;
};

/* ------------------------------------------------------------ the input */

export interface RebalanceTechnician {
  technicianId: string;
  start: string;
  end: string;
  /** When the van leaves: the start of the shift, now, or when work under way will be done. */
  departAt: number;
  shift: Shift;
  /** Their visits as the day stands, in order. Locked ones included. */
  order: string[];
}

export interface RebalanceVisit {
  stop: PlanStop;
  /** Stays with whoever has it, in its order among their other locked visits. */
  locked: boolean;
  /**
   * Per technician, null when they may take it and the sentence why not when
   * they may not. A technician missing from the record is not considered.
   */
  refusals: Record<string, string | null>;
  /**
   * A member whose plan promised priority. Placed before everybody else in
   * the unassigned pile, so the next free gap goes to them, as it does on
   * the board and in "Suggest who".
   */
  priority?: boolean | undefined;
}

export interface Unplaced {
  visitId: string;
  /**
   * `locked` is unassigned and locked, so left alone; `nobody_may` is
   * refused by everybody considered; `would_break` could go somewhere only
   * by breaking a window, the overtime limit or lunch.
   */
  why: "locked" | "nobody_may" | "would_break";
  refusals: string[];
  /** For `would_break`: the least bad place, and what it would break there. */
  nearest: {
    technicianId: string;
    late: { id: string; lateBy: number }[];
    overLimitMinutes: number;
    lunchLateBy: number;
  } | null;
}

export interface RebalanceDay {
  technicianId: string;
  evaluation: ShiftEvaluation;
  /** Stops on this day the caller refused for this person, which the plan could not move. */
  refused: string[];
}

export interface RebalanceResult {
  before: RebalanceDay[];
  after: RebalanceDay[];
  /** Every visit whose technician changes, including visits that had nobody. */
  moves: { visitId: string; from: string | null; to: string }[];
  unplaced: Unplaced[];
  driveBefore: number;
  driveAfter: number;
  overtimeBefore: number;
  overtimeAfter: number;
  /** Whether the proposal differs from the day as it is at all. */
  changed: boolean;
}

/* -------------------------------------------------------------- solving */

export function rebalance(input: {
  technicians: readonly RebalanceTechnician[];
  visits: readonly RebalanceVisit[];
  travel: Travel;
  /** The least driving a move between technicians must save on its own. */
  minMoveSavingMinutes?: number;
  maxPasses?: number;
}): RebalanceResult {
  const minMove = input.minMoveSavingMinutes ?? 5;
  const maxPasses = input.maxPasses ?? 100;
  const visitById = new Map(input.visits.map((v) => [v.stop.id, v]));
  const techs = [...input.technicians].sort((a, b) => a.technicianId.localeCompare(b.technicianId));
  const techById = new Map(techs.map((t) => [t.technicianId, t]));
  const stops = input.visits.map((v) => v.stop);

  const may = (visitId: string, technicianId: string): boolean => {
    const v = visitById.get(visitId);
    if (!v || !(technicianId in v.refusals)) return false;
    return v.refusals[technicianId] === null;
  };

  const plans = new Map(techs.map((t) => [t.technicianId, {
    start: t.start, end: t.end, departAt: t.departAt, stops, travel: input.travel,
  } satisfies DayPlan]));

  const evaluateRoute = (technicianId: string, order: readonly string[]) => {
    const t = techById.get(technicianId)!;
    const evaluation = evaluateShift(plans.get(technicianId)!, order, t.shift);
    const refused = order.filter((id) => !may(id, technicianId));
    const cost: Cost = {
      refused: refused.length,
      late: evaluation.late.length,
      lateMinutes: evaluation.lateMinutes,
      overLimit: evaluation.overLimitMinutes,
      lunchLate: evaluation.lunch?.lateBy ?? 0,
      overtime: evaluation.overtimeMinutes,
      drive: evaluation.driveMinutes,
      finish: evaluation.finishAt,
    };
    return { evaluation, refused, cost };
  };

  const routes = new Map(techs.map((t) => [t.technicianId, t.order.filter((id) => visitById.has(id))]));
  const before = techs.map((t) => {
    const r = evaluateRoute(t.technicianId, routes.get(t.technicianId)!);
    return { technicianId: t.technicianId, evaluation: r.evaluation, refused: r.refused };
  });
  const costs = new Map(techs.map((t) => [t.technicianId, evaluateRoute(t.technicianId, routes.get(t.technicianId)!).cost]));
  const originalOwner = new Map<string, string>();
  for (const [technicianId, order] of routes) for (const id of order) originalOwner.set(id, technicianId);

  /* 1. The unassigned pile: members first, then earliest closing window first. */
  const unplaced: Unplaced[] = [];
  const open = input.visits
    .filter((v) => !originalOwner.has(v.stop.id))
    .sort((a, b) =>
      Number(b.priority === true) - Number(a.priority === true)
      || (a.stop.windowEnd ?? Number.POSITIVE_INFINITY) - (b.stop.windowEnd ?? Number.POSITIVE_INFINITY)
      || (a.stop.windowStart ?? Number.POSITIVE_INFINITY) - (b.stop.windowStart ?? Number.POSITIVE_INFINITY)
      || a.stop.id.localeCompare(b.stop.id));

  for (const v of open) {
    const refusals = Object.values(v.refusals).filter((r): r is string => r !== null);
    if (v.locked) {
      unplaced.push({ visitId: v.stop.id, why: "locked", refusals, nearest: null });
      continue;
    }
    const allowed = techs.filter((t) => may(v.stop.id, t.technicianId));
    if (allowed.length === 0) {
      unplaced.push({ visitId: v.stop.id, why: "nobody_may", refusals, nearest: null });
      continue;
    }
    let best: { technicianId: string; order: string[]; cost: Cost; feasible: boolean;
      evaluation: ShiftEvaluation } | null = null;
    for (const t of allowed) {
      const current = routes.get(t.technicianId)!;
      const was = costs.get(t.technicianId)!;
      for (let position = 0; position <= current.length; position++) {
        const order = [...current.slice(0, position), v.stop.id, ...current.slice(position)];
        const r = evaluateRoute(t.technicianId, order);
        const feasible = compare(r.cost, was, HARD) <= 0;
        const delta: Cost = zero();
        for (const f of FIELDS) delta[f] = r.cost[f] - was[f];
        const better = !best
          || (feasible && !best.feasible)
          || (feasible === best.feasible && compare(delta, best.cost) < 0);
        if (better) best = { technicianId: t.technicianId, order, cost: delta, feasible, evaluation: r.evaluation };
      }
    }
    if (best && best.feasible) {
      routes.set(best.technicianId, best.order);
      costs.set(best.technicianId, evaluateRoute(best.technicianId, best.order).cost);
    } else if (best) {
      const wasLate = new Set(evaluateRoute(best.technicianId, routes.get(best.technicianId)!).evaluation.late.map((l) => l.id));
      unplaced.push({
        visitId: v.stop.id, why: "would_break", refusals,
        nearest: {
          technicianId: best.technicianId,
          late: best.evaluation.late.filter((l) => !wasLate.has(l.id)),
          overLimitMinutes: Math.max(0, best.cost.overLimit),
          lunchLateBy: Math.max(0, best.cost.lunchLate),
        },
      });
    }
  }

  /* 2. Improve until nothing does. */
  const movable = (id: string) => !visitById.get(id)?.locked;

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;

    /**
     * Between technicians: a run of one to three visits lifted off one day
     * and put on another. A run, not only one, because two calls on the far
     * side of town are each cheap to leave where they are while the other
     * is there, and only moving both at once shows the drive they cost.
     */
    between: for (const a of techs) {
      const fromOrder = routes.get(a.technicianId)!;
      for (let length = 1; length <= 3; length++) {
        for (let index = 0; index + length <= fromOrder.length; index++) {
          const segment = fromOrder.slice(index, index + length);
          if (!segment.every(movable)) continue;
          const without = [...fromOrder.slice(0, index), ...fromOrder.slice(index + length)];
          const fromCost = evaluateRoute(a.technicianId, without).cost;
          for (const b of techs) {
            if (b.technicianId === a.technicianId || !segment.every((id) => may(id, b.technicianId))) continue;
            const toOrder = routes.get(b.technicianId)!;
            const was = add(costs.get(a.technicianId)!, costs.get(b.technicianId)!);
            for (let position = 0; position <= toOrder.length; position++) {
              const order = [...toOrder.slice(0, position), ...segment, ...toOrder.slice(position)];
              const toCost = evaluateRoute(b.technicianId, order).cost;
              const now = add(fromCost, toCost);
              if (!worthMoving(now, was, minMove)) continue;
              routes.set(a.technicianId, without);
              routes.set(b.technicianId, order);
              costs.set(a.technicianId, fromCost);
              costs.set(b.technicianId, toCost);
              moved = true;
              break between;
            }
          }
        }
      }
    }
    if (moved) continue;

    /** Within a day: one visit to another place, or two swapped. */
    within: for (const t of techs) {
      const order = routes.get(t.technicianId)!;
      const was = costs.get(t.technicianId)!;
      for (let i = 0; i < order.length; i++) {
        if (!movable(order[i]!)) continue;
        const rest = [...order.slice(0, i), ...order.slice(i + 1)];
        for (let k = 0; k <= rest.length; k++) {
          if (k === i) continue;
          const candidate = [...rest.slice(0, k), order[i]!, ...rest.slice(k)];
          const cost = evaluateRoute(t.technicianId, candidate).cost;
          if (compare(cost, was) < 0) {
            routes.set(t.technicianId, candidate);
            costs.set(t.technicianId, cost);
            moved = true;
            break within;
          }
        }
        for (let j = i + 1; j < order.length; j++) {
          if (!movable(order[j]!)) continue;
          const candidate = [...order];
          [candidate[i], candidate[j]] = [candidate[j]!, candidate[i]!];
          const cost = evaluateRoute(t.technicianId, candidate).cost;
          if (compare(cost, was) < 0) {
            routes.set(t.technicianId, candidate);
            costs.set(t.technicianId, cost);
            moved = true;
            break within;
          }
        }
      }
    }
    if (!moved) break;
  }

  const after = techs.map((t) => {
    const r = evaluateRoute(t.technicianId, routes.get(t.technicianId)!);
    return { technicianId: t.technicianId, evaluation: r.evaluation, refused: r.refused };
  });
  const moves: RebalanceResult["moves"] = [];
  for (const t of techs) {
    for (const id of routes.get(t.technicianId)!) {
      const from = originalOwner.get(id) ?? null;
      if (from !== t.technicianId) moves.push({ visitId: id, from, to: t.technicianId });
    }
  }
  const sum = (days: RebalanceDay[], f: (e: ShiftEvaluation) => number) => days.reduce((n, d) => n + f(d.evaluation), 0);
  const changed = moves.length > 0
    || after.some((d, i) => d.evaluation.order.join() !== before[i]!.evaluation.order.join());

  return {
    before, after, moves, unplaced,
    driveBefore: sum(before, (e) => e.driveMinutes),
    driveAfter: sum(after, (e) => e.driveMinutes),
    overtimeBefore: sum(before, (e) => e.overtimeMinutes),
    overtimeAfter: sum(after, (e) => e.overtimeMinutes),
    changed,
  };
}

/**
 * Whether moving a visit between two people is worth the two notices it
 * costs. Anything that keeps a promise or a limit the plan breaks is; inside
 * those, less overtime is; otherwise only a real saving in driving.
 */
function worthMoving(now: Cost, was: Cost, minMove: number): boolean {
  const hard = compare(now, was, HARD);
  if (hard !== 0) return hard < 0;
  if (now.overtime !== was.overtime) return now.overtime < was.overtime;
  return was.drive - now.drive >= minMove;
}
