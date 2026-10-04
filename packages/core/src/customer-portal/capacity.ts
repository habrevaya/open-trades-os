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

/**
 * Jobs in a window still kept back from whoever is booking.
 *
 * `hold.share` is the largest share any live plan holds. Somebody who is not
 * a member is kept out of all of what is still held. A member is kept out of
 * only the part above what their own plan holds (`ownShare`), so a plan that
 * holds a tenth lets its members into a tenth of the window and no further
 * into the third a dearer plan keeps for its own.
 */
export function heldForMembers(input: {
  hold: MemberHold;
  /** What the window holds with nothing booked. */
  whole: number;
  /** Jobs of this length' worth of members' work already in the window. */
  memberJobs: number;
  opensAt: Date;
  now: Date;
  /** The share the booker's own plan holds, 0 to 1. Absent or 0 for somebody who is not a member. */
  ownShare?: number | undefined;
}): number {
  const share = Math.min(Math.max(input.hold.share, 0), 1);
  const releasedAt = input.opensAt.getTime() - Math.max(input.hold.releaseHours, 0) * 3_600_000;
  if (share === 0 || input.now.getTime() >= releasedAt) return 0;
  const jobsOf = (fraction: number) => Math.max(Math.ceil(input.whole * fraction - 0.5 - 1e-9), 0);
  const reserved = jobsOf(share);
  const own = Math.min(jobsOf(Math.min(Math.max(input.ownShare ?? 0, 0), 1)), reserved);
  const stillHeld = Math.max(reserved - Math.max(input.memberJobs, 0), 0);
  return Math.max(stillHeld - own, 0);
}
