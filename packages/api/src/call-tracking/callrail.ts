import { createHmac, timingSafeEqual } from "node:crypto";
import {
  registerCallTrackingProvider,
  type CallFetch, type CallTrackingProvider, type CredentialCheck,
  type TrackedCall, type WebhookProof, type WebhookRequest,
} from "./provider";

/**
 * CALLRAIL
 *
 * The first call tracking adapter, because it is what a contractor can get
 * on a Tuesday afternoon: an API key is self-serve from the integrations
 * screen on any paid plan, with no sales call, no developer programme and
 * nothing that can be refused.
 *
 * Written against the HTTP API directly with `fetch` and no SDK, for the
 * reasons the Stripe and Twilio adapters give: the SDK is a large dependency
 * for three endpoints, a self hoster auditing what leaves their network
 * should be able to read the request, and a library that updates itself can
 * change what it sends on a patch release. Nothing else in the codebase
 * imports this file. It registers itself under its catalogue key.
 *
 * WHAT IS VERIFIED HERE, AND IT IS WORTH SAYING EXACTLY
 *
 * CallRail DOES sign its webhooks, which is better than the queue assumed
 * when it was written. The published scheme is: a per-company signing key,
 * visible on the Webhooks configuration page and also returned as
 * `signing_key` when a Webhooks integration is created through the API; an
 * HMAC over the RAW request body; SHA-1; base64; delivered in a header the
 * documentation names only as "a Signature header".
 *
 * SHA-1 is weaker than anybody would choose today and it is what they offer.
 * It is not broken for HMAC in the way it is for collision resistance, so
 * this is a real check rather than a decorative one, and the catalogue says
 * which algorithm it is rather than leaving a reader to assume SHA-256.
 *
 * Replay is handled with the `timestamp` field INSIDE the signed body, which
 * is what their documentation points at and is the only workable answer: the
 * body is all that is signed, so a timestamp in a header would be free to
 * change. A captured delivery is therefore valid for the length of the
 * window and no longer.
 *
 * WHAT IS NOT VERIFIED, AND IS CARRIED BY THE TOKEN IN THE URL. The signing
 * key is per company at CallRail and per connection here, so the signature
 * proves the body came from a CallRail account holding that key; it does not
 * prove which of this deployment's tenants it is for. That is the token in
 * the path's job, exactly as with the lead webhook, which is why the route
 * resolves the connection from the token first and checks the signature
 * against THAT connection's secret.
 */

const API = "https://api.callrail.com/v3";

/**
 * The header the signature arrives in.
 *
 * The documentation says only "a Signature header" and names no other. The
 * route lower-cases every header before the adapter sees it, so this matches
 * whatever casing is actually sent. The vendor-prefixed spelling is accepted
 * as well, because a vendor adding its own prefix later is the common way
 * this breaks and accepting both costs nothing: a delivery carrying neither
 * is refused either way, which is the safe direction to be wrong in.
 */
export const SIGNATURE_HEADER = "signature";
const SIGNATURE_HEADER_ALIAS = "x-callrail-signature";

/**
 * How far out of date a delivery may be, and why it is a day rather than
 * the five minutes Stripe uses.
 *
 * CALLRAIL'S TIMESTAMP IS THE EVENT'S OWN TIME, NOT THE MOMENT OF SENDING.
 * Their documentation says the field is "based on the data in the request",
 * and in the worked example they publish, `timestamp` is identical to
 * `start_time`: the second the call began. So it bounds how old the CALL is
 * and says nothing about how long the delivery took.
 *
 * That matters because of two other things they document. The post-call
 * webhook waits for the recording, the transcription and the call summary to
 * attach, with a maximum delay of TWENTY MINUTES after the hangup. And the
 * call itself may have run for an hour before that. A five minute window, or
 * a fifteen minute one, would refuse a perfectly genuine delivery about a
 * long call, and because CallRail does not resend, a refusal is a call the
 * company never gets back.
 *
 * So the window is deliberately coarse, and it is NOT what makes a replay
 * harmless. That is the unique index on the provider's call id: a replayed
 * delivery of a real call updates the row it already wrote and records no
 * second marketing touch, which is asserted. The window is here to stop an
 * ancient captured delivery being injected indefinitely, and a day is a
 * bound that does that without refusing anybody's hour-long Tuesday.
 */
