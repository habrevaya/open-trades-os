import {
  registerRouter, tableFrom, failureFrom, USER_AGENT, DAY_SECONDS,
  type RouterOptions, type RoutingProvider,
} from "./provider";

/**
 * OPENROUTESERVICE: OPENSTREETMAP ROADS, HOSTED OR SELF HOSTED
 *
 * Heidelberg's routing service over the same OpenStreetMap data as OSRM,
 * with a free hosted tier that takes a key and a container a company can run
 * itself without one. `POST /v2/matrix/{profile}` with the coordinates in the
 * body, so a long day does not become a URL too long for a proxy.
 *
 * The hosted tier limits a matrix to a few thousand cells, so fifty points a
 * request. Kept a week: the data is OpenStreetMap's, which may be kept, and a
 * week is long enough that the free daily quota goes on new questions.
 */

const API = "https://api.openrouteservice.org";

export function openRouteServiceRouter(options: RouterOptions): RoutingProvider {
  const settings = options.settings;
  // A connection's `endpoint` or `baseUrl` survives only where overrides are
  // allowed (the test suites); a self hosted server is `OPENROUTESERVICE_URL`.
  const endpoint = String(
    settings["endpoint"] ?? settings["baseUrl"] ?? (process.env["OPENROUTESERVICE_URL"]?.trim() || API),
  ).trim().replace(/\/+$/, "");
  const profile = typeof settings["profile"] === "string" && /^[a-z-]+$/.test(settings["profile"]) ? settings["profile"] : "driving-car";
  const isPublic = endpoint === API;
  const doFetch = options.fetch ?? fetch;

  return {
    name: "openrouteservice",
    keepForSeconds: 7 * DAY_SECONDS,
    maxPoints: 50,
    async matrix(request) {
      if (isPublic && !options.secret) {
        return {
          kind: "failed", retryable: false,
          reason: "No OpenRouteService key. Put it in your secret store and enter its name on the integrations screen, or enter the address of your own server.",
        };
      }
      const points = [...request.sources, ...request.destinations];
      let response: Response;
      try {
        response = await doFetch(`${endpoint}/v2/matrix/${profile}`, {
          method: "POST",
          headers: {
            "user-agent": USER_AGENT,
            accept: "application/json",
            "content-type": "application/json",
            ...(options.secret ? { authorization: options.secret } : {}),
          },
          body: JSON.stringify({
            locations: points.map((p) => [p.lng, p.lat]),
            sources: request.sources.map((_, i) => i),
            destinations: request.destinations.map((_, i) => i + request.sources.length),
            metrics: ["duration", "distance"],
            units: "m",
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        return { kind: "failed", retryable: true, reason: `OpenRouteService could not be reached: ${(error as Error).message}` };
      }
      if (!response.ok) return failureFrom(response.status, await response.text().catch(() => ""));
      const body = await response.json().catch(() => null) as { durations?: unknown; distances?: unknown } | null;
      if (!body) return { kind: "failed", retryable: true, reason: "OpenRouteService answered with something that was not a matrix." };
      return tableFrom(request, body.durations, body.distances);
    },
  };
}

registerRouter("openrouteservice", openRouteServiceRouter);
