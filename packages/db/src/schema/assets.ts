import {
  pgTable, pgEnum, uuid, text, integer, boolean, jsonb, date, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { pk, timestamps, money, currency } from "./_shared";
import { organization, user } from "./tenancy";
import { recurrenceModel } from "./agreements";

/**
 * FLEET, TOOLS AND COMPANY ASSETS: THE STORAGE
 *
 * `packages/core/src/assets/index.ts` is fourteen hundred lines of decision
 * logic about things a company owns: who has the core drill, what the hour
 * meter said, when the calibration lapses and what that does to the reports
 * the instrument already produced. Every function in it is pure, every one of
 * them takes its facts as arguments, and until this file there was nowhere in
 * the product those facts could be kept. The logic had no caller because it
 * had no data.
 *
 * SO THE COLUMNS ARE DICTATED RATHER THAN DESIGNED. Each table below is one
 * of core's interfaces with a tenant and a primary key added, and the
 * comments say which. Inventing a shape here and then adapting core to it
 * would mean re-deciding things that file already decided at length and with
 * reasons, and the reasons are the valuable part.
 *
 * WHAT THIS IS NOT, and the line matters because the two get conflated by
 * everybody who has not worked in the trade:
 *
 *   `equipment`        THE CUSTOMER'S. The furnace at 12 Oak Street. It has a
 *                      serial, a warranty and ten years of service history,
 *                      and it belongs to the homeowner. `services/equipment.ts`.
 *
 *   `rentable_asset`   A HIRE UNIT. A dumpster that goes out on a job, comes
 *                      back, and bills by the day. It is a thing the company
 *                      SELLS THE USE OF, and its binding question is
 *                      utilization. `schema/scheduling.ts`, the asset_rental
 *                      capacity model.
 *
 *   `company_asset`    THE COMPANY'S OWN TOOLS. The van, the chipper, the
 *                      thermal imager. Nobody is billed for it. Its questions
 *                      are custody, wear and expiry, and it is this file.
 *
 * A dumpster and a core drill are both "an asset" in English and nothing else
 * about them is the same, which is why they are not one table.
 *
 * NO `deleted_at` FILTER ANYWHERE THAT READS THESE TABLES. The columns exist
 * because `timestamps` carries them on every table in this schema, and
 * nothing in this module sets one: an asset is RETIRED, by a date, which is
 * core's own word and a column something writes. `test/unwritten-columns.test.ts`
 * makes the argument at length: a filter on a column nothing sets is
 * decoration that makes a query look guarded when it is not.
 */

/**
 * The six kinds, from core's `ASSET_KINDS`.
 *
 * Duplicated here by necessity rather than by choice: the column has to be
 * constrained and Postgres cannot hold core's `ASSET_KIND_PROFILES`, which is
 * where the meaning lives. `test/assets.integration.test.ts` asserts the two
 * lists are the same, because a kind added to core and not here is a screen
 * offering an option every save rejects.
 */
export const assetKind = pgEnum("asset_kind", [
  "vehicle", "powered_tool", "hand_tool", "instrument", "trailer", "equipment",
]);

/** Core's `MeterUnit`. What counter this thing wears out by, if it has one. */
export const assetMeterUnit = pgEnum("asset_meter_unit", [
  "hours", "miles", "kilometres", "cycles",
]);

/**
 * Core's `CustodianKind`. A person, a place, or a job.
 *
 * Three rather than one because "who has it" and "where is it" are different
 * questions, and core says so: a trailer lives at a yard and a thermal imager
 * lives in somebody's truck, and recording the trailer as being in a person's
 * pocket is how a register stops being believed.
 */
export const assetCustodianKind = pgEnum("asset_custodian_kind", [
  "technician", "location", "job",
]);

/** Core's `ComplianceKind`. The four dates that can stop something happening. */
export const assetComplianceKind = pgEnum("asset_compliance_kind", [
  "registration", "inspection", "insurance", "calibration",
]);

/** Core's `AssetCostKind`. */
export const assetCostKind = pgEnum("asset_cost_kind", [
  "acquisition", "maintenance", "fuel", "repair", "insurance",
  "registration", "storage", "other",
]);

/**
 * Where a reading came from, from core's `MeterReading.source`.
 *
 * Kept because the four are believed differently. A telematics number and a
 * number a technician read off a dusty gauge in the rain are both readings,
 * and when two of them disagree this column is the only thing that says which
 * one to look at first.
 */
export const assetReadingSource = pgEnum("asset_reading_source", [
  "technician", "telematics", "invoice", "import",
]);

/** Which of core's two interval shapes a maintenance task is on. */
export const assetIntervalBasis = pgEnum("asset_interval_basis", ["time", "meter"]);

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

/**
 * One thing the company owns. Core's `Asset`.
 *
 * THERE IS NO `current_custodian_id` COLUMN AND THERE SHOULD NEVER BE ONE.
 * Core states the rule and the reason: custody is a fold over an append only
 * history, and the moment a mutable holder column exists, some path writes an
 * assignment without updating it and the register confidently names the wrong
 * person from then on. It is found by the person who no longer works here.
 * The same argument `inventory` makes about a stored `available`.
 *
 * NO `location_id` EITHER, for the same reason. A place is a custodian: see
 * `asset_custody.custodian_kind`.
 */
export const companyAsset = pgTable("company_asset", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  kind: assetKind("kind").notNull(),
  /** What a person calls it on a list. "Chipper 2", "Van 14", "FLIR E8". */
  label: text("label").notNull(),
  /**
   * WHAT A CREW AND A JOB TYPE NAME WHEN THEY SAY THEY NEED ONE.
   *
   * `crew.required_asset_ids` and `job_type.required_asset_ids` are lists of
   * strings that, before this table, had nothing behind them at all. This
   * column is what they match.
   *
   * IT IS NOT UNIQUE AND IT IS NOT THIS ROW'S ID, which is the whole point. A
   * job type that says tree removal needs a chipper is talking about a CLASS
   * of machine, not about one serial number. Pointing it at a uuid would tie
   * every tree removal in the company to one physical chipper, so buying a
   * second one or retiring the first silently breaks the job type. Two
   * chippers carry the same code and either satisfies the requirement.
   *
   * Matched by exact equality, which is the same comparison crews has always
   * made between the two lists. Null for a thing no crew declares.
   */
  requirementCode: text("requirement_code"),
  /** Serial, VIN or asset tag. Core: absent for a pooled hand tool record. */
  identifier: text("identifier"),
  /**
   * The counter this unit wears out by, or null when it wears out by time.
   *
   * Carried per asset rather than read from core's kind profile because the
   * profile gives the ordinary case and not every case. Core models
   * kilometres and no kind defaults to it: a company outside the United
   * States meters the same van in km, and with the unit pinned to the kind
   * there is nowhere to say so. The profile is the default this column is
   * seeded from, not a replacement for it.
   */
  meterUnit: assetMeterUnit("meter_unit"),
  /**
   * An override of core's per day plausibility ceiling, in the asset's own
   * unit. Null means use `METER_UNITS[unit].maxPerDay`.
   *
   * It exists because core's `ReadingOptions.maxPerDay` exists, and that
   * option exists for the machine that genuinely runs harder than the
   * ceiling: a generator on a storm job runs 24 hours and a two truck relay
   * really does cover more than 1,200 miles. Without somewhere to record it,
   * the honest reading from that machine is refused every day and people
   * learn to stop entering readings.
   */
  meterMaxPerDay: integer("meter_max_per_day"),
  /**
   * How many of it there are, for a kind core marks `trackedIndividually:
   * false`.
   *
   * A box of screwdrivers is a quantity because serialising a screwdriver
   * costs more than the screwdriver, and a register that demands it is a
   * register nobody fills in. Everything else is 1 and has its own row,
   * because any one of twenty core drills can be the one that does not come
   * back.
   */
  quantity: integer("quantity").notNull().default(1),
  acquiredOn: date("acquired_on"),
  /**
   * THE RETIREMENT, which is this module's delete.
   *
   * A sold van and a stolen imager leave the fleet and their history has to
   * survive them: the readings are what the cost per mile was built from and
   * the custody record is what answers "who had it last". Deleting the row
   * destroys both, so nothing here deletes.
   */
  retiredOn: date("retired_on"),
  notes: text("notes"),
  ...timestamps,
}, (t) => ({
  orgIdx: index("company_asset_org_idx").on(t.organizationId, t.kind),
  /** The crew check reads by code on every verdict, for every crew on a job. */
  codeIdx: index("company_asset_code_idx").on(t.organizationId, t.requirementCode),
  /**
   * One serial, one row. Two records for the same van is the same split
   * history defect `equipment` guards against for the customer's furnace:
   * half the readings on one and half on the other, and no number about
   * either is right. Postgres does not collide nulls, so the pooled hand tool
   * record with no identifier is unaffected.
   */
  identifierIdx: uniqueIndex("company_asset_identifier_idx").on(t.organizationId, t.identifier),
}));

