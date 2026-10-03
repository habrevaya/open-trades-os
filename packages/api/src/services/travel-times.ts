import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { geo, type routing } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import { createRouter, type RoutingProvider } from "../routing/provider";
// Registers the adapters, so a connection's provider key resolves.
import "../routing";

/**
 * DRIVE TIMES BY ROAD, WHEN THE COMPANY HAS A ROAD NETWORK TO ASK
 *
 * One function the optimiser, the rebalance, the assignment suggestions and
 * the customer's ETA all call: the minutes between every pair of a set of
 * points. With a routing provider connected (capability `routing`: OSRM,
 * Mapbox or OpenRouteService), by road, from `travel_time` where the pair was
 * asked before and from the provider where it was not. With none, or when the
 * provider fails, the straight line estimate `geo.driveMinutes` has always
 * given, and the answer SAYS WHICH: `source` is `road`, `estimate`, or
 * `mixed` when some pairs came from each, and a failure is carried in words.
 *
 * THE NETWORK IS IN NO TRANSACTION. The cache is read in one, the provider is
 * asked outside any, and the answers are written in a third, the same three
 * steps the geocoder takes, so a routing server that takes ten seconds holds
 * no locks and no connection while it thinks. Callers load what they need,
 * then call this, then compute: see `services/dispatch-map.ts`.
 */

export type TravelSource = "road" | "estimate" | "mixed";

export interface TravelMatrix {
  /** Minutes between two keys. Zero when either is not on the map, which callers check first. */
  travel: routing.Travel;
  source: TravelSource;
  /** The connected provider's key, or null when there is none. */
  provider: string | null;
  /** Why some or all of the drives are estimates although a provider is connected. */
  failure: string | null;
}

export interface TravelDeps {
  /** Reads a credential by the NAME on the connection. The environment by default. */
  readSecret?: (ref: string) => Promise<string>;
  now?: () => Date;
}

const envSecret = async (ref: string) => {
  const value = process.env[ref];
  if (!value) throw new Error(`No secret in the environment for "${ref}"`);
  return value;
};

/**
 * The company's routing provider, or null. The OLDEST connected one, so which
 * service answers does not change between two optimisations for no visible
 * reason, the same rule the geocoder follows.
 */
async function routerOf(ctx: ServiceContext, deps: TravelDeps): Promise<{ provider: RoutingProvider | null; error: string | null }> {
  const connection = await inTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(schema.integrationConnection)
      .where(and(
        eq(schema.integrationConnection.capability, "routing"),
        eq(schema.integrationConnection.status, "connected"),
        isNull(schema.integrationConnection.deletedAt),
      ))
      .orderBy(asc(schema.integrationConnection.createdAt)).limit(1);
    return row ?? null;
  });
  if (!connection) return { provider: null, error: null };
  try {
    const secret = connection.credentialRef ? await (deps.readSecret ?? envSecret)(connection.credentialRef) : null;
    return {
      provider: createRouter(connection.provider, { settings: (connection.settings ?? {}) as Record<string, unknown>, secret }),
      error: null,
    };
  } catch (error) {
    return { provider: null, error: (error as Error).message };
  }
}

/** Whether a road network is connected, for a screen that wants to say which drive times it shows. */
export async function connectedRouter(ctx: ServiceContext): Promise<string | null> {
  return inTenant(ctx, async (tx) => {
    const [row] = await tx.select({ provider: schema.integrationConnection.provider })
      .from(schema.integrationConnection)
      .where(and(
        eq(schema.integrationConnection.capability, "routing"),
        eq(schema.integrationConnection.status, "connected"),
        isNull(schema.integrationConnection.deletedAt),
      ))
      .orderBy(asc(schema.integrationConnection.createdAt)).limit(1);
    return row?.provider ?? null;
  });
}

/**
 * Minutes between every pair of `points` that are on the map.
 *
 * `declared` is consulted first for each pair, so a route's own declared
 * drive time beats the road network as it beats the straight line: the
 * person who drives the route knows the gate is locked after five.
 */
