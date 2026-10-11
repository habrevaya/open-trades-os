import {
  type Money, money, zero, add, subtract, sum, isZero, compare, toString,
} from "../money/index.js";

/**
 * SALES TAX: WHICH OF THE COMPANY'S RATES A SALE IS CHARGED, AND THE CENTS
 *
 * The product does not decide what the law says a rate is (BUILD.md, "Tax
 * rate determination"). The company writes down the rates it charges, says
 * which is its usual one, and puts a different one on a customer or an
 * address where it differs. Everything here is the arithmetic and the
 * decisions that follow from that table, kept in one place so the office's
 * invoice, "Bill this job", an estimate, the phone and `/my-day` all reach
 * the same rate for the same sale.
 *
 * WHAT DECIDES A SALE'S RATE, in this order (`resolve`):
 *
 *   1. The company says it charges no sales tax. Nothing is taxed.
 *   2. The customer is exempt, on a certificate that has not lapsed. Nothing
 *      is taxed. A lapsed certificate is not an exemption: a sale billed
 *      exempt on one is tax the company owes and did not collect, which is
 *      the expensive way to be wrong, so it is taxed and the office is told.
 *   3. The address the work is at names a rate. Sales tax follows where the
 *      work is done, so the address wins over the customer.
 *   4. The customer names a rate.
 *   5. The company's default rate.
 *   6. None of those: no rate applies, and nothing is taxed.
 *
 * A named rate with no percentage in force on the day (one that starts next
 * month) or one that has been retired is passed over, and the next step
 * decides, rather than charging a rate that is not in force.
 *
 * WHICH LINES. A rate is charged on the lines that are taxable, and nothing
 * else: the price book item says whether it is, a part recorded on a job
 * carries what its item said, and a line typed by hand says so itself,
 * defaulting to taxed for a part and not for labour (`defaultTaxable`),
 * because that is how most states that tax parts treat labour.
 */

/** Where a line's rate came from. Stored on the line as `tax_source`. */
export type TaxSource =
  | "address" | "customer" | "default" | "exempt" | "none" | "off"
  | "chosen" | "estimate" | "given";

/**
 * The outcomes the company's table decides, as opposed to a person or a
 * document. Issuing a draft checks lines from these against the table on the
 * day it is issued; a rate somebody chose, or one carried from a signed
 * estimate, is theirs and stands.
 */
export const TABLE_SOURCES: readonly TaxSource[] = ["address", "customer", "default", "exempt", "none", "off"];

export const isTableSource = (source: string | null | undefined): boolean =>
  source !== null && source !== undefined && (TABLE_SOURCES as readonly string[]).includes(source);

/** In words, for the line on an invoice and the office's screens. */
export const SOURCE_LABEL: Record<TaxSource, string> = {
  address: "The rate for this address",
  customer: "This customer's rate",
  default: "The company's usual rate",
  exempt: "Tax exempt",
  none: "No rate applies",
  off: "The company charges no sales tax",
  chosen: "Chosen for this document",
  estimate: "As the estimate charged",
  given: "As recorded",
};

/* --------------------------------------------------------------- the table */

/** A percentage from a day. `rate` is a fraction: "0.0825". `effectiveFrom` is a calendar date. */
export interface RateVersion {
  rate: string;
  effectiveFrom: string;
  /**
   * The jurisdictions the percentage is made of, when the company wrote it
   * down in parts: Texas 6.25%, Travis County 1%, Austin 1%. Their sum is
   * `rate` (`checkParts` refuses anything else). Empty or absent, the rate
   * is one figure, as every rate was before parts.
   */
  parts?: readonly RatePart[] | undefined;
}

export interface CompanyRate {
  id: string;
  name: string;
  retired: boolean;
  versions: readonly RateVersion[];
}

export interface TaxTable {
  /** False when the company has said it charges no sales tax at all. */
  chargesTax: boolean;
  defaultRateId: string | null;
  rates: readonly CompanyRate[];
}

/** A company that has said nothing: no rates, nothing charged. */
export const EMPTY_TABLE: TaxTable = { chargesTax: true, defaultRateId: null, rates: [] };

/** The percentage in force on a day: the latest that started on or before it, or null. */
export function versionOn(versions: readonly RateVersion[], on: string): RateVersion | null {
  let best: RateVersion | null = null;
  for (const version of versions) {
    if (version.effectiveFrom > on) continue;
    if (!best || version.effectiveFrom > best.effectiveFrom) best = version;
  }
  return best;
}

