import {
  type Money, money, add, subtract, multiply, divide, compare, isPositive, isNegative, zero,
  toString as moneyToString, round, edit,
} from "../money/index.js";

/** An amount as a person reads it on an invoice: 300.00, not 300.0000. */
const cents = (value: Money): string => edit(round(value, 2));
import { dateIn, minutesInDay } from "../time/index.js";

/**
 * WHOSE PRICE GOVERNS A LINE, AND HOW IT GOT THERE
 *
 * Our price book is not the price authority in five segments. A facilities
 * client's contract, a home warranty network's schedule, a manufacturer's
 * labour allowance and an insurance price list each say what a job may be
 * charged, and none of them is a list of our items at our prices. A
 * commercial schedule is mostly RULES: an hourly rate per trade and time of
 * day, a markup on materials, a charge for turning up, and a short list of
 * flat prices for the repairs they see most.
 *
 * This file decides which of those prices a given line of work, and says so
 * in a form the invoice can carry: the authority, the basis, and the working
 * in a sentence. Everything here is pure: no database, no clock. The service
 * loads the cards and the work and hands them in.
 *
 * THE ORDER IS THE CARD'S OWN ORDER OF SPECIFICITY. A flat price for this
 * exact repair beats an hourly rate, which beats a markup, because that is
 * how a schedule is read by the client's own accounts payable: the most
 * specific thing that applies is the price.
 *
 * NOT ON THE CARD IS NOT THE SAME AS NO CARD. When a card applies and none of
 * its rules prices a line, the line falls back to our price book and is
 * marked out of scope, so somebody agrees the price with the client before
 * the invoice goes rather than finding out when it is rejected. With no card
 * at all the price book is simply the authority and nothing is flagged.
 *
 * COST IS NEVER TAKEN FROM A CARD. The price is theirs and the cost is ours,
 * which is what keeps margin true on work we did not price.
 */

/** Who issued a card. Mirrors `contracts.AUTHORITIES` in the API. */
export type CardAuthority = "contract" | "warranty_network" | "manufacturer_allowance" | "insurance" | "brand";

/** Who priced a line: a card's authority, our price book, or a person typing a price. */
export type PriceAuthority = CardAuthority | "price_book" | "entered";

/** How the authority priced it. */
export type PriceBasis =
  | "card_line" | "labour_rate" | "material_markup" | "trip_charge"
  | "price_book" | "entered" | "history" | "share";

export const AUTHORITY_LABEL: Record<PriceAuthority, string> = {
  contract: "Client contract",
  warranty_network: "Warranty network schedule",
  manufacturer_allowance: "Manufacturer allowance",
  insurance: "Insurance price list",
  brand: "Brand schedule",
  price_book: "Our price book",
  entered: "Entered by hand",
};

export const BASIS_LABEL: Record<PriceBasis, string> = {
  card_line: "listed price",
  labour_rate: "hourly rate",
  material_markup: "markup on cost",
  trip_charge: "trip charge",
  price_book: "price book",
  entered: "typed in",
  history: "as recorded",
  share: "share of a split line",
};

/** A label for any stored authority, including one written by a later version. */
export const authorityLabel = (key: string | null | undefined): string =>
  key ? AUTHORITY_LABEL[key as PriceAuthority] ?? key.replace(/_/g, " ") : "Not recorded";

/* ------------------------------------------------------------ time bands */

export type LabourBand = "standard" | "after_hours" | "weekend" | "holiday";

export const BANDS: LabourBand[] = ["standard", "after_hours", "weekend", "holiday"];

export const BAND_LABEL: Record<LabourBand, string> = {
  standard: "Standard hours",
  after_hours: "After hours",
  weekend: "Weekend",
  holiday: "Holiday",
};

/** The client's definition of standard hours, in the company's zone. */
export interface BandRules {
  /** 0 for Sunday to 6 for Saturday. */
  standardDays: number[];
  standardStartMinute: number;
  standardEndMinute: number;
  /** `YYYY-MM-DD`. */
  holidays: string[];
  timeZone: string;
}

/**
 * Which band an instant falls in, by the card's own definition.
 *
 * Holiday first, then a day outside the standard days, then a time outside
 * the standard hours. A holiday that falls on a Saturday is a holiday: the
 * client pays the holiday rate, which is the higher one on every schedule
 * this was written against.
 */
export function bandAt(rules: BandRules, instant: Date): LabourBand {
  const date = dateIn(instant, rules.timeZone);
  if (rules.holidays.includes(date)) return "holiday";
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (!rules.standardDays.includes(weekday)) return "weekend";
  const minute = minutesInDay(instant, rules.timeZone);
  if (minute < rules.standardStartMinute || minute >= rules.standardEndMinute) return "after_hours";
  return "standard";
}

