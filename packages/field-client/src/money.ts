/**
 * MONEY AS THE PHONE TYPES AND SHOWS IT
 *
 * Amounts travel as decimal strings, "120.5000", because a float cannot hold
 * a cent exactly and a payment is the one place where that matters to
 * somebody's books. The phone bundle does not carry the domain package's
 * money module, so the two things a screen needs, reading what a thumb typed
 * and showing a balance, are here, done on the digits and never through a
 * JavaScript number.
 */

/**
 * What somebody typed, as a decimal string with two places, or null.
 *
 * Forgiving about a dollar sign, commas and spaces, which is what a person
 * copying a number off an invoice types. Strict about everything else: three
 * places of cents, two points, or a minus sign are refused, because a
 * payment recorded as something other than what was handed over is worse
 * than one that has to be typed again.
 */
export function parseAmount(typed: string): string | null {
  const cleaned = typed.trim().replace(/^\$/, "").replace(/[,\s]/g, "");
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  const cents = (match[2] ?? "").padEnd(2, "0");
  if (/^0+$/.test(whole) && /^0+$/.test(cents)) return null;
  return `${whole}.${cents}`;
}

/**
 * "$1,234.50" from "1234.5000". Rounded half up to the cent on the digits,
 * because a balance with four places shows two and the customer is told the
 * one a bookkeeper would write.
 */
export function formatAmount(decimal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!match) return decimal;
  const negative = match[1] === "-";
  let whole = BigInt(match[2]!);
  const frac = (match[3] ?? "").padEnd(3, "0");
  let cents = BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n;
  if (cents === 100n) {
    whole += 1n;
    cents = 0n;
  }
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${cents.toString().padStart(2, "0")}`;
}

/** Whether a balance is more than nothing, on the digits. */
export function isOwing(decimal: string | null): boolean {
  if (decimal === null) return false;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!match || match[1] === "-") return false;
  return /[1-9]/.test(`${match[2]}${match[3] ?? ""}`);
}
