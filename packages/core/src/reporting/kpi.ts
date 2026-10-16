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
 *   A FIRST TIME FIX. A completed job done in one visit, with the jobs that
 *   were planned as several visits, or held for a part order, left out.
 *
 *   A JOB'S SUPPLIES AGAINST ITS REVENUE. What its supplies cost over what it
 *   billed, with the supplies billed back to the customer at cost taken out
 *   of both.
 *
 *   AN APPLICATION RECORD'S COMPLETENESS. Every regulated field a visit's
 *   report was required to capture, captured, judged against the list frozen
 *   on the report when it was written.
 *
 *   A PANEL WORTH UPGRADING. Recorded as full, flagged as a known problem, or
 *   rated below 100 amps, read only from values held to the pack's
 *   declaration.
 *
 *   A JOB'S HOURS AGAINST ITS BUDGET. Crew hours less the hours of change
 *   orders the customer approved, against the hours budgeted, counted only
 *   over jobs whose hours are all in.
 *
 *   A PERMITTED JOB'S FIRST INSPECTION. Signed off first time only when no
 *   inspection on it failed for our work, and left out when it failed only for
 *   somebody else's.
 *
 *   A ROUTE DAY'S MILES. Driven between stops, never to the first or home from
 *   the last, and not counted at all when the phone's positions have a gap.
 *
 *   A WATER HEATER CAUGHT. An old heater we looked at that we went on to
 *   replace, with the ones the customer had booked with somebody else left
 *   out.
 *
 *   A LATE CANCELLATION. A stop the customer called off with less notice than
 *   the company asks for, judged by when they asked and the notice window in
 *   force then, with the company's own cancellations left out.
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

/* ------------------------------------------------- budgeted hour variance */

export interface BudgetPunch {
  kind: string;
  minutes: number | null;
  /** Punched out. A punch still running has no hours yet. */
  ended: boolean;
}

export interface BudgetJob {
  /** Crew hours budgeted, as a number, or null when nobody set one. */
  budgetedHours: number | null;
  /** The punches on the job. */
  punches: readonly BudgetPunch[];
  /** Crew hours on change orders the customer approved that name this job. */
  approvedChangeHours: number;
}

/**
 * One completed job's hours against its budget, or why it is not counted.
 *
 * "Actual crew hours minus budgeted hours on completed jobs, as a percentage
 * of budgeted. EXCLUDES change order hours that were separately approved, or
 * every approved upsell reads as an overrun."
 *
 * ACTUAL is every working punch on the job, each person separately, which is
 * what crew hours are: on site and travelling to it, and not leave or an
 * unpaid break (`NOT_A_DAY_WORKED`). The approved change order hours come off
 * it. A job is LEFT OUT OF BOTH HALVES when it has no budget, a punch still
 * running, or no hours at all: a job nobody clocked would read as a hundred
 * per cent under budget, the most flattering misreading of "not recorded".
 */
export function budgetVarianceOf(job: BudgetJob):
  | { counted: false; why: "no_budget" | "punch_open" | "no_hours" }
  | { counted: true; overHours: number; budgetedHours: number } {
  if (job.budgetedHours === null || job.budgetedHours <= 0) return { counted: false, why: "no_budget" };
  const working = job.punches.filter((p) => !(NOT_A_DAY_WORKED as readonly string[]).includes(p.kind));
  if (working.some((p) => !p.ended)) return { counted: false, why: "punch_open" };
  const minutes = working.reduce((sum, p) => sum + (p.minutes ?? 0), 0);
  if (minutes === 0) return { counted: false, why: "no_hours" };
  return {
    counted: true,
    overHours: minutes / 60 - job.approvedChangeHours - job.budgetedHours,
    budgetedHours: job.budgetedHours,
  };
}

/* -------------------------------------------- supply cost share of revenue */

export interface SupplyLine {
  /** The job line's kind. A supply is a `part`: equipment fitted is capital, and labour is hours. */
  kind: string;
  quantity: number;
  /** Null when nobody recorded what it cost. */
  unitCost: number | null;
  /** Marked as billed back to the customer at cost. */
  billedBack: boolean;
  /**
   * What it was billed at, net of discounts, on an invoice that was issued and
   * not voided; null when it is on no such invoice.
   */
  billedRevenue: number | null;
}

export interface SupplyJob {
  /** The ledger's revenue on the job. */
  revenue: number;
  lines: readonly SupplyLine[];
}

