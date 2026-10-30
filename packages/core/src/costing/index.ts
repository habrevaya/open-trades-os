import * as m from "../money/index.js";

/**
 * M15. LABOUR BURDEN AND OVERHEAD, AS RATES THE COMPANY CHOSE
 *
 * Gross margin on a job is revenue less what can be traced to it: materials,
 * hours at the loaded rate frozen onto each punch, and card fees. It is true
 * and it is not what the job cost the company. The employer's payroll taxes,
 * the benefits and workers' compensation on every hour, the truck, the
 * dispatcher and the building all come out of the same revenue.
 *
 * Job costing has said, since it was written, that it allocates none of that
 * and why: the usual stand-ins are circular, and a rate nobody chose would put
 * an opinion into every margin. That is still right about a DEFAULT. What an
 * owner can do is choose the rates themselves, on a dated settings screen,
 * and see a second margin beside the first. So:
 *
 *   DIRECT MARGIN stays exactly as it was, with no rate in it.
 *
 *   FULLY LOADED MARGIN is the direct margin less labour burden and overhead
 *   at the company's own rates, shown beside it and never instead of it.
 *
 * Every rate has an effective date, and a punch or a job is costed at the
 * rate in effect on its own day, so raising workers' comp in July does not
 * reprice March.
 *
 * WHAT A BURDEN IS ON. A percentage is of the BASE wage on the punch, because
 * payroll taxes and workers' compensation are charged on wages, and the
 * fringe already in the loaded rate is a benefit, not a wage, so burdening it
 * again would count part of it twice. A per hour figure is per paid hour.
 *
 * The SQL that applies these to the job costing report lives beside the rest
 * of that arithmetic in `report-catalogue.ts`; the functions here are the same
 * rules in TypeScript, which the settings screen previews with and an
 * integration test holds the SQL to.
 */

export const BURDEN_COMPONENTS = ["payroll_taxes", "benefits", "workers_comp"] as const;
export type BurdenComponent = (typeof BURDEN_COMPONENTS)[number];

export const COMPONENTS = [...BURDEN_COMPONENTS, "overhead"] as const;
export type Component = (typeof COMPONENTS)[number];

export const BASES = [
  "percent_of_wages", "per_hour", "per_job", "percent_of_revenue",
  "percent_of_material", "per_visit", "per_truck",
] as const;
export type Basis = (typeof BASES)[number];

export const COMPONENT_LABEL: Record<Component, string> = {
  payroll_taxes: "Payroll taxes",
  benefits: "Benefits",
  workers_comp: "Workers' compensation",
  overhead: "Overhead",
};

export const BASIS_LABEL: Record<Basis, string> = {
  percent_of_wages: "Percent of base wages",
  per_hour: "Per paid hour",
  per_job: "Per job",
  percent_of_revenue: "Percent of the job's revenue",
  percent_of_material: "Percent of the job's material cost",
  per_visit: "Per visit",
  per_truck: "Per truck, each day it went out on the job",
};

/**
 * Which way each component may be charged.
 *
 * A burden follows the hours, so it is a percentage of wages or an amount per
 * hour. Overhead is spread across jobs, by the hour, by the job, by revenue,
 * by material cost, by the visit or by the truck, and the company picks which
 * (or a mix); the caveat on the statement says what each choice does.
 */
export const ALLOWED_BASES: Record<Component, readonly Basis[]> = {
  payroll_taxes: ["percent_of_wages", "per_hour"],
  benefits: ["percent_of_wages", "per_hour"],
  workers_comp: ["percent_of_wages", "per_hour"],
  overhead: ["per_hour", "per_job", "percent_of_revenue", "percent_of_material", "per_visit", "per_truck"],
};

export const isPercent = (basis: Basis) =>
  basis === "percent_of_wages" || basis === "percent_of_revenue" || basis === "percent_of_material";

export interface CostingRate {
  component: Component;
  basis: Basis;
  /** A decimal string: a percentage ("7.65") or an amount ("4.50"). Zero switches a component off. */
  rate: string;
  /** `YYYY-MM-DD`. In effect from this day until a later row for the same component. */
  effectiveFrom: string;
}

