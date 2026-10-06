import { trimTrailingSlashes, type geo } from "@opentradesos/core";
import {
  registerGeocoder, pace, realClock, failureFrom, USER_AGENT,
  type GeocoderOptions, type GeocodingProvider,
} from "./provider";

/**
 * NOMINATIM: OPENSTREETMAP'S OWN GEOCODER
 *
 * The adapter that needs no key and no account, so a company can put its
 * customers on a map the afternoon it installs this. It speaks to any
 * Nominatim compatible endpoint: the public server at
 * nominatim.openstreetmap.org by default, or one the company runs itself,
 * which is what anybody with more than a few thousand addresses should do.
 *
 * THE PUBLIC SERVER'S USAGE POLICY, AND WHAT THIS ADAPTER DOES ABOUT EACH
 * PART OF IT (https://operations.osmfoundation.org/policies/nominatim/):
 *
 *   An absolute maximum of one request a second. Enforced here per endpoint
 *   per process, with a floor that cannot be configured below it for the
 *   public host: a setting can make it slower, never faster.
 *   A valid User-Agent identifying the application. Every request carries
 *   one, with the operator's contact address on it when they give one.
 *   Results must be cached. They are, permanently, on the property, and an
 *   address is never asked twice unless it changes.
 *   No bulk geocoding of large amounts of data. A backfill of a company's
 *   whole customer list is exactly that, so the worker sends it a handful a
 *   pass at one a second, and the docs tell a company with a large list to
 *   point this at its own server or use the commercial adapter.
 *   Attribution. The map that draws these points credits OpenStreetMap
 *   contributors, and so does every pin's caption.
 *
 * A STRUCTURED SEARCH, NOT FREE TEXT. Street, city, state and postcode go in
 * their own parameters, so a house number is never mistaken for a postcode
 * and a city called Paris in Texas is not answered in France.
 */

export const PUBLIC_ENDPOINT = "https://nominatim.openstreetmap.org";
const PUBLIC_MIN_INTERVAL_MS = 1_100;

interface Place {
  lat?: string;
  lon?: string;
  place_rank?: number;
  addresstype?: string;
  category?: string;
  type?: string;
  display_name?: string;
}

/**
 * How close the answer is, from what Nominatim says it found. Rank 30 is a
 * building or a numbered house; 26 to 29 is a road; a postcode is named as
 * one; anything coarser is a town or a county and is called a locality.
 */
export function precisionOf(place: Place): Exclude<geo.GeocodePrecision, "placed"> {
  if (place.addresstype === "postcode" || place.type === "postcode") return "postal_code";
  const rank = place.place_rank ?? 0;
  if (rank >= 30) return "rooftop";
  if (rank >= 26) return "street";
  return "locality";
}

export function nominatimGeocoder(options: GeocoderOptions): GeocodingProvider {
  const settings = options.settings;
  /**
   * The deployment's own server when its operator set one. A connection's
   * `endpoint` reaches here only where endpoint overrides are allowed, which
   * is the test suites: a company cannot point the server's requests, and its
   * customers' addresses, at a host of its choosing.
   */
  const endpoint = trimTrailingSlashes(String(
    settings["endpoint"] ?? (process.env["NOMINATIM_URL"]?.trim() || PUBLIC_ENDPOINT),
  ));
  const isPublic = new URL(endpoint).hostname === new URL(PUBLIC_ENDPOINT).hostname;
  const configured = typeof settings["minIntervalMs"] === "number" ? settings["minIntervalMs"] : 0;
  const minInterval = isPublic ? Math.max(PUBLIC_MIN_INTERVAL_MS, configured) : Math.max(0, configured);
  const contact = typeof settings["contactEmail"] === "string" && settings["contactEmail"].trim() !== ""
    ? settings["contactEmail"].trim()
    : null;
  const countryCodes = Array.isArray(settings["countryCodes"])
    ? (settings["countryCodes"] as string[]).map((c) => c.trim().toLowerCase()).filter(Boolean)
    : [];
  const doFetch = options.fetch ?? fetch;
  const clock = options.clock ?? realClock;

  return {
    name: "nominatim",
    async geocode(request) {
      const a = request.address;
      const params = new URLSearchParams({ format: "jsonv2", limit: "1" });
      if (a.addressLine1) params.set("street", a.addressLine1.trim());
      if (a.city) params.set("city", a.city.trim());
      if (a.state) params.set("state", a.state.trim());
      if (a.postalCode) params.set("postalcode", a.postalCode.trim());
      if (a.country) params.set("country", a.country.trim());
      if (countryCodes.length > 0) params.set("countrycodes", countryCodes.join(","));
      /**
       * The policy asks heavy users to identify themselves with an address
       * they read, and Nominatim takes it as a parameter as well as in the
       * agent string.
       */
      if (contact) params.set("email", contact);

      await pace(endpoint, minInterval, clock);
      let response: Response;
      try {
        response = await doFetch(`${endpoint}/search?${params.toString()}`, {
          headers: {
            "user-agent": contact ? `${USER_AGENT} contact ${contact}` : USER_AGENT,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        return { kind: "failed", retryable: true, reason: `The geocoder could not be reached: ${(error as Error).message}` };
      }
      if (!response.ok) return failureFrom(response.status, await response.text().catch(() => ""));

      const places = await response.json().catch(() => null) as Place[] | null;
      if (!Array.isArray(places)) {
        return { kind: "failed", retryable: true, reason: "The geocoder answered with something that was not a list of places." };
      }
      const [place] = places;
      if (!place) return { kind: "not_found", reason: "OpenStreetMap has no match for this address." };

      const lat = Number(place.lat);
      const lng = Number(place.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { kind: "failed", retryable: false, reason: "The geocoder's answer had no usable coordinates." };
      }
      return { kind: "found", lat, lng, precision: precisionOf(place), label: place.display_name ?? null };
    },
  };
}

registerGeocoder("nominatim", nominatimGeocoder);