/** A named rate's fraction on a day, or null when it is retired or nothing is in force yet. */
export function rateOn(rate: CompanyRate | undefined, on: string): string | null {
  if (!rate || rate.retired) return null;
  return versionOn(rate.versions, on)?.rate ?? null;
}

/* ----------------------------------------------------------- percentages */

/** The fraction a column holds, without the zeros it pads with: "0.082500" reads "0.0825". */
export function canonical(rate: string): string {
  const text = rate.trim();
  if (!text.includes(".")) return text === "" ? "0" : text;
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

/** Whether two fractions are the same rate, however many zeros either carries. */
export const sameRate = (a: string, b: string): boolean => {
  const scale = (x: string) => {
    const [whole = "0", frac = ""] = canonical(x).split(".");
    return BigInt(whole + frac.padEnd(8, "0").slice(0, 8));
  };
  return scale(a) === scale(b);
};

export type PercentCheck = { ok: true; rate: string } | { ok: false; reason: string };

/**
 * A percentage somebody typed, "8.25" or "8.25%", as the fraction a line
 * carries, "0.0825". At most four decimal places of a percentage, which is
 * six of a fraction and exactly what the `rate` column holds, so nothing is
 * rounded on the way in. Under a hundred, because a sales tax of a hundred
 * per cent is a typo for one.
 */
export function percentToRate(typed: string): PercentCheck {
  const text = typed.trim().replace(/%$/, "").trim();
  if (!/^\d{1,2}(\.\d{1,4})?$/.test(text)) {
    return { ok: false, reason: "Write the rate as a percentage under 100, like 8.25, with at most four decimal places." };
  }
  const [whole = "0", frac = ""] = text.split(".");
  const digits = (BigInt(whole) * 10_000n + BigInt(frac.padEnd(4, "0"))).toString().padStart(7, "0");
  return { ok: true, rate: canonical(`${digits.slice(0, -6) || "0"}.${digits.slice(-6)}`) };
}

/** A fraction as the percentage a person reads: "0.0825" is "8.25". */
export function rateToPercent(rate: string): string {
  const [whole = "0", frac = ""] = canonical(rate).split(".");
  const digits = BigInt(whole + frac.padEnd(6, "0").slice(0, 6));
  const text = digits.toString().padStart(5, "0");
  return canonical(`${text.slice(0, -4) || "0"}.${text.slice(-4)}`);
}

/** "Travis County 8.25%": what a rate is called on a list and a line. */
export const describe = (name: string, rate: string): string => `${name} ${rateToPercent(rate)}%`;

/* ---------------------------------------------------------- the decision */

export interface Exemption {
  exempt: boolean;
  certificate: string | null;
  /** The last day the certificate covers. Null for one that does not lapse. */
  expiresOn: string | null;
}

/** Whether an exemption holds on a day, and whether it would have but for lapsing. */
export function exemptOn(exemption: Exemption, on: string): { exempt: boolean; lapsed: boolean } {
  if (!exemption.exempt) return { exempt: false, lapsed: false };
  if (exemption.expiresOn !== null && exemption.expiresOn < on) return { exempt: false, lapsed: true };
  return { exempt: true, lapsed: false };
}

export interface TaxParty {
  exemption: Exemption;
  /** The rate named on the customer, if any. */
  customerRateId: string | null;
  /** The rate named on the address the work is at, if any and if there is one. */
  addressRateId: string | null;
}

export interface Resolved {
  /** The fraction charged on taxable lines. "0" when nothing is. */
  rate: string;
  taxRateId: string | null;
  /** The rate's name, when it is one of the company's. */
  name: string | null;
  source: TaxSource;
  /** Said to the office beside the figure: why this rate, or why none. */
  note: string;
}

/** The rate for a sale to this customer at this address on this day. See the head of this file for the order. */
export function resolve(table: TaxTable, party: TaxParty, on: string): Resolved {
  if (!table.chargesTax) {
    return { rate: "0", taxRateId: null, name: null, source: "off", note: SOURCE_LABEL.off };
  }
  const exemption = exemptOn(party.exemption, on);
  if (exemption.exempt) {
    const note = party.exemption.certificate
      ? `Tax exempt, certificate ${party.exemption.certificate}`
      : "Tax exempt, with no certificate number on the customer";
    return { rate: "0", taxRateId: null, name: null, source: "exempt", note };
  }
  const lapsed = exemption.lapsed
    ? ` The customer's exemption certificate ran out on ${party.exemption.expiresOn}, so they are taxed.`
    : "";
  const byId = new Map(table.rates.map((r) => [r.id, r]));
  const steps: Array<[string | null, TaxSource]> = [
    [party.addressRateId, "address"],
    [party.customerRateId, "customer"],
    [table.defaultRateId, "default"],
  ];
  for (const [id, source] of steps) {
    if (!id) continue;
    const named = byId.get(id);
    const rate = rateOn(named, on);
    if (rate === null || !named) continue;
    return {
      rate: canonical(rate), taxRateId: named.id, name: named.name, source,
      note: `${SOURCE_LABEL[source]}: ${describe(named.name, rate)}.${lapsed}`,
    };
  }
  return { rate: "0", taxRateId: null, name: null, source: "none", note: `${SOURCE_LABEL.none}.${lapsed}` };
}

/** What a line carries once its taxability is known: the rate, its name and where it came from. */
export interface LineRate {
  taxRate: string;
  taxRateId: string | null;
  taxSource: TaxSource | null;
}

/** A resolved rate on one line. A line that is not taxable carries nothing, whatever applies to the sale. */
export function onLine(resolved: Pick<Resolved, "rate" | "taxRateId" | "source">, taxable: boolean): LineRate {
  if (!taxable) return { taxRate: "0", taxRateId: null, taxSource: null };
  return { taxRate: canonical(resolved.rate), taxRateId: resolved.taxRateId, taxSource: resolved.source };
}

/**
 * A rate somebody chose, by name, on a day. Null when the rate is retired or
 * has no percentage in force on that day, which the caller refuses in words.
 */
export function chosen(table: TaxTable, taxRateId: string, on: string): Resolved | null {
  const named = table.rates.find((r) => r.id === taxRateId);
  const rate = rateOn(named, on);
  if (rate === null || !named) return null;
  return {
    rate: canonical(rate), taxRateId: named.id, name: named.name, source: "chosen",
    note: `${SOURCE_LABEL.chosen}: ${describe(named.name, rate)}.`,
  };
}

/**
 * A percentage typed by hand (an estimate's tax box, the phone's) named for
 * the company's rate it is, when it is one. The figure is what was typed
 * either way; the name is what lets a filing report put it on the right
 * row rather than under "typed by hand". The rate the sale would have been
 * charged anyway is preferred, then any rate in force with that percentage.
 */
export function nameTyped(table: TaxTable, rate: string, on: string, preferred: string | null = null): string | null {
  if (Number(rate) === 0) return null;
  const live = table.rates.filter((r) => rateOn(r, on) !== null);
  const pick = live.find((r) => r.id === preferred && sameRate(rateOn(r, on)!, rate))
    ?? live.find((r) => sameRate(rateOn(r, on)!, rate));
  return pick?.id ?? null;
}

/**
 * Whether a line typed by hand is taxed when nobody said: a part is, labour
 * is not. `kind` is a price book item kind or a job line kind; anything that
 * is not labour is treated as a part, which is the side that collects the
 * tax rather than the side that owes it.
 */
export function defaultTaxable(kind: string | null | undefined): boolean {
  return kind !== "labor" && kind !== "labour";
}

/* ------------------------------------------------------------- the cents */

/**
 * The document's tax, rounded once, shared back onto its lines.
 *
 * Tax is worked out on each line at full precision and rounded once at the
 * document (`ledger.computeInvoice`), which is what the customer's own
 * arithmetic gives. Rounding each line on its own as well, and showing
 * those, leaves a third of multi line invoices whose lines do not add up to
 * their tax by a cent, and a filing report summed from the lines that does
 * not agree with the ledger.
 *
 * So the rounded total is shared between the lines by largest remainder,
 * the way `splits.taxAcross` shares a job's tax between payers: each line
 * gets its exact tax rounded down to the cent, and the cents left over go
 * one each to the lines with the largest fraction left, the earliest line on
 * a tie. Every line is then strictly within a cent of its exact tax, and the
 * lines add up to the total exactly.
 */
export function shareTax(exact: readonly Money[], total: Money): Money[] {
  const currency = total.currency;
  const cent = money("0.01", currency).amount;
  const floors = exact.map((x) => floorTo(x.amount, cent));
  let left = total.amount - floors.reduce((a, b) => a + b, 0n);
  const order = exact
    .map((x, i) => ({ i, rest: x.amount - floors[i]! }))
    .sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.i - b.i));
  const out = [...floors];
  const owing = order.filter((x) => x.rest > 0n);
  for (let k = 0; left > 0n && owing.length > 0; k += 1) {
    out[owing[k % owing.length]!.i]! += cent;
    left -= cent;
  }
  for (let k = order.length - 1; left < 0n && k >= 0; k -= 1) {
    const i = order[k]!.i;
    out[i]! -= cent;
    left += cent;
  }
  return out.map((amount) => ({ amount, currency }));
}

