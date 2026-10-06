import {
  type Money, compare, isPositive, multiply, round, subtract, zero,
} from "../money/index.js";
import { addDays, addMonths, compareDates, parseDate } from "../recurrence/index.js";

/**
 * WHAT A MEMBERSHIP IS WORTH ON THE DAY IT IS USED
 *
 * Two questions the agreement book has always recorded the inputs for and
 * never answered: is this customer a member today, and therefore what comes
 * off the price; and is this term about to end, and therefore what does the
 * company owe them before it does. Both are decisions with edges, so both are
 * here, pure, and tested without a database. The services do the asking.
 */

/* ------------------------------------------------------------ member pricing */

/** One agreement a customer holds, as much of it as the decision reads. */
export interface MemberCandidate {
  agreementId: string;
  planName: string;
  /** The plan's discount as a fraction: 0.15 is fifteen per cent. Null for none. */
  discountRate: string | null;
  status: string;
  startedOn: string;
  endsOn: string | null;
  /** The address the agreement was sold against, when it was sold against one. */
  propertyId: string | null;
  /** The plan's perks, as it stands today. See `memberPricingFor` on why these are not frozen. */
  waivesDiagnosticFee?: boolean | undefined;
  waivesAfterHoursRate?: boolean | undefined;
  priorityDispatch?: boolean | undefined;
  /** What the discount leaves out, frozen on the agreement with the rate. */
  exclusions?: DiscountExclusions | undefined;
  /**
   * The share of each window the plan holds for its members, from 0 to 1,
   * or null for the company's own figure. Read by `priorityShareFor`.
   */
  holdShare?: number | null | undefined;
}

export interface MemberPricing {
  agreementId: string;
  planName: string;
  /** The discount as a fraction. "0" for a plan whose only benefit is a waived fee. */
  rate: string;
  waivesDiagnosticFee: boolean;
  waivesAfterHoursRate: boolean;
  /** What the rate does not touch. Empty for a discount on everything eligible. */
  exclusions: DiscountExclusions;
}

/** Which fee a price book item is, when it is one a plan can waive. */
export type FeeRole = "diagnostic" | "after_hours";

/**
 * Whether a rate is a discount anybody can apply.
 *
 * A fraction strictly between nothing and the whole price. Zero is a plan with
 * no discount, which is common and means "do nothing". Anything at or above
 * one is a plan whose rate was typed as a percentage, and applying it would
 * give the work away: refused rather than guessed at, the same way the
 * discount limit refuses it.
 */
export function usableRate(rate: string | null | undefined): rate is string {
  if (rate === null || rate === undefined || rate.trim() === "") return false;
  const n = Number(rate);
  return Number.isFinite(n) && n > 0 && n < 1;
}

/**
 * Which agreement's discount applies to work on a day, if any.
 *
 * ACTIVE ON THE DAY, not merely active. An agreement whose term ended
 * yesterday and has not renewed is a lapsed member whose status column has
 * not caught up, and pricing them as a member is a discount nobody paid for.
 * The end date is exclusive: a term sold on 15 January runs to 14 January.
 *
 * AT THIS ADDRESS, when the work has one. A membership is sold against a home,
 * and a customer who owns a rental as well does not get the rental's furnace
 * done at member rates because their own house is on a plan. An agreement
 * with no property covers the customer wherever the work is, which is how a
 * company that never recorded one has always meant it.
 *
 * THE BEST ONE, when there are several. A customer on two plans is entitled to
 * the better benefit, not to both, and stacking would take two discounts off
 * one line. Ties go to the agreement sold first, then by id, so the same
 * inputs always name the same agreement and the line says which.
 */
