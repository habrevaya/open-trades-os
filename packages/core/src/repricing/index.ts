import {
  type Money, money, toString, add, subtract, multiply, divide, round, compare, isPositive, isZero,
} from "../money/index.js";

/**
 * CHANGING MANY PRICES AT ONCE
 *
 * A trade pack seeds a price book at national averages, and re-pricing it
 * for one market item by item is the job nobody finishes. So the book stays
 * at national averages and every quote is wrong in the same direction. This
 * is the arithmetic for a change applied to a selection: a percentage, a
 * fixed amount, a target margin over cost, and rounding to a price ending.
 *
 * WHAT THIS DECIDES IS ONE ITEM'S NEW PRICE OR WHY IT HAS NONE. The service
 * selects, previews and writes versions; the arithmetic lives here so the
 * preview a person reads and the prices that are written are computed by the
 * same function and cannot disagree.
 *
 * NO FLOATS. Every figure is a decimal string through the money module, for
 * the reason that module gives: a percentage applied to 1,200 items in
 * floating point produces a handful of prices a cent off, and nobody finds
 * them until a customer does.
 */

export type Adjustment =
  /** Up or down by a percentage: "5" is five per cent up, "-10" ten down. */
  | { kind: "percent"; percent: string }
  /** Up or down by an amount: "12.50", or "-5". */
  | { kind: "amount"; amount: string }
  /**
   * Priced so the margin over cost is this: "0.45" is a price whose cost is
   * fifty five per cent of it. Margin, not markup, because margin is what the
   * price book has always shown and a person setting "45" while reading "45"
   * on the screen beside it should get the same number back.
   */
  | { kind: "margin"; margin: string }
  /** Leave the price where it is, for a rule that only rounds. */
  | { kind: "none" };

export interface RepriceRule {
  adjust: Adjustment;
  /**
   * Round up to the next price ending in these two digits of cents: "00",
   * "95", "99". Absent for no rounding.
   */
  ending?: string | undefined;
}

/**
 * The highest margin a rule may ask for.
 *
 * Not a judgement about pricing. At a margin of one the price is cost
 * divided by nothing, and close to one it is a hundred times cost, which is
 * a typo rather than a strategy.
 */
export const MAX_MARGIN = "0.95";
/** A percentage change beyond which a rule is a typo: a thousand per cent up. */
export const MAX_PERCENT = "1000";

export type RuleVerdict = { ok: true } | { ok: false; message: string };

/** Four places at most, which is what a price is stored to. A leading plus is allowed. */
const DECIMAL = /^[-+]?\d+(\.\d{1,4})?$/;
const num = (value: string): string => value.trim().replace(/^\+/, "");

/** Whether a rule is one worth previewing, in words when it is not. */
export function checkRule(rule: RepriceRule): RuleVerdict {
  const { adjust } = rule;
  switch (adjust.kind) {
    case "percent": {
      if (!DECIMAL.test(adjust.percent.trim())) return { ok: false, message: "Give the percentage as a number, like 5 or -10." };
      const p = money(num(adjust.percent));
      if (isZero(p)) return { ok: false, message: "A change of nought per cent changes nothing." };
      if (compare(p, money("-100")) <= 0) return { ok: false, message: "A cut of 100% or more would price everything at nothing." };
      if (compare(p, money(MAX_PERCENT)) > 0) return { ok: false, message: `More than ${MAX_PERCENT}% up is almost certainly a typo.` };
      break;
    }
    case "amount": {
      if (!DECIMAL.test(adjust.amount.trim())) return { ok: false, message: "Give the amount as a number, like 12.50 or -5." };
      if (isZero(money(num(adjust.amount)))) return { ok: false, message: "A change of nothing changes nothing." };
      break;
    }
    case "margin": {
      if (!DECIMAL.test(adjust.margin.trim())) return { ok: false, message: "Give the margin as a fraction, like 0.45 for 45%." };
      const m = money(num(adjust.margin));
      if (!isPositive(m)) return { ok: false, message: "A margin of nothing or less is selling at a loss." };
      if (compare(m, money(MAX_MARGIN)) > 0) {
        return { ok: false, message: "A margin above 95% prices things at more than twenty times cost, which is almost certainly a typo." };
      }
      break;
    }
    case "none":
      if (!rule.ending) return { ok: false, message: "Choose a change, a rounding, or both." };
      break;
  }
  if (rule.ending !== undefined && !/^\d{2}$/.test(rule.ending)) {
    return { ok: false, message: "A price ending is two digits of cents, like 00, 95 or 99." };
  }
  return { ok: true };
}

/**
 * Round UP to the next price whose cents are this ending.
 *
 * Up, and never to the nearest, so rounding never takes money off a price
 * somebody just decided: 218.40 to .95 is 218.95, 218.96 is 219.95, and a
 * price already on the ending stays where it is.
 */