function floorTo(amount: bigint, step: bigint): bigint {
  const rest = ((amount % step) + step) % step;
  return amount - rest;
}

/* ------------------------------------------------------------- by rate */

export interface TaxedLine {
  taxable: boolean;
  taxRate: string;
  taxRateId: string | null;
  /** What the rate was charged on: the line's total after discounts. */
  base: Money;
  tax: Money;
}

export interface RateTotal {
  /** The company's rate, or null for a rate typed by hand or recorded from history. */
  taxRateId: string | null;
  /** The fraction, canonical. */
  rate: string;
  /** Sales the rate was charged on. */
  base: Money;
  tax: Money;
  /**
   * The row's tax by jurisdiction, when the rate is written down in parts
   * (`withParts`). Adds up to `tax` exactly; the ledger refuses it otherwise.
   */
  parts?: readonly PartTotal[] | undefined;
}

/** One jurisdiction's share of a row's tax. */
export interface PartTotal {
  name: string;
  /** The part's own fraction: "0.0625" for the state's 6.25%. */
  rate: string;
  tax: Money;
}

/**
 * One document's tax by rate: what a filing return asks for, and what the
 * ledger posts to sales tax payable, one entry per rate.
 *
 * Grouped by the company's rate and the percentage together, so a county
 * whose rate rose mid month is two rows rather than one row at a rate it
 * never charged. Lines that charged nothing are left out.
 *
 * The rows add up to `taxTotal` exactly. They already do for anything raised
 * here, because the lines share the document's rounded tax (`shareTax`);
 * history recorded with another system's per line tax may be a cent out, and
 * that cent goes to the largest row, so the ledger still balances against
 * the document.
 */
