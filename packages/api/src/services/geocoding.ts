import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { geo, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { createGeocoder, type GeocodingProvider, type Clock } from "../maps/provider";
// Registers the adapters, so a connection's provider key resolves.
import "../maps";
import { within } from "./workflow-schedule";

/**
 * PUTTING ADDRESSES ON THE MAP
 *
 * `property.latitude` and `property.longitude` were in the first migration and
 * nothing filled them, so there could be no map and no measure of how far
 * apart two jobs are. This is what fills them, and it does it in the
 * BACKGROUND: the worker asks the company's geocoder, never the request that
 * saved the address. A geocoder that takes eight seconds, or is down, must
 * not be the reason a customer cannot be added while they are on the phone.
 *
 * WHAT TRIGGERS A LOOKUP. Not an event, and not a hook on every path that
 * writes an address: there are four such paths today (a property, a new
 * customer, an online booking, a lead) and the fifth would forget. Instead the
 * row carries a generated `address_key`, and a row whose stored coordinate
 * answers for a different key is due. A new address, an edited one and the
 * whole backlog from before this existed are the same condition, so the
 * backfill is not a separate job: connecting a geocoder is what starts it.
 *
 * WHAT IS NEVER TOUCHED: a pin a person placed. See `geo.geocodeDue`.
 *
 * ONE LOOKUP, THREE STEPS, AND THE NETWORK IS IN NONE OF THE TRANSACTIONS.
 *
 *   1. Claim the row: record which address is being tried and when to try
 *      again if this attempt dies, and write the `integration_event` the
 *      contributing rules require before any outbound call. The claim is a
 *      conditional update, so two workers racing for one row cannot both win.
 *   2. Ask the geocoder, outside any transaction.
 *   3. Write what it said, unless somebody placed a pin while it was asking.
 */

type Entity = "property" | "location";

export type SecretReader = (ref: string) => Promise<string>;

export interface GeocodeDeps {
  /** Reads a credential by the NAME on the connection. The environment by default. */
  readSecret?: SecretReader;
  /**
   * Builds the provider for a company's connection. Tests pass a fake here,
   * which is how nothing in the test suite ever reaches a network.
   */
  providerFor?: (connection: {
    provider: string; settings: Record<string, unknown>; secret: string | null;
  }) => GeocodingProvider;
  clock?: Clock;
  now?: () => Date;
}

const envSecret: SecretReader = async (ref) => {
  const value = process.env[ref];
  if (!value) throw new Error(`No secret in the environment for "${ref}"`);
  return value;
};

function systemActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "geocoder" };
}

export interface GeocodePass {
  looked: number;
  found: number;
  notFound: number;
  failed: number;
  /** Companies whose geocoder could not even be built, with why. */
  unusable: { organizationId: string; reason: string }[];
}

/**
 * One pass of the worker: a handful of due addresses, oldest priority first.
 *
 * Bounded by a time budget as well as a count, because the public
 * OpenStreetMap server answers one request a second and the rest of the
 * worker's pass (the texts, the workflows) must not wait behind a backfill of
 * four thousand customers. What does not fit goes on the next pass.
 */
