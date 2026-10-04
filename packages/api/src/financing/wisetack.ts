import { createHmac, timingSafeEqual } from "node:crypto";
import { financing } from "@opentradesos/core";
import {
  registerFinancingProvider,
  type ApplicationCreated, type ApplicationRequest, type ApplicationState, type FinancingEvent,
  type FinancingOutcome, type FinancingProvider, type WebhookRequest,
} from "./provider";

/**
 * WISETACK
 *
 * The first financing adapter, because Wisetack is built for exactly this: a
 * trades company sends a homeowner a link for an amount, the homeowner applies
 * on Wisetack's page, and Wisetack pays the company when the work is done,
 * less its merchant fee.
 *
 * WHAT HAS AND HAS NOT BEEN CHECKED. This is written to Wisetack's merchant
 * transaction API as its merchant documentation describes it: create a
 * transaction for an amount and get back the link the customer applies on,
 * read a transaction back, and status changes delivered to a callback. It has
 * been exercised against a fake of that API in this repository's tests and
 * NOT against a live Wisetack account, because one needs a signed merchant
 * agreement. A company turning it on should run one application through
 * Wisetack's sandbox (point `baseUrl` at it) before any customer sees a link.
 * Every field name Wisetack uses is in this one file, so a difference found
 * there is a change here and nowhere else.
 *
 * THE WEBHOOK IS VERIFIED AND THEN NOT BELIEVED. A delivery is checked with
 * an HMAC-SHA256 of the raw body under the endpoint's signing secret, and the
 * transaction it names is then read back from Wisetack before anything is
 * recorded (see the seam). So even a mistake in how this file reads a delivery
 * can delay a status, and cannot invent one.
 *
 * "AS LOW AS" IS NOT ASKED OF WISETACK PER CUSTOMER. It is worked out in core
 * from the plans on the company's agreement, which the company enters on the
 * connection. That is a number per estimate without a network call on every
 * page view, and a figure that is exactly as right as the plans entered.
 */

interface WisetackSettings {
  merchantId?: string;
  plans?: string[];
  minAmount?: string;
  maxAmount?: string;
  /** Override for the sandbox or a test fake. */
  baseUrl?: string;
}

const API = "https://api.wisetack.com/v1";

/** The header the signature arrives in, lower cased as the route hands headers over. */
export const SIGNATURE_HEADER = "x-wisetack-signature";

/**
 * Wisetack's statuses, in our words.
 *
 * Several of theirs are one of ours: a customer who has accepted the loan
 * terms and one who has confirmed them are both "approved" to the office, and
 * the difference shows as the chosen offer. A status not listed here is
 * treated as the least advanced one, so an unknown word can never move an
 * application forward, and it is kept as written for whoever reads the log.
 */
const STATUS: Record<string, financing.ApplicationStatus> = {
  PENDING: "sent",
  INITIATED: "applied",
  ACTIONS_REQUIRED: "applied",
  AUTHORIZED: "approved",
  LOAN_TERMS_ACCEPTED: "approved",
  CONFIRMED: "approved",
  SETTLED: "funded",
  DECLINED: "declined",
  EXPIRED: "expired",
  CANCELED: "cancelled",
  CANCELLED: "cancelled",
  /** Money went back after funding. `financing.advance` keeps the payment and flags it. */
  REFUNDED: "cancelled",
};

export const statusOf = (raw: string | null | undefined): financing.ApplicationStatus | null =>
  raw ? STATUS[raw.trim().toUpperCase()] ?? null : null;

/** "1234.56" or 1234.56 to cents, without a float multiplication. */
function centsOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole = "0", frac = ""] = text.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

const dollars = (minor: number): string => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

