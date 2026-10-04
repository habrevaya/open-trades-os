import { pgTable, pgEnum, uuid, text, boolean, index, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, money } from "./_shared";
import { organization, user } from "./tenancy";
import { priceBookItem } from "./pricebook";
import { rental } from "./scheduling";

/**
 * WHAT A HAUL TURNED UP, CHARGED FOR.
 *
 * The dumpster pack prices a contaminated load, an overfilled can and five
 * kinds of prohibited item, and before this table there was nowhere to say
 * that one had happened. The driver saw the mattress, the facility charged
 * for sorting the load, and the charge to the customer lived in somebody's
 * memory until the invoice went out without it.
 *
 * A charge belongs to ONE HAUL (one rental row), because the scale ticket
 * and the facility's sorting fee are per load, and a swap chain is several
 * loads. It is recorded when it is found and invoiced with the hire.
 */
export const rentalChargeKind = pgEnum("rental_charge_kind", [
  "contamination", "prohibited_item", "overweight", "overfill", "other",
]);

export const rentalCharge = pgTable("rental_charge", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  rentalId: uuid("rental_id").notNull().references(() => rental.id, { onDelete: "cascade" }),
  kind: rentalChargeKind("kind").notNull(),
  /** What was found, in the words that go on the invoice line. */
  description: text("description").notNull(),
  /** The price book fee it was priced from, when it was. */
  priceBookItemId: uuid("price_book_item_id").references(() => priceBookItem.id, { onDelete: "set null" }),
  /** Three tires is one charge of three, not three charges. */
  quantity: money("quantity").notNull().default("1"),
  unitPrice: money("unit_price").notNull(),
  taxable: boolean("taxable").notNull().default(true),
  /** Who saw it and where: "two tires under the shingles, front left". */
  note: text("note"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Set when it went onto an invoice. A charge on an invoice is no longer removable. */
  invoiceId: uuid("invoice_id"),
  invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  rentalIdx: index("rental_charge_rental_idx").on(t.organizationId, t.rentalId)
    .where(sql`${t.deletedAt} is null`),
}));
