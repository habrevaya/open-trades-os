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
    "From a sign in only, for a card the customer already lets the company charge. Turning it on needs the autopay words shown for this card, checked as the agreement's are; it then pays each bill issued from now on, a plan's instalments included, and turns it off on any other card; the backups stay behind it, and a backup chosen here moves to the front. Turning it off needs no words, and stops the backups too.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({ token: Token, cardId: Uuid, on: z.boolean(), wording: z.string().max(2000).optional() }),
  output: PortalCardAgreement,
});

export const setPortalCardAutopayBackup = defineRoute({
  method: "post",
  path: "/v1/portal/cards/{cardId}/autopay-backup",
  summary: "Keep a saved card as a backup for paying automatically, or stop",
  description:
    "From a sign in only, for a card the customer already lets the company charge and that is not the card paying automatically. Turning it on needs the backup words shown for this card (`wording.backup` on `GET /v1/portal/cards`), checked as the agreement's are, and a card already paying automatically; it goes behind the backups there are, up to two. When an automatic charge on the first card does not go through, each backup is tried once, in order, in the same run, and the customer is told which card paid. Backups are never tried on the next day's try, and stop when paying automatically stops. Turning it off needs no words and leaves the other backups where they are.",
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
  /** 1 for the card paying automatically, 2 and 3 for its backups in order, null for neither. */
  autopayRank: z.number().int().nullable(),
  givenBy: z.enum(["customer", "office"]),
  way: z.enum(["portal_sign_in", "office_phone", "office_form"]),
  wayLabel: z.string(),
  agreedOn: z.string().nullable(),
  takenBy: z.string().nullable(),
});

const ChargeOnFile = z.object({
  id: Uuid,
  trigger: z.enum(["office", "autopay"]),
  attempt: z.number().int(),
  /** 1 for the first card, 2 and 3 for a backup tried in the same run after the cards before it did not go through. */
  cardRank: z.number().int(),
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
  summary: "Charge the invoice's balance, or part of it, to a saved card the payer agreed may be charged",
  description:
    "The whole balance, or `amount` of it (dollars and cents, more than nothing, never more than is owed). Refused for a card without the customer's live agreement, a card that is not the payer's, and an invoice with nothing owed. Charged off session through the processor, for exactly the figure asked, and refused if less is owed by the time the processor is asked; the money goes on this invoice when its signed webhook says it moved. Never a tip: a tip is the customer's to add. When the bank wants the customer to confirm it themselves, the customer is sent the link to pay and the answer says so. The person charging is named on the charge and in the audit log.",
  module: "M13",
  permissions: ["payment:charge_saved", "payment:collect"],
  idempotent: true,
  input: z.object({ id: Uuid, cardId: Uuid, amount: z.string().max(20).optional() }),
  output: z.object({ chargeId: Uuid, status: z.string(), message: z.string() }),
});

/* ------------------------------- an agreement the office records */

const OfficeAgreement = PortalCardAgreement.omit({ hasForm: true, takenBy: true }).extend({
  /** The person at the company who took it, in full. */
  takenBy: z.string().nullable(),
  hasForm: z.boolean(),
  /** The scanned form, for one on paper. Opened at `/files/{storageKey}` by somebody who may read documents. */
  form: z.object({ attachmentId: Uuid, fileName: z.string().nullable(), storageKey: z.string() }).nullable(),
});

export const listCustomerCardAgreements = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/card-agreements",
  summary: "A customer's saved cards, their agreement to be charged, and the words to record one under",
  description:
    "Each saved card (never the card number) with its live agreement, whoever gave it: the customer in their own account, or the office from a phone call or a signed form. The words are the product's, one set for a phone agreement (a script to read out) and one for a signed form, exactly as they are checked when an agreement is recorded.",
  module: "M13",
  permissions: ["payment:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    cards: z.array(z.object({
      cardId: Uuid,
      kind: z.enum(["card", "bank_account"]),
      label: z.string(),
      savedOn: z.string(),
      agreement: OfficeAgreement.nullable(),
      wording: z.object({ phone: z.string(), form: z.string() }),
    })),
  }),
});

export const recordCustomerCardAgreement = defineRoute({
  method: "post",
  path: "/v1/customers/{id}/card-agreements",
  summary: "Record that a customer agreed, by phone or on a signed form, to be charged on a saved card",
  description:
    "Needs `payment:charge_saved`. `wording` is the product's own words for this way and this card (from the list), refused when they are not. `agreedOn` is the company's day the customer agreed: not in the future, not before the card was saved. A signed form needs its scan, sent as `form` (base64) or an earlier upload to the customer as `formAttachmentId`; without one it is refused. A card with a live agreement is refused: the customer's own stands. Kept in the same records as the customer's own agreement, shown to them in their portal, where they can withdraw it.",
  module: "M13",
  permissions: ["payment:charge_saved"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    cardId: Uuid,
    way: z.enum(["phone", "signed_form"]),
    agreedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    wording: z.string().min(20).max(4000),
    form: z.object({
      fileName: z.string().min(1).max(200),
      contentType: z.string().max(100).optional(),
      bytes: z.string().min(1),
    }).optional(),
    formAttachmentId: Uuid.optional(),
  }),
  output: OfficeAgreement,
});

export const withdrawCustomerCardAgreement = defineRoute({
  method: "post",
  path: "/v1/customers/{id}/card-agreements/{agreementId}/withdraw",
  summary: "Record that a customer asked to stop being charged on a saved card",
  description:
    "Needs `payment:charge_saved`. Ends the agreement and paying automatically at once, naming the person who took the request. The agreement and its form are kept. Withdrawing one already withdrawn changes nothing.",
  module: "M13",
  permissions: ["payment:charge_saved"],
  idempotent: true,
  input: z.object({ id: Uuid, agreementId: Uuid }),
  output: z.object({ ok: z.literal(true) }),
});

export const cardOnFileRoutes = {
  agreeToPortalCardCharges, setPortalCardAutopay, setPortalCardAutopayBackup, withdrawPortalCardAgreement,
  listInvoiceCardsOnFile, chargeInvoiceCardOnFile,
  listCustomerCardAgreements, recordCustomerCardAgreement, withdrawCustomerCardAgreement,
} as const;
