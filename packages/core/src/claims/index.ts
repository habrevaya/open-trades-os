import {
  type Money, add, subtract, compare, isPositive, isNegative, zero, round, edit, format,
} from "../money/index.js";

/** An amount as a person reads it: 380.00, not 380.0000. */
const cents = (value: Money): string => edit(round(value, 2));

/**
 * A CLAIM ON A THIRD PARTY, AND WHAT BECOMES OF IT
 *
 * A home warranty company, a manufacturer or a carrier is asked to pay for
 * covered work, and the answer comes back in one of four shapes: yes, yes
 * for less, no, or money that does not match either. The invoice is the
 * receivable and ages on the ledger like any other; the claim is the
 * conversation about it, and this file is the rules of that conversation.
 *
 * The rules are few and they are the ones that cost money when they are
 * loose:
 *
 *   An approval cannot be for more than was claimed. A payer approving more
 *   than we asked for is a typing error on one side, and recording it would
 *   make a short payment look like an overpayment.
 *
 *   A denial is final here. Appealing it is a new claim with its own
 *   reference, because the payer treats it as one, and an old denial quietly
 *   turned into an approval is a receivable nobody can trace.
 *
 *   Paid in full means what they agreed, not what we asked. A claim approved
 *   at 380 against 420 and paid 380 is paid; the 40 was decided at approval,
 *   and calling the claim short paid would chase money the payer never owed.
 */

export type ClaimStatus = "submitted" | "approved" | "paid" | "short_paid" | "denied";

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  submitted: "Submitted",
  approved: "Approved",
  paid: "Paid",
  short_paid: "Short paid",
  denied: "Denied",
};

export interface ClaimState {
  status: ClaimStatus;
  claimed: Money;
  approved: Money | null;
  paid: Money;
}

export type Decision =
  | { ok: true; status: ClaimStatus; approved: Money | null }
  | { ok: false; reason: string };

/** What they said about it. */
export function decide(
  claim: ClaimState, input: { outcome: "approved" | "denied"; amount?: Money | null; note?: string | null },
): Decision {
  if (claim.status === "denied") {
    return { ok: false, reason: "This claim was denied. An appeal is a new claim with the payer's new reference." };
  }
  if (claim.status === "paid") return { ok: false, reason: "This claim is paid. There is nothing left to decide." };
  if (isPositive(claim.paid)) {
    return { ok: false, reason: "Money has already arrived against this claim, so the payer has decided. Record the rest of their payment instead." };
  }
  if (input.outcome === "denied") {
    if (!input.note?.trim()) {
      return { ok: false, reason: "Say why they denied it, in their words. A denial with no reason cannot be appealed or learned from." };
    }
    return { ok: true, status: "denied", approved: null };
  }
  const amount = input.amount ?? claim.claimed;
  if (isNegative(amount) || !isPositive(amount)) {
    return { ok: false, reason: "An approval is for more than nothing. If they will pay nothing, record a denial." };
  }
  if (compare(amount, claim.claimed) > 0) {
    return {
      ok: false,
      reason: `They cannot approve ${cents(amount)} against a claim for ${cents(claim.claimed)}. Check the figure with them.`,
    };
  }
  return { ok: true, status: "approved", approved: amount };
}

/** What we expect from them now: what they approved, or what we claimed until they say. */
export const expectedOf = (claim: ClaimState): Money => claim.approved ?? claim.claimed;

/**
 * Money arrived from them against the claim.
 *
 * Paid when everything expected has arrived, short paid when less has. A
 * payment above what was expected is refused: it is a payment for something
 * else, and booking it here would leave a credit on a receivable that does
 * not owe one.
 */
export function settle(
  claim: ClaimState, amount: Money,
): { ok: true; status: ClaimStatus; paid: Money; shortfall: Money } | { ok: false; reason: string } {
  if (claim.status === "denied") {
    return { ok: false, reason: "This claim was denied. Money from them is for something else, or the denial was reversed: record it as a new claim." };
  }
  if (claim.status === "paid") return { ok: false, reason: "This claim is already paid in full." };
  if (!isPositive(amount)) return { ok: false, reason: "Record the amount that arrived." };

  const expected = expectedOf(claim);
  const paid = add(claim.paid, amount);
  if (compare(paid, expected) > 0) {
    return {
      ok: false,
      reason: `That would bring payments to ${cents(paid)} against ${cents(expected)} expected. `
        + "Money over what they agreed is not for this claim.",
    };
  }
  const shortfall = subtract(expected, paid);
  return { ok: true, status: isPositive(shortfall) ? "short_paid" : "paid", paid, shortfall };
}

/** What is still owed on a claim. Zero once it is paid or denied. */
export function outstanding(claim: ClaimState): Money {
  if (claim.status === "denied" || claim.status === "paid") return zero(claim.claimed.currency);
  const left = subtract(expectedOf(claim), claim.paid);
  return isNegative(left) ? zero(left.currency) : left;
}

/* ------------------------------------------------ billing the rest on */

export type BillOn = { ok: true; amount: Money } | { ok: false; reason: string };

/**
 * WHAT IS LEFT FOR THE CUSTOMER WHEN THE PAYER PAID LESS THAN WAS CLAIMED.
 *
 * Asked for by a person on one claim, never worked out for every claim on a
 * schedule: whether a homeowner owes what their warranty company would not
 * pay is a conversation, and the office has it.
 *
 * Only on a claim the payer is done with: paid (what they agreed, which may
 * be less than was asked), short paid or denied. A claim still waiting on
 * their answer or their money may yet be paid, and billing the customer
 * meanwhile would ask two people for the same money.
 *
 * AND ONLY ONCE THEIR INVOICE OWES NOTHING. The part they did not pay sits on
 * their invoice as a receivable until somebody credits it or writes it off
 * there. Billing it to the customer while it is still owed by the payer
 * would put the same money on the books as owed twice, and count it as
 * revenue twice once the customer's invoice is issued. So the person settles
 * the payer's invoice first, by the decision that fits (a credit when the
 * payer's own schedule never covered it, a write off when they simply would
 * not pay), and then bills the customer.
 *
 * The amount is what was claimed less what they paid.
 */
export function billOn(claim: ClaimState, input: {
  /** What the payer's invoice still owes. */
  payerOwes: Money;
  /** The invoice already made for the customer from this claim, still in use, if any. */
  alreadyBilled: string | null;
}): BillOn {
  if (input.alreadyBilled) {
    return { ok: false, reason: `This claim has already been billed to the customer, on invoice ${input.alreadyBilled}.` };
  }
  if (claim.status === "submitted" || claim.status === "approved") {
    return {
      ok: false,
      reason: "The payer has not finished with this claim: it is waiting on their answer or their money. Bill the customer once it is paid, short paid or denied.",
    };
  }
  const rest = subtract(claim.claimed, claim.paid);
  if (!isPositive(rest)) {
    return { ok: false, reason: "They paid everything that was claimed, so there is nothing to bill the customer." };
  }
  if (isPositive(input.payerOwes)) {
    return {
      ok: false,
      reason: `Their invoice still shows ${format(round(input.payerOwes, 2))} owing. Credit it or write it off on their invoice first, so the same money is not owed by two people.`,
    };
  }
  return { ok: true, amount: rest };
}