export const MAX_SKEW_MS = 24 * 60 * 60 * 1000;

interface CallRailSettings {
  /** `ACC8154...`, from the URL of their dashboard or from the accounts endpoint. */
  accountId?: string;
  /** Narrows a backfill to one company in a multi-company account. */
  companyId?: string;
  /** Override for testing. Never set in production. */
  baseUrl?: string;
}

function matches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  /**
   * timingSafeEqual throws on a length mismatch, which would itself be a
   * length oracle if it escaped. Different lengths are simply not equal.
   */
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The published scheme, written out rather than described.
 *
 * `Base64(HMAC-SHA1(signing_key, raw_body))`. The RAW body: parsing it to an
 * object and stringifying it back moves one byte of whitespace and every
 * signature stops matching, which presents as "the signing key is wrong" and
 * costs an afternoon.
 */
export function callRailSignature(signingKey: string, body: string): string {
  return createHmac("sha1", signingKey).update(Buffer.from(body, "utf8")).digest("base64");
}

export function verifyCallRailWebhook(
  request: WebhookRequest,
  signingKey: string,
  now: () => number = Date.now,
): boolean {
  const provided = request.headers[SIGNATURE_HEADER] ?? request.headers[SIGNATURE_HEADER_ALIAS];
  if (!provided) return false;
  if (!matches(callRailSignature(signingKey, request.body), provided)) return false;

  /**
   * The timestamp is read only AFTER the signature has been checked, and
   * that order matters: it is a field in attacker-supplied JSON until the
   * HMAC says otherwise, and reading it first would mean parsing untrusted
   * input to decide whether to trust the input.
   */
  let payload: unknown;
  try {
    payload = JSON.parse(request.body);
  } catch {
    /**
     * A correctly signed body that is not JSON. Only reachable if the
     * signing key has leaked or the vendor has changed format, and in both
     * cases refusing is right.
     */
    return false;
  }

  const stamped = asObject(payload)?.["timestamp"];
  /**
   * A signed delivery with no timestamp is ACCEPTED, and that is a decision
   * rather than an oversight. The replay window is a second line of defence
   * behind a secret the attacker does not have; refusing every delivery that
   * omits the field would mean one undocumented shape from the vendor turns
   * a working integration into silence, and silence here is lost calls that
   * nobody can get back because CallRail does not resend.
   */
  if (typeof stamped !== "string") return true;

  const at = Date.parse(stamped);
  if (!Number.isFinite(at)) return true;
  return Math.abs(now() - at) <= MAX_SKEW_MS;
}

const PROOF: WebhookProof = {
  kind: "signature",
  header: SIGNATURE_HEADER,
  secretIs:
    "the signing key on the Webhooks page of the CallRail company this feed belongs to, "
    + "which is also returned as signing_key when a Webhooks integration is created through their API",
  verify: (request, secret, now) => verifyCallRailWebhook(request, secret, now),
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const str = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};

const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
};

const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/**
 * Their call object into ours.
 *
 * THE IDENTITY IS THE ONE PART WORTH LABOURING. CallRail's v3 endpoints
 * return a masked id, `CAL8154...`, and the worked example of a webhook body
 * in their own documentation carries a bare numeric id from their legacy
 * API. A connector that took whichever one turned up would give the same
 * call two different identities depending on whether it arrived by webhook
 * or by backfill, and the operator would end up with two rows for one call
 * and every count of calls in the business quietly too high.
 *
 * So the preference order is fixed here, `resource_id` then `id`, and the
 * service does NOT rely on it alone: it also matches on the natural key of a
 * call, which is the tracking number, the caller's number and the second it
 * started. Two guards because the first one depends on a vendor's choice
 * that this code cannot see.
 */
