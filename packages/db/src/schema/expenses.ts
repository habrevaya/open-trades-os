import { pgTable, pgEnum, uuid, text, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { pk, money } from "./_shared";
import { organization, technician, user } from "./tenancy";
import { job } from "./work";

/**
 * WHAT A PERSON SPENT FOR THE COMPANY, AND A DAY AWAY
 *
 * A technician buys a part at a supply house with their own card, pays a toll,
 * or eats on a job two hours from home. The company owes it back. Two tables,
 * because the two are different facts:
 *
 *   `expense`   a receipt. Somebody paid, the office decides whether the company
 *               pays it back, and an approved one goes to the payroll bureau as
 *               a non-taxable reimbursement line for the pay period it was
 *               approved in.
 *   `per_diem`  an allowance. The company's flat rate for a day away from home,
 *               recorded by the office against the job the person was away on.
 *               There is no receipt and nothing to approve.
 *
 * NEITHER IS POSTED TO THE LEDGER. What the company owes a person for a receipt
 * is a payable, and whether this product books one is the decision receiving
 * stock already left unmade (M16): the reimbursement is paid through payroll
 * and the cost lands on the job's costing (M15), which is where an owner reads
 * it. Posting it would be a second place for the same money to be wrong.
 *
 * Every one is for a technician, because payroll is keyed by the people on the
 * board. Somebody who is not on the board is reimbursed the way they are paid.
 */
export const expenseStatus = pgEnum("expense_status", ["pending", "approved", "refused"]);

export const expense = pgTable("expense", {
  /** Made by the phone for one recorded offline, so a retried sync records it once. */
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id),
  /** The job it was for, when it was for one. Null is the shop: fuel for the van, a tool. */
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  amount: money("amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  /** The day it was paid, in the company's calendar. */
  spentOn: date("spent_on").notNull(),
  /** What it was for, in the person's words. */
  description: text("description").notNull(),
  status: expenseStatus("status").notNull().default("pending"),
  /**
   * Who decided and when. The instant of approval decides the pay period it is
   * paid in: the day the company agreed to pay it back, not the day it was
   * bought, so a receipt from last month approved this week is paid this week
   * and never changes a period that has already been paid.
   */
  decidedByUserId: uuid("decided_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Their name as it was when they decided, because a person's own row is all row level security lets anybody read. */
  decidedByName: text("decided_by_name"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  /** Required to refuse, optional to approve. The person reads it. */
  decisionReason: text("decision_reason"),
  /** When the person recorded it, by the phone's clock for one made offline. */
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personIdx: index("expense_person_idx").on(t.organizationId, t.technicianId, t.spentOn),
  statusIdx: index("expense_status_idx").on(t.organizationId, t.status, t.createdAt),
  jobIdx: index("expense_job_idx").on(t.organizationId, t.jobId),
}));

/**
 * A DAY AWAY, AT THE COMPANY'S RATE.
 *
 * The amount is the rate as it stood when the day was recorded, kept on the
 * row. A rate read live would change what was already paid the day somebody
 * edited it, which is the argument for freezing a wage rate on a punch.
 *
 * One per person per day: being away on two jobs on one day is one day away.
 */
export const perDiem = pgTable("per_diem", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id),
  /** The job they were away on, which is where the cost lands. */
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  /** The day away, in the company's calendar. It decides the pay period. */
  day: date("day").notNull(),
  amount: money("amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personDayIdx: uniqueIndex("per_diem_person_day_idx").on(t.organizationId, t.technicianId, t.day),
  jobIdx: index("per_diem_job_idx").on(t.organizationId, t.jobId),
}));
