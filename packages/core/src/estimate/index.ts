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
 * percent, or neither, or a percentage above one hundred, each of which is a
 * configuration mistake that should surface at setup rather than silently
 * overcharge a customer.
 */
export function computeDeposit(total: Money, policy: DepositPolicy): Money {
  const currency = total.currency;
  const hasAmount = policy.amount !== undefined;
  const hasPercent = policy.percent !== undefined;

  if (hasAmount && hasPercent) {
    throw new DepositError("A deposit policy sets an amount or a percent, not both.");
  }
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
