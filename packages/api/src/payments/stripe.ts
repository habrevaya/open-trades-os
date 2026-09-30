import { createHmac, timingSafeEqual } from "node:crypto";
import {
  registerPaymentProvider,
  type ChargeOutcome, type ChargeRequest, type PaymentEvent, type PaymentEventKind,
  type PaymentProvider, type RefundOutcome, type RefundRequest, type WebhookRequest,
} from "./provider";

/**
 * STRIPE
 *
 * The first payments adapter, because it is what a company this size can get
 * a merchant account with on a Tuesday afternoon without a sales call.
 *
 * Written against the HTTP API directly rather than the SDK, for the reasons
 * the Twilio adapter gives and one more that is specific to money. The SDK is
 * a large dependency for four endpoints; a self hoster auditing what leaves
 * their network should be able to read the request; and a payments library
 * that updates itself is a payments library that can change what it sends on
 * a patch release. Nothing else in the codebase imports this file. It
 * registers itself, and a deployment using a different processor never loads
 * it.
 *
 * THE KEY IS A RESTRICTED KEY, supplied by the operator.
 *
 * Stripe lets an account holder mint a key limited to particular resources.
 * The setup note in the connector catalogue asks for one scoped to payment
 * intents, charges and refunds, which is everything this file does and
 * nothing else. It is worth asking for: a full secret key on a self hosted
 * box can move the operator's payouts and read every customer they have,
 * where a restricted one cannot, and the difference costs them thirty
 * seconds in a dashboard.
 */

interface StripeSettings {
  /** Sent to the browser to mount a payment form. Never the secret key. */
  publishableKey?: string;
  /** Override for testing. Never set in production. */
  baseUrl?: string;
}

const API = "https://api.stripe.com/v1";

/**
 * Stripe's API is form encoded, including for nested objects, which it
 * expresses as `a[b]=c` and `a[0]=b`.
 *
 * Written out rather than pulled in, because the encoding is the only part of
 * this that a library would be doing and it is fifteen lines. Arrays matter:
 * `expand[0]=latest_charge.balance_transaction` is how the processing fee is
 * obtained in the same round trip, and getting the bracket syntax wrong
 * returns a 200 with the field silently absent.
 */
