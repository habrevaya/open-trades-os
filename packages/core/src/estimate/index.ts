import {
  type Money, add, subtract, multiply, round, zero, compare, isZero, toString,
} from "../money/index.js";
import { computeInvoice, type InvoiceLineInput, type InvoiceTotals } from "../ledger/index.js";

/**
 * GOOD, BETTER, BEST
 *
 * An option is a whole scope of work, not a discount tier. The customer picks
 * one; the lines under the others never existed as far as the resulting job is
 * concerned. All the arithmetic below exists so that the option a customer
 * approved converts into an invoice that matches it to the cent, because an
 * invoice that disagrees with the approved quote is the fastest way to lose a
 * customer who was, a moment ago, happy.
 */

export interface EstimateLineInput extends InvoiceLineInput {
  /**
   * Priced and shown, but outside the option total until the customer ticks
   * it. The surge protector on a system replacement, the haul-away on a water
   * heater. Offering these separately sells more of them than folding them in.
   */
  isOptional?: boolean | undefined;
  isSelected?: boolean | undefined;
  unitCost?: Money | undefined;
}

export interface OptionTotals extends InvoiceTotals {
  /** What the base scope costs with nothing extra ticked. */
  baseTotal: Money;
  /** Everything on offer but not currently taken. The upsell still available. */
  optionalTotal: Money;
  /** Sum of unit costs, where known. Null when any included line lacks a cost. */
  cost: Money | null;
  /** Gross margin as a rate, e.g. "0.412". Null when cost is unknown. */
  margin: string | null;
}

/**
 * A line counts toward the total when it is not optional, or when it is
 * optional and the customer has taken it. Everything else is priced, shown and
 * excluded.
 */
function isIncluded(line: EstimateLineInput): boolean {
  return !line.isOptional || line.isSelected === true;
}

export function computeOption(lines: EstimateLineInput[]): {
  lines: ReturnType<typeof computeInvoice>["lines"];
  totals: OptionTotals;
} {
  const currency = lines[0]?.unitPrice.currency ?? "USD";
  const included = lines.filter(isIncluded);

  // Every line is computed so the customer sees a price against the options
  // they have not taken. Only the included ones roll up.
  const all = computeInvoice(lines);
  const { totals } = computeInvoice(included);

  const base = computeInvoice(lines.filter((l) => !l.isOptional));

  const untaken = lines
    .map((line, i) => ({ line, computed: all.lines[i]! }))
    .filter(({ line }) => line.isOptional && line.isSelected !== true);

  const optionalTotal = round(
    untaken.reduce((acc, { computed }) => add(acc, computed.lineTotal), zero(currency)),
    2,
  );

  /**
   * Cost is all-or-nothing on purpose. A margin computed from a scope where
   * three of eight lines happen to carry a cost is not a low margin, it is a
   * wrong one, and it will be read as the former. Better to show nothing than
   * a number that is confidently incorrect.
   */
  const missingCost = included.some((l) => l.unitCost === undefined);
  const cost = missingCost
    ? null
    : round(
        included.reduce(
          (acc, l) => add(acc, multiply(l.unitCost as Money, l.quantity)),
          zero(currency),
        ),
        2,
      );

  const revenue = subtract(totals.subtotal, totals.discountTotal);
  const margin =
    cost === null || isZero(revenue)
      ? null
      : divideToRate(subtract(revenue, cost), revenue);

  return {
    lines: all.lines,
    totals: {
      ...totals,
      baseTotal: base.totals.total,
      optionalTotal,
      cost,
      margin,
    },
  };
}

/** Six decimal places, matching the `rate` column in the schema. */
function divideToRate(numerator: Money, denominator: Money): string {
  const n = Number(toString(numerator));
  const d = Number(toString(denominator));
  return (n / d).toFixed(6);
}

/**
 * Which option to show first.
 *
 * Highest priced first, with the recommended one pulled to the front if the
 * company marked one. Presenting cheapest-first anchors the customer on the
 * cheapest, which is the whole reason good/better/best exists; every trade
 * that sells this way presents descending.
 */
export function presentationOrder<T extends { total: Money; isRecommended?: boolean }>(
  options: T[],
): T[] {
  const sorted = [...options].sort((a, b) => compare(b.total, a.total));
  const recommended = sorted.findIndex((o) => o.isRecommended === true);
  if (recommended <= 0) return sorted;
  const [pick] = sorted.splice(recommended, 1);
  return [pick!, ...sorted];
}

