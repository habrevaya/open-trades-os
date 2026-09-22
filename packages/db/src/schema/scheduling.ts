import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp, date, time } from "drizzle-orm/pg-core";
import { pk, timestamps, sourceRef, money, rate } from "./_shared";
import { organization, businessUnit, location, technician } from "./tenancy";
import { property } from "./crm";

/**
 * CAPACITY MODELS
 *
 * Research across twenty six trades found four structurally different ways a
 * home services company sells capacity, and NO existing platform models all
 * four. ServiceTitan is a dispatch system with routing bolted on through an
 * acquisition. Aspire and LMN are crew only. Skimmer is route only.
 * ServiceCore and Docket are asset only.
 *
 * Building all four as first class is the structural differentiator, and it
 * has to be decided now: retrofitting a second capacity model into an engine
 * that assumed the first is a rewrite, not a feature.
 *
 *   technician_dispatch  an individual with a skill set and a truck
 *                        plumbing, HVAC, electrical, garage door, locksmith
 *                        needs: skill matching, emergency preemption, same-day
 *
 *   crew_production      a crew with shared skills and shared equipment
 *                        tree, landscape install, painting, roofing, fencing
 *                        needs: crew composition, equipment as a constraint,
 *                        production rate per crew-day, multi-day phasing
 *
 *   route                a stop in a sequence, priced by density
 *                        pool, pest, lawn maintenance, cleaning, gutter, snow
 *                        needs: density economics, anchored-to-completion
 *                        recurrence, stop-level margin, weather triggers
 *
 *   asset_rental         a physical unit out on hire
 *                        dumpster, portable toilet, temporary fence
 *                        needs: per-asset availability, delivery and pickup as
 *                        separate events, rental period billing, utilization
 *                        rather than labor as the binding constraint
 */
export const capacityModel = pgEnum("capacity_model", [
  "technician_dispatch",
  "crew_production",
  "route",
  "asset_rental",
]);

// ---------------------------------------------------------------------------
// Service area
// ---------------------------------------------------------------------------

export const territory = pgTable("territory", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Either a postal code list or a drawn polygon. Most shops start with the list. */
  postalCodes: jsonb("postal_codes").$type<string[]>().notNull().default([]),
  boundary: jsonb("boundary").$type<{ type: "Polygon"; coordinates: number[][][] } | null>(),
  homeLocationId: uuid("home_location_id").references(() => location.id, { onDelete: "set null" }),
  /** Trip charge applied to work in this territory. Null means the org default. */
  travelFee: money("travel_fee"),
  color: text("color"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("territory_org_idx").on(t.organizationId) }));

export const businessHours = pgTable("business_hours", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "cascade" }),
  /** 0 = Sunday, matching JS getDay(). */
  dayOfWeek: integer("day_of_week").notNull(),
  opensAt: time("opens_at"),
  closesAt: time("closes_at"),
  closed: boolean("closed").notNull().default(false),
  ...timestamps,
}, (t) => ({ orgIdx: index("business_hours_org_idx").on(t.organizationId, t.dayOfWeek) }));

// ---------------------------------------------------------------------------
// Crews: the crew_production model
// ---------------------------------------------------------------------------

/**
 * A crew is the dispatchable unit for production trades. It is NOT just a list
 * of technicians: it carries a production rate and a set of required equipment,
 * because a tree crew without the chipper cannot take the job no matter who is
 * standing in the truck.
 */
export const crew = pgTable("crew", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  homeLocationId: uuid("home_location_id").references(() => location.id, { onDelete: "set null" }),
  /**
   * Units of production per crew-day, in the trade's own unit: square feet
   * painted, linear feet of fence, cubic yards of debris. Used to convert a
   * job's size into a schedule rather than guessing at hours.
   */
  productionRatePerDay: money("production_rate_per_day"),
  productionUnit: text("production_unit"),
  /** Asset ids this crew must have to be assignable. Enforced at assignment. */
  requiredAssetIds: jsonb("required_asset_ids").$type<string[]>().notNull().default([]),
  skills: jsonb("skills").$type<string[]>().notNull().default([]),
  color: text("color"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("crew_org_idx").on(t.organizationId) }));

export const crewMember = pgTable("crew_member", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  crewId: uuid("crew_id").notNull().references(() => crew.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  isLead: boolean("is_lead").notNull().default(false),
  ...timestamps,
}, (t) => ({
  uniq: uniqueIndex("crew_member_uniq_idx").on(t.crewId, t.technicianId),
}));

