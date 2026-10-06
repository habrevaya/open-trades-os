import { ads } from "@opentradesos/core";
import {
  AuthorizationLostError, PlatformRefusedError, PlatformUnavailableError, jsonOf, registerAdsAdapter, textSetting,
  type AdapterInput, type AdsAdapter, type EventOutcome, type OutboundEvent, type PulledSpend,
} from "./provider";

/**
 * META (FACEBOOK AND INSTAGRAM) ADS
 *
 * Two things through the Graph API:
 *
 *   SPEND, from the ad account's insights at campaign level, one row per
 *   campaign per day. Meta reports spend as a decimal string in the account's
 *   currency, which is kept exactly rather than read as a float.
 *
 *   THE CONVERSIONS API: a Lead when a job is booked and a Purchase when it is
 *   paid, as server events against the company's pixel. Each carries the
 *   job's event id, which Meta deduplicates on, and `action_source` of
 *   `system_generated`, which is what Meta calls an event a CRM reports.
 *   Matching is on the click parameter built from the fbclid, the `_fbp`
 *   browser id, and hashed email and phone only where core said they may go.
 *
 * Events go one per request. A Conversions API request is refused whole when
 * one event in it is bad, and a refused batch would put nine good jobs in the
 * refused list beside the one stale one. A trades company books tens of jobs
 * a day, not thousands, so the extra requests cost nothing worth saving.
 *
 * The token goes in the Authorization header rather than the query string the
 * Graph API also accepts, because a URL is logged by every proxy between this
 * box and Meta.
 */

const DEFAULT_BASE = "https://graph.facebook.com";
const DEFAULT_VERSION = "v21.0";
const MAX_PAGES = 50;

const accountDigits = (value: string | undefined) => value?.replace(/^act_/i, "").replace(/\D/g, "") || undefined;

/** Meta's error words, and whether they mean the sign in is gone. */
function metaFailure(status: number, body: unknown): Error {
  const error = (body as { error?: { message?: unknown; code?: unknown; error_user_msg?: unknown } }).error ?? {};
  const words = [error.error_user_msg, error.message].find((w) => typeof w === "string") as string | undefined ?? "";
  /** 190 is Meta's code for a token that is no longer valid, whatever the HTTP status says. */
  if (error.code === 190 || status === 401) {
    return new AuthorizationLostError(`Meta no longer accepts this connection's sign in: ${words.slice(0, 300)}`);
  }
  /** 4, 17, 32 and 613 are Meta's rate limits. */
  if (status === 429 || status >= 500 || [4, 17, 32, 613].includes(Number(error.code))) {
    return new PlatformUnavailableError(`Meta answered HTTP ${status}: ${words.slice(0, 300)} It will be tried again.`);
  }
  return new PlatformRefusedError(`Meta refused the request (HTTP ${status}): ${words.slice(0, 300)}`);
}