export class DepositError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepositError";
  }
}

export interface DepositPolicy {
  /** A flat amount. Mutually exclusive with `percent`. */
  amount?: Money | undefined;
  /** A share of the option total, e.g. "0.5" for half. */
  percent?: string | undefined;
  /** Optional ceiling, so a percentage on a large job stays reasonable. */
  maximum?: Money | undefined;
  /** Below this, do not ask. Collecting $18 up front costs more than it holds. */
  minimum?: Money | undefined;
}

/**
 * What to ask for up front.
 *
 * Returns zero rather than throwing when the policy resolves below the
 * minimum, because "no deposit on this one" is a normal outcome and not an
 * error. It throws only on a policy that cannot mean anything: both amount and
 * percent, or a percentage above one hundred, each of which is a configuration
 * mistake that should surface at setup rather than silently overcharge a
 * customer.
 *
 * It does NOT throw on a policy that sets neither. That is how a job taking
 * no deposit is expressed, and the branch below says what that costs.
 */
export function computeDeposit(total: Money, policy: DepositPolicy): Money {
  const currency = total.currency;
  const hasAmount = policy.amount !== undefined;
  const hasPercent = policy.percent !== undefined;

  if (hasAmount && hasPercent) {
    throw new DepositError("A deposit policy sets an amount or a percent, not both.");
  }
  /**
   * NEITHER SET MEANS NO DEPOSIT, and the comment above used to say this
   * threw.
   *
   * I changed the code to match the comment and a test that has been here
   * since this function was written went red: "asks for nothing when no
   * policy is set". The behaviour is deliberate, so the comment was the
   * thing that was wrong, which is the usual direction in this repository
   * and not the one I assumed.
   *
   * The limitation is real and is worth writing down rather than fixing on a
   * guess. An empty policy is ambiguous: it is how a job type that takes no
   * deposit is expressed, and it is also what a policy row looks like after
   * losing both of its columns. This function cannot tell them apart, so a
   * configuration mistake reads as "no deposit on this one" and the caller
   * has no way to notice. Resolving that needs the caller to distinguish
   * "no policy" from "a policy that asks for nothing" before it gets here,
   * which is a change to the shape rather than to this branch.
   */
  if (!hasAmount && !hasPercent) return zero(currency);

  if (hasPercent && Number(policy.percent) > 1) {
    throw new DepositError(
      `A deposit cannot exceed the total. Percent was ${policy.percent}, which is over 100%.`,
    );
  }

  let deposit = hasAmount
    ? (policy.amount as Money)
    : round(multiply(total, policy.percent as string), 2);

  // A flat deposit larger than the job is a typo, not a policy.
  if (compare(deposit, total) > 0) deposit = total;
  if (policy.maximum && compare(deposit, policy.maximum) > 0) deposit = policy.maximum;
  if (policy.minimum && compare(deposit, policy.minimum) < 0) return zero(currency);

  return deposit;
}

/**
 * How much of a held deposit a given invoice may consume.
 *
 * Never more than the deposit has left, and never more than the invoice is
 * asking for. Applying a $2,000 deposit to a $1,400 first invoice and leaving
 * the customer with a $600 credit they have to ring up about is the behaviour
 * this prevents: the remainder stays held against the next invoice on the job.
 */
export function applicableDeposit(input: {
  heldAmount: Money;
  alreadyApplied: Money;
  invoiceBalance: Money;
}): Money {
  const remaining = subtract(input.heldAmount, input.alreadyApplied);
  if (compare(remaining, zero(remaining.currency)) <= 0) return zero(remaining.currency);
  return compare(remaining, input.invoiceBalance) <= 0 ? remaining : input.invoiceBalance;
}

/* ------------------------------------------------- who may give money away */

/**
 * WHAT A DISCOUNT POLICY SAYS, AND WHO MAY EXCEED IT.
 *
 * `estimate_line.discount_amount` has existed since the first migration and
 * anybody holding `estimate:write` could set it to anything. The catalogue
 * declares `estimate:discount` and `estimate.discount.unlimited`, both
 * granted to roles and checked by nothing, so the two authorities a company
 * actually wants were a restriction the owner believed they had applied.
 *
 * THE DECISION IS IN CORE AND NOT IN THE SERVICE for the reason the overtime
 * policy gives: it is a rule about money with several edges, and a rule like
 * that written inside a database transaction is a rule nobody can test
 * without one. The service decides WHETHER to ask; this decides the answer.
 */

