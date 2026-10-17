import { pgTable, pgEnum, uuid, text, boolean, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, money } from "./_shared";
import { organization, user } from "./tenancy";
import { customer } from "./crm";
import { priceBookItem } from "./pricebook";
import { rental, rentableAsset } from "./scheduling";

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

/**
 * WHY A CONTAINER WAS KEPT OFF THE ROAD: out for repair, or held because a
 * customer asked. `container_hold_kind` in the database.
 */
export const containerHoldKind = pgEnum("container_hold_kind", ["repair", "customer"]);

/**
 * A CONTAINER KEPT OFF THE ROAD, FROM WHEN TO WHEN.
 *
 * The dumpster pack's turnaround between pickup and redelivery EXCLUDES "cans
 * routed to the yard for repair and cans held at customer request, since
 * neither is a dispatch failure". The status column says only what a can is
 * now: tagged out today and back tomorrow, the repair left no trace, and a
 * report for last month could not tell that the slow turnaround was a welder
 * and not the dispatcher. So each one is a period with a start and an end.
 *
 * A REPAIR is opened by tagging the can out (or collecting it with "back in
 * service" unticked) and closed by putting it back in service. A CUSTOMER HOLD
 * is the office keeping a can for somebody who asked (a builder who wants that
 * one on Monday), opened and closed on the containers board, and closed on its
 * own when the can is delivered.
 *
 * `starts_at` is null only for a repair that was already running when this
 * history began: the can was tagged out, and nobody knows since when. That is
 * said rather than guessed, and the turnaround reads it as having started
 * before anything it measures.
 *
 * Nothing deletes a period (`deleted_at` is never written), because the
 * turnaround figure for a month already reported reads it.
 */
export const containerHold = pgTable("container_hold", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  assetId: uuid("asset_id").notNull().references(() => rentableAsset.id, { onDelete: "cascade" }),
  kind: containerHoldKind("kind").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  /** Null while it is still running. */
  endsAt: timestamp("ends_at", { withTimezone: true }),
  /** What is wrong with it, or who asked and why. */
  reason: text("reason").notNull(),
  /** The customer who asked, for a customer hold, when the office named one. */
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
  recordedByUserId: uuid("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  assetIdx: index("container_hold_asset_idx").on(t.organizationId, t.assetId, t.startsAt),
  /** One repair and one customer hold running at a time on a can: a second would be the first recorded twice. */
  openIdx: uniqueIndex("container_hold_open_idx").on(t.assetId, t.kind).where(sql`${t.endsAt} is null`),
}));
