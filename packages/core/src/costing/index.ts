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

export const BASES = ["percent_of_wages", "per_hour", "per_job", "percent_of_revenue"] as const;
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
};

/**
 * Which way each component may be charged.
 *
 * A burden follows the hours, so it is a percentage of wages or an amount per
 * hour. Overhead is spread across jobs, by the hour, by the job or by revenue,
 * and the company picks which one; the caveat on the statement says what each
 * choice does.
 */
export const ALLOWED_BASES: Record<Component, readonly Basis[]> = {
  payroll_taxes: ["percent_of_wages", "per_hour"],
  benefits: ["percent_of_wages", "per_hour"],
  workers_comp: ["percent_of_wages", "per_hour"],
  overhead: ["per_hour", "per_job", "percent_of_revenue"],
};

export const isPercent = (basis: Basis) => basis === "percent_of_wages" || basis === "percent_of_revenue";

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

/** The rate for one component in effect on a day: the latest that started on or before it. */
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
 * Overhead charged to one job, at the overhead rate in effect on the job's day.
 *
 * A cancelled job carries none: nothing was done, and a per job charge on it
 * would make cancellations look like the most expensive work in the company.
 */
export function overhead(
  job: { date: string; minutes: number; revenue: m.Money; cancelled?: boolean },
  rates: readonly CostingRate[],
): m.Money {
  const currency = job.revenue.currency;
  if (job.cancelled) return m.zero(currency);
  const rate = rateOn(rates, "overhead", job.date);
  if (!rate) return m.zero(currency);
  switch (rate.basis) {
    case "per_job": return m.money(rate.rate, currency);
    case "per_hour": return m.multiply(m.divide(m.money(String(job.minutes), currency), "60"), rate.rate);
    case "percent_of_revenue": return m.divide(m.multiply(job.revenue, rate.rate), "100");
    default: return m.zero(currency);
  }
}

/** Direct margin less burden and overhead. The second margin, never a replacement for the first. */
export function fullyLoadedMargin(directMargin: m.Money, burden: m.Money, overheadCharge: m.Money): m.Money {
  return m.subtract(m.subtract(directMargin, burden), overheadCharge);
}

/**
 * What an hour costs at a given base wage on a given day, for the settings
 * screen: the wage, the burden on it, and the overhead if overhead is by the
 * hour. A number an owner can check against their own payroll before trusting
 * the reports built on it.
 */
export function hourAt(baseRate: string, date: string, rates: readonly CostingRate[], currency = "USD") {
  const burden = labourBurden([{ date, minutes: 60, baseRate }], rates, currency);
  const overheadRate = rateOn(rates, "overhead", date);
  const perHourOverhead = overheadRate?.basis === "per_hour" ? m.money(overheadRate.rate, currency) : m.zero(currency);
  const wage = m.money(baseRate, currency);
  return { wage, burden, overhead: perHourOverhead, total: m.add(m.add(wage, burden), perHourOverhead) };
}
