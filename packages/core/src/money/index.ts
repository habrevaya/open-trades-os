/**
 * MONEY
 *
 * No floats. Ever. `0.1 + 0.2 !== 0.3` is a curiosity in a blog post and a
 * lawsuit in an invoicing system.
 *
 * Money is a bigint of MINOR UNITS SCALED BY 10^4, plus a currency code. That
 * matches numeric(14,4) in the database exactly, so a value survives a round
 * trip through Postgres without a representation change.
 *
 * Why scale 4 and not 2:
 *
 *   - Unit costs are routinely quoted in fractions of a cent. Wire at
 *     $0.1875/ft, a chemical at $0.0042/oz. Rounding those to cents at the
 *     line level and then multiplying by 2,400 feet produces a number that is
 *     visibly wrong to the person holding the invoice.
 *   - Tax rates, commission splits and margin calculations all produce
 *     sub-cent intermediates.
 *   - Rounding is applied ONCE, at the document total, not on every line. That
 *     is the behavior every accountant expects and most systems get wrong.
 */

export type CurrencyCode = string;

export interface Money {
  /** Value scaled by 10,000. $12.34 is 123_400n. */
  readonly amount: bigint;
  readonly currency: CurrencyCode;
}

export const SCALE = 4;
const FACTOR = 10_000n;

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Cannot combine ${a} and ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

/**
 * Parse a decimal string. This is the ONLY entry point from the database and
 * from user input, and it deliberately does not accept a JS number, because
 * accepting one is how a float gets in.
 */
