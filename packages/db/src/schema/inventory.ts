import { pgTable, pgEnum, uuid, text, integer, index, uniqueIndex, timestamp, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, money } from "./_shared";
import { organization, user, location } from "./tenancy";
import { priceBookItem } from "./pricebook";
import { job } from "./work";

/**
 * PURCHASING, VENDORS AND INVENTORY
 *
 * The rules live in `packages/core/src/inventory`. This is where the history
 * they read is kept, and the shape of these tables follows one decision made
 * there: A STOCK LEVEL IS NOT STORED.
 *
 * There is no `on_hand` column anywhere in this file, and no `committed`
 * column either. Both are folded from `stock_movement`, which is append only,
 * for the same reason the ledger is: a stock level somebody can edit is a
 * stock level nobody can explain, and every count that has ever disagreed
 * with a system has disagreed because somebody corrected the number instead
 * of recording the correction.
 *
 * The cost of that choice is real and worth naming. Reading a level means
 * folding a history, so a company with a million movements pays for it on
 * every read. The answer when that day arrives is a periodic snapshot plus
 * the movements after it, which is a cache and can be rebuilt. It is NOT a
 * mutable column, because a cache that can be rebuilt from the truth and a
 * number that IS the truth are different things.
 */

export const movementKind = pgEnum("stock_movement_kind", [
  "receipt",
  "issue",
  "transfer_out",
  "transfer_in",
  "return_to_stock",
  "return_to_vendor",
  "adjustment_in",
  "adjustment_out",
  "scrap",
  "commit",
  "release",
]);

export const purchaseOrderStatus = pgEnum("purchase_order_status", [
  "draft", "submitted", "acknowledged", "partially_received", "received", "cancelled",
]);

/**
 * A quantity column.
 *
 * Scale 4, matching money and matching `core.Quantity`, because trades
 * quantities are genuinely fractional: 12.5 feet of lineset, 2.75 pounds of
 * refrigerant. An integer column here means a cycle count that never
 * reconciles, and the cost of that is not the rounding, it is the counting
 * process somebody abandons.
 */
const quantity = money;

/**
 * Who we buy from.
 *
 * Deliberately thin. Terms, contacts, catalogues and three way matching are
 * all real and all absent, because this table exists to let a purchase order
 * name somebody rather than to be a vendor management module.
 */
export const vendor = pgTable("vendor", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  accountNumber: text("account_number"),
  email: text("email"),
  phone: text("phone"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  nameIdx: uniqueIndex("vendor_name_idx").on(t.organizationId, t.name)
    .where(sql`${t.deletedAt} is null`),
}));

/**
 * THE HISTORY EVERY QUANTITY IS DERIVED FROM.
 *
 * Append only. There is no update path in the service and no soft delete
 * here: a movement that was wrong is corrected by an adjustment that says so,
 * which leaves both facts in the record. Deleting one leaves a level that
 * changed for no reason anybody can point at.
 *
 * `quantity` is ALWAYS POSITIVE. Direction comes from `kind`, and that is not
 * a style preference: a signed quantity is how a receipt of minus three ends
 * up in a history with nobody able to say whether it was a return, a
 * correction or a typo.
 */
export const stockMovement = pgTable("stock_movement", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** What moved. A price book item, because that is what a part IS here. */
  itemId: uuid("item_id").notNull().references(() => priceBookItem.id, { onDelete: "restrict" }),
  /** Where it moved. A van is a location, which is the whole point. */
  locationId: uuid("location_id").notNull().references(() => location.id, { onDelete: "restrict" }),
  kind: movementKind("kind").notNull(),
  quantity: quantity("quantity").notNull(),
  /**
   * What the whole of this movement cost, not a cost per unit.
   *
   * Required on anything that adds stock and meaningless on anything that
   * removes it, because the cost of an issue is decided by the costing method
   * from the layers, never carried on the movement.
   */
  totalCost: money("total_cost"),
  /**
   * WHICH JOB. On a commit or a release this is required by the service, and
   * it is the field that makes a reservation belong to somebody.
   *
   * The first version of the core module held one committed counter per item
   * per location. Two jobs reserve the last compressor, one technician
   * collects theirs, the counter drops, and the other job's reservation is
   * now held against an empty shelf. Nobody finds out until a second
   * technician arrives at a property.
   */
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  /** Shared by the two halves of a transfer, and the only thing pairing them. */
  transferId: uuid("transfer_id"),
  reasonCode: text("reason_code"),
  purchaseOrderId: uuid("purchase_order_id"),
  purchaseOrderLineId: uuid("purchase_order_line_id"),
  /**
   * A total order within the organization, assigned by the database.
   *
   * `occurred_at` alone is not enough: a delivery that happened on Monday and
   * was typed in on Thursday has an earlier `occurred_at` and a later
   * sequence, and FIFO has to consume it as Monday stock while the history
   * still replays deterministically. The core module sorts by occurred_at
   * then sequence then id, and needs both.
   */
  sequence: integer("sequence").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  recordedByUserId: uuid("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  /** The fold. Every level read is this index. */
  levelIdx: index("stock_movement_level_idx").on(t.organizationId, t.itemId, t.locationId, t.occurredAt, t.sequence),
  jobIdx: index("stock_movement_job_idx").on(t.organizationId, t.jobId).where(sql`${t.jobId} is not null`),
  transferIdx: index("stock_movement_transfer_idx").on(t.transferId).where(sql`${t.transferId} is not null`),
  poIdx: index("stock_movement_po_idx").on(t.purchaseOrderId).where(sql`${t.purchaseOrderId} is not null`),
  sequenceIdx: uniqueIndex("stock_movement_sequence_idx").on(t.organizationId, t.sequence),
}));

