import { numeric, timestamp, uuid, char, text, jsonb } from "drizzle-orm/pg-core";

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
