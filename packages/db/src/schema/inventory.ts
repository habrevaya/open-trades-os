import { pgTable, pgEnum, uuid, text, integer, index, uniqueIndex, timestamp, boolean, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, money } from "./_shared";
import { organization, user, location, memberRole, role } from "./tenancy";
import { priceBookItem } from "./pricebook";
import { job } from "./work";
import { equipment } from "./crm";

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
 * WHAT A VENDOR CALLS ONE OF OUR ITEMS, AND WHAT THEY CHARGE FOR IT.
 *
 * Our code for a part and the supplier's are different strings, and every
 * supplier's is different again: the same capacitor is "CAP-45-5" in our
 * book, "C455R" at one supply house and "8401-2210" at the other. A purchase
 * order goes to the supplier, so it has to carry THEIR number, and without a
 * place to keep it somebody typed it from memory onto every order.
 *
 * One row per item per vendor. The cost here is the vendor's price to us,
 * which is a different number from the item's own cost (the one job costing
 * reads) whenever a part is bought from more than one place. A catalogue
 * import writes both when asked to, and writes this one always.
 */
export const vendorItem = pgTable("vendor_item", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  vendorId: uuid("vendor_id").notNull().references(() => vendor.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => priceBookItem.id, { onDelete: "cascade" }),
  /** The vendor's own part number or SKU, as printed in their catalogue. */
  partNumber: text("part_number").notNull(),
  /** Their description, which is often more exact than ours and is what their counter staff read. */
  description: text("description"),
  /** What one costs from this vendor. Null when nobody has said. */
  cost: money("cost"),
  /** When the cost was last stated, by a person or a catalogue, so a stale one can be seen as stale. */
  costUpdatedAt: timestamp("cost_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /**
   * One part number per item per vendor, and one item per part number per
   * vendor. Either collision makes a purchase order line ambiguous: two of
   * our items answering to "C455R" means the receipt lands on whichever one a
   * query read first. Case blind, because a catalogue in capitals and a
   * person typing in lower case mean the same part.
   */
  vendorItemIdx: uniqueIndex("vendor_item_vendor_item_idx").on(t.organizationId, t.vendorId, t.itemId),
  partNumberIdx: uniqueIndex("vendor_item_part_number_idx")
    .on(t.organizationId, t.vendorId, sql`lower(${t.partNumber})`),
  itemIdx: index("vendor_item_item_idx").on(t.organizationId, t.itemId),
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
   * WHICH SERIAL NUMBER OR LOT, for an item tracked by one.
   *
   * A serialised part moves one unit to a movement, so the history of a
   * compressor is the list of movements naming its serial: received on this
   * order, moved to Van 4, issued to job 1042. Where a serial IS is folded
   * from that list exactly as a level is, and stored nowhere.
   */
  lotId: uuid("lot_id").references(() => stockLot.id, { onDelete: "restrict" }),
  /**
   * The part of `total_cost` that is freight and fees spread onto this line,
   * not the price paid for the goods. Kept apart so a receipt can say "four
   * hundred of parts and twelve of the freight" rather than a total nobody
   * can reconcile against the vendor's bill. Included in `total_cost`, which
   * is what costing reads.
   */
  landedCost: money("landed_cost"),
  /** The delivery this arrived on, when it was received against an order. */
  receiptId: uuid("receipt_id").references(() => purchaseOrderReceipt.id, { onDelete: "restrict" }),
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
  lotIdx: index("stock_movement_lot_idx").on(t.organizationId, t.lotId).where(sql`${t.lotId} is not null`),
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
  /**
   * The vendor's part number AS IT WAS when the order was written.
   *
   * Copied rather than joined, for the reason a price is copied onto an
   * invoice: the order went to the supplier saying this, and a part number
   * corrected next month must not change what the order we sent them said.
   * Null when the item has no number recorded for this vendor.
   */
  vendorPartNumber: text("vendor_part_number"),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
}, (t) => ({
  orderIdx: index("purchase_order_line_order_idx").on(t.purchaseOrderId, t.sortOrder),
}));

/* ===================================================================== */
/* Serial numbers and lots                                                */
/* ===================================================================== */

/**
 * HOW AN ITEM IS TRACKED, when it is tracked beyond a count.
 *
 * `serial`: every unit has its own number and moves on its own. A compressor,
 * a furnace, a water heater: the number the manufacturer's warranty is keyed
 * to and the one a customer reads off the label in five years.
 *
 * `lot`: units arrive in batches that share a number, and the batch is what
 * matters. Refrigerant by cylinder lot, adhesive by batch with an expiry: a
 * recall names a lot, never a unit.
 */