export function memberPricingFor(
  candidates: readonly MemberCandidate[],
  at: { on: string; propertyId?: string | null | undefined },
): MemberPricing | null {
  /**
   * A plan earns a place here by giving SOMETHING off: a usable rate, or a
   * waived fee. A plan whose only benefit is "no diagnostic fee for members"
   * is common, and leaving it out because its rate is nought was the reason
   * that perk was recorded on every plan and applied by nothing.
   */
  const eligible = coveringOn(candidates, at).filter((c) =>
    usableRate(c.discountRate) || c.waivesDiagnosticFee === true || c.waivesAfterHoursRate === true);

  if (eligible.length === 0) return null;

  /**
   * THE BEST ONE, NEVER TWO. Ranked by the rate first, because on a normal
   * document the rate is worth more than a waived fee, then by how many fees
   * it waives. Benefits are not stacked across plans: a customer on two plans
   * is entitled to the better one's benefits, and mixing the rate of one with
   * the waiver of another is an offer no plan made.
   */
  const rateOf = (c: MemberCandidate) => (usableRate(c.discountRate) ? Number(c.discountRate) : 0);
  const waivers = (c: MemberCandidate) => Number(c.waivesDiagnosticFee === true) + Number(c.waivesAfterHoursRate === true);
  const best = [...eligible].sort((a, b) =>
    rateOf(b) - rateOf(a)
    || waivers(b) - waivers(a)
    || compareDates(a.startedOn, b.startedOn)
    || (a.agreementId < b.agreementId ? -1 : a.agreementId > b.agreementId ? 1 : 0))[0]!;

  return {
    agreementId: best.agreementId,
    planName: best.planName,
    rate: usableRate(best.discountRate) ? best.discountRate : "0",
    waivesDiagnosticFee: best.waivesDiagnosticFee === true,
    waivesAfterHoursRate: best.waivesAfterHoursRate === true,
    exclusions: best.exclusions ?? NO_EXCLUSIONS,
  };
}

/**
 * The agreements that cover work on a day at an address, whatever they give.
 *
 * Shared by the discount and by priority dispatch, so "is this customer a
 * member for this job" has one answer: active, started, not yet ended (the end
 * is exclusive), and sold against this address or against none.
 */
function coveringOn(
  candidates: readonly MemberCandidate[],
  at: { on: string; propertyId?: string | null | undefined },
): MemberCandidate[] {
  return candidates.filter((c) =>
    c.status === "active"
    && compareDates(c.startedOn, at.on) <= 0
    && (c.endsOn === null || compareDates(at.on, c.endsOn) < 0)
    && (c.propertyId === null || !at.propertyId || c.propertyId === at.propertyId));
}

/**
 * Whether work on a day goes to the front of the queue, and which plan says so.
 *
 * The same coverage rule as the discount, so a member whose plan promised
 * priority is first on the board exactly when they would be priced as a
 * member, and not for a job at the rental their plan does not cover. Null
 * when no covering plan promises it.
 */
export function priorityFor(
  candidates: readonly MemberCandidate[],
  at: { on: string; propertyId?: string | null | undefined },
): { agreementId: string; planName: string } | null {
  const found = coveringOn(candidates, at)
    .filter((c) => c.priorityDispatch === true)
    .sort((a, b) => compareDates(a.startedOn, b.startedOn)
      || (a.agreementId < b.agreementId ? -1 : a.agreementId > b.agreementId ? 1 : 0))[0];
  return found ? { agreementId: found.agreementId, planName: found.planName } : null;
}

/**
 * How much of each held window a member's plan lets them into, on a day at
 * an address, or null when no covering plan promises priority.
 *
 * EACH PLAN SAYS ITS OWN SHARE, with the company's figure for a plan that
 * says none. A window keeps back the largest share any live plan asks for,
 * and a member is kept out of only the part above their own plan's share, so
 * a gold plan holding a third of the morning and a silver plan holding a
 * tenth both mean what they say. A customer on two such plans gets the larger.
 */
export function priorityShareFor(
  candidates: readonly MemberCandidate[],
  at: { on: string; propertyId?: string | null | undefined },
  companyShare: number,
): number | null {
  const covering = coveringOn(candidates, at).filter((c) => c.priorityDispatch === true);
  if (covering.length === 0) return null;
  return Math.max(...covering.map((c) => shareOf(c.holdShare, companyShare)));
}

