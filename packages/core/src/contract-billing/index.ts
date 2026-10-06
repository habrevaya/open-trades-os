import { type Money, edit, round } from "../money/index.js";
import { addDays, addMonths } from "../recurrence/index.js";

/**
 * A CONTRACT BILLED ON A SCHEDULE
 *
 * A commercial maintenance contract often bills a fixed amount every month,
 * quarter or year whether or not anybody visited: "1,200.00 a month for the
 * planned maintenance at both sites". The work on it is still recorded and
 * may still be billed by the job; this is the fee for being under contract.
 *
 * Everything here is pure: which periods a schedule owes, what each costs,
 * and on which day each is billed. The service decides what has already
 * been billed and writes the invoices.
 *
 * IN ADVANCE, ON THE BILLING DAY. Each invoice covers the period that begins
 * on the day it is billed, the way a fixed fee contract is written: the
 * month of March is billed on the first of March. The billing day is a day
 * of the month from 1 to 28, so every month has one, and a quarterly or
 * yearly schedule bills on it every third or twelfth month, counted from the
 * first billing day on or after the day the schedule starts.
 *
 * A PART PERIOD AT EITHER END. A contract that starts on the 15th with a
 * billing day of the 1st has a first period of the 15th to the end of the
 * month, billed on the 15th; one that ends on the 10th has a last period of
 * the 1st to the 10th. Each is prorated by day ONLY when the contract says
 * so, against the days of the whole period it is part of. Otherwise it is
 * billed as a whole period, which is what a contract that says nothing about
 * part months means: the fee is the fee.
 *
 * ROUNDED ONCE. A prorated amount is the whole amount times the days over the
 * period's days, exactly, then rounded to the cent half up. Rounding the day
 * rate first and multiplying would be a cent out on a long month.
 */

export type Frequency = "monthly" | "quarterly" | "yearly";

export const FREQUENCIES: readonly Frequency[] = ["monthly", "quarterly", "yearly"];

/** How many months one period of each frequency runs. */
export const MONTHS: Record<Frequency, number> = { monthly: 1, quarterly: 3, yearly: 12 };

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  monthly: "Every month",
  quarterly: "Every three months",
  yearly: "Every year",
};

export interface Schedule {
  /** The fee for one whole period. */
  amount: Money;
  frequency: Frequency;
  /** 1 to 28. */
  billingDay: number;
  /** The first day the schedule bills for. */
  startsOn: string;
  /** The last day it bills for, when it has one: the contract's end, or the day the schedule was ended. */
  endsOn: string | null;
  /** Prorate a part period at either end by day. Off, a part period is billed whole. */
  prorate: boolean;
}

export interface Period {
  /** First and last day the period covers, inclusive. */
  start: string;
  end: string;
  /** The day it is billed: its first day. */
  billOn: string;
  amount: Money;
  /** True when the amount is a share of the whole fee, by day. */
  prorated: boolean;
  /** Days this period covers. */
  days: number;
  /** Days of the whole period it is part of, which a prorated amount is a share of. */
  fullDays: number;
}

/** Whether a schedule's terms can be billed, and why not, in words. */
export function scheduleProblem(input: {
  amount: string; frequency: string; billingDay: number; startsOn: string; endsOn?: string | null | undefined;
}): string | null {
  if (!/^\d+(\.\d{1,4})?$/.test(input.amount.trim())) {
    return `"${input.amount}" is not an amount. Write the fee for one period, like 1200.00.`;
  }
  if (Number(input.amount) <= 0) return "A schedule that bills nothing is not a schedule. Write the fee for one period.";
  if (!(FREQUENCIES as readonly string[]).includes(input.frequency)) {
    return `"${input.frequency}" is not how often a contract bills. Every month, every three months or every year.`;
  }
  if (!Number.isInteger(input.billingDay) || input.billingDay < 1 || input.billingDay > 28) {
    return "Pick a billing day from 1 to 28, so every month has one.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn) || Number.isNaN(Date.parse(`${input.startsOn}T00:00:00Z`))) {
    return "The first day billed is not a date.";
  }
  if (input.endsOn && input.endsOn < input.startsOn) {
    return `The contract ends on ${input.endsOn}, before the schedule's first day.`;
  }
  return null;
}

