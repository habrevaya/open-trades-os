import { type Money, add, subtract, zero, toString, isZero } from "../money/index.js";
import { dateIn } from "../time/index.js";
import { distanceKm } from "../location/index.js";

/**
 * THE DEFINITIONS BEHIND THE TRADE SCORECARD, AS PURE RULES
 *
 * The scorecard counts in SQL (`services/kpi-catalogue.ts`), because it counts
 * thousands of records. What a number MEANS is decided here, in plain
 * functions with no database, so that a definition can be read and tested on
 * its own, and so an integration test can hold the SQL to it: the rows that
 * test seeds are put through these functions as well, and the two answers must
 * be the same.
 *
 * Five rules live here.
 *
 *   HOW TWO HALVES BECOME ONE NUMBER. A zero denominator is nothing to measure
 *   and not nought: nought per cent close rate says every estimate was lost.
 *
 *   A CREW DAY. Taken from the crew's own clock and not from the roster, one
 *   per crew per day however many people are on it, and never a day the crew
 *   completed no stop or only spent in the yard.
 *
 *   AN INSTALL'S MARGIN. Install revenue less material, subcontract, disposal
 *   and burdened labour, counted only over installs whose costs are all in.
 *
 *   A PERMITTED JOB'S FIRST INSPECTION. Signed off first time only when no
 *   inspection on it failed for our work, and left out when it failed only for
 *   somebody else's.
 *
 *   A ROUTE DAY'S MILES. Driven between stops, never to the first or home from
 *   the last, and not counted at all when the phone's positions have a gap.
 */

export type KpiFormat = "percent" | "money" | "number" | "duration";

/**
 * How two scalars become the number on the screen.
 *
 * A zero denominator is NULL and never zero. Nought per cent close rate says
 * every estimate lost; no estimates presented says there is nothing to
 * measure, and those are different months with different answers. This
 * codebase has made the same choice in `utilisation`, `reachRate` and
 * `overageCapture`, and it is the same reason each time.
 */
export function combine(format: KpiFormat, numerator: number, denominator: number): string | null {
  if (denominator === 0) return null;
  switch (format) {
    case "percent":
      return ((numerator / denominator) * 100).toFixed(1);
    case "money":
      /**
       * Four decimal places, as every money column in this schema is. A figure
       * rounded to cents here and summed elsewhere would not reconcile against
       * the ledger it came from.
       */
      return (numerator / denominator).toFixed(4);
    case "duration":
    case "number":
      return (numerator / denominator).toFixed(2);
  }
}

/* ------------------------------------------------------------- crew days */

/**
 * The time entry kinds that are not a day worked at all: leave, a holiday,
 * training and an unpaid break. The same list for a technician's day and a
 * crew's, so the two cannot drift.
 */
export const NOT_A_DAY_WORKED = ["pto", "holiday", "training", "unpaid_break"] as const;

/**
 * Time that is not a CREW'S day: everything above, and the shop. "EXCLUDES yard
 * time, shop days and rain days" is the definition of revenue per crew day, and
 * a technician's day on the clock is a different question (a shop day is paid
 * time that counts as capacity there), which is why this is a longer list and
 * not the same one.
 */
export const NOT_A_CREW_DAY = [...NOT_A_DAY_WORKED, "shop"] as const;

export interface CrewVisit {
  id: string;
  /** The crew the visit was sent to, when it was sent to one. */
  crewId: string | null;
  status: string;
  completedAt: Date | null;
}

export interface ClockPunch {
  /** The visit the person punched in on. A punch on no visit belongs to no crew. */
  visitId: string | null;
  kind: string;
  startedAt: Date;
}

/**
 * The days a crew worked, in the company's calendar: one per crew per day.
 *
 * A crew day needs BOTH of these, and the second is the whole of "rain days
 * where no stop was completed":
 *
 *   somebody on the crew was on the clock, on the crew's own visit, in a kind
 *   of time that is a crew's day (not the shop, not leave): the crew clock,
 *   rather than the roster, which would count a crew on its day off;
 *
 *   and the crew completed a stop that day. A day of rain, or one spent in the
 *   yard, has punches and no stop, and counting it makes a washed out week
 *   look like a productivity collapse.
 *
 * ONE PER CREW, WHATEVER ITS SIZE. Counted per person, a four person crew is
 * four days and revenue per crew day reports a quarter of the truth.
 */