export function money(value: string, currency: CurrencyCode = "USD"): Money {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`Not a decimal string: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith("-");
  const [whole = "0", frac = ""] = trimmed.replace("-", "").split(".");
  if (frac.length > SCALE) {
    throw new RangeError(`More than ${SCALE} decimal places would lose precision: ${value}`);
  }
  const padded = frac.padEnd(SCALE, "0");
  const amount = BigInt(whole) * FACTOR + BigInt(padded || "0");
  return { amount: negative ? -amount : amount, currency };
}

export const zero = (currency: CurrencyCode = "USD"): Money => ({ amount: 0n, currency });

/** Exact decimal string, always with 4 places. What goes back to the database. */
export function toString(m: Money): string {
  const negative = m.amount < 0n;
  const abs = negative ? -m.amount : m.amount;
  const whole = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

export const add = (a: Money, b: Money): Money => (assertSame(a, b), { amount: a.amount + b.amount, currency: a.currency });
export const subtract = (a: Money, b: Money): Money => (assertSame(a, b), { amount: a.amount - b.amount, currency: a.currency });
export const negate = (m: Money): Money => ({ amount: -m.amount, currency: m.currency });
export const abs = (m: Money): Money => ({ amount: m.amount < 0n ? -m.amount : m.amount, currency: m.currency });

export const isZero = (m: Money) => m.amount === 0n;
export const isNegative = (m: Money) => m.amount < 0n;
export const isPositive = (m: Money) => m.amount > 0n;
export const compare = (a: Money, b: Money): number => (assertSame(a, b), a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0);
export const equals = (a: Money, b: Money) => a.currency === b.currency && a.amount === b.amount;

export const sum = (items: Money[], currency: CurrencyCode = "USD"): Money =>
  items.reduce(add, zero(items[0]?.currency ?? currency));

export const max = (a: Money, b: Money): Money => (compare(a, b) >= 0 ? a : b);
export const min = (a: Money, b: Money): Money => (compare(a, b) <= 0 ? a : b);

/**
 * Rounding. Half-up away from zero, which is what a person doing this by hand
 * on paper does, and what every invoice a customer has ever received uses.
 * Banker's rounding is correct for statistics and surprising on a receipt.
 */
export type RoundingMode = "half-up" | "half-even" | "down" | "up";

function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new RangeError("Division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;
  if (remainder === 0n) return negative ? -quotient : quotient;

  let rounded = quotient;
  const twice = remainder * 2n;
  switch (mode) {
    case "down": break;
    case "up": rounded = quotient + 1n; break;
    case "half-up": if (twice >= d) rounded = quotient + 1n; break;
    case "half-even":
      if (twice > d || (twice === d && quotient % 2n === 1n)) rounded = quotient + 1n;
      break;
  }
  return negative ? -rounded : rounded;
}

/**
 * Multiply by a quantity or a rate, given as a decimal STRING for the same
 * reason money is: a rate of 0.0825 is not representable as a float.
 */
export function multiply(m: Money, factor: string, mode: RoundingMode = "half-up"): Money {
  const f = parseRate(factor);
  return { amount: divideRounded(m.amount * f.value, f.divisor, mode), currency: m.currency };
}

export function divide(m: Money, divisor: string, mode: RoundingMode = "half-up"): Money {
  const d = parseRate(divisor);
  if (d.value === 0n) throw new RangeError("Division by zero");
  return { amount: divideRounded(m.amount * d.divisor, d.value, mode), currency: m.currency };
}

/** Round to a number of decimal places. Documents round to 2; lines do not. */
export function round(m: Money, places = 2, mode: RoundingMode = "half-up"): Money {
  if (places >= SCALE) return m;
  const step = 10n ** BigInt(SCALE - places);
  return { amount: divideRounded(m.amount, step, mode) * step, currency: m.currency };
}

function parseRate(rate: string): { value: bigint; divisor: bigint } {
  const trimmed = rate.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new TypeError(`Not a decimal string: ${JSON.stringify(rate)}`);
  const negative = trimmed.startsWith("-");
  const [whole = "0", frac = ""] = trimmed.replace("-", "").split(".");
  const value = BigInt(whole + frac) * (negative ? -1n : 1n);
  return { value, divisor: 10n ** BigInt(frac.length) };
}

/**
 * ALLOCATION
 *
 * Split an amount into parts by ratio without losing or inventing a cent.
 * The remainder is distributed one minor unit at a time to the largest parts
 * first, so the parts always sum exactly back to the original.
 *
 * This is not a nicety. It is how a payment is applied across invoices, how a
 * discount is spread over lines, how a commission is split across a crew, and
 * how tax is apportioned. Every one of those has to reconcile to the cent or
 * the migration and the month-end close both fail.
 */
export function allocate(m: Money, ratios: string[], precision = SCALE): Money[] {
  if (ratios.length === 0) return [];
  if (precision < 0 || precision > SCALE) throw new RangeError(`precision must be 0 to ${SCALE}`);

  const parsed = ratios.map(parseRate);
  const commonDivisor = parsed.reduce((acc, r) => (r.divisor > acc ? r.divisor : acc), 1n);
  const weights = parsed.map((r) => (r.value * commonDivisor) / r.divisor);
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n) throw new RangeError("Cannot allocate across ratios summing to zero");

  /**
   * Allocate in units of the requested precision, not in raw scale-4 units.
   *
   * This matters and is easy to get wrong. Splitting $10.00 three ways at full
   * scale gives 3.3334 / 3.3333 / 3.3333, which sums correctly. But the moment
   * those are rounded to cents for presentation or for a payment record, they
   * become 3.33 / 3.33 / 3.33 and a cent has evaporated.
   *
   * So a caller allocating money that will be STORED or PAID at cent precision
   * passes precision = 2, and gets 3.34 / 3.33 / 3.33: parts that are already
   * whole cents and still sum exactly to the original.
   */
  const step = 10n ** BigInt(SCALE - precision);
  const units = m.amount / step;
  const stranded = m.amount % step;

  const shares = weights.map((w) => (units * w) / total);
  let remainder = units - shares.reduce((a, b) => a + b, 0n);

  // Leftover units go to the largest weights first, deterministically, so the
  // same inputs always produce the same split.
  const order = weights.map((w, i) => ({ w, i })).sort((a, b) => (b.w > a.w ? 1 : b.w < a.w ? -1 : a.i - b.i));
  const direction = remainder < 0n ? -1n : 1n;
  let k = 0;
  while (remainder !== 0n) {
    const target = order[k % order.length];
    if (target) shares[target.i] = (shares[target.i] ?? 0n) + direction;
    remainder -= direction;
    k++;
  }

  const out = shares.map((s) => ({ amount: s * step, currency: m.currency }));
  // Anything below the requested precision cannot be split at that precision,
  // so it rides on the first part rather than silently disappearing.
  if (stranded !== 0n && out[0]) out[0] = { amount: out[0].amount + stranded, currency: m.currency };
  return out;
}

/** Split evenly into n parts, remainder distributed to the earliest parts. */
export const split = (m: Money, parts: number, precision = SCALE): Money[] =>
  allocate(m, Array.from({ length: parts }, () => "1"), precision);

/**
 * For an editable box: the fewest decimal places that lose nothing, never
 * fewer than two.
 *
 * `toString` always writes four, because that is what the column holds and
 * what allocation needs. Putting that straight into an input asks somebody to
 * retype "2500.0000", which is the storage format leaking onto a form, and
 * `format` is no good either because a box that posts back "$2,500.00" has to
 * be parsed by something that knows about dollar signs and commas.
 *
 * Truncating to two unconditionally would be worse than either. An allocated
 * instalment really is 16.5833, and showing it as 16.58 in a box somebody
 * then saves is a schedule that silently stops summing to the total.
 */
export function edit(m: Money): string {
  const [whole, frac = ""] = toString(m).replace(/0+$/, "").split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

/** Display only. Never feed this back into a calculation. */
export function format(m: Money, locale = "en-US"): string {
  const value = Number(toString(round(m, 2)));
  return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(value);
}
