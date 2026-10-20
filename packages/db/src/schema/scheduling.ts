import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp, date, time, check } from "drizzle-orm/pg-core";
import { pk, timestamps, sourceRef, money, rate, geocodeColumns } from "./_shared";
import { sql } from "drizzle-orm";
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

/**
 * A WEEK OF OPENING HOURS: seven rows for the company (no branch, no number),
 * seven for a branch that keeps its own, and seven for a phone number set to
 * keep its own. Core's `holidays.weekFor` and `weekForNumber` choose which a
 * reader reads. A row is one owner's, never a branch's and a number's at once.
 */
export const businessHours = pgTable("business_hours", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "cascade" }),
  /**
   * The phone number whose own week this is; goes with the number. The
   * foreign key to `phone_number` (on delete cascade) is written in the
   * migration that added the column rather than here, because importing
   * `comms` into this file is an import cycle (comms, work, scheduling) that
   * breaks the schema's loading.
   */
  phoneNumberId: uuid("phone_number_id"),
  /** 0 = Sunday, matching JS getDay(). */
  dayOfWeek: integer("day_of_week").notNull(),
  opensAt: time("opens_at"),
  closesAt: time("closes_at"),
  closed: boolean("closed").notNull().default(false),
  ...timestamps,
}, (t) => ({
  orgIdx: index("business_hours_org_idx").on(t.organizationId, t.dayOfWeek),
  oneOwner: check("business_hours_one_owner", sql`${t.businessUnitId} is null or ${t.phoneNumberId} is null`),
}));

/**
 * THE COMPANY'S OWN HOLIDAYS: a date it is closed, or open with hours of its
 * own, on top of the week above.
 *
 * Read by everything that reads the week: online booking offers no window on a
 * closed date, the phones route a call on one as after hours, the reviews
 * clock does not run, the multi day rebalance moves nothing onto it, and a
 * recurring task told to skip holidays skips it. Core's `holidays` holds the
 * rule, so every reader asks the same question the same way.
 *
 * `repeats_yearly` is a fixed date holiday: only the month and day of `date`
 * are read. A holiday that moves carries its `rule` (the fourth Thursday of
 * November) and is worked out for each year; `observed` keeps a repeating
 * one off a weekend (the Monday after when it falls on a Sunday). A row with
 * a `business_unit_id` is that branch's own, read by that branch's readers
 * beside the company's; it goes with the branch if the branch is deleted
 * rather than becoming the whole company's. Removed outright when the
 * company takes one off the list; nothing points at a row, and the audit log
 * keeps what it said.
 */
export const holidayObserved = pgEnum("holiday_observed", ["as_is", "sunday_to_monday", "weekend_to_weekday"]);

export const companyHoliday = pgTable("company_holiday", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  date: date("date").notNull(),
  repeatsYearly: boolean("repeats_yearly").notNull().default(false),
  /** Shut all day. False is open, with the hours below. */
  closed: boolean("closed").notNull().default(true),
  opensAt: time("opens_at"),
  closesAt: time("closes_at"),
  /** A day of the week in a month, `{ month, weekday, week }`, for a holiday that moves. Null for a date. */
  rule: jsonb("rule").$type<{ month: number; weekday: number; week: 1 | 2 | 3 | 4 | "last" } | null>(),
  /** Where a repeating holiday is kept when it lands on a weekend. */
  observed: holidayObserved("observed").notNull().default("as_is"),
  /** The branch whose own holiday this is. Null is the whole company's. */
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "cascade" }),
  /**
   * The phone number whose own day off this is, read only for that number
   * and only while it keeps its own hours; never the company's or a
   * branch's. Goes with the number: the foreign key is the migration's, as
   * on `business_hours` above.
   */
  phoneNumberId: uuid("phone_number_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgIdx: index("company_holiday_org_idx").on(t.organizationId, t.date),
  branchIdx: index("company_holiday_branch_idx").on(t.businessUnitId),
  numberIdx: index("company_holiday_number_idx").on(t.phoneNumberId),
  oneOwner: check("company_holiday_one_owner", sql`${t.businessUnitId} is null or ${t.phoneNumberId} is null`),
}));

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
  /**
   * The kit this crew carries, as `company_asset.requirement_code` values.
   * Enforced at assignment by `services/crews.ts`.
   *
   * CODES RATHER THAN ROW IDS, which is the whole reason this is a jsonb list
   * of strings and not a join table of foreign keys. A crew carries "a
   * chipper", not chipper number two: tying it to one physical machine means
   * retiring that machine or buying a second one silently changes what the
   * crew can do. The register resolves a code to every unit behind it.
   */
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
  /**
   * The operator's own drive time between two consecutive stops on this
   * route, in minutes.
   *
   * Density is stop time PLUS travel, and travel is the half that decides
   * whether a fifteenth stop runs into overtime: a dense subdivision pool
   * route is four minutes between gates and a rural one is twenty five, on
   * identical stop times. There is no geocoding in this product, so the only
   * honest source of that number is the person who drives the route.
   *
   * It lives on the route rather than being passed in by whoever asks,
   * because two screens passing different assumptions would give two
   * different answers to "will this day run long", and the dispatch board
   * already learned that lesson with `isLate`.
   *
   * NULLABLE, and null is not zero. An undeclared route reports its stop
   * time as a FLOOR and says that travel is not included, rather than
   * claiming a day fits when nobody has said how far apart the stops are.
   */
  travelMinutesBetweenStops: integer("travel_minutes_between_stops"),
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

