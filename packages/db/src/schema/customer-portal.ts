import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, index, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { pk } from "./_shared";
import { organization } from "./tenancy";
import { customer } from "./crm";
import { integrationConnection } from "./integrations";
import { portalGrant } from "./portal";

/**
 * A CARD THE CUSTOMER SAVED, AND NOTHING OF THE CARD ITSELF.
 *
 * The card number, expiry and security code go from the customer's browser
 * straight to the processor and never reach this server: the processor hands
 * back a reference to the card it now holds, and the reference, the brand,
 * the last four digits and the expiry are all that is kept here. Those four
 * are what a customer needs to recognise their own card in a list, and none
 * of them can be charged by anybody who reads this table.
 *
 * Saved only by the customer, from their own signed in account, never from a
 * link and never by the office. A link can be forwarded, and a card saved
 * through a forwarded link is a stranger's card on somebody's account.
 */

/**
 * Who this customer is at the processor.
 *
 * A processor keeps saved cards against its own customer record, so one is
 * made the first time a customer saves a card and kept, one per customer per
 * connection. Per connection rather than per customer, because a company that
 * changes its Stripe account has a different set of customers there, and a
 * reference into the old account is a reference to nothing.
 */
export const paymentProfile = pgTable("payment_profile", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull()
    .references(() => integrationConnection.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  /** The processor's own id for this customer, `cus_` at Stripe. */
  externalRef: text("external_ref").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  customerIdx: uniqueIndex("payment_profile_customer_idx").on(t.organizationId, t.connectionId, t.customerId),
}));

export const savedPaymentMethod = pgTable("saved_payment_method", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().references(() => paymentProfile.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  /**
   * `card` or `bank_account`. A bank account is saved the same way, through
   * the processor's own setup flow with the bank verified on the spot, and
   * nothing of it is kept here but the bank's name and the last four digits.
   * It pays more slowly: a payment from one is pending for days before the
   * processor says the money arrived, and can still fail in that time.
   */
  kind: text("kind").notNull().default("card"),
  /** The processor's id for the card, `pm_` at Stripe. What a charge names. */
  externalRef: text("external_ref").notNull(),
  /**
   * As the processor reports them. Enough to recognise the card, never
   * enough to use it. For a bank account the brand is the bank's name and
   * there is no expiry.
   */
  brand: text("brand"),
  last4: text("last4"),
  expMonth: integer("exp_month"),
  expYear: integer("exp_year"),
  /** The customer's own sign in that saved it. */
  savedByGrantId: uuid("saved_by_grant_id").references(() => portalGrant.id, { onDelete: "set null" }),
  /**
   * When the customer took it off. The row stays, because a payment taken
   * with it names it, and the processor has been told to forget the card.
   */
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /**
   * One live row per card. Coming back from the processor twice (a refresh
   * of the page it returned to) records the card once.
   */
  externalIdx: uniqueIndex("saved_payment_method_external_idx").on(t.organizationId, t.externalRef)
    .where(sql`${t.removedAt} is null`),
  customerIdx: index("saved_payment_method_customer_idx").on(t.organizationId, t.customerId),
}));