export function byRate(lines: readonly TaxedLine[], taxTotal: Money): RateTotal[] {
  const currency = taxTotal.currency;
  const groups = new Map<string, RateTotal>();
  for (const line of lines) {
    if (!line.taxable || Number(line.taxRate) === 0) continue;
    const rate = canonical(line.taxRate);
    const key = `${line.taxRateId ?? ""}|${rate}`;
    const at = groups.get(key) ?? { taxRateId: line.taxRateId, rate, base: zero(currency), tax: zero(currency) };
    at.base = add(at.base, line.base);
    at.tax = add(at.tax, line.tax);
    groups.set(key, at);
  }
  const rows = [...groups.values()];
  const gap = subtract(taxTotal, sum(rows.map((r) => r.tax), currency));
  if (!isZero(gap)) {
    if (rows.length === 0) {
      rows.push({ taxRateId: null, rate: "0", base: zero(currency), tax: gap });
    } else {
      let largest = 0;
      for (const [i, r] of rows.entries()) if (compare(r.tax, rows[largest]!.tax) > 0) largest = i;
      rows[largest]!.tax = add(rows[largest]!.tax, gap);
    }
  }
  return rows;
}

/** A row as it rides on a ledger entry's metadata, so the filing report reads it back. */
export function asMetadata(row: RateTotal): Record<string, string | null> {
  return { taxRateId: row.taxRateId, taxRate: row.rate, taxableBase: toString(row.base) };
}

/**
 * A part's entry's metadata: the row's, plus which jurisdiction it is, its
 * own percentage and the sales it was charged on.
 *
 * Only one part carries `taxableBase` (`carriesBase`, the first that posts
 * anything). Every part was charged on the same sales, and the report by
 * rate sums `taxableBase` across a rate's entries, so carrying it on each
 * part would count the sales once per jurisdiction. `partBase` is the same
 * figure for the report by jurisdiction, where each part's sales are its own.
 */
