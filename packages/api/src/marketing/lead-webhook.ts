import { createHmac, timingSafeEqual } from "node:crypto";
import { registerLeadSource, type LeadSource, type InboundLead, type WebhookRequest } from "./provider";

/**
 * THE GENERIC LEAD WEBHOOK
 *
 * One signed endpoint that a marketplace, a form builder, a website or a
 * partner can POST a lead to. It is the first lead connector because it is
 * how the real ones actually deliver: Angi, Thumbtack and Facebook Lead Ads
 * all POST, and where an API also exists, polling it is the slower path in a
 * market where speed to lead is the entire game.
 *
 * WHAT THE SIGNATURE IS FOR, AND WHY IT CANNOT BE SKIPPED
 *
 * Without it this endpoint is a job creation API open to the internet.
 * Anybody who learns the URL can inject work onto a contractor's dispatch
 * board, consume the capacity a real customer would have booked, and send a
 * van to an address that never asked for one. The van is the part that
 * matters: this is not a spam problem, it is somebody's morning.
 *
 * So `verify` is required by the interface, there is no setting that
 * disables it, and the comparison below is constant time. A byte by byte
 * comparison that returns early leaks the correct signature one character at
 * a time to anybody willing to send a few thousand requests, which is the
 * kind of detail that looks like paranoia right up until it is a job on
 * somebody's board.
 *
 * FIELD MAPPING IS CONFIGURATION, NOT CODE
 *
 * Every sender calls the same five things something different: `name`,
 * `full_name`, `contact.name`, `customer_name`. A parser per sender is the
 * same file eight times, so the mapping is data held on the connection and
 * this file reads it. A sender nobody anticipated is a settings change
 * rather than a release.
 */

/** Where to find each field in whatever shape the sender uses. */
export interface LeadFieldMap {
  externalId?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  serviceRequested?: string;
  notes?: string;
  estimatedValue?: string;
  expiresAt?: string;
}

/**
 * The paths tried when no mapping says otherwise.
 *
 * A default rather than a requirement, because the commonest sender is a
 * website form whose fields are already called the obvious thing, and making
 * that case require a mapping is making the easy case hard.
 */
const FALLBACKS: Record<keyof LeadFieldMap, string[]> = {
  externalId: ["id", "lead_id", "leadId", "external_id", "request_id"],
  contactName: ["name", "full_name", "fullName", "contact_name", "customer_name", "contact.name"],
  contactEmail: ["email", "email_address", "contact_email", "contact.email"],
  contactPhone: ["phone", "phone_number", "phoneNumber", "contact_phone", "telephone", "contact.phone"],
  addressLine1: ["address", "address1", "address_line1", "street", "street_address", "location.address"],
  city: ["city", "locality", "location.city"],
  state: ["state", "region", "location.state"],
  postalCode: ["zip", "zipcode", "zip_code", "postal_code", "postcode", "location.zip"],
  serviceRequested: ["service", "service_type", "job_type", "category", "trade"],
  notes: ["notes", "message", "comments", "description", "details"],
  estimatedValue: ["value", "estimated_value", "job_value", "budget"],
  expiresAt: ["expires_at", "expiresAt", "expiry", "respond_by"],
};

/**
 * Read a dotted path out of a parsed body.
 *
 * Dotted because half these senders nest under `contact` or `location` and
 * half do not, and a mapping that could only name a top level key would
 * force a sender to flatten their own payload before sending it.
 */
