import { sql } from "drizzle-orm";
import { pgTable, uuid, text, boolean, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { pk, rate } from "./_shared";
import { organization, user } from "./tenancy";

/**
 * THE SALES TAX RATES A COMPANY CHARGES
 *
 * Not a jurisdiction table, and deliberately not a lookup. Working out which
 * rate the law says applies at an address is a product of its own (BUILD.md
 * keeps "Tax rate determination" unbuilt, behind `core/tax.TaxProvider`).
 * This is the company writing down the rates it already knows it charges,
 * "Travis County 8.25%", and saying which one is its usual one, so that a
 * part billed from the van is taxed without anybody typing a number.
 *
 * A RATE IS A NAME AND A HISTORY. `tax_rate` is the name somebody chose and
 * `tax_rate_version` the percentage from a day, so a county raising its rate
 * on the first of the month is a new version dated the first, and an invoice
 * raised in March still says what March charged. The line keeps the rate as
 * applied in any case (`invoice_line.tax_rate`, rule 3 in billing.ts); the
 * history is what lets a draft written on the 30th and issued on the 2nd be
 * checked against the rate in force on the day it is issued.
 *
 * Nothing here is soft deleted. A rate an invoice charged is retired, never
 * removed, because the invoice names it; `retired_at` takes it off every
 * list a person picks from and out of every decision made from then on.
 */
export const taxRate = pgTable("tax_rate", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** What the office and the invoice call it: "Travis County", "Round Rock city". */
  name: text("name").notNull(),
  /** Taken off every list from this moment. Lines that charged it keep naming it. */
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /**
   * One "Travis County" among the rates in use. Two of them is an office
   * picking between identical names and a filing report with two rows that
   * mean the same thing. Case blind, and only among the live ones, so a
   * retired rate does not hold its name.
   */
  nameIdx: uniqueIndex("tax_rate_name_idx").on(t.organizationId, sql`lower(${t.name})`)
    .where(sql`${t.retiredAt} is null`),
}));

export const taxRateVersion = pgTable("tax_rate_version", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  taxRateId: uuid("tax_rate_id").notNull().references(() => taxRate.id, { onDelete: "cascade" }),
  /** A fraction, as every rate column is: 0.0825 for 8.25%. */
  rate: rate("rate").notNull(),
  /** The first day, in the company's calendar, this percentage is charged. */
  effectiveFrom: date("effective_from").notNull(),
  note: text("note"),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /** One percentage per rate per day, or "what did it charge on the 1st" has two answers. */
  dayIdx: uniqueIndex("tax_rate_version_day_idx").on(t.taxRateId, t.effectiveFrom),
  orgIdx: index("tax_rate_version_org_idx").on(t.organizationId, t.taxRateId),
}));

/**
 * WHAT THE COMPANY SAYS ABOUT SALES TAX AS A WHOLE. One row per company,
 * written the first time somebody answers.
 *
 * `charges_tax` is a statement, not an absence: a company with no row has
 * said nothing, and is charged tax only where somebody has put a rate on a
 * customer or an address; a company that says it charges none is charged
 * none anywhere, whatever rates are lying around from before.
 */
export const taxSetting = pgTable("tax_setting", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  chargesTax: boolean("charges_tax").notNull().default(true),
  /** The rate charged where no customer or address names one. */
  defaultTaxRateId: uuid("default_tax_rate_id").references(() => taxRate.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /** One answer per company. Written by an upsert on it, never a second insert. */
  orgIdx: uniqueIndex("tax_setting_org_idx").on(t.organizationId),
}));