// ---------------------------------------------------------------------------
// Custody
// ---------------------------------------------------------------------------

/**
 * One period during which one asset was with one custodian. Core's
 * `CustodyAssignment`.
 *
 * HALF OPEN, `[held_from, held_until)`, which is core's decision and not a
 * detail. A handover on the 4th means the old assignment runs UNTIL the 4th
 * and the new one runs FROM the 4th, and the asset is in exactly one place on
 * the 4th. Every other reading either double counts that day or loses it.
 *
 * APPEND ONLY. The only column anything updates is `held_until`, which is
 * what closing an assignment means. A mistaken assignment is corrected by
 * closing it and opening the true one, so the record of what people believed
 * at the time survives: when a technician leaves and the imager is not in the
 * box, the question is "who had it, when, and who said so", and an
 * overwritten row cannot answer any part of it.
 */
export const assetCustody = pgTable("asset_custody", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  assetId: uuid("asset_id").notNull().references(() => companyAsset.id, { onDelete: "cascade" }),
  custodianKind: assetCustodianKind("custodian_kind").notNull(),
  /**
   * A technician, a location or a job, depending on the kind beside it.
   *
   * POLYMORPHIC, SO NO FOREIGN KEY, and that is a cost rather than a choice:
   * Postgres cannot point one column at three tables. The service checks the
   * referenced row exists in the right table before writing, because without
   * that check this column is a uuid-shaped field that will eventually hold a
   * technician id under `custodian_kind = 'location'` and nothing will say so.
   */
  custodianId: uuid("custodian_id").notNull(),
  heldFrom: date("held_from").notNull(),
  /** Null means open: they still have it. */
  heldUntil: date("held_until"),
  /**
   * Who said so. Half of what makes a custody record worth anything in the
   * conversation it exists for.
   */
  recordedByUserId: uuid("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  note: text("note"),
  ...timestamps,
}, (t) => ({
  assetIdx: index("asset_custody_asset_idx").on(t.organizationId, t.assetId, t.heldFrom),
  /** "What is Ana holding" reads this way, across every asset at once. */
  custodianIdx: index("asset_custody_custodian_idx")
    .on(t.organizationId, t.custodianKind, t.custodianId, t.heldFrom),
}));