export function asPartMetadata(row: RateTotal, part: PartTotal, carriesBase: boolean): Record<string, string | null> {
  const base = toString(row.base);
  return {
    taxRateId: row.taxRateId,
    taxRate: row.rate,
    ...(carriesBase ? { taxableBase: base } : {}),
    part: part.name,
    partRate: canonical(part.rate),
    partBase: base,
  };
}

/* ------------------------------------------------------ a rate in parts */

/**
 * A RATE WRITTEN DOWN IN PARTS.
 *
 * In most states the rate a sale is charged is several rates added up: the
 * state's, the county's, the city's, a transit district's. A return asks
 * for each separately. The company may write a rate down as its parts, and
 * the rate charged is their sum, exactly as a rate written as one figure is
 * charged; nothing here looks a part up (BUILD.md, "Tax rate determination").
 *
 * The parts never change what the customer pays. They decide only how the
 * tax already worked out is shared between jurisdictions on the ledger:
 * `splitTax` takes the row's rounded tax and shares it in proportion to each
 * part's percentage, by largest remainder, so the parts add up to the cent.
 * Working each part out from the sales instead and rounding each on its own
 * would leave the parts a cent away from the tax the customer was charged,
 * which is a cent the ledger cannot post.
 */
export interface RatePart {
  name: string;
  /** A fraction, as every rate here is: "0.0625" for 6.25%. */
  rate: string;
}

export type PartsCheck =
  | { ok: true; rate: string; parts: RatePart[] }
  | { ok: false; reason: string };

/** A fraction in millionths, which is exactly what the rate column holds. */
const micros = (fraction: string): bigint => {
  const [whole = "0", frac = ""] = canonical(fraction).split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6));
};

const fromMicros = (value: bigint): string => {
  const text = value.toString().padStart(7, "0");
  return canonical(`${text.slice(0, -6) || "0"}.${text.slice(-6)}`);
};

/**
 * The parts somebody typed, checked, and the rate they add up to.
 *
 * Each part needs a name and a percentage above nothing, and two parts with
 * one name is a filing report with two rows for one jurisdiction, so it is
 * refused. When a percentage for the whole rate is typed as well it must be
 * the sum: a rate of 8.25% whose parts add up to 8.5% is a typo somewhere,
 * and guessing which figure was meant would charge one and file the other.
 */
export function checkParts(
  typed: readonly { name: string; percent: string }[], total?: string | undefined,
): PartsCheck {
  if (typed.length === 0) return { ok: false, reason: "Give at least one part, with a name and a percent." };
  const parts: RatePart[] = [];
  const seen = new Set<string>();
  for (const [i, one] of typed.entries()) {
    const name = one.name.trim();
    if (name === "") return { ok: false, reason: `Part ${i + 1} needs a name, like Texas or Travis County.` };
    if (name.length > 100) return { ok: false, reason: `Part ${i + 1}'s name is too long.` };
    const key = name.toLowerCase();
    if (seen.has(key)) return { ok: false, reason: `There are two parts called ${name}. Each part is one place.` };
    seen.add(key);
    const checked = percentToRate(one.percent);
    if (!checked.ok) return { ok: false, reason: `${name}: ${checked.reason}` };
    if (micros(checked.rate) === 0n) return { ok: false, reason: `${name} is 0%. Leave out a part that charges nothing.` };
    parts.push({ name, rate: checked.rate });
  }
  const sumMicros = parts.reduce((acc, p) => acc + micros(p.rate), 0n);
  if (sumMicros >= 1_000_000n) return { ok: false, reason: "The parts add up to 100% or more. Check each percent." };
  const rate = fromMicros(sumMicros);
  if (total !== undefined && total.trim() !== "") {
    const whole = percentToRate(total);
    if (!whole.ok) return whole;
    if (!sameRate(whole.rate, rate)) {
      return {
        ok: false,
        reason: `The parts add up to ${rateToPercent(rate)}%, not the ${rateToPercent(whole.rate)}% given for the whole rate. `
          + "Leave the whole rate empty to charge the sum, or fix the part that is wrong.",
      };
    }
  }
  return { ok: true, rate, parts };
}

