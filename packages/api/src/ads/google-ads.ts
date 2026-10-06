import { ads } from "@opentradesos/core";
import {
  failure, jsonOf, registerAdsAdapter, textSetting, PlatformRefusedError, PlatformUnavailableError,
  type AdapterInput, type AdsAdapter, type EventOutcome, type OutboundAdjustment, type OutboundEvent, type PulledLead, type PulledSpend,
} from "./provider";

/**
 * GOOGLE ADS, AND LOCAL SERVICES THROUGH THE SAME API
 *
 * Three things, all through the Google Ads API's REST interface:
 *
 *   SPEND. One query per pull: every campaign's cost, clicks and impressions
 *   per day. A Local Services campaign comes back from the same query with
 *   channel type LOCAL_SERVICES, and is filed under Local Services by core
 *   rather than blended into Google Ads.
 *
 *   CONVERSIONS. A paid job, uploaded as a click conversion against the
 *   gclid (or the gbraid or wbraid an iPhone sends instead), with the job's
 *   revenue as its value, the job's event id as its `orderId` so Google
 *   itself refuses a second copy, and hashed email and phone only where core
 *   said they may go. Partial failure is on, so one stale click in a batch
 *   does not refuse the other nine.
 *
 *   ADJUSTMENTS. A paid job whose revenue changed after it was sent: a
 *   RESTATEMENT to its new value or a RETRACTION when nothing is left, found
 *   by Google through the same `orderId` the conversion carried.
 *
 *   LOCAL SERVICES LEADS. The `local_services_lead` resource, which is where
 *   Google moved Local Services leads from the old standalone API. Calls,
 *   messages and bookings, with the consumer's name and number where Google
 *   discloses them.
 *
 * Every request needs the operator's DEVELOPER TOKEN, which is an application
 * to Google and is not instant. A token at "test account" access works only
 * against test accounts, and Google answers a real account with
 * DEVELOPER_TOKEN_NOT_APPROVED, which this passes through in Google's words.
 */

const DEFAULT_BASE = "https://googleads.googleapis.com";
const DEFAULT_VERSION = "v21";
/** A runaway page loop is a bug, not a big account. Ten thousand rows a page, fifty pages. */
const MAX_PAGES = 50;

const GOOGLE_CLICK_PARAMS = new Set(["gclid", "gbraid", "wbraid"]);

/** A customer id as Google's paths want it: digits only, which is not how the Ads screen prints it. */
export const customerDigits = (value: string | undefined): string | undefined => {
  const digits = value?.replace(/\D/g, "");
  return digits && digits.length >= 8 ? digits : undefined;
};

/** Google's own error words, from the deepest place it puts them. */
function googleMessage(body: unknown): string {
  const error = (body as { error?: { message?: unknown; details?: unknown } }).error;
  const details = Array.isArray(error?.details) ? error.details as { errors?: { message?: unknown; errorCode?: Record<string, unknown> }[] }[] : [];
  const first = details.flatMap((d) => d.errors ?? [])[0];
  if (first) {
    const code = first.errorCode ? Object.values(first.errorCode)[0] : undefined;
    return [code, first.message].filter((part) => typeof part === "string").join(": ");
  }
  return typeof error?.message === "string" ? error.message : "";
}