export async function geocodePending(db: Database, options: {
  limit?: number;
  budgetMs?: number;
  shouldStop?: () => boolean;
  only?: readonly string[];
  deps?: GeocodeDeps;
} = {}): Promise<GeocodePass> {
  const deps = options.deps ?? {};
  const clock = deps.clock ?? { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
  const started = clock.now();
  const budget = options.budgetMs ?? 4_000;
  const outOfTime = () => (options.shouldStop?.() ?? false) || clock.now() - started >= budget;

  const due = within(options.only, await db.execute<{ organization_id: string; entity: Entity; entity_id: string }>(
    sql`select organization_id, entity, entity_id from app.addresses_to_geocode(${options.limit ?? 25})`,
  ));

  const pass: GeocodePass = { looked: 0, found: 0, notFound: 0, failed: 0, unusable: [] };
  const providers = new Map<string, GeocodingProvider | null>();

  for (const row of due) {
    if (outOfTime()) break;
    const ctx: ServiceContext = { actor: systemActor(row.organization_id), db };

    if (!providers.has(row.organization_id)) {
      providers.set(row.organization_id, await providerOf(ctx, deps).catch(async (error: unknown) => {
        const reason = (error as Error).message;
        pass.unusable.push({ organizationId: row.organization_id, reason });
        await noteConnectionError(ctx, reason);
        return null;
      }));
    }
    const provider = providers.get(row.organization_id);
    if (!provider) continue;

    const outcome = await lookUp(ctx, provider, row.entity, row.entity_id, deps);
    if (outcome === null) continue;
    pass.looked += 1;
    if (outcome.kind === "found") pass.found += 1;
    else if (outcome.kind === "not_found") pass.notFound += 1;
    else pass.failed += 1;
  }
  return pass;
}

/**
 * The company's geocoder. The OLDEST connected one when somebody has
 * connected two, so which service an address goes to does not change between
 * two passes for no visible reason.
 */
async function providerOf(ctx: ServiceContext, deps: GeocodeDeps): Promise<GeocodingProvider> {
  const connection = await inTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(schema.integrationConnection)
      .where(and(
        eq(schema.integrationConnection.capability, "maps"),
        eq(schema.integrationConnection.status, "connected"),
        isNull(schema.integrationConnection.deletedAt),
      ))
      .orderBy(asc(schema.integrationConnection.createdAt)).limit(1);
    return row ?? null;
  });
  if (!connection) throw new Error("No geocoder is connected.");
  const secret = connection.credentialRef
    ? await (deps.readSecret ?? envSecret)(connection.credentialRef)
    : null;
  const settings = (connection.settings ?? {}) as Record<string, unknown>;
  return deps.providerFor
    ? deps.providerFor({ provider: connection.provider, settings, secret })
    : createGeocoder(connection.provider, { settings, secret, ...(deps.clock ? { clock: deps.clock } : {}) });
}

/**
 * Said on the connection, so the integrations screen shows it. A geocoder
 * whose secret is missing otherwise fails silently forever, and the only
 * symptom is a map that never fills in.
 */
async function noteConnectionError(ctx: ServiceContext, reason: string | null): Promise<void> {
  await inTenant(ctx, async (tx) => {
    await tx.update(schema.integrationConnection)
      .set({ lastError: reason, lastCheckedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.integrationConnection.capability, "maps"),
        eq(schema.integrationConnection.status, "connected"),
      ));
  });
}

type GeoRow = {
  id: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  address_key: string;
  located_address: string | null;
  location_source: string | null;
  geocode_attempted_address: string | null;
  geocode_retry_at: Date | string | null;
  geocode_attempts: number;
};

/** Both tables carry the same columns, so one statement serves either. */
const tableOf = (entity: Entity) => sql.identifier(entity);

