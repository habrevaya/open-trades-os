import { sql } from "drizzle-orm";
import { numeric, timestamp, uuid, char, text, jsonb, integer, pgEnum, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Money is NEVER a float. Every monetary column is numeric(14,4) and travels
 * with a currency code. Four decimal places because unit costs, tax rates and
 * commission splits routinely need more precision than cents, and rounding is
 * applied once at the document total rather than on every line.
 */
export const money = (name: string) => numeric(name, { precision: 14, scale: 4 });

/** ISO 4217. Denormalized onto documents so historical records never re-derive it. */
export const currency = (name = "currency") => char(name, { length: 3 }).notNull().default("USD");

/** Rates and percentages: 0.0825 for 8.25%. Same no-floats rule. */
export const rate = (name: string) => numeric(name, { precision: 9, scale: 6 });

export const pk = () => uuid("id").primaryKey().defaultRandom();

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};

/**
 * Provenance for anything that arrived through open-trades-os-migration.
 * Keeping the source id and raw payload is what makes an import idempotent,
 * re-runnable and reconcilable instead of a restore-from-backup situation.
 */
export const sourceRef = {
  sourceSystem: text("source_system"),
  sourceId: text("source_id"),
  sourcePayload: jsonb("source_payload").$type<Record<string, unknown>>(),
};

/**
 * ONE RECORD PER SOURCE RECORD.
 *
 * `source_system` and `source_id` are only worth having if the pair names
 * exactly one row: "which invoice did Jobber invoice 2201 become" with two
 * answers is worse than no answer, because a re-run migration would quietly
 * create the second. Unique per organization, and partial, because almost
 * every row was typed in here and has no source at all.
 */
export const sourceRefIndex = (
  name: string,
  t: { organizationId: AnyPgColumn; sourceSystem: AnyPgColumn; sourceId: AnyPgColumn },
) => uniqueIndex(name).on(t.organizationId, t.sourceSystem, t.sourceId).where(sql`source_id is not null`);

/**
 * HOW CLOSE TO THE DOOR A COORDINATE IS. Mirrors `GEOCODE_PRECISIONS` in
 * `packages/core/src/geo/geocode.ts`, which says what each one means.
 */
export const geocodePrecision = pgEnum("geocode_precision", [
  "rooftop", "interpolated", "street", "postal_code", "locality", "placed",
]);

/**
 * WHERE AN ADDRESS IS, AND HOW WE KNOW. Spread onto every table that has an
 * address the dispatch map draws: a property, and a location a technician's
 * day starts from.
 *
 * `latitude` and `longitude` stay text, as `property` has always had them,
 * and are never written without `location_source` and `location_precision`
 * beside them: a pin a geocoder put in the middle of a postcode and a pin
 * somebody dropped on the gate are both a coordinate, and only one of them is
 * worth routing a van to.
 *
 * `address_key` is GENERATED, so the database and the worker cannot disagree
 * about whether the address has changed since it was looked up. It is the
 * same normalisation as `geo.addressKey` in core, and a test compares the two.
 * The rest is the worker's bookkeeping, kept here rather than in a queue
 * table because the question it answers, "does this row need looking up",
 * is a property of the row.
 */
export const geocodeColumns = () => ({
  latitude: text("latitude"),
  longitude: text("longitude"),
  /** `manual` for a pin a person placed, which the geocoder then never touches. Otherwise the provider key. */
  locationSource: text("location_source"),
  locationPrecision: geocodePrecision("location_precision"),
  locatedAt: timestamp("located_at", { withTimezone: true }),
  /** The `address_key` the stored coordinate answers for. */
  locatedAddress: text("located_address"),
  addressKey: text("address_key").generatedAlwaysAs(sql`
    lower(btrim(regexp_replace(coalesce(address_line1, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(address_line2, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(city, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(state, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(postal_code, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(country, ''), '[[:space:]]+', ' ', 'g')))`),
  /** The `address_key` the last lookup was FOR, found or not. */
  geocodeAttemptedAddress: text("geocode_attempted_address"),
  geocodeAttempts: integer("geocode_attempts").notNull().default(0),
  /** When to ask again after a failure that might clear. Null after an attempt means not for this address. */
  geocodeRetryAt: timestamp("geocode_retry_at", { withTimezone: true }),
  /** What the last lookup said when it did not find the place, in words. */
  geocodeError: text("geocode_error"),
});