export function crewDays(input: {
  visits: readonly CrewVisit[];
  punches: readonly ClockPunch[];
  zone: string;
}): { crewId: string; day: string }[] {
  const crewOf = new Map<string, string>();
  const completedDays = new Set<string>();
  for (const visit of input.visits) {
    if (!visit.crewId) continue;
    crewOf.set(visit.id, visit.crewId);
    if (visit.status === "completed" && visit.completedAt) {
      completedDays.add(`${visit.crewId}|${dateIn(visit.completedAt, input.zone)}`);
    }
  }

  const found = new Set<string>();
  for (const punch of input.punches) {
    if ((NOT_A_CREW_DAY as readonly string[]).includes(punch.kind)) continue;
    const crew = punch.visitId ? crewOf.get(punch.visitId) : undefined;
    if (!crew) continue;
    const key = `${crew}|${dateIn(punch.startedAt, input.zone)}`;
    if (completedDays.has(key)) found.add(key);
  }
  return [...found].sort().map((key) => {
    const [crewId, day] = key.split("|") as [string, string];
    return { crewId, day };
  });
}

/* ---------------------------------------------------------- install margin */

export interface InstallJob {
  revenue: Money;
  /** What its lines cost, and the cost of goods sold posted to it, journals included. */
  material: Money;
  /** Hours at the loaded rate frozen on each punch. */
  labour: Money;
  /** Payroll taxes, benefits and workers' compensation at the company's own rates. */
  burden: Money;
  /** Every fact that makes the cost of the job unfinished. All zero or true on a job whose costs are in. */
  openPunches: number;
  unpricedLabourHours: number;
  /** Work consumed that is neither billed nor marked non-billable, so revenue may still be coming. */
  undecidedLines: number;
  /** Lines consumed with no cost recorded: unknown, not zero. */
  uncostedLines: number;
  labourRecorded: boolean;
}

/**
 * Whether a job's cost is all in, which is the only kind of install an install
 * margin may be read from.
 *
 * The same four things the job's own statement names as reasons its margin is
 * "still moving" (a punch running, hours nothing could price, work nobody has
 * billed or written off, a line with no cost) and a fifth it names separately:
 * no hours recorded at all, so labour is zero because nobody measured it. An
 * install with any of them is LEFT OUT OF BOTH HALVES. Counted, its margin is
 * too high by an amount nobody can state, and the installs where that is most
 * likely (a subcontractor nobody has recorded yet) are the ones an owner is
 * checking.
 */
export function costsAreIn(job: InstallJob): boolean {
  return job.labourRecorded && job.openPunches === 0 && job.unpricedLabourHours === 0
    && job.undecidedLines === 0 && job.uncostedLines === 0;
}

/** What one install earned: revenue less material, labour and burden. Overhead is not in the definition. */
export function installEarned(job: InstallJob): Money {
  return subtract(subtract(subtract(job.revenue, job.material), job.labour), job.burden);
}

/**
 * Install gross margin over a set of completed installs: the two halves, and
 * the percentage, which is null over no install revenue.
 */
export function installMargin(jobs: readonly InstallJob[]): {
  jobs: number; earned: Money; revenue: Money; percent: string | null;
} {
  const counted = jobs.filter(costsAreIn);
  const currency = counted[0]?.revenue.currency ?? "USD";
  let earned = zero(currency);
  let revenue = zero(currency);
  for (const job of counted) {
    earned = add(earned, installEarned(job));
    revenue = add(revenue, job.revenue);
  }
  return {
    jobs: counted.length,
    earned,
    revenue,
    percent: isZero(revenue) ? null : combine("percent", Number(toString(earned)), Number(toString(revenue))),
  };
}