async function lookUp(
  ctx: ServiceContext, provider: GeocodingProvider, entity: Entity, id: string, deps: GeocodeDeps,
): Promise<geo.GeocodeOutcome | null> {
  const now = deps.now?.() ?? new Date();

  /** 1. Claim. */
  const claimed = await inTenant(ctx, async (tx) => {
    const rows = await tx.execute<GeoRow>(sql`
      select id, address_line1, address_line2, city, state, postal_code, country, address_key,
             located_address, location_source, geocode_attempted_address, geocode_retry_at, geocode_attempts
      from ${tableOf(entity)} where id = ${id} for update`);
    const row = rows[0];
    if (!row) return null;
    const state: geo.GeocodeState = {
      addressKey: row.address_key,
      locatedAddress: row.located_address,
      locationSource: row.location_source,
      attemptedAddress: row.geocode_attempted_address,
      retryAt: row.geocode_retry_at === null ? null : new Date(row.geocode_retry_at),
      attempts: row.geocode_attempts,
    };
    if (!geo.geocodeDue(state, now)) return null;

    const attempts = row.geocode_attempted_address === row.address_key ? row.geocode_attempts + 1 : 1;
    /**
     * A provisional retry time, written before the call. If this process
     * dies while the geocoder is answering, the row is due again after the
     * back off rather than on the very next pass, which against a free
     * service with a one a second limit is the difference between a crash
     * and a flood.
     */
    await tx.execute(sql`
      update ${tableOf(entity)}
         set geocode_attempted_address = address_key,
             geocode_attempts = ${attempts},
             geocode_retry_at = ${geo.retryAfter(attempts, now).toISOString()}::timestamptz
       where id = ${id}`);

    const query = geo.addressQuery({
      addressLine1: row.address_line1, city: row.city, state: row.state,
      postalCode: row.postal_code, country: row.country,
    });
    const [event] = await tx.insert(schema.integrationEvent).values({
      organizationId: ctx.actor.organizationId,
      direction: "outbound",
      provider: provider.name,
      eventType: "geocode",
      idempotencyKey: `geocode:${entity}:${id}:${createHash("sha256").update(row.address_key).digest("hex").slice(0, 16)}:${attempts}`,
      status: "in_flight",
      attempts: 1,
      requestPayload: { entity, query },
      entityType: entity,
      entityId: id,
    }).returning({ id: schema.integrationEvent.id });

    return {
      key: row.address_key, attempts, eventId: event!.id, query,
      address: {
        addressLine1: row.address_line1, addressLine2: row.address_line2, city: row.city,
        state: row.state, postalCode: row.postal_code, country: row.country,
      },
      previouslyLocated: row.located_address,
    };
  });
  if (!claimed) return null;

  /** 2. Ask, outside any transaction. */
  let outcome: geo.GeocodeOutcome;
  try {
    outcome = await provider.geocode({ query: claimed.query, address: claimed.address });
  } catch (error) {
    outcome = { kind: "failed", retryable: true, reason: `The geocoder threw: ${(error as Error).message}` };
  }

  /** 3. Write what it said. */
  await inTenant(ctx, async (tx) => {
    if (outcome.kind === "found") {
      /**
       * Not over a pin placed while the geocoder was answering, and not for
       * an address that changed while it was answering: the key in the
       * WHERE is the one this lookup was for, so a row edited in the
       * meantime is left due rather than given a coordinate for its old
       * address.
       */
      await tx.execute(sql`
        update ${tableOf(entity)}
           set latitude = ${geo.formatCoordinate(outcome.lat)},
               longitude = ${geo.formatCoordinate(outcome.lng)},
               location_precision = ${outcome.precision}::geocode_precision,
               location_source = ${provider.name},
               located_at = ${now.toISOString()}::timestamptz,
               located_address = ${claimed.key},
               geocode_retry_at = null,
               geocode_error = null,
               geocode_attempts = 0
         where id = ${id}
           and location_source is distinct from ${geo.PLACED_BY_HAND}
           and address_key = ${claimed.key}`);
    } else {
      const retryAt = outcome.kind === "failed" && outcome.retryable
        ? geo.retryAfter(claimed.attempts, now)
        : null;
      /**
       * A coordinate for a PREVIOUS address is taken off when the new one
       * cannot be found. Leaving it would put this customer's pin on the
       * house they moved out of, which is worse than no pin: no pin is
       * listed as not on the map, and a wrong pin is driven to.
       */
      await tx.execute(sql`
        update ${tableOf(entity)}
           set geocode_retry_at = ${retryAt?.toISOString() ?? null}::timestamptz,
               geocode_error = ${outcome.reason},
               latitude = case when located_address is distinct from address_key then null else latitude end,
               longitude = case when located_address is distinct from address_key then null else longitude end,
               location_precision = case when located_address is distinct from address_key then null else location_precision end,
               location_source = case when located_address is distinct from address_key then null else location_source end
         where id = ${id}
           and location_source is distinct from ${geo.PLACED_BY_HAND}`);
    }

    await tx.update(schema.integrationEvent).set({
      status: outcome.kind === "failed" ? "failed" : "succeeded",
      responsePayload: outcome.kind === "found"
        ? { kind: outcome.kind, precision: outcome.precision }
        : { kind: outcome.kind },
      error: outcome.kind === "found" ? null : outcome.reason,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.integrationEvent.id, claimed.eventId));

    /**
     * A credential the geocoder refuses is put on the connection, where the
     * integrations screen shows it; a success clears it.
     */
    if (outcome.kind === "found") {
      await tx.update(schema.integrationConnection)
        .set({ lastError: null, lastCheckedAt: new Date() })
        .where(and(
          eq(schema.integrationConnection.capability, "maps"),
          eq(schema.integrationConnection.provider, provider.name),
        ));
    } else if (outcome.kind === "failed" && !outcome.retryable) {
      await tx.update(schema.integrationConnection)
        .set({ lastError: outcome.reason, lastCheckedAt: new Date() })
        .where(and(
          eq(schema.integrationConnection.capability, "maps"),
          eq(schema.integrationConnection.provider, provider.name),
        ));
    }
  });
  return outcome;
}

