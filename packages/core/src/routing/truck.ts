/**
 * A ROLL OFF DRIVER'S DAY, ORDERED BY WHAT IS ON THE TRUCK
 *
 * The dumpster pack says it in its own job types: the order of a driver's
 * day is decided by what is on the truck and what has to come back on it.
 * A drop needs an empty container on the truck. A collection needs room on
 * it, and once the full can is hooked the truck goes to the yard to tip it
 * before it can take anything else. A swap needs an empty on the truck and
 * leaves with a full one. `optimise` knows none of that: it would happily
 * send a driver from a collection straight to a drop with a full can on the
 * hook and nothing to drop.
 *
 * THE MODEL, said plainly because a dispatcher will check it by hand:
 *
 *  - The truck carries `capacity` containers (one for nearly every roll off
 *    truck, two or three for a hook lift moving small cans).
 *  - At the yard everything full is tipped and the truck is loaded with as
 *    many empties as lets it work through the most of the stops that follow
 *    before it has to come back; the fewest that does so on a tie.
 *  - A stop the truck cannot serve as it is (a drop with no empty on board,
 *    a collection with no room) is reached by way of the yard, and the yard
 *    run's drive and its minutes there count like any other drive.
 *  - A dump and return needs room for the can and brings the same can back;
 *    its trip to the facility is inside the job's own length, as the pack's
 *    seventy five minutes are, and is not counted twice.
 *  - The day ends at the yard, so a full can on board at the end is tipped.
 *
 * The search is `optimise`'s own (nearest neighbour in time, then 2-opt and
 * or-opt, windows first and driving second, deterministic), walking each
 * candidate order through this arithmetic instead of the plain one. Still a
 * proposal: applying it is the ordinary reorder, and the yard runs are said
 * on the proposal for the driver rather than written as stops.
 */

import { better, improve, type DayPlan, type Evaluation, type PlanStop } from "./index.js";

/** What a stop does to the truck. `none` is any other work on the day. */
export type TruckWork = "drop" | "pickup" | "swap" | "dump_return" | "none";

export interface TruckStop extends PlanStop {
  work: TruckWork;
}

export interface TruckLoad {
  /** Empty containers on the truck, ready to drop. */
  empties: number;
  /** Full containers on the truck, to tip at the yard. */
  fulls: number;
}

export interface TruckPlan extends DayPlan {
  stops: readonly TruckStop[];
  /** The key of the yard: where empties are loaded and full cans tipped. */
  yard: string;
  /** Containers the truck carries at once. At least one. */
  capacity: number;
  /** Minutes at the yard to tip what is full and load what is needed. */
  yardMinutes: number;
  /**
   * What is on the truck as the plan starts. Null when the day starts at
   * the yard, where it is loaded for the stops that follow.
   */
  load: TruckLoad | null;
}

export interface YardRun {
  /** The stop before the run, or null when the truck goes straight from where the plan starts. */
  afterId: string | null;
  /** The stop it is for, or null for the run at the end of the day. */
  beforeId: string | null;
  /** Full containers tipped. */
  tipped: number;
  /** Empties loaded, or left at the yard when negative. */
  loaded: number;
  arriveAt: number;
}

export interface TruckEvaluation extends Evaluation {
  yardRuns: YardRun[];
  /** What the truck leaves with in the morning. */
  startLoad: TruckLoad;
}

/** Whether the truck as it is can serve a stop. */
export function canServe(work: TruckWork, load: TruckLoad, capacity: number): boolean {
  switch (work) {
    case "drop":
    case "swap":
      return load.empties >= 1;
    case "pickup":
    case "dump_return":
      return load.empties + load.fulls < capacity;
    default:
      return true;
  }
}

/** The truck after a stop it could serve. */
export function afterStop(work: TruckWork, load: TruckLoad): TruckLoad {
  switch (work) {
    case "drop": return { empties: load.empties - 1, fulls: load.fulls };
    case "swap": return { empties: load.empties - 1, fulls: load.fulls + 1 };
    case "pickup": return { empties: load.empties, fulls: load.fulls + 1 };
    default: return load;
  }
}

