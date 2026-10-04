/**
 * PRICING ON THE GLASS
 *
 * What a customer is shown on a technician's phone, worked out on the phone
 * with no signal, has to be the figure the server writes when the phone gets
 * one: an estimate the customer signed at $4,210.00 that lands in the office
 * at $4,209.99 is a disagreement about what was agreed, and the signature
 * records the server's hash, not the phone's picture. So the phone does the
 * sum the server does, line for line: the price times the quantity, less any
 * discount, less the member's discount where a plan gives one (per line,
 * rounded to the cent on each, off what is left), tax held at full precision
 * per line and the document rounded once at the bottom.
 *
 * IMPORTS NOTHING, ON PURPOSE. The phone app bundles this one file
 * (`@opentradesos/core/field-pricing`), and the bundler that builds it does
 * not follow the rest of core's imports, the reason `location` gives. So the
 * money arithmetic is written out here on bigints, and a test in core holds
 * every answer to `estimate.computeOption`, `ledger.computeInvoice` and
 * `membership.memberDiscounts` over thousands of random documents. If those
 * change and this does not, that test fails, rather than a customer being
 * shown one figure and billed another.
 *
 * No cost and no margin, ever: this is what a customer reads.
 */

/** Scale four, the same as core's money and `numeric(14,4)`. */
const FACTOR = 10_000n;

function parse(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new TypeError(`Not a decimal string: ${JSON.stringify(value)}`);
  const negative = trimmed.startsWith("-");
  const [whole = "0", frac = ""] = trimmed.replace("-", "").split(".");
  if (frac.length > 4) throw new RangeError(`More than 4 decimal places would lose precision: ${value}`);
  const amount = BigInt(whole) * FACTOR + BigInt(frac.padEnd(4, "0") || "0");
  return negative ? -amount : amount;
}

function show(amount: bigint): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  return `${negative ? "-" : ""}${abs / FACTOR}.${(abs % FACTOR).toString().padStart(4, "0")}`;
}

/** Half up, away from zero: what a person doing it on paper does, and what core does. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d && remainder !== 0n ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function times(amount: bigint, factor: string): bigint {
  const trimmed = factor.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new TypeError(`Not a decimal string: ${JSON.stringify(factor)}`);
  const negative = trimmed.startsWith("-");
  const [whole = "0", frac = ""] = trimmed.replace("-", "").split(".");
  const value = BigInt(whole + frac) * (negative ? -1n : 1n);
  return divideHalfUp(amount * value, 10n ** BigInt(frac.length));
}

const toCents = (amount: bigint): bigint => divideHalfUp(amount, 100n) * 100n;

/** The same test as `membership.usableRate`: a fraction strictly between nothing and all of it. */
function usableRate(rate: string | null | undefined): rate is string {
  if (rate === null || rate === undefined || rate.trim() === "") return false;
  const n = Number(rate);
  return Number.isFinite(n) && n > 0 && n < 1;
}

/** What a member's plan gives, as the server sends it with the day. */
export interface OnSiteMember {
  /** The discount as a fraction, "0.15" for fifteen per cent. "0" for a plan that only waives a fee. */
  rate: string;
  waivesDiagnosticFee: boolean;
  waivesAfterHoursRate: boolean;
  /**
   * The price book items the plan's discount leaves out, flattened by the
   * server from the categories and items the plan names, because the phone
   * carries the price book without its categories. Absent for none.
   */
  excludedItemIds?: readonly string[] | undefined;
}

export interface OnSiteLine {
  quantity: string;
  unitPrice: string;
  /** A discount somebody typed. The phone offers none; a document copied from the office may carry one. */
  discountAmount?: string | undefined;
  taxable: boolean;
  /** The rate as a fraction, "0.0825". */
  taxRate: string;
  /** Priced and shown, outside the total until the customer ticks it. */
  isOptional?: boolean | undefined;
  isSelected?: boolean | undefined;
  /**
   * The price book item's kind, which decides whether the member rate
   * touches the line at all (a discount item never takes one). Null for a
   * line typed by hand.
   */
  itemKind?: string | null | undefined;
  /** "diagnostic" or "after_hours" when the line is a fee a plan may waive. */
  feeRole?: string | null | undefined;
  /** The price book item the line came from, which decides whether the plan leaves it out. Null for a typed line. */
  itemId?: string | null | undefined;
  /**
   * The member's discount already on the line, for a document the office
   * priced. When given, the line is shown as priced and nothing is worked
   * out again: the discount is inside `discountAmount` already.
   */
  memberDiscountAmount?: string | undefined;
}

export interface PricedLine {
  /** What the plan took off this line. "0.0000" when it took nothing. */
  memberDiscount: string;
  /** Every discount on the line, typed and member together. */
  discountAmount: string;
  /** Price times quantity, before any discount. */
  gross: string;
  /** What the line comes to before tax, to the cent. */
  lineTotal: string;
  taxAmount: string;
  /** Whether it counts toward the total: not optional, or optional and ticked. */
  included: boolean;
}

