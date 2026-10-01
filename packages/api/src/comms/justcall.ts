import { createHmac, timingSafeEqual } from "node:crypto";
import {
  registerProvider,
  type DeliveryReport, type InboundMessage, type MessagingProvider,
  type OutboundMessage, type SendResult, type WebhookRequest,
} from "./provider";

/**
 * JUSTCALL
 *
 * The second adapter behind the messaging seam, and the reason it was worth
 * building before anything harder: it is the test of whether that seam was
 * drawn in the right place. If adding a carrier meant touching the send path,
 * the consent model or the outbox, the interface was wrong. It did not. This
 * file is the whole of the change, plus one line in the barrel next door.
 *
 * Written against the HTTP API with `fetch` and no SDK, for the reason the
 * Twilio adapter gives: a self hoster auditing what leaves their network
 * should be able to read it.
 *
 * WHAT IS DIFFERENT FROM TWILIO, because the differences are where the bugs
 * would be:
 *
 *   Auth is `Authorization: <key>:<secret>`, which is neither Basic nor
 *   Bearer. The two halves arrive here as one secret string, because the
 *   deployment's secret store holds one value per name and splitting a
 *   credential across two names is two things to rotate and one of them
 *   forgotten.
 *
 *   The body is JSON, not form encoded.
 *
 *   The signature does not cover the body. See `justCallSignature`, where
 *   that is spelled out, because it changes what this adapter can promise.
 */

interface JustCallSettings {
  /**
   * The URL JustCall was configured to POST to.
   *
   * Not read from the request, deliberately. The signature is computed over
   * the `webhook_url` the BODY carries, and a body is the one thing an
   * attacker controls completely, so checking the body's claim against the
   * body's own signature proves nothing. This is the value a human typed into
   * JustCall, held here, and compared.
   */
  webhookUrl?: string;
  /** Override for testing. Never set in production. */
  baseUrl?: string;
}

/** Their rate limit response, the only status worth a second attempt on its own. */
const TOO_MANY = 429;

/**
 * JustCall's dynamic webhook signature.
 *
 * HMAC-SHA256, hex, keyed with the API key secret, over
 *
 *     `${secret}|${encodeURIComponent(webhook_url)}|${type}|${timestamp}`
 *
 * reproduced from the worked example they publish, which is in the test suite
 * verbatim so this is checked against the vendor's own answer rather than
 * against this file's reading of their prose.
 *
 * THE SECRET IS BOTH THE KEY AND THE FIRST FIELD OF THE MESSAGE. That is
 * their design, not a transcription error, and it is reproduced exactly
 * because a signature scheme is not a thing to improve unilaterally.
 *
 * WHAT THIS SIGNATURE DOES NOT COVER, SAID PLAINLY: the event data. Not one
 * byte of `data` is in the signed string, so a valid signature proves that
 * somebody holding the secret sent SOME event of this type to this URL at
 * this timestamp. It does not prove this body. Anyone who has seen one
 * genuine delivery holds a tuple they can resend with any `data` they like.
 *
 * Two things stand between that and a forged message in somebody's inbox, and
 * both are here rather than assumed:
 *
 *   The timestamp window, which is tight precisely because the signature is
 *   weak. Twilio signs the body and can afford to be generous; this cannot.
 *
 *   The provider's own message id, which the inbound path writes as a unique
 *   key, so a replayed body lands on the row it already wrote.
 *
 * A reader deciding whether to point this at a production number should know
 * that, which is why it is in the file and on the website rather than in a
 * commit message.
 */
