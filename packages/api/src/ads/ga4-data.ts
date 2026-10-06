import {
  failure, jsonOf, registerAdsAdapter, textSetting, PlatformRefusedError, PlatformUnavailableError,
  type AdapterInput, type AdsAdapter, type PulledAnalytics,
} from "./provider";

/**
 * GOOGLE ANALYTICS 4, READ BACK
 *
 * Sessions and engaged sessions per day by session source and medium, from
 * the Data API's `runReport`. The other half of the `ga4` connection, which
 * only ever sends events: that one needs a Measurement Protocol secret and no
 * sign in, this one needs a sign in and no secret, so they are two
 * connections rather than one with two kinds of credential.
 *
 * Google's own numbers, with its sampling, its thresholds and its consent
 * mode gaps. They are shown beside this product's leads, never added to them.
 */

const DEFAULT_BASE = "https://analyticsdata.googleapis.com";
const PAGE = 10_000;
const MAX_PAGES = 10;

function googleWords(body: unknown): string {
  const error = (body as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : "";
}

function createGa4Data(input: AdapterInput): AdsAdapter {
  const base = (textSetting(input.settings, "baseUrl") ?? DEFAULT_BASE).replace(/\/$/, "");
  const property = textSetting(input.settings, "propertyId")?.replace(/^properties\//, "").replace(/\D/g, "") || undefined;

  return {
    provider: "ga4_data",

    async pullAnalytics(range) {
      if (!property) {
        throw new PlatformRefusedError("Enter the Google Analytics property id, the number in Admin under Property details, not the G- id.");
      }
      if (!input.token) throw new PlatformRefusedError("Nobody has signed in with Google for this connection yet.");
      const out: PulledAnalytics[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const token = await input.token.accessToken();
        let response;
        try {
          response = await input.transport(`${base}/v1beta/properties/${property}:runReport`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              dateRanges: [{ startDate: range.from, endDate: range.to }],
              dimensions: [{ name: "date" }, { name: "sessionSource" }, { name: "sessionMedium" }],
              metrics: [{ name: "sessions" }, { name: "engagedSessions" }],
              limit: String(PAGE), offset: String(page * PAGE),
            }),
          });
        } catch (error) {
          throw new PlatformUnavailableError(`Google Analytics could not be reached: ${(error as Error).message}`);
        }
        const body = await jsonOf(response, "Google Analytics");
        if (response.status < 200 || response.status >= 300) throw failure(response.status, "Google Analytics", googleWords(body));
        const rows = (body as { rows?: { dimensionValues?: { value?: unknown }[]; metricValues?: { value?: unknown }[] }[] }).rows ?? [];
        for (const row of rows) {
          const [date, source, medium] = (row.dimensionValues ?? []).map((d) => (typeof d.value === "string" ? d.value : ""));
          const [sessions, engaged] = (row.metricValues ?? []).map((v) => Math.trunc(Number(v.value) || 0));
          if (!date || !/^\d{8}$/.test(date)) continue;
          out.push({
            kind: "sessions",
            /** Analytics writes a day as 20260401. */
            day: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
            source: (source || "(not set)").slice(0, 200),
            medium: (medium || "(not set)").slice(0, 200),
            sessions: sessions ?? 0,
            engagedSessions: engaged ?? 0,
          });
        }
        const total = Number((body as { rowCount?: unknown }).rowCount ?? rows.length);
        if (rows.length < PAGE || (page + 1) * PAGE >= total) return out;
      }
      return out;
    },
  };
}

registerAdsAdapter("ga4_data", createGa4Data);
