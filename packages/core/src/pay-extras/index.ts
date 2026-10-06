import { type Money, allocate, compare, isPositive, isZero, money, round, split, zero } from "../money/index.js";
import { addDays } from "../time/index.js";

/**
 * WHAT A COMPANY PAYS A PERSON BESIDE THEIR HOURS
 *
 * What a person spent for the company and gets back, a flat allowance for a
 * day away, and how a customer's tip is shared between the people on a job.
 * Nothing here touches a database or a clock it was not handed, so every rule
 * can be tested without either.
 *
 * Money in a person's pocket is where a small company is most often unfair by
 * accident, so every refusal below is a sentence the person who typed the
 * figure can act on, and every default is the one that pays nobody anything
 * the company did not choose to pay.
 */

/* ------------------------------------------------------------ the settings */

/**
 * How a tip is shared between the people on the job it was left for.
 *
 *   even   everybody on the job's visits gets the same, to the cent. The way
 *          tips were always shared, and what a company that never chose gets.
 *   hours  in proportion to the hours each person was clocked in on the job.
 *   lead   the person marked as lead on the job's visits takes all of it.
 */
export const TIP_SPLIT_RULES = ["even", "hours", "lead"] as const;
export type TipSplitRule = (typeof TIP_SPLIT_RULES)[number];

export const TIP_SPLIT_LABEL: Record<TipSplitRule, string> = {
  even: "Evenly between everybody on the job",
  hours: "By the hours each person worked on the job",
  lead: "All to the lead on the job",
};

export interface PayExtras {
  /** The company's allowance for one day away, as dollars and cents. Null until somebody sets it. */
  perDiemRate: string | null;
  tipSplit: TipSplitRule;
}

/**
 * Read the settings blob. Anything hand edited into nonsense reads as the
 * defaults, which pay nobody a per diem and split tips as they always were.
 */
export function readPayExtras(raw: unknown): PayExtras {
  const blob = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rate = typeof blob["perDiemRate"] === "string" && checkPerDiemRate(blob["perDiemRate"]).ok
    ? (checkPerDiemRate(blob["perDiemRate"]) as { ok: true; rate: string }).rate
    : null;
  const rule = TIP_SPLIT_RULES.find((r) => r === blob["tipSplit"]) ?? "even";
  return { perDiemRate: rate, tipSplit: rule };
}

/** The most a day away can be. A figure past this is a typing slip, and a slip here is paid daily. */
export const MAX_PER_DIEM = "1000.00";

export type RateCheck = { ok: true; rate: string } | { ok: false; reason: string };

export function checkPerDiemRate(value: string): RateCheck {
  const typed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(typed)) {
    return { ok: false, reason: "Say the rate for one day away in dollars and cents, like 75.00." };
  }
  const rate = round(money(typed), 2);
  if (!isPositive(rate)) return { ok: false, reason: "A day away has to be paid more than nothing. Leave the rate empty to pay none." };
  if (compare(rate, money(MAX_PER_DIEM)) > 0) {
    return { ok: false, reason: `A day away of more than ${MAX_PER_DIEM} is most likely a slip of the keys. Check the amount.` };
  }
  return { ok: true, rate: `${rate.amount / 10000n}.${String((rate.amount % 10000n) / 100n).padStart(2, "0")}` };
}

/* ------------------------------------------------------------ an expense */

/** More than this is not something to put on a phone: it is a purchase the office makes. */
export const MAX_EXPENSE = "10000.00";

/** How far back a receipt may be dated. Older than this is a different conversation with the office. */
export const EXPENSE_BACK_DAYS = 120;

export type ExpenseCheck =
  | { ok: true; amount: Money; description: string }
  | { ok: false; reason: string };

/**
 * Whether what somebody typed can be an expense.
 *
 * `today` is the company's date, handed in, so a receipt dated tomorrow is
 * refused by the company's calendar rather than the server's.
 */
export function checkExpense(input: { amount: string; spentOn: string; today: string; description: string }): ExpenseCheck {
  const typed = input.amount.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(typed)) {
    return { ok: false, reason: "Say what you paid in dollars and cents, like 42.50." };
  }
  const amount = round(money(typed), 2);
  if (!isPositive(amount)) return { ok: false, reason: "An expense has to be more than nothing." };
  if (compare(amount, money(MAX_EXPENSE)) > 0) {
    return { ok: false, reason: `That is more than ${MAX_EXPENSE}. Ask the office to buy it, or to pay you back another way.` };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spentOn) || Number.isNaN(Date.parse(`${input.spentOn}T00:00:00Z`))) {
    return { ok: false, reason: "Say the day you paid it." };
  }
  if (input.spentOn > input.today) return { ok: false, reason: "That day has not happened yet." };
  if (input.spentOn < addDays(input.today, -EXPENSE_BACK_DAYS)) {
    return { ok: false, reason: `That is more than ${EXPENSE_BACK_DAYS} days ago. Ask the office to pay it back.` };
  }
  const description = input.description.trim().replace(/\s+/g, " ");
  if (description === "") return { ok: false, reason: "Say what it was for, so the office knows what it is paying back." };
  if (description.length > 300) return { ok: false, reason: "Say what it was for in a few words. The most it takes is 300 letters." };
  return { ok: true, amount, description };
}

