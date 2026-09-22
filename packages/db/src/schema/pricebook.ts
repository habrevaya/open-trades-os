import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { pk, timestamps, sourceRef, money, rate } from "./_shared";
import { organization } from "./tenancy";

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

export const priceBookCategory = pgTable("price_book_category", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  code: text("code"),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
}, (t) => ({ orgIdx: index("price_book_category_org_idx").on(t.organizationId) }));

export const priceBookItem = pgTable("price_book_item", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").references(() => priceBookCategory.id, { onDelete: "set null" }),
  kind: itemKind("kind").notNull().default("service"),
  code: text("code").notNull(),
  active: boolean("active").notNull().default(true),
  /** Set when the row came from a trade pack, so pack updates can be offered later. */
  tradePackId: text("trade_pack_id"),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
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