// ---------------------------------------------------------------------------
// Routes: the route model
// ---------------------------------------------------------------------------

/**
 * A route is a named recurring sequence of stops served on a given weekday by
 * a given technician or crew. Pool, pest, lawn and cleaning companies sell
 * routes, not appointments, and their unit economics are about density: how
 * many stops fit between the first and the last without overtime.
 */
export const route = pgTable("route", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  territoryId: uuid("territory_id").references(() => territory.id, { onDelete: "set null" }),
  technicianId: uuid("technician_id").references(() => technician.id, { onDelete: "set null" }),
  crewId: uuid("crew_id").references(() => crew.id, { onDelete: "set null" }),
  dayOfWeek: integer("day_of_week"),
  /** Target stops per day. The density number an owner actually manages to. */
  targetStopCount: integer("target_stop_count"),
  startsAt: time("starts_at"),
  color: text("color"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("route_org_idx").on(t.organizationId, t.dayOfWeek) }));

export const routeStop = pgTable("route_stop", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  routeId: uuid("route_id").notNull().references(() => route.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").notNull().references(() => property.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  estimatedMinutes: integer("estimated_minutes").notNull().default(20),
  /**
   * Recurrence anchored to COMPLETION, not to the calendar. A pool route is
   * "every 7 days from when it was actually last serviced", and storing only a
   * cadence without the anchor means every future date drifts. See the
   * migration playbook: this is where most imports break.
   */
  intervalDays: integer("interval_days"),
  lastServicedOn: date("last_serviced_on"),
  nextDueOn: date("next_due_on"),
  /** Route pricing is per stop, and margin is measured per stop, not per job. */
  pricePerStop: money("price_per_stop"),
  active: boolean("active").notNull().default(true),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  routeIdx: index("route_stop_route_idx").on(t.routeId, t.sequence),
  dueIdx: index("route_stop_due_idx").on(t.organizationId, t.nextDueOn),
}));

// ---------------------------------------------------------------------------
// Rentable assets: the asset_rental model
// ---------------------------------------------------------------------------

/**
 * A dumpster company's binding constraint is not labor, it is how many cans
 * are out and where. Utilization is the metric, delivery and pickup are two
 * separate dispatchable events, and billing runs on elapsed rental period
 * rather than on work performed.
 */
export const rentableAsset = pgTable("rentable_asset", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  assetType: text("asset_type").notNull(),
  identifier: text("identifier").notNull(),
  size: text("size"),
  homeLocationId: uuid("home_location_id").references(() => location.id, { onDelete: "set null" }),
  /** Where it is right now when it is out on hire. */
  currentPropertyId: uuid("current_property_id").references(() => property.id, { onDelete: "set null" }),
  status: text("status").notNull().default("available"),
  purchaseCost: money("purchase_cost"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  orgIdx: index("rentable_asset_org_idx").on(t.organizationId, t.assetType, t.status),
  identIdx: uniqueIndex("rentable_asset_identifier_idx").on(t.organizationId, t.identifier),
}));

export const rental = pgTable("rental", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  assetId: uuid("asset_id").notNull().references(() => rentableAsset.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
  /** Billing runs off the period, and the included window drives overage. */
  includedDays: integer("included_days"),
  dailyRate: money("daily_rate"),
  overageRate: money("overage_rate"),
  /** Disposal weight tickets, which is how junk and dumpster work actually bills. */
  weightTons: money("weight_tons"),
  disposalFee: money("disposal_fee"),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  assetIdx: index("rental_asset_idx").on(t.assetId),
  openIdx: index("rental_open_idx").on(t.organizationId, t.pickedUpAt),
}));

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export const timeOff = pgTable("time_off", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  reason: text("reason"),
  approved: boolean("approved").notNull().default(false),
  ...timestamps,
}, (t) => ({ techIdx: index("time_off_tech_idx").on(t.technicianId, t.startsAt) }));

export const onCallRotation = pgTable("on_call_rotation", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  /** Multiplier on labor for work taken during this window. */
  rateMultiplier: rate("rate_multiplier"),
  ...timestamps,
}, (t) => ({ orgIdx: index("on_call_org_idx").on(t.organizationId, t.startsAt) }));
