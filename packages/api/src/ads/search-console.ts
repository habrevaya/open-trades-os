import {
  failure, jsonOf, registerAdsAdapter, textSetting, PlatformRefusedError, PlatformUnavailableError,
  type AdapterInput, type AdsAdapter, type PulledAnalytics,
} from "./provider";

/**
 * GOOGLE SEARCH CONSOLE, READ BACK
 *
 * What people typed into Google before they arrived, per day, with the
 * clicks and impressions Google reports for each search. The Search Analytics
 * query, by date and query, a page of twenty five thousand rows at a time.
 *
 * Google withholds queries below a privacy threshold, so the rows do not add
 * up to the site's total clicks and nothing here pretends they do: the
 * overview shows the queries as Google gives them.
 */

const DEFAULT_BASE = "https://www.googleapis.com";
const ROW_LIMIT = 25_000;
const MAX_PAGES = 8;

function googleWords(body: unknown): string {
  const error = (body as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : "";
}

function createSearchConsole(input: AdapterInput): AdsAdapter {
  const base = (textSetting(input.settings, "baseUrl") ?? DEFAULT_BASE).replace(/\/$/, "");
  const site = textSetting(input.settings, "siteUrl");

  return {
    provider: "search_console",

    async pullAnalytics(range) {
      if (!site) throw new PlatformRefusedError("Enter the Search Console property: sc-domain:yourcompany.com, or the site's https address.");
      if (!input.token) throw new PlatformRefusedError("Nobody has signed in with Google for this connection yet.");
      const url = `${base}/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
      const out: PulledAnalytics[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const token = await input.token.accessToken();
        let response;
        try {
          response = await input.transport(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              startDate: range.from, endDate: range.to, dimensions: ["date", "query"],
              rowLimit: ROW_LIMIT, startRow: page * ROW_LIMIT, dataState: "all",
            }),
          });
        } catch (error) {
          throw new PlatformUnavailableError(`Search Console could not be reached: ${(error as Error).message}`);
        }
        const body = await jsonOf(response, "Search Console");
        if (response.status < 200 || response.status >= 300) throw failure(response.status, "Search Console", googleWords(body));
        const rows = (body as { rows?: { keys?: unknown; clicks?: unknown; impressions?: unknown; position?: unknown }[] }).rows ?? [];
        for (const row of rows) {
          const keys = Array.isArray(row.keys) ? row.keys : [];
          const day = keys[0];
          const query = keys[1];
          if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof query !== "string" || query.trim() === "") continue;
          const position = typeof row.position === "number" && Number.isFinite(row.position) ? row.position.toFixed(2) : null;
          out.push({
            kind: "search", day, query: query.trim().slice(0, 500),
            clicks: Math.trunc(Number(row.clicks) || 0),
            impressions: Math.trunc(Number(row.impressions) || 0),
            position,
          });
        }
        if (rows.length < ROW_LIMIT) return out;
      }
      return out;
    },
  };
}

registerAdsAdapter("search_console", createSearchConsole);
