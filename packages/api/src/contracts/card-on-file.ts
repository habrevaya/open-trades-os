import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";
import { PortalCardAgreement } from "./customer-portal";

/**
 * A SAVED CARD THE COMPANY MAY CHARGE
 *
 * The customer's three routes take their sign in, never a link: agreeing to
 * let the company charge a saved card, paying bills automatically with it,
 * and withdrawing. The words they agree to are sent back with the yes and
 * checked against the words the server builds for that card, so what is
 * stored is what they read.
 *
 * The office's two routes read the cards an invoice's payer agreed may be
 * charged, and charge one. Charging needs `payment:charge_saved`, which a
 * technician does not hold, as well as `payment:collect`, and is refused for
 * any card without a live agreement whoever asks.
 */

const Token = z.string().min(20).max(200);

export const agreeToPortalCardCharges = defineRoute({
  method: "post",
  path: "/v1/portal/cards/{cardId}/agreement",
  summary: "Let the company charge a saved card without pressing Pay",
  description:
    "From a sign in only. `wording` is the text the customer was shown for this card (from `GET /v1/portal/cards`), and is refused when it is not the words the server builds for it now. Records the words, when, from which sign in, as which contact and from where. Agreeing to a card already agreed returns the agreement that stands.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({ token: Token, cardId: Uuid, wording: z.string().min(20).max(2000) }),
  output: PortalCardAgreement,
});

export const setPortalCardAutopay = defineRoute({
  method: "post",
  path: "/v1/portal/cards/{cardId}/autopay",
  summary: "Pay each bill automatically with a saved card, or stop",
  description:
    "From a sign in only, for a card the customer already lets the company charge. Turning it on needs the autopay words shown for this card, checked as the agreement's are; it then pays each bill issued from now on, a plan's instalments included, and turns it off on any other card. Turning it off needs no words.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({ token: Token, cardId: Uuid, on: z.boolean(), wording: z.string().max(2000).optional() }),
  output: PortalCardAgreement,
});

export const withdrawPortalCardAgreement = defineRoute({
  method: "post",
  path: "/v1/portal/cards/{cardId}/agreement/withdraw",
  summary: "Stop the company charging a saved card",
  description: "From a sign in only. Ends the agreement and paying automatically at once; the card stays saved for paying by pressing Pay. Withdrawing when there is nothing to withdraw changes nothing.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({ token: Token, cardId: Uuid }),
  output: z.object({ ok: z.literal(true) }),
});

const CardOnFile = z.object({
  agreementId: Uuid,
  cardId: Uuid,
  kind: z.enum(["card", "bank_account"]),
  label: z.string(),
  agreedAt: z.string().datetime(),
  agreedByContact: z.string().nullable(),
  autopay: z.boolean(),
});

const ChargeOnFile = z.object({
  id: Uuid,
  trigger: z.enum(["office", "autopay"]),
  attempt: z.number().int(),
  status: z.string(),
  amount: MoneyString.nullable(),
  card: z.string(),
  requestedBy: z.string().nullable(),
  failureReason: z.string().nullable(),
  retryAt: z.string().datetime().nullable(),
  customerTold: z.string().nullable(),
  customerToldNote: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const listInvoiceCardsOnFile = defineRoute({
  method: "get",
  path: "/v1/invoices/{id}/cards-on-file",
  summary: "The saved cards an invoice's payer agreed may be charged, and the charges on it",
  description: "Only cards whose customer agreed, in their own account, to be charged without pressing Pay, and every charge of one on this invoice: by whom, automatically or not, and what became of it.",
  module: "M13",
  permissions: ["payment:read"],
  input: z.object({ id: Uuid }),
  output: z.object({ cards: z.array(CardOnFile), charges: z.array(ChargeOnFile) }),
});

export const chargeInvoiceCardOnFile = defineRoute({
  method: "post",
  path: "/v1/invoices/{id}/charge-card",
  summary: "Charge the invoice's balance to a saved card the payer agreed may be charged",
  description:
    "Refused for a card without the customer's live agreement, a card that is not the payer's, and an invoice with nothing owed. Charged off session through the processor; the invoice shows paid when its signed webhook says the money moved. When the bank wants the customer to confirm it themselves, the customer is sent the link to pay and the answer says so. The person charging is named on the charge and in the audit log.",
  module: "M13",
  permissions: ["payment:charge_saved", "payment:collect"],
  idempotent: true,
  input: z.object({ id: Uuid, cardId: Uuid }),
  output: z.object({ chargeId: Uuid, status: z.string(), message: z.string() }),
});

export const cardOnFileRoutes = {
  agreeToPortalCardCharges, setPortalCardAutopay, withdrawPortalCardAgreement,
  listInvoiceCardsOnFile, chargeInvoiceCardOnFile,
} as const;