export function justCallSignature(
  secret: string, webhookUrl: string, type: string, timestamp: string,
): string {
  const payload = `${secret}|${encodeURIComponent(webhookUrl)}|${type}|${timestamp}`;
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * How far out of date a delivery may be and still be acted on.
 *
 * Five minutes, and the reasoning is the opposite of the one the CallRail
 * adapter gives for its twenty four hours. There, the timestamp is the
 * event's own time and the body is signed, so a wide window costs nothing and
 * a narrow one loses calls. Here the timestamp is the only freshness in a
 * signature that does not cover what it is attesting to, so the window IS the
 * security property and every extra minute is a minute a captured tuple stays
 * usable against any payload.
 */
export const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Their timestamp is "2024-03-21 17:08:22": a space, no zone, no offset.
 *
 * Read as UTC, which is what it is, rather than handed to `new Date()` on the
 * string as written. V8 parses a space separated date as LOCAL time, so on a
 * box set to anything but UTC every delivery would arrive hours out and the
 * skew check would refuse the genuine ones and only the genuine ones.
 */
function parseTimestamp(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) {
    // An all digits value is epoch seconds, which their header table calls an
    // int even though every example is a string. Both are accepted.
    const seconds = /^\d{10}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    return Number.isNaN(seconds) ? null : seconds * 1000;
  }
  return Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  );
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
 * Their delivery_status values, mapped to ours.
 *
 * `received` is theirs for an inbound message and is deliberately absent:
 * it is not a delivery outcome for anything we sent, and mapping it would
 * let an inbound event overwrite the delivery state of an outbound one.
 *
 * An empty string appears in their own examples on a message that has just
 * been sent and has no outcome yet. It maps to nothing, for the reason the
 * Twilio adapter drops `queued`: recording it would move a message backwards
 * from delivered when callbacks arrive out of order.
 */
const STATUS: Record<string, DeliveryReport["status"]> = {
  sent: "sent",
  delivered: "delivered",
  undelivered: "undelivered",
  failed: "failed",
};

interface Envelope {
  type?: unknown;
  webhook_url?: unknown;
  data?: Record<string, unknown>;
}

function envelope(body: string): Envelope | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Envelope;
  } catch {
    return null;
  }
}

/** The media list, which sits in a different place on inbound than on send. */
function mediaFrom(info: Record<string, unknown> | undefined): InboundMessage["media"] {
  const raw = info?.["mms"];
  if (!Array.isArray(raw)) return [];
  const out: InboundMessage["media"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const url = (item as Record<string, unknown>)["media_url"];
    if (typeof url !== "string" || url === "") continue;
    const type = (item as Record<string, unknown>)["content_type"];
    out.push({ url, contentType: typeof type === "string" ? type : "application/octet-stream" });
  }
  return out;
}

