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
}

export interface MemberPricing {
  agreementId: string;
  planName: string;
  rate: string;
}

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
  const eligible = candidates.filter((c) =>
    c.status === "active"
    && usableRate(c.discountRate)
    && compareDates(c.startedOn, at.on) <= 0
    && (c.endsOn === null || compareDates(at.on, c.endsOn) < 0)
    && (c.propertyId === null || !at.propertyId || c.propertyId === at.propertyId));

  if (eligible.length === 0) return null;

  const best = [...eligible].sort((a, b) =>
    Number(b.discountRate) - Number(a.discountRate)
    || compareDates(a.startedOn, b.startedOn)
    || (a.agreementId < b.agreementId ? -1 : a.agreementId > b.agreementId ? 1 : 0))[0]!;

  return { agreementId: best.agreementId, planName: best.planName, rate: best.discountRate! };
}

export interface MemberLine {
  quantity: string;
  unitPrice: Money;
  /** Whatever discount somebody already typed on the line. Comes off first. */
  discountAmount?: Money | undefined;
  eligible: boolean;
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
export function memberDiscounts(lines: readonly MemberLine[], rate: string): Money[] {
  return lines.map((line) => {
    const currency = line.unitPrice.currency;
    if (!line.eligible || !usableRate(rate)) return zero(currency);
    const gross = multiply(line.unitPrice, line.quantity);
    const net = subtract(gross, line.discountAmount ?? zero(currency));
    if (!isPositive(net)) return zero(currency);
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