/* ------------------------------------------------- first time inspection pass */

export interface PermitVisit {
  jobId: string;
  /** The day the inspector came, `YYYY-MM-DD`. */
  inspectedOn: string;
  result: "passed" | "failed";
  /** Whose work a fail was about. Null on a pass. */
  failureScope: "our_work" | "outside_our_work" | null;
}

/**
 * Where a permitted job lands in the first time inspection pass rate.
 *
 * "Permitted jobs signed off on the first inspection divided by all permitted
 * jobs inspected, EXCLUDING jobs failed for something outside the electrical
 * scope."
 *
 *   `failed`   an inspection on it failed for our work, at any stage. The
 *              strict reading, and the conservative one: a rough in that
 *              passed and a final that failed for our work is not a job
 *              signed off first time.
 *   `excluded` none failed for our work and one failed for something outside
 *              it. Out of both halves, and counted beside the figure so the
 *              exclusion cannot quietly grow.
 *   `passed`   every inspection on it passed the first time it was made.
 *
 * A job failed for our work AND for somebody else's is `failed`: the crew's
 * miss is in it, which is the thing the number exists to show.
 */
export type PermitVerdict = "passed" | "failed" | "excluded";

export function permitVerdict(visits: readonly Pick<PermitVisit, "result" | "failureScope">[]): PermitVerdict | null {
  if (visits.length === 0) return null;
  if (visits.some((v) => v.result === "failed" && v.failureScope === "our_work")) return "failed";
  if (visits.some((v) => v.result === "failed")) return "excluded";
  return "passed";
}

/**
 * The jobs a window counts: each permitted job ONCE, on the day of its first
 * inspection, with its verdict over every inspection recorded on it by now.
 * So a failure recorded later on a job first inspected last month counts
 * against last month, where the job is, rather than not at all.
 */
