import { routes, type RouteName } from "../contracts/index";
import type { Method, RouteDefinition } from "../lib/define";

/**
 * MATCHING A REQUEST TO A ROUTE
 *
 * Kept apart from the dispatch, and pure, because this is the piece that
 * decides which code runs for a URL. A matcher that is a little bit wrong
 * serves a request from the wrong endpoint, and that is not a class of bug
 * anybody wants to find by reading logs.
 *
 * Paths are declared as `/v1/jobs/{id}/visits`. Segments are compared one for
 * one, so `/v1/jobs/{id}` never matches `/v1/jobs/abc/visits`, and a literal
 * segment wins over a parameter: `/v1/pricebook/items` is not served by a
 * route declared `/v1/pricebook/{id}`.
 */

export interface Match {
  name: RouteName;
  route: RouteDefinition;
  params: Record<string, string>;
}

interface Compiled {
  name: RouteName;
  route: RouteDefinition;
  method: Method;
  segments: string[];
  /** How many segments are literal. Used to prefer the more specific route. */
  specificity: number;
}

const split = (path: string): string[] =>
  path.split("/").filter((segment) => segment !== "");

const isParam = (segment: string): boolean =>
  segment.startsWith("{") && segment.endsWith("}");

const TABLE: Compiled[] = Object.entries(routes)
  .map(([name, route]) => {
    const definition = route as RouteDefinition;
    const segments = split(definition.path);
    return {
      name: name as RouteName,
      route: definition,
      method: definition.method,
      segments,
      specificity: segments.filter((s) => !isParam(s)).length,
    };
  })
  // Most literal segments first, so a specific route is tried before a
  // parameterised one that would also match.
  .sort((a, b) => b.specificity - a.specificity);

/**
 * The route for a method and path, or nothing.
 *
 * `pathMatched` separates the two failures a caller cares about. A path
 * nobody serves is a 404; a path served for a different method is a 405, and
 * answering 404 to the second sends an integrator hunting for a typo in a URL
 * that was correct.
 */
export function matchRoute(method: string, path: string): {
  match?: Match;
  pathMatched: boolean;
  allowed: Method[];
} {
  const wanted = method.toLowerCase() as Method;
  const parts = split(path);
  const allowed = new Set<Method>();
  let match: Match | undefined;

  for (const entry of TABLE) {
    if (entry.segments.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < entry.segments.length; i += 1) {
      const segment = entry.segments[i]!;
      const given = parts[i]!;
      if (isParam(segment)) {
        params[segment.slice(1, -1)] = decodeURIComponent(given);
      } else if (segment !== given) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    allowed.add(entry.method);
    if (entry.method === wanted && !match) {
      match = { name: entry.name, route: entry.route, params };
    }
  }

  return {
    ...(match ? { match } : {}),
    pathMatched: allowed.size > 0,
    allowed: [...allowed],
  };
}

/**
 * Query string to a plain object, with the coercions a URL forces on us.
 *
 * Everything in a query string is a string and the contracts are written
 * against real types: `limit` is a number, `includeInactive` is a boolean.
 * Coercing here rather than loosening every contract keeps the schema honest
 * about what the endpoint takes, which is what the OpenAPI document and any
 * generated client are built from.
 *
 * Only the two unambiguous coercions happen. A string that merely looks like a
 * number stays a string unless the schema asks for one, because a postal code
 * of "78701" is not 78701.
 */
export function queryToInput(
  search: URLSearchParams,
  shape: Record<string, "number" | "boolean" | "array" | "other">,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    const kind = shape[key] ?? "other";

    if (kind === "array") { out[key] = values; continue; }

    const value = values[values.length - 1]!;
    // An empty parameter is omitted rather than passed as "". A schema with a
    // default then applies it, which is what `?cursor=` should mean.
    if (value === "") continue;

    if (kind === "number") {
      const n = Number(value);
      // Left as the string when it is not a number, so the schema reports
      // "expected number, received string" rather than "received nan".
      out[key] = Number.isFinite(n) ? n : value;
    } else if (kind === "boolean" && (value === "true" || value === "false")) {
      out[key] = value === "true";
    } else {
      out[key] = value;
    }
  }
  return out;
}
