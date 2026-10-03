import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * THE CUSTOMER SIGNED IN, AND WHAT THEY CAN DO THERE
 *
 * Signing in is two public routes: ask for a code at an address, then trade
 * the code for a session token. Both take the company's public key (its
 * slug, which its booking page already shows), and neither says whether the
 * address belongs to anybody: the first always answers the same way, and the
 * second refuses a wrong code, an expired one, a spent one and one for an
 * address nobody has with one sentence.
 *
 * The session token is a customer scope portal grant, held by the web app in
 * a cookie and by any other client however it keeps secrets, and every
 * route after sign in takes it the way the link routes take a link's token.
 * It reaches exactly one customer. The routes that save and use a card, and
 * the one that opens a single estimate, job or invoice as its own page,
 * refuse an account LINK with the same token shape: a link can be
 * forwarded, and a code went to the address on the customer's own record.
 */

const Token = z.string().min(20).max(200);

export const requestPortalCode = defineRoute({
  method: "post",
  path: "/v1/public/portal/{organizationSlug}/codes",
  summary: "Send a customer a sign in code",
  description:
    "Takes the email address or mobile number the company has for the customer, and sends a six digit code there through the company's own email or text sender, under their consent rules. Answers the same whether or not the address is on file, so it cannot be used to find out who is a customer. Counted per address and per network address before anything is sent; past the ceiling it answers 429 and sends nothing. A new code ends the one before it.",
  module: "M05",
  permissions: [],
  authorization: "public",
  idempotent: true,
  input: z.object({
    organizationSlug: z.string().min(1).max(100),
    address: z.string().min(3).max(254),
  }),
  output: z.object({ accepted: z.literal(true), expiresInMinutes: z.number().int() }),
});

export const SignInAccount = z.object({
  id: Uuid,
  name: z.string(),
  place: z.string().nullable(),
});

export const verifyPortalCode = defineRoute({
  method: "post",
  path: "/v1/public/portal/{organizationSlug}/sign-in",
  summary: "Sign a customer in with the code they were sent",
  description:
    "A right code returns a session token, good for a week and for one customer, and spends the code. A wrong one is counted, and five end it. When the address is on more than one customer record the answer names them, and the same code is sent again with the one chosen. Every refusal is the same 401 sentence.",
  module: "M05",
  permissions: [],
  authorization: "public",
  input: z.object({
    organizationSlug: z.string().min(1).max(100),
    address: z.string().min(3).max(254),
    code: z.string().min(4).max(20),
    customerId: Uuid.optional(),
  }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("signed_in"),
      /** Exists exactly once, here. Only its hash is stored. */
      token: z.string(),
      expiresAt: z.string().datetime(),
      customerName: z.string(),
    }),
    z.object({ status: z.literal("choose"), accounts: z.array(SignInAccount) }),
  ]),
});

export const signOutOfPortal = defineRoute({
  method: "post",
  path: "/v1/portal/sign-out",
  summary: "End a customer's sign in",
  description: "Ends the session everywhere it is held. Only a sign in can be ended here; an account link somebody was sent is withdrawn by the office.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({ token: Token }),
  output: z.object({ ok: z.literal(true) }),
});

export const PortalTipOffer = z.object({
  available: z.boolean(),
  presets: z.array(z.object({ percent: z.number().int(), amount: MoneyString })),
  /** First names of the technicians a tip would go to. */
  for: z.array(z.string()),
});