function createGoogleAds(provider: "google_ads" | "google_lsa", input: AdapterInput): AdsAdapter {
  const base = (textSetting(input.settings, "baseUrl") ?? DEFAULT_BASE).replace(/\/$/, "");
  const version = textSetting(input.settings, "apiVersion") ?? DEFAULT_VERSION;
  const customerId = customerDigits(textSetting(input.settings, "customerId"));
  const loginCustomerId = customerDigits(textSetting(input.settings, "loginCustomerId"));
  const developerToken = input.secrets["developerToken"];

  function ready(): { customerId: string; developerToken: string } {
    if (!customerId) throw new PlatformRefusedError("Enter the Google Ads customer id, the ten digits at the top of the Ads screen.");
    if (!developerToken) throw new PlatformRefusedError("The Google Ads developer token is not in the secret store under the name given.");
    if (!input.token) throw new PlatformRefusedError("Nobody has signed in with Google for this connection yet.");
    return { customerId, developerToken };
  }

  async function call(path: string, body: Record<string, unknown>): Promise<unknown> {
    const { developerToken: devToken } = ready();
    const token = await input.token!.accessToken();
    let response;
    try {
      response = await input.transport(`${base}/${version}/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": devToken,
          ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new PlatformUnavailableError(`Google Ads could not be reached: ${(error as Error).message}`);
    }
    const parsed = await jsonOf(response, "Google Ads");
    if (response.status < 200 || response.status >= 300) throw failure(response.status, "Google Ads", googleMessage(parsed));
    return parsed;
  }

  async function search(query: string): Promise<Record<string, unknown>[]> {
    const { customerId: cid } = ready();
    const rows: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await call(`customers/${cid}/googleAds:search`, { query, ...(pageToken ? { pageToken } : {}) }) as {
        results?: Record<string, unknown>[]; nextPageToken?: string;
      };
      rows.push(...(body.results ?? []));
      if (!body.nextPageToken) return rows;
      pageToken = body.nextPageToken;
    }
    throw new PlatformUnavailableError("Google Ads kept returning pages past any account this product expects. Stopped rather than loop.");
  }

  const int = (value: unknown): number | null => {
    const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

  return {
    provider,

    async pullSpend(range) {
      const only = provider === "google_lsa" ? " AND campaign.advertising_channel_type = 'LOCAL_SERVICES'" : "";
      const rows = await search(
        "SELECT customer.currency_code, campaign.id, campaign.name, campaign.advertising_channel_type, "
        + "segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions FROM campaign "
        + `WHERE segments.date BETWEEN '${range.from}' AND '${range.to}' AND metrics.cost_micros > 0${only}`,
      );
      const out: PulledSpend[] = [];
      for (const row of rows) {
        const campaign = (row["campaign"] ?? {}) as { id?: unknown; name?: unknown; advertisingChannelType?: unknown };
        const segments = (row["segments"] ?? {}) as { date?: unknown };
        const metrics = (row["metrics"] ?? {}) as { costMicros?: unknown; clicks?: unknown; impressions?: unknown };
        const customer = (row["customer"] ?? {}) as { currencyCode?: unknown };
        if (typeof campaign.id !== "string" && typeof campaign.id !== "number") continue;
        if (typeof segments.date !== "string") continue;
        out.push({
          accountId: customerId!,
          campaignId: String(campaign.id),
          campaignName: typeof campaign.name === "string" ? campaign.name : `Campaign ${String(campaign.id)}`,
          channelType: typeof campaign.advertisingChannelType === "string" ? campaign.advertisingChannelType : null,
          day: segments.date,
          amount: ads.microsToAmount(String(metrics.costMicros ?? "0")),
          impressions: int(metrics.impressions),
          clicks: int(metrics.clicks),
          currency: typeof customer.currencyCode === "string" ? customer.currencyCode : "USD",
        });
      }
      return out;
    },

    ...(provider === "google_ads" ? {
      async sendEvents(events: OutboundEvent[]): Promise<EventOutcome[]> {
        const { customerId: cid } = ready();
        const action = textSetting(input.settings, "conversionActionId")?.replace(/\D/g, "");
        if (!action) throw new PlatformRefusedError("Choose the Google Ads conversion action that booked jobs are reported as.");
        const conversions = events.map((event) => {
          const param = event.clickParam && GOOGLE_CLICK_PARAMS.has(event.clickParam) ? event.clickParam : "gclid";
          const identifiers = [
            ...(event.hashedEmail ? [{ hashedEmail: event.hashedEmail }] : []),
            ...(event.hashedPhone ? [{ hashedPhoneNumber: event.hashedPhone }] : []),
          ];
          return {
            conversionAction: `customers/${cid}/conversionActions/${action}`,
            conversionDateTime: ads.googleDateTime(event.at),
            ...(event.value !== null ? { conversionValue: Number(event.value), currencyCode: event.currency } : {}),
            orderId: event.eventId,
            ...(event.clickId ? { [param]: event.clickId } : {}),
            ...(identifiers.length > 0 ? { userIdentifiers: identifiers } : {}),
            consent: { adUserData: event.adUserData },
          };
        });
        const body = await call(`customers/${cid}:uploadClickConversions`, { conversions, partialFailure: true }) as {
          partialFailureError?: { message?: unknown; details?: { errors?: { message?: unknown; errorCode?: Record<string, unknown>; location?: { fieldPathElements?: { fieldName?: string; index?: number }[] } }[] }[] };
        };
        /**
         * Partial failure names each refused conversion by its index in the
         * request, in a field path. Everything not named was accepted.
         */
        const refused = new Map<number, string>();
        for (const detail of body.partialFailureError?.details ?? []) {
          for (const error of detail.errors ?? []) {
            const at = error.location?.fieldPathElements?.find((p) => p.fieldName === "conversions")?.index;
            const code = error.errorCode ? Object.values(error.errorCode)[0] : undefined;
            const words = [code, error.message].filter((part) => typeof part === "string").join(": ");
            if (typeof at === "number") refused.set(at, words || "Google refused this conversion.");
          }
        }
        if (body.partialFailureError && refused.size === 0) {
          const words = typeof body.partialFailureError.message === "string" ? body.partialFailureError.message : "";
          return events.map((event) => ({ eventId: event.eventId, ok: false as const, message: words || "Google refused these conversions." }));
        }
        return events.map((event, index) => refused.has(index)
          ? { eventId: event.eventId, ok: false as const, message: refused.get(index)! }
          : { eventId: event.eventId, ok: true as const });
      },
    } : {}),

    ...(provider === "google_ads" ? {
      async adjustConversions(adjustments: OutboundAdjustment[]) {
        const { customerId: cid } = ready();
        const action = textSetting(input.settings, "conversionActionId")?.replace(/\D/g, "");
        if (!action) throw new PlatformRefusedError("Choose the Google Ads conversion action that booked jobs are reported as.");
        const body = await call(`customers/${cid}:uploadConversionAdjustments`, {
          conversionAdjustments: adjustments.map((a) => ({
            conversionAction: `customers/${cid}/conversionActions/${action}`,
            adjustmentType: a.kind === "retraction" ? "RETRACTION" : "RESTATEMENT",
            orderId: a.orderId,
            adjustmentDateTime: ads.googleDateTime(a.at),
            ...(a.kind === "restatement" && a.value !== null
              ? { restatementValue: { adjustedValue: Number(a.value), currencyCode: a.currency } }
              : {}),
          })),
          partialFailure: true,
        }) as {
          partialFailureError?: { message?: unknown; details?: { errors?: { message?: unknown; errorCode?: Record<string, unknown>; location?: { fieldPathElements?: { fieldName?: string; index?: number }[] } }[] }[] };
        };
        const refused = new Map<number, string>();
        for (const detail of body.partialFailureError?.details ?? []) {
          for (const error of detail.errors ?? []) {
            const at = error.location?.fieldPathElements?.find((p) => p.fieldName === "conversion_adjustments" || p.fieldName === "conversionAdjustments")?.index;
            const code = error.errorCode ? Object.values(error.errorCode)[0] : undefined;
            const words = [code, error.message].filter((part) => typeof part === "string").join(": ");
            if (typeof at === "number") refused.set(at, words || "Google refused this adjustment.");
          }
        }
        if (body.partialFailureError && refused.size === 0) {
          const words = typeof body.partialFailureError.message === "string" ? body.partialFailureError.message : "";
          return adjustments.map((a) => ({ orderId: a.orderId, ok: false, message: words || "Google refused these adjustments." }));
        }
        return adjustments.map((a, index) => ({
          orderId: a.orderId, ok: !refused.has(index), message: refused.get(index) ?? null,
        }));
      },
    } : {}),

    ...(provider === "google_lsa" ? {
      async pullLeads(since: Date): Promise<PulledLead[]> {
        const from = since.toISOString().slice(0, 19).replace("T", " ");
        const rows = await search(
          "SELECT local_services_lead.id, local_services_lead.lead_type, local_services_lead.category_id, "
          + "local_services_lead.service_id, local_services_lead.contact_details, local_services_lead.lead_status, "
          + "local_services_lead.creation_date_time, local_services_lead.lead_charged FROM local_services_lead "
          + `WHERE local_services_lead.creation_date_time >= '${from}' ORDER BY local_services_lead.creation_date_time`,
        );
        const out: PulledLead[] = [];
        for (const row of rows) {
          const lead = (row["localServicesLead"] ?? {}) as {
            id?: unknown; leadType?: unknown; categoryId?: unknown; serviceId?: unknown; leadStatus?: unknown;
            contactDetails?: { phoneNumber?: unknown; email?: unknown; consumerName?: unknown };
            creationDateTime?: unknown; leadCharged?: unknown;
          };
          if (typeof lead.id !== "string" && typeof lead.id !== "number") continue;
          const created = typeof lead.creationDateTime === "string"
            ? new Date(`${lead.creationDateTime.replace(" ", "T")}${/[zZ]|[+-]\d\d:?\d\d$/.test(lead.creationDateTime) ? "" : "Z"}`)
            : new Date();
          const text = (value: unknown) => typeof value === "string" && value.trim() !== "" ? value.trim() : null;
          const service = text(lead.serviceId) ?? text(lead.categoryId);
          out.push({
            externalId: String(lead.id),
            type: text(lead.leadType) ?? "UNKNOWN",
            name: text(lead.contactDetails?.consumerName),
            phone: text(lead.contactDetails?.phoneNumber),
            email: text(lead.contactDetails?.email),
            /** "xcat:service_area_business_hvac" reads as "hvac", which is what the office calls it. */
            service: service ? service.replace(/^.*:/, "").replace(/^service_area_business_/, "").replace(/_/g, " ") : null,
            createdAt: Number.isNaN(created.getTime()) ? new Date() : created,
            charged: typeof lead.leadCharged === "boolean" ? lead.leadCharged : null,
            raw: lead as Record<string, unknown>,
          });
        }
        return out;
      },
    } : {}),
  };
}

registerAdsAdapter("google_ads", (input) => createGoogleAds("google_ads", input));
registerAdsAdapter("google_lsa", (input) => createGoogleAds("google_lsa", input));
