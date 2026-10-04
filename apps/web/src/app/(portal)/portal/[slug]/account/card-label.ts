/**
 * How a saved card or bank account is named on a button, on the server and
 * in the browser alike: "Visa ending 4242", "Frost Bank account ending 6789".
 *
 * Its own module rather than beside the saved cards control, because that
 * control is a client component and a server page cannot call a function
 * exported from one: the page naming a card for the pay button failed the
 * moment a customer had a card saved.
 */
const BRAND: Record<string, string> = {
  visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover",
  diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay",
};

export const cardLabel = (card: { brand: string | null; last4: string | null; kind?: "card" | "bank_account" | undefined }) =>
  card.kind === "bank_account"
    ? `${card.brand ?? "Bank"} account${card.last4 ? ` ending ${card.last4}` : ""}`
    : `${BRAND[card.brand ?? ""] ?? "Card"}${card.last4 ? ` ending ${card.last4}` : ""}`;