export async function travelMatrix(
  ctx: ServiceContext,
  points: ReadonlyMap<string, geo.LatLng | null>,
  options: {
    assumptions: geo.DriveAssumptions;
    declared?: (from: string, to: string) => number | null;
    deps?: TravelDeps;
  },
): Promise<TravelMatrix> {
  const deps = options.deps ?? {};
  const now = deps.now?.() ?? new Date();

  const keyOf = new Map<string, string>();
  const placeOf = new Map<string, geo.LatLng>();
  for (const [id, at] of points) {
    if (!at) continue;
    const key = geo.coordinateKey(at);
    keyOf.set(id, key);
    if (!placeOf.has(key)) placeOf.set(key, at);
  }
  const coordinates = [...placeOf.keys()].sort();

  const { provider, error } = await routerOf(ctx, deps);
  const road = new Map<string, number>();
  let failure = error;

  if (provider && coordinates.length > 1) {
    /** 1. What is already known and still fresh. */
    const cached = await inTenant(ctx, (tx) => tx.select({
      originKey: schema.travelTime.originKey,
      destinationKey: schema.travelTime.destinationKey,
      minutes: schema.travelTime.minutes,
    }).from(schema.travelTime).where(and(
      eq(schema.travelTime.provider, provider.name),
      inArray(schema.travelTime.originKey, coordinates),
      inArray(schema.travelTime.destinationKey, coordinates),
      gt(schema.travelTime.expiresAt, now),
    )));
    for (const row of cached) road.set(`${row.originKey}|${row.destinationKey}`, row.minutes);

    const missingFrom = coordinates.filter((a) => coordinates.some((b) => a !== b && !road.has(`${a}|${b}`)));
    const missingTo = coordinates.filter((b) => coordinates.some((a) => a !== b && !road.has(`${a}|${b}`)));

    if (missingFrom.length > 0) {
      /** 2. Ask, in blocks the provider accepts, outside any transaction. */
      const half = Math.max(1, Math.floor(provider.maxPoints / 2));
      const fresh: { originKey: string; destinationKey: string; minutes: number; meters: number | null }[] = [];
      for (let i = 0; i < missingFrom.length && !failure; i += half) {
        const sources = missingFrom.slice(i, i + half);
        for (let j = 0; j < missingTo.length && !failure; j += half) {
          const destinations = missingTo.slice(j, j + half);
          const outcome = await ask(ctx, provider, sources, destinations, placeOf);
          if (outcome.kind === "failed") {
            failure = outcome.reason;
            break;
          }
          for (const [r, origin] of sources.entries()) {
            for (const [c, destination] of destinations.entries()) {
              const minutes = outcome.minutes[r]?.[c] ?? null;
              if (minutes === null || origin === destination) continue;
              road.set(`${origin}|${destination}`, minutes);
              fresh.push({ originKey: origin, destinationKey: destination, minutes, meters: outcome.meters?.[r]?.[c] ?? null });
            }
          }
        }
      }

      /** 3. Keep what came back, for as long as the provider allows. */
      if (fresh.length > 0) {
        const expiresAt = new Date(now.getTime() + provider.keepForSeconds * 1000);
        await inTenant(ctx, async (tx) => {
          for (let k = 0; k < fresh.length; k += 500) {
            await tx.insert(schema.travelTime).values(fresh.slice(k, k + 500).map((f) => ({
              organizationId: ctx.actor.organizationId,
              provider: provider.name,
              originKey: f.originKey,
              destinationKey: f.destinationKey,
              minutes: f.minutes,
              meters: f.meters,
              computedAt: now,
              expiresAt,
            }))).onConflictDoUpdate({
              target: [schema.travelTime.organizationId, schema.travelTime.provider,
                schema.travelTime.originKey, schema.travelTime.destinationKey],
              set: {
                minutes: sql`excluded.minutes`, meters: sql`excluded.meters`,
                computedAt: sql`excluded.computed_at`, expiresAt: sql`excluded.expires_at`,
              },
            });
          }
        });
      }
    }
    await noteConnection(ctx, provider.name, failure);
  }

  /**
   * Which kind of answer the caller got, decided over the pairs it could ask
   * about, so a screen can say "by road" only when every drive was.
   */
  let roadPairs = 0;
  let estimatedPairs = 0;
  for (const a of coordinates) {
    for (const b of coordinates) {
      if (a === b) continue;
      if (road.has(`${a}|${b}`)) roadPairs += 1;
      else estimatedPairs += 1;
    }
  }
  const source: TravelSource = roadPairs === 0 ? "estimate" : estimatedPairs === 0 ? "road" : "mixed";

  const travel: routing.Travel = (from, to) => {
    if (from === to) return 0;
    const declared = options.declared?.(from, to) ?? null;
    if (declared !== null) return declared;
    const a = keyOf.get(from);
    const b = keyOf.get(to);
    if (!a || !b) return 0;
    if (a === b) return 0;
    const byRoad = road.get(`${a}|${b}`);
    if (byRoad !== undefined) return byRoad;
    return geo.driveMinutes(placeOf.get(a)!, placeOf.get(b)!, options.assumptions);
  };

  return {
    travel,
    source,
    provider: provider?.name ?? null,
    failure,
  };
}