/** A plan's own share, or the company's when it set none, kept between nothing and all of it. */
export function shareOf(planShare: number | null | undefined, companyShare: number): number {
  const share = planShare === null || planShare === undefined ? companyShare : planShare;
  return Number.isFinite(share) ? Math.min(Math.max(share, 0), 1) : 0;
}

/* ------------------------------------------------- what the discount leaves out */

/**
 * The price book categories and single items a plan's discount does not
 * touch. A category leaves out everything filed under it, however deep, so
 * "Equipment" takes "Equipment / Furnaces" with it.
 */
export interface DiscountExclusions {
  categoryIds: readonly string[];
  itemIds: readonly string[];
}

export const NO_EXCLUSIONS: DiscountExclusions = Object.freeze({ categoryIds: [], itemIds: [] });

/**
 * Exclusions read from a stored value, whatever shape it arrived in.
 *
 * A jsonb column is whatever was written to it. Anything that is not a list
 * of strings is dropped rather than trusted, duplicates go, and the order is
 * fixed, so two agreements with the same exclusions compare equal.
 */
export function readExclusions(value: unknown): DiscountExclusions {
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim() !== ""))].sort() : [];
  if (!value || typeof value !== "object") return NO_EXCLUSIONS;
  const record = value as Record<string, unknown>;
  return { categoryIds: list(record["categoryIds"]), itemIds: list(record["itemIds"]) };
}

export const hasExclusions = (e: DiscountExclusions | null | undefined): boolean =>
  e !== null && e !== undefined && (e.categoryIds.length > 0 || e.itemIds.length > 0);

/**
 * Whether a price book item is left out of the discount.
 *
 * By the item itself, or by its category or any category above it. The walk
 * up stops at a category it has already seen, so a price book whose parents
 * were edited into a loop is answered rather than hung on. A line typed by
 * hand names no item and no category, and is never left out: there is
 * nothing to say it is equipment.
 */
export function excludedFromDiscount(
  item: { itemId?: string | null | undefined; categoryId?: string | null | undefined },
  exclusions: DiscountExclusions,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  if (!hasExclusions(exclusions)) return false;
  if (item.itemId && exclusions.itemIds.includes(item.itemId)) return true;
  const seen = new Set<string>();
  let at = item.categoryId ?? null;
  while (at !== null && !seen.has(at)) {
    if (exclusions.categoryIds.includes(at)) return true;
    seen.add(at);
    at = parentOf.get(at) ?? null;
  }
  return false;
}

/**
 * Every item the discount leaves out, as one flat list, for a phone that
 * carries the price book without its categories' family tree.
 */
export function excludedItemIds(
  items: readonly { id: string; categoryId: string | null }[],
  exclusions: DiscountExclusions,
  parentOf: ReadonlyMap<string, string | null>,
): string[] {
  if (!hasExclusions(exclusions)) return [];
  return items.filter((item) => excludedFromDiscount({ itemId: item.id, categoryId: item.categoryId }, exclusions, parentOf))
    .map((item) => item.id).sort();
}

export interface MemberLine {
  quantity: string;
  unitPrice: Money;
  /** Whatever discount somebody already typed on the line. Comes off first. */
  discountAmount?: Money | undefined;
  eligible: boolean;
  /** Set when the line is the diagnostic fee or the after hours rate, from the price book item. */
  feeRole?: FeeRole | null | undefined;
  /**
   * Left out of the plan's discount (`excludedFromDiscount`). The rate does
   * not touch it; a waived fee is still waived, because that is a separate
   * promise the plan names on its own.
   */
  excluded?: boolean | undefined;
}

/** The fees a plan waives, as `memberDiscounts` reads them. */
export interface Waivers {
  diagnostic?: boolean | undefined;
  afterHours?: boolean | undefined;
}

