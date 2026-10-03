import type { geo } from "@opentradesos/core";

/**
 * THE ROUTING SEAM: HOW LONG THE DRIVE ACTUALLY IS
 *
 * `routing` has been a member of the capability enum since the first
 * migration with nothing behind it, so every drive time in the product was a
 * straight line stretched by a road factor. That is about right across a day
 * and wrong for any river with one bridge. A provider here answers the one
 * question the optimiser, the rebalance and the customer's ETA all ask: how
 * many minutes by road from each of these points to each of those.
 *
 * A MATRIX, NOT A ROUTE. Ordering a day of twelve stops needs every pair, and
 * asking for them one at a time is a hundred and forty four requests where a
 * matrix is one. All three adapters speak a table endpoint.
 *
 * FAILURE IS AN ANSWER. An adapter returns `failed` rather than throwing, and
 * the caller falls back to the straight line estimate for the pairs it could
 * not get and says so, because a dispatcher whose optimiser stopped working
 * when a routing server restarted would stop trusting it for good.
 *
 * HOW LONG AN ANSWER MAY BE KEPT IS THE PROVIDER'S CALL, declared as
 * `keepForSeconds`: a company's own OSRM is theirs to cache for weeks, a
 * commercial service's terms decide for its answers.
 */

export interface MatrixRequest {
  sources: geo.LatLng[];
  destinations: geo.LatLng[];
}

export type MatrixOutcome =
  /** Rows are sources, columns destinations. Null where the provider found no road between them. */
  | { kind: "ok"; minutes: (number | null)[][]; meters: (number | null)[][] | null }
  | { kind: "failed"; reason: string; retryable: boolean };

export interface RoutingProvider {
  readonly name: string;
  /** How long one answer may be kept before it is asked again. */
  readonly keepForSeconds: number;
  /** The most points (sources and destinations together) one request may carry. */
  readonly maxPoints: number;
  matrix(request: MatrixRequest): Promise<MatrixOutcome>;
}

export interface RouterOptions {
  settings: Record<string, unknown>;
  /** The resolved credential, for a provider that takes one. Never stored. */
  secret: string | null;
  /** Injected in tests, so nothing here ever reaches a network from a test. */
  fetch?: typeof fetch;
}

export class RouterNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No routing provider registered as "${provider}"`);
    this.name = "RouterNotConfiguredError";
  }
}

const registry = new Map<string, (options: RouterOptions) => RoutingProvider>();

/** Registered rather than imported, the same as every other seam in this package. */
export function registerRouter(name: string, factory: (options: RouterOptions) => RoutingProvider): void {
  registry.set(name, factory);
}

export function createRouter(name: string, options: RouterOptions): RoutingProvider {
  const factory = registry.get(name);
  if (!factory) throw new RouterNotConfiguredError(name);
  return factory(options);
}

export const registeredRouters = (): string[] => [...registry.keys()];

/**
 * Seconds to whole minutes, the way `geo.driveMinutes` rounds: up, and never
 * zero between two different places, because a drive of forty seconds is
 * still getting back in the van.
 */
export function minutesOf(seconds: number | null | undefined, samePlace: boolean): number | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  if (samePlace) return 0;
  return Math.max(1, Math.ceil(seconds / 60));
}

/** A table from the provider, checked for shape and turned into minutes. */
export function tableFrom(
  request: MatrixRequest,
  durations: unknown,
  distances: unknown,
): MatrixOutcome {
  if (!Array.isArray(durations) || durations.length !== request.sources.length) {
    return { kind: "failed", retryable: true, reason: "The routing service answered with a table of the wrong size." };
  }
  const minutes: (number | null)[][] = [];
  for (const [i, row] of durations.entries()) {
    if (!Array.isArray(row) || row.length !== request.destinations.length) {
      return { kind: "failed", retryable: true, reason: "The routing service answered with a table of the wrong size." };
    }
    const from = request.sources[i]!;
    minutes.push(row.map((value: unknown, j) => {
      const to = request.destinations[j]!;
      return minutesOf(typeof value === "number" ? value : null, from.lat === to.lat && from.lng === to.lng);
    }));
  }
  const meters = Array.isArray(distances)
    ? distances.map((row: unknown) => Array.isArray(row)
      ? row.map((value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null))
      : request.destinations.map(() => null))
    : null;
  return { kind: "ok", minutes, meters };
}

/** The same split the geocoders make: a 429 and a 5xx may clear, anything else will not. */
export function failureFrom(status: number, body: string): MatrixOutcome {
  const retryable = status === 429 || status >= 500;
  const detail = body.trim().slice(0, 200);
  return {
    kind: "failed",
    retryable,
    reason: status === 401 || status === 403
      ? `The routing service refused the credential (${status}). Check the secret name on the integrations screen.`
      : `The routing service answered ${status}${detail ? `: ${detail}` : ""}.`,
  };
}

export const USER_AGENT = "OpenTradesOS/1.0 (dispatch routing; https://github.com/open-trades-os/open-trades-os)";

export const DAY_SECONDS = 86_400;
