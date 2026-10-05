/**
 * HOW MANY MORE OF THIS WORK FIT IN ONE ARRIVAL WINDOW
 *
 * Online booking used to offer a window on the strength of one number the
 * company typed in, "how many per window", and nothing about who would go.
 * A Tuesday morning with every technician already full was offered as
 * readily as an empty one. This is the arithmetic that replaces it, from
 * the same facts the dispatch board shows: who is working, who is off,
 * who is qualified for this kind of work, and how much of each person's
 * window is already booked.
 *
 * The model, said plainly because a dispatcher will check it against their
 * own judgement:
 *
 *  - A technician's window is the time between its start and end, less the
 *    part of it already taken by visits on their day. A visit occupies from
 *    when it is due to arrive for its estimated length, so a three hour job
 *    arriving at eleven takes one hour of an eight to twelve window and two
 *    of the twelve to four.
 *  - Somebody away for any part of the window, or not qualified for the
 *    work, offers none of it.
 *  - Each person fits as many more of this job as their free time holds,
 *    whole jobs only. A job longer than the window needs the whole window.
 *  - Work already asked for and not yet on anybody's day (unassigned
 *    visits, booking requests waiting for the office, customers' requests to
 *    move into this window) comes off the total first, because it will need
 *    somebody too.
 *
 * The company's own per window limit stays as a ceiling on top of this: it
 * is how many it is willing to sell online, which can be fewer than it could
 * staff. Pure: no database, no clock it was not handed.
 */

export interface Span {
  start: Date;
  end: Date;
}

export interface Occupied {
  start: Date;
  minutes: number;
}

const MINUTE = 60_000;

/** Minutes of a window that a set of visits take up, each clipped to the window. */
export function occupiedMinutes(window: Span, visits: readonly Occupied[]): number {
  let total = 0;
  for (const visit of visits) {
    const start = Math.max(visit.start.getTime(), window.start.getTime());
    const end = Math.min(visit.start.getTime() + Math.max(visit.minutes, 0) * MINUTE, window.end.getTime());
    if (end > start) total += (end - start) / MINUTE;
  }
  return total;
}

export interface TechnicianWindow {
  id: string;
  /** Visits on their day, which take time out of the window where they overlap it. */
  busy: readonly Occupied[];
  /** Approved time off touching the window. */
  away: boolean;
  /** Refused for this work's required skills. Unknown skills do not refuse. */
  qualified: boolean;
}

export interface WindowCapacity {
  /** Jobs of this length that still fit, across everybody, after work waiting for somebody. */
  jobs: number;
  /**
   * Jobs of this length the window holds with nothing booked in it, across
   * everybody working and qualified: what a share of the window is a share of.
   */
  whole: number;
  /** Jobs each person could still take on their own, before the waiting work. */
  byTechnician: Map<string, number>;
}

export function windowCapacity(input: {
  window: Span;
  durationMinutes: number;
  technicians: readonly TechnicianWindow[];
  /** Minutes of work asked for in this window that nobody holds yet. */
  waitingMinutes: number;
}): WindowCapacity {
  const length = Math.max((input.window.end.getTime() - input.window.start.getTime()) / MINUTE, 0);
  const byTechnician = new Map<string, number>();
  if (length === 0) return { jobs: 0, whole: 0, byTechnician };
  const size = Math.max(Math.min(input.durationMinutes, length), 1);

  let supply = 0;
  let whole = 0;
  for (const person of input.technicians) {
    if (person.away || !person.qualified) {
      byTechnician.set(person.id, 0);
      continue;
    }
    const free = Math.max(length - occupiedMinutes(input.window, person.busy), 0);
    const fits = Math.floor(free / size + 1e-9);
    byTechnician.set(person.id, fits);
    supply += fits;
    whole += Math.floor(length / size + 1e-9);
  }
  const waiting = Math.ceil(Math.max(input.waitingMinutes, 0) / size - 1e-9);
  return { jobs: Math.max(supply - waiting, 0), whole, byTechnician };
}

/* --------------------------------------------------------- a route's stops */

export interface RouteStopWork {
  id: string;
  routeId: string;
  /** The company's calendar day the stop is on. */
  day: string;
  /** Its place in the route's order. Null sorts last, by id. */
  order: number | null;
  /** The window's start, which for a route stop is the start of the working day. */
  start: Date;
  minutes: number;
}

/**
 * WHEN EACH OF A ROUTE'S STOPS ACTUALLY HAPPENS, for counting a day's time.
 *
 * A route sells a day and a place in the order, so every stop is written
 * with the working day as its window. Each stop on a route's day starts
 * when the one before it finished plus the route's drive between stops,
 * from the earliest window start among them, and the drive to it is time
 * the person is busy too: a stop occupies from when they leave the last
 * one. Returns each stop's busy stretch by id. Deterministic: order, then
 * id.
 */
export function layRouteStops(
  stops: readonly RouteStopWork[],
  driveMinutes: (routeId: string) => number,
): Map<string, Occupied> {
  const groups = new Map<string, RouteStopWork[]>();
  for (const stop of stops) {
    const key = `${stop.routeId}|${stop.day}`;
    groups.set(key, [...(groups.get(key) ?? []), stop]);
  }
  const out = new Map<string, Occupied>();
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
    const drive = Math.max(driveMinutes(sorted[0]!.routeId), 0);
    let at = Math.min(...sorted.map((s) => s.start.getTime()));
    for (const [i, stop] of sorted.entries()) {
      const leg = i > 0 ? drive : 0;
      out.set(stop.id, { start: new Date(at), minutes: leg + Math.max(stop.minutes, 0) });
      at += (leg + Math.max(stop.minutes, 0)) * MINUTE;
    }
  }
  return out;
}

/* ------------------------------------------------- capacity held for members */

/**
 * A SHARE OF EACH WINDOW KEPT FOR MEMBERS, UNTIL IT IS TOO LATE TO MATTER
 *
 * A plan that promises priority dispatch is a promise that a member who
 * calls on Monday is seen this week, and an online calendar that sold every
 * window of the week to strangers on Sunday night has broken it before the
 * member picked up the phone. So a company can hold a share of each window
 * back from anybody who is not a member, and let it go a set number of
 * hours before the window opens, when an empty slot is worth more to the
 * company than the member it might have been for.
 *
 * The share is of the whole window (`whole`, what it holds with nothing
 * booked), rounded to the nearest whole job with a half rounded down, so a
 * quarter of a window that holds two jobs holds none back and of one that
 * holds four holds one: a hold never takes half of a small window.
 * Members' own work booked into the window uses the hold up first: once
 * members have taken their share, nothing more is kept from anybody.
 */
export interface MemberHold {
  /** The share of each window held for members, from 0 to 1. */
  share: number;
  /** Hours before a window opens when what is still held is let go to anybody. */
  releaseHours: number;
}

/** Jobs in a window still kept back from somebody who is not a member. */
export function heldForMembers(input: {
  hold: MemberHold;
  /** What the window holds with nothing booked. */
  whole: number;
  /** Jobs of this length' worth of members' work already in the window. */
  memberJobs: number;
  opensAt: Date;
  now: Date;
}): number {
  const share = Math.min(Math.max(input.hold.share, 0), 1);
  const releasedAt = input.opensAt.getTime() - Math.max(input.hold.releaseHours, 0) * 3_600_000;
  if (share === 0 || input.now.getTime() >= releasedAt) return 0;
  const reserved = Math.max(Math.ceil(input.whole * share - 0.5 - 1e-9), 0);
  return Math.max(reserved - Math.max(input.memberJobs, 0), 0);
}
