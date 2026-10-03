/**
 * THE ORDER OF A TECHNICIAN'S DAY, PROPOSED
 *
 * A suggestion, never a decision. Everything here returns a proposal and the
 * figures that justify it; applying one is the dispatcher pressing a button,
 * which goes through the same reorder path a drag does. A solver that moved
 * cards on its own would reorder a day around a customer the office promised
 * "first thing" on the phone, and nothing in the data would say so.
 *
 * WHAT IT RESPECTS, IN ORDER OF HOW MUCH IT CARES:
 *
 *   1. Arrival windows. A visit carries the window the customer was given,
 *      and arriving after it closes is a broken promise. Arriving before it
 *      opens is a wait, not a violation: the van sits outside.
 *   2. Fixed appointments, which are windows that open and close at the same
 *      minute, so they need no second mechanism. Work already under way or
 *      finished is not passed in at all; the plan starts from it.
 *   3. Drive time, which is what is being minimised once 1 and 2 hold.
 *
 * A WINDOW THAT CANNOT BE MET IS REPORTED, NEVER SILENTLY BROKEN. The
 * objective puts the number of late arrivals first and the minutes late
 * second, so the solver will drive further to keep a promise, and a plan
 * that still breaks one says which, by how much, and whether ANY order could
 * have kept it. "Nothing can get there by ten" and "this order gets there at
 * ten forty" are different conversations with the customer.
 *
 * HOW. Nearest neighbour construction in time rather than distance (the next
 * stop is the one work can start at soonest, so a nearby house whose window
 * opens at three does not pull the van across town to wait), then 2-opt and
 * or-opt improvement until neither finds anything better. First improvement,
 * scanned in a fixed order, with ties broken on the stop id: the same day in
 * gives the same order out, every time, which is what lets a dispatcher trust
 * the preview they were shown is the order they will get.
 *
 * NOTHING HERE KNOWS WHAT A KILOMETRE IS. Travel arrives as a function from
 * one key to another in minutes, so the service decides whether two stops use
 * the company's declared drive time from a route or an estimate from the
 * straight line between them, and this file only orders.
 */

export interface PlanStop {
  id: string;
  /** Minutes on site. */
  serviceMinutes: number;
  /** The arrival window, in minutes from the plan's origin. Null is any time. */
  windowStart: number | null;
  windowEnd: number | null;
}

/** Minutes of driving between two keys: a stop id, or the start and end keys. */
export type Travel = (from: string, to: string) => number;

export interface DayPlan {
  /** The key of where the day starts. */
  start: string;
  /** The key of where it ends, usually the same place. */
  end: string;
  /** When the van leaves the start, in the same minutes as the windows. */
  departAt: number;
  stops: readonly PlanStop[];
  travel: Travel;
}

export interface Arrival {
  id: string;
  arriveAt: number;
  /** When work starts, after any wait for the window to open. */
  startAt: number;
  leaveAt: number;
  /** Minutes after the window closed. Zero when on time. */
  lateBy: number;
}

export interface Evaluation {
  order: string[];
  driveMinutes: number;
  waitMinutes: number;
  /** Back at the end key. */
  finishAt: number;
  arrivals: Arrival[];
  late: { id: string; lateBy: number }[];
  lateMinutes: number;
}

/** Walk a day in a given order and say what it costs. */
export function evaluate(plan: DayPlan, order: readonly string[]): Evaluation {
  const byId = new Map(plan.stops.map((s) => [s.id, s]));
  let at = plan.start;
  let clock = plan.departAt;
  let drive = 0;
  let wait = 0;
  const arrivals: Arrival[] = [];
  for (const id of order) {
    const stop = byId.get(id);
    if (!stop) throw new RangeError(`${id} is not a stop in this plan.`);
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
  }
  const home = order.length === 0 ? 0 : plan.travel(at, plan.end);
  drive += home;
  const late = arrivals.filter((a) => a.lateBy > 0).map((a) => ({ id: a.id, lateBy: a.lateBy }));
  return {
    order: [...order],
    driveMinutes: drive,
    waitMinutes: wait,
    finishAt: clock + home,
    arrivals,
    late,
    lateMinutes: late.reduce((n, l) => n + l.lateBy, 0),
  };
}