/**
 * When to buy more, per item PER LOCATION.
 *
 * Per location rather than per item, because the reorder point for a van and
 * for a warehouse are different questions with different answers. One point
 * per item is how a company ends up either restocking every van to warehouse
 * depth or never restocking one at all.
 */
export const reorderPolicy = pgTable("reorder_policy", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => priceBookItem.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => location.id, { onDelete: "cascade" }),
  reorderPoint: quantity("reorder_point").notNull(),
  reorderQuantity: quantity("reorder_quantity").notNull(),
  /** Stock to hold above the point when buying. Optional. */
  targetLevel: quantity("target_level"),
  preferredVendorId: uuid("preferred_vendor_id").references(() => vendor.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  itemLocationIdx: uniqueIndex("reorder_policy_item_location_idx").on(t.organizationId, t.itemId, t.locationId)
    .where(sql`${t.deletedAt} is null`),
}));

export const purchaseOrder = pgTable("purchase_order", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  vendorId: uuid("vendor_id").notNull().references(() => vendor.id, { onDelete: "restrict" }),
  /**
   * The default destination, which the lines may each override. Kept here so
   * a person writing an order fills it in once, and read by nothing: the
   * location that decides where stock lands is the one on the line.
   */
  defaultLocationId: uuid("default_location_id").notNull().references(() => location.id, { onDelete: "restrict" }),
  status: purchaseOrderStatus("status").notNull().default("draft"),
  /**
   * What the vendor said, and what we expect.
   *
   * `expected_at` earns its place: an overdue purchase order is a phone call
   * to a vendor, and that is never the action an automatic reorder takes.
   */
  expectedAt: timestamp("expected_at", { withTimezone: true }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  vendorReference: text("vendor_reference"),
  notes: text("notes"),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  numberIdx: uniqueIndex("purchase_order_number_idx").on(t.organizationId, t.number),
  /** The reorder engine's read: what is on order right now. */
  openIdx: index("purchase_order_open_idx").on(t.organizationId, t.status),
}));

/**
 * One line, with what was ordered and what has arrived so far.
 *
 * `quantity_received` is a running total rather than a derived value, and
 * that is a deliberate exception to the rule at the top of this file. It is
 * NOT a stock level: it is the state of a promise between us and a vendor,
 * and the movements that receive stock are a different fact from how much of
 * an order is still owed. A short shipment that is later cancelled leaves
 * stock received and nothing further owed, and only one of those two numbers
 * changes.
 */
export const purchaseOrderLine = pgTable("purchase_order_line", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id").notNull().references(() => purchaseOrder.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => priceBookItem.id, { onDelete: "restrict" }),
  /**
   * Where THIS LINE is going, not where the order is.
   *
   * A purchase order is delivered to more than one place more often than it
   * sounds: a vendor drops the condensers at the shop and the filters
   * straight onto a van. One location on the order means somebody receives
   * the whole thing to the warehouse and then transfers half of it, or
   * simply does not, and the van stock is wrong from the first delivery.
   */
  locationId: uuid("location_id").notNull().references(() => location.id, { onDelete: "restrict" }),
  quantityOrdered: quantity("quantity_ordered").notNull(),
  quantityReceived: quantity("quantity_received").notNull().default("0"),
  /** What the vendor charges for one, which is how a vendor quotes. */
  unitPrice: money("unit_price").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
}, (t) => ({
  orderIdx: index("purchase_order_line_order_idx").on(t.purchaseOrderId, t.sortOrder),
}));
