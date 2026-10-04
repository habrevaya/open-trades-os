import { adapterSettings } from "../secrets/endpoints";

/**
 * THE PAYMENTS SEAM
 *
 * Same shape as the messaging seam next door, for the same reason: a
 * contractor self hosting this must be able to point it at the processor they
 * already have a merchant account with, and must be able to leave. So the
 * product knows about "take this much money from this customer" and nothing
 * about Stripe, and an adapter is a few hundred lines.
 *
 * NO PLATFORM ACCOUNT, NO CONNECT, AND THAT IS THE WHOLE POSTURE.
 *
 * The schema comment on `integration_connection` already states it: Stripe
 * deprecated Standard, Express and Custom for new platforms in favour of
 * Accounts v2 configurations, and for bring your own self hosting the answer
 * is no Connect at all, just an operator supplied restricted key. That is
 * Stripe's own guidance and it is also the only design that survives the
 * product being self hosted, because the alternative puts a platform secret
 * on infrastructure this project does not control and cannot audit.
 *
 * What it means in practice: the money goes from the homeowner to the
 * contractor's own Stripe account, on the contractor's own terms, at the
 * contractor's own rate. This codebase never touches it, never holds it, and
 * takes no cut. An operator revoking the key in their Stripe dashboard stops
 * this software charging anybody, immediately, without asking us.
 *
 * THREE THINGS ARE DELIBERATELY NOT THE PROVIDER'S BUSINESS.
 *
 * WHAT THE MONEY IS FOR. The provider is told an amount and a reference. It
 * is not told which invoices the money settles, because allocation is an
 * accounting decision that has to survive the processor being replaced, and
 * `billing.pay` already makes it correctly with a total ordering that a
 * processor knows nothing about.
 *
 * WHETHER THE PAYMENT IS ALLOWED. A refused card is the processor's answer;
 * whether this customer should be charged at all is ours.
 *
 * WHEN THE MONEY IS REAL. A client side confirmation is a claim by a browser.
 * The authority is the webhook, verified, and nothing else. See `receive` in
 * `services/payments.ts` for why this is not paranoia.
 */

/** Minor units, because every processor's API speaks them and float does not. */
export interface ChargeRequest {
  /** Cents. An integer, and never a float: 19.99 dollars is 1999. */
  amountMinor: number;
  currency: string;
  /**
   * Our own id for this attempt, sent as the processor's idempotency key.
   *
   * Not optional. A card charge is the one request in this product where a
   * retry that is not deduplicated takes a second thousand dollars off
   * somebody, and the network failure that causes it is the ordinary case
   * rather than the exotic one: the charge succeeded and the response was
   * lost.
   */
  idempotencyKey: string;
  /** Shown on the customer's statement where the processor supports it. */
  description?: string | undefined;
  /** Carried back on the webhook, so settlement needs no lookup table. */
  metadata?: Record<string, string> | undefined;
  /** For a receipt the processor sends on the operator's behalf. */
  receiptEmail?: string | undefined;
  /**
   * A card the customer saved, and the processor's record of the customer
   * it is saved against. When both are given the charge is confirmed on the
   * spot with that card, because the customer is on the page pressing Pay;
   * the intent comes back succeeded, processing, or asking the browser to
   * finish a bank's check. Nothing about it is settled until the webhook.
   */
  customerRef?: string | undefined;
  paymentMethodRef?: string | undefined;
  /**
   * What the saved method is. A bank account is debited rather than
   * charged: the processor answers `processing`, and only days later says
   * whether the money arrived. Card when absent.
   */
  methodKind?: "card" | "bank_account" | undefined;
  /**
   * The customer agreeing to this debit on the page, for a bank account:
   * where they were and what they used. A processor records it on the
   * mandate that authorises taking money from somebody's bank.
   */
  acceptance?: { ip?: string | undefined; userAgent?: string | undefined } | undefined;
}

export interface ChargeIntent {
  /** The processor's id for this attempt. Stored, and matched on the webhook. */
  intentId: string;
  /**
   * What the browser or the field app needs to finish the payment.
   *
   * Deliberately opaque to everything above this seam. Stripe calls it a
   * client secret, another processor calls it a session token or a redirect
   * URL, and a service that branched on which one it got would be a service
   * that knows about Stripe.
   */
  clientSecret: string;
  amountMinor: number;
  currency: string;
  status: string;
}

