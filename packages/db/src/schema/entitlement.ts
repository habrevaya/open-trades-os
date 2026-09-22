import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, timestamp, date } from "drizzle-orm/pg-core";
import { pk, timestamps, money, rate } from "./_shared";
import { organization } from "./tenancy";
import { customer, property, equipment } from "./crm";
import { job, visit } from "./work";

/**
 * ENTITLEMENT: WHO IS PAYING FOR THIS, AND WHY
 *
 * Separate from the party model, which answers WHO. This answers WHY IT IS
 * FREE, OR CHEAPER, OR BILLED TO SOMEONE ELSE.
 *
 * Research found this is the single most load-bearing missing concept. Every
 * one of these is a different coverage source and they produce completely
 * different money behaviour on the same physical visit:
 *
 *   customer            they pay, at our price
 *   agreement           included in a maintenance plan, so zero revenue on
 *                       the visit and recognised revenue on the agreement
 *   parts_warranty      manufacturer pays for the part, customer pays labour
 *   labour_warranty     we eat the labour, manufacturer pays the part
 *   our_warranty        our own callback, nobody is billed and it costs us
 *   home_warranty       an administrator pays a rate card, customer pays a
 *                       trade call fee
 *   insurance           a carrier pays most, customer pays a deductible
 *   goodwill            we chose to absorb it, and that decision is reportable
 *   no_charge_callback  rework on our own work, which must never be billed
 *
 * If a visit and an invoice line do not carry a RESOLVED coverage source,
 * then invoicing, pricing, the field app script and agreement profitability
 * all have to reconstruct it later from circumstantial evidence, and all four
 * get rewritten when they cannot.
 *
 * The distinction that matters most for reporting: a zero dollar visit under
 * an agreement and a zero dollar visit that is our own rework look identical
 * on a revenue report and mean opposite things about the business.
 */
export const coverageSource = pgEnum("coverage_source", [
  "customer",
  "agreement",
  "parts_warranty",
  "labour_warranty",
  "our_warranty",
  "home_warranty",
  "insurance",
  "goodwill",
  "no_charge_callback",
  "contract",
]);

/**
 * The resolved entitlement for a visit or a line. Written at resolution time,
 * not derived on read, because the inputs change and the record must not.
 */
export const entitlement = pgTable("entitlement", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  source: coverageSource("source").notNull().default("customer"),

  jobId: uuid("job_id").references(() => job.id, { onDelete: "cascade" }),
  visitId: uuid("visit_id").references(() => visit.id, { onDelete: "cascade" }),
  equipmentId: uuid("equipment_id").references(() => equipment.id, { onDelete: "set null" }),

  /** What granted it: the membership, the contract, the warranty record. */
  grantingEntityType: text("granting_entity_type"),
  grantingEntityId: uuid("granting_entity_id"),
  /** Their claim or authorisation number. */
  externalReference: text("external_reference"),

  /** Covers labour, parts, or both. Warranty splits are the common case. */
  coversLabour: boolean("covers_labour").notNull().default(false),
  coversParts: boolean("covers_parts").notNull().default(false),
  coversTrip: boolean("covers_trip").notNull().default(false),
  /** Percentage the source covers, where it is not all or nothing. */
  coveragePercent: rate("coverage_percent"),
  /** Cap, where the source has one. Distinct from an authorization ceiling. */
  coverageLimit: money("coverage_limit"),
  /** What the customer still owes regardless: deductible, trade call fee. */
  customerResponsibility: money("customer_responsibility"),

  resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedByUserId: uuid("resolved_by_user_id"),
  notes: text("notes"),
  ...timestamps,
}, (t) => ({
  visitIdx: index("entitlement_visit_idx").on(t.visitId),
  jobIdx: index("entitlement_job_idx").on(t.jobId),
  /** Agreement profitability, and the cost of our own rework. Both reportable. */
  sourceIdx: index("entitlement_source_idx").on(t.organizationId, t.source, t.resolvedAt),
}));

/**
 * ASSET CENTRICITY
 *
 * A commercial visit is not "work at a property", it is work on a LIST OF
 * ASSETS at a property. A fire inspection covers 40 extinguishers and 3 risers.
 * A restaurant PM covers 12 pieces of kitchen equipment. Each one gets its own
 * readings, findings, photos and pass or fail.
 *
 * Two things the original equipment table could not express, both of which are
 * a results-table migration to add later:
 *   - assets NEST. A riser has valves; a rooftop unit has a compressor.
 *   - assets MOVE. Equipment is relocated, swapped under warranty, or follows
 *     a tenant. Service history has to follow the asset, not the address.
 */
export const visitAsset = pgTable("visit_asset", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  visitId: uuid("visit_id").notNull().references(() => visit.id, { onDelete: "cascade" }),
  equipmentId: uuid("equipment_id").notNull().references(() => equipment.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull().default(0),
  /** pass | fail | not_accessible | not_present | deferred */
  outcome: text("outcome"),
  notes: text("notes"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  visitIdx: index("visit_asset_visit_idx").on(t.visitId, t.sequence),
  equipmentIdx: index("visit_asset_equipment_idx").on(t.equipmentId),
}));

export const equipmentMove = pgTable("equipment_move", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  equipmentId: uuid("equipment_id").notNull().references(() => equipment.id, { onDelete: "cascade" }),
  fromPropertyId: uuid("from_property_id").references(() => property.id, { onDelete: "set null" }),
  toPropertyId: uuid("to_property_id").references(() => property.id, { onDelete: "set null" }),
  /** relocated | swapped_under_warranty | replaced | removed | returned */
  reason: text("reason").notNull(),
  movedOn: date("moved_on").notNull(),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  notes: text("notes"),
  ...timestamps,
}, (t) => ({ equipmentIdx: index("equipment_move_equipment_idx").on(t.equipmentId, t.movedOn) }));