/**
 * HOW A DISPOSAL FACILITY CHARGES: by the ton on the scale ticket, or a flat
 * price for the load. `disposal_fee_basis` in the database.
 */
export const disposalFeeBasis = pgEnum("disposal_fee_basis", ["per_ton", "per_load"]);

/**
 * A LANDFILL OR TRANSFER STATION, AS A PLACE.
 *
 * A full can is tipped at one of these and not at the yard, and until this
 * existed a hire recorded only the facility's name as free text. A facility
 * has an address and a pin (geocoded by the worker like a property, and
 * pinnable by hand), the hours it takes loads, and what it charges, so the
 * route can go yard to customer to facility to the next stop and the fee on a
 * weighed load can be worked out rather than typed.
 *
 * `hours` is the week as a list of days with an opening and a closing time;
 * a day not listed is a day it is closed, and an empty list means nobody has
 * recorded them, which the planner never treats as closed.
 *
 * A facility is closed with `active` and never deleted (nothing writes its
 * `deleted_at`), because every haul that went there keeps pointing at it. The
 * facility a day is planned around unless told otherwise is the one flagged
 * `is_default`, of which a company has at most one.
 */
export const disposalFacility = pgTable("disposal_facility", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country").notNull().default("US"),
  /** The pin, the same way a property has one: geocoded by the worker, or placed by hand and then never moved. */
  ...geocodeColumns(),
  /** Days it takes loads: `{ day: 0 to 6 from Sunday, opens: "07:00", closes: "16:30" }`. */
  hours: jsonb("hours").$type<{ day: number; opens: string; closes: string }[]>().notNull().default([]),
  /**
   * Days it is shut whatever its week says: `{ date: "2026-11-26", name: "Thanksgiving", yearly: false }`.
   * A yearly one is shut on that month and day every year. A day listed here
   * wins over the hours, even for a facility whose hours nobody has recorded.
   */
  holidays: jsonb("holidays").$type<{ date: string; name: string | null; yearly: boolean }[]>().notNull().default([]),
  feeBasis: disposalFeeBasis("fee_basis"),
  /** Per ton or per load, as `fee_basis` says. */
  feeAmount: money("fee_amount"),
  /** The least it charges for any load, when it has a minimum. */
  minimumFee: money("minimum_fee"),
  /**
   * The materials it takes: `{ material: "Yard waste", feeBasis: "per_ton", feeAmount: "38.0000" }`,
   * the rate null for one charged at the general rate above. An empty list is
   * not recorded, which never turns a load away; a listed one is the whole of
   * what it takes, so the route does not send it a can of anything else.
   */
  materials: jsonb("materials")
    .$type<{ material: string; feeBasis: "per_ton" | "per_load" | null; feeAmount: string | null }[]>()
    .notNull().default([]),
  /** Minutes for the queue, the scale and the tip, which the route counts. */
  tipMinutes: integer("tip_minutes").notNull().default(20),
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  ...timestamps,
}, (t) => ({
  orgIdx: index("disposal_facility_org_idx").on(t.organizationId, t.name),
  /** One default at a time: the facility a day is planned around when nobody names another. */
  defaultIdx: uniqueIndex("disposal_facility_default_idx").on(t.organizationId)
    .where(sql`${t.isDefault} and ${t.active}`),
}));

/**
 * HOW A HIRE IS INVOICED: each haul on an invoice of its own, or a swap chain
 * on one invoice for the whole hire. `rental_invoice_mode` in the database.
 */
export const rentalInvoiceMode = pgEnum("rental_invoice_mode", ["per_haul", "chain"]);

