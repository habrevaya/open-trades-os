import { customerPortal } from "@opentradesos/core";

/**
 * How a saved card or bank account is named on a button, on the server and
 * in the browser alike: "Visa ending 4242", "Frost Bank account ending 6789".
 *
 * Its own module rather than beside the saved cards control, because that
 * control is a client component and a server page cannot call a function
 * exported from one: the page naming a card for the pay button failed the
 * moment a customer had a card saved. The words themselves are core's,
 * because the agreement a customer signs carries the card's name and the
 * server has to build the same words the page showed.
 */
export const cardLabel = (card: { brand: string | null; last4: string | null; kind?: "card" | "bank_account" | undefined }) =>
  customerPortal.methodLabel(card);