export interface RefundRequest {
  /** The processor's payment id, not ours. */
  intentId: string;
  /** Cents. Absent means the whole thing. */
  amountMinor?: number | undefined;
  idempotencyKey: string;
  reason?: string | undefined;
}

export interface RefundResult {
  refundId: string;
  amountMinor: number;
  status: string;
}

/**
 * `retryable` is the whole reason these are results rather than exceptions.
 *
 * A processor rate limit and a declined card both fail, and treating them the
 * same means either giving up on a payment that would have gone through, or
 * retrying a card that will never work while a customer watches a spinner.
 * The messaging seam learned this first and the stakes here are higher.
 */
export type ChargeOutcome =
  | { ok: true; intent: ChargeIntent }
  | { ok: false; code: string; message: string; retryable: boolean };

export type RefundOutcome =
  | { ok: true; refund: RefundResult }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface WebhookRequest {
  headers: Record<string, string>;
  /** The raw body, exactly as received. Re-serializing breaks every signature. */
  body: string;
}

/**
 * What happened, normalized.
 *
 * Processors disagree about nearly every field name and about how many
 * objects one payment is. What every one of them agrees on is that something
 * happened to a known amount of money attached to a known attempt, and that
 * is all anything above this seam needs.
 */
export type PaymentEventKind =
  | "succeeded"
  /**
   * Accepted and on its way, not yet arrived. A bank debit sits here for
   * days. Nothing is booked: it is pending until the processor says it
   * succeeded or failed.
   */
  | "processing"
  | "failed"
  /** The customer's bank pulled it back. Different from a refund we chose. */
  | "disputed"
  | "refunded"
  /** Something we do not model. Recorded and ignored, never guessed at. */
  | "other";

export interface PaymentEvent {
  /**
   * The processor's id for THE EVENT, not for the payment.
   *
   * This is what makes webhook handling idempotent, and processors retry for
   * days. Stripe will deliver the same `payment_intent.succeeded` again if
   * our answer was slow, and settling it twice pays an invoice twice and
   * writes two ledger transactions that both look deliberate.
   */
  eventId: string;
  kind: PaymentEventKind;
  /** The processor's raw event name, kept for the log and for triage. */
  type: string;
  intentId: string | null;
  amountMinor: number | null;
  currency: string | null;
  /**
   * What the processor kept. Null when it has not told us yet.
   *
   * Null and zero are different answers and conflating them is how a company
   * reports card revenue it never received. Stripe reports the fee on the
   * balance transaction, which does not always exist at the moment the
   * payment succeeds.
   */
  feeMinor: number | null;
  /** Cumulative amount refunded on this payment, where the event says. */
  refundedMinor: number | null;
  /**
   * The individual refunds this event names, each with the processor's own
   * id. A refund event IS one; a charge event lists them only when the
   * account's API version includes them. Empty when the event says nothing
   * about individual refunds, and then `refundedMinor` is all there is.
   *
   * The id is what keeps a refund from being posted twice. Stripe reports one
   * refund as `refund.created`, `refund.updated` and `charge.refunded`, three
   * events with three event ids, and the event id alone would book it three
   * times.
   */
  refunds?: PaymentRefund[] | undefined;
  /** When the processor says the event happened. */
  occurredAt?: Date | null | undefined;
  /** Whatever we attached at charge time. */
  metadata: Record<string, string>;
  /** For a failure, the processor's reason, written for a person. */
  failureMessage: string | null;
  /**
   * How the customer paid, in the processor's words, when the event says:
   * `card`, `us_bank_account`. Null when it does not. Used to book a bank
   * payment as one even when it was chosen in the processor's own form.
   */
  methodType?: string | null | undefined;
}

export interface PaymentRefund {
  refundId: string;
  amountMinor: number;
  /** When the refund was made, which is the date its posting carries. */
  createdAt: Date | null;
  /** The processor's status. Only `succeeded` has moved any money. */
  status: string | null;
}

/**
 * SAVING A CARD, as a processor does it.
 *
 * The card details go from the customer's browser to the processor and never
 * through this server. What crosses this seam is references: the processor's
 * id for the customer, for the setup the browser completes, and for the card
 * it ends up holding. A processor that cannot hold cards simply has no vault,
 * and the portal offers no "save a card" to its customers.
 */
