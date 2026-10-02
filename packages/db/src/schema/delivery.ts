import { pgTable, pgEnum, uuid, text, jsonb, integer, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, money } from "./_shared";
import { organization, user } from "./tenancy";
import { customer } from "./crm";
import { report } from "./platform";
import { message } from "./comms";

/**
 * THINGS THAT ARRIVE ON THEIR OWN
 *
 * A report somebody has to remember to run is a report that gets run when
 * something has already gone wrong. An owner wants receivables by age in their
 * inbox on Monday morning, and their accountant wants the month's invoices on
 * the first. A customer with a balance wants a statement once a month without
 * anybody in the office remembering to send one.
 *
 * Two kinds of schedule, one table, one clock. The cadence, the pause, the
 * cursor saying when it is next due and the last thing that went wrong are the
 * same for both, and so is the worker pass that fires them: a second table with
 * a second clock would be a second place for "it was paused but it sent
 * anyway" to happen.
 *
 * THE SCHEDULE IS A CURSOR, NOT A TIMER, exactly as `workflow_schedule` is. A
 * row says when it is next due, a pass asks the database what is due, and the
 * delivery and the move of the cursor commit together, so a worker that dies
 * mid send rolls both back and the next pass tries again.
 *
 * ONCE PER PERIOD IS A UNIQUE INDEX, not a hope. Each delivery row carries the
 * key of the occurrence it was for, and the second attempt at the same one
 * inserts nothing. That is what makes a restart, a second worker, or somebody
 * moving the time from seven to eight after the seven o'clock one already went
 * all send nothing twice.
 */

export const deliveryKind = pgEnum("delivery_kind", ["report", "statements"]);
export const deliveryFrequency = pgEnum("delivery_frequency", ["daily", "weekly", "monthly"]);

export const deliverySchedule = pgTable("delivery_schedule", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  kind: deliveryKind("kind").notNull(),
  /** What the list calls it. The report's own name when it was created. */
  name: text("name").notNull(),
  /**
   * Which report, on a report schedule: exactly one of a built-in slug or a
   * saved report. A POINTER rather than a copy, for the reason a dashboard tile
   * is one: a schedule holding its own definition keeps emailing last
   * quarter's version of a report after somebody corrected it.
   */
  builtInReport: text("built_in_report"),
  reportId: uuid("report_id").references(() => report.id, { onDelete: "cascade" }),
  frequency: deliveryFrequency("frequency").notNull(),
  /** ISO weekdays, Monday 1 to Sunday 7. Weekly only. */
  weekdays: jsonb("weekdays").$type<number[]>().notNull().default([]),
  /** 1 to 28. Monthly only. See `checkCadence` in core for why not 31. */
  dayOfMonth: integer("day_of_month"),
  /** `HH:MM` in the company's timezone. */
  timeOfDay: text("time_of_day").notNull(),
  /** Which days a delivered report covers. `Period` in core. */
  period: text("period").notNull().default("all"),
  /**
   * People in the company, by user. Their address is read when the report
   * goes, so somebody who changes their email gets the next one at the new
   * address, and somebody who has left the company gets nothing.
   */
  recipientUserIds: jsonb("recipient_user_ids").$type<string[]>().notNull().default([]),
  /** Addresses outside the company: the accountant, the bookkeeper. */
  externalAddresses: jsonb("external_addresses").$type<string[]>().notNull().default([]),
  /** Statements only: a customer owing this much or less is not sent one. */
  minimumBalance: money("minimum_balance"),
  /**
   * WHOSE AUTHORITY A REPORT RUNS UNDER. The person who set it up, re-checked
   * against what they hold on the day it runs, so a report somebody has lost
   * the right to see stops arriving rather than carrying on in their name.
   */
  ownerUserId: uuid("owner_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Paused, not deleted: the history stays and it comes back on the same clock. */
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  /** Why the last attempt did not go, in words. Cleared by one that did. */
  lastError: text("last_error"),
  ...timestamps,
}, (t) => ({
  dueIdx: index("delivery_schedule_due_idx").on(t.nextRunAt),
  orgIdx: index("delivery_schedule_org_idx").on(t.organizationId, t.kind),
  /**
   * One statement run per company. Two would send every customer two
   * statements a month, which is the complaint a setting exists to avoid.
   */
  statementsIdx: uniqueIndex("delivery_schedule_statements_idx").on(t.organizationId)
    .where(sql`${t.kind} = 'statements'`),
}));

