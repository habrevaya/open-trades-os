import { createHmac } from "node:crypto";
import {
  constantTimeEquals, registerEmailProvider,
  type DeliveryFeedback, type EmailEvent, type EmailProvider,
  type OutboundEmail, type ProviderSecrets, type SendResult, type WebhookRequest,
} from "./provider";

/**
 * RESEND
 *
 * Written against the HTTP API directly rather than the SDK, for the same
 * reason `../comms/twilio.ts` is: the SDK is a dependency and a build step for
 * one endpoint and one signature check, and a self hoster auditing what leaves
 * their network should be able to read the request.
 *
 * Nothing else in the codebase imports this file. It registers itself, and a
 * deployment sending over plain SMTP never loads it.
 */

interface ResendSettings {
  /** Override for testing. Never set in production. */
  baseUrl?: string;
  /**
   * How far out of step a webhook's own timestamp may be, in seconds.
   *
   * Five minutes is Svix's own default. It is not belt and braces: without it
   * a signed request captured from a log or a proxy replays forever, and
   * replaying a hard bounce is how an attacker gets an address suppressed.
   */
  toleranceSeconds?: number;
}

/**
 * Failures worth trying again.
 *
 * Everything else is a decision Resend has made about this message, and
 * retrying it is how a queue fills up with mail to an address their API has
 * already refused.
 */
const RETRYABLE = new Set([
  "rate_limit_exceeded",
  "daily_quota_exceeded", // Lifts at midnight without anybody doing anything.
  "application_error",
  "internal_server_error",
]);

/**
 * Resend's webhook event names, mapped to ours.
 *
 * `email.opened` and `email.clicked` are deliberately absent. An open is a
 * tracking pixel, which Apple Mail Privacy Protection fetches for every
 * message whether or not a human looked at it, so recording one as a fact
 * about a person is recording something we do not know. Nothing in this
 * product reads an open, and an adapter that parsed them would be inventing
 * a column for them.
 */
const EVENTS: Record<string, EmailEvent["type"]> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "deferred",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

/**
 * The Svix signature Resend uses.
 *
 * HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${raw body}`, keyed by the
 * base64 secret that follows the `whsec_` prefix, base64 encoded.
 *
 * Three details here are the difference between a working check and one that
 * always passes.
 *
 * The KEY is the base64 DECODED bytes after the prefix. Using the printable
 * `whsec_...` string as the key produces a signature that never matches, and
 * the usual response to a check that never matches is to stop checking.
 *
 * The BODY is the exact bytes received. Parsing the JSON and re-serializing
 * it changes key order and whitespace and breaks every signature.
 *
 * The header holds a SPACE SEPARATED LIST of `v1,<signature>` pairs, because
 * a secret being rotated means two are valid at once. Matching only the first
 * drops every webhook during a rotation.
 */
export function svixSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64");
}

export function verifySvix(
  secret: string,
  request: WebhookRequest,
  toleranceSeconds: number,
  now: number = Date.now(),
): boolean {
  const id = request.headers["svix-id"];
  const timestamp = request.headers["svix-timestamp"];
  const header = request.headers["svix-signature"];
  if (!id || !timestamp || !header) return false;

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  // Both directions. A timestamp far in the FUTURE is as much a forgery
  // signal as a stale one, and only checking the past half lets an attacker
  // mint something that stays valid for as long as they like.
  if (Math.abs(now / 1000 - sent) > toleranceSeconds) return false;

  const expected = svixSignature(secret, id, timestamp, request.body);

  for (const part of header.split(" ")) {
    const [version, signature] = part.split(",");
    if (version !== "v1" || !signature) continue;
    if (constantTimeEquals(signature, expected)) return true;
  }
  return false;
}

/** The tag we ask Resend to carry so a callback can name our own message. */
const REFERENCE_TAG = "reference";

function referenceFrom(data: Record<string, unknown>): string | undefined {
  const tags = data["tags"];
  if (!Array.isArray(tags)) return undefined;
  for (const tag of tags) {
    if (tag && typeof tag === "object") {
      const record = tag as Record<string, unknown>;
      if (record["name"] === REFERENCE_TAG && typeof record["value"] === "string") {
        return record["value"];
      }
    }
  }
  return undefined;
}

/**
 * Whether a bounce is permanent.
 *
 * Resend reports a bounce subtype, and the three that matter are theirs
 * rather than ours. Anything unrecognized is treated as NOT permanent, which
 * is the safe direction: a soft bounce wrongly called hard writes a
 * suppression, and a suppression is a customer this company can no longer
 * email until somebody notices and lifts it by hand.
 */
function isPermanentBounce(data: Record<string, unknown>): boolean {
  const bounce = data["bounce"];
  const subType = bounce && typeof bounce === "object"
    ? (bounce as Record<string, unknown>)["subType"]
    : undefined;
  const type = bounce && typeof bounce === "object"
    ? (bounce as Record<string, unknown>)["type"]
    : undefined;
  return type === "Permanent"
    || subType === "General" && type === "Permanent"
    || subType === "NoEmail"
    || subType === "Suppressed";
}