/**
 * Better, as a strict order. Broken promises first, then how badly, then the
 * drive, then the time the day ends. Strict, so an improvement step never
 * swaps between two equally good orders forever.
 */
export function better(a: Evaluation, b: Evaluation): boolean {
  if (a.late.length !== b.late.length) return a.late.length < b.late.length;
  if (a.lateMinutes !== b.lateMinutes) return a.lateMinutes < b.lateMinutes;
  if (a.driveMinutes !== b.driveMinutes) return a.driveMinutes < b.driveMinutes;
  return a.finishAt < b.finishAt;
}

/**
 * Nearest neighbour in time.
 *
 * Of the stops still to do, the one whose window can still be met and where
 * work can start soonest; ties on the shorter drive, then the earlier
 * closing window, then the id. When none can be met any more, the one whose
 * window closed first, because it is the most late already and leaving it
 * makes it later.
 */
export function construct(plan: DayPlan): string[] {
  const remaining = [...plan.stops].sort((a, b) => a.id.localeCompare(b.id));
  const order: string[] = [];
  let at = plan.start;
  let clock = plan.departAt;
  while (remaining.length > 0) {
    let best: { index: number; begin: number; leg: number; closes: number } | null = null;
    let urgent: { index: number; closes: number } | null = null;
    for (const [index, stop] of remaining.entries()) {
      const leg = plan.travel(at, stop.id);
      const arrive = clock + leg;
      const closes = stop.windowEnd ?? Number.POSITIVE_INFINITY;
      if (arrive <= closes) {
        const begin = Math.max(arrive, stop.windowStart ?? arrive);
        if (
          !best
          || begin < best.begin
          || (begin === best.begin && leg < best.leg)
          || (begin === best.begin && leg === best.leg && closes < best.closes)
        ) {
          best = { index, begin, leg, closes };
        }
      } else if (!urgent || closes < urgent.closes) {
        urgent = { index, closes };
      }
    }
    const pick = best ?? urgent;
    const [stop] = remaining.splice(pick!.index, 1);
    const leg = plan.travel(at, stop!.id);
    const arrive = clock + leg;
    clock = Math.max(arrive, stop!.windowStart ?? arrive) + stop!.serviceMinutes;
    at = stop!.id;
    order.push(stop!.id);
  }
  return order;
}

/**
 * 2-opt and or-opt until neither finds anything.
 *
 * 2-opt reverses a run of stops, which undoes a route crossing itself.
 * Or-opt lifts a run of one to three stops and puts it somewhere else, which
 * is what moves a single out of the way house to the end of the day where it
 * belongs without disturbing the rest. Both are scanned in index order and
 * the first strict improvement is taken, so the result depends on nothing
 * but the input.
 *
 * Bounded, because a day of sixty stops is possible and a dispatcher waiting
 * on a preview is a person staring at a spinner. The bound is generous for a
 * service day and the result at the bound is still a valid order, just not
 * the last word.
 */
