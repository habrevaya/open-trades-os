import {
  registerRouter, tableFrom, failureFrom, USER_AGENT, DAY_SECONDS,
  type RouterOptions, type RoutingProvider,
} from "./provider";
import { trimTrailingSlashes } from "@opentradesos/core";

/**
 * MAPBOX: THE MATRIX API, FOR A COMPANY THAT WOULD RATHER PAY THAN RUN A SERVER
 *
 * `directions-matrix/v1`, driving, durations and distances. Twenty five
 * coordinates a request, which the caller splits a day into.
 *
 * Its own key, `mapbox_directions`, rather than sharing the geocoder's
 * `mapbox`: a company can geocode with one and route with the other, and a
 * connection is one provider for one capability.
 *
 * KEPT FOR A DAY AT MOST. Mapbox's terms restrict storing what its APIs
 * return, and this is the cautious reading: long enough that a dispatcher
 * optimising the same day twice does not pay twice, short enough not to be
 * a copy of their road network. A company with its own agreement may know
 * better; this does not assume it.
 *
 * The token travels in the URL because that is where Mapbox takes it, so the
 * catalogue tells the operator to mint one scoped to this API alone.
 */

const API = "https://api.mapbox.com";

export function mapboxRouter(options: RouterOptions): RoutingProvider {
  const settings = options.settings;
  const base = trimTrailingSlashes(String(settings["baseUrl"] ?? API));
  const profile = settings["profile"] === "driving-traffic" ? "driving-traffic" : "driving";
  const doFetch = options.fetch ?? fetch;

  return {
    name: "mapbox_directions",
    keepForSeconds: DAY_SECONDS,
    /** Ten with live traffic, twenty five without. */
    maxPoints: profile === "driving-traffic" ? 10 : 25,
    async matrix(request) {
      if (!options.secret) {
        return {
          kind: "failed", retryable: false,
          reason: "No Mapbox token. Put it in your secret store and enter its name on the integrations screen.",
        };
      }
      const points = [...request.sources, ...request.destinations];
      const coordinates = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
      const params = new URLSearchParams({
        sources: request.sources.map((_, i) => i).join(";"),
        destinations: request.destinations.map((_, i) => i + request.sources.length).join(";"),
        annotations: "duration,distance",
        access_token: options.secret,
      });
      let response: Response;
      try {
        response = await doFetch(`${base}/directions-matrix/v1/mapbox/${profile}/${coordinates}?${params.toString()}`, {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        return { kind: "failed", retryable: true, reason: `Mapbox could not be reached: ${(error as Error).message}` };
      }
      if (!response.ok) return failureFrom(response.status, await response.text().catch(() => ""));
      const body = await response.json().catch(() => null) as { code?: string; message?: string; durations?: unknown; distances?: unknown } | null;
      if (!body || body.code !== "Ok") {
        return { kind: "failed", retryable: false, reason: `Mapbox said ${body?.code ?? "nothing usable"}${body?.message ? `: ${body.message}` : ""}.` };
      }
      return tableFrom(request, body.durations, body.distances);
    },
  };
}

registerRouter("mapbox_directions", mapboxRouter);