export const viewPortalAccount = defineRoute({
  method: "get",
  path: "/v1/portal/account",
  summary: "The customer's whole account",
  description:
    "Homes, work, visits, invoices with what is owed, estimates, plans and deposits, from a customer scope token: a sign in or an account link. Built field by field from what the customer may see; no cost, no margin, no internal note, no other customer.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: Token }),
  output: z.object({
    organizationName: z.string(),
    customerName: z.string(),
    properties: z.array(z.object({
      id: Uuid, line1: z.string(), line2: z.string().nullable(),
      city: z.string(), state: z.string(), postalCode: z.string(),
    })),
    jobs: z.array(z.object({
      id: Uuid, number: z.number().int(), summary: z.string(), status: z.string(),
      completedAt: z.string().datetime().nullable(),
    })),
    visits: z.array(z.object({
      id: Uuid, jobNumber: z.number().int(), summary: z.string(), status: z.string(),
      windowStart: z.string().datetime().nullable(), windowEnd: z.string().datetime().nullable(),
      technicianName: z.string().nullable(),
    })),
    invoices: z.array(z.object({
      id: Uuid, number: z.number().int(), status: z.string(),
      issuedOn: z.string().date().nullable(), dueOn: z.string().date().nullable(),
      currency: z.string(), total: MoneyString, balance: MoneyString, payable: z.boolean(),
      tipping: PortalTipOffer,
    })),
    estimates: z.array(z.object({
      id: Uuid, number: z.number().int(), title: z.string().nullable(), status: z.string(),
      sentAt: z.string().datetime().nullable(),
    })),
    agreements: z.array(z.object({
      id: Uuid, planName: z.string(), status: z.string(),
      startedOn: z.string().date(), endsOn: z.string().date().nullable(),
    })),
    deposits: z.array(z.object({
      id: Uuid, status: z.string(), amountRequested: MoneyString, amountReceived: MoneyString, currency: z.string(),
    })),
    onlinePaymentAvailable: z.boolean(),
  }),
});

const PaymentStart = z.object({
  intentId: z.string(),
  /** Opaque. What the payment form needs to finish the charge. */
  clientSecret: z.string(),
  publishableKey: z.string().nullable(),
  /** The whole charge: the balance, and the tip when there is one. */
  amount: MoneyString,
  tip: MoneyString,
  currency: z.string(),
});

export const payPortalAccountInvoice = defineRoute({
  method: "post",
  path: "/v1/portal/account/pay",
  summary: "Pay one of the customer's invoices, from their account",
  description:
    "The invoice has to be this customer's or billed to them; any other id is the same not found as one that does not exist. The amount is the invoice's balance, read here, plus a tip when the company takes tips and somebody is recorded on the job to receive it. Creates no payment: the processor's signed webhook is the only thing that does.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({
    token: Token,
    invoiceId: Uuid,
    /** Dollars and cents, as typed. Empty or zero is no tip. */
    tip: z.string().max(20).optional(),
  }),
  output: PaymentStart,
});

export const openPortalRecord = defineRoute({
  method: "post",
  path: "/v1/portal/account/open",
  summary: "Open one of the customer's own estimates, jobs or invoices on its own page",
  description:
    "From a sign in only. Returns a link to the page made for that record (approve the estimate, track the job and see its photographs, pay the invoice), minted for that one record and one day. Narrower than the session it came from, never wider.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({
    token: Token,
    kind: z.enum(["estimate", "job", "invoice"]),
    id: Uuid,
  }),
  output: z.object({ url: z.string().url() }),
});

export const PortalCard = z.object({
  id: Uuid,
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  expMonth: z.number().int().nullable(),
  expYear: z.number().int().nullable(),
  savedAt: z.string().datetime(),
});

export const listPortalCards = defineRoute({
  method: "get",
  path: "/v1/portal/cards",
  summary: "The cards the customer has saved",
  description: "From a sign in only. The brand, the last four digits and the expiry, which is all that is kept: the card itself is held by the processor.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: Token }),
  output: z.object({ cards: z.array(PortalCard), canSave: z.boolean() }),
});

export const startPortalCardSetup = defineRoute({
  method: "post",
  path: "/v1/portal/card-setup",
  summary: "Start saving a card",
  description:
    "From a sign in only. Returns what the processor's own card element needs to collect the card in the browser. The card details go to the processor and never to this server.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({ token: Token }),
  output: z.object({
    setupId: z.string(),
    clientSecret: z.string(),
    publishableKey: z.string().nullable(),
  }),
});