export function improve(
  plan: DayPlan, start: readonly string[], maxPasses = 200, pinned: ReadonlySet<string> = new Set(),
): Evaluation {
  let current = evaluate(plan, start);
  const n = start.length;
  /**
   * A stop a dispatcher locked keeps its place in the day: any candidate that
   * moves one is not a candidate. Checked on the order rather than built into
   * the moves, so 2-opt and or-opt stay the simple scans they are.
   */
  const at = new Map(start.map((id, i) => [id, i]));
  const keeps = (order: readonly string[]) =>
    pinned.size === 0 || order.every((id, i) => !pinned.has(id) || at.get(id) === i);
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;

    twoOpt: for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const order = [...current.order.slice(0, i), ...current.order.slice(i, j + 1).reverse(), ...current.order.slice(j + 1)];
        if (!keeps(order)) continue;
        const candidate = evaluate(plan, order);
        if (better(candidate, current)) {
          current = candidate;
          moved = true;
          break twoOpt;
        }
      }
    }
    if (moved) continue;

    orOpt: for (let length = 1; length <= Math.min(3, n - 1); length++) {
      for (let i = 0; i + length <= n; i++) {
        const segment = current.order.slice(i, i + length);
        const rest = [...current.order.slice(0, i), ...current.order.slice(i + length)];
        for (let k = 0; k <= rest.length; k++) {
          if (k === i) continue;
          const order = [...rest.slice(0, k), ...segment, ...rest.slice(k)];
          if (!keeps(order)) continue;
          const candidate = evaluate(plan, order);
          if (better(candidate, current)) {
            current = candidate;
            moved = true;
            break orOpt;
          }
        }
      }
    }
    if (!moved) break;
  }
  return current;
}

export interface Proposal {
  current: Evaluation;
  proposed: Evaluation;
  /** Whether the proposal is strictly better than what the day is now. */
  improved: boolean;
  /**
   * Windows the proposal still misses, with whether ANY order could have
   * kept them: one that cannot be reached in time even when driven to first,
   * straight from the start, is a promise that was broken when it was made.
   */
  missed: { id: string; lateBy: number; unreachable: boolean }[];
}

/**
 * The best order this can find, compared with the order the day has now.
 *
 * Improved from both the constructed order and the current one, and the
 * better of the two kept, so a day a dispatcher has already arranged well is
 * never handed back worse: if nothing beats it, the proposal IS the current
 * order and `improved` is false.
 */
export function optimise(
  plan: DayPlan, current: readonly string[], options: { pinned?: ReadonlySet<string> } = {},
): Proposal {
  const pinned = options.pinned ?? new Set<string>();
  const ids = new Set(plan.stops.map((s) => s.id));
  if (current.length !== ids.size || new Set(current).size !== current.length || current.some((id) => !ids.has(id))) {
    throw new RangeError("The current order must name every stop in the plan exactly once.");
  }
  const now = evaluate(plan, current);
  /**
   * Built from scratch only when nothing is locked: a constructed order puts
   * every stop wherever it likes, locked ones included, and improving from
   * it could never put them back.
   */
  const fromCurrent = improve(plan, current, 200, pinned);
  const fromScratch = pinned.size === 0 ? improve(plan, construct(plan)) : fromCurrent;
  let proposed = better(fromScratch, fromCurrent) ? fromScratch : fromCurrent;
  if (!better(proposed, now)) proposed = now;

  const byId = new Map(plan.stops.map((s) => [s.id, s]));
  const missed = proposed.late.map((l) => {
    const stop = byId.get(l.id)!;
    const direct = plan.departAt + plan.travel(plan.start, l.id);
    return { id: l.id, lateBy: l.lateBy, unreachable: stop.windowEnd !== null && direct > stop.windowEnd };
  });
  return { current: now, proposed, improved: proposed !== now, missed };
}

/* -------------------------------------------- who should take the rest */

export interface TechnicianDay {
  technicianId: string;
  start: string;
  end: string;
  departAt: number;
  /** In the order they are in now. */
  stops: PlanStop[];
}

export interface OpenVisit {
  stop: PlanStop;
  /**
   * Per technician, null when they may take it and the sentence saying why
   * not when they may not. A technician missing from the record has not been
   * asked and is not considered.
   */
  refusals: Record<string, string | null>;
}

export interface Considered {
  technicianId: string;
  /** Null when refused. */
  addedDriveMinutes: number | null;
  /** Whether putting it here makes something late that was not. */
  makesLate: boolean;
  refused: string | null;
}

export interface Suggestion {
  visitId: string;
  /** Null when nobody may take it. */
  technicianId: string | null;
  /** Where in their day, zero based, in the order the day would then have. */
  position: number | null;
  addedDriveMinutes: number | null;
  /** Late arrivals this would create on that technician's day, this visit included. */
  makesLate: { id: string; lateBy: number }[];
  considered: Considered[];
}

