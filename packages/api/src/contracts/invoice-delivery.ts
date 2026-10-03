import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * GIVING THE INVOICE TO THE CUSTOMER
 *
 * `invoice_delivery` has been in the schema since the first migration and
 * nothing had ever written a row. A company using this product could raise an
 * invoice and then had no way to put it in front of the person who owes the
 * money, which is most of what an invoice is for.
 *
 * THE ROUTES BELOW ARE A COMPOSER OVER TWO MECHANISMS THAT ALREADY EXIST. The
 * mail goes through the email service, which owns consent, the suppression
 * list and the provider callbacks. The link is a portal grant, which is the
 * same token mechanism a customer already uses to approve an estimate. There
 * is deliberately no second mail path and no second token.
 *
 * SENDING TWICE AND NEVER SENDING ARE DIFFERENT SIZES OF PROBLEM, and the
 * shape of `sendInvoice` says so. A second send is refused unless the caller
 * asks for it by name, so a double click cannot mail a customer twice by
 * accident. A send that could not go out is recorded rather than thrown away,
 * so an invoice nobody sent appears on `listUndeliveredInvoices` beside the
 * money still outstanding instead of ageing quietly on a receivables report.
 *
 * A BOUNCED INVOICE IS NOT A LATE PAYER. Both show as an open balance past
 * its due date and they need opposite responses: one gets chased and the
 * other gets a correct email address. Telling them apart is the whole reason
 * the delivery attempt is a row rather than a log line.
 *
 * STATEMENTS ARE NOT HERE. Sending a customer several invoices at once is a
 * real need and it is a different document with its own period, its own
 * opening balance and a payment that allocates across invoices. A loop over
 * this route would produce one email per invoice, which is a mailshot rather
 * than a statement, so it is left out rather than half built.
 */

export const DeliveryState = z.enum([
  /** A row exists and nothing was ever handed to a transport. */
  "interrupted",
  /** The transport refused before anything left: suppressed, no consent, no provider. */
  "refused",
  /** A link was minted and handed to the operator. Nothing more is knowable. */
  "link_issued",
  /** In the outbox. No provider has seen it. */
  "queued",
  /** A provider accepted it. Through a plain SMTP relay this is the last word. */
  "sent",
  /** A receiving server accepted it. */
  "delivered",
  /** The receiving end refused it. The customer does not have their invoice. */
  "bounced",
  /** We never got as far as a conversation with the receiving end. */
  "failed",
]);

export const sendInvoice = defineRoute({
  method: "post",
  path: "/v1/invoices/{invoiceId}/send",
  summary: "Send an invoice to the customer",
  description:
    "Emails the invoice with a link the customer can open without an account, and records the attempt. A second send of the same invoice is refused unless resend is set, so a double click cannot mail somebody twice. A send the mail system refuses, because the address bounced or asked to stop, is recorded as a failed attempt rather than thrown away: an invoice nobody sent is a receivable nobody chases, and it appears on the undelivered list instead.",
  module: "M13",
  permissions: ["invoice:send"],
  idempotent: true,
  input: z.object({
    invoiceId: Uuid,
    /**
     * Where to send it, when it is not the address on the customer record.
     * A commercial client's accounts payable mailbox is rarely the contact
     * who booked the work. Left out, the payer's address wins over the
     * customer's, because on a warranty or insurance job they are not the
     * same person and only one of them owes the money.
     */
    to: z.string().email().max(320).optional(),
    /**
     * `portal_link` mints the link, records that it was handed over, and
     * sends nothing. It is what an operator uses when the address is
     * suppressed or the customer wants it another way.
     */
    channel: z.enum(["email", "portal_link"]).optional(),
    /** Say it on purpose. Without it a repeat send is refused and named. */
    resend: z.boolean().optional(),
    /** One line from the operator, shown above the link. */
    note: z.string().max(500).optional(),
    /**
     * Longer than the payment terms by default. A link that dies before the
     * invoice is due is a customer who cannot pay on the day they meant to,
     * and the company hears about that as a late payment.
     */
    linkExpiresInDays: z.number().int().min(1).max(365).optional(),
  }),
  output: z.object({
    deliveryId: Uuid,
    invoiceId: Uuid,
    channel: z.enum(["email", "portal_link"]),
    /** Which attempt this is for this invoice, counting from one. */
    attempt: z.number().int(),
    destination: z.string().nullable(),
    state: DeliveryState,
    /**
     * The link, which exists exactly once, here. Only its hash is stored, so
     * a retried request answers with an empty string rather than minting a
     * second live link to the same document.
     */
    portalUrl: z.string(),
    messageId: Uuid.nullable(),
    /** Why the mail system refused. Null on a send that was handed over. */
    reason: z.string().nullable(),
    explanation: z.string().nullable(),
  }),
});

export const InvoiceDelivery = z.object({
  id: Uuid,
  invoiceId: Uuid,
  attempt: z.number().int(),
  channel: z.string(),
  destination: z.string().nullable(),
  state: DeliveryState,
  error: z.string().nullable(),
  submittedAt: z.string().datetime().nullable(),
  sentAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  /** The provider's own words about why it did not arrive. */
  failureReason: z.string().nullable(),
  /**
   * Somebody marked this email as spam. NOT a delivery failure: it arrived
   * and a human pressed a button, so it is carried beside the state rather
   * than folded into it.
   */
  complained: z.boolean(),
  messageId: Uuid.nullable(),
  portalGrantId: Uuid.nullable(),
  /** False once the link has expired or somebody withdrew it. */
  linkActive: z.boolean(),
  createdAt: z.string().datetime(),
});

