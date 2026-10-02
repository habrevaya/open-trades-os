import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database } from "@opentradesos/db";
import { ConflictError, type ExternalRef } from "./context";

/**
 * PROVENANCE ON THE WAY IN, AND FINDING IT AGAIN
 *
 * `externalRef` arrives on a create and lands in `source_system` and
 * `source_id`, which every importable table has carried since the first
 * migration and nothing wrote. `clean` in context.ts turns them back into
 * `externalRef` on the way out, and a unique index per table makes the pair
 * name one record.
 */

/** The columns to spread into an insert. Nothing at all when there is no ref. */
export function provenance(ref: ExternalRef | undefined): { sourceSystem?: string; sourceId?: string } {
  return ref ? { sourceSystem: ref.source, sourceId: ref.id } : {};
}

/** The tables a caller may give an `externalRef`, by the name in SQL. */
type Importable =
  | "customer" | "property" | "price_book_item" | "job" | "visit" | "estimate" | "invoice" | "payment";

/**
 * Refuse a second record for the same source record, naming the first.
 *
 * Checked before the insert rather than left to the unique index, because
 * the index's answer is a constraint name in a 500, and the answer a
 * migration needs is "that is already loaded, as this id", which lets it
 * adopt the record instead of failing the run. The index is still what
 * guarantees it, under concurrency, where a check alone cannot.
 */
export async function assertUnclaimed(
  tx: Database, table: Importable, ref: ExternalRef | undefined,
): Promise<void> {
  if (!ref) return;
  const rows = await tx.execute<{ id: string }>(sql`
    select id from ${sql.raw(`public.${table}`)}
    where source_system = ${ref.source} and source_id = ${ref.id}
    limit 1
  `);
  const existing = rows[0];
  if (existing) {
    throw new ConflictError(
      `${ref.source} ${table.replace(/_/g, " ")} ${ref.id} is already here, as ${existing.id}.`,
    );
  }
}

/** A list filter on where records came from, or nothing when none was asked. */
export function byExternal(
  columns: { sourceSystem: AnyPgColumn; sourceId: AnyPgColumn },
  input: { externalSource?: string | undefined; externalId?: string | undefined },
): SQL | undefined {
  return and(
    input.externalSource !== undefined ? eq(columns.sourceSystem, input.externalSource) : undefined,
    input.externalId !== undefined ? eq(columns.sourceId, input.externalId) : undefined,
  );
}