/**
 * Cheapest insertion, one visit at a time, earliest closing window first.
 *
 * Each open visit goes to the technician and position that adds the least
 * driving without making anybody late, and the next visit is placed against
 * the day as it would then be, so two suggestions never both count the same
 * gap. A technician who may not take it, because of skills or time off, is
 * listed with the reason rather than left out: "why not Dana" is the first
 * question a dispatcher asks of a suggestion.
 *
 * When every technician who may take it would be late, the least late is
 * still suggested and says so. Leaving it unsuggested would hide the one
 * visit on the board that most needs a person to look at it.
 */
export function suggestAssignments(input: {
  technicians: TechnicianDay[];
  visits: OpenVisit[];
  travel: Travel;
}): Suggestion[] {
  const days = new Map(input.technicians.map((t) => [t.technicianId, { ...t, stops: [...t.stops] }]));
  const ordered = [...input.visits].sort((a, b) =>
    (a.stop.windowEnd ?? Number.POSITIVE_INFINITY) - (b.stop.windowEnd ?? Number.POSITIVE_INFINITY)
    || (a.stop.windowStart ?? Number.POSITIVE_INFINITY) - (b.stop.windowStart ?? Number.POSITIVE_INFINITY)
    || a.stop.id.localeCompare(b.stop.id));

  const out: Suggestion[] = [];
  for (const open of ordered) {
    const considered: Considered[] = [];
    let best: {
      technicianId: string; position: number; added: number;
      makesLate: { id: string; lateBy: number }[]; newLate: number; lateMinutes: number;
    } | null = null;

    for (const technicianId of [...days.keys()].sort()) {
      if (!(technicianId in open.refusals)) continue;
      const refusal = open.refusals[technicianId] ?? null;
      if (refusal !== null) {
        considered.push({ technicianId, addedDriveMinutes: null, makesLate: false, refused: refusal });
        continue;
      }
      const day = days.get(technicianId)!;
      const plan = { start: day.start, end: day.end, departAt: day.departAt, travel: input.travel };
      const before = evaluate({ ...plan, stops: day.stops }, day.stops.map((s) => s.id));
      const withIt = [...day.stops, open.stop];

      let local: { position: number; evaluation: Evaluation } | null = null;
      for (let position = 0; position <= day.stops.length; position++) {
        const order = day.stops.map((s) => s.id);
        order.splice(position, 0, open.stop.id);
        const evaluation = evaluate({ ...plan, stops: withIt }, order);
        if (!local || better(evaluation, local.evaluation)) local = { position, evaluation };
      }
      const added = local!.evaluation.driveMinutes - before.driveMinutes;
      const newLate = local!.evaluation.late.length - before.late.length;
      considered.push({ technicianId, addedDriveMinutes: added, makesLate: newLate > 0, refused: null });

      const wasLate = new Set(before.late.map((l) => l.id));
      const candidate = {
        technicianId, position: local!.position, added,
        makesLate: local!.evaluation.late.filter((l) => !wasLate.has(l.id)), newLate,
        lateMinutes: local!.evaluation.lateMinutes - before.lateMinutes,
      };
      if (
        !best
        || candidate.newLate < best.newLate
        || (candidate.newLate === best.newLate && candidate.lateMinutes < best.lateMinutes)
        || (candidate.newLate === best.newLate && candidate.lateMinutes === best.lateMinutes && candidate.added < best.added)
      ) {
        best = candidate;
      }
    }

    if (!best) {
      out.push({
        visitId: open.stop.id, technicianId: null, position: null,
        addedDriveMinutes: null, makesLate: [], considered,
      });
      continue;
    }
    const day = days.get(best.technicianId)!;
    day.stops.splice(best.position, 0, open.stop);
    out.push({
      visitId: open.stop.id,
      technicianId: best.technicianId,
      position: best.position,
      addedDriveMinutes: best.added,
      makesLate: best.makesLate,
      considered,
    });
  }
  return out;
}

export * from "./rebalance.js";