/** Days from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
}

/** The first billing day on or after a date. */
function firstAnchor(on: string, billingDay: number): string {
  const day = Number(on.slice(8, 10));
  const sameMonth = `${on.slice(0, 8)}${String(billingDay).padStart(2, "0")}`;
  return day <= billingDay ? sameMonth : addMonths(sameMonth, 1);
}

/**
 * The whole period that contains a day: from the billing day on or before it
 * to the day before the next. Anchored on the schedule's own first billing
 * day, so a quarterly schedule keeps its months.
 */
function wholePeriodAround(schedule: Pick<Schedule, "frequency" | "billingDay" | "startsOn">, on: string): { start: string; end: string } {
  const step = MONTHS[schedule.frequency];
  const anchor = firstAnchor(schedule.startsOn, schedule.billingDay);
  /** Months from the anchor to the day, rounded down to whole periods, either way. */
  const months = (Number(on.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 + Number(on.slice(5, 7)) - Number(anchor.slice(5, 7));
  let k = Math.floor(months / step);
  let start = addMonths(anchor, k * step);
  /** Earlier in its month than the billing day: the period began a step before. */
  if (start > on) {
    k -= 1;
    start = addMonths(anchor, k * step);
  }
  /** Always after the day: k is the whole periods from the anchor to its month. */
  const next = addMonths(anchor, (k + 1) * step);
  return { start, end: addDays(next, -1) };
}

/** A prorated amount: the whole fee times days over the period's days, rounded once, to the cent, half up. */
export function prorate(amount: Money, days: number, fullDays: number): Money {
  if (days >= fullDays) return amount;
  const numerator = amount.amount * BigInt(days);
  const denominator = BigInt(fullDays) * 100n;
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  let cents = abs / denominator;
  if ((abs % denominator) * 2n >= denominator) cents += 1n;
  return { amount: (negative ? -cents : cents) * 100n, currency: amount.currency };
}

/** The period that begins on a day, cut at the schedule's end, priced. */
export function periodFrom(schedule: Schedule, start: string): Period | null {
  if (start < schedule.startsOn) return null;
  if (schedule.endsOn && start > schedule.endsOn) return null;
  const whole = wholePeriodAround(schedule, start);
  const end = schedule.endsOn && schedule.endsOn < whole.end ? schedule.endsOn : whole.end;
  const days = daysBetween(start, end);
  const fullDays = daysBetween(whole.start, whole.end);
  const part = days < fullDays;
  const prorated = part && schedule.prorate;
  return {
    start,
    end,
    billOn: start,
    amount: prorated ? prorate(schedule.amount, days, fullDays) : round(schedule.amount, 2),
    prorated,
    days,
    fullDays,
  };
}

/**
 * Every period from the schedule's first day whose billing day has come by
 * `through`, in order. Stops at the schedule's end, and after `limit`
 * periods so a schedule started years ago is caught up a page at a time
 * rather than in one transaction nobody can wait for.
 */
export function periodsThrough(schedule: Schedule, through: string, limit = 120): Period[] {
  const out: Period[] = [];
  let start = schedule.startsOn;
  while (out.length < limit) {
    const period = periodFrom(schedule, start);
    if (!period || period.billOn > through) break;
    out.push(period);
    start = addDays(period.end, 1);
  }
  return out;
}

/** The next period whose billing day has not come yet, for the screen: "next bills 1 April". */
export function nextPeriod(schedule: Schedule, today: string): Period | null {
  let start = schedule.startsOn;
  for (let guard = 0; guard < 2000; guard += 1) {
    const period = periodFrom(schedule, start);
    if (!period) return null;
    if (period.billOn > today) return period;
    start = addDays(period.end, 1);
  }
  return null;
}

/** "1 Mar 2027 to 31 Mar 2027", as a line on the invoice says it. */
export function periodWords(start: string, end: string): string {
  const words = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  return `${words(start)} to ${words(end)}`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The working of a period's amount, in a sentence the invoice line carries. */
export function periodNote(period: Period, amount: Money): string {
  if (period.prorated) {
    return `${period.days} of ${period.fullDays} days of ${edit(round(amount, 2))} a period, prorated by day.`;
  }
  if (period.days < period.fullDays) {
    return `A part period of ${period.days} days, billed as a whole period as the contract says.`;
  }
  return `The contract's fee for the period.`;
}