/**
 * One completed job's supply cost and the revenue it is a share of, or why it
 * is not counted.
 *
 * "Chemical, consumable and equipment consumable cost divided by invoiced
 * revenue. EXCLUDES supplies stocked for a commercial account and billed back
 * at cost, which are a pass through and not a margin leak."
 *
 * A PASS THROUGH is a supply marked billed back that is on an issued invoice:
 * its cost leaves the top and what it was billed at leaves the bottom, so it
 * moves neither. One marked and not yet billed is still a cost with nothing
 * against it, and counts as one; the office marking a supply is a promise,
 * and the invoice is the fact.
 *
 * A job with a supply whose cost nobody recorded is LEFT OUT OF BOTH HALVES:
 * unknown is not free, and counted at nothing it would read as a cheaper job
 * than it was.
 */
export function supplyCostOf(job: SupplyJob):
  | { counted: false; why: "uncosted" }
  | { counted: true; supplyCost: number; revenue: number; passedThrough: number } {
  let supplyCost = 0;
  let passed = 0;
  let passedRevenue = 0;
  for (const line of job.lines) {
    if (line.kind !== "part") continue;
    if (line.billedBack && line.billedRevenue !== null) {
      passed += 1;
      passedRevenue += line.billedRevenue;
      continue;
    }
    if (line.unitCost === null) return { counted: false, why: "uncosted" };
    supplyCost += line.quantity * line.unitCost;
  }
  return { counted: true, supplyCost, revenue: job.revenue - passedRevenue, passedThrough: passed };
}

/* ---------------------------------------- application record completeness */

/**
 * The field a pest control report says no product was applied in, and why.
 * The pack's own key: a visit recorded with it "has its own required set" and
 * the definition leaves it out.
 */
export const NO_PRODUCT_REASON = "no_product_reason";

export interface RecordReport {
  /** What it was required to capture, frozen when it was written; null when written before that was kept. */
  required: ReadonlyArray<{ key: string; regulated: boolean }> | null;
  /** The keys it captured a value for. */
  captured: readonly string[];
}

/**
 * What one completed visit counts as.
 *
 * "Completed visits where every regulated field required by the operator's
 * configuration was captured, divided by completed visits. EXCLUDES visits
 * recorded with a no product applied reason, which have their own required
 * set."
 *
 *   `excluded`    a report on it gave a no product applied reason. Out of
 *                 both halves and counted beside.
 *   `incomplete`  no report at all (a completed visit with no application
 *                 record is the most incomplete record there is), or a report
 *                 missing a regulated field it was required to capture.
 *   `complete`    a report on it captured every regulated field it was
 *                 required to.
 *   `unknown`     its reports were held to no regulated field: written before
 *                 the list was kept, or the operator required none. Out of
 *                 both halves and counted beside, rather than read as complete
 *                 for having been asked nothing.
 */
export function recordCompletenessOf(visit: { reports: readonly RecordReport[] }):
  "excluded" | "incomplete" | "complete" | "unknown" {
  if (visit.reports.some((r) => r.captured.includes(NO_PRODUCT_REASON))) return "excluded";
  if (visit.reports.length === 0) return "incomplete";
  const judged = visit.reports.filter((r) => (r.required ?? []).some((f) => f.regulated));
  if (judged.length === 0) return "unknown";
  return judged.some((r) => r.required!.filter((f) => f.regulated).every((f) => r.captured.includes(f.key)))
    ? "complete" : "incomplete";
}

/* ----------------------------------------------------- panel upgrade pipeline */

/**
 * Whether a panel is one the electrical pack's panel upgrade pipeline counts:
 * "recorded as full, flagged as a known concern, or rated below 100 amps".
 *
 * Read only from values held to the declaration (`field.typedAttributes`):
 * open spaces a number, the concern a yes or no, the rating one of the pack's
 * options. Full is no open spaces. A panel none of whose readable values
 * qualifies, carrying one of the three as something else (words typed before
 * the register checked them), is `unknown`: its recommendation is counted
 * beside the figure and never in it, because "100A" read as no rating would
 * leave it out and read as a rating would be a guess.
 */