export function roundToEnding(price: Money, ending: string): Money {
  const cents = BigInt(ending);
  const centsNow = round(price, 2, "up");
  // Minor units at scale four: one cent is 100n, one dollar 10_000n.
  const dollars = centsNow.amount >= 0n ? centsNow.amount / 10_000n : 0n;
  const candidate = dollars * 10_000n + cents * 100n;
  const amount = candidate >= centsNow.amount ? candidate : candidate + 10_000n;
  return { amount, currency: price.currency };
}

export interface RepriceInput {
  price: string;
  cost: string | null;
}

export type RepriceOutcome =
  | { changed: true; price: string }
  | { changed: false; reason: "no_cost" | "not_positive" | "unchanged"; message: string };

/**
 * One item's new price under a rule.
 *
 * Cents at the end, half up, because a percentage of 218.40 is 229.32 and a
 * price book holding 229.3200 and 229.3199 side by side is one somebody
 * cannot read.
 */
export function reprice(item: RepriceInput, rule: RepriceRule): RepriceOutcome {
  const before = money(item.price);
  let after: Money;

  switch (rule.adjust.kind) {
    case "percent": {
      const factor = toString(add(money("1"), divide(money(num(rule.adjust.percent)), "100")));
      after = round(multiply(before, factor), 2);
      break;
    }
    case "amount":
      after = round(add(before, money(num(rule.adjust.amount))), 2);
      break;
    case "margin": {
      if (item.cost === null) {
        return {
          changed: false, reason: "no_cost",
          message: "No cost recorded, so there is no margin to set. Record its cost first.",
        };
      }
      const cost = money(item.cost);
      if (!isPositive(cost)) {
        return {
          changed: false, reason: "no_cost",
          message: "Its cost is recorded as nothing, so any price is all margin.",
        };
      }
      const keep = toString(subtract(money("1"), money(num(rule.adjust.margin))));
      after = round(divide(cost, keep), 2, "up");
      break;
    }
    case "none":
      after = before;
      break;
  }

  if (rule.ending !== undefined) after = roundToEnding(after, rule.ending);

  if (!isPositive(after)) {
    return {
      changed: false, reason: "not_positive",
      message: "This would price it at nothing or less, so it is left as it is.",
    };
  }
  if (compare(after, before) === 0) {
    return { changed: false, reason: "unchanged", message: "Already at that price." };
  }
  return { changed: true, price: toString(after) };
}

/**
 * Margin over cost as a fraction, or null when there is nothing to divide.
 *
 * The same definition the price book list uses: (price minus cost) over
 * price. Four places, as a string.
 */
export function marginOf(price: string, cost: string | null): string | null {
  if (cost === null) return null;
  const p = money(price);
  if (isZero(p)) return null;
  const margin = divide(subtract(p, money(cost)), toString(p));
  // `divide` keeps four places of money; a margin is a rate and is read to four.
  return toString(margin);
}

/**
 * The rule as a sentence an owner checks against what they meant.
 *
 * Stored on the change when it is applied, so the record of what was done
 * says it in the words that were on the screen at the time.
 */
export function describeRule(rule: RepriceRule): string {
  const parts: string[] = [];
  const { adjust } = rule;
  switch (adjust.kind) {
    case "percent": {
      const p = num(adjust.percent);
      parts.push(p.startsWith("-") ? `Down ${p.slice(1)}%` : `Up ${p}%`);
      break;
    }
    case "amount": {
      const a = num(adjust.amount);
      parts.push(a.startsWith("-") ? `Down $${a.slice(1)}` : `Up $${a}`);
      break;
    }
    case "margin":
      parts.push(`Priced to a ${trimPercent(adjust.margin)}% margin over cost`);
      break;
    case "none":
      break;
  }
  if (rule.ending !== undefined) {
    parts.push(parts.length === 0 ? `Rounded up to the next .${rule.ending}` : `rounded up to the next .${rule.ending}`);
  }
  return parts.join(", ");
}

/** "0.45" reads as "45", "0.375" as "37.5". */
function trimPercent(fraction: string): string {
  const scaled = toString(multiply(money(num(fraction)), "100"));
  return scaled.replace(/\.?0+$/, "");
}

/**
 * The rule that undoes a change, item by item: each item back to the price
 * it had. Not a rule at all in the sense above, because "undo five per cent
 * up" is not "five per cent down" (that lands 25 cents short on a 100 dollar
 * item), so a reversal is written as the old prices themselves.
 */
export function reversalOf(line: { priceBefore: string; priceAfter: string; priceNow: string }):
  | { ok: true; price: string }
  | { ok: false; message: string } {
  if (compare(money(line.priceNow), money(line.priceAfter)) !== 0) {
    return {
      ok: false,
      message: "Its price has been changed again since, so putting the old one back would undo that too.",
    };
  }
  return { ok: true, price: line.priceBefore };
}