export const rental = pgTable("rental", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  assetId: uuid("asset_id").notNull().references(() => rentableAsset.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  /**
   * Whether `delivered_at` is the moment the can was put down, or only its day.
   *
   * The containers board took a delivery as a day and kept it at midday, which
   * bills the right container days and says nothing about the hour. The pack's
   * turnaround is hours from a can emptied at the facility to it placed on the
   * next site, and hours from a midday nobody chose would be hours from a
   * guess. False for every hire recorded before this was kept, because nobody
   * can now say which of them had a real time; such a placement is counted
   * beside the turnaround figure, never given an hour.
   */
  deliveredTimeKnown: boolean("delivered_time_known").notNull().default(false),
  pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
  /**
   * When the full can was emptied at the facility, from the driver's phone or
   * typed by the office when the ticket arrives.
   *
   * Not the pickup (that includes the drive and the queue at the gate) and not
   * the scale ticket's weighbridge time, which is when the truck was weighed
   * and is read from a facility's file only to the day. Null until somebody
   * records it.
   */
  tippedAt: timestamp("tipped_at", { withTimezone: true }),
  /**
   * When the can was collected EMPTY, for a haul that came back with nothing
   * in it: no tip is expected and none will come. The container's turnaround
   * runs from here instead, so its next placement is measured rather than
   * counted beside as not known. A moment on the collection's day, recorded
   * by the office with the mark; null for every haul that was not empty. A
   * haul cannot be both tipped and empty, which the service enforces.
   */
  cameBackEmptyAt: timestamp("came_back_empty_at", { withTimezone: true }),
  /** Billing runs off the period, and the included window drives overage. */
  includedDays: integer("included_days"),
  dailyRate: money("daily_rate"),
  overageRate: money("overage_rate"),
  /** Disposal weight tickets, which is how junk and dumpster work actually bills. */
  weightTons: money("weight_tons"),
  disposalFee: money("disposal_fee"),
  /**
   * The rental this one replaced in a swap, when it is one.
   *
   * A swap is one stop that takes the full can and leaves an empty one at the
   * same address, and the dumpster pack's `avg_rental_duration` KPI says in so
   * many words that it "counts a swap inside the parent rental rather than as a
   * rental of its own". A swap has to close one row and open another, because
   * `asset_id` is a single column and the can physically changed, so without
   * this link a four week construction hire with three swaps reads as four
   * unrelated week long rentals and the average duration comes out at a
   * quarter of the truth.
   *
   * The chain is backwards rather than forwards because that is the direction
   * the write goes: the swap knows what it replaced, and nothing has to be
   * updated on the row that is being closed.
   */
  previousRentalId: uuid("previous_rental_id"),
  /**
   * The scale ticket's own number and where the load went.
   *
   * Written here rather than only as a reading on the visit, because this is
   * the support behind the largest line on the invoice and the largest line in
   * the cost of goods, and the pack's retention rule keeps a disposal ticket
   * for three years from the haul. A number that lives only in a visit's
   * readings blob cannot be totalled, reconciled against the facility's
   * account, or found when a customer questions a tonnage charge.
   */
  disposalTicketNumber: text("disposal_ticket_number"),
  disposalFacility: text("disposal_facility"),
  /**
   * The facility the load went to, when it is one the company has recorded.
   * The name above is kept in step with it, so a report that reads the text
   * and a screen that reads this say the same thing; a facility typed in words
   * with no record behind it leaves this null.
   */
  disposalFacilityId: uuid("disposal_facility_id").references(() => disposalFacility.id, { onDelete: "set null" }),
  /** One of the pack's material options. Free text because facilities differ. */
  materialType: text("material_type"),
  /** Diverted to recycling, for the diversion report a jurisdiction collects. */
  divertedTons: money("diverted_tons"),
  /** What the quoted price covers, so the two meters have something to measure against. */
  includedTons: money("included_tons"),
  perTonRate: money("per_ton_rate"),
  /**
   * The stop that will collect it, once the collection scheduler has put one
   * on the board. Read before scheduling, so running the scheduler twice puts
   * one collection on the route rather than two. No foreign key, because
   * `visit` is declared in a file that imports this one; the service writes it
   * from the visit it has just created.
   */
  collectionVisitId: uuid("collection_visit_id"),
  /**
   * When the customer agreed the collection should happen, when they agreed
   * one: the start and end of the window, as instants. It beats the day the
   * price runs out, early or late, and the collection is booked into it by
   * the worker or by a person. Null is no agreement: the collection goes on
   * the day the price covers to, in the working day.
   */
  collectionAgreedStart: timestamp("collection_agreed_start", { withTimezone: true }),
  collectionAgreedEnd: timestamp("collection_agreed_end", { withTimezone: true }),
  /**
   * THE HIRE'S BILLING TERMS, carried forward through every swap like its rates.
   *
   * `invoice_as` is the company's choice per rental: a swap chain is invoiced
   * one haul at a time (each row on its own invoice), or as one invoice for the
   * whole hire with the lines of every haul on it.
   *
   * `disposal_pass_through` is the terms saying the facility's disposal fee is
   * the customer's, at cost. It is the terms and nothing more: the fee is OFFERED
   * when the invoice is raised and added only when a person says to.
   */
  invoiceAs: rentalInvoiceMode("invoice_as").notNull().default("per_haul"),
  disposalPassThrough: boolean("disposal_pass_through").notNull().default(false),
  /**
   * WHETHER THE DISPOSAL FEE WAS PASSED ON. Null until somebody decided, true
   * when it went on the invoice, false when it was left off, with who and when
   * and the amount that was offered, so "did we charge them for the dump" has an
   * answer that does not depend on reading invoice lines.
   */
  disposalFeePassedOn: boolean("disposal_fee_passed_on"),
  disposalFeeAmount: money("disposal_fee_amount"),
  disposalFeeDecidedAt: timestamp("disposal_fee_decided_at", { withTimezone: true }),
  disposalFeeDecidedByUserId: uuid("disposal_fee_decided_by_user_id"),
  /**
   * The invoice this hire's period and meters were billed on. Set by raising
   * it, and read before raising another, so the same extra days cannot reach
   * two invoices. No foreign key, for the same reason as the stop above.
   */
  invoiceId: uuid("invoice_id"),
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
