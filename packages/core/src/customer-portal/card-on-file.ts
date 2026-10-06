/**
 * A SAVED CARD THE COMPANY MAY CHARGE
 *
 * A customer who saved a card or bank account pays with it by pressing Pay.
 * Letting the company charge it with nobody on the page is a second thing to
 * agree to, in words the customer reads, and paying every bill as it is
 * issued is a third. This file holds those words and the few rules about
 * what happens when a charge does not go through. Nothing here touches a
 * database, a processor or a clock it was not handed.
 *
 * THE WORDS ARE THE RECORD. What the customer is shown is built here, sent to
 * the page, sent back with their yes, built again on the server and compared:
 * the agreement stored is the one they read, word for word, or nothing is
 * stored. So the wording is a function of what the customer can see (the
 * company's name and the card as it is named on the page) and nothing else.
 */

export type SavedMethodKind = "card" | "bank_account";

const BRAND: Record<string, string> = {
  visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover",
  diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay",
};

/**
 * How a saved card or bank account is named to the customer and the office
 * alike: "Visa ending 4242", "Frost Bank account ending 6789". Here rather
 * than in the web app, because the agreement's words carry it and the
 * server has to build the same words the page showed.
 */
export function methodLabel(card: { brand: string | null; last4: string | null; kind?: SavedMethodKind | string | undefined }): string {
  return card.kind === "bank_account"
    ? `${card.brand ?? "Bank"} account${card.last4 ? ` ending ${card.last4}` : ""}`
    : `${BRAND[card.brand ?? ""] ?? "Card"}${card.last4 ? ` ending ${card.last4}` : ""}`;
}

export interface WordingInput {
  /** The company, as the customer knows it. */
  company: string;
  /** The card as the page names it: "Visa ending 4242", "Frost Bank account ending 6789". */
  method: string;
  kind: SavedMethodKind;
}

const companyName = (name: string) => name.trim() || "The company";

/**
 * Letting the company charge this card or bank account for the customer's
 * bills, from the office, without the customer pressing Pay.
 *
 * Conservative on purpose: only what a bill says is owed, a receipt every
 * time, and the customer can stop it themselves at any time from their
 * account. A bank account says "take payments from" because that is what a
 * debit is, and the customer should not have to know the difference.
 */
export function agreementWording(input: WordingInput): string {
  const company = companyName(input.company);
  const what = input.kind === "bank_account" ? `take payments from my ${input.method}` : `charge my ${input.method}`;
  return `I let ${company} ${what} for bills I owe them, without me pressing Pay each time. `
    + `They will only take the amount a bill says I owe, and I will get a receipt each time. `
    + `I can stop this at any time from my account, and it stops at once for anything not yet charged.`;
}

/**
 * Paying every bill automatically, on top of the agreement above.
 *
 * Says when (the day the bill is issued, a plan's instalments included),
 * what happens when it does not go through (a link to pay another way, and
 * at most one more try the next day), and that the customer can turn it off.
 */
export function autopayWording(input: WordingInput): string {
  const company = companyName(input.company);
  const what = input.kind === "bank_account" ? `take each bill's amount from my ${input.method}` : `charge each bill to my ${input.method}`;
  return `Pay my bills automatically: when ${company} issues me a bill, including each payment on a plan, `
    + `they ${what} that day. If it does not go through, they send me a link to pay another way and may try `
    + `once more the next day. I can turn this off at any time from my account.`;
}

/**
 * Two wordings are the same agreement when they say the same words. Spaces
 * are what a browser is allowed to change on the way back (a line break in a
 * textarea, a trailing space), and nothing else.
 */
export function sameWording(shown: string, expected: string): boolean {
  const squash = (text: string) => text.replace(/\s+/g, " ").trim();
  return squash(shown) === squash(expected);
}

/* -------------------------------------------------- when a charge fails */

/**
 * The processor's answer that means the customer's bank wants them to
 * confirm this payment themselves. Charging again will get the same answer;
 * only the customer, on the page, can finish it.
 */
export const NEEDS_CUSTOMER = "authentication_required";

/**
 * Answers that will not change by tomorrow: the card is gone, wrong or not
 * the kind that can be charged this way. Trying again would be a second
 * decline on the customer's statement for nothing.
 */
const WILL_NOT_CHANGE = new Set([
  NEEDS_CUSTOMER,
  "expired_card", "incorrect_number", "invalid_number", "invalid_expiry_month", "invalid_expiry_year",
  "card_not_supported", "lost_card", "stolen_card", "pickup_card", "resource_missing",
  "payment_method_unactivated", "payment_method_unexpected_state", "payment_method_not_available",
  "account_closed", "no_account", "debit_not_authorized", "bank_account_restricted",
]);

export type ChargeFailure = "needs_customer" | "declined";

/** Whether a failure is one only the customer can finish, or an ordinary decline. */
export function failureKind(code: string | null): ChargeFailure {
  return code === NEEDS_CUSTOMER ? "needs_customer" : "declined";
}

/** A day, because a card declined for a low balance on Thursday is often fine on Friday. */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * When a declined automatic payment is tried again, or null when it is not.
 *
 * Once, the next day, and never for an answer that will not change. The
 * second try is the last: after it the customer has the link and the office
 * has the task, and a third decline on somebody's statement is a phone call
 * nobody wants. A charge from the office is never tried again by itself,
 * because the person who pressed Charge saw the answer.
 */
export function retryAt(input: {
  trigger: "office" | "autopay"; attempt: number; code: string | null; now: Date;
}): Date | null {
  if (input.trigger !== "autopay" || input.attempt >= 2) return null;
  if (input.code !== null && WILL_NOT_CHANGE.has(input.code)) return null;
  return new Date(input.now.getTime() + RETRY_AFTER_MS);
}

/**
 * What a charge that did not go through says to the customer, above the link
 * to pay another way. Plain, and never the processor's code.
 */
export function payLinkNote(input: { kind: ChargeFailure; method: string; retrying: boolean }): string {
  if (input.kind === "needs_customer") {
    return `We tried to take this bill from your ${input.method} and your bank wants you to confirm the payment yourself. `
      + "Open the link to pay it.";
  }
  return input.retrying
    ? `We tried to take this bill from your ${input.method} and it did not go through. We will try once more tomorrow, `
      + "or you can pay it now with the link."
    : `We tried to take this bill from your ${input.method} and it did not go through. Please pay it with the link.`;
}

/** How long a charge may sit as `charging` before a worker takes it as abandoned and asks again with the same key. */
export const ABANDONED_AFTER_MS = 10 * 60 * 1000;