/** Whether a band definition can be used, and why not. */
export function bandRulesProblem(rules: Omit<BandRules, "timeZone">): string | null {
  for (const day of rules.standardDays) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return `${day} is not a day of the week. Use 0 for Sunday to 6 for Saturday.`;
    }
  }
  for (const [name, value] of [["start", rules.standardStartMinute], ["end", rules.standardEndMinute]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 1440) {
      return `The standard hours ${name} at minute ${value}, which is not a time of day.`;
    }
  }
  if (rules.standardEndMinute <= rules.standardStartMinute) {
    return "Standard hours have to end after they start. A card whose day ends before it begins charges everything at the after hours rate.";
  }
  for (const date of rules.holidays) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      return `"${date}" is not a date. Holidays are written YYYY-MM-DD.`;
    }
  }
  return null;
}

/* ---------------------------------------------------------- labour rates */

export interface LabourRate {
  /** The trade, as the job type the work is booked under. Null for every kind of work. */
  jobTypeId: string | null;
  band: LabourBand;
  hourlyRate: Money;
  minimumMinutes: number | null;
  incrementMinutes: number | null;
}

/**
 * The bands a band falls back to, most specific first.
 *
 * A card that names no weekend rate pays its after hours rate at the weekend,
 * and one that names no premium at all pays its standard rate whenever the
 * work happens. Falling back DOWN is what the card says; falling back up
 * would charge a client a premium they never agreed to.
 */
const FALLBACK: Record<LabourBand, LabourBand[]> = {
  holiday: ["holiday", "weekend", "after_hours", "standard"],
  weekend: ["weekend", "after_hours", "standard"],
  after_hours: ["after_hours", "standard"],
  standard: ["standard"],
};

/**
 * The rate that applies to labour in this trade at this time.
 *
 * The band is matched before the trade. An after hours rate for every trade
 * beats a standard rate for plumbing on a plumbing call at nine at night,
 * because the premium is the thing the client agreed to pay for the hour,
 * and the trade only decides which premium when the card names one per
 * trade.
 */
export function labourRateFor(
  rates: readonly LabourRate[], jobTypeId: string | null, band: LabourBand,
): { rate: LabourRate; chargedBand: LabourBand } | null {
  for (const candidate of FALLBACK[band]) {
    const specific = jobTypeId
      ? rates.find((r) => r.band === candidate && r.jobTypeId === jobTypeId)
      : undefined;
    const general = rates.find((r) => r.band === candidate && r.jobTypeId === null);
    const found = specific ?? general;
    if (found) return { rate: found, chargedBand: candidate };
  }
  return null;
}

/** Two rates for the same trade and band are two answers to one question. */
export function labourRatesProblem(rates: readonly LabourRate[]): string | null {
  const seen = new Set<string>();
  for (const rate of rates) {
    const key = `${rate.jobTypeId ?? "any"}:${rate.band}`;
    if (seen.has(key)) {
      return `Two ${BAND_LABEL[rate.band].toLowerCase()} rates for the same trade. Keep one.`;
    }
    seen.add(key);
    if (isNegative(rate.hourlyRate)) return "A negative hourly rate is not a rate.";
    for (const [name, value] of [["minimum", rate.minimumMinutes], ["increment", rate.incrementMinutes]] as const) {
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1440)) {
        return `A ${name} of ${value} minutes is not something a card can say.`;
      }
    }
  }
  return null;
}

/**
 * The minutes a card pays for, from the minutes worked.
 *
 * The minimum first, then rounded UP to the increment, because that is the
 * order a schedule states them in: "one hour minimum, then in quarter hours".
 * Rounding first and then applying the minimum gives the same answer in
 * every case but one, and the one is a client who reads it the other way.
 */
export function billableMinutes(worked: number, minimum: number | null, increment: number | null): number {
  let minutes = Math.max(0, Math.ceil(worked));
  if (minimum !== null && minutes < minimum) minutes = minimum;
  if (increment !== null && increment > 0) minutes = Math.ceil(minutes / increment) * increment;
  return minutes;
}

/**
 * Hours, as a quantity string, from a whole number of minutes, when that can
 * be written exactly in four decimal places. Null when it cannot: fifty
 * minutes is 0.8333... hours, and a line of 0.8333 at 90.00 an hour does not
 * add up to what the card pays.
 */
export function exactHours(minutes: number): string | null {
  if (minutes % 3 !== 0) return null;
  return moneyToString(divide(money(String(minutes)), "60"));
}