/**
 * One request to the provider, recorded as an `integration_event` before it
 * goes, as every outbound call in this product is, so a deployment can see
 * what it asked a metered service and when.
 */
async function ask(
  ctx: ServiceContext,
  provider: RoutingProvider,
  sources: string[],
  destinations: string[],
  placeOf: Map<string, geo.LatLng>,
) {
  const digest = createHash("sha256").update(`${sources.join(";")}>${destinations.join(";")}`).digest("hex").slice(0, 16);
  const eventId = await inTenant(ctx, async (tx) => {
    const [event] = await tx.insert(schema.integrationEvent).values({
      organizationId: ctx.actor.organizationId,
      direction: "outbound",
      provider: provider.name,
      eventType: "travel_matrix",
      idempotencyKey: `travel-matrix:${digest}:${Date.now()}`,
      status: "in_flight",
      attempts: 1,
      requestPayload: { sources: sources.length, destinations: destinations.length },
    }).returning({ id: schema.integrationEvent.id });
    return event!.id;
  });

  let outcome: Awaited<ReturnType<RoutingProvider["matrix"]>>;
  try {
    outcome = await provider.matrix({
      sources: sources.map((k) => placeOf.get(k)!),
      destinations: destinations.map((k) => placeOf.get(k)!),
    });
  } catch (error) {
    outcome = { kind: "failed", retryable: true, reason: `The routing service threw: ${(error as Error).message}` };
  }

  await inTenant(ctx, (tx) => tx.update(schema.integrationEvent).set({
    status: outcome.kind === "ok" ? "succeeded" : "failed",
    error: outcome.kind === "ok" ? null : outcome.reason,
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(schema.integrationEvent.id, eventId)));
  return outcome;
}

/**
 * Said on the connection, so the integrations screen shows a routing server
 * that has stopped answering; a success clears it.
 */
async function noteConnection(ctx: ServiceContext, provider: string, failure: string | null): Promise<void> {
  await inTenant(ctx, (tx) => tx.update(schema.integrationConnection)
    .set({ lastError: failure, lastCheckedAt: new Date() })
    .where(and(
      eq(schema.integrationConnection.capability, "routing"),
      eq(schema.integrationConnection.provider, provider),
    )));
}

/** In words, for the screens that show a drive time. */
export function describeSource(matrix: Pick<TravelMatrix, "source" | "provider" | "failure">): string {
  if (matrix.source === "road") return `Drive times by road, from ${providerLabel(matrix.provider)}.`;
  if (matrix.source === "mixed") {
    return `Most drive times by road from ${providerLabel(matrix.provider)}; the rest are straight line estimates${matrix.failure ? ` because ${lower(matrix.failure)}` : ""}.`;
  }
  if (matrix.failure) return `Drive times are straight line estimates, because ${lower(matrix.failure)}`;
  return "Drive times are straight line estimates. Connect a routing service under Settings, Integrations for times by road.";
}

const providerLabel = (key: string | null) =>
  key === "osrm" ? "your OSRM server"
  : key === "mapbox_directions" ? "Mapbox"
  : key === "openrouteservice" ? "OpenRouteService"
  : key ?? "the routing service";

const lower = (s: string) => (s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s);