export function panelQualifies(
  attributes: Readonly<Record<string, unknown>>,
  ratings: readonly string[],
): "in" | "out" | "unknown" {
  const amps = attributes["service_amps"];
  const open = attributes["spaces_open"];
  const concern = attributes["known_concern"];
  if (concern === true) return "in";
  if (typeof open === "number" && open <= 0) return "in";
  if (typeof amps === "string" && ratings.includes(amps) && Number(amps) < 100) return "in";
  const untyped = (amps !== undefined && amps !== null && !(typeof amps === "string" && ratings.includes(amps)))
    || (open !== undefined && open !== null && typeof open !== "number")
    || (concern !== undefined && concern !== null && typeof concern !== "boolean");
  return untyped ? "unknown" : "out";
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

/* ------------------------------------------------- cancellation rate by route */

export interface CancelStop {
  status: string;
  /** When it was booked for. A visit with no time was never a scheduled stop. */
  windowStart: Date | null;
  /** Null on a cancelled visit when nobody recorded who. */
  cancelledBy: "customer" | "company" | null;
  /** When the customer asked, or the company decided. */
  cancelledAt: Date | null;
  /** The company's notice window when it was called off, in hours. */
  noticeHours: number | null;
}

/** The visit statuses that mean somebody called it off (one done anyway is still one called off). */
export const VISIT_CALLED_OFF = ["cancelled", "completed_after_cancellation"] as const;

/**
 * What one scheduled stop counts as.
 *
 * "Stops cancelled or skipped inside the notice window divided by stops
 * scheduled, reported per route and per weekday. EXCLUDES visits the company
 * cancelled for weather or staffing, which are a separate and more serious
 * number."
 *
 *   `null`      no window, so it was never a scheduled stop.
 *   `kept`      not called off: done, still to come, or missed.
 *   `late`      the customer called it off with less notice than the window
 *               asked for, or after it had started (skipped at the door).
 *   `in_time`   the customer called it off with the notice asked for. In the
 *               denominator: it was a scheduled stop, and an owner wants to
 *               see how many customers cancel properly as well as how many
 *               do not.
 *   `company`   the company called it off. Out of both halves and counted
 *               beside, as the definition says.
 *   `unknown`   called off with nobody recording who (before this was kept, or
 *               brought in from another system). Out of both halves and
 *               counted beside, rather than read as either: a week of rain
 *               read as customers would be the misreading the definition
 *               warns about, and read as the company would hide real ones.
 *
 * Exactly the notice asked for is in time: a policy of a day's notice is met
 * by a call a day before.
 */
export function cancellationOf(stop: CancelStop): "kept" | "late" | "in_time" | "company" | "unknown" | null {
  if (stop.windowStart === null) return null;
  if (!(VISIT_CALLED_OFF as readonly string[]).includes(stop.status)) return "kept";
  if (stop.cancelledBy === null || stop.cancelledAt === null || stop.noticeHours === null) return "unknown";
  if (stop.cancelledBy === "company") return "company";
  const due = stop.windowStart.getTime() - stop.noticeHours * 3_600_000;
  return stop.cancelledAt.getTime() > due ? "late" : "in_time";
}

/* ------------------------------------------------ water heater opportunity capture */

export interface HeaterSeen {
  /** When it was put in, as a date; null when nobody recorded it. */
  installedOn: string | null;
  /** The first day in the window somebody inspected or worked on it. */
  inspectedOn: string;
  /** Recorded as replaced, each with the day and whether the record names one of our jobs. */
  replacements: ReadonlyArray<{ movedOn: string; byUs: boolean }>;
  /** Recommendations on it the customer declined and still stand declined. */
  declines: ReadonlyArray<{ declinedOn: string; code: string | null }>;
}

/** A date ten years before another, as Postgres counts it: the 29th of February falls back to the 28th. */
export function tenYearsBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y - 10, m, 0)).getUTCDate();
  return `${String(y - 10).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/**
 * What one water heater inspected in the window counts as.
 *
 * "Water heaters replaced divided by water heaters recorded as over ten years
 * old and inspected in the period. Excludes units the customer has already
 * scheduled with someone else, so the ones nobody followed up on stay
 * visible."
 *
 *   `unknown_age`        no install date recorded, so nothing says it is over
 *                        ten. Out of both halves and counted beside, because
 *                        a register with no ages would otherwise read as a
 *                        company with no old heaters.
 *   `young`              ten years old or less on the day it was inspected.
 *   `replaced`           over ten, and replaced on a job of ours on or after
 *                        that day. In both halves. A replacement recorded with
 *                        no job of ours named might be somebody else's and is
 *                        not counted as caught.
 *   `booked_elsewhere`   over ten, not replaced by us, and a recommendation on
 *                        it declined, on or after that day, because the
 *                        customer had booked the work with another company.
 *                        Out of both halves and counted beside.
 *   `open`               over ten and none of those: the one nobody followed
 *                        up on, in the bottom half, visible.
 */
export function heaterCaptureOf(unit: HeaterSeen):
  "unknown_age" | "young" | "replaced" | "booked_elsewhere" | "open" {
  if (unit.installedOn === null) return "unknown_age";
  if (unit.installedOn >= tenYearsBefore(unit.inspectedOn)) return "young";
  if (unit.replacements.some((r) => r.byUs && r.movedOn >= unit.inspectedOn)) return "replaced";
  if (unit.declines.some((d) => d.code === "booked_elsewhere" && d.declinedOn >= unit.inspectedOn)) return "booked_elsewhere";
  return "open";
}