export const listInvoiceDeliveries = defineRoute({
  method: "get",
  path: "/v1/invoices/{invoiceId}/deliveries",
  summary: "Every attempt to send one invoice",
  description:
    "Answers when it went, to whom, and whether it arrived, as a query rather than an investigation. Guarded by invoice:read rather than invoice:send, because somebody chasing a payment has to be able to see that it bounced without also being able to send it.",
  module: "M13",
  permissions: ["invoice:read"],
  input: z.object({ invoiceId: Uuid }),
  output: z.object({ deliveries: z.array(InvoiceDelivery) }),
});

export const listUndeliveredInvoices = defineRoute({
  method: "get",
  /**
   * UNDER `/v1/invoice-deliveries`, NOT `/v1/invoices/undelivered`.
   *
   * The second one collides with `GET /v1/invoices/{id}`: the matcher cannot
   * tell a literal segment from a parameter, so whichever was registered
   * first would win and the other would be unreachable. A route test caught
   * it, which is the only reason this is a path and not an outage, because an
   * ambiguous route does not fail, it quietly serves the wrong handler.
   *
   * This list is about deliveries rather than about invoices anyway, which is
   * what the collision was pointing at.
   */
  path: "/v1/invoice-deliveries/undelivered",
  summary: "Money outstanding the customer may never have seen",
  description:
    "Open invoices with a balance whose last send bounced, was refused, never left, or was never attempted at all. A bounced invoice and a late payer look identical on an ageing report and need opposite responses: one gets chased, the other gets a correct address. Ordered by due date, because that is the order the money is owed in.",
  module: "M13",
  permissions: ["invoice:read"],
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({
    invoices: z.array(z.object({
      invoiceId: Uuid,
      number: z.number().int(),
      customerId: Uuid,
      customerName: z.string(),
      balance: MoneyString,
      currency: z.string(),
      dueOn: z.string().date().nullable(),
      deliveryId: Uuid.nullable(),
      channel: z.string().nullable(),
      destination: z.string().nullable(),
      /** `never_attempted` is the quietest version of the same problem. */
      state: z.union([DeliveryState, z.literal("never_attempted")]),
      failureReason: z.string().nullable(),
      lastAttemptAt: z.string().datetime().nullable(),
    })),
  }),
});

/**
 * THE CUSTOMER SIDE
 *
 * Both routes below are reached by the token in the emailed link, held by
 * somebody with no account. They declare no permissions because the grant IS
 * the permission, and neither takes an invoice id: the subject comes from the
 * grant, so there is nothing in the request a caller could change to reach
 * another customer's invoice.
 */

export const PortalInvoiceLine = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  quantity: MoneyString,
  unitPrice: MoneyString,
  lineTotal: MoneyString,
});

export const viewPortalInvoice = defineRoute({
  method: "get",
  path: "/v1/portal/invoice",
  summary: "View an invoice as the customer",
  description:
    "Built field by field from what a customer is entitled to see rather than redacted from the office view, so the unit cost on every line is never selected at all. A read, so opening the page does not spend the link.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: z.string().min(20).max(200) }),
  output: z.object({
    organizationName: z.string(),
    number: z.number().int(),
    status: z.string(),
    issuedOn: z.string().date().nullable(),
    dueOn: z.string().date().nullable(),
    currency: z.string(),
    subtotal: MoneyString,
    discountTotal: MoneyString,
    taxTotal: MoneyString,
    total: MoneyString,
    amountPaid: MoneyString,
    balance: MoneyString,
    propertyAddress: z.string(),
    lines: z.array(PortalInvoiceLine),
    /** The money already on this invoice, netted per payment. */
    payments: z.array(z.object({
      receivedAt: z.string().datetime(),
      method: z.string(),
      amount: MoneyString,
    })),
    /** Tips added for the technicians, which are not money on the invoice. */
    tips: z.array(z.object({ receivedAt: z.string().datetime(), amount: MoneyString })),
    /** Whether there is anything left to pay. */
    payable: z.boolean(),
    /** False when the company has connected no processor. Nothing to click. */
    onlinePaymentAvailable: z.boolean(),
    /** What a tip would be, when the company takes them and somebody is recorded on the job. */
    tipping: z.object({
      available: z.boolean(),
      presets: z.array(z.object({ percent: z.number().int(), amount: MoneyString })),
      for: z.array(z.string()),
    }),
  }),
});

export const payPortalInvoice = defineRoute({
  method: "post",
  path: "/v1/portal/invoice/pay",
  summary: "Pay an invoice from the link",
  description:
    "Takes no amount and no invoice id. The invoice comes from the grant and the amount is read from its balance, because the caller is a browser and a browser that can name both can name a number that suits it. It creates no payment: the processor's signed webhook is the only thing that marks money as having moved.",
  module: "M13",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({
    token: z.string().min(20).max(200),
    /**
     * A tip for the technicians, in dollars and cents as the customer typed
     * it. Refused when the company does not take tips, when it is more than
     * the balance, and when nobody is recorded on the job to receive it.
     */
    tip: z.string().max(20).optional(),
  }),
  output: z.object({
    intentId: z.string(),
    /** Opaque. What the payment form needs to finish the charge. */
    clientSecret: z.string(),
    publishableKey: z.string().nullable(),
    /** The whole charge: the balance, and the tip when there is one. */
    amount: MoneyString,
    tip: MoneyString,
    currency: z.string(),
  }),
});

export const invoiceDeliveryRoutes = {
  sendInvoice, listInvoiceDeliveries, listUndeliveredInvoices,
  viewPortalInvoice, payPortalInvoice,
} as const;
