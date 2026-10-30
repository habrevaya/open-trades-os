import { pgTable, pgEnum, uuid, text, index, uniqueIndex, timestamp, date, numeric, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, money } from "./_shared";
import { organization, technician, user } from "./tenancy";
import { job } from "./work";
import { companyAsset } from "./assets";

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
  /**
   * For a claim entered as miles driven: the miles, to a tenth, and the rate for one mile it was worked out at,
   * kept here so a rate changed later never reprices it. `amount` is those two multiplied, to the cent. Both
   * null for one entered as an amount paid. Worked out at the rate in force on `spent_on`, the day of the drive.
   */
  miles: numeric("miles", { precision: 8, scale: 1 }),
  mileageRate: numeric("mileage_rate", { precision: 7, scale: 3 }),
  /**
   * Which line the rate came from, for a claim in miles: the company's, the person's own or the vehicle's. Kept
   * so the claim can say so for as long as it exists. Null on a claim made before there were overrides, which
   * were all worked out at the company's rate, and the view reads it so.
   */
  mileageRateSource: text("mileage_rate_source"),
  /** The vehicle the person named on a claim in miles, and its name as it was. Neither is read back to price anything. */
  mileageAssetId: uuid("mileage_asset_id").references(() => companyAsset.id, { onDelete: "set null" }),
  mileageAssetLabel: text("mileage_asset_label"),
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
  /** Miles and the rate they were worked out at are one fact: a claim has both or neither. */
  milesWithRate: check("expense_miles_with_rate", sql`(${t.miles} is null) = (${t.mileageRate} is null)`),
  rateSourceKnown: check("expense_rate_source_known", sql`${t.mileageRateSource} is null or ${t.mileageRateSource} in ('company', 'person', 'vehicle')`),
}));

/**
 * A MILEAGE RATE OF ONE PERSON'S OR ONE VEHICLE'S OWN, FROM A DAY (M17)
 *
 * The company's rate for a mile is a history in its pay settings. A company that pays one driver more
 * (a heavy truck, a long commute) or one vehicle less keeps that here: a line for one person or one
 * vehicle, from a day, in the same shape as the company's own. A claim in miles is worked out at the
 * vehicle's line in force on the day of the drive, else the person's, else the company's, and keeps
 * the rate and where it came from on the claim (`expense.mileage_rate`, `mileage_rate_source`), so a
 * line added or taken off here never reprices a claim already made.
 *
 * Exactly one of the person and the vehicle is named. A line is taken off, never edited, for the reason
 * the company's lines are: a list that said something other than what claims were paid at would be wrong.
 */
export const mileageRateOverride = pgTable("mileage_rate_override", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").references(() => technician.id, { onDelete: "cascade" }),
  assetId: uuid("asset_id").references(() => companyAsset.id, { onDelete: "cascade" }),
  /** The first day the rate applies, a company date. */
  fromDay: date("from_day").notNull(),
  /** Dollars for one mile, up to three decimals. */
  perMile: numeric("per_mile", { precision: 7, scale: 3 }).notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oneSubject: check("mileage_rate_override_one_subject", sql`(${t.technicianId} is null) <> (${t.assetId} is null)`),
  personDayIdx: uniqueIndex("mileage_rate_override_person_day_idx").on(t.organizationId, t.technicianId, t.fromDay)
    .where(sql`technician_id is not null`),
  assetDayIdx: uniqueIndex("mileage_rate_override_asset_day_idx").on(t.organizationId, t.assetId, t.fromDay)
    .where(sql`asset_id is not null`),
}));

/**
 * A DAY AWAY, AT THE RATE OF WHERE IT WAS.
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
  /**
   * The place whose rate the day was worked out at, when the company has places (M17), and its name
   * as it was. Neither is a foreign key: places live in the company's pay settings, a place is
   * retired rather than deleted, and the name is what the office reads on a day recorded long ago.
   * Both are null for a day at the company's one standard rate.
   */
  placeId: uuid("place_id"),
  placeName: text("place_name"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  placeNamed: check("per_diem_place_named", sql`(${t.placeId} is null) = (${t.placeName} is null)`),
  personDayIdx: uniqueIndex("per_diem_person_day_idx").on(t.organizationId, t.technicianId, t.day),
  jobIdx: index("per_diem_job_idx").on(t.organizationId, t.jobId),
}));