/** The most days one entry may cover, so a typed year is a slip and not a thousand allowances. */
export const MAX_PER_DIEM_DAYS = 31;

/** Every day from the first to the last, both included, or why not. */
export function daysAway(from: string, to: string): { ok: true; days: string[] } | { ok: false; reason: string } {
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  if (!valid(from) || !valid(to)) return { ok: false, reason: "Say the first and last day away." };
  if (to < from) return { ok: false, reason: "The last day is before the first. Put the earlier day first." };
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day);
    if (days.length > MAX_PER_DIEM_DAYS) {
      return { ok: false, reason: `That is more than ${MAX_PER_DIEM_DAYS} days. Record a month at a time.` };
    }
  }
  return { ok: true, days };
}

/* --------------------------------------------------------- a cash tip kept */

/** More than this is not a tip, and is recorded as a payment. Said the same on the phone. */
export const MAX_CASH_TIP = "10000.00";

export type TipAmountCheck = { ok: true; amount: Money } | { ok: false; reason: string };

/**
 * What the office typed as a cash tip. Zero is allowed only when asked for,
 * because the way a tip that was never given comes off somebody's pay is a
 * correction to nothing, and a new tip of nothing is a slip.
 */
export function checkTipAmount(value: string, options: { allowZero?: boolean } = {}): TipAmountCheck {
  const typed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(typed)) return { ok: false, reason: "Say the tip in dollars and cents, like 20 or 20.50." };
  const amount = round(money(typed), 2);
  if (!isPositive(amount) && !(options.allowZero && isZero(amount))) {
    return { ok: false, reason: "A tip has to be more than nothing." };
  }
  if (compare(amount, money(MAX_CASH_TIP)) > 0) return { ok: false, reason: "That is more than a tip. Record it as a payment instead." };
  return { ok: true, amount };
}

/* ------------------------------------------------------------ tip shares */

export interface TipPerson {
  technicianId: string;
  /** Seconds clocked in on the job, closed punches only. Zero when none are recorded. */
  seconds: number;
  /** Marked as lead on at least one of the job's visits. */
  isLead: boolean;
}

export interface TipSplit {
  shares: { technicianId: string; amount: Money }[];
  /** The rule that actually produced the shares, which is "even" when the chosen one had nothing to go on. */
  rule: TipSplitRule;
  /**
   * Said in words when the chosen rule could not be followed, empty when it
   * could. Kept on every share so nobody has to guess why a split was even.
   */
  note: string;
}

/**
 * Share one tip between the people on a job, by the company's rule.
 *
 * A rule with nothing to go on does NOT hand the tip to nobody or to the
 * wrong person: no hours recorded, or no lead marked, falls back to an even
 * split and says so. The alternatives are a tip with no owner, which sits as a
 * liability until somebody notices, and a guess at who deserved it.
 *
 * Sorted by id before anything is shared, so the odd cent lands on the same
 * person for the same inputs, and a person with no share is left out rather
 * than written as zero.
 */
export function splitTipByRule(rule: TipSplitRule, tip: Money, people: readonly TipPerson[]): TipSplit {
  const byId = new Map<string, TipPerson>();
  for (const person of people) {
    const seen = byId.get(person.technicianId);
    byId.set(person.technicianId, seen
      ? { ...seen, isLead: seen.isLead || person.isLead, seconds: Math.max(seen.seconds, person.seconds) }
      : person);
  }
  const everybody = [...byId.values()].sort((a, b) => a.technicianId.localeCompare(b.technicianId));
  if (everybody.length === 0 || isZero(tip)) return { shares: [], rule, note: "" };

  const evenly = (among: TipPerson[]) => {
    const parts = split(tip, among.length, 2);
    return among.map((p, i) => ({ technicianId: p.technicianId, amount: parts[i] ?? zero(tip.currency) }));
  };

  if (rule === "lead") {
    const leads = everybody.filter((p) => p.isLead);
    if (leads.length === 0) {
      return {
        shares: evenly(everybody), rule: "even",
        note: "No lead is marked on this job, so the tip was split evenly between everybody on it.",
      };
    }
    return {
      shares: evenly(leads), rule: "lead",
      note: leads.length > 1 ? "More than one person is marked as lead, so the tip was split evenly between them." : "",
    };
  }

  if (rule === "hours") {
    const worked = everybody.filter((p) => p.seconds > 0);
    if (worked.length === 0) {
      return {
        shares: evenly(everybody), rule: "even",
        note: "No hours were recorded on this job, so the tip was split evenly between everybody on it.",
      };
    }
    const parts = allocate(tip, worked.map((p) => String(Math.round(p.seconds))), 2);
    return {
      shares: worked.map((p, i) => ({ technicianId: p.technicianId, amount: parts[i] ?? zero(tip.currency) }))
        .filter((s) => !isZero(s.amount)),
      rule: "hours",
      note: worked.length < everybody.length
        ? "Somebody on the job has no hours recorded on it, so they have no share of this tip."
        : "",
    };
  }

  return { shares: evenly(everybody), rule: "even", note: "" };
}