/**
 * How many empties to leave the yard with: the number that serves the most
 * of the stops that follow before the truck has to come back, and the
 * fewest that does so. Counting stops rather than looking further is enough
 * for a truck of one to four cans, and it is what a driver does.
 */
export function loadFor(works: readonly TruckWork[], capacity: number): number {
  let best = { empties: 0, served: -1 };
  for (let empties = 0; empties <= capacity; empties++) {
    let load: TruckLoad = { empties, fulls: 0 };
    let served = 0;
    for (const work of works) {
      if (!canServe(work, load, capacity)) break;
      load = afterStop(work, load);
      served += 1;
    }
    if (served > best.served) best = { empties, served };
  }
  return best.empties;
}

/** Walk a day in a given order with the truck, and say what it costs. */
export function evaluateTruck(plan: TruckPlan, order: readonly string[]): TruckEvaluation {
  const capacity = Math.max(1, Math.floor(plan.capacity));
  const byId = new Map(plan.stops.map((s) => [s.id, s]));
  const works = order.map((id) => {
    const stop = byId.get(id);
    if (!stop) throw new RangeError(`${id} is not a stop in this plan.`);
    return stop.work;
  });

  const startLoad: TruckLoad = plan.load ?? { empties: loadFor(works, capacity), fulls: 0 };
  let load = startLoad;
  let at = plan.start;
  let previous: string | null = null;
  let clock = plan.departAt;
  let drive = 0;
  let wait = 0;
  const arrivals: Evaluation["arrivals"] = [];
  const yardRuns: YardRun[] = [];

  const toYard = (beforeId: string | null, upcoming: readonly TruckWork[]) => {
    const leg = plan.travel(at, plan.yard);
    drive += leg;
    clock += leg;
    const arriveAt = clock;
    const empties = upcoming.length > 0 ? loadFor(upcoming, capacity) : 0;
    yardRuns.push({ afterId: previous, beforeId, tipped: load.fulls, loaded: empties - load.empties, arriveAt });
    clock += plan.yardMinutes;
    load = { empties, fulls: 0 };
    at = plan.yard;
  };

  for (const [index, id] of order.entries()) {
    const stop = byId.get(id)!;
    if (!canServe(stop.work, load, capacity)) toYard(id, works.slice(index));
    const leg = plan.travel(at, id);
    drive += leg;
    const arriveAt = clock + leg;
    const startAt = stop.windowStart !== null && arriveAt < stop.windowStart ? stop.windowStart : arriveAt;
    wait += startAt - arriveAt;
    const lateBy = stop.windowEnd !== null && arriveAt > stop.windowEnd ? arriveAt - stop.windowEnd : 0;
    const leaveAt = startAt + stop.serviceMinutes;
    arrivals.push({ id, arriveAt, startAt, leaveAt, lateBy });
    clock = leaveAt;
    at = id;
    previous = id;
    load = afterStop(stop.work, load);
  }

  /**
   * Home, and a full can still on the hook is tipped first: at the yard when
   * the day ends there, by way of it when it does not.
   */
  const tipAtEnd = order.length > 0 && load.fulls > 0;
  if (tipAtEnd && plan.end !== plan.yard) toYard(null, []);
  const home = order.length === 0 ? 0 : plan.travel(at, plan.end);
  drive += home;
  if (tipAtEnd && plan.end === plan.yard) {
    yardRuns.push({ afterId: previous, beforeId: null, tipped: load.fulls, loaded: 0, arriveAt: clock + home });
    clock += plan.yardMinutes;
  }

  const late = arrivals.filter((a) => a.lateBy > 0).map((a) => ({ id: a.id, lateBy: a.lateBy }));
  return {
    order: [...order],
    driveMinutes: drive,
    waitMinutes: wait,
    finishAt: clock + home,
    arrivals,
    late,
    lateMinutes: late.reduce((n, l) => n + l.lateBy, 0),
    yardRuns,
    startLoad,
  };
}