/* ------------------------------------------------------------------ pins */

export interface Located {
  id: string;
  latitude: string | null;
  longitude: string | null;
  locationPrecision: geo.GeocodePrecision | null;
  locationSource: string | null;
}

/**
 * A pin placed by hand.
 *
 * It wins from then on: `location_source` is `manual`, and the worker's
 * finder, its in-tenant check and its final write each refuse to touch a row
 * in that state. The coordinate is refused if it is not a place on Earth, or
 * is null island, for the reason `geo.parseLatLng` gives.
 */
export async function placePin(
  ctx: ServiceContext, input: { entity: Entity; id: string; latitude: number; longitude: number },
): Promise<Located> {
  const permission = input.entity === "property" ? "property:write" : "settings:write";
  return guardedWrite(ctx, permission, async (tx) => {
    const at = geo.parseLatLng(input.latitude, input.longitude);
    if (!at) {
      throw new ConflictError("That is not a place on the map. A pin needs a latitude and a longitude, and 0, 0 is the sea.");
    }
    const before = await located(tx, input.entity, input.id);
    const rows = await tx.execute<Located & Record<string, unknown>>(sql`
      update ${tableOf(input.entity)}
         set latitude = ${geo.formatCoordinate(at.lat)},
             longitude = ${geo.formatCoordinate(at.lng)},
             location_precision = 'placed'::geocode_precision,
             location_source = ${geo.PLACED_BY_HAND},
             located_at = now(),
             located_address = address_key,
             geocode_retry_at = null,
             geocode_error = null,
             geocode_attempts = 0,
             updated_at = now()
       where id = ${input.id}
       returning id, latitude, longitude, location_precision as "locationPrecision", location_source as "locationSource"`);
    const after = rows[0]!;
    await audit(tx, ctx, `${input.entity}.pinned`, input.entity, input.id, before, after);
    return pick(after);
  });
}

/**
 * Take a placed pin off and hand the row back to the geocoder, which finds
 * it due on its next pass because nothing answers for its address any more.
 */
export async function clearPin(
  ctx: ServiceContext, input: { entity: Entity; id: string },
): Promise<Located> {
  const permission = input.entity === "property" ? "property:write" : "settings:write";
  return guardedWrite(ctx, permission, async (tx) => {
    const before = await located(tx, input.entity, input.id);
    const rows = await tx.execute<Located & Record<string, unknown>>(sql`
      update ${tableOf(input.entity)}
         set latitude = null, longitude = null, location_precision = null, location_source = null,
             located_at = null, located_address = null,
             geocode_attempted_address = null, geocode_attempts = 0,
             geocode_retry_at = null, geocode_error = null,
             updated_at = now()
       where id = ${input.id}
       returning id, latitude, longitude, location_precision as "locationPrecision", location_source as "locationSource"`);
    await audit(tx, ctx, `${input.entity}.unpinned`, input.entity, input.id, before, rows[0]!);
    return pick(rows[0]!);
  });
}

