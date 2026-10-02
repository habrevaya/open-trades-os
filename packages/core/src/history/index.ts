import { dateIn, instantOfLocal } from "../time/index.js";

/**
 * RECORDING WHAT ALREADY HAPPENED
 *
 * Most writes in this product describe something happening now: a job booked,
 * an invoice raised, a cheque handed over. A company moving here from another
 * system also has ten years of things that happened THEN, and they have to
 * land on the dates they happened or every report built on a date is wrong.
 * Ten years of invoices issued on the day of the cutover put every one of them
 * in "current" on the aging report and ten years of revenue in one month.
 *
 * Back-dating is also the oldest trick in small business bookkeeping. Revenue
 * moved into last quarter, a cheque recorded as arriving before the late fee,
 * an invoice dated to fall inside a commission period. So the rules here are
 * not about convenience, they are about who may say "this happened on a day
 * other than today":
 *
 *   1. Nothing is dated in the future. A document issued tomorrow is a draft,
 *      and cash received tomorrow has not been received.
 *   2. A date within the last LATE_ENTRY_DAYS is ordinary. The cheque that sat
 *      in the truck over a long weekend is keyed in on Tuesday, and refusing
 *      that would push people to type today's date, which is worse.
 *   3. Anything earlier is history, and needs `data:import`, a permission no
 *      preset grants except the owner's. An app token that loads a migration
 *      holds it because an owner chose to give it; a bookkeeper does not hold
 *      it by default.
 *   4. Nothing posts into a closed period, whoever is asking. That rule lives
 *      where the posting is written, because it is about the books rather
 *      than about who is writing to them.
 *
 * A back-dated posting is still an append. The ledger never learns to edit;
 * it learns to put a new pair on an earlier day.
 */

/**
 * How far back an ordinary caller may date something without holding
 * `data:import`. A week covers a long weekend and a slow bookkeeper and does
 * not cover last quarter.
 */
export const LATE_ENTRY_DAYS = 7;

/**
 * How far in the future an INSTANT may be before it counts as the future. A
 * phone's clock is routinely a minute or two out, and a payment recorded at
 * 10:00:30 by a server that thinks it is 10:00:00 has not been post-dated.
 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type DateClass = "future" | "today" | "recent" | "historical";

/** Whole calendar days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error(`Not calendar dates: ${from}, ${to}`);
  return Math.round((b - a) / 864e5);
}

/**
 * Where a business date sits relative to today, both in the company's own
 * calendar. Comparing in UTC would move the boundary by six hours for a
 * company in Chicago and make a cheque keyed in at 7pm "tomorrow".
 */
export function classifyDate(date: string, today: string): DateClass {
  const age = daysBetween(date, today);
  if (age < 0) return "future";
  if (age === 0) return "today";
  if (age <= LATE_ENTRY_DAYS) return "recent";
  return "historical";
}

/** The same question for an instant, read in a zone. */
export function classifyInstant(at: Date, now: Date, timeZone: string): DateClass {
  if (at.getTime() - now.getTime() > CLOCK_SKEW_MS) return "future";
  return classifyDate(dateIn(at, timeZone), dateIn(now, timeZone));
}

/**
 * The instant a posting for a business date is stamped with.
 *
 * Today's documents keep the wall clock, so the order things happened in a
 * day survives. An earlier date is stamped at noon in the company's zone,
 * which is on that calendar day however the instant is later read: midnight
 * would land on the previous day for anybody reading it in UTC minus
 * anything, and a December 31st invoice would move into the previous year's
 * books on exactly the report where it matters.
 */
export function postingInstant(date: string, timeZone: string, now: Date): Date {
  if (date === dateIn(now, timeZone)) return now;
  return instantOfLocal(date, 12 * 60, timeZone);
}

/**
 * Whether a business date is inside a closed period. Inclusive: a close
 * through March 31st freezes March 31st.
 */
export function isClosed(date: string, closedThrough: string | null): boolean {
  return closedThrough !== null && date <= closedThrough;
}