/* -------------------------------------------------------------- markup */

export interface MarkupTier {
  /** The highest unit cost this tier covers. Null for everything above the last tier. */
  upToCost: Money | null;
  /** A fraction: 0.25 is twenty five per cent on cost. */
  percent: string;
}

/** Tiers in the order they apply: the lowest ceiling first, the open one last. */
export function sortTiers(tiers: readonly MarkupTier[]): MarkupTier[] {
  return [...tiers].sort((a, b) => {
    if (a.upToCost === null) return 1;
    if (b.upToCost === null) return -1;
    return compare(a.upToCost, b.upToCost);
  });
}

export function markupTiersProblem(tiers: readonly MarkupTier[]): string | null {
  if (tiers.filter((t) => t.upToCost === null).length > 1) {
    return "Only one band can cover everything above the others.";
  }
  const ceilings = tiers.filter((t) => t.upToCost !== null).map((t) => moneyToString(t.upToCost!));
  if (new Set(ceilings).size !== ceilings.length) return "Two bands end at the same cost. Keep one.";
  for (const tier of tiers) {
    if (!/^\d+(\.\d+)?$/.test(tier.percent)) return `"${tier.percent}" is not a markup. Use a fraction: 0.25 is twenty five per cent.`;
    if (Number(tier.percent) > 10) {
      /**
       * Refused rather than divided by a hundred, for the reason every rate
       * in this product is a fraction: guessing that "25" meant a quarter is
       * how a markup ends up a hundred times what the client agreed.
       */
      return `A markup of ${tier.percent} is ${Number(tier.percent) * 100} per cent. Write a fraction: 0.25 is twenty five per cent.`;
    }
    if (tier.upToCost !== null && !isPositive(tier.upToCost)) return "A band has to end above nothing.";
  }
  return null;
}

/** The tier that applies to a unit cost, or null when the card has none that does. */
export function tierFor(tiers: readonly MarkupTier[], unitCost: Money): MarkupTier | null {
  for (const tier of sortTiers(tiers)) {
    if (tier.upToCost === null || compare(unitCost, tier.upToCost) <= 0) return tier;
  }
  return null;
}

/* ----------------------------------------------------------- the cards */

export interface CardLine {
  id: string;
  priceBookItemId: string | null;
  externalCode: string | null;
  description: string;
  price: Money;
  allowedMinutes: number | null;
}

export interface CardTerms {
  id: string;
  name: string;
  authority: CardAuthority;
  lines: CardLine[];
  labourRates: LabourRate[];
  markup: MarkupTier[];
  tripCharge: Money | null;
  bands: BandRules;
}

/** The kinds of work a job line records, plus the trip a card charges for. */
export type WorkKind =
  | "part" | "labor" | "equipment" | "subcontractor" | "disposal" | "permit" | "other" | "trip";

export interface WorkLine {
  kind: WorkKind;
  name: string;
  /** Our item, when the work was recorded against one. */
  priceBookItemId: string | null;
  /** Their code, when somebody recorded one. */
  externalCode?: string | null;
  /** Hours for labour, units for everything else. */
  quantity: string;
  /** What we would charge: the price book in force, or the price recorded on the line. */
  ourPrice: Money;
  /** Whether `ourPrice` came from the price book rather than somebody typing it. */
  ourPriceIsBook: boolean;
  unitCost: Money | null;
  /** When the work was done, which decides the band. */
  at: Date;
  /** The trade, as the job type. */
  jobTypeId: string | null;
}

export interface PricedLine {
  quantity: string;
  unitPrice: Money;
  authority: PriceAuthority;
  basis: PriceBasis;
  rateCardId: string | null;
  rateCardLineId: string | null;
  /** The working, in a sentence a client's accounts payable would accept. */
  note: string | null;
  /** A card applies and nothing on it prices this line. */
  outOfScope: boolean;
  band: LabourBand | null;
}

const fallback = (line: WorkLine, cards: readonly CardTerms[]): PricedLine => ({
  quantity: line.quantity,
  unitPrice: line.ourPrice,
  authority: line.ourPriceIsBook ? "price_book" : "entered",
  basis: line.ourPriceIsBook ? "price_book" : "entered",
  rateCardId: null,
  rateCardLineId: null,
  note: cards.length === 0
    ? null
    : `Not on ${cards.length === 1 ? cards[0]!.name : "any card that applies"}, so priced from ${line.ourPriceIsBook ? "our price book" : "the price recorded"}. Agree it with the client before this goes out.`,
  outOfScope: cards.length > 0,
  band: null,
});

