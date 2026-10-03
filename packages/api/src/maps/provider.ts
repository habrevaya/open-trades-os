import type { geo } from "@opentradesos/core";
import { adapterSettings } from "../secrets/endpoints";

/**
 * THE GEOCODING SEAM
 *
 * `maps` has been a member of the capability enum since the first migration,
 * with a note in `schema/integrations.ts` about which vendors may be cached
 * and which may not, and nothing behind it. This is the first provider, and
 * the first thing that ever filled `property.latitude`.
 *
 * A provider answers one question: where is this address, and how sure are
 * you. NOT FOUND IS AN ANSWER, NOT AN ERROR, and it comes back as a value
 * rather than a throw, because the worker treats the two completely
 * differently: an address the geocoder cannot find is not asked about again
 * until somebody changes it, and a timeout is asked about again after a back
 * off. An adapter that threw for both would have the worker either hammering
 * a free service with an address that will never resolve or giving up on one
 * that was only unlucky.
 *
 * EVERY PROVIDER HERE MAY BE STORED PERMANENTLY. That is a property of the
 * vendor's terms, not of the code, and it is why Google is not an adapter:
 * Google's terms cap caching coordinates at thirty days and bar showing them
 * on a map that is not Google's, and this product keeps a property's
 * coordinates for as long as it keeps the property and draws them on
 * OpenStreetMap tiles. Mapbox sells a permanent tier for exactly this, and
 * OpenStreetMap data is open under the ODbL.
 */

export interface GeocodeRequest {
  /** The one line `geo.addressQuery` builds, for providers that take free text. */
  query: string;
  /** The same address in parts, for providers that take a structured search. */
  address: geo.AddressParts;
}

export interface GeocodingProvider {
  readonly name: string;
  geocode(request: GeocodeRequest): Promise<geo.GeocodeOutcome>;
}

export interface GeocoderOptions {
  settings: Record<string, unknown>;
  /** The resolved credential, for a provider that takes one. Never stored. */
  secret: string | null;
  /** Injected in tests, so nothing here ever reaches a network from a test. */
  fetch?: typeof fetch;
  /** Injected in tests, so a rate limit does not make a test sit and wait. */
  clock?: Clock;
}

export class GeocoderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No geocoder registered as "${provider}"`);
    this.name = "GeocoderNotConfiguredError";
  }
}

const registry = new Map<string, (options: GeocoderOptions) => GeocodingProvider>();

/** Registered rather than imported, the same as every other seam in this package. */
export function registerGeocoder(name: string, factory: (options: GeocoderOptions) => GeocodingProvider): void {
  registry.set(name, factory);
}

export function createGeocoder(name: string, options: GeocoderOptions): GeocodingProvider {
  const factory = registry.get(name);
  if (!factory) throw new GeocoderNotConfiguredError(name);
  // Never a stored endpoint override: see `adapterSettings`. Mapbox's token
  // travels in the query string, so a `baseUrl` would receive it.
  return factory({ ...options, settings: adapterSettings(name, options.settings) });
}

export const registeredGeocoders = (): string[] => [...registry.keys()];

/* ------------------------------------------------------------- the pace */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * One request per interval, per endpoint, per process.
 *
 * Keyed by the endpoint rather than by the connection, because the limit
 * belongs to the service being asked. Two companies on one deployment both
 * using the public OpenStreetMap server share its one request a second, and
 * a limiter per company would send two.
 *
 * Per process and not across processes: a deployment running three workers
 * against the public server sends three a second. The docs say to run one
 * worker, or your own geocoder, which is what the policy asks of anybody
 * sending volume anyway.
 */
const lastCall = new Map<string, number>();

export async function pace(key: string, minIntervalMs: number, clock: Clock): Promise<void> {
  const previous = lastCall.get(key);
  const now = clock.now();
  if (previous !== undefined) {
    const wait = previous + minIntervalMs - now;
    if (wait > 0) await clock.sleep(wait);
  }
  lastCall.set(key, Math.max(now, (previous ?? 0) + minIntervalMs));
}

/** For tests: forget every endpoint's last call. */
export function resetPace(): void {
  lastCall.clear();
}

/** The identification every request carries. A stock library agent is refused by the public servers. */
export const USER_AGENT = "OpenTradesOS/1.0 (dispatch geocoder; https://github.com/open-trades-os/open-trades-os)";

/**
 * A failure in the shape the worker wants: a 429 and a 5xx might clear, so
 * they are retried after a back off; any other 4xx is a request this
 * adapter built wrong or a credential that does not work, and asking again
 * gets the same answer.
 */
export function failureFrom(status: number, body: string): geo.GeocodeOutcome {
  const retryable = status === 429 || status >= 500;
  const detail = body.trim().slice(0, 200);
  return {
    kind: "failed",
    retryable,
    reason: status === 401 || status === 403
      ? `The geocoder refused the credential (${status}). Check the secret name on the integrations screen.`
      : `The geocoder answered ${status}${detail ? `: ${detail}` : ""}.`,
  };
}