function form(values: Record<string, unknown>, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        parts.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === "object") {
      parts.push(...form(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

export const SIGNATURE_HEADER = "stripe-signature";

/**
 * How far out of date a webhook may be.
 *
 * Five minutes, which is Stripe's own default tolerance. The timestamp is
 * inside the signed payload, so without this window a signature captured once
 * is valid forever: anybody who obtained one `payment_intent.succeeded`
 * delivery could replay it whenever they liked, and every replay would verify
 * correctly. The event id check in `services/payments.ts` stops the replay
 * being ACTED on twice, and this stops it being believed at all. Both,
 * because the first is a database lookup and this is arithmetic.
 */
export const MAX_SKEW_MS = 5 * 60 * 1000;

function matches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Stripe's signature header: `t=1614556800,v1=abc...,v1=def...`
 *
 * Two details here are the difference between a working check and one that
 * always passes.
 *
 * THERE CAN BE SEVERAL `v1` VALUES, during a secret rotation, and the header
 * is valid if ANY of them matches. Parsing it as a flat object keeps the last
 * one and rejects deliveries signed with the other secret, which presents as
 * random webhook failures during the one week somebody is rotating.
 *
 * THE SIGNED PAYLOAD IS `${timestamp}.${rawBody}`. Not the body alone, and
 * not a re-serialized body. `JSON.parse` followed by `JSON.stringify` changes
 * one byte of whitespace somewhere and every signature stops matching, which
 * presents as "the signing secret is wrong" and costs an afternoon.
 */
export function verifyStripeSignature(
  request: WebhookRequest,
  secret: string,
  now: () => number = Date.now,
): boolean {
  const header = request.headers[SIGNATURE_HEADER] ?? request.headers[SIGNATURE_HEADER.toUpperCase()];
  if (!header) return false;

  let timestamp = "";
  const signatures: string[] = [];
  for (const piece of header.split(",")) {
    const separator = piece.indexOf("=");
    if (separator === -1) continue;
    const key = piece.slice(0, separator).trim();
    const value = piece.slice(separator + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) return false;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return false;
  /** Stripe's timestamp is seconds. Comparing it to milliseconds passes every time. */
  if (Math.abs(now() - sentAt * 1000) > MAX_SKEW_MS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${request.body}`)
    .digest("hex");

  return signatures.some((candidate) => matches(expected, candidate));
}

/**
 * Stripe event names to the five things this product does about money.
 *
 * Anything unrecognised becomes `other` rather than being dropped. An account
 * can be sent events nobody here anticipated, and the honest answer is a
 * logged row saying so; guessing which of the four it resembles is how a
 * `charge.failed` gets recorded as a refund.
 */
function kindOf(type: string): PaymentEventKind {
  if (type === "payment_intent.succeeded") return "succeeded";
  if (type === "payment_intent.payment_failed") return "failed";
  if (type === "charge.refunded" || type === "refund.updated") return "refunded";
  if (type.startsWith("charge.dispute.")) return "disputed";
  return "other";
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The fee, which is NOT on the payment intent.
 *
 * Stripe reports what it kept on the balance transaction hanging off the
 * charge, and only once that transaction exists. So this digs for it and
 * returns null when it is absent rather than zero, because zero is a claim
 * that the payment was free and a company that believes it is reporting card
 * revenue it never received.
 */
function feeFrom(object: Record<string, unknown>): number | null {
  const direct = num(object["application_fee_amount"]);
  const charge = asObject(object["latest_charge"]) ?? asObject(object["charge"]);
  const balance = asObject(charge?.["balance_transaction"])
    ?? asObject(object["balance_transaction"]);
  const fee = num(balance?.["fee"]);
  return fee ?? (direct === null ? null : direct);
}

function metadataFrom(object: Record<string, unknown>): Record<string, string> {
  const raw = asObject(object["metadata"]);
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function stripeProvider(settings: StripeSettings, secretKey: string): PaymentProvider {
  const base = settings.baseUrl ?? API;

  async function call(
    path: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        /**
         * Stripe's own idempotency, on top of ours.
         *
         * Ours stops us asking twice. This stops the SECOND ask being
         * charged when the first one's response was lost in the network,
         * which is the failure our side cannot see and cannot recover from.
         */
        "idempotency-key": idempotencyKey,
        "stripe-version": "2024-06-20",
      },
      body: form(body).join("&"),
    });

    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = asObject(JSON.parse(text)) ?? {};
    } catch {
      json = { error: { message: text.slice(0, 500) } };
    }
    return { ok: response.ok, status: response.status, json };
  }

  /**
   * A failure Stripe will answer differently if asked again.
   *
   * 429 and 5xx are the processor's problem and worth another go. A 4xx is
   * ours or the card's, and retrying it is how a declined card becomes four
   * declined cards on a customer's statement and a fraud flag on the
   * merchant account.
   */
  const retryable = (status: number): boolean => status === 429 || status >= 500;

  const failure = (
    status: number, json: Record<string, unknown>,
  ): { ok: false; code: string; message: string; retryable: boolean } => {
    const error = asObject(json["error"]);
    return {
      ok: false,
      code: str(error?.["code"]) ?? str(error?.["type"]) ?? `http_${status}`,
      message: str(error?.["message"]) ?? `Stripe answered ${status}.`,
      retryable: retryable(status),
    };
  };

  return {
    name: "stripe",
    publishableKey: settings.publishableKey ?? null,

    async charge(request: ChargeRequest): Promise<ChargeOutcome> {
      const { ok, status, json } = await call("/payment_intents", {
        amount: request.amountMinor,
        currency: request.currency.toLowerCase(),
        /**
         * Automatic payment methods, so an operator who turns on Apple Pay,
         * Link or bank debit in their own dashboard gets it here without a
         * release. The alternative is this file holding a list of payment
         * method types that has to be kept in step with a dashboard nobody
         * on this side can see.
         */
        automatic_payment_methods: { enabled: true },
        description: request.description,
        receipt_email: request.receiptEmail,
        metadata: request.metadata,
        expand: ["latest_charge.balance_transaction"],
      }, request.idempotencyKey);

      if (!ok) return failure(status, json);

      const intentId = str(json["id"]);
      const clientSecret = str(json["client_secret"]);
      if (!intentId || !clientSecret) {
        /**
         * A 200 with nothing to pay against. Not retryable: asking again
         * with the same idempotency key returns the same useless answer,
         * and asking with a new one risks a second intent for one invoice.
         */
        return {
          ok: false,
          code: "no_client_secret",
          message: "Stripe accepted the charge and returned nothing to pay with.",
          retryable: false,
        };
      }

      return {
        ok: true,
        intent: {
          intentId,
          clientSecret,
          amountMinor: num(json["amount"]) ?? request.amountMinor,
          currency: str(json["currency"]) ?? request.currency,
          status: str(json["status"]) ?? "requires_payment_method",
        },
      };
    },

    async refund(request: RefundRequest): Promise<RefundOutcome> {
      const { ok, status, json } = await call("/refunds", {
        payment_intent: request.intentId,
        amount: request.amountMinor,
        reason: request.reason,
      }, request.idempotencyKey);

      if (!ok) return failure(status, json);

      const refundId = str(json["id"]);
      if (!refundId) {
        return {
          ok: false,
          code: "no_refund_id",
          message: "Stripe accepted the refund and returned no refund to record.",
          retryable: false,
        };
      }

      return {
        ok: true,
        refund: {
          refundId,
          amountMinor: num(json["amount"]) ?? request.amountMinor ?? 0,
          status: str(json["status"]) ?? "pending",
        },
      };
    },

    verify(request: WebhookRequest, secret: string): boolean {
      return verifyStripeSignature(request, secret);
    },

    parseEvent(request: WebhookRequest): PaymentEvent | null {
      let envelope: Record<string, unknown>;
      try {
        envelope = asObject(JSON.parse(request.body)) ?? {};
      } catch {
        return null;
      }

      const eventId = str(envelope["id"]);
      const type = str(envelope["type"]);
      const object = asObject(asObject(envelope["data"])?.["object"]);
      if (!eventId || !type || !object) return null;

      /**
       * A charge event names its intent in `payment_intent`; an intent event
       * IS the intent and names it in `id`. Reading only one of the two makes
       * every refund unmatchable, which shows up as a refund that verified,
       * parsed, logged and changed nothing.
       */
      const intentId = str(object["payment_intent"]) ?? str(object["id"]);

      return {
        eventId,
        kind: kindOf(type),
        type,
        intentId,
        amountMinor: num(object["amount"]) ?? num(object["amount_captured"]),
        currency: str(object["currency"]),
        feeMinor: feeFrom(object),
        refundedMinor: num(object["amount_refunded"]),
        metadata: metadataFrom(object),
        failureMessage:
          str(asObject(object["last_payment_error"])?.["message"])
          ?? str(object["failure_message"]),
      };
    },
  };
}

registerPaymentProvider("stripe", (settings, secret) =>
  stripeProvider(settings as StripeSettings, secret));