export type RateCheck = { ok: true } | { ok: false; field: string; reason: string };

/** Whether a rate can be saved, with the reason in words when it cannot. */
export function checkRate(input: { component: string; basis: string; rate: string; effectiveFrom: string }): RateCheck {
  if (!(COMPONENTS as readonly string[]).includes(input.component)) {
    return { ok: false, field: "component", reason: `"${input.component}" is not something a rate can be set for.` };
  }
  const component = input.component as Component;
  if (!(ALLOWED_BASES[component] as readonly string[]).includes(input.basis)) {
    const allowed = ALLOWED_BASES[component].map((b) => BASIS_LABEL[b].toLowerCase()).join(" or ");
    return { ok: false, field: "basis", reason: `${COMPONENT_LABEL[component]} is charged ${allowed}.` };
  }
  if (!/^\d{1,6}(\.\d{1,4})?$/.test(input.rate.trim())) {
    return { ok: false, field: "rate", reason: "The rate is a number with at most four decimal places, and not negative." };
  }
  if (isPercent(input.basis as Basis) && Number(input.rate) > 100) {
    return { ok: false, field: "rate", reason: "A percentage cannot be more than 100." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || Number.isNaN(Date.parse(`${input.effectiveFrom}T00:00:00Z`))) {
    return { ok: false, field: "effectiveFrom", reason: "The date it takes effect is a calendar date." };
  }
  return { ok: true };
}

/**
 * The rate for one component in effect on a day: the latest that started on
 * or before it. For a burden component, which has one rate a day; overhead
 * can be a mix of several, read with `overheadMixOn`.
 */
export function rateOn(rates: readonly CostingRate[], component: Component, date: string): CostingRate | null {
  let best: CostingRate | null = null;
  for (const rate of rates) {
    if (rate.component !== component || rate.effectiveFrom > date) continue;
    if (!best || rate.effectiveFrom > best.effectiveFrom) best = rate;
  }
  return best;
}

/** A closed, paid punch, as costing needs it. */
export interface Punch {
  /** The day it started, in the company's calendar. */
  date: string;
  minutes: number;
  /** The base wage frozen onto the punch, or null when no wage scale was in effect. */
  baseRate: string | null;
}

/**
 * Labour burden on a set of punches, each at the rates in effect on its day.
 *
 * A punch with no base rate carries no percentage burden, because there is no
 * wage to take a percentage of; job costing already names those hours as
 * unpriced, which is the problem to fix.
 */
export function labourBurden(punches: readonly Punch[], rates: readonly CostingRate[], currency = "USD"): m.Money {
  let total = m.zero(currency);
  for (const punch of punches) {
    const hours = m.divide(m.money(String(punch.minutes), currency), "60");
    for (const component of BURDEN_COMPONENTS) {
      const rate = rateOn(rates, component, punch.date);
      if (!rate) continue;
      if (rate.basis === "per_hour") {
        total = m.add(total, m.multiply(hours, rate.rate));
      } else if (rate.basis === "percent_of_wages" && punch.baseRate !== null) {
        const wages = m.multiply(hours, punch.baseRate);
        total = m.add(total, m.divide(m.multiply(wages, rate.rate), "100"));
      }
    }
  }
  return total;
}

/**
 * OVERHEAD AS A MIX. A company can charge overhead on more than one basis at
 * once: per paid hour, per job, as a share of revenue or of material cost, per
 * visit and per truck day, in any combination. Each
 * part is an overhead row with its own basis, and the parts set on one day are
 * the mix from that day.
 *
 * WHICH ROWS ARE IN EFFECT. The mix on a day is every overhead row on the
 * latest date on or before it, and nothing from an earlier date. So a mix is
 * replaced whole: a company charging $20 an hour from January that sets 15% of
 * revenue from September charges 15% of revenue from September and no longer
 * the hourly part, which is what overhead with one basis always meant. To add
 * a part, the whole mix is set again on the new day, which the settings screen
 * does in one form. The other reading, each basis its own history, would turn
 * every change of basis a company already made into a mix it never chose.
 */
export const OVERHEAD_BASES = [
  "per_hour", "per_job", "percent_of_revenue", "percent_of_material", "per_visit", "per_truck",
] as const;
export type OverheadBasis = (typeof OVERHEAD_BASES)[number];

export const OVERHEAD_PART_LABEL: Record<OverheadBasis, string> = {
  per_hour: "Per paid hour",
  per_job: "Per job",
  percent_of_revenue: "Share of revenue",
  percent_of_material: "Share of material cost",
  per_visit: "Per visit",
  per_truck: "Per truck day",
};

/**
 * THE THREE LATER BASES, and what each one measures on a job.
 *
 *   percent_of_material  a percentage of the job's material cost: its lines
 *                        at cost plus cost of goods sold posted to it, the
 *                        same figure as the materials on its statement. For a
 *                        company whose stockroom, buyer and warehouse rent
 *                        grow with the parts it fits.
 *   per_visit            an amount for each visit on the job that was not
 *                        cancelled and was not brought in from the old system.
 *                        A second trip costs the dispatcher and the drive
 *                        again, which per job does not see.
 *   per_truck            an amount for each truck day: each company vehicle
 *                        that went out on the job, once for each day it did.
 *                        A truck went out when it was held, on the visit's
 *                        day, by somebody on that visit (or by the job
 *                        itself) according to the vehicle register's custody
 *                        record. A visit by somebody holding no vehicle that
 *                        day adds nothing: the register is the only record of
 *                        which truck went, and a guess would charge a truck
 *                        that stayed in the yard.
 *
 * The same caveat holds for these as for the first three: by material cost a
 * parts heavy job carries more overhead whether or not it used more of the
 * office, per visit a callback carries a second charge, and per truck a job
 * nobody recorded a truck for carries none.
 */

/** The overhead rows in effect on a day: every one on the latest date on or before it. */
export function overheadMixOn(rates: readonly CostingRate[], date: string): CostingRate[] {
  let latest: string | null = null;
  for (const rate of rates) {
    if (rate.component !== "overhead" || rate.effectiveFrom > date) continue;
    if (latest === null || rate.effectiveFrom > latest) latest = rate.effectiveFrom;
  }
  if (latest === null) return [];
  return rates.filter((rate) => rate.component === "overhead" && rate.effectiveFrom === latest);
}

/** What each part of the mix charged one job, and their total. */
export interface OverheadParts {
  perHour: m.Money;
  perJob: m.Money;
  revenueShare: m.Money;
  materialShare: m.Money;
  perVisit: m.Money;
  perTruck: m.Money;
  total: m.Money;
}

/** What overhead is charged on, for one job. The three later measures are zero when left out. */
export interface OverheadJob {
  date: string;
  minutes: number;
  revenue: m.Money;
  cancelled?: boolean;
  /** Material cost at cost, as on the job's statement. */
  materialCost?: m.Money;
  /** Visits not cancelled. */
  visits?: number;
  /** Truck days: each vehicle that went out on the job, once for each day. */
  truckDays?: number;
}

/**
 * Overhead charged to one job, part by part, at the mix in effect on the
 * job's day.
 *
 * A cancelled job carries none: nothing was done, and a per job charge on it
 * would make cancellations look like the most expensive work in the company.
 */
export function overheadParts(job: OverheadJob, rates: readonly CostingRate[]): OverheadParts {
  const currency = job.revenue.currency;
  let perHour = m.zero(currency);
  let perJob = m.zero(currency);
  let revenueShare = m.zero(currency);
  let materialShare = m.zero(currency);
  let perVisit = m.zero(currency);
  let perTruck = m.zero(currency);
  if (!job.cancelled) {
    for (const rate of overheadMixOn(rates, job.date)) {
      switch (rate.basis) {
        case "per_job": perJob = m.add(perJob, m.money(rate.rate, currency)); break;
        case "per_hour":
          perHour = m.add(perHour, m.multiply(m.divide(m.money(String(job.minutes), currency), "60"), rate.rate));
          break;
        case "percent_of_revenue":
          revenueShare = m.add(revenueShare, m.divide(m.multiply(job.revenue, rate.rate), "100"));
          break;
        case "percent_of_material":
          materialShare = m.add(materialShare, m.divide(m.multiply(job.materialCost ?? m.zero(currency), rate.rate), "100"));
          break;
        case "per_visit":
          perVisit = m.add(perVisit, m.multiply(m.money(rate.rate, currency), String(job.visits ?? 0)));
          break;
        case "per_truck":
          perTruck = m.add(perTruck, m.multiply(m.money(rate.rate, currency), String(job.truckDays ?? 0)));
          break;
        default: break;
      }
    }
  }
  const total = [perJob, revenueShare, materialShare, perVisit, perTruck].reduce((sum, part) => m.add(sum, part), perHour);
  return { perHour, perJob, revenueShare, materialShare, perVisit, perTruck, total };
}

/** Overhead charged to one job: the sum of its parts. */
export function overhead(job: OverheadJob, rates: readonly CostingRate[]): m.Money {
  return overheadParts(job, rates).total;
}

export type MixCheck =
  | { ok: true; parts: { basis: OverheadBasis; rate: string }[] }
  | { ok: false; field: string; reason: string };

/**
 * Whether a mix can be saved from the settings form: each box empty or a
 * rate, at least one filled, and the date a calendar date. A zero is allowed
 * and is how a company switches overhead off from a day.
 */
export function checkOverheadMix(input: {
  perHour?: string | undefined; perJob?: string | undefined; percentOfRevenue?: string | undefined;
  percentOfMaterial?: string | undefined; perVisit?: string | undefined; perTruck?: string | undefined;
  effectiveFrom: string;
}): MixCheck {
  const boxes: [OverheadBasis, string, string | undefined][] = [
    ["per_hour", "perHour", input.perHour],
    ["per_job", "perJob", input.perJob],
    ["percent_of_revenue", "percentOfRevenue", input.percentOfRevenue],
    ["percent_of_material", "percentOfMaterial", input.percentOfMaterial],
    ["per_visit", "perVisit", input.perVisit],
    ["per_truck", "perTruck", input.perTruck],
  ];
  const parts: { basis: OverheadBasis; rate: string }[] = [];
  for (const [basis, field, raw] of boxes) {
    const value = raw?.trim() ?? "";
    if (value === "") continue;
    const checked = checkRate({ component: "overhead", basis, rate: value, effectiveFrom: input.effectiveFrom });
    if (!checked.ok) return { ok: false, field: checked.field === "rate" ? field : checked.field, reason: checked.reason };
    parts.push({ basis, rate: value });
  }
  if (parts.length === 0) {
    return {
      ok: false, field: "perHour",
      reason: "Fill in at least one part. To stop charging overhead from a day, put 0 in one of them.",
    };
  }
  return { ok: true, parts };
}

/** Direct margin less burden and overhead. The second margin, never a replacement for the first. */
export function fullyLoadedMargin(directMargin: m.Money, burden: m.Money, overheadCharge: m.Money): m.Money {
  return m.subtract(m.subtract(directMargin, burden), overheadCharge);
}

/**
 * What an hour costs at a given base wage on a given day, for the settings
 * screen: the wage, the burden on it, and the overhead if overhead is by the
 * hour (the per hour part, when overhead is a mix). A number an owner can
 * check against their own payroll before trusting the reports built on it.
 */
export function hourAt(baseRate: string, date: string, rates: readonly CostingRate[], currency = "USD") {
  const burden = labourBurden([{ date, minutes: 60, baseRate }], rates, currency);
  const perHourOverhead = overheadMixOn(rates, date)
    .filter((rate) => rate.basis === "per_hour")
    .reduce((sum, rate) => m.add(sum, m.money(rate.rate, currency)), m.zero(currency));
  const wage = m.money(baseRate, currency);
  return { wage, burden, overhead: perHourOverhead, total: m.add(m.add(wage, burden), perHourOverhead) };
}

/**
 * WHAT A JOURNAL LINE ON A JOB DOES TO THE JOB'S MARGIN.
 *
 * A journal line can name a job (M14), and job costing already reads the
 * ledger by job for three things, so a line on one of those accounts is in the
 * margin the day it is posted and is not read a second time by anything else:
 *
 *   revenue   4000, 4100 and 4900, credits less debits. An accountant
 *             recognising revenue the invoices did not.
 *   material  5000, debits less credits: cost of goods sold. Where a
 *             subcontractor's bill, a tip receipt or supplier's invoice for
 *             this job's parts goes. It ADDS to the cost on the job's lines,
 *             so a part costed on a line is not to be journalled here too:
 *             that is the one way to count a cost twice, and it is the
 *             bookkeeper's to avoid, which the statement says beside the
 *             lines it lists.
 *   fees      6100, debits less credits.
 *
 * EVERYTHING ELSE IS LISTED AND NOT COUNTED. In particular labour: hours come
 * from the timeclock at the rate frozen onto each punch, so a payroll journal
 * on the same job would count the same hours twice, and the commission
 * expense is kept out of margin on purpose (`ACCOUNTS.COMMISSION_EXPENSE`).
 * A line on a job that costing does not read is shown on the statement as
 * booked to the job and not counted, so nothing is hidden and nothing is
 * counted that should not be.
 */
export type JournalCounts = "revenue" | "material" | "fees" | null;

export function journalCounts(accountCode: string): JournalCounts {
  switch (accountCode.trim()) {
    case "4000": case "4100": case "4900": return "revenue";
    case "5000": return "material";
    case "6100": return "fees";
    default: return null;
  }
}

/**
 * A COST THAT MAY BE COUNTED TWICE.
 *
 * Material cost on a job is its lines plus what was journalled to cost of
 * goods sold on it (above), so the one way left to count a cost twice is to
 * put it on a line and journal it to the job as well. Nothing can tell for
 * certain whether a $480 line and a $480 journal are one bill or two; a
 * person can. So job costing flags a pair that looks like one cost and leaves
 * both figures exactly as they are:
 *
 *   the same amount, to the cent: the line's quantity times its unit cost
 *   against the journal's debit to cost of goods sold, and
 *
 *   either the same vendor named on both (a vendor of the company whose name
 *   is in the journal's memo and in the line's name, or who sells the line's
 *   price book item), or dates close together: the journal's day within
 *   `DOUBLE_COUNT_DAYS` of the day the line was recorded, either way.
 *
 * Thirty days because a subcontractor's or supplier's bill often arrives
 * weeks after the work, and a warning somebody can dismiss in one click is
 * cheaper than a cost counted twice in every margin report. A reversed
 * journal, and a reversal, never match: together they net to nothing.
 *
 * The SQL that finds the pairs is `DOUBLE_COUNT_PAIRS_SQL` in
 * report-catalogue.ts; this is the same rule in TypeScript, and an
 * integration test holds the two to each other.
 */
export const DOUBLE_COUNT_DAYS = 30;

export interface DoubleCountCandidate {
  /** The line's quantity times its unit cost. */
  lineCost: string;
  /** The journal's debit to cost of goods sold on the job. */
  journalAmount: string;
  /** Days between the journal's day and the line's, either way. */
  daysApart: number;
  /** A vendor named on both, or null. */
  sameVendor: string | null;
}

const cents = (value: string) => Math.round(Number(value) * 100);

export function possibleDoubleCount(candidate: DoubleCountCandidate): boolean {
  if (cents(candidate.lineCost) !== cents(candidate.journalAmount)) return false;
  if (cents(candidate.lineCost) === 0) return false;
  return candidate.sameVendor !== null || Math.abs(candidate.daysApart) <= DOUBLE_COUNT_DAYS;
}

/** Why a pair was flagged, in a sentence an owner reads on the job. */
export function doubleCountReason(candidate: { daysApart: number; sameVendor: string | null }): string {
  const days = Math.abs(candidate.daysApart);
  const when = days === 0 ? "on the same day" : `${days} ${days === 1 ? "day" : "days"} apart`;
  return candidate.sameVendor !== null
    ? `Same amount, and both name ${candidate.sameVendor} (${when}).`
    : `Same amount, ${when}.`;
}
