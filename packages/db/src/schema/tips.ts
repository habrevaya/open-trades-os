import { pgTable, uuid, text, index, timestamp } from "drizzle-orm/pg-core";
import { pk, money } from "./_shared";
import { organization, technician, user } from "./tenancy";
import { invoice, payment } from "./billing";
import { job, visit } from "./work";
import { payPeriod } from "./workforce";

/**
 * A TIP, AND WHO IT IS FOR.
 *
 * The payment carries the tip as one amount (`payment.tip_amount`), and the
 * ledger holds it as owed to technicians from the moment it arrives. This is
 * the other half: WHICH technicians, how much each, for which job, and
 * whether it has been passed on yet. Without it the company would know it
 * owed its technicians forty dollars and not to whom.
 *
 * Split when the money arrives, between the technicians on the job's visits
 * as they were when the customer chose the tip, because that is who the
 * customer was thanking. Written once and not re-split when a visit is later
 * reassigned: the tip is the customer's decision about the people who came.
 *
 * Paid through payroll. A tip appears as its own line on the pay register
 * and the export for the period it arrived in, and paying it out discharges
 * the liability against cash and marks these rows paid.
 */
export const tipShare = pgTable("tip_share", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  paymentId: uuid("payment_id").notNull().references(() => payment.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").references(() => invoice.id, { onDelete: "set null" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id),
  amount: money("amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  /** When the payment carrying it arrived, which decides the pay period it lands in. */
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paidInPeriodId: uuid("paid_in_period_id").references(() => payPeriod.id, { onDelete: "set null" }),
  /**
   * The company's rule the share was worked out by, and a sentence when that
   * rule had nothing to go on and the tip was shared evenly instead. Kept on
   * the share, so a tip already split is never re-split by a later choice, and
   * so "why did Sam get twice what Priya did" has an answer on the row.
   */
  splitRule: text("split_rule").notNull().default("even"),
  splitNote: text("split_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  paymentIdx: index("tip_share_payment_idx").on(t.organizationId, t.paymentId),
  invoiceIdx: index("tip_share_invoice_idx").on(t.organizationId, t.invoiceId),
  technicianIdx: index("tip_share_technician_idx").on(t.organizationId, t.technicianId, t.occurredAt),
}));

/**
 * A CASH TIP THE TECHNICIAN KEPT.
 *
 * A customer hands the technician a twenty at the door, for them. It never
 * reaches the company, so nothing about it is on the books: no payment, no
 * Tips payable, nothing to pass on. It is still pay, and a tip an employee
 * keeps is reported to the employer and taxed through payroll, so the
 * technician records it on the phone and it appears on their pay statement
 * and the export as `cash_tip`, already in their hand.
 *
 * Its id is the one the phone made, so a retried sync records it once. The
 * technician is the phone's own, never one the payload names: nobody records
 * a tip on somebody else's pay.
 */
export const cashTip = pgTable("cash_tip", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  visitId: uuid("visit_id").references(() => visit.id, { onDelete: "set null" }),
  amount: money("amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  /** When it was handed over, by the phone's clock as the sync resolved it. */
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  note: text("note"),
  /**
   * Who put it on their pay when it was not the technician: the office, from
   * what a customer said. Null is the technician's own, from the phone. For
   * one the office recorded, `note` is the reason it was recorded.
   */
  recordedByUserId: uuid("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Their name as it was then, because a person's own row is all row level security lets anybody read. */
  recordedByName: text("recorded_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  technicianIdx: index("cash_tip_technician_idx").on(t.organizationId, t.technicianId, t.receivedAt),
}));

/**
 * A CASH TIP CHANGED, AND WHY.
 *
 * What a person's pay says they were handed is reported as pay, so changing it
 * is never silent: the office says why, the amount before and after is kept
 * here, and the technician sees the history beside the tip. A correction to
 * nothing is how a tip that was never given comes off their pay.
 */
export const cashTipCorrection = pgTable("cash_tip_correction", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  cashTipId: uuid("cash_tip_id").notNull().references(() => cashTip.id, { onDelete: "cascade" }),
  previousAmount: money("previous_amount").notNull(),
  newAmount: money("new_amount").notNull(),
  reason: text("reason").notNull(),
  correctedByUserId: uuid("corrected_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Their name as it was then, because a person's own row is all row level security lets anybody read. */
  correctedByName: text("corrected_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tipIdx: index("cash_tip_correction_tip_idx").on(t.organizationId, t.cashTipId, t.createdAt),
}));