function dateOf(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function verifyWisetackSignature(request: WebhookRequest, secret: string): boolean {
  const header = request.headers[SIGNATURE_HEADER];
  if (!header || !secret) return false;
  const given = header.trim().replace(/^sha256=/i, "");
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac("sha256", secret).update(request.body, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(given.toLowerCase(), "utf8"), Buffer.from(expected, "utf8"));
}

/** Who to call this, and the plans to quote from, read off the connection. */
export function termsFrom(settings: WisetackSettings): financing.FinancingTerms {
  const plans = (settings.plans ?? [])
    .map((text) => financing.parsePlan(text))
    .filter((plan): plan is financing.FinancingPlan => plan !== null);
  const amount = (value: unknown) =>
    typeof value === "string" && /^\d+(\.\d{1,4})?$/.test(value.trim()) ? value.trim() : null;
  return { lender: "Wisetack", minAmount: amount(settings.minAmount), maxAmount: amount(settings.maxAmount), plans };
}

export function wisetackProvider(rawSettings: Record<string, unknown>, token: string): FinancingProvider {
  const settings = rawSettings as WisetackSettings;
  const base = (settings.baseUrl ?? API).replace(/\/$/, "");
  const merchant = encodeURIComponent(settings.merchantId ?? "");

  async function call(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<
    { ok: true; json: Record<string, unknown> } | { ok: false; code: string; message: string; retryable: boolean }
  > {
    if (!settings.merchantId) {
      return { ok: false, code: "no_merchant", message: "The Wisetack connection has no merchant id.", retryable: false };
    }
    let response: Response;
    try {
      response = await fetch(`${base}/merchants/${merchant}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return {
        ok: false, code: "network",
        message: `Wisetack could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    }
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* a non JSON error page */ }
    if (!response.ok) {
      const message = typeof json["message"] === "string" ? json["message"]
        : typeof json["error"] === "string" ? json["error"] : `Wisetack answered ${response.status}.`;
      return {
        ok: false, code: `http_${response.status}`, message,
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    return { ok: true, json };
  }

  function stateFrom(json: Record<string, unknown>, fallbackId: string): ApplicationState {
    const raw = typeof json["status"] === "string" ? json["status"] : "";
    const terms = (json["loanTerms"] ?? json["selectedLoanOffer"]) as Record<string, unknown> | undefined;
    const months = Number(terms?.["termLength"] ?? terms?.["months"]);
    const apr = terms?.["apr"] ?? terms?.["aprPercent"];
    return {
      externalId: typeof json["transactionId"] === "string" ? json["transactionId"] : fallbackId,
      status: statusOf(raw) ?? "sent",
      rawStatus: raw,
      approvedAmountMinor: centsOf(json["approvedLoanAmount"]),
      chosenOffer: terms && Number.isInteger(months) && months > 0 && apr !== undefined
        ? { months, aprPercent: String(apr), monthlyPaymentMinor: centsOf(terms["monthlyPayment"]) }
        : null,
      fundedAmountMinor: centsOf(json["settledLoanAmount"] ?? json["settledAmount"]),
      feeMinor: centsOf(json["processingFee"] ?? json["merchantFee"]),
      fundedAt: dateOf(json["settledDate"] ?? json["settledAt"]),
      expiresAt: dateOf(json["expirationDate"]),
    };
  }

  return {
    name: "wisetack",

    terms: () => termsFrom(settings),

    async createApplication(request: ApplicationRequest): Promise<FinancingOutcome<ApplicationCreated>> {
      const result = await call("POST", "/transactions", {
        transactionAmount: dollars(request.amountMinor),
        purchaseId: request.reference,
        transactionPurpose: request.purpose.slice(0, 200),
        ...(request.customer.firstName ? { firstName: request.customer.firstName } : {}),
        ...(request.customer.lastName ? { lastName: request.customer.lastName } : {}),
        ...(request.customer.phone ? { mobileNumber: request.customer.phone } : {}),
        ...(request.customer.email ? { email: request.customer.email } : {}),
        ...(request.callbackUrl ? { callbackURL: request.callbackUrl } : {}),
      }, request.idempotencyKey);
      if (!result.ok) return result;
      const id = result.json["transactionId"];
      const link = result.json["paymentLink"];
      if (typeof id !== "string" || typeof link !== "string") {
        return { ok: false, code: "malformed", message: "Wisetack answered without a transaction id or a link.", retryable: false };
      }
      return {
        ok: true,
        value: {
          externalId: id,
          applicationUrl: link,
          status: statusOf(typeof result.json["status"] === "string" ? result.json["status"] : null) ?? "sent",
          expiresAt: dateOf(result.json["expirationDate"]),
        },
      };
    },

    async readApplication(externalId: string): Promise<FinancingOutcome<ApplicationState>> {
      const result = await call("GET", `/transactions/${encodeURIComponent(externalId)}`);
      if (!result.ok) return result;
      return { ok: true, value: stateFrom(result.json, externalId) };
    },

    verify: verifyWisetackSignature,

    parseEvent(request: WebhookRequest): FinancingEvent | null {
      let json: Record<string, unknown>;
      try { json = JSON.parse(request.body) as Record<string, unknown>; } catch { return null; }
      const externalId = json["transactionId"];
      const eventId = json["messageId"] ?? json["eventId"];
      if (typeof externalId !== "string" || typeof eventId !== "string") return null;
      const raw = typeof json["changedStatus"] === "string" ? json["changedStatus"]
        : typeof json["status"] === "string" ? json["status"] : null;
      return {
        eventId,
        externalId,
        type: typeof json["eventType"] === "string" ? json["eventType"] : (raw ?? "status"),
        reportedStatus: statusOf(raw),
        reference: typeof json["purchaseId"] === "string" ? json["purchaseId"] : null,
      };
    },
  };
}

registerFinancingProvider("wisetack", wisetackProvider);