export interface PricedTotals {
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  /** What the plan saved on the lines that count. */
  memberSavings: string;
}

/**
 * Whether a line takes the member rate. The same rule as
 * `membership.eligibleForMemberPricing`: nothing off a line that costs
 * nothing, and nothing off a discount item, which is already a reduction.
 */
export function memberEligible(line: Pick<OnSiteLine, "unitPrice" | "itemKind">): boolean {
  if (parse(line.unitPrice) <= 0n) return false;
  return line.itemKind !== "discount";
}

/**
 * One document, priced the way the server prices it.
 *
 * An estimate option and an invoice on site are both this: every line is
 * worked out (so an optional extra the customer has not ticked still shows
 * its price), and only the lines that count roll up into the totals.
 */
export function priceOnSite(
  lines: readonly OnSiteLine[],
  member: OnSiteMember | null = null,
): { lines: PricedLine[]; totals: PricedTotals } {
  const worked = lines.map((line) => {
    const gross = times(parse(line.unitPrice), line.quantity);
    const typed = parse(line.discountAmount ?? "0");
    let memberOff = 0n;
    if (line.memberDiscountAmount !== undefined) {
      // Priced already, and the member's part is inside the discount.
      memberOff = parse(line.memberDiscountAmount);
    } else if (member && memberEligible(line)) {
      const net = gross - typed;
      if (net > 0n) {
        const waived = (line.feeRole === "diagnostic" && member.waivesDiagnosticFee)
          || (line.feeRole === "after_hours" && member.waivesAfterHoursRate);
        const excluded = line.itemId !== null && line.itemId !== undefined
          && (member.excludedItemIds ?? []).includes(line.itemId);
        if (waived) memberOff = net;
        else if (!excluded && usableRate(member.rate)) {
          const off = toCents(times(net, member.rate));
          memberOff = off > net ? net : off;
        }
      }
    }
    const discount = line.memberDiscountAmount !== undefined ? typed : typed + memberOff;
    const net = gross - discount;
    const tax = line.taxable ? times(net, line.taxRate) : 0n;
    return {
      gross, discount, net, tax, memberOff,
      included: !line.isOptional || line.isSelected === true,
    };
  });

  const counted = worked.filter((w) => w.included);
  const subtotal = toCents(counted.reduce((sum, w) => sum + w.gross, 0n));
  const discountTotal = toCents(counted.reduce((sum, w) => sum + w.discount, 0n));
  const taxTotal = toCents(counted.reduce((sum, w) => sum + w.tax, 0n));
  const total = toCents(subtotal - discountTotal + taxTotal);

  return {
    lines: worked.map((w) => ({
      memberDiscount: show(w.memberOff),
      discountAmount: show(w.discount),
      gross: show(w.gross),
      lineTotal: show(toCents(w.net)),
      taxAmount: show(toCents(w.tax)),
      included: w.included,
    })),
    totals: {
      subtotal: show(subtotal),
      discountTotal: show(discountTotal),
      taxTotal: show(taxTotal),
      total: show(total),
      memberSavings: show(toCents(counted.reduce((sum, w) => sum + w.memberOff, 0n))),
    },
  };
}

/** Two amounts as money, compared to the cent: what the customer saw against what the server worked out. */
export function sameAmount(a: string, b: string): boolean {
  return toCents(parse(a)) === toCents(parse(b));
}

/** A tax percentage typed on the phone ("8.25") as the fraction a line carries ("0.0825"), or null. */
export function rateFromPercent(typed: string): string | null {
  const text = typed.trim().replace(/%$/, "").trim();
  if (text === "") return "0";
  if (!/^\d{1,2}(\.\d{1,4})?$/.test(text)) return null;
  const [whole = "0", frac = ""] = text.split(".");
  const digits = BigInt(whole + frac.padEnd(4, "0"));
  // Percent to fraction is two places to the left: six places in all.
  const scaled = digits.toString().padStart(7, "0");
  const fraction = `${scaled.slice(0, -6) || "0"}.${scaled.slice(-6)}`.replace(/0+$/, "").replace(/\.$/, "");
  return fraction === "" ? "0" : fraction;
}

/**
 * What each suggested tip comes to on an amount, to the cent: the same
 * figures `customerPortal.tipChoices` puts on the portal's pay button, so a
 * customer offered fifteen per cent at the door is offered what they would
 * have been offered online.
 */
export function tipChoices(amount: string, presets: readonly number[]): { percent: number; amount: string }[] {
  const base = parse(amount);
  return presets.map((percent) => ({ percent, amount: show(toCents(times(base, String(percent / 100)))) }));
}

/** A sum of decimal strings, exactly, for a screen adding a tip to a payment. */
export function addAmounts(...amounts: string[]): string {
  return show(amounts.reduce((sum, a) => sum + parse(a), 0n));
}
