import { describe, it, expect } from "vitest";
import { getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { FIELD_PERMISSIONS } from "@opentradesos/core";
import { schema } from "@opentradesos/db";

/**
 * EVERY REDACTION RULE GUARDS SOMETHING
 *
 * `FIELD_PERMISSIONS` maps "entity.field" to the permission that reveals it,
 * and `redact` walks the record's own keys. A rule naming a column that does
 * not exist therefore does nothing at all, silently, and reads in review as
 * protection that is in place.
 *
 * Three of them were exactly that: `customer.balance`, `customer.creditLimit`
 * and `customer.discountRate` guarded fields the customer table has never
 * had, so `customer.financials:read` protected nothing on a customer. Not a
 * leak, because there was nothing to leak. Just a guard that was not a guard,
 * which is the same shape as a scope resolved and never applied.
 */

/** Every "table.column" the schema actually has. */
const COLUMNS = new Set<string>();
for (const [name, table] of Object.entries(schema)) {
  if (!is(table, PgTable)) continue;
  for (const column of Object.keys(getTableColumns(table))) {
    COLUMNS.add(`${name}.${column}`);
  }
}

/**
 * Fields a service composes rather than selects.
 *
 * Listed by hand, because the alternative is exempting anything unrecognised
 * and that is how the dead rules survived. Each one has to be redacted by a
 * service that builds it, and each is asserted below.
 */
const COMPUTED = new Set<string>([
  // Derived from price and cost in services/pricebook.ts.
  "priceBookItemVersion.margin",
  // Derived per option in services/estimates.ts.
  "estimateOption.cost",
  "estimateOption.margin",
  /**
   * Summed from the open invoices in services/customers.ts on every read.
   * Not a column deliberately: a stored balance is a number two writers
   * race to update, and the one that loses leaves a customer owing money
   * the system believes they paid.
   */
  "customer.balance",
]);

describe("field redaction", () => {
  it("finds the schema at all", () => {
    // A resolver that collected nothing would make the test below pass by
    // having no columns to disagree with.
    expect(COLUMNS.has("customer.name")).toBe(true);
    // A money column on a table that is not the first one, so the walk is
    // covering the whole schema rather than one export.
    expect(COLUMNS.has("jobLine.unitCost")).toBe(true);
    expect(COLUMNS.has("customer.nonsense")).toBe(false);
    // The one this test was written for. `job.grossMargin` had a redaction
    // rule and has never been a column.
    expect(COLUMNS.has("job.grossMargin")).toBe(false);
  });

  it("names a real column, or a field a service composes", () => {
    const dead = Object.keys(FIELD_PERMISSIONS)
      .filter((key) => !COLUMNS.has(key) && !COMPUTED.has(key));
    expect(dead).toEqual([]);
  });

  it("does not exempt a computed field that the schema already has", () => {
    // An entry drifting into COMPUTED would silence this test for a column
    // that is really there, which is the same failure one level up.
    expect([...COMPUTED].filter((key) => COLUMNS.has(key))).toEqual([]);
  });
});