function at(body: Record<string, unknown>, path: string): unknown {
  let current: unknown = body;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function text(body: Record<string, unknown>, mapped: string | undefined, fallbacks: string[]): string | null {
  const paths = mapped ? [mapped, ...fallbacks] : fallbacks;
  for (const path of paths) {
    const value = at(body, path);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

/**
 * Whether a signature matches, without leaking how close a wrong one was.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * signal, so the lengths are compared first and a mismatch returns false
 * rather than reaching the comparison. Everything about the request that is
 * signed has to be exactly what arrived: re-serialising the body changes one
 * byte of whitespace and every signature stops matching.
 */
function matches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const SIGNATURE_HEADER = "x-otos-signature";
export const TIMESTAMP_HEADER = "x-otos-timestamp";

/**
 * How far out of date a request may be.
 *
 * Five minutes. The timestamp is in the signed payload, so without this
 * window a signature captured once is valid forever and a replayed request
 * puts the same lead on the board again every time somebody sends it. Five
 * is long enough for clock drift on a sender nobody administers and short
 * enough that a captured request is useless by the time it is noticed.
 */
export const MAX_SKEW_MS = 5 * 60 * 1000;

export function webhookLeadSource(options: {
  fieldMap?: LeadFieldMap;
  source?: string;
  now?: () => number;
} = {}): LeadSource {
  const map = options.fieldMap ?? {};
  const now = options.now ?? Date.now;

  return {
    name: "lead_webhook",

    verify(request: WebhookRequest, secret: string): boolean {
      const provided = request.headers[SIGNATURE_HEADER] ?? request.headers[SIGNATURE_HEADER.toUpperCase()];
      const timestamp = request.headers[TIMESTAMP_HEADER] ?? request.headers[TIMESTAMP_HEADER.toUpperCase()];
      if (!provided || !timestamp) return false;

      const sentAt = Number(timestamp);
      if (!Number.isFinite(sentAt)) return false;
      if (Math.abs(now() - sentAt) > MAX_SKEW_MS) return false;

      /**
       * The URL is in the signed payload as well as the body. Without it a
       * signature for one company's endpoint is valid at another's, and a
       * partner who sends to several tenants could aim a lead at whichever
       * of them they liked.
       */
      const payload = `${timestamp}.${request.url}.${request.body}`;
      const expected = createHmac("sha256", secret).update(payload).digest("hex");
      return matches(expected, provided);
    },

    parse(request: WebhookRequest): InboundLead | null {
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(request.body);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        body = parsed as Record<string, unknown>;
      } catch {
        return null;
      }

      const name = text(body, map.contactName, FALLBACKS.contactName);
      const phone = text(body, map.contactPhone, FALLBACKS.contactPhone);
      const email = text(body, map.contactEmail, FALLBACKS.contactEmail);

      /**
       * A name and SOME way to reach them, or this is not a lead.
       *
       * Refused here rather than stored as an empty customer, because a row
       * in the CRM with a name and no phone number reads to whoever opens it
       * as a lead somebody failed to call, and they will spend their morning
       * trying to find out who it was.
       */
      if (!name || (!phone && !email)) return null;

      const expiresRaw = text(body, map.expiresAt, FALLBACKS.expiresAt);
      const expiresAt = expiresRaw ? new Date(expiresRaw) : null;

      return {
        externalId: text(body, map.externalId, FALLBACKS.externalId)
          /**
           * Falling back to the signature makes a retry of the SAME request
           * idempotent, which is the case that matters: a sender that did
           * not get a 200 will send the identical body again.
           */
          ?? (request.headers[SIGNATURE_HEADER] ?? "").slice(0, 64),
        contactName: name,
        contactEmail: email,
        contactPhone: phone,
        addressLine1: text(body, map.addressLine1, FALLBACKS.addressLine1),
        city: text(body, map.city, FALLBACKS.city),
        state: text(body, map.state, FALLBACKS.state),
        postalCode: text(body, map.postalCode, FALLBACKS.postalCode),
        serviceRequested: text(body, map.serviceRequested, FALLBACKS.serviceRequested),
        notes: text(body, map.notes, FALLBACKS.notes),
        estimatedValue: text(body, map.estimatedValue, FALLBACKS.estimatedValue),
        expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
        source: options.source ?? "marketplace",
        /** Kept whole, because a field mapping is always wrong about something. */
        raw: body,
      };
    },
  };
}

/**
 * The signature a sender computes.
 *
 * Exported so the settings screen can show a worked example rather than
 * prose. An integrator handed "sign the body with HMAC-SHA256" gets the
 * concatenation order wrong roughly half the time, and the failure looks
 * identical to a wrong secret.
 */
export function signLeadWebhook(input: {
  secret: string; url: string; body: string; timestamp: number;
}): { signature: string; timestamp: string } {
  const timestamp = String(input.timestamp);
  const payload = `${timestamp}.${input.url}.${input.body}`;
  return {
    signature: createHmac("sha256", input.secret).update(payload).digest("hex"),
    timestamp,
  };
}

registerLeadSource("lead_webhook", () => webhookLeadSource());