/**
 * Whether a line takes the member rate at all.
 *
 * A line that costs nothing has nothing to take off. A price book item of the
 * DISCOUNT kind is already a reduction, and a percentage off a reduction makes
 * it smaller, which is a member paying more for being a member. A line that
 * bills the membership itself is the plan's own price, and discounting a plan
 * by its own benefit is a rate nobody set. A manual adjustment is somebody's
 * deliberate figure for the whole document and is left as typed.
 */
export function eligibleForMemberPricing(line: {
  unitPrice: Money;
  itemKind?: string | null | undefined;
  origin?: string | null | undefined;
}): boolean {
  if (!isPositive(line.unitPrice)) return false;
  if (line.itemKind === "discount") return false;
  if (line.origin === "membership" || line.origin === "manual") return false;
  return true;
}

/**
 * What the member rate takes off each line.
 *
 * PER LINE, rounded to the cent on each, and that is a decision rather than a
 * shortcut. The discount is shown on the line it came off, so the customer
 * can check each one against the price beside it, and a figure rounded once
 * at the bottom and spread back over the lines would put a cent on some line
 * that its own arithmetic does not produce.
 *
 * OFF WHAT IS LEFT after a discount somebody typed, never off the gross. Ten
 * per cent off a line that was already reduced by hand is ten per cent of what
 * the customer was going to pay, which is what "members save ten per cent"
 * means. Taking it off the gross would discount the hand discount as well.
 */
export function memberDiscounts(lines: readonly MemberLine[], rate: string, waivers: Waivers = {}): Money[] {
  return lines.map((line) => {
    const currency = line.unitPrice.currency;
    if (!line.eligible) return zero(currency);
    const gross = multiply(line.unitPrice, line.quantity);
    const net = subtract(gross, line.discountAmount ?? zero(currency));
    if (!isPositive(net)) return zero(currency);
    /**
     * A WAIVED FEE IS THE WHOLE LINE, whatever the rate. The plan said
     * members do not pay it, not that they pay less of it, and it is still a
     * line on the document at its full price with the whole of it discounted,
     * so the customer sees what being a member saved them and the ledger
     * posts it as a discount rather than as revenue that never existed.
     */
    if ((line.feeRole === "diagnostic" && waivers.diagnostic === true)
      || (line.feeRole === "after_hours" && waivers.afterHours === true)) {
      return net;
    }
    if (line.excluded === true || !usableRate(rate)) return zero(currency);
    const off = round(multiply(net, rate), 2);
    // Never more than what is left, whatever the rate's rounding does.
    return compare(off, net) > 0 ? net : off;
  });
}

/* ------------------------------------------------------------------ renewals */

/** One agreement, as much of it as a renewal decision reads. */
export interface RenewalState {
  status: string;
  endsOn: string | null;
  /** The agreement's own switch, frozen at sale and turned off by a cancellation. */
  autoRenews: boolean;
  /** The plan's switch. Both have to say yes. */
  planAutoRenews: boolean;
  renewalNoticeDays: number;
  renewalNoticeSentAt: Date | null;
}

export type RenewalDecision =
  | { renew: true }
  | { renew: false; reason: "not_active" | "no_end" | "not_yet" | "not_automatic" };

/**
 * Whether the worker renews this agreement today.
 *
 * BOTH SWITCHES, because they mean different things. The plan's says the
 * company sells this as a continuing membership; the agreement's says this
 * member agreed to that, and it is the one a cancellation turns off. Renewing
 * on the plan's word alone would renew somebody who asked not to be.
 *
 * ON OR AFTER THE END DATE, not before. Renewing early starts a second term's
 * obligations while the first is still being delivered, and a worker that was
 * down for a week still renews the agreements it missed when it comes back.
 */
export function renewalDue(state: RenewalState, today: string): RenewalDecision {
  if (state.status !== "active") return { renew: false, reason: "not_active" };
  if (state.endsOn === null) return { renew: false, reason: "no_end" };
  if (!state.autoRenews || !state.planAutoRenews) return { renew: false, reason: "not_automatic" };
  if (compareDates(today, state.endsOn) < 0) return { renew: false, reason: "not_yet" };
  return { renew: true };
}

