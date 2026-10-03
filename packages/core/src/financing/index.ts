import * as m from "../money/index.js";

/**
 * CONSUMER FINANCING, WITH NO DATABASE AND NO LENDER IN IT
 *
 * A homeowner looking at a twelve thousand dollar furnace replacement is
 * asking two questions, and only one of them is about the furnace. The other
 * is "what does that cost me a month", and a company that cannot answer it on
 * the estimate loses the job to one that can.
 *
 * Three things live here because each is wrong in a way that matters and can
 * be tested without a lender:
 *
 *   WHAT AN APPLICATION'S STATUS MAY BECOME. Lenders deliver status changes
 *   by webhook, out of order and more than once, and an application that
 *   steps back from approved to applied because a slow delivery arrived late
 *   is a customer the office rings to say they were declined when they were
 *   not.
 *
 *   THE MONTHLY FIGURE. "As low as" is the number a customer quotes back. It
 *   is worked out exactly, in integers, and rounded UP to the cent, so the
 *   figure on the page is never lower than a real payment on those terms.
 *
 *   THE SENTENCE AROUND IT. A monthly figure without "subject to approval" is
 *   a promise of credit, which this company is not in a position to make and
 *   which consumer lending rules treat as an advertised term. The sentence is
 *   built here, once, so no screen can show the number without it.
 *
 * NOTHING ABOUT THE CUSTOMER'S CREDIT IS MODELLED. The lender decides; this
 * product records the status the lender returns, the amount it approved and
 * the offer the customer chose, and nothing else.
 */

/* ---------------------------------------------------------------- statuses */

export const APPLICATION_STATUSES = [
  /** The link exists and has been handed to the customer. Nothing more is known. */
  "sent",
  /** The customer started or submitted the application. */
  "applied",
  /** The lender approved an amount. The customer may or may not have accepted it. */
  "approved",
  "declined",
  /** The link or the approval ran out before anybody used it. */
  "expired",
  /** The lender paid the company. The money is on the invoice. */
  "funded",
  /** The company or the lender called it off before any money moved. */
  "cancelled",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const STATUS_LABEL: Record<ApplicationStatus, string> = {
  sent: "Link sent",
  applied: "Applied",
  approved: "Approved",
  declined: "Declined",
  expired: "Expired",
  funded: "Funded",
  cancelled: "Cancelled",
};

/** Still able to become money. An office chasing applications reads these. */
export const LIVE_STATUSES: readonly ApplicationStatus[] = ["sent", "applied", "approved"];

/** How far along a live application is. The ending states are not ranked against each other. */
const PROGRESS: Partial<Record<ApplicationStatus, number>> = { sent: 0, applied: 1, approved: 2 };

const ENDED: readonly ApplicationStatus[] = ["declined", "expired", "cancelled"];

export type StatusChange =
  | { changed: true; status: ApplicationStatus }
  | { changed: false; status: ApplicationStatus; reason: string | null };

/**
 * What an application becomes when the lender reports a status.
 *
 * FUNDED IS FINAL. Money arrived and was recorded on an invoice; nothing a
 * later delivery says undoes that here. A lender reversing a funded loan is a
 * refund, which moves money back, and that is a decision for a person with
 * the books open, so it is reported rather than acted on.
 *
 * FUNDED ALWAYS WINS OTHERWISE. A lender that says it paid the company is
 * stating a fact about money, and an application this product had as expired
 * is the one that is wrong.
 *
 * FORWARD ONLY between sent, applied and approved, because deliveries arrive
 * out of order: an "applied" that lands after "approved" is the older news.
 *
 * AN ENDING STATE IS FINAL except for funding. A declined application that
 * the lender reports as applied again is a delivery from before the decision.
 */
export function advance(current: ApplicationStatus, reported: ApplicationStatus): StatusChange {
  if (current === reported) return { changed: false, status: current, reason: null };
  if (current === "funded") {
    return {
      changed: false,
      status: current,
      reason: `The lender now reports this as ${STATUS_LABEL[reported].toLowerCase()} after it was funded. `
        + "The payment already on the invoice is left as it is; if money went back, record the refund.",
    };
  }
  if (reported === "funded") return { changed: true, status: reported };
  if (ENDED.includes(current)) {
    return { changed: false, status: current, reason: `Already ${STATUS_LABEL[current].toLowerCase()}.` };
  }
  if (ENDED.includes(reported)) return { changed: true, status: reported };
  const from = PROGRESS[current] ?? 0;
  const to = PROGRESS[reported] ?? 0;
  if (to > from) return { changed: true, status: reported };
  return { changed: false, status: current, reason: "An older update arrived after a newer one." };
}

/* ------------------------------------------------------------------- terms */

/** One way a lender offers to spread a loan: a number of months at an APR. */
export interface FinancingPlan {
  months: number;
  /** A decimal string: "17.99" is 17.99% APR. "0" is a no interest plan. */
  aprPercent: string;
}

/**
 * What the lender offers this company's customers.
 *
 * Read from the company's own agreement with the lender, entered on the
 * connection, rather than invented: the plans a merchant may advertise are
 * set by that agreement, and a figure built on somebody else's plans is a
 * term this company does not offer.
 */
export interface FinancingTerms {
  /** Who lends. Named in the sentence, because the customer is borrowing from them, not from the company. */
  lender: string;
  /** Smallest and largest amount the lender finances, as decimal strings, or null for no stated limit. */
  minAmount: string | null;
  maxAmount: string | null;
  plans: FinancingPlan[];
}

/** Longest term this product will work a payment out for. Twenty years is already a mortgage. */
export const MAX_MONTHS = 240;

/**
 * A plan typed on the connection as "60@17.99": months, then the APR.
 *
 * Null for anything else rather than a guess, because a plan read wrongly is
 * a monthly figure shown to customers that the lender will not honour.
 */
export function parsePlan(text: string): FinancingPlan | null {
  const match = /^\s*(\d{1,3})\s*@\s*(\d{1,2}(?:\.\d{1,4})?)\s*%?\s*$/.exec(text);
  if (!match) return null;
  const months = Number(match[1]);
  if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) return null;
  return { months, aprPercent: match[2]! };
}