export const stockTrackingMode = pgEnum("stock_tracking_mode", ["serial", "lot"]);

/**
 * WHICH ITEMS ARE TRACKED, AND HOW.
 *
 * A row of its own rather than a column on the price book item, because it
 * is a statement about stock rather than about what we sell: the price book
 * does not change when the warehouse starts writing serials down. No row
 * means counted only, which is what nearly every part is.
 */
export const stockTracking = pgTable("stock_tracking", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => priceBookItem.id, { onDelete: "cascade" }),
  mode: stockTrackingMode("mode").notNull(),
  setByUserId: uuid("set_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  itemIdx: uniqueIndex("stock_tracking_item_idx").on(t.organizationId, t.itemId),
}));

/**
 * ONE SERIAL NUMBER, OR ONE LOT.
 *
 * The number and what it is of. NOT where it is: that is folded from the
 * movements that name it, for the reason at the top of this file. The one
 * fact stored here that movements cannot carry is the customer's equipment
 * record a serialised unit became when it was installed, which is the trace
 * from our shelf to their basement.
 */
export const stockLot = pgTable("stock_lot", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => priceBookItem.id, { onDelete: "restrict" }),
  mode: stockTrackingMode("mode").notNull(),
  /** As printed on the unit or the batch label. */
  number: text("number").notNull(),
  /** A lot's use by date, where the batch has one. Never set on a serial. */
  expiresOn: date("expires_on"),
  /**
   * The customer's equipment record this unit was installed as, or into.
   * Set when a serialised unit is issued to a job and the technician says
   * which unit at the property it is.
   */
  equipmentId: uuid("equipment_id").references(() => equipment.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  /**
   * One row per number per item. Two rows for serial 4471 of the same model
   * would split its history in two and the trace would answer with whichever
   * was read first. Case blind, because a label read aloud and typed in is
   * the same number either way.
   */
  numberIdx: uniqueIndex("stock_lot_number_idx").on(t.organizationId, t.itemId, sql`lower(${t.number})`),
  equipmentIdx: index("stock_lot_equipment_idx").on(t.organizationId, t.equipmentId)
    .where(sql`${t.equipmentId} is not null`),
}));

/* ===================================================================== */
/* Receiving with freight: landed cost                                    */
/* ===================================================================== */

/** Spread by what each line cost, or by how many of each arrived. */
export const landedCostBasis = pgEnum("landed_cost_basis", ["value", "quantity"]);

/**
 * ONE DELIVERY AGAINST A PURCHASE ORDER.
 *
 * The receiving event, so freight and fees that came with it have something
 * to belong to. A purchase order received in three drops has three of these,
 * each with its own freight, and each spread over only what came on that
 * truck: freight on the second drop has nothing to do with the first.
 */
export const purchaseOrderReceipt = pgTable("purchase_order_receipt", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id").notNull().references(() => purchaseOrder.id, { onDelete: "cascade" }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  receivedByUserId: uuid("received_by_user_id").references(() => user.id, { onDelete: "set null" }),
  basis: landedCostBasis("basis").notNull().default("value"),
  /** Every charge below added up, and spread onto the movements. */
  chargesTotal: money("charges_total").notNull().default("0"),
  ...timestamps,
}, (t) => ({
  orderIdx: index("purchase_order_receipt_order_idx").on(t.purchaseOrderId, t.receivedAt),
}));

/** Freight, a fuel surcharge, a hazmat fee: one line each, as the vendor's bill shows them. */
export const purchaseOrderReceiptCharge = pgTable("purchase_order_receipt_charge", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  receiptId: uuid("receipt_id").notNull().references(() => purchaseOrderReceipt.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  amount: money("amount").notNull(),
  ...timestamps,
}, (t) => ({
  receiptIdx: index("purchase_order_receipt_charge_receipt_idx").on(t.receiptId),
}));

/* ===================================================================== */
/* Approval rules for spending                                            */
/* ===================================================================== */