export function inspectionPass(visits: readonly PermitVisit[], window: { from: string; to: string }): {
  passed: string[]; failed: string[]; excluded: string[];
} {
  const byJob = new Map<string, PermitVisit[]>();
  for (const visit of visits) byJob.set(visit.jobId, [...(byJob.get(visit.jobId) ?? []), visit]);
  const out = { passed: [] as string[], failed: [] as string[], excluded: [] as string[] };
  for (const [jobId, own] of [...byJob.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = own.map((v) => v.inspectedOn).sort()[0]!;
    if (first < window.from || first > window.to) continue;
    const verdict = permitVerdict(own)!;
    out[verdict].push(jobId);
  }
  return out;
}

/* ---------------------------------------------------------- route miles */

export interface RouteFix {
  at: Date;
  lat: number;
  lng: number;
}

export interface RouteStop {
  /** When the person arrived, and when the stop was completed. */
  arrivedAt: Date;
  completedAt: Date;
}

export interface RouteDaySummary {
  /** Completed stops with an arrival time, on the day. */
  stops: number;
  /** Drives between one stop and the next that were measured. */
  drives: number;
  /** Miles driven between the first stop and the last, to three places. */
  miles: number;
  /** Positions read. */
  fixes: number;
  /**
   * `counted` when every drive between stops is covered by positions.
   * `gap` when one is not: the phone was off or out of signal for longer
   * than the company's positions are taken, or there is no position near
   * one end of a drive. A gap's miles are not kept, because a straight line
   * over a stretch nobody saw is shorter than the road.
   */
  status: "counted" | "gap";
  /** For a gap, which drive and why, in words. */
  note: string | null;
}

const KM_PER_MILE = 1.609344;

/**
 * THE LONGEST TWO POSITIONS MAY BE APART ON A DRIVE and still be read as
 * the road between them: three of the company's intervals, and never less
 * than fifteen minutes, so a phone that slows its fixes in a pocket is not a
 * gap and an hour with the phone off is.
 */
export function routeGapSeconds(intervalSeconds: number): number {
  return Math.max(15 * 60, 3 * intervalSeconds);
}

/**
 * MILES DRIVEN BETWEEN STOPS, FROM THE PHONE'S POSITIONS, for one person's day.
 *
 * Route density divides completed stops by route miles and EXCLUDES "the drive
 * from the yard to the first stop and back from the last". So the miles are the
 * drives BETWEEN stops: from each stop's completion to the next stop's arrival,
 * in the order the person arrived at them. The way out and the way home are
 * outside every drive and are never read.
 *
 * Each drive is the path through its positions, with the last position at or
 * before it set off and the first at or after it arrived as its two ends, and
 * the distance between two positions is the straight line between them. Taken
 * every minute or so on a road, that is the road to within a few per cent, and
 * slightly short of it on a winding one, which makes the density read a little
 * high rather than low; the doc says so.
 *
 * A DAY WITH A GAP IS NOT COUNTED. When two positions on a drive are further
 * apart than `gapSeconds`, or there is no position within it of either end of a
 * drive, the straight line across the gap would be shorter than the road, and
 * the day would read as a tighter route than it was. Its miles are dropped and
 * the day is marked `gap`, so a month's figure is over the days that were seen
 * whole, and says how many were not.
 *
 * Fewer than two stops is no route at all and is answered null: one stop has no
 * drive between stops, and counting it would add a stop over no miles.
 */
export function routeDay(input: {
  fixes: readonly RouteFix[];
  stops: readonly RouteStop[];
  gapSeconds: number;
  /** The company's timezone, for the times a gap's note names. */
  zone: string;
}): RouteDaySummary | null {
  const stops = [...input.stops]
    .filter((s) => s.completedAt.getTime() >= s.arrivedAt.getTime())
    .sort((a, b) => a.arrivedAt.getTime() - b.arrivedAt.getTime());
  if (stops.length < 2) return null;
  const fixes = [...input.fixes].sort((a, b) => a.at.getTime() - b.at.getTime());
  const gap = input.gapSeconds * 1000;
  const clock = (at: Date) => new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: input.zone,
  }).format(at);

  let km = 0;
  let drives = 0;
  for (let i = 0; i + 1 < stops.length; i += 1) {
    const leaves = stops[i]!.completedAt.getTime();
    const arrives = stops[i + 1]!.arrivedAt.getTime();
    const gapAt = (note: string): RouteDaySummary => ({
      stops: stops.length, drives, miles: 0, fixes: fixes.length, status: "gap", note,
    });
    /**
     * A stop begun before the one before it was closed: nobody is at two
     * places at once, so one of the two times is wrong and the drive between
     * them cannot be placed. Not counted, rather than read as no miles.
     */
    if (arrives < leaves) {
      return gapAt(`The stop begun at ${clock(stops[i + 1]!.arrivedAt)} was begun before the one before it was closed, so the drive between them cannot be placed.`);
    }
    drives += 1;
    const before = fixes.filter((f) => f.at.getTime() <= leaves).at(-1);
    const after = fixes.find((f) => f.at.getTime() >= arrives);
    if (!before || leaves - before.at.getTime() > gap) {
      return gapAt(`No position near the start of the drive that set off at ${clock(stops[i]!.completedAt)}.`);
    }
    if (!after || after.at.getTime() - arrives > gap) {
      return gapAt(`No position near the end of the drive that arrived at ${clock(stops[i + 1]!.arrivedAt)}.`);
    }
    const path = [before, ...fixes.filter((f) => f.at.getTime() > leaves && f.at.getTime() < arrives), after];
    for (let j = 1; j < path.length; j += 1) {
      const a = path[j - 1]!;
      const b = path[j]!;
      if (b.at.getTime() - a.at.getTime() > gap) {
        return gapAt(`No position between ${clock(a.at)} and ${clock(b.at)} on a drive between stops.`);
      }
      km += distanceKm(a, b);
    }
  }
  return {
    stops: stops.length,
    drives,
    miles: Math.round((km / KM_PER_MILE) * 1000) / 1000,
    fixes: fixes.length,
    status: "counted",
    note: null,
  };
}
