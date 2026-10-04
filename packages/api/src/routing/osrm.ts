import {
  registerRouter, tableFrom, failureFrom, USER_AGENT, DAY_SECONDS,
  type RouterOptions, type RoutingProvider,
} from "./provider";

/**
 * OSRM: THE ROUTING ENGINE A COMPANY CAN RUN ITSELF
 *
 * The Open Source Routing Machine over OpenStreetMap roads. No account, no
 * key and no bill: a company downloads its state's extract, runs the
 * published container, and points this at it. That is the answer for anybody
 * who does not want customers' addresses leaving the building, and the reason
 * this adapter needs an `endpoint` and has no default: the project's own demo
 * server asks not to be used for production traffic, and pointing a product
 * at it by default would be exactly that.
 *
 * `/table/v1/{profile}` answers a whole matrix in one request, with
 * `sources` and `destinations` naming which of the coordinates are which.
 * Answers are kept thirty days: the roads are the company's own copy and
 * change when they refresh the extract.
 */

export function osrmRouter(options: RouterOptions): RoutingProvider {
  const settings = options.settings;
  const endpoint = typeof settings["endpoint"] === "string" ? settings["endpoint"].trim().replace(/\/+$/, "") : "";
  const profile = typeof settings["profile"] === "string" && /^[a-z_-]+$/.test(settings["profile"]) ? settings["profile"] : "driving";
  const doFetch = options.fetch ?? fetch;

  return {
    name: "osrm",
    keepForSeconds: 30 * DAY_SECONDS,
    /** OSRM's own default `max-table-size` is 100. */
    maxPoints: 100,
    async matrix(request) {
      if (!endpoint) {
        return { kind: "failed", retryable: false, reason: "No OSRM server address. Enter the address of your OSRM server on the integrations screen." };
      }
      const points = [...request.sources, ...request.destinations];
      const coordinates = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
      const params = new URLSearchParams({
        sources: request.sources.map((_, i) => i).join(";"),
        destinations: request.destinations.map((_, i) => i + request.sources.length).join(";"),
        annotations: "duration,distance",
      });
      let response: Response;
      try {
        response = await doFetch(`${endpoint}/table/v1/${profile}/${coordinates}?${params.toString()}`, {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        return { kind: "failed", retryable: true, reason: `The OSRM server could not be reached: ${(error as Error).message}` };
      }
      if (!response.ok) return failureFrom(response.status, await response.text().catch(() => ""));
      const body = await response.json().catch(() => null) as { code?: string; message?: string; durations?: unknown; distances?: unknown } | null;
      if (!body || body.code !== "Ok") {
        return { kind: "failed", retryable: false, reason: `OSRM said ${body?.code ?? "nothing usable"}${body?.message ? `: ${body.message}` : ""}.` };
      }
      return tableFrom(request, body.durations, body.distances);
    },
  };
}

registerRouter("osrm", osrmRouter);