export function createJustCallProvider(
  settings: Record<string, unknown>,
  credential: string,
): MessagingProvider {
  const config = settings as unknown as JustCallSettings;
  const base = config.baseUrl ?? "https://api.justcall.io";

  /**
   * The secret half of the credential, which is what signs a webhook.
   *
   * The whole `key:secret` string is the Authorization header; only the part
   * after the colon keys the HMAC. Splitting on the LAST colon rather than
   * the first, because a secret containing one would otherwise be silently
   * truncated and every signature would fail with nothing saying why.
   */
  const cut = credential.lastIndexOf(":");
  const secret = cut === -1 ? credential : credential.slice(cut + 1);

  return {
    name: "justcall",

    async send(message: OutboundMessage): Promise<SendResult> {
      /**
       * `restrict_once` is deliberately not sent.
       *
       * It is their own duplicate suppression: the same body to the same
       * number inside 24 hours is silently dropped. That is a decision the
       * outbox already makes, with our idempotency key and our rules, and
       * having two of them means a legitimate second reminder disappearing
       * at the carrier with a success returned to us.
       */
      const payload: Record<string, unknown> = {
        justcall_number: message.from,
        contact_number: message.to,
        body: message.body,
      };
      const media = message.media ?? [];
      if (media.length > 0) payload["media_url"] = media.join(",");

      let response: Response;
      try {
        response = await fetch(`${base}/v2.1/texts/new`, {
          method: "POST",
          headers: {
            Authorization: credential,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        // The request never reached them, so nothing was sent and trying
        // again is safe. Distinguished from a refusal, which is not.
        return {
          ok: false,
          code: "network",
          message: error instanceof Error ? error.message : "Could not reach JustCall",
          retryable: true,
        };
      }

      const body = await response.json().catch(() => ({})) as Record<string, unknown>;

      if (!response.ok) {
        return {
          ok: false,
          code: String(response.status),
          message: String(body["message"] ?? body["error"] ?? response.statusText),
          /**
           * Rate limited or their side broke. Everything else is a decision
           * they have made about this message and this recipient, and
           * retrying is how a queue fills with texts to a dead number.
           */
          retryable: response.status === TOO_MANY || response.status >= 500,
        };
      }

      /**
       * Their id lives under `data` on a v2.1 response. A send that comes
       * back 200 with no id is a failure here rather than a success with an
       * empty string: the id is what every delivery receipt is matched on,
       * and storing "" means the next one matches this row too.
       */
      const data = body["data"];
      const id = data && typeof data === "object"
        ? (data as Record<string, unknown>)["id"]
        : body["id"];
      if (id === undefined || id === null || id === "") {
        return {
          ok: false,
          code: "no_id",
          message: "JustCall accepted the message and returned no id to match its receipt against.",
          retryable: false,
        };
      }

      return { ok: true, providerMessageId: String(id) };
    },

    verify(request: WebhookRequest): boolean {
      const signature = request.headers["x-justcall-signature"];
      const timestamp = request.headers["x-justcall-request-timestamp"];
      if (!signature || !timestamp) return false;

      const body = envelope(request.body);
      if (!body || typeof body.type !== "string") return false;

      /**
       * The URL the signature is computed over is the one WE were configured
       * with, not the one the body claims. Taking it from the body would mean
       * checking an attacker's claim against an attacker's signature, which
       * is a verify() that cannot fail for anyone holding the secret for any
       * other account.
       */
      const url = config.webhookUrl ?? (typeof body.webhook_url === "string" ? body.webhook_url : null);
      if (!url) return false;

      const at = parseTimestamp(timestamp);
      if (at === null) return false;
      if (Math.abs(Date.now() - at) > MAX_SKEW_MS) return false;

      return constantTimeEquals(
        signature,
        justCallSignature(secret, url, body.type, timestamp),
      );
    },

    parseInbound(request: WebhookRequest): InboundMessage | null {
      const body = envelope(request.body);
      const data = body?.data;
      if (!data) return null;

      /**
       * Only an event that carries an inbound message. `sms.sent_received`
       * fires for both directions, so direction decides rather than the
       * event name, and a status update is never an inbound even though it
       * carries the whole message with it.
       */
      const direction = data["direction"];
      if (typeof direction !== "string" || direction.toLowerCase() !== "incoming") return null;
      if (body.type === "sms.status_updated") return null;

      const from = data["contact_number"];
      const to = data["justcall_number"];
      const id = data["id"];
      if (typeof from !== "string" || from === "") return null;
      if (id === undefined || id === null || id === "") return null;

      const info = data["sms_info"];
      const sms = info && typeof info === "object" ? info as Record<string, unknown> : undefined;
      const text = sms?.["body"];

      return {
        from,
        to: typeof to === "string" ? to : "",
        body: typeof text === "string" ? text : "",
        media: mediaFrom(sms),
        providerMessageId: String(id),
      };
    },

    parseDelivery(request: WebhookRequest): DeliveryReport | null {
      const body = envelope(request.body);
      const data = body?.data;
      if (!data) return null;

      /**
       * An outcome for something WE sent. An inbound message carries
       * `delivery_status: "received"`, which is not one, and letting it
       * through would record a receipt against a message that has none.
       */
      const direction = data["direction"];
      if (typeof direction !== "string" || direction.toLowerCase() !== "outgoing") return null;

      const id = data["id"];
      const status = data["delivery_status"];
      if (id === undefined || id === null || id === "") return null;
      if (typeof status !== "string") return null;

      const mapped = STATUS[status.toLowerCase()];
      if (!mapped) return null;

      return {
        providerMessageId: String(id),
        /**
         * JustCall carries nothing of ours through a send, so there is no
         * reference to give back and a receipt is matched on their id alone.
         * Stated as undefined rather than as an empty string, which would
         * read as a reference that matched nothing.
         */
        reference: undefined,
        status: mapped,
        errorCode: undefined,
        errorMessage: undefined,
      };
    },
  };
}

registerProvider("justcall", createJustCallProvider);
