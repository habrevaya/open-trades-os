import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, index, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { pk, money } from "./_shared";
import { organization, user } from "./tenancy";
import { contact, customer } from "./crm";
import { invoice } from "./billing";
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

/**
 * THE CUSTOMER LETTING THE COMPANY CHARGE A SAVED CARD OR BANK ACCOUNT.
 *
 * A saved card is a reference the customer uses by pressing Pay. Charging it
 * with nobody on the page is a different thing, and is allowed only while
 * one of these is live for that card: the customer, signed in to their own
 * account, read the words in `wording` and agreed to them. Without a live
 * row nothing in this product can charge the card from the office or from
 * the worker, and `payments.intent` checks it again inside the transaction
 * that asks the processor.
 *
 * What is kept is what a dispute is decided on: the exact words shown, when,
 * how (`agreed_via`), from which sign in, as which contact when it was a
 * contact signed in as the customer, and from where. The row is never edited
 * into saying something else: withdrawing it sets `withdrawn_at` and keeps
 * the rest, and agreeing again is a new row.
 *
 * Paying automatically is a second agreement on top of the first, with its
 * own words and its own sign in, because "you may charge this card for my
 * bills" and "charge it for every bill as it is issued" are different
 * things to say yes to. Turning it off clears it; the audit log keeps when
 * it was on.
 */
export const paymentAgreement = pgTable("payment_agreement", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  savedPaymentMethodId: uuid("saved_payment_method_id").notNull()
    .references(() => savedPaymentMethod.id, { onDelete: "cascade" }),
  /** The words the customer was shown and agreed to, exactly. */
  wording: text("wording").notNull(),
  agreedAt: timestamp("agreed_at", { withTimezone: true }).notNull().defaultNow(),
  /** How they agreed. `portal_sign_in` (ticked and pressed Agree, signed in to their account) is the only way today. */
  agreedVia: text("agreed_via").notNull(),
  /** The sign in they agreed from. */
  grantId: uuid("grant_id").references(() => portalGrant.id, { onDelete: "set null" }),
  /** The contact who agreed, when a contact signed in as the customer. */
  contactId: uuid("contact_id").references(() => contact.id, { onDelete: "set null" }),
  ip: text("ip"),
  userAgent: text("user_agent"),
  /** When paying each bill automatically was turned on, and the words agreed to then. Null while it is off. */
  autopayAt: timestamp("autopay_at", { withTimezone: true }),
  autopayWording: text("autopay_wording"),
  autopayGrantId: uuid("autopay_grant_id").references(() => portalGrant.id, { onDelete: "set null" }),
  /** When it stopped: `customer` withdrew it, or `card_removed` because the card itself was taken off. */
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  withdrawnReason: text("withdrawn_reason"),
  withdrawnGrantId: uuid("withdrawn_grant_id").references(() => portalGrant.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /** One live agreement per card: agreeing twice is the same agreement. */
  liveIdx: uniqueIndex("payment_agreement_live_idx").on(t.organizationId, t.savedPaymentMethodId)
    .where(sql`${t.withdrawnAt} is null`),
  /** One card pays automatically per customer, or every bill would be charged twice. */
  autopayIdx: uniqueIndex("payment_agreement_autopay_idx").on(t.organizationId, t.customerId)
    .where(sql`${t.withdrawnAt} is null and ${t.autopayAt} is not null`),
  customerIdx: index("payment_agreement_customer_idx").on(t.organizationId, t.customerId),
}));

/**
 * ONE CHARGE OF A SAVED CARD WITH NOBODY ON THE PAGE, by the office or by
 * the worker paying a bill automatically.
 *
 * Written before the processor is asked, and its id is the key the processor
 * deduplicates on, so a worker that dies between asking and hearing back
 * asks again with the same key and gets the same charge rather than a
 * second one. Paying automatically is charged once per invoice, and tried
 * again once the next day when a card was declined: the unique index on
 * the invoice and the try is what makes "once" true whatever the worker does.
 *
 * It records the attempt and what became of it. Whether money arrived is
 * still the processor's signed webhook, through the same payment path as
 * every card payment.
 */
export const cardOnFileCharge = pgTable("card_on_file_charge", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id, { onDelete: "cascade" }),
  /** Who pays the invoice, whose card it is. */
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  /** The agreement it was charged under. Never null: there is no charge without one. */
  agreementId: uuid("agreement_id").notNull().references(() => paymentAgreement.id, { onDelete: "cascade" }),
  savedPaymentMethodId: uuid("saved_payment_method_id").notNull()
    .references(() => savedPaymentMethod.id, { onDelete: "cascade" }),
  /** `office`, a person pressing Charge on the invoice, or `autopay`, the worker. */
  trigger: text("trigger").notNull(),
  /** 1, or 2 for the one next day try of a declined automatic payment. */
  attempt: integer("attempt").notNull().default(1),
  /** The person who pressed Charge. Null for the worker. */
  requestedByUserId: uuid("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /**
   * `charging` while the processor is being asked; `submitted` when it took
   * the charge (a bank payment then takes days); `paid` once the money is
   * booked; `failed` with the reason; `needs_customer` when their bank wants
   * them to confirm it themselves; `cancelled` when there was no longer
   * anything to charge by the time it came round.
   */
  status: text("status").notNull().default("charging"),
  amount: money("amount"),
  /** The payment attempt in `integration_event`, which the webhook settles. */
  attemptEventId: uuid("attempt_event_id"),
  intentId: text("intent_id"),
  failureCode: text("failure_code"),
  failureReason: text("failure_reason"),
  /** When a declined automatic payment is tried again. Null when it will not be. */
  retryAt: timestamp("retry_at", { withTimezone: true }),
  /** How the customer was sent the link to pay another way: `email`, `text`, or `not_sent` with the reason. */
  customerTold: text("customer_told"),
  customerToldNote: text("customer_told_note"),
  /** The office task raised about it. */
  taskId: uuid("task_id"),
  /** The office's request key, so a double press is one charge. */
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  autopayIdx: uniqueIndex("card_on_file_charge_autopay_idx").on(t.organizationId, t.invoiceId, t.attempt)
    .where(sql`${t.trigger} = 'autopay'`),
  keyIdx: uniqueIndex("card_on_file_charge_key_idx").on(t.organizationId, t.idempotencyKey)
    .where(sql`${t.idempotencyKey} is not null`),
  invoiceIdx: index("card_on_file_charge_invoice_idx").on(t.organizationId, t.invoiceId),
  openIdx: index("card_on_file_charge_open_idx").on(t.organizationId, t.status),
}));