const MATERIAL_KINDS: readonly WorkKind[] = ["part", "equipment"];

/**
 * Price one line of work under the cards that apply to whoever pays for it.
 *
 * Cards are tried in the order given, and the first rule of the most
 * specific kind wins: a listed price on any card, then an hourly rate, then
 * a markup. The service passes the cards for the payer in the order the
 * contract holds them.
 */
export function priceWork(cards: readonly CardTerms[], line: WorkLine): PricedLine {
  /** A listed price for this exact item or code. */
  for (const card of cards) {
    const listed = (line.priceBookItemId
      ? card.lines.find((l) => l.priceBookItemId === line.priceBookItemId)
      : undefined)
      ?? (line.externalCode ? card.lines.find((l) => l.externalCode === line.externalCode) : undefined);
    if (listed) {
      return {
        quantity: line.quantity,
        unitPrice: listed.price,
        authority: card.authority,
        basis: "card_line",
        rateCardId: card.id,
        rateCardLineId: listed.id,
        note: listed.allowedMinutes !== null
          ? `${card.name}: ${listed.description}, allowing ${listed.allowedMinutes} minutes.`
          : `${card.name}: ${listed.description}.`,
        outOfScope: false,
        band: null,
      };
    }
  }

  if (line.kind === "labor") {
    for (const card of cards) {
      const band = bandAt(card.bands, line.at);
      const found = labourRateFor(card.labourRates, line.jobTypeId, band);
      if (!found) continue;
      const worked = Math.round(Number(moneyToString(multiply(money(line.quantity), "60"))));
      const minutes = billableMinutes(worked, found.rate.minimumMinutes, found.rate.incrementMinutes);
      const hours = exactHours(minutes);
      const amount = round(divide(multiply(found.rate.hourlyRate, String(minutes)), "60"), 2);
      const fellBack = found.chargedBand !== band
        ? ` (the card names no ${BAND_LABEL[band].toLowerCase()} rate)`
        : "";
      const adjusted = minutes !== worked ? `, ${worked} min worked` : "";
      return {
        quantity: hours ?? "1",
        unitPrice: hours ? found.rate.hourlyRate : amount,
        authority: card.authority,
        basis: "labour_rate",
        rateCardId: card.id,
        rateCardLineId: null,
        note: `${BAND_LABEL[found.chargedBand]} rate${fellBack}: ${minutes} min at ${cents(found.rate.hourlyRate)} an hour${adjusted}.`,
        outOfScope: false,
        band: found.chargedBand,
      };
    }
  }

  if (MATERIAL_KINDS.includes(line.kind) && line.unitCost && isPositive(line.unitCost)) {
    for (const card of cards) {
      const tier = tierFor(card.markup, line.unitCost);
      if (!tier) continue;
      const price = round(add(line.unitCost, multiply(line.unitCost, tier.percent)), 2);
      return {
        quantity: line.quantity,
        unitPrice: price,
        authority: card.authority,
        basis: "material_markup",
        rateCardId: card.id,
        rateCardLineId: null,
        note: `Cost ${cents(line.unitCost)} plus ${percentText(tier.percent)} markup.`,
        outOfScope: false,
        band: null,
      };
    }
  }

  if (line.kind === "trip") {
    for (const card of cards) {
      if (!card.tripCharge) continue;
      return {
        quantity: line.quantity,
        unitPrice: card.tripCharge,
        authority: card.authority,
        basis: "trip_charge",
        rateCardId: card.id,
        rateCardLineId: null,
        note: `${card.name}: trip charge per visit.`,
        outOfScope: false,
        band: null,
      };
    }
  }

  return fallback(line, cards);
}

/** The trip charge a card makes per visit, from the first card that has one. */
export function tripChargeOf(cards: readonly CardTerms[]): { card: CardTerms; amount: Money } | null {
  for (const card of cards) if (card.tripCharge && isPositive(card.tripCharge)) return { card, amount: card.tripCharge };
  return null;
}

const percentText = (fraction: string): string => {
  const percent = Number(fraction) * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
};

/* --------------------------------------------------------- the ceiling */

export type CeilingAction = "hold" | "warn";

export interface CeilingVerdict {
  state: "none" | "within" | "over";
  ceiling: Money | null;
  /** What is left before this work, null with no ceiling. */
  remaining: Money | null;
  over: Money | null;
  /** True when the invoice must wait for a bigger authorisation. */
  held: boolean;
  message: string | null;
}

