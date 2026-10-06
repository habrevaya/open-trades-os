/**
 * CHECKING A WEBHOOK CAME FROM YOUR INSTANCE
 *
 * Every delivery carries three headers that matter here:
 *
 *   x-otos-timestamp   milliseconds since the epoch, when it was signed
 *   x-otos-signature   hex HMAC-SHA256 of `${timestamp}.${body}` with the
 *                      endpoint's secret; during a secret rotation's overlap,
 *                      two of them separated by a comma, newest first
 *   x-otos-delivery    stable across retries and replays of one event to one
 *                      endpoint, for deduplicating
 *
 * Verify against the RAW body, exactly as it arrived. A body parsed and
 * serialised again is a different string and will not match, which is the
 * single most common reason a correct secret "fails".
 *
 * Written against Web Crypto rather than `node:crypto`, so the same function
 * runs in Node, in Deno, on an edge runtime and in a worker.
 */

export const SIGNATURE_HEADER = "x-otos-signature";
export const TIMESTAMP_HEADER = "x-otos-timestamp";
export const DELIVERY_HEADER = "x-otos-delivery";
export const EVENT_HEADER = "x-otos-event";

/** Five minutes either way, the same window the server signs for. */
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/** What a delivery's body is. */
export interface WebhookEvent {
  id: string;
  name: string;
  sequence: number;
  occurredAt: string;
  organizationId: string;
  entity: { type: string; id: string | null };
  payload: Record<string, unknown>;
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const record = headers as Record<string, string | string[] | undefined>;
  const found = Object.entries(record).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(found) ? (found[0] ?? null) : (found ?? null);
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Every character compared, whatever the first difference. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface VerifyInput {
  /**
   * The endpoint's signing secret, or both of them while you move from one
   * to the other after a rotation. A delivery is accepted when any secret
   * matches any signature in the header.
   */
  secret: string | readonly string[];
  /** The raw request body, as a string, exactly as it arrived. */
  body: string;
  headers: HeaderSource;
  toleranceMs?: number;
  /** For tests. Milliseconds since the epoch. */
  now?: number;
}

/**
 * Verify a delivery and return its event. Throws `WebhookVerificationError`
 * saying which check failed: a missing header, a timestamp outside the
 * window, or no signature matching.
 */
export async function verifyWebhook(input: VerifyInput): Promise<WebhookEvent> {
  const timestamp = header(input.headers, TIMESTAMP_HEADER);
  const signatures = header(input.headers, SIGNATURE_HEADER);
  if (!timestamp || !signatures) {
    throw new WebhookVerificationError(`The ${TIMESTAMP_HEADER} and ${SIGNATURE_HEADER} headers are both required.`);
  }
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) throw new WebhookVerificationError("The timestamp is not a number.");
  const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  if (Math.abs((input.now ?? Date.now()) - sentAt) > tolerance) {
    /**
     * Refused even when the signature is right, because the timestamp is
     * inside what was signed: an old delivery replayed by somebody who
     * captured it is exactly a correct signature with an old timestamp.
     */
    throw new WebhookVerificationError("The delivery is too old or too far in the future. It may be a replay.");
  }

  const secrets = typeof input.secret === "string" ? [input.secret] : [...input.secret];
  const presented = signatures.split(",").map((s) => s.trim()).filter((s) => s !== "");
  let matched = false;
  for (const secret of secrets) {
    const expected = await hmacHex(secret, `${timestamp}.${input.body}`);
    for (const candidate of presented) if (sameString(expected, candidate)) matched = true;
  }
  if (!matched) throw new WebhookVerificationError("No signature matches. Check the secret, and that the body is the raw one.");

  return JSON.parse(input.body) as WebhookEvent;
}
