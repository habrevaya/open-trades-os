import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * TAKING A CARD
 *
 * The `payment` table has carried a `processor` column defaulting to "stripe"
 * since the first migration, with a `processor_payment_id` beside it and an
 * `idempotency_key` documented as written before the processor call. Nothing
 * had ever called a processor. A company running this could record that a
 * card had been taken somewhere else, which is a different product.
 *
 * THE MONEY GOES TO THE OPERATOR'S OWN MERCHANT ACCOUNT. There is no platform
 * account, no Connect, and this project takes no cut: the operator supplies a
 * restricted key for the Stripe account they already have, and revoking it in
 * their dashboard stops this software charging anybody without asking us.
 *
 * NOTHING HERE MARKS AN INVOICE PAID. `createPaymentIntent` returns what a
 * payment form needs and writes no payment. The webhook is the only authority
 * on whether money moved, because a browser reporting success is a claim by a
 * browser: it can be wrong honestly, when somebody closes the tab mid charge,
 * and dishonestly, when the request was never a payment form at all. Both
 * produce an invoice marked paid with nothing behind it, and no report
 * downstream can tell.
 */

export const getPaymentsStatus = defineRoute({
  method: "get",
  path: "/v1/payments/connection",
  summary: "Whether cards can be taken, and what the form needs",
  description:
    "Says separately whether a processor is connected and whether its webhook is configured, because the two fail differently. A connection with no signing secret takes cards perfectly well and never learns that any of them succeeded: every invoice stays open, every customer is chased for money they have already paid, and the settings screen says connected.",
  module: "M13",
  permissions: ["integration:read"],
  input: z.object({}),
  output: z.object({
    connected: z.boolean(),
    provider: z.string().nullable(),
    /** Safe to hand a browser. Never the secret key. */
    publishableKey: z.string().nullable(),
    webhookConfigured: z.boolean(),
    connectionId: Uuid.nullable(),
    /**
     * What to paste into the processor's dashboard, after this deployment's
     * own public address. A path rather than a URL because this process does
     * not reliably know that address: behind a load balancer the request
     * arrives on an internal hostname, and a URL built from it sends the
     * operator to somewhere Stripe cannot reach.
     */
    webhookPath: z.string().nullable(),
    lastError: z.string().nullable(),
  }),
});

export const createPaymentIntent = defineRoute({
  method: "post",
  path: "/v1/payments/intents",
  summary: "Start a card payment",
  description:
    "Name the invoices and the amount is read from their balances rather than taken from the caller, because the caller is usually a browser and a browser that can name both can name a number that suits it. Returns a client secret and records the attempt. It does not create a payment: that happens when the processor says the money moved.",
  module: "M13",
  permissions: ["payment:collect"],
  idempotent: true,
  input: z.object({
    customerId: Uuid,
    /**
     * Only read when no invoices are named. A charge for an amount nobody
     * named is one nothing can reconcile, so one of the two is required.
     */
    amount: MoneyString.optional(),
    /**
     * Which invoices this is meant to settle, carried through the processor
     * and back. Omit it and the money lands oldest balance first, which is
     * right for a cheque in the post and wrong for a customer who clicked
     * pay on one invoice out of four.
     */
    invoiceIds: z.array(Uuid).max(50).optional(),
    /** Shown on the customer's statement. */
    description: z.string().max(200).optional(),
    receiptEmail: z.string().email().max(320).optional(),
  }),
  output: z.object({
    attemptId: Uuid,
    intentId: z.string(),
    /** Opaque. What the payment form needs to finish the charge. */
    clientSecret: z.string(),
    publishableKey: z.string().nullable(),
    amount: MoneyString,
    currency: z.string(),
    allocations: z.array(z.object({ invoiceId: Uuid, amount: MoneyString })),
  }),
});

export const refundPayment = defineRoute({
  method: "post",
  path: "/v1/payments/{paymentId}/refund",
  summary: "Give a card payment back",
  description:
    "Refuses more than is left to refund, and refuses a payment that never went through a processor: money that arrived as a cheque goes back as a cheque. The payment row is not changed here. Stripe answers with a refund that is pending, and the row changes when the webhook says the money actually moved, so there is one path to that column rather than two that disagree the day a refund is created and then fails.",
  module: "M13",
  permissions: ["payment:refund"],
  idempotent: true,
  input: z.object({
    paymentId: Uuid,
    /** Omit for the whole remaining amount. */
    amount: MoneyString.optional(),
    reason: z.string().max(200).optional(),
  }),
  output: z.object({
    paymentId: Uuid,
    refundId: z.string(),
    amount: MoneyString,
    status: z.string(),
    /** Always false. The webhook settles it. Said out loud so nobody waits for true. */
    settled: z.literal(false),
  }),
});

export const paymentRoutes = {
  getPaymentsStatus, createPaymentIntent, refundPayment,
} as const;