/** Fixed point for the payment arithmetic: eighteen places, far below a cent at any term. */
const S = 10n ** 18n;

function decimalToScaled(value: string, scale: bigint): bigint {
  const [whole = "0", frac = ""] = value.trim().split(".");
  const digits = scale.toString().length - 1;
  const padded = (frac + "0".repeat(digits)).slice(0, digits);
  return BigInt(whole) * scale + BigInt(padded || "0");
}

/**
 * THE MONTHLY PAYMENT on a fully amortising loan, worked out exactly.
 *
 *   payment = principal x r / (1 - (1 + r)^-n), with r the APR over twelve
 *
 * In integers at eighteen decimal places rather than in floating point,
 * because this is money a customer is shown, and the same inputs must give the
 * same figure on every machine. ROUNDED UP to the cent: "as low as" must never
 * be lower than a payment on those terms really is. At zero APR it is the
 * principal over the months, rounded up the same way.
 */
export function monthlyPayment(principal: m.Money, plan: FinancingPlan): m.Money {
  if (!Number.isInteger(plan.months) || plan.months < 1 || plan.months > MAX_MONTHS) {
    throw new RangeError(`A plan runs for 1 to ${MAX_MONTHS} months, not ${plan.months}.`);
  }
  if (!/^\d{1,2}(\.\d{1,4})?$/.test(plan.aprPercent.trim())) {
    throw new RangeError(`"${plan.aprPercent}" is not an APR this can work with.`);
  }
  if (m.isNegative(principal)) throw new RangeError("A loan cannot be for a negative amount.");

  const n = BigInt(plan.months);
  /** Monthly rate at scale S: percent / 100 / 12. */
  const r = decimalToScaled(plan.aprPercent, S) / 1200n;
  /** Principal in money's own units (ten thousandths). */
  const p = principal.amount;

  let units: bigint;
  if (r === 0n) {
    units = p / n + (p % n === 0n ? 0n : 1n);
  } else {
    let growth = S;
    for (let i = 0n; i < n; i += 1n) growth = (growth * (S + r)) / S;
    const numerator = p * r * growth;
    const denominator = S * (growth - S);
    units = numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
  }
  /** Up to a whole cent: a hundred units of money's scale of four. */
  const cents = units / 100n + (units % 100n === 0n ? 0n : 1n);
  return { amount: cents * 100n, currency: principal.currency };
}

export interface Offer {
  monthly: m.Money;
  plan: FinancingPlan;
  lender: string;
}

/**
 * The lowest monthly payment the lender's plans give for this amount, or null.
 *
 * Null when there are no plans, or the amount is outside what the lender
 * finances: a page that shows "as low as" on a job the lender will not touch
 * is advertising credit that does not exist.
 */
export function asLowAs(amount: m.Money, terms: FinancingTerms): Offer | null {
  if (!m.isPositive(amount)) return null;
  if (terms.minAmount && m.compare(amount, m.money(terms.minAmount, amount.currency)) < 0) return null;
  if (terms.maxAmount && m.compare(amount, m.money(terms.maxAmount, amount.currency)) > 0) return null;
  let best: Offer | null = null;
  for (const plan of terms.plans) {
    const monthly = monthlyPayment(amount, plan);
    if (!best || m.compare(monthly, best.monthly) < 0) best = { monthly, plan, lender: terms.lender };
  }
  return best;
}

/** Whether a lender would look at this amount at all, before any plan is considered. */
export function inRange(amount: m.Money, terms: FinancingTerms): boolean {
  if (!m.isPositive(amount)) return false;
  if (terms.minAmount && m.compare(amount, m.money(terms.minAmount, amount.currency)) < 0) return false;
  if (terms.maxAmount && m.compare(amount, m.money(terms.maxAmount, amount.currency)) > 0) return false;
  return true;
}

/**
 * The words that go round the number, every time it is shown.
 *
 * "As low as" names the plan it came from and says, in the same sentence,
 * that the lender decides and the customer's own terms may differ. It is not
 * a promise of credit and it must not read as one, so there is no way to get
 * the figure out of this module without the caveat attached.
 */
export function offerSentence(offer: Offer): string {
  const monthly = m.format(offer.monthly);
  const apr = Number(offer.plan.aprPercent) === 0 ? "0% APR" : `${trimDecimal(offer.plan.aprPercent)}% APR`;
  return `As low as ${monthly} a month over ${offer.plan.months} months at ${apr}, `
    + `if ${offer.lender} approves the application. Subject to approval; `
    + "the rate and term you are offered may be different.";
}

/** The short form under a price, which still carries the caveat. */
export function offerShort(offer: Offer): string {
  return `As low as ${m.format(offer.monthly)}/month with ${offer.lender}, subject to approval`;
}

function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