/**
 * Nearest neighbour in time, with the truck: of the stops still to do, the
 * one where work can start soonest, counting the run to the yard first when
 * the truck as it stands cannot serve it.
 */
export function constructTruck(plan: TruckPlan): string[] {
  const capacity = Math.max(1, Math.floor(plan.capacity));
  const remaining = [...plan.stops].sort((a, b) => a.id.localeCompare(b.id));
  const order: string[] = [];
  let at = plan.start;
  let clock = plan.departAt;
  let load: TruckLoad = plan.load ?? { empties: loadFor(remaining.map((s) => s.work), capacity), fulls: 0 };
  while (remaining.length > 0) {
    let best: { index: number; begin: number; leg: number; closes: number; viaYard: boolean } | null = null;
    let urgent: { index: number; closes: number; viaYard: boolean } | null = null;
    for (const [index, stop] of remaining.entries()) {
      const viaYard = !canServe(stop.work, load, capacity);
      const leg = viaYard
        ? plan.travel(at, plan.yard) + plan.yardMinutes + plan.travel(plan.yard, stop.id)
        : plan.travel(at, stop.id);
      const arrive = clock + leg;
      const closes = stop.windowEnd ?? Number.POSITIVE_INFINITY;
      if (arrive <= closes) {
        const begin = Math.max(arrive, stop.windowStart ?? arrive);
        if (!best || begin < best.begin || (begin === best.begin && leg < best.leg)
          || (begin === best.begin && leg === best.leg && closes < best.closes)) {
          best = { index, begin, leg, closes, viaYard };
        }
      } else if (!urgent || closes < urgent.closes) {
        urgent = { index, closes, viaYard };
      }
    }
    const pick = (best ?? urgent)!;
    const [stop] = remaining.splice(pick.index, 1);
    if (pick.viaYard) {
      const works = [stop!.work, ...remaining.map((s) => s.work)];
      load = { empties: loadFor(works, capacity), fulls: 0 };
      clock += plan.travel(at, plan.yard) + plan.yardMinutes;
      at = plan.yard;
    }
    const leg = plan.travel(at, stop!.id);
    const arrive = clock + leg;
    clock = Math.max(arrive, stop!.windowStart ?? arrive) + stop!.serviceMinutes;
    at = stop!.id;
    load = afterStop(stop!.work, load);
    order.push(stop!.id);
  }
  return order;
}

export interface TruckProposal {
  current: TruckEvaluation;
  proposed: TruckEvaluation;
  improved: boolean;
  missed: { id: string; lateBy: number; unreachable: boolean }[];
}

/**
 * The best order this can find for a driver's day, with the yard runs it
 * needs, compared with the order the day has now. Never handed back worse:
 * when nothing beats the current order, the proposal is the current order.
 */
export function optimiseTruck(
  plan: TruckPlan, current: readonly string[], options: { pinned?: ReadonlySet<string> } = {},
): TruckProposal {
  const pinned = options.pinned ?? new Set<string>();
  const ids = new Set(plan.stops.map((s) => s.id));
  if (current.length !== ids.size || new Set(current).size !== current.length || current.some((id) => !ids.has(id))) {
    throw new RangeError("The current order must name every stop in the plan exactly once.");
  }
  const now = evaluateTruck(plan, current);
  const fromCurrent = improve(plan, current, 200, pinned, evaluateTruck);
  const fromScratch = pinned.size === 0 ? improve(plan, constructTruck(plan), 200, new Set(), evaluateTruck) : fromCurrent;
  const chosen = better(fromScratch, fromCurrent) ? fromScratch : fromCurrent;
  const proposed = better(chosen, now) ? evaluateTruck(plan, chosen.order) : now;

  const byId = new Map(plan.stops.map((s) => [s.id, s]));
  const missed = proposed.late.map((l) => {
    const stop = byId.get(l.id)!;
    const direct = plan.departAt + plan.travel(plan.start, l.id);
    return { id: l.id, lateBy: l.lateBy, unreachable: stop.windowEnd !== null && direct > stop.windowEnd };
  });
  return { current: now, proposed, improved: proposed !== now, missed };
}