// ---------------------------------------------------------------------------
// Meter readings
// ---------------------------------------------------------------------------

/**
 * What the meter said, on a day. Core's `MeterReading`.
 *
 * `value` IS AN INTEGER BECAUSE CORE REFUSES ANYTHING ELSE. Whole units as
 * they appear on the face of the meter: a fraction here becomes float
 * arithmetic that later divides money, in `costPerUnitOfUse`.
 *
 * THE RESET PAIR IS THE SUBTLE PART. A failed hour meter gets swapped and the
 * new one starts at zero while the machine still has 4,812 hours on it.
 * Inferring that from a decrease throws all of them away, so core REFUSES a
 * decrease and makes the replacement a declaration: what the old meter
 * finally read, and why. Both columns are set together or neither is, which
 * the service enforces, because a reset with no final value silently restarts
 * the machine's life at zero and a final value with no reason is a number
 * nobody can audit.
 */
export const assetMeterReading = pgTable("asset_meter_reading", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  assetId: uuid("asset_id").notNull().references(() => companyAsset.id, { onDelete: "cascade" }),
  unit: assetMeterUnit("unit").notNull(),
  value: integer("value").notNull(),
  takenOn: date("taken_on").notNull(),
  source: assetReadingSource("source").notNull(),
  /** The highest the OLD meter ever showed, immediately before replacement. */
  resetPreviousFinalValue: integer("reset_previous_final_value"),
  resetReason: text("reset_reason"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  /**
   * Every read of this table is "this asset, in date order": accepting a
   * reading compares against the latest, usage sums consecutive pairs, and
   * the projection walks a window backwards from the end.
   */
  assetIdx: index("asset_meter_reading_asset_idx").on(t.organizationId, t.assetId, t.takenOn),
}));

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * A recurring service on one asset. Core's `MaintenancePlan`.
 *
 * TWO BASES THAT ARE GENUINELY DIFFERENT PROBLEMS, which is the central
 * distinction in core's file and the reason this table has two sets of
 * columns rather than one clever one.
 *
 * "Every six months" is a RECURRENCE. It goes through the recurrence module,
 * which already knows about counting from actual completion, seasonal
 * anchoring and exceptions, and the time columns here are the same ones
 * `recurring_schedule` carries so the one parser reads both.
 *
 * "Every 250 hours" CANNOT go through it at all. It is a function of how hard
 * the machine gets used next month, which has not happened. There is no rule
 * that produces the date, only a projection from the recent rate of use, and
 * core refuses to launder that guess through the calendar machinery where it
 * would come out looking like a fact.
 */
