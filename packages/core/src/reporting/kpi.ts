import { type Money, add, subtract, zero, toString, isZero } from "../money/index.js";
import { dateIn } from "../time/index.js";

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
 * Three rules live here.
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
 *   A FIRST TIME FIX. A completed job done in one visit, with the jobs that
 *   were planned as several visits, or held for a part order, left out.
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

/* --------------------------------------------------------- first time fix */

/**
 * The visit statuses that are work done: a visit completed, and one completed
 * on a phone that had not heard it was cancelled (which still happened).
 */
export const VISIT_DONE = ["completed", "completed_after_cancellation"] as const;

/**
 * Which holds each trade's first time fix definition leaves out.
 *
 * The three packs that declare `first_time_fix` define it three ways, and the
 * difference is the exclusion, not the arithmetic: HVAC excludes only work
 * planned as several visits; plumbing also "jobs held for a part order";
 * electrical "jobs held for a part order or an inspection". A trade not listed
 * leaves out no hold, which is the HVAC reading and the strict one.
 */
export const FIRST_TIME_FIX_HOLDS: Readonly<Record<string, readonly string[]>> = {
  hvac: [],
  plumbing: ["part"],
  electrical: ["part", "inspection"],
};

export interface FixVisit {
  status: string;
  arrivedAt: Date | null;
  completedAt: Date | null;
}

export interface FixHold {
  reason: string;
  placedAt: Date;
  /**
   * For a part hold: the purchase order it names went to the supplier and was
   * not cancelled. A draft order is not an order, and one cancelled is a part
   * nobody is waiting for.
   */
  orderPlaced: boolean;
}

export interface FixJob {
  completedAt: Date;
  multiVisitPlannedAt: Date | null;
  visits: readonly FixVisit[];
  holds: readonly FixHold[];
}

/**
 * What one completed job counts as.
 *
 *   `unknown`   no visit on it was done, so how many visits it took is not
 *               recorded (finished from the office, or brought in from
 *               history). Out of both halves.
 *   `excluded`  planned as several visits before its first visit started, or
 *               held for a reason this trade's definition leaves out, before
 *               it was finished. Out of both halves and counted beside.
 *   `fixed`     done in one visit.
 *   `returned`  done in more than one.
 *
 * A PLAN IS ONLY A PLAN BEFORE THE WORK. Planned at or before the first moment
 * anybody arrived (or, with no arrival recorded, finished) a visit on it; a
 * plan written after that is a return visit described kindly. The jobs service
 * refuses one, and this reads the time anyway.
 */
export function firstTimeFixOf(job: FixJob, trade: string): "unknown" | "excluded" | "fixed" | "returned" {
  const done = job.visits.filter((v) => (VISIT_DONE as readonly string[]).includes(v.status));
  if (done.length === 0) return "unknown";

  const starts = job.visits
    .map((v) => v.arrivedAt ?? v.completedAt)
    .filter((at): at is Date => at !== null)
    .map((at) => at.getTime());
  const started = starts.length > 0 ? Math.min(...starts) : Number.POSITIVE_INFINITY;
  const planned = job.multiVisitPlannedAt !== null && job.multiVisitPlannedAt.getTime() <= started;

  const leftOut = FIRST_TIME_FIX_HOLDS[trade] ?? [];
  const held = job.holds.some((hold) => leftOut.includes(hold.reason)
    && hold.placedAt.getTime() <= job.completedAt.getTime()
    && (hold.reason !== "part" || hold.orderPlaced));

  if (planned || held) return "excluded";
  return done.length === 1 ? "fixed" : "returned";
}
