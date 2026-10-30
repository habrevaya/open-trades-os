import type { Permission } from "../access/permissions.js";
import * as m from "../money/index.js";
import { normalizeTag, tagKey } from "../tags/index.js";
import type { Checked } from "./workflow.js";

/**
 * PRICING RULES AN APPLICATION REGISTERED
 *
 * A connected application can tell the company's pricing one of four
 * things, and only these four, as data:
 *
 *   `customer_tag`    a percentage or an amount for customers carrying a tag
 *   `job_type`        a percentage or an amount for one kind of work
 *   `time_window`     a percentage or an amount for work booked in a window
 *                     (days and hours), or outside the company's own hours
 *   `minimum_charge`  the least a document may come to
 *
 * A percentage or an amount below zero takes money off; above zero adds it.
 *
 * THE VOCABULARY IS CLOSED BECAUSE A RULE IS MONEY. A rule an application
 * could write as an expression would be a way to change any price in the
 * company from outside it, and nobody could read one back and say what it
 * does. Four shapes can each be said in one sentence on the invoice line
 * they touched, which is the point of recording them there.
 *
 * WHERE THEY APPLY. When lines are priced, after member pricing and before
 * tax, and only on lines priced from the company's own price book: a price
 * somebody typed was chosen on purpose, a contract's rate card is what the
 * client agreed, and a line recorded from another system is history. Each
 * line a rule touched records which rule, from which application, and how
 * much.
 *
 * THE ORDER, which is the whole of what this file decides:
 *
 *   1. Percentages, each taken from the line's price after member pricing
 *      and never from another rule's result, so two percentages give the
 *      same answer in either order.
 *   2. Amounts, spread over the lines by what each comes to, to the cent.
 *   3. Nothing taken off a line below nothing: a reduction stops at zero.
 *   4. A minimum charge last, on what the document comes to after all of
 *      the above, spread the same way. Only the largest minimum that applies
 *      counts, because "never less than 150" and "never less than 200" mean
 *      200.
 *
 * Money taken off is written into the line's discount, the way a member's
 * discount is, so it posts as a discount with revenue at the full price.
 * Money added raises the line's unit price, so it posts as revenue; the
 * record on the line keeps the price before it.
 */