/**
 * ONE STEP OF APPROVAL, and the order size that needs it.
 *
 * An order at or over `minimum_total` needs this step, approved by somebody
 * holding the role named. Steps are approved in `step` order, so a company
 * that says "over a thousand, the office manager; over five thousand, the
 * owner as well" writes two rows and a six thousand dollar order needs both,
 * the office manager first.
 *
 * The role is a preset OR one of the company's own roles, exactly one of the
 * two: a custom role replaces the preset on a membership, so a step naming
 * the preset would never match somebody on a custom role.
 */
export const purchaseApprovalRule = pgTable("purchase_approval_rule", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  step: integer("step").notNull(),
  minimumTotal: money("minimum_total").notNull(),
  approverRole: memberRole("approver_role"),
  approverRoleId: uuid("approver_role_id").references(() => role.id, { onDelete: "restrict" }),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  stepIdx: uniqueIndex("purchase_approval_rule_step_idx").on(t.organizationId, t.step)
    .where(sql`${t.deletedAt} is null`),
}));

export const approvalDecision = pgEnum("purchase_approval_decision", ["approved", "rejected"]);

/**
 * WHO APPROVED WHICH STEP OF WHICH ORDER, and at what total.
 *
 * The step, its threshold and the role are copied from the rule, because a
 * rule changed next month must not change what was required of an order this
 * month. The total is copied for the same reason an invoice copies a price.
 */
export const purchaseOrderApproval = pgTable("purchase_order_approval", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id").notNull().references(() => purchaseOrder.id, { onDelete: "cascade" }),
  ruleId: uuid("rule_id").references(() => purchaseApprovalRule.id, { onDelete: "set null" }),
  step: integer("step").notNull(),
  minimumTotal: money("minimum_total").notNull(),
  /** The role the step asked for, in words, as it was named on the day. */
  roleLabel: text("role_label").notNull(),
  orderTotal: money("order_total").notNull(),
  decision: approvalDecision("decision").notNull(),
  decidedByUserId: uuid("decided_by_user_id").references(() => user.id, { onDelete: "set null" }),
  note: text("note"),
  ...timestamps,
}, (t) => ({
  stepIdx: uniqueIndex("purchase_order_approval_step_idx").on(t.purchaseOrderId, t.step),
}));

/* ===================================================================== */
/* Sending an order to the vendor                                         */
/* ===================================================================== */

/**
 * EVERY TIME AN ORDER WAS EMAILED, whether it went or not.
 *
 * The email carries a link to the order printable as the vendor reads it,
 * and the link is a token whose hash is all that is kept here. A vendor with
 * no address on file, or one the mail provider would not take, is a row
 * saying so, which is how a buyer sees the order never reached the counter.
 */
export const purchaseOrderSend = pgTable("purchase_order_send", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id").notNull().references(() => purchaseOrder.id, { onDelete: "cascade" }),
  destination: text("destination"),
  /** `queued` or `refused`. Queued is not delivered, and the screen says queued. */
  state: text("state").notNull(),
  explanation: text("explanation"),
  messageId: uuid("message_id"),
  linkTokenHash: text("link_token_hash"),
  linkExpiresAt: timestamp("link_expires_at", { withTimezone: true }),
  sentByUserId: uuid("sent_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  orderIdx: index("purchase_order_send_order_idx").on(t.purchaseOrderId, t.createdAt),
  tokenIdx: uniqueIndex("purchase_order_send_token_idx").on(t.linkTokenHash)
    .where(sql`${t.linkTokenHash} is not null`),
}));

/* ===================================================================== */
/* Truck stock minimums                                                   */
/* ===================================================================== */

/**
 * WHAT EACH TRUCK SHOULD CARRY.
 *
 * Not a reorder point. A truck is not bought for, it is filled from the
 * warehouse, so falling under its minimum suggests a transfer from the shelf
 * rather than a purchase order, and the warehouse's own reorder point then
 * decides whether to buy. Per item per truck, because the capacitor that
 * fails on every third call wants six on every van and the blower motor
 * wants none.
 */
export const truckStockMinimum = pgTable("truck_stock_minimum", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => priceBookItem.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => location.id, { onDelete: "cascade" }),
  /** At or below this, restock. */
  minimum: quantity("minimum").notNull(),
  /** Fill back up to this. */
  target: quantity("target").notNull(),
  ...timestamps,
}, (t) => ({
  itemLocationIdx: uniqueIndex("truck_stock_minimum_item_location_idx")
    .on(t.organizationId, t.itemId, t.locationId)
    .where(sql`${t.deletedAt} is null`),
}));