function toCall(raw: Record<string, unknown>): TrackedCall | null {
  const externalId = str(raw["resource_id"]) ?? str(raw["id"]);
  const trackingNumber = str(raw["tracking_phone_number"]) ?? str(raw["trackingnum"]);
  const customerNumber = str(raw["customer_phone_number"]) ?? str(raw["callernum"]);
  const startedAtRaw = str(raw["start_time"]) ?? str(raw["created_at"]);

  /**
   * ALL FOUR OR NOTHING, and this is what refuses the sibling webhooks.
   *
   * A call with no id cannot be made idempotent, one with no tracking number
   * cannot be attributed to anything, one with no caller cannot be matched
   * to a customer, and one with no start time cannot be placed in a report.
   * The text message and form submission bodies CallRail posts at this same
   * URL each lack three of the four, so they fall out here rather than being
   * half-parsed into a phantom call with no duration and a marketing touch
   * behind it.
   *
   * Returning null rather than throwing makes the endpoint answer 200 and
   * record nothing, which is right for a body that will fail identically on
   * every retry and which they will stop sending if it errors.
   */
  if (!externalId || !trackingNumber || !customerNumber || !startedAtRaw) return null;

  const startedAt = new Date(startedAtRaw);
  if (Number.isNaN(startedAt.getTime())) return null;

  const direction = str(raw["direction"]) === "outbound" ? "outbound" as const : "inbound" as const;

  return {
    externalId,
    direction,
    trackingNumber,
    customerNumber,
    businessNumber: str(raw["business_phone_number"]),
    startedAt,
    durationSeconds: num(raw["duration"]),
    /**
     * `answered` absent is NOT treated as answered. A pre-call webhook fires
     * before anybody has picked up and carries no such field; recording it
     * as answered would make every missed call look handled, which is the
     * one number a shop manages to.
     */
    answered: bool(raw["answered"]) ?? false,
    voicemail: bool(raw["voicemail"]) ?? false,
    customerName: str(raw["customer_name"]) ?? str(raw["callername"]),
    utm: {
      ...(str(raw["utm_source"]) ? { source: str(raw["utm_source"])! } : {}),
      ...(str(raw["utm_medium"]) ? { medium: str(raw["utm_medium"])! } : {}),
      ...(str(raw["utm_campaign"]) ? { campaign: str(raw["utm_campaign"])! } : {}),
      ...(str(raw["utm_term"]) ? { term: str(raw["utm_term"])! } : {}),
      ...(str(raw["utm_content"]) ? { content: str(raw["utm_content"])! } : {}),
    },
    /**
     * Whichever click id they captured. Only one is ever set on a call,
     * because a visit arrives from one network, and the order here is the
     * order of how much money a trades company spends on each.
     */
    clickId: str(raw["gclid"]) ?? str(raw["msclkid"]) ?? str(raw["fbclid"]),
    referrer: str(raw["referrer"]) ?? str(raw["referrer_domain"]) ?? str(raw["referring_url"]),
    landingPath: str(raw["landing_page_url"]) ?? str(raw["landingpage"]),
    personId: str(raw["person_id"]),
    firstCall: bool(raw["first_call"]),
    raw,
  };
}

/**
 * The fields a backfill asks for by name.
 *
 * CallRail returns a small default set and everything else only on request,
 * and the attribution is all in the "everything else": a backfill that did
 * not name these would import calls with no source, no campaign and no click
 * id, which is a call list rather than attribution and looks exactly like
 * the real thing on screen.
 */
const WANTED_FIELDS = [
  "campaign", "medium", "keywords", "source", "source_name", "first_call",
  "landing_page_url", "referrer_domain", "device_type", "lead_status",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "msclkid", "person_id", "company_id",
].join(",");