/** Whole days from one calendar date to another. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000);
}

/**
 * Whether the notice the plan owes is due today.
 *
 * ONCE PER TERM. `renewalNoticeSentAt` is cleared when a term is added, so a
 * set value means this term's notice has been dealt with, whether it went or
 * was refused. A sweep that only stopped on success would text somebody who
 * replied STOP on every pass for a month.
 *
 * INSIDE THE WINDOW AND BEFORE THE END. A notice inside the last thirty days
 * is what the plan promised; one after the term ended is not a notice, it is
 * news, and the agreement has either renewed or lapsed by then.
 *
 * LATE IS STILL SENT. An agreement sold with twenty days left of a thirty day
 * notice period, or a worker that was down, is a customer owed the notice
 * now rather than one quietly skipped.
 */
export function noticeDue(state: RenewalState, today: string): boolean {
  if (state.status !== "active" || state.endsOn === null) return false;
  if (state.renewalNoticeDays <= 0) return false;
  if (state.renewalNoticeSentAt !== null) return false;
  const left = daysBetween(today, state.endsOn);
  return left > 0 && left <= state.renewalNoticeDays;
}

/** The term after this one: it starts the day this one ends. */
export function nextTerm(endsOn: string, termMonths: number): { startsOn: string; endsOn: string } {
  return { startsOn: endsOn, endsOn: addMonths(endsOn, termMonths) };
}

/**
 * The last day of cover, for a sentence a customer reads.
 *
 * The end date is exclusive in the data and nobody says it that way. "Your
 * plan ends on 15 January" read by somebody whose last covered day is the
 * 14th is a phone call on the 15th.
 */
export const lastCoveredDay = (endsOn: string): string => addDays(endsOn, -1);

/** Whether an agreement ends inside the next `days`, counting today. */
export function endingWithin(endsOn: string | null, today: string, days: number): boolean {
  if (endsOn === null) return false;
  const left = daysBetween(today, endsOn);
  return left >= 0 && left <= days;
}

/* ------------------------------------------------- why it was cancelled */

/**
 * WHY A MEMBER CANCELLED, FROM A FIXED LIST.
 *
 * The list rather than words because the retention, renewal and churn
 * figures have to tell a house sale or a move from a customer who left over
 * the price or the service, and "sold the house", "sold house", "moved" and
 * "relocating" are four strings and one fact. `other` takes words, and any
 * reason may carry some.
 */
export const CANCELLATION_CODES = ["moved", "sold", "price", "service", "switched", "not_needed", "other"] as const;
export type CancellationCode = (typeof CANCELLATION_CODES)[number];

export const CANCELLATION_LABEL: Record<CancellationCode, string> = {
  moved: "Moved house",
  sold: "Sold the property",
  price: "Price",
  service: "Not happy with the service",
  switched: "Switched to another company",
  not_needed: "No longer needed",
  other: "Something else",
};

/** A reason that means the customer left the home, which is offered the end of their link to it. */
export const leftTheHome = (code: CancellationCode | null | undefined): boolean => code === "moved" || code === "sold";

/**
 * What is wrong with a reason, in words, or null. A coded reason needs no
 * words except "something else", which is nothing without them; a
 * cancellation with no code at all needs words, as one always did.
 */
export function cancellationProblem(code: string | null | undefined, words: string | null | undefined): string | null {
  const said = (words ?? "").trim();
  if (code === null || code === undefined) {
    return said === "" ? "A cancellation needs a reason." : null;
  }
  if (!(CANCELLATION_CODES as readonly string[]).includes(code)) {
    return `"${code}" is not one of the reasons. Pick one from the list.`;
  }
  if (code === "other" && said === "") return "Say in words why they cancelled.";
  return null;
}