export const confirmPortalCardSetup = defineRoute({
  method: "post",
  path: "/v1/portal/card-setup/confirm",
  summary: "Record a card the processor says was saved",
  description:
    "From a sign in only, for a setup this customer started. The setup is read from the processor with the company's key, and the card is recorded only when the processor says the setup succeeded for this customer. Running it twice records the card once.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({ token: Token, setupId: z.string().min(3).max(200) }),
  output: PortalCard,
});

export const removePortalCard = defineRoute({
  method: "post",
  path: "/v1/portal/cards/{cardId}/remove",
  summary: "Remove a saved card",
  description: "The processor is told to forget it first. Removing a card already removed changes nothing.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({ token: Token, cardId: Uuid }),
  output: z.object({ ok: z.literal(true) }),
});

export const payPortalInvoiceWithCard = defineRoute({
  method: "post",
  path: "/v1/portal/cards/{cardId}/pay",
  summary: "Pay one invoice with a saved card",
  description:
    "From a sign in only, for an invoice this customer is the one paying. Confirmed with the card on the spot, so the answer is succeeded, processing, or requires_action when the bank wants to check it is them; the client secret finishes that in the browser. The invoice shows paid when the processor's signed webhook says the money moved.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({
    token: Token,
    cardId: Uuid,
    invoiceId: Uuid,
    tip: z.string().max(20).optional(),
  }),
  output: PaymentStart.extend({ status: z.string() }),
});

/* ------------------------------------------------------- the office side */

const PortalSettings = z.object({
  tipping: z.object({
    enabled: z.boolean(),
    presets: z.array(z.number().int()),
  }),
  jobPhotos: z.enum(["chosen", "all"]),
});

export const getPortalSettings = defineRoute({
  method: "get",
  path: "/v1/portal-settings",
  summary: "What customers may do for themselves on the portal",
  module: "M05",
  permissions: ["settings:read"],
  input: z.object({}),
  output: PortalSettings.extend({ signInUrl: z.string() }),
});

export const setPortalSettings = defineRoute({
  method: "patch",
  path: "/v1/portal-settings",
  summary: "Turn tipping on or off, and choose which job photographs customers see",
  description:
    "Tipping is off until it is turned on. Suggested tips are one to four whole percentages up to 50. Job photographs are either the ones somebody chose, one by one, or every one on the job.",
  module: "M05",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    tipping: z.object({
      enabled: z.boolean(),
      presets: z.array(z.number().int().min(1).max(50)).min(1).max(4),
    }).optional(),
    jobPhotos: z.enum(["chosen", "all"]).optional(),
  }),
  output: PortalSettings.extend({ signInUrl: z.string() }),
});

export const listInvoiceTips = defineRoute({
  method: "get",
  path: "/v1/invoices/{id}/tips",
  summary: "The tips that came with payments on an invoice, and who each is for",
  description: "A tip is held for the technicians, not counted on the invoice: it is owed to them from the moment it arrives and paid out through payroll.",
  module: "M13",
  permissions: ["invoice:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    tips: z.array(z.object({
      paymentId: Uuid,
      receivedAt: z.string().datetime(),
      amount: MoneyString,
      shares: z.array(z.object({
        technicianId: Uuid,
        technicianName: z.string(),
        amount: MoneyString,
        paidAt: z.string().datetime().nullable(),
      })),
    })),
  }),
});

export const customerPortalRoutes = {
  requestPortalCode, verifyPortalCode, signOutOfPortal, viewPortalAccount, payPortalAccountInvoice,
  openPortalRecord, listPortalCards, startPortalCardSetup, confirmPortalCardSetup, removePortalCard,
  payPortalInvoiceWithCard, getPortalSettings, setPortalSettings, listInvoiceTips,
} as const;