export function callRailProvider(
  settings: CallRailSettings, apiKey: string,
): CallTrackingProvider {
  const base = settings.baseUrl ?? API;

  async function get(path: string, query: Record<string, string>): Promise<{
    ok: boolean; status: number; json: Record<string, unknown>;
  }> {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        /**
         * Their own spelling, quotes included. `Bearer` is refused, and so
         * is the same token without the quotes.
         */
        authorization: `Token token="${apiKey}"`,
        accept: "application/json",
      },
    });

    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = asObject(JSON.parse(text)) ?? {};
    } catch {
      json = { error: text.slice(0, 500) };
    }
    return { ok: response.ok, status: response.status, json };
  }

  /**
   * A failure CallRail will answer differently if asked again.
   *
   * 429 is their rate limit, which is 1,000 requests an hour and 10,000 a
   * day, and their own advice is to pause and resume rather than to stop.
   * 5xx is their problem. A 401 is the key, a 404 is the account id, and
   * retrying either is how a backfill spends its whole budget learning the
   * same thing a thousand times.
   */
  const retryable = (status: number) => status === 429 || status >= 500;

  const failure = (status: number, json: Record<string, unknown>) => ({
    ok: false as const,
    code: `http_${status}`,
    message: str(json["error"])
      ?? (status === 401
        ? "CallRail refused the API key. It is the one from the integrations screen of your own account, and it is sent as Token token=\"...\" rather than as a bearer token."
        : `CallRail answered ${status}.`),
    retryable: retryable(status),
  });

  return {
    name: "callrail",
    proof: PROOF,

    parseCall(request: WebhookRequest): TrackedCall | null {
      let body: unknown;
      try {
        body = JSON.parse(request.body);
      } catch {
        return null;
      }
      const raw = asObject(body);
      if (!raw) return null;

      /**
       * NO SEPARATE CHECK FOR THE SIBLING WEBHOOKS, and that is deliberate.
       *
       * CallRail posts text messages and form submissions at the same URL.
       * An earlier version of this looked for `form_data` and `message` and
       * declined those bodies, which was a guard that could not be made to
       * fail: `toCall` already refuses anything without a tracking number,
       * the caller's number and a start time, and NEITHER of those shapes
       * has them. A text carries `source_number`, `destination_number`,
       * `content` and `timestamp`; a form carries `form_data`, `form_url`
       * and `submitted_at`. One of the two field names in that guard was
       * wrong as well, which nothing could have shown.
       *
       * A guard nothing can break is a guard nobody can verify, and this
       * codebase treats that as worse than no guard, because it reads as
       * protection. The required fields do the work and the test names both
       * shapes.
       */
      return toCall(raw);
    },

    async listCalls(window): Promise<CallFetch> {
      if (!settings.accountId) {
        return {
          ok: false,
          code: "no_account_id",
          message:
            "No CallRail account id on the connection. It is the identifier in the URL of your "
            + "CallRail dashboard, and without it there is nothing to list calls from.",
          retryable: false,
        };
      }

      const { ok, status, json } = await get(`/a/${settings.accountId}/calls.json`, {
        /**
         * Offset pagination rather than their relative pagination, on
         * purpose. Relative pagination is faster on large sets and their own
         * documentation warns that page n+1 may not begin where page n
         * ended if a call arrives in between, which for a backfill means a
         * call silently skipped. A backfill exists to close a gap, so the
         * slower paging that cannot open a new one is the right trade.
         */
        page: String(window.page),
        per_page: "100",
        start_date: window.since.toISOString(),
        end_date: window.until.toISOString(),
        fields: WANTED_FIELDS,
        ...(settings.companyId ? { company_id: settings.companyId } : {}),
      });

      if (!ok) return failure(status, json);

      const list = Array.isArray(json["calls"]) ? json["calls"] : [];
      const calls: TrackedCall[] = [];
      for (const entry of list) {
        const raw = asObject(entry);
        const call = raw ? toCall(raw) : null;
        if (call) calls.push(call);
      }

      const totalPages = num(json["total_pages"]) ?? window.page;
      return { ok: true, calls, page: window.page, hasMore: window.page < totalPages };
    },

    async checkCredential(): Promise<CredentialCheck> {
      const { ok, status, json } = await get("/a.json", {});
      if (!ok) return failure(status, json);

      const accounts = Array.isArray(json["accounts"]) ? json["accounts"] : [];
      const first = asObject(accounts[0]);
      const wanted = settings.accountId
        ? accounts.map(asObject).find((a) => a && str(a["id"]) === settings.accountId) ?? null
        : first;

      if (!wanted) {
        return {
          ok: false,
          code: "no_such_account",
          message: settings.accountId
            ? `The key works and it cannot see account ${settings.accountId}. CallRail scopes a key to the accounts its user holds.`
            : "The key works and the account list came back empty, so there is nothing to read calls from.",
          retryable: false,
        };
      }

      return {
        ok: true,
        accountId: str(wanted["id"]) ?? "",
        accountName: str(wanted["name"]) ?? "",
      };
    },
  };
}

registerCallTrackingProvider("callrail", (settings, secret) =>
  callRailProvider(settings as CallRailSettings, secret));