/**
 * Whether this much more work fits under the ceiling the client set.
 *
 * Counts what earlier invoices on the job already used, for the reason the
 * authorisation module gives: two invoices each fitting on their own and
 * together over the limit is the case that is usually got wrong.
 *
 * `warn` does not make going over acceptable, it makes it the client's call:
 * some facilities networks take the overage and chase it afterwards. The
 * message is the same either way, because the person invoicing needs to know
 * in both cases.
 */
export function ceilingVerdict(input: {
  amount: Money;
  alreadyBilled: Money;
  ceiling: Money | null;
  action: CeilingAction;
  source: string;
}): CeilingVerdict {
  if (!input.ceiling) {
    return { state: "none", ceiling: null, remaining: null, over: null, held: false, message: null };
  }
  const remaining = subtract(input.ceiling, input.alreadyBilled);
  const after = add(input.alreadyBilled, input.amount);
  if (compare(after, input.ceiling) <= 0) {
    return { state: "within", ceiling: input.ceiling, remaining, over: null, held: false, message: null };
  }
  const over = subtract(after, input.ceiling);
  const left = isNegative(remaining) ? zero(remaining.currency) : remaining;
  return {
    state: "over",
    ceiling: input.ceiling,
    remaining,
    over,
    held: input.action === "hold",
    message: `${input.source} is ${cents(input.ceiling)}`
      + (isPositive(input.alreadyBilled) ? `, of which ${cents(input.alreadyBilled)} is already billed` : "")
      + `. This work comes to ${cents(input.amount)}, ${cents(over)} over. `
      + (input.action === "hold"
        ? `It is held until the client raises the limit. Ask them for a supplement, or bill ${cents(left)} now.`
        : "The contract lets it through, so expect the client to question the difference."),
  };
}

/* --------------------------------------------------------- annual escalation */

/**
 * A CONTRACT'S ANNUAL ESCALATION, APPLIED TO ITS CARDS.
 *
 * A contract says "rates rise three per cent each year on the anniversary",
 * and the card is the price list that has to rise. Pure arithmetic here: the
 * service decides which cards are in force and writes the new version.
 */

/**
 * The anniversary after `escalatedThrough` (or the first one, a year after
 * the contract started), as `YYYY-MM-DD`. A contract that started on the 29th
 * of February has its anniversary on the 28th in a year without one, because
 * a rise that waits for a day that does not exist would skip three years.
 */
export function nextAnniversary(startsOn: string, escalatedThrough: string | null): string {
  const [year, month, day] = startsOn.split("-").map(Number) as [number, number, number];
  const from = escalatedThrough ?? startsOn;
  for (let n = 1; n < 200; n += 1) {
    const candidate = anniversaryIn(year + n, month, day);
    if (candidate > from) return candidate;
  }
  throw new RangeError(`No anniversary of ${startsOn} after ${from}.`);
}

function anniversaryIn(year: number, month: number, day: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(Math.min(day, last))}`;
}

/** Which year of the contract an anniversary opens: the first anniversary opens year two. */
export function contractYear(startsOn: string, anniversary: string): number {
  return Number(anniversary.slice(0, 4)) - Number(startsOn.slice(0, 4)) + 1;
}

/**
 * A price risen by a rate, to the cent, half up: 142.50 at three per cent is
 * 146.78 (146.775 rounded up). A rate is a fraction, 0.03 for three per cent,
 * and must be more than nothing and less than one: a "3" is a typo that would
 * quadruple every price on the card.
 */
export function escalate(price: Money, rate: string): Money {
  /**
   * Exact, then rounded once to the cent, from the bigints: multiplying to
   * four places and then rounding to two would round twice, and a price a
   * hair under half a cent would come out a cent high.
   */
  const found = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!found) throw new TypeError(`Not a rate: ${JSON.stringify(rate)}`);
  const divisor = 10n ** BigInt((found[2] ?? "").length);
  const value = BigInt(`${found[1]}${found[2] ?? ""}`);
  const numerator = price.amount * (divisor + value);
  const denominator = divisor * 100n;
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  let cents = abs / denominator;
  if ((abs % denominator) * 2n >= denominator) cents += 1n;
  return { amount: (negative ? -cents : cents) * 100n, currency: price.currency };
}

/** Whether a stored escalation rate is one a card can be risen by. */
export function escalationRateProblem(rate: string | null | undefined): string | null {
  if (rate === null || rate === undefined || rate.trim() === "") return "This contract has no annual escalation rate.";
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return "An escalation of nothing raises nothing. Set the contract's rate first.";
  if (n >= 1) return `An escalation of ${rate} would more than double every price. Write 0.03 for three per cent.`;
  return null;
}