export const RULE_KINDS = ["customer_tag", "job_type", "time_window", "minimum_charge"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const RULE_KIND_LABEL: Record<RuleKind, string> = {
  customer_tag: "Customer tag",
  job_type: "Job type",
  time_window: "Time of the work",
  minimum_charge: "Minimum charge",
};

/**
 * Days 0 (Sunday) to 6, and a span of the day as "HH:MM" in the company's own zone.
 *
 * `days` are the days the window STARTS on. When `to` is earlier than `from` the
 * window runs past midnight into the next day: "from 18:00 to 06:00" on Monday
 * is Monday from six in the evening until Tuesday at six in the morning, so work
 * at three on Tuesday morning is inside it because the window that holds it
 * started on Monday, a listed day. Work at three on Monday morning is not,
 * unless Sunday is listed. `to` of "24:00" is the end of the same day.
 */
export interface TimeWindow { days: number[]; from: string; to: string }

export interface PricingRule {
  kind: RuleKind;
  /** `customer_tag`: the tag, as a person typed it. Compared ignoring case and spacing. */
  tag?: string;
  /** `job_type`: the job type's id. */
  jobTypeId?: string;
  /** `time_window`: a window, or the company's own hours turned inside out. */
  window?: "outside_hours" | TimeWindow;
  /** A signed percentage, "-10" or "15". Exactly one of this and `amount`. */
  percent?: string;
  /** A signed amount for the whole document, "-25.00" or "75.00". */
  amount?: string;
  /** `minimum_charge`: the least the document comes to. */
  minimum?: string;
}

/**
 * What a rule reads. A rule on a customer's tag makes the product read the
 * customer every time a line is priced, so the application has to be able
 * to read customers itself; the same for jobs and visits. A minimum charge
 * reads nothing beyond the document.
 */
export const RULE_READS: Record<RuleKind, Permission[]> = {
  customer_tag: ["customer:read"],
  job_type: ["job:read"],
  time_window: ["visit:read"],
  minimum_charge: [],
};

const PERCENT = /^-?\d{1,3}(\.\d{1,2})?$/;
const AMOUNT = /^-?\d{1,6}(\.\d{1,2})?$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** "HH:MM" as minutes since midnight. */
export const minuteOf = (clock: string): number => {
  const [h, min] = clock.split(":").map(Number);
  return h! * 60 + min!;
};

/**
 * Check a rule, every problem at once. `jobTypeIds` is the company's job
 * types, so a rule for a kind of work the company does not have is refused
 * rather than registered to apply to nothing.
 */
export function checkPricingRule(input: unknown, known: { jobTypeIds: readonly string[] }): Checked<PricingRule> {
  if (!isRecord(input)) return { ok: false, problems: ["A pricing rule is an object with a kind."] };
  const kind = input["kind"];
  if (typeof kind !== "string" || !(RULE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, problems: [`A rule's kind is one of ${RULE_KINDS.join(", ")}.`] };
  }
  const problems: string[] = [];
  const rule: PricingRule = { kind: kind as RuleKind };

  if (kind === "minimum_charge") {
    const minimum = typeof input["minimum"] === "string" ? input["minimum"] : "";
    if (!AMOUNT.test(minimum) || minimum.startsWith("-") || Number(minimum) <= 0) {
      problems.push("A minimum charge is an amount above nothing, such as \"150.00\".");
    } else rule.minimum = m.toString(m.round(m.money(minimum), 2));
    if (input["percent"] !== undefined || input["amount"] !== undefined) {
      problems.push("A minimum charge has a minimum, not a percentage or an amount.");
    }
    return problems.length > 0 ? { ok: false, problems } : { ok: true, value: rule };
  }

  if (kind === "customer_tag") {
    const verdict = normalizeTag(typeof input["tag"] === "string" ? input["tag"] : "");
    if (!verdict.ok) problems.push(verdict.message);
    else rule.tag = verdict.tag;
  }
  if (kind === "job_type") {
    const id = typeof input["jobTypeId"] === "string" ? input["jobTypeId"] : "";
    if (!UUID.test(id) || !known.jobTypeIds.includes(id)) problems.push("That job type is not one of the company's.");
    else rule.jobTypeId = id;
  }
  if (kind === "time_window") {
    const window = input["window"];
    if (window === "outside_hours") {
      rule.window = "outside_hours";
    } else if (isRecord(window)) {
      const days = Array.isArray(window["days"]) ? window["days"] as unknown[] : [];
      const from = typeof window["from"] === "string" ? window["from"] : "";
      const to = typeof window["to"] === "string" ? window["to"] : "";
      const goodDays = days.length > 0 && days.length <= 7
        && days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
        && new Set(days).size === days.length;
      if (!goodDays) problems.push("A window's days are 0 (Sunday) to 6 (Saturday), each once.");
      if (!CLOCK.test(from) || !CLOCK.test(to)) problems.push("A window's times are \"HH:MM\" on the 24 hour clock.");
      else if (from === "24:00") {
        problems.push("A window cannot start at 24:00. Start it at 00:00, the first minute of the day.");
      } else if (minuteOf(from) === minuteOf(to)) {
        problems.push("A window has to start and end at different times. One that runs past midnight is fine: from 18:00 to 06:00 is the evening and the night after it.");
      }
      if (goodDays && CLOCK.test(from) && CLOCK.test(to)) {
        rule.window = { days: [...(days as number[])].sort((a, b) => a - b), from, to };
      }
    } else {
      problems.push("A time window is \"outside_hours\" or an object with days, from and to.");
    }
  }

  const percent = input["percent"];
  const amount = input["amount"];
  if ((percent === undefined) === (amount === undefined)) {
    problems.push("A rule gives exactly one of a percentage and an amount.");
  } else if (percent !== undefined) {
    if (typeof percent !== "string" || !PERCENT.test(percent) || Number(percent) === 0
      || Number(percent) < -100 || Number(percent) > 100) {
      problems.push("A percentage is between -100 and 100 and not nothing, as a string such as \"-10\" or \"15\".");
    } else rule.percent = percent;
  } else if (typeof amount !== "string" || !AMOUNT.test(amount) || Number(amount) === 0) {
    problems.push("An amount is not nothing, as a string such as \"-25.00\" or \"75.00\".");
  } else {
    rule.amount = m.toString(m.round(m.money(amount), 2));
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: rule };
}

/** The rule in one sentence, for the line it touched and the screen that lists it. */
export function describeRule(rule: PricingRule): string {
  const effect = rule.percent !== undefined
    ? `${rule.percent.startsWith("-") ? rule.percent.slice(1) : rule.percent}% ${rule.percent.startsWith("-") ? "off" : "added"}`
    : rule.amount !== undefined
      ? `${m.format(m.abs(m.money(rule.amount)))} ${rule.amount.startsWith("-") ? "off" : "added"}`
      : "";
  switch (rule.kind) {
    case "customer_tag": return `${effect} for customers tagged "${rule.tag}"`;
    case "job_type": return `${effect} on this job type`;
    case "time_window": {
      const window = rule.window;
      if (window === "outside_hours" || window === undefined) return `${effect} for work outside your hours`;
      const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const days = window.days.map((d) => names[d]).join(", ");
      /** Past midnight, the window is named by the day it starts, and says it ends the next one. */
      return windowWraps(window)
        ? `${effect} for work from ${window.from} on ${days} until ${window.to} the next day`
        : `${effect} for work on ${days} from ${window.from} to ${window.to}`;
    }
    case "minimum_charge": return `at least ${m.format(m.money(rule.minimum ?? "0"))} in all`;
  }
}

/** What the product knows about the sale when it prices it. */
export interface RuleFacts {
  /** The customer whose work it is: the job's customer, or the document's. */
  customerTags: readonly string[];
  jobTypeId: string | null;
  /**
   * When the work was booked for: the start of the window of the job's
   * first visit not cancelled, in the company's zone. Null when there is
   * no job or no booked visit, and then no time rule applies.
   */
  work: { dayOfWeek: number; minute: number; outsideHours: boolean } | null;
}

/** Whether a window runs past midnight: it ends at an earlier time than it starts. */
export const windowWraps = (window: TimeWindow): boolean => minuteOf(window.to) < minuteOf(window.from);

/**
 * Whether work at `minute` on `dayOfWeek` is inside a window.
 *
 * A window that ends the same day is its days, between `from` and `to`. One
 * that runs past midnight holds two stretches of a day: the evening of a listed
 * day (from `from` to midnight) and the morning after a listed day (midnight to
 * `to`), so the morning is matched against YESTERDAY's day. Sunday's early
 * hours belong to a window that started on Saturday.
 */
export function inWindow(window: TimeWindow, dayOfWeek: number, minute: number): boolean {
  const from = minuteOf(window.from);
  const to = minuteOf(window.to);
  if (from < to) return window.days.includes(dayOfWeek) && minute >= from && minute < to;
  return (window.days.includes(dayOfWeek) && minute >= from)
    || (window.days.includes((dayOfWeek + 6) % 7) && minute < to);
}

export function ruleMatches(rule: PricingRule, facts: RuleFacts): boolean {
  switch (rule.kind) {
    case "customer_tag":
      return rule.tag !== undefined && facts.customerTags.some((tag) => tagKey(tag) === tagKey(rule.tag!));
    case "job_type":
      return rule.jobTypeId !== undefined && facts.jobTypeId === rule.jobTypeId;
    case "time_window": {
      if (!facts.work || rule.window === undefined) return false;
      if (rule.window === "outside_hours") return facts.work.outsideHours;
      return inWindow(rule.window, facts.work.dayOfWeek, facts.work.minute);
    }
    case "minimum_charge":
      return true;
  }
}

/** A rule as the pricing code is handed it. */
export interface ActiveRule {
  id: string;
  name: string;
  appName: string;
  version: number;
  rule: PricingRule;
}

/** One line as the rules see it. */
export interface RuleLine {
  quantity: string;
  unitPrice: m.Money;
  /** Everything already taken off: typed by hand and the member's plan. */
  discountAmount: m.Money;
  /** Priced from the company's own price book, and so a line a rule may touch. */
  touchable: boolean;
  /**
   * Part of what the customer pays: not an optional line left unticked on an
   * estimate. An amount and a minimum are spread over these only, because an
   * optional line may never be bought.
   */
  counts: boolean;
}

/** What one rule did to one line. Negative took money off, positive added it. */
export interface AppliedRule {
  ruleId: string;
  name: string;
  appName: string;
  version: number;
  kind: RuleKind;
  amount: string;
  /** The line's unit price before any rule raised it. */
  unitPriceBefore: string;
}

export interface RuledLine {
  unitPrice: m.Money;
  discountAmount: m.Money;
  applied: AppliedRule[];
}

const net = (line: { quantity: string; unitPrice: m.Money; discountAmount: m.Money }) =>
  m.subtract(m.multiply(line.unitPrice, line.quantity), line.discountAmount);

const positiveQuantity = (quantity: string) => {
  try { return m.isPositive(m.money(quantity)); } catch { return false; }
};

/** "-12.5" as the exact factor "-0.125000", without a float anywhere near it. */
function percentFactor(percent: string): string {
  const units = m.money(percent).amount;
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

/** Spread an amount over lines by what each comes to, to the cent; evenly when they all come to nothing. */
function spread(amount: m.Money, weights: m.Money[]): m.Money[] {
  const positive = weights.map((w) => (m.isPositive(w) ? m.toString(w) : "0"));
  const ratios = positive.every((w) => Number(w) === 0) ? weights.map(() => "1") : positive;
  return m.allocate(amount, ratios, 2);
}

/**
 * Apply the rules that hold for this sale to its lines, in the order above.
 * Pure: the same lines, rules and facts give the same answer, which is what
 * lets an estimate and the invoice from it be priced by one function.
 */
export function applyPricingRules(
  lines: readonly RuleLine[], rules: readonly ActiveRule[], facts: RuleFacts,
): RuledLine[] {
  const matching = rules.filter((r) => ruleMatches(r.rule, facts));
  const out: RuledLine[] = lines.map((line) => ({ unitPrice: line.unitPrice, discountAmount: line.discountAmount, applied: [] }));
  if (matching.length === 0) return out;

  /** Lines a rule may touch: from the price book, for a positive quantity. */
  const touch = lines.map((line) => line.touchable && positiveQuantity(line.quantity));
  const base = lines.map((line) => net(line));
  /** Each rule's effect on each line, in order, before it is written into the line. */
  const deltas: Array<Array<{ rule: ActiveRule; amount: m.Money }>> = lines.map(() => []);
  const running = base.slice();

  const add = (i: number, rule: ActiveRule, amount: m.Money) => {
    if (m.isZero(amount)) return;
    let taken = amount;
    /** A reduction stops at nothing. */
    if (m.isNegative(taken) && m.compare(m.negate(taken), running[i]!) > 0) {
      taken = m.isPositive(running[i]!) ? m.negate(running[i]!) : m.zero(amount.currency);
    }
    if (m.isZero(taken)) return;
    running[i] = m.add(running[i]!, taken);
    deltas[i]!.push({ rule, amount: taken });
  };

  /* 1. Percentages, each from the price after member pricing. */
  for (const rule of matching.filter((r) => r.rule.percent !== undefined)) {
    const factor = percentFactor(rule.rule.percent!);
    lines.forEach((_, i) => {
      if (!touch[i] || !m.isPositive(base[i]!)) return;
      add(i, rule, m.round(m.multiply(base[i]!, factor), 2));
    });
  }

  /* 2. Amounts, spread over the lines that are bought. */
  for (const rule of matching.filter((r) => r.rule.amount !== undefined)) {
    const targets = lines.map((line, i) => i).filter((i) => touch[i] && lines[i]!.counts);
    if (targets.length === 0) continue;
    const parts = spread(m.money(rule.rule.amount!), targets.map((i) => running[i]!));
    targets.forEach((i, j) => add(i, rule, parts[j]!));
  }

  /* 4. The largest minimum, on what the document now comes to. */
  const minimums = matching.filter((r) => r.rule.kind === "minimum_charge" && r.rule.minimum !== undefined)
    .sort((a, b) => m.compare(m.money(b.rule.minimum!), m.money(a.rule.minimum!)));
  const minimum = minimums[0];
  if (minimum) {
    const total = m.sum(lines.map((line, i) => (line.counts ? running[i]! : m.zero())), "USD");
    const short = m.round(m.subtract(m.money(minimum.rule.minimum!), total), 2);
    const targets = lines.map((_, i) => i).filter((i) => touch[i] && lines[i]!.counts);
    if (m.isPositive(short) && targets.length > 0) {
      const parts = spread(short, targets.map((i) => running[i]!));
      targets.forEach((i, j) => add(i, minimum, parts[j]!));
    }
  }

  /* Written into each line: what came off into its discount, what was added into its price. */
  lines.forEach((line, i) => {
    const these = deltas[i]!;
    if (these.length === 0) return;
    const off = m.sum(these.filter((d) => m.isNegative(d.amount)).map((d) => m.negate(d.amount)), "USD");
    const added = m.sum(these.filter((d) => m.isPositive(d.amount)).map((d) => d.amount), "USD");
    const before = line.unitPrice;
    /**
     * Added money raises the unit price, rounded up to the fourth place so
     * the line never comes to less than the rule said. What the price rose
     * by, times the quantity, is what the record says was added: the few
     * hundredths of a cent of rounding go on the last rule that added
     * anything, so the records on a line add up to what changed on it.
     */
    const raise = m.isPositive(added) ? m.divide(added, line.quantity, "up") : m.zero();
    const unitPrice = m.add(before, raise);
    const actuallyAdded = m.subtract(m.multiply(unitPrice, line.quantity), m.multiply(before, line.quantity));
    const lastPositive = these.map((d) => m.isPositive(d.amount)).lastIndexOf(true);
    out[i] = {
      unitPrice,
      discountAmount: m.add(line.discountAmount, off),
      applied: these.map((d, k) => ({
        ruleId: d.rule.id,
        name: d.rule.name,
        appName: d.rule.appName,
        version: d.rule.version,
        kind: d.rule.rule.kind,
        amount: m.toString(k === lastPositive ? m.add(d.amount, m.subtract(actuallyAdded, added)) : d.amount),
        unitPriceBefore: m.toString(before),
      })),
    };
  });
  return out;
}

/** The part of a line's discount its pricing rules gave, from what the line recorded. */
export function ruleDiscount(applied: readonly { amount: string }[] | null | undefined): m.Money {
  return m.sum((applied ?? []).map((a) => m.money(a.amount)).filter((a) => m.isNegative(a)).map((a) => m.negate(a)), "USD");
}

/** What a line's price was before any rule raised it, from what the line recorded. */
export function priceBeforeRules(unitPrice: string, applied: readonly { unitPriceBefore: string }[] | null | undefined): string {
  return applied && applied.length > 0 ? applied[0]!.unitPriceBefore : unitPrice;
}