export interface DiscountPolicy {
  /** The most a holder of `estimate:discount` may take off, as a fraction. */
  maxPercent: string;
  /** An absolute ceiling as well, when the company set one. */
  maxAmount?: Money | undefined;
}

export interface DiscountRequest {
  /** The total discount across the option, as one figure. */
  discount: Money;
  /** The option's subtotal before any discount and before tax. */
  subtotal: Money;
  /** Does the caller hold `estimate:discount` at all. */
  mayDiscount: boolean;
  /** Does the caller hold `estimate.discount.unlimited`. */
  uncapped: boolean;
  /** The company's policy, or null when it has not set one. */
  policy: DiscountPolicy | null;
}

export type DiscountVerdict =
  | { allowed: true }
  | {
    allowed: false;
    /**
     * Which rule refused, as a code rather than a sentence, so a caller can
     * decide what to do about it. `over_cap` is the one worth routing to a
     * manager; the others are not.
     */
    reason: "no_authority" | "no_policy" | "over_cap" | "negative" | "exceeds_subtotal";
    /** The most this caller could have taken off. Null when none at all. */
    ceiling: Money | null;
  };

/**
 * May this discount be applied.
 *
 * THE ORDER OF THESE CHECKS IS LOAD BEARING, because the first one that
 * matches is the sentence somebody reads:
 *
 *   A zero discount is always allowed, before anything else. A line with no
 *   discount is an ordinary line, and requiring the permission to write one
 *   would mean a technician who may quote cannot quote at all.
 *
 *   A NEGATIVE discount is refused next, before any authority question.
 *   Nothing in the permission model makes a negative discount sensible: it is
 *   a surcharge wearing a discount's name, it would pass a cap check by being
 *   comfortably under it, and the total it produces is higher than the price
 *   the customer was shown.
 *
 *   A discount larger than the subtotal is refused before the cap, because it
 *   is not a question of authority either. An option that costs less than
 *   nothing is not a steep discount, it is a company paying somebody to take
 *   the work, and no permission should authorise it by accident.
 *
 *   Then authority, then the policy's existence, then the cap.
 */
export function checkDiscount(request: DiscountRequest): DiscountVerdict {
  const zeroOf = zero(request.discount.currency);

  if (compare(request.discount, zeroOf) === 0) return { allowed: true };

  if (compare(request.discount, zeroOf) < 0) {
    return { allowed: false, reason: "negative", ceiling: null };
  }

  if (compare(request.discount, request.subtotal) > 0) {
    return { allowed: false, reason: "exceeds_subtotal", ceiling: request.subtotal };
  }

  if (!request.mayDiscount && !request.uncapped) {
    return { allowed: false, reason: "no_authority", ceiling: zeroOf };
  }

  /**
   * Uncapped skips the policy entirely, INCLUDING its absence.
   *
   * Somebody holding `estimate.discount.unlimited` in a company that has
   * never opened the settings screen is still allowed, because the
   * permission's whole meaning is "not subject to the limit" and a limit that
   * does not exist is the easiest kind not to be subject to.
   */
  if (request.uncapped) return { allowed: true };

  if (!request.policy) {
    return { allowed: false, reason: "no_policy", ceiling: zeroOf };
  }

  /**
   * BOTH CEILINGS APPLY AND THE LOWER WINS.
   *
   * "Up to ten per cent, and never more than two thousand" is a sentence an
   * owner says out loud. The other reading, whichever is larger, would make
   * the second half authorise more than the first, which is the opposite of
   * what somebody writing a second limit intends.
   */
  const fromPercent = round(multiply(request.subtotal, request.policy.maxPercent), 2);
  const ceiling = request.policy.maxAmount
    && compare(request.policy.maxAmount, fromPercent) < 0
    ? request.policy.maxAmount
    : fromPercent;

  if (compare(request.discount, ceiling) > 0) {
    return { allowed: false, reason: "over_cap", ceiling };
  }
  return { allowed: true };
}

/**
 * The sentence for a refusal.
 *
 * Here rather than in the service so the wording is the same whichever
 * surface asked, and exhaustive over the union so a new reason cannot be
 * added without one.
 */