function createMetaAds(input: AdapterInput): AdsAdapter {
  const base = (textSetting(input.settings, "baseUrl") ?? DEFAULT_BASE).replace(/\/$/, "");
  const version = textSetting(input.settings, "apiVersion") ?? DEFAULT_VERSION;
  const accountId = accountDigits(textSetting(input.settings, "adAccountId"));
  const pixelId = textSetting(input.settings, "pixelId")?.replace(/\D/g, "") || undefined;

  async function request(url: string, init: { method: string; body?: string }): Promise<unknown> {
    if (!input.token) throw new PlatformRefusedError("Nobody has signed in with Meta for this connection yet.");
    const token = await input.token.accessToken();
    let response;
    try {
      response = await input.transport(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
      });
    } catch (error) {
      throw new PlatformUnavailableError(`Meta could not be reached: ${(error as Error).message}`);
    }
    const parsed = await jsonOf(response, "Meta");
    if (response.status < 200 || response.status >= 300) throw metaFailure(response.status, parsed);
    return parsed;
  }

  return {
    provider: "meta_ads",

    async pullSpend(range) {
      if (!accountId) throw new PlatformRefusedError("Enter the Meta ad account id, the number after act_ in Ads Manager.");
      const params = new URLSearchParams({
        level: "campaign",
        fields: "campaign_id,campaign_name,spend,impressions,clicks,account_currency",
        time_range: JSON.stringify({ since: range.from, until: range.to }),
        time_increment: "1",
        limit: "500",
      });
      let url: string | null = `${base}/${version}/act_${accountId}/insights?${params.toString()}`;
      const out: PulledSpend[] = [];
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const body = await request(url, { method: "GET" }) as {
          data?: Record<string, unknown>[]; paging?: { next?: unknown };
        };
        for (const row of body.data ?? []) {
          const spend = typeof row["spend"] === "string" ? row["spend"].trim() : "0";
          if (!/^\d+(\.\d+)?$/.test(spend) || typeof row["date_start"] !== "string" || row["campaign_id"] === undefined) continue;
          const [whole, fraction = ""] = spend.split(".");
          const count = (value: unknown) => {
            const n = Number(value);
            return Number.isFinite(n) ? Math.trunc(n) : null;
          };
          out.push({
            accountId,
            campaignId: String(row["campaign_id"]),
            campaignName: typeof row["campaign_name"] === "string" ? row["campaign_name"] : `Campaign ${String(row["campaign_id"])}`,
            channelType: null,
            day: row["date_start"],
            /** Exactly as Meta wrote it, cut to four places rather than rounded through a float. */
            amount: `${whole}.${fraction.padEnd(4, "0").slice(0, 4)}`,
            impressions: count(row["impressions"]),
            clicks: count(row["clicks"]),
            currency: typeof row["account_currency"] === "string" ? row["account_currency"] : "USD",
          });
        }
        /** Meta's next page is a whole URL, which carries no token because ours went in a header. */
        url = typeof body.paging?.next === "string" ? body.paging.next : null;
      }
      return out;
    },

    async sendEvents(events: OutboundEvent[]): Promise<EventOutcome[]> {
      if (!pixelId) throw new PlatformRefusedError("Enter the Meta pixel id the Conversions API sends to.");
      const testCode = textSetting(input.settings, "testEventCode");
      const outcomes: EventOutcome[] = [];
      for (const event of events) {
        const userData: Record<string, unknown> = {
          ...(event.hashedEmail ? { em: [event.hashedEmail] } : {}),
          ...(event.hashedPhone ? { ph: [event.hashedPhone] } : {}),
          ...(event.clickId && event.clickSeenAt ? { fbc: ads.metaClickParam(event.clickId, event.clickSeenAt) } : {}),
          ...(event.browserId ? { fbp: event.browserId } : {}),
        };
        const body = {
          data: [{
            event_name: event.kind === "purchase" ? "Purchase" : "Lead",
            event_time: Math.floor(event.at.getTime() / 1000),
            event_id: event.eventId,
            action_source: "system_generated",
            user_data: userData,
            ...(event.value !== null ? { custom_data: { value: Number(event.value), currency: event.currency } } : {}),
          }],
          ...(testCode ? { test_event_code: testCode } : {}),
        };
        try {
          const answer = await request(`${base}/${version}/${pixelId}/events`, { method: "POST", body: JSON.stringify(body) }) as {
            events_received?: unknown;
          };
          outcomes.push(answer.events_received === 1
            ? { eventId: event.eventId, ok: true }
            : { eventId: event.eventId, ok: false, message: "Meta answered without counting the event." });
        } catch (error) {
          if (error instanceof PlatformRefusedError) {
            outcomes.push({ eventId: event.eventId, ok: false, message: error.message });
            continue;
          }
          throw error;
        }
      }
      return outcomes;
    },
  };
}

registerAdsAdapter("meta_ads", createMetaAds);