/**
 * ONE ATTEMPT TO DELIVER A REPORT, and what became of it.
 *
 * Written whether it went or not. A report that failed to run because its
 * author lost access, or went to nobody because every address was suppressed,
 * is a row saying so, because "it just stopped arriving" is the complaint and
 * the answer has to be on a screen rather than in a log nobody reads.
 */
export const reportDelivery = pgTable("report_delivery", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  scheduleId: uuid("schedule_id").references(() => deliverySchedule.id, { onDelete: "set null" }),
  /** Set when an automation sent it rather than a schedule. */
  workflowRunId: uuid("workflow_run_id"),
  /**
   * `schedule:{id}:{day}` or `run:{runId}:{step}`. The unique index on it is
   * the whole of "never twice".
   */
  idempotencyKey: text("idempotency_key").notNull(),
  /** As it was called when it went, which survives the report being renamed. */
  reportName: text("report_name").notNull(),
  builtInReport: text("built_in_report"),
  reportId: uuid("report_id"),
  /** The dates it covered. `to` exclusive, like every report range. */
  periodFrom: date("period_from"),
  periodTo: date("period_to"),
  /** `queued`, `partly_queued`, `refused` or `failed`. */
  status: text("status").notNull(),
  rowCount: integer("row_count"),
  /**
   * Who it was for and what happened to each: the message queued for them, or
   * the reason it was not. The message's own status says whether it was
   * delivered after that, and is read rather than copied here.
   */
  recipients: jsonb("recipients")
    .$type<{ address: string; userId?: string; messageId?: string; refused?: string }[]>()
    .notNull().default([]),
  error: text("error"),
  ranAsUserId: uuid("ran_as_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  keyIdx: uniqueIndex("report_delivery_key_idx").on(t.organizationId, t.idempotencyKey),
  scheduleIdx: index("report_delivery_schedule_idx").on(t.organizationId, t.scheduleId, t.createdAt),
}));

/**
 * ONE STATEMENT SENT TO ONE CUSTOMER.
 *
 * By hand from the statement page, or by the monthly run. A monthly one names
 * the month it was for, and one customer has at most one per month: the
 * unique index, again, rather than a check somebody could race past.
 *
 * The email carries a LINK to the statement on the customer's own account
 * page rather than the numbers, so `closing_balance` here is what it said when
 * it went, kept for the office's list, and the customer sees today's figures
 * when they open it.
 */
export const statementDelivery = pgTable("statement_delivery", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  scheduleId: uuid("schedule_id").references(() => deliverySchedule.id, { onDelete: "set null" }),
  /** `2026-09` on a monthly run. Null on one sent by hand. */
  period: text("period"),
  periodFrom: date("period_from").notNull(),
  /** Inclusive, as the statement prints it. */
  periodTo: date("period_to").notNull(),
  destination: text("destination"),
  closingBalance: money("closing_balance"),
  messageId: uuid("message_id").references(() => message.id, { onDelete: "set null" }),
  portalGrantId: uuid("portal_grant_id"),
  /** Why it did not go: no address, suppressed, no email connected. */
  error: text("error"),
  sentByUserId: uuid("sent_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  periodIdx: uniqueIndex("statement_delivery_period_idx").on(t.organizationId, t.customerId, t.period)
    .where(sql`${t.period} is not null`),
  customerIdx: index("statement_delivery_customer_idx").on(t.organizationId, t.customerId, t.createdAt),
}));
