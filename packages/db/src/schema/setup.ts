import { pgTable, uuid, text, jsonb, integer, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { pk } from "./_shared";
import { organization, user } from "./tenancy";

/**
 * GETTING A COMPANY SET UP, AND WHAT IT WAS SET UP FROM
 *
 * Two tables, both written by the setup wizard and both small.
 */

/**
 * A SETUP STEP SOMEBODY SAID WAS DONE.
 *
 * The wizard used to compute nothing and store nothing, so every step read
 * as outstanding every time the list was opened, including the trade the
 * company had chosen a minute earlier. A list that cannot remember is a list
 * people stop believing.
 *
 * Done is a statement a person makes rather than something inferred from the
 * data, and that is deliberate. "Is the price book re-priced for your market"
 * has no answer in the database: a price book at national averages looks
 * exactly like one somebody checked line by line and agreed with. The step
 * pages say what is already in place beside the button, so the person
 * pressing it is deciding with the facts in front of them.
 *
 * One row per step. Marking a step not done deletes nothing: the row keeps who
 * marked it and when, with `completed_at` cleared, so "who un-ticked payments"
 * has an answer.
 */
export const setupStep = pgTable("setup_step", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** A key from the step catalogue in `packages/core/src/setup`. */
  stepKey: text("step_key").notNull(),
  /** Null while the step is outstanding, including after somebody reopened it. */
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** Whoever last marked it either way. */
  changedByUserId: uuid("changed_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  stepIdx: uniqueIndex("setup_step_key_idx").on(t.organizationId, t.stepKey),
}));

/**
 * ONE TIME A TRADE PACK WAS APPLIED, AND WHAT IT SEEDED.
 *
 * The snapshot is the reason this table exists. A pack is code, and the code
 * only ever holds the newest version of it, so by the time version two ships
 * nothing can say what version one put into this company's price book. And
 * that is exactly the question an upgrade has to answer for every item: is
 * the price on this row the one the pack seeded (and so the company's to
 * receive the new one), or one somebody here typed (and so never to be
 * touched)? Comparing the row against what was seeded answers it whatever
 * route the edit took: a single revision, a bulk re-price, an import.
 *
 * Append only. An upgrade is a new row with the new version's snapshot, so
 * the history reads as the sequence of versions the company has been on.
 */
export const tradePackApplication = pgTable("trade_pack_application", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  packId: text("pack_id").notNull(),
  version: integer("version").notNull(),
  /** `apply` for the first time, `upgrade` for a newer version over an older one. */
  kind: text("kind").notNull().default("apply"),
  /**
   * The price book as this version seeded it, by item code: name,
   * description, price, cost, labour minutes, taxable, tax class and
   * warranty, exactly as the pack declared them.
   */
  seeded: jsonb("seeded").$type<Record<string, Record<string, unknown>>>().notNull().default({}),
  /** What happened: counts of items and job types added, updated, kept and skipped. */
  result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
  appliedByUserId: uuid("applied_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  packIdx: index("trade_pack_application_pack_idx").on(t.organizationId, t.packId, t.version),
}));