function firstRecipient(data: Record<string, unknown>): string | undefined {
  const to = data["to"];
  if (typeof to === "string") return to;
  if (Array.isArray(to) && typeof to[0] === "string") return to[0];
  return undefined;
}

/**
 * `secrets.webhookSecret` is the Svix endpoint secret from the Resend
 * dashboard, `whsec_` prefixed, read from the secret store under the name in
 * `settings.webhookSecretRef`. Separate from the API key, which is `apiKey`:
 * they are two different credentials and a deployment can hold one without
 * the other. Without it there is no verification, so there is no webhook.
 *
 * It is never read from `settings`. It used to be, which put a credential
 * that can forge a hard bounce into an ordinary database column.
 */
export function createResendProvider(
  settings: Record<string, unknown>,
  apiKey: string,
  secrets: ProviderSecrets = {},
): EmailProvider {
  const config = settings as unknown as ResendSettings;
  const base = config.baseUrl ?? "https://api.resend.com";
  const webhookSecret = secrets.webhookSecret;
  const tolerance = config.toleranceSeconds ?? 300;

  /**
   * No secret configured means no verification is possible, and an endpoint
   * that cannot verify must not claim it can. Reporting `none` here rather
   * than a `webhook` whose `verify` returns false is the honest shape: the
   * operator sees a sentence telling them what to go and configure, instead
   * of a delivery column that is silently always empty.
   */
  const delivery: DeliveryFeedback = webhookSecret
    ? {
        kind: "webhook",
        verify: (request) => verifySvix(webhookSecret, request, tolerance),
        parse: (request): EmailEvent | null => {
          let payload: unknown;
          try {
            payload = JSON.parse(request.body);
          } catch {
            return null;
          }
          if (!payload || typeof payload !== "object") return null;
          const envelope = payload as Record<string, unknown>;

          const mapped = EVENTS[String(envelope["type"])];
          // An unmapped event is not an error. Resend adds event types, and a
          // webhook that 500s on one it does not know is a webhook the
          // provider eventually disables for being unreliable.
          if (!mapped) return null;

          const data = (envelope["data"] ?? {}) as Record<string, unknown>;
          const providerMessageId = data["email_id"];
          if (typeof providerMessageId !== "string") return null;

          const reference = referenceFrom(data);
          const recipient = firstRecipient(data);

          return {
            providerMessageId,
            ...(reference ? { reference } : {}),
            type: mapped,
            ...(mapped === "bounced" ? { permanent: isPermanentBounce(data) } : {}),
            ...(recipient ? { recipient } : {}),
          };
        },
      }
    : {
        kind: "none",
        because:
          "No webhook signing secret is configured for this Resend connection, so a delivery "
          + "callback could not be told apart from anyone on the internet posting to the same URL. "
          + "Put the endpoint secret from the Resend dashboard in your secret store and give the "
          + "connection its name as the webhook signing secret to turn delivery reporting on.",
      };

  return {
    name: "resend",
    delivery,

    async send(message: OutboundEmail): Promise<SendResult> {
      const response = await fetch(`${base}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          /**
           * Resend deduplicates on this for 24 hours. The outbox already
           * claims a row before calling, so a double send needs a process to
           * die in a very specific window; this closes that window at the
           * provider instead of relying on our claim alone.
           */
          "Idempotency-Key": message.reference,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          ...(message.text ? { text: message.text } : {}),
          ...(message.html ? { html: message.html } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          ...(message.headers && Object.keys(message.headers).length > 0
            ? { headers: message.headers }
            : {}),
          /**
           * Base64 in the JSON body, which is how Resend's API takes a file.
           * Its other form is a URL it fetches, and the file here exists only
           * in this database.
           */
          ...(message.attachments && message.attachments.length > 0
            ? {
                attachments: message.attachments.map((file) => ({
                  filename: file.filename,
                  content: file.content.toString("base64"),
                  content_type: file.contentType,
                })),
              }
            : {}),
          /**
           * Our id, carried back on the delivery callback.
           *
           * Best effort, and the service does not depend on it: a callback
           * that arrives without a tag is matched on Resend's own id instead.
           * Tag values are restricted to letters, digits, underscores and
           * dashes, which a uuid satisfies, so nothing here needs escaping.
           */
          tags: [{ name: REFERENCE_TAG, value: message.reference }],
        }),
      });

      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;

      if (!response.ok) {
        const code = String(payload["name"] ?? response.status);
        return {
          ok: false,
          code,
          message: String(payload["message"] ?? response.statusText),
          // A 5xx is Resend's problem rather than the message's, whatever
          // name they put on it.
          retryable: RETRYABLE.has(code) || response.status >= 500 || response.status === 429,
        };
      }

      const id = payload["id"];
      if (typeof id !== "string") {
        /**
         * A 2xx with no id is not a success. Returning ok here would store a
         * null provider id on a message marked sent, and every later
         * delivery callback for it would match nothing.
         */
        return {
          ok: false,
          code: "no_message_id",
          message: "Resend accepted the request but returned no message id.",
          retryable: true,
        };
      }
      return { ok: true, providerMessageId: id };
    },
  };
}

registerEmailProvider("resend", createResendProvider);