export const assetMaintenancePlan = pgTable("asset_maintenance_plan", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  assetId: uuid("asset_id").notNull().references(() => companyAsset.id, { onDelete: "cascade" }),
  /** "250 hour service", "Annual DOT inspection". What goes on the worklist. */
  label: text("label").notNull(),
  basis: assetIntervalBasis("basis").notNull(),

  /** --- the time basis, mirroring `recurring_schedule` --------------------- */
  model: recurrenceModel("model"),
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  intervalDays: integer("interval_days"),
  anchorMonths: jsonb("anchor_months").$type<number[]>().notNull().default([]),

  /** --- the meter basis ---------------------------------------------------- */
  meterUnit: assetMeterUnit("meter_unit"),
  /** Units of use between services. 250 hours, 5000 miles. */
  everyUnits: integer("every_units"),

  /**
   * When this task was last ACTUALLY done, which both bases count from.
   *
   * A date rather than a stored meter reading at service, deliberately, and
   * core says why: a stored reading is meaningless the moment the meter is
   * replaced, and a date survives it. The usage since the service is measured
   * from whichever reading sits nearest this day.
   */
  lastServicedOn: date("last_serviced_on"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  assetIdx: index("asset_maintenance_plan_asset_idx").on(t.organizationId, t.assetId),
}));

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

/**
 * A date that expires and stops something. Core's `ComplianceObligation`.
 *
 * ONE ROW PER KIND PER ASSET, holding the CURRENT obligation. A renewal moves
 * `expires_on` forward and sets `last_certified_on` to the day the new
 * certificate was issued; it does not append a row, because every question
 * anybody asks of this table is about the one in force.
 *
 * `last_certified_on` IS NOT PAPERWORK AND IT IS ONLY ABOUT CALIBRATION.
 * Registration, inspection and insurance stop something happening tomorrow.
 * Calibration reaches BACKWARDS: an instrument out of certificate did not
 * start producing bad numbers on the day the certificate lapsed, it has been
 * drifting, so every report it produced since the last good calibration is
 * open to challenge. This column is the date that list of reports starts
 * from, and without it core's `workAtRiskSince` can never be set.
 */
export const assetCompliance = pgTable("asset_compliance", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  assetId: uuid("asset_id").notNull().references(() => companyAsset.id, { onDelete: "cascade" }),
  kind: assetComplianceKind("kind").notNull(),
  expiresOn: date("expires_on").notNull(),
  /** Plate number, certificate number, policy number. What to quote on the phone. */
  reference: text("reference"),
  /** For calibration: the last date the instrument was certified good. */
  lastCertifiedOn: date("last_certified_on"),
  ...timestamps,
}, (t) => ({
  assetIdx: index("asset_compliance_asset_idx").on(t.organizationId, t.assetId),
  /** The warning board: everything expiring, across the whole fleet, by date. */
  expiryIdx: index("asset_compliance_expiry_idx").on(t.organizationId, t.expiresOn),
  kindIdx: uniqueIndex("asset_compliance_kind_idx").on(t.assetId, t.kind),
}));

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * Money spent on one asset. Core's `AssetCost`.
 *
 * THIS TABLE DOES NOT DEPRECIATE ANYTHING, and core says why at length:
 * depreciation is an accounting policy with tax consequences, it belongs next
 * to the ledger, and a second module that thinks it knows the book value of a
 * van is a second answer that will drift from the first.
 *
 * `acquisition` IS A KIND RATHER THAN A COLUMN ON THE ASSET because core's
 * summary keeps it apart from running cost and needs it in the same list to
 * do so. Folding a purchase into the month's running cost makes the month a
 * van was bought look like the most expensive month of its life and every
 * month after it look free, and no comparison between two vans survives that.
 */
export const assetCost = pgTable("asset_cost", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  assetId: uuid("asset_id").notNull().references(() => companyAsset.id, { onDelete: "cascade" }),
  kind: assetCostKind("kind").notNull(),
  amount: money("amount").notNull(),
  currency: currency(),
  incurredOn: date("incurred_on").notNull(),
  note: text("note"),
  ...timestamps,
}, (t) => ({
  assetIdx: index("asset_cost_asset_idx").on(t.organizationId, t.assetId, t.incurredOn),
}));
