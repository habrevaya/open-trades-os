import { createHmac, timingSafeEqual } from "node:crypto";
import {
  registerProvider,
  type DeliveryReport, type InboundMessage, type MessagingProvider,
  type OutboundMessage, type SendResult, type WebhookRequest,
} from "./provider";

/**
 * TWILIO
 *
 * The first adapter, because it is what most companies of this size already
 * have. Written against the HTTP API directly rather than the SDK: the SDK is
 * a large dependency for four endpoints, and a self hoster auditing what
 * leaves their network should be able to read it.
 *
 * Nothing else in the codebase imports this file. It registers itself, and a
 * deployment that uses a different carrier never loads it.
 */

interface TwilioSettings {
  accountSid: string;
  /** The number or messaging service the account sends from. */
  messagingServiceSid?: string;
  /** Override for testing. Never set in production. */
  baseUrl?: string;
}

/**
 * Twilio's signature: HMAC-SHA1 over the full URL with the POST parameters
 * appended in sorted key order, base64 encoded.
 *
 * Two details in here are the difference between a working check and one that
 * always passes.
 *
 * The URL must be the one Twilio was configured with, including scheme, host
 * and query string. Behind a load balancer the request often arrives as http
 * on an internal hostname, so the caller passes the public URL rather than
 * reconstructing it from headers an attacker can set.
 *
 * The comparison is constant time. A byte-at-a-time string compare leaks the
 * signature through timing, which is a slow but real forgery path.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

function formToObject(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) out[key] = value;
  return out;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // length oracle if it escaped. Different lengths are simply not equal.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Twilio's status names, mapped to ours.
 *
 * `undelivered` and `failed` are different and both are kept: undelivered
 * means the carrier rejected it, which is usually a bad number, and failed
 * means Twilio never got that far. An operator chasing "why did this customer
 * not get their reminder" needs to know which.
 */
const STATUS: Record<string, DeliveryReport["status"]> = {
  sent: "sent",
  delivered: "delivered",
  undelivered: "undelivered",
  failed: "failed",
};

/**
 * Errors worth trying again.
 *
 * Everything else is a decision the carrier has made about this message and
 * this recipient, and retrying is how a queue fills up with texts to a
 * disconnected number.
 */
const RETRYABLE = new Set([
  "20429", // too many requests
  "20003", // authentication, usually a rotated token mid-flight
  "30001", // queue overflow
  "30002", // account suspended, which a human fixes and then the retry works
]);

export function createTwilioProvider(
  settings: Record<string, unknown>,
  authToken: string,
): MessagingProvider {
  const config = settings as unknown as TwilioSettings;
  const base = config.baseUrl ?? "https://api.twilio.com";

  return {
    name: "twilio",

    async send(message: OutboundMessage): Promise<SendResult> {
      const form = new URLSearchParams({
        To: message.to,
        Body: message.body,
        ...(config.messagingServiceSid
          ? { MessagingServiceSid: config.messagingServiceSid }
          : { From: message.from }),
      });
      for (const url of message.media ?? []) form.append("MediaUrl", url);

      const response = await fetch(
        `${base}/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.accountSid}:${authToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
            /**
             * Our id, echoed back on every status callback. Without it a
             * delivery receipt has to be matched on the provider's id alone,
             * which is not written until the send returns: a callback that
             * beats the write has nothing to match.
             */
            "I-Twilio-Idempotency-Token": message.reference,
          },
          body: form,
        },
      );

      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;

      if (!response.ok) {
        const code = String(payload["code"] ?? response.status);
        return {
          ok: false,
          code,
          message: String(payload["message"] ?? response.statusText),
          // A 5xx from the API is the carrier's problem, not the message's.
          retryable: RETRYABLE.has(code) || response.status >= 500,
        };
      }

      return { ok: true, providerMessageId: String(payload["sid"]) };
    },

    verify(request: WebhookRequest): boolean {
      const signature = request.headers["x-twilio-signature"];
      if (!signature) return false;
      return constantTimeEquals(
        signature,
        twilioSignature(authToken, request.url, formToObject(request.body)),
      );
    },

    parseInbound(request: WebhookRequest): InboundMessage | null {
      const form = formToObject(request.body);
      if (!form["From"] || !form["MessageSid"]) return null;
      // A status callback posts to a different endpoint but the same shape.
      // `MessageStatus` present and `Body` absent means it is not an inbound.
      if (form["MessageStatus"] && form["Body"] === undefined) return null;

      const count = Number(form["NumMedia"] ?? 0);
      const media: InboundMessage["media"] = [];
      for (let i = 0; i < count; i += 1) {
        const url = form[`MediaUrl${i}`];
        if (url) media.push({ url, contentType: form[`MediaContentType${i}`] ?? "application/octet-stream" });
      }

      return {
        from: form["From"],
        to: form["To"] ?? "",
        body: form["Body"] ?? "",
        media,
        providerMessageId: form["MessageSid"],
      };
    },

    parseDelivery(request: WebhookRequest): DeliveryReport | null {
      const form = formToObject(request.body);
      const status = form["MessageStatus"] ?? form["SmsStatus"];
      if (!form["MessageSid"] || !status) return null;
      const mapped = STATUS[status];
      // `queued`, `sending` and `accepted` are Twilio telling us it is still
      // working. Recording those would move a message backwards from
      // delivered to sending when callbacks arrive out of order.
      if (!mapped) return null;

      return {
        providerMessageId: form["MessageSid"],
        reference: form["IdempotencyToken"],
        status: mapped,
        errorCode: form["ErrorCode"],
        errorMessage: form["ErrorMessage"],
      };
    },
  };
}

registerProvider("twilio", createTwilioProvider);
