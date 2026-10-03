import { pgTable, uuid, text, index, timestamp } from "drizzle-orm/pg-core";
import { pk, money } from "./_shared";
import { organization, technician } from "./tenancy";
import { invoice, payment } from "./billing";
import { job } from "./work";
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  paymentIdx: index("tip_share_payment_idx").on(t.organizationId, t.paymentId),
  invoiceIdx: index("tip_share_invoice_idx").on(t.organizationId, t.invoiceId),
  technicianIdx: index("tip_share_technician_idx").on(t.organizationId, t.technicianId, t.occurredAt),
}));