export type VaultOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface SavedCardDetails {
  /** The processor's id for the card. The only thing a later charge needs. */
  ref: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/** A bank account the processor holds, as much of it as a customer needs to recognise it. */
export interface SavedBankAccountDetails {
  ref: string;
  bankName: string | null;
  last4: string | null;
}

export interface CardSetup {
  setupId: string;
  /** The processor's word for where it is. Only `succeeded` means a card is saved. */
  status: string;
  /** The customer the setup was made for, as the processor reports it. */
  customerRef: string | null;
  card: SavedCardDetails | null;
  /** Present instead of `card` when what was saved is a bank account. */
  bankAccount?: SavedBankAccountDetails | null | undefined;
  metadata: Record<string, string>;
}

export interface CardVault {
  /** A record of this customer at the processor, for cards to be saved against. */
  createCustomer(request: {
    idempotencyKey: string;
    email?: string | undefined;
    name?: string | undefined;
    metadata?: Record<string, string> | undefined;
  }): Promise<VaultOutcome<{ customerRef: string }>>;
  /** Start saving a card: what the browser needs to collect it. */
  startSetup(request: {
    customerRef: string;
    idempotencyKey: string;
    metadata?: Record<string, string> | undefined;
    /**
     * A card, or a bank account verified on the spot by signing in to the
     * bank in the processor's own window. Never by micro deposits: a
     * verification that takes two days and a second visit is one most
     * customers never finish. Card when absent.
     */
    kind?: "card" | "bank_account" | undefined;
  }): Promise<VaultOutcome<{ setupId: string; clientSecret: string }>>;
  /** What became of a setup, read from the processor rather than believed from a browser. */
  readSetup(setupId: string): Promise<VaultOutcome<CardSetup>>;
  /** Tell the processor to forget a card. */
  detach(cardRef: string, idempotencyKey: string): Promise<VaultOutcome<{ detached: true }>>;
}

export interface PaymentProvider {
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeOutcome>;
  /** Present when the processor can keep a card for later. */
  readonly cards?: CardVault | undefined;
  refund(request: RefundRequest): Promise<RefundOutcome>;
  /**
   * Whether this request genuinely came from the processor.
   *
   * Not optional, and not a boolean flag somebody can turn off in settings.
   * An unverified payments webhook is an endpoint where anybody on the
   * internet can declare an invoice paid. There is no rate limit, no fraud
   * screen and no reconciliation step that catches that, because the forged
   * event says the money arrived and every system downstream believes it: the
   * invoice closes, the job moves to paid, the ledger balances, the customer
   * is never chased, and the first person to notice is a bookkeeper in a
   * different quarter.
   */
  verify(request: WebhookRequest, secret: string): boolean;
  parseEvent(request: WebhookRequest): PaymentEvent | null;
  /**
   * The key the browser or field app needs to complete a charge.
   *
   * Publishable by definition and never the secret key. It is exposed
   * because the alternative is an operator pasting it into a second settings
   * field that has to agree with the first one, and two credentials that must
   * match with nothing making them match is how a payment form ends up
   * talking to the wrong account.
   */
  readonly publishableKey: string | null;
}

export class PaymentProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No payment provider configured for "${provider}"`);
    this.name = "PaymentProviderNotConfiguredError";
  }
}

/**
 * Providers are registered rather than imported.
 *
 * A self hoster whose merchant account is with someone else should not have
 * to edit a switch statement in the middle of the charge path, and a build
 * that imports every processor pulls every processor's dependencies into a
 * deployment that uses one.
 */
const registry = new Map<
  string,
  (settings: Record<string, unknown>, secret: string) => PaymentProvider
>();

export function registerPaymentProvider(
  name: string,
  factory: (settings: Record<string, unknown>, secret: string) => PaymentProvider,
): void {
  registry.set(name, factory);
}

export function createPaymentProvider(
  name: string,
  settings: Record<string, unknown>,
  secret: string,
): PaymentProvider {
  const factory = registry.get(name);
  if (!factory) throw new PaymentProviderNotConfiguredError(name);
  // Never a stored endpoint override: see `adapterSettings`.
  return factory(adapterSettings(name, settings), secret);
}

export const registeredPaymentProviders = (): string[] => [...registry.keys()];