/**
 * Which parts a row's tax is shared by: those of the rate's version that
 * charged this very percentage, the one in force on the day first, else the
 * latest that charged it. A percentage none of the versions charged (typed
 * by hand on an estimate, say) is not split, because the parts of some
 * other percentage do not describe it.
 */
export function partsFor(versions: readonly RateVersion[], charged: string, on: string): RatePart[] {
  const matching = versions.filter((v) => sameRate(v.rate, charged) && (v.parts?.length ?? 0) > 0);
  if (matching.length === 0) return [];
  const inForce = versionOn(versions, on);
  if (inForce && sameRate(inForce.rate, charged) && (inForce.parts?.length ?? 0) > 0) return [...inForce.parts!];
  const latest = [...matching].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]!;
  return [...latest.parts!];
}

/**
 * A row's tax shared between its parts, to the cent, by largest remainder.
 *
 * Each part's exact share is the row's tax times its percentage over the
 * rate's; each gets that rounded down to the cent, and the cents left over
 * go one each to the parts with the largest fraction left, the first part
 * on a tie. The parts then add up to the row's tax exactly and each is
 * within a cent of its exact share. A negative tax (history's stray cent)
 * is shared the same way with the sign put back. Anything below a cent in
 * the tax itself, which only history recorded at four places can carry,
 * rides on the part with the largest remainder rather than disappearing.
 */
export function splitTax(tax: Money, parts: readonly RatePart[]): Money[] {
  if (parts.length === 0) return [];
  const currency = tax.currency;
  const negative = tax.amount < 0n;
  const total = negative ? -tax.amount : tax.amount;
  const weights = parts.map((p) => micros(p.rate));
  const sumWeights = weights.reduce((a, b) => a + b, 0n);
  if (sumWeights === 0n) throw new RangeError("Parts that charge nothing cannot share a tax.");
  const cent = money("0.01", currency).amount;

  const exact = weights.map((w) => total * w);
  const floors = exact.map((x) => ((x / sumWeights) / cent) * cent);
  const rests = exact.map((x, i) => x - floors[i]! * sumWeights);
  const order = rests.map((rest, i) => ({ rest, i }))
    .sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.i - b.i));

  const out = [...floors];
  let left = total - floors.reduce((a, b) => a + b, 0n);
  for (let k = 0; left >= cent; k += 1) {
    out[order[k % order.length]!.i]! += cent;
    left -= cent;
  }
  if (left > 0n) out[order[0]!.i]! += left;
  return out.map((amount) => ({ amount: negative ? -amount : amount, currency }));
}

/**
 * A row with its tax shared between the parts of its rate. Parts that do
 * not add up to the row's percentage are not this row's (`partsFor` already
 * keeps those out); the row is returned as it was, posted as one figure.
 */
export function withParts(row: RateTotal, parts: readonly RatePart[]): RateTotal {
  if (parts.length === 0) return row;
  const sumMicros = parts.reduce((acc, p) => acc + micros(p.rate), 0n);
  if (sumMicros !== micros(row.rate)) return row;
  const shares = splitTax(row.tax, parts);
  return {
    ...row,
    parts: parts.map((p, i) => ({ name: p.name, rate: canonical(p.rate), tax: shares[i]! })),
  };
}

/* ---------------------------------------------------- the provider seam */

/**
 * WHAT A TAX PROVIDER IS ASKED, AND WHAT IT ANSWERS.
 *
 * The seam a commercial rate service would sit behind, in the style of the
 * other provider seams (M25): a question about one sale, and a rate with
 * where it came from. The only implementation is the company's own table
 * (`tableProvider`), and that is deliberate: looking a jurisdiction's rate
 * up from an address is a product somebody else sells, and BUILD.md keeps
 * it out of this one. A provider that asks over the network must be asked
 * before the database transaction that writes the document, never inside
 * it, as every other network seam here is.
 */
export interface TaxQuestion {
  /** The day the sale is taxed on, in the company's calendar: the invoice's date. */
  on: string;
  party: TaxParty;
  /** Where the work is, for a provider that reads an address. The table does not. */
  address: {
    line1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  } | null;
}

export interface TaxProvider {
  readonly name: string;
  rateFor(question: TaxQuestion): Promise<Resolved>;
}

/** The company's own table, as a provider. Pure: everything it needs was loaded first. */
export function tableProvider(table: TaxTable): TaxProvider {
  return {
    name: "table",
    rateFor: async (question) => resolve(table, question.party, question.on),
  };
}
