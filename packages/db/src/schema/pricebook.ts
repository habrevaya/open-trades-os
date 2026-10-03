import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, sourceRef, sourceRefIndex, money, rate } from "./_shared";
import { organization, user } from "./tenancy";

/**
 * PRICE BOOK
 *
 * Versioned, and that is not optional. An invoice must reference the exact
 * price book VERSION that was quoted, never the live row. Otherwise raising a
 * price silently rewrites three years of financial history and every report
 * built on it. This is the second most common data modeling failure in this
 * category after the customer/property collapse.
 *
 * `price_book_item` is the stable identity. `price_book_item_version` holds
 * everything that can change. Documents point at the version.
 */

export const itemKind = pgEnum("item_kind", ["service", "material", "equipment", "labor", "fee", "discount"]);

/**
 * WHICH FEE THIS IS, when it is one a membership can waive.
 *
 * A plan has carried "waives the diagnostic fee" and "waives the after hours
 * rate" since the first migration, and nothing could apply either, because
 * nothing could tell which line on a document WAS the diagnostic fee. Every
 * company names it differently ("Trip charge", "Service call", "Dispatch
 * fee"), so matching on a name would be a guess that is wrong in a way
 * nobody notices until a member is charged for something their plan says
 * they never pay. The company says which item it is, once, on the item.
 *
 * Null for everything else, which is nearly everything.
 */
export const feeRole = pgEnum("price_book_fee_role", ["diagnostic", "after_hours"]);

export const priceBookCategory = pgTable("price_book_category", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  code: text("code"),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
}, (t) => ({
  orgIdx: index("price_book_category_org_idx").on(t.organizationId),
  /**
   * One "Water heaters" under one parent. Two categories with the same name
   * side by side is a price book where half the items are in each and
   * nobody can say which is the real one. Case blind, because "Drains" and
   * "drains" are the same shelf, and among the live ones only, so a removed
   * category does not hold its name. A null parent is the top level, which
   * a plain unique index would treat as never equal to itself.
   */
  nameIdx: uniqueIndex("price_book_category_name_idx")
    .on(t.organizationId, sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.name})`)
    .where(sql`${t.deletedAt} is null`),
}));

export const priceBookItem = pgTable("price_book_item", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").references(() => priceBookCategory.id, { onDelete: "set null" }),
  kind: itemKind("kind").notNull().default("service"),
  code: text("code").notNull(),
  active: boolean("active").notNull().default(true),
  /**
   * On the item rather than the version, because it is what the item IS and
   * not something it costs: no document points at it, and changing it changes
   * nothing anybody was charged. See `feeRole`.
   */
  feeRole: feeRole("fee_role"),
  /** Set when the row came from a trade pack, so pack updates can be offered later. */
  tradePackId: text("trade_pack_id"),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  sourceRefIdx: sourceRefIndex("price_book_item_source_ref_idx", t),
  codeIdx: uniqueIndex("price_book_item_code_idx").on(t.organizationId, t.code),
}));

export const priceBookItemVersion = pgTable("price_book_item_version", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => priceBookItem.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  /** Customer-facing copy. Shown verbatim on good/better/best proposals. */
  description: text("description"),
  imageUrl: text("image_url"),
  /** What we charge. Flat rate, not hourly, for kind = service. */
  price: money("price").notNull(),
  /** What it costs us. Drives job costing and margin reporting. */
  cost: money("cost"),
  /** Estimated labor to perform, in minutes. Feeds job duration estimation. */
  laborMinutes: integer("labor_minutes"),
  taxable: boolean("taxable").notNull().default(true),
  taxClass: text("tax_class"),
  /** Commission basis override. Null means use the technician's plan default. */
  commissionRate: rate("commission_rate"),
  warrantyMonths: integer("warranty_months"),
  /** Kits: child items included in this one, with quantities. */
  components: jsonb("components").$type<Array<{ itemId: string; quantity: number }>>().notNull().default([]),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  itemVersionIdx: uniqueIndex("price_book_item_version_idx").on(t.itemId, t.version),
  currentIdx: index("price_book_item_version_current_idx").on(t.organizationId, t.itemId, t.effectiveTo),
}));

/**
 * A CHANGE TO MANY PRICES AT ONCE, AND WHAT IT DID.
 *
 * Re-pricing a seeded book item by item is the job nobody finishes, so the
 * book is left at national averages and every quote is wrong in the same
 * direction. A bulk change writes a NEW VERSION per item, exactly as a single
 * edit does, and never touches a version in place; this table is the record
 * of which versions it wrote and what each price was before, which is what
 * makes "undo that" an operation rather than an afternoon. Undoing is itself
 * a change, written the same way, and points back at the one it reverses.
 */
export const priceChangeKind = pgEnum("price_change_kind", ["change", "reversal"]);

export const priceChangeBatch = pgTable("price_change_batch", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  kind: priceChangeKind("kind").notNull().default("change"),
  /** The rule as it was applied, so the record says what was asked for. */
  rule: jsonb("rule").$type<Record<string, unknown>>().notNull().default({}),
  /** The same rule as a sentence, written once, at the time. */
  description: text("description").notNull(),
  /** Which items it was asked about: a category, a search. */
  selection: jsonb("selection").$type<Record<string, unknown>>().notNull().default({}),
  itemCount: integer("item_count").notNull().default(0),
  reversesBatchId: uuid("reverses_batch_id"),
  reversedByBatchId: uuid("reversed_by_batch_id"),
  appliedByUserId: uuid("applied_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgIdx: index("price_change_batch_org_idx").on(t.organizationId, t.createdAt),
}));

export const priceChangeLine = pgTable("price_change_line", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  batchId: uuid("batch_id").notNull().references(() => priceChangeBatch.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => priceBookItem.id, { onDelete: "cascade" }),
  /** The version that was in force, which this change closed. */
  fromVersionId: uuid("from_version_id").notNull().references(() => priceBookItemVersion.id),
  /** The version this change wrote. */
  toVersionId: uuid("to_version_id").notNull().references(() => priceBookItemVersion.id),
  priceBefore: money("price_before").notNull(),
  priceAfter: money("price_after").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  batchIdx: index("price_change_line_batch_idx").on(t.batchId),
}));