const pick = (row: Located): Located => ({
  id: row.id, latitude: row.latitude, longitude: row.longitude,
  locationPrecision: row.locationPrecision, locationSource: row.locationSource,
});

async function located(tx: Database, entity: Entity, id: string): Promise<Located> {
  /**
   * A property that has been merged away is not a place to pin; a location
   * is retired with `active`, and pinning a closed branch is harmless.
   */
  const rows = await tx.execute<Located & Record<string, unknown>>(sql`
    select id, latitude, longitude, location_precision as "locationPrecision", location_source as "locationSource"
    from ${tableOf(entity)}
    where id = ${id} ${entity === "property" ? sql`and deleted_at is null` : sql``}`);
  if (!rows[0]) throw new NotFoundError(entity === "property" ? "Property" : "Location");
  return pick(rows[0]);
}

/* ---------------------------------------------------------------- status */

/**
 * How much of the company is on the map.
 *
 * The addresses the geocoder could not find are listed by name, because a
 * count of them is something nobody acts on and a list is twenty minutes of
 * somebody placing pins.
 */
export async function status(ctx: ServiceContext) {
  return guardedRead(ctx, "property:read", async (tx) => {
    const [connection] = await tx.select({ provider: schema.integrationConnection.provider })
      .from(schema.integrationConnection)
      .where(and(
        eq(schema.integrationConnection.capability, "maps"),
        eq(schema.integrationConnection.status, "connected"),
        isNull(schema.integrationConnection.deletedAt),
      ))
      .orderBy(asc(schema.integrationConnection.createdAt)).limit(1);

    const counts = await tx.execute<{ precision: string | null; waiting: boolean; failing: boolean; n: number }>(sql`
      select location_precision::text as precision,
             (location_precision is null and geocode_attempted_address is distinct from address_key) as waiting,
             (location_precision is null and geocode_retry_at is not null) as failing,
             count(*)::int as n
      from public.property
      where deleted_at is null
      group by 1, 2, 3`);
    const byPrecision: Record<string, number> = {};
    let total = 0;
    let waiting = 0;
    let failing = 0;
    for (const row of counts) {
      total += row.n;
      if (row.precision) byPrecision[row.precision] = (byPrecision[row.precision] ?? 0) + row.n;
      else if (row.failing) failing += row.n;
      else if (row.waiting) waiting += row.n;
    }

    const missing = await tx.execute<{ id: string; address: string; reason: string | null }>(sql`
      select id, concat_ws(', ', address_line1, city, state, postal_code) as address, geocode_error as reason
      from public.property
      where deleted_at is null
        and location_precision is null
        and geocode_attempted_address = address_key
        and geocode_retry_at is null
      order by created_at desc
      limit 100`);

    return {
      geocoder: connection?.provider ?? null,
      total,
      byPrecision,
      waiting,
      notFound: missing.map((m) => ({ propertyId: m.id, address: m.address, reason: m.reason })),
      failing,
    };
  });
}

export const handlers = {
  pinProperty: (ctx: ServiceContext, input: { id: string; latitude: number; longitude: number }) =>
    placePin(ctx, { entity: "property", ...input }),
  unpinProperty: (ctx: ServiceContext, input: { id: string }) => clearPin(ctx, { entity: "property", id: input.id }),
  pinLocation: (ctx: ServiceContext, input: { id: string; latitude: number; longitude: number }) =>
    placePin(ctx, { entity: "location", ...input }),
  unpinLocation: (ctx: ServiceContext, input: { id: string }) => clearPin(ctx, { entity: "location", id: input.id }),
  getGeocodingStatus: (ctx: ServiceContext) => status(ctx),
} as const;