export function discountRefusal(verdict: Extract<DiscountVerdict, { allowed: false }>): string {
  switch (verdict.reason) {
    case "negative":
      return "A discount cannot be negative. That is a surcharge, and it would pass every "
        + "cap by being under it while charging the customer more than the price they saw.";
    case "exceeds_subtotal":
      return "That discount is larger than the option itself, which would price the work "
        + "below nothing.";
    case "no_authority":
      return "You do not have permission to discount an estimate. Somebody who does can "
        + "apply it.";
    case "no_policy":
      return "This company has not set a discount limit, so nobody is authorised to apply "
        + "one yet. Set the limit on the estimate settings screen.";
    case "over_cap":
      return `That is more than the limit for this company${
        verdict.ceiling ? `, which is ${toString(verdict.ceiling)} on this option` : ""
      }. Somebody with unlimited discount authority can apply it.`;
    default: {
      const unwritten: never = verdict.reason;
      return `That discount cannot be applied: ${String(unwritten)}`;
    }
  }
}

/* ------------------------------------------------------- the proposal page */

export type Tier = "Good" | "Better" | "Best";

/**
 * GOOD, BETTER AND BEST, named by price and never by position.
 *
 * Two or three options are a ladder and a customer reads them as one, so the
 * proposal says which rung each is. The rung is decided by the total, cheapest
 * first, because the presentation order puts the recommended option first
 * and a recommended middle option labelled "Good" because it was drawn
 * first would tell the customer the opposite of what the company meant.
 *
 * Two options are Good and Better rather than Good and Best: calling the
 * second of two "Best" claims there was nothing between them, and a customer
 * asks what happened to Better. One option is not a ladder, and four or more
 * are a menu rather than tiers, so neither gets a label and each keeps the
 * name somebody gave it. Two options at the same price are not a ladder
 * either: whichever was called Good would be a judgement nobody made.
 */
export function tierLabels(totals: readonly Money[]): (Tier | null)[] {
  if (totals.length < 2 || totals.length > 3) return totals.map(() => null);
  const order = totals
    .map((total, index) => ({ total, index }))
    .sort((a, b) => compare(a.total, b.total) || a.index - b.index);
  for (let i = 1; i < order.length; i += 1) {
    if (compare(order[i]!.total, order[i - 1]!.total) === 0) return totals.map(() => null);
  }
  const names: Tier[] = order.length === 2 ? ["Good", "Better"] : ["Good", "Better", "Best"];
  const out: (Tier | null)[] = totals.map(() => null);
  order.forEach((entry, rank) => { out[entry.index] = names[rank]!; });
  return out;
}

/* ------------------------------------------------- an estimate's history */

/**
 * How an estimate written in another system ended, for a migration.
 *
 * Without this every estimate a company brings across arrives as a draft,
 * and its close rate, its won and lost list and its average days to a yes
 * all start from the day of the cutover. The outcome is a statement about
 * the past, so it is checked as one: it needs a date, the date cannot be in
 * the future or before the estimate was written, and a win has to say which
 * option won.
 */
export interface HistoricalOutcome {
  status: "approved" | "declined" | "expired";
  /** The day it was decided, or for an expiry the day it lapsed. */
  on: string;
  /** For an approval: which option, by its position in the request, from nought. */
  chosenOption?: number | undefined;
}

export type HistoryVerdict = { ok: true } | { ok: false; message: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function checkHistory(
  outcome: HistoricalOutcome,
  context: { optionCount: number; issuedOn: string; today: string },
): HistoryVerdict {
  if (!ISO_DAY.test(outcome.on)) {
    return { ok: false, message: "The outcome needs the day it happened, as a date like 2024-03-18." };
  }
  if (outcome.on > context.today) {
    return { ok: false, message: "An outcome from history cannot be dated in the future." };
  }
  if (outcome.on < context.issuedOn) {
    return {
      ok: false,
      message: `The outcome is dated ${outcome.on}, before the estimate was written on ${context.issuedOn}.`,
    };
  }
  if (outcome.status === "approved") {
    if (outcome.chosenOption === undefined) {
      return {
        ok: false,
        message: "An approved estimate has to say which option was approved. Converting it later copies that option and no other.",
      };
    }
    if (!Number.isInteger(outcome.chosenOption)
      || outcome.chosenOption < 0 || outcome.chosenOption >= context.optionCount) {
      return {
        ok: false,
        message: `The chosen option is counted from nought, and this estimate has ${context.optionCount}.`,
      };
    }
  } else if (outcome.chosenOption !== undefined) {
    return { ok: false, message: `A ${outcome.status} estimate has no chosen option.` };
  }
  return { ok: true };
}

export * from "./proposal-layout.js";
