import { geo } from "@opentradesos/core";
import {
  registerGeocoder, pace, realClock, failureFrom, USER_AGENT,
  type GeocoderOptions, type GeocodingProvider,
} from "./provider";

/**
 * MAPBOX: THE COMMERCIAL ADAPTER, ON THE PERMANENT TIER
 *
 * For a company with more addresses than a free public server should be
 * asked about, or that wants house level answers in places OpenStreetMap is
 * thin. The token is the name of a secret in the deployment's store, like
 * every other credential in this product.
 *
 * `permanent=true`, ALWAYS. Mapbox's ordinary geocoding results may not be
 * stored; the permanent tier exists to be stored, is billed separately, and
 * is what an address book of customers needs. Asking for the temporary tier
 * and keeping the answer on a property row forever would put the company in
 * breach of terms nobody on their side read. A token on an account without
 * permanent geocoding is refused by Mapbox, and that refusal is passed on
 * rather than worked around.
 *
 * THE TOKEN TRAVELS IN THE URL, because the query string is the only place
 * Mapbox accepts it. A URL is logged by proxies in a way a header is not, so
 * the catalogue tells the operator to mint a token scoped to geocoding alone.
 *
 * Geocoding v6, forward, one result, free text from `geo.addressQuery`.
 */

const API = "https://api.mapbox.com";

interface Feature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    feature_type?: string;
    full_address?: string;
    coordinates?: { accuracy?: string };
  };
}

/**
 * How close the answer is. An address feature carries its own accuracy:
 * rooftop, parcel and point are on the property, interpolated is between two
 * numbered houses, and approximate or intersection is the street.
 */
export function precisionOf(feature: Feature): Exclude<geo.GeocodePrecision, "placed"> {
  const type = feature.properties?.feature_type;
  const accuracy = feature.properties?.coordinates?.accuracy;
  if (type === "address") {
    if (accuracy === "rooftop" || accuracy === "parcel" || accuracy === "point") return "rooftop";
    if (accuracy === "interpolated") return "interpolated";
    return "street";
  }
  if (type === "street") return "street";
  if (type === "postcode") return "postal_code";
  return "locality";
}

export function mapboxGeocoder(options: GeocoderOptions): GeocodingProvider {
  const settings = options.settings;
  const base = String(settings["baseUrl"] ?? API).replace(/\/+$/, "");
  const countryCodes = Array.isArray(settings["countryCodes"])
    ? (settings["countryCodes"] as string[]).map((c) => c.trim().toLowerCase()).filter(Boolean)
    : [];
  const minInterval = typeof settings["minIntervalMs"] === "number" ? Math.max(0, settings["minIntervalMs"]) : 100;
  const doFetch = options.fetch ?? fetch;
  const clock = options.clock ?? realClock;

  return {
    name: "mapbox",
    async geocode(request) {
      if (!options.secret) {
        return {
          kind: "failed", retryable: false,
          reason: "No Mapbox token. Put it in your secret store and enter its name on the integrations screen.",
        };
      }
      const params = new URLSearchParams({
        q: request.query,
        limit: "1",
        permanent: "true",
        access_token: options.secret,
      });
      if (countryCodes.length > 0) params.set("country", countryCodes.join(","));

      await pace(base, minInterval, clock);
      let response: Response;
      try {
        response = await doFetch(`${base}/search/geocode/v6/forward?${params.toString()}`, {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        return { kind: "failed", retryable: true, reason: `Mapbox could not be reached: ${(error as Error).message}` };
      }
      if (!response.ok) return failureFrom(response.status, await response.text().catch(() => ""));

      const body = await response.json().catch(() => null) as { features?: Feature[] } | null;
      if (!body || !Array.isArray(body.features)) {
        return { kind: "failed", retryable: true, reason: "Mapbox answered with something that was not a feature collection." };
      }
      const [feature] = body.features;
      if (!feature) return { kind: "not_found", reason: "Mapbox has no match for this address." };

      const [lng, lat] = feature.geometry?.coordinates ?? [];
      if (geo.parseLatLng(lat, lng) === null) {
        return { kind: "failed", retryable: false, reason: "Mapbox's answer had no usable coordinates." };
      }
      return {
        kind: "found", lat: lat!, lng: lng!,
        precision: precisionOf(feature),
        label: feature.properties?.full_address ?? null,
      };
    },
  };
}

registerGeocoder("mapbox", mapboxGeocoder);
