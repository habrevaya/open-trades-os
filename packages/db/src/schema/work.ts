import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { pk, timestamps, sourceRef, sourceRefIndex, money } from "./_shared";
import { organization, businessUnit, location, technician } from "./tenancy";
import { customer, property, equipment } from "./crm";
import { marketingChannel, acquisitionCampaign } from "./acquisition";
import { capacityModel, crew, route, routeStop, rental, territory } from "./scheduling";

/**
 * WORK
 *
 * `job` is the commercial unit: what was sold, what gets invoiced, what gets
 * costed. `visit` is the operational unit: what gets dispatched to a truck on
 * a given day.
 *
 * One job has many visits. This is NOT an edge case. A diagnostic trip, a
 * parts-return trip and a two-day install are all one job. Modeling a job as a
 * single calendar block is the mistake that forces every "we need to reschedule
 * half of this" workaround, and it is why Jobber struggles with install work.
 */

export const jobStatus = pgEnum("job_status", [
  "lead", "estimating", "scheduled", "in_progress", "on_hold",
  "completed", "invoiced", "paid", "cancelled",
]);

/**
 * Note `completed_after_cancellation`, which looks like a contradiction and is
 * the most important state in this enum.
 *
 * A technician works offline. Dispatch cancels the visit while they are in a
 * crawlspace with no signal. The technician completes the work and syncs.
 *
 * The naive resolution is to reject their write, because the server is
 * authoritative and the visit is cancelled. That is wrong, and expensively so:
 * rejecting it destroys the labour record, the photos, the signature, the
 * readings and, in a regulated trade, a compliance record that legally has to
 * exist. The work physically happened. Deleting the evidence does not undo it.
 *
 * So the write is ACCEPTED into a distinguished state and a dispatcher
 * exception is raised for a human to resolve. The general rule, applied
 * everywhere in the sync layer: never reject a field write that records
 * something that actually happened.
 */
export const visitStatus = pgEnum("visit_status", [
  "unassigned", "scheduled", "dispatched", "en_route",
  "working", "completed", "cancelled", "no_show",
  "completed_after_cancellation",
]);

/**
 * WHAT KIND OF REVENUE A JOB TYPE PRODUCES
 *
 * Added because the trade packs' own KPI definitions depend on it and nothing
 * could answer them. Eight packs declare sixty three KPIs between them, and
 * roughly a third name a distinction this column is: "install revenue",
 * "completed service calls to non members", "the recurring route average",
 * "deep cleans, move outs and post construction, which are all day jobs".
 *
 * `capacity_model` is a different question and is not this. It says HOW the work
 * is scheduled: one technician, a crew, a route, a container on hire. Two job
 * types with the same capacity model can be an install and a maintenance visit,
 * which carry different margins and belong in different numbers.
 *
 *   install      a replacement or a new system. Capital work, priced as a
 *                project, and the margin an owner watches most closely.
 *   service      a one off call: a repair, a diagnosis, an unblocking.
 *   recurring    a stop on a programme or a route. The thing a renewal rate and
 *                a stops-per-day figure are about.
 *   project      multi day crew work. A deep clean, a landscape build, a
 *                post construction clean. Counted separately from `recurring`
 *                because an all day job in a route average pulls it to nothing.
 *   internal     not customer revenue at all: a yard repair, a shop day, a
 *                container inspection. In a revenue-per-day denominator these
 *                are capacity consumed and nothing earned, which is exactly why
 *                they have to be distinguishable rather than absent.
 */
export const jobRevenueClass = pgEnum("job_revenue_class", [
  "install", "service", "recurring", "project", "internal",
]);

export const jobType = pgTable("job_type", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code"),
  /**
   * Which capacity model schedules this work. See schema/scheduling.ts.
   * Set per job type rather than per organization, because a landscape company
   * genuinely runs crew_production for installs and route for maintenance, and
   * a plumbing company that starts renting portable toilets should not need a
   * second system.
   */
  capacityModel: capacityModel("capacity_model").notNull().default("technician_dispatch"),
  /**
   * Defaults to `service`, which is the commonest and the least wrong thing to
   * assume about a job type somebody created by hand without saying.
   */
  revenueClass: jobRevenueClass("revenue_class").notNull().default("service"),
  /** Units of production for crew_production. Square feet, linear feet, yards. */
  productionUnit: text("production_unit"),
  defaultDurationMinutes: integer("default_duration_minutes").notNull().default(60),
  /** Skills a technician must hold to be assignable. Enforced by the scheduling engine. */
  requiredSkills: jsonb("required_skills").$type<string[]>().notNull().default([]),
  /**
   * Equipment this kind of work cannot be done without, as the same
   * `company_asset.requirement_code` values `crew.required_asset_ids` holds.
   *
   * It is the counterpart of that column and the reason it can be enforced.
   * A crew declares the kit it carries; a job type declares the kit the work
   * needs; a crew missing one of these cannot take the job no matter who is
   * standing in the truck. Without this column `crew.required_asset_ids` is
   * a list with nothing to compare against, and the comment on it saying
   * "enforced at assignment" could not be true of any code.
   *
   * Per job type rather than per job, exactly like `required_skills` above,
   * because the chipper is a property of tree removal rather than of one
   * customer's tree. For the same reason it is a code rather than a row id:
   * tree removal needs a chipper, not chipper number two, and a job type
   * pinned to one machine breaks the day that machine is sold.
   */
  requiredAssetIds: jsonb("required_asset_ids").$type<string[]>().notNull().default([]),
  checklistTemplate: jsonb("checklist_template").$type<Array<{ id: string; label: string; required: boolean }>>().notNull().default([]),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  color: text("color"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("job_type_org_idx").on(t.organizationId) }));

export const job = pgTable("job", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** Human-facing sequential number, per organization. Generated, never the uuid. */
  number: integer("number").notNull(),
  /**
   * The branch's mark printed in front of the number ("AUS-1042"), written
   * once when the job is made and only when the company prints branch marks.
   * Never worked out again: see the same column on `invoice`.
   */
  numberPrefix: text("number_prefix"),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  jobTypeId: uuid("job_type_id").references(() => jobType.id, { onDelete: "set null" }),
  territoryId: uuid("territory_id").references(() => territory.id, { onDelete: "set null" }),
  /** Size of the work in the job type's production unit, for crew scheduling. */
  productionQuantity: money("production_quantity"),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  status: jobStatus("status").notNull().default("lead"),
  summary: text("summary").notNull(),
  description: text("description"),
  /** The customer's own words, captured at intake. Invaluable for the AI agents. */
  customerComplaint: text("customer_complaint"),
  equipmentId: uuid("equipment_id").references(() => equipment.id, { onDelete: "set null" }),
  /**
   * The catalogue key this job is credited to. Filled when blank from the
   * attribution the company chose, and `lead_source_origin` says so: a
   * source somebody picked and a source the touches implied are different
   * evidence.
   */
  leadSource: text("lead_source"),
  leadSourceOrigin: text("lead_source_origin"),
  /** The channel and tracking campaign the credited touch belonged to. */
  channelId: uuid("channel_id").references(() => marketingChannel.id, { onDelete: "set null" }),
  acquisitionCampaignId: uuid("acquisition_campaign_id")
    .references(() => acquisitionCampaign.id, { onDelete: "set null" }),
  /**
   * The outbound text or email send (`marketing_campaign`) this job is
   * credited to, when the credited touch carried that send's utm tag.
   * Written by `services/marketing.ts` `creditWork`, which every path that
   * creates work for a customer calls. Its foreign key is declared in
   * `sql/after.sql`, because the campaign tables import this one.
   */
  campaignId: uuid("campaign_id"),

  /**
   * WHOSE PRICE GOVERNS. Our price book is not the authority in five segments:
   * a commercial contract rate card, a warranty network schedule, a
   * manufacturer labour allowance, an insurance price list, or a bid we
   * submitted. Cost tracking stays ours regardless, which is what keeps margin
   * reporting honest even on work we did not price.
   */
  priceSource: text("price_source").notNull().default("price_book"),
  rateCardId: uuid("rate_card_id"),
  contractId: uuid("contract_id"),

  /**
   * Required on the invoice by most commercial and property management
   * clients, and by every builder. Trivial to add now, painful to backfill
   * across a migrated data set later.
   */
  purchaseOrderNumber: text("purchase_order_number"),
  costCode: text("cost_code"),
  /** Set when this job is warranty rework on a previous one. Drives callback rate. */
  parentJobId: uuid("parent_job_id"),
  isWarranty: boolean("is_warranty").notNull().default(false),
  /** Generated from a membership or recurring schedule rather than booked ad hoc. */
  agreementId: uuid("agreement_id"),
  priority: integer("priority").notNull().default(0),
  /**
   * SKILLS THIS ONE JOB NEEDS BEYOND ITS JOB TYPE.
   *
   * A job type says what its work ordinarily needs. One unusual job (a
   * service call on a unit that turns out to need a confined space entry, a
   * repair on a roof that needs a lift ticket) needs something its type does
   * not, and before this column the only place to say so was a note nobody's
   * assignment check read. Added to the type's list wherever a person is
   * checked for the work, never instead of it.
   */
  requiredSkills: jsonb("required_skills").$type<string[]>().notNull().default([]),
  total: money("total"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancellationReason: text("cancellation_reason"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  sourceRefIdx: sourceRefIndex("job_source_ref_idx", t),
  orgStatusIdx: index("job_org_status_idx").on(t.organizationId, t.status),
  customerIdx: index("job_customer_idx").on(t.customerId),
  propertyIdx: index("job_property_idx").on(t.propertyId),
  /**
   * UNIQUE, not merely indexed. The number is allocated as max + 1 under an
   * advisory lock in services/jobs.ts, and the lock is a convention a future
   * insert can forget. This is the part that cannot be forgotten.
   */
  numberIdx: uniqueIndex("job_number_idx").on(t.organizationId, t.number),
}));

export const visit = pgTable("visit", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull().default(1),
  status: visitStatus("status").notNull().default("unassigned"),
  /**
   * Arrival WINDOW, not a point in time. Contractors promise "between 1 and 4",
   * and storing a single timestamp is what produces the angry review.
   */
  windowStart: timestamp("window_start", { withTimezone: true }),
  windowEnd: timestamp("window_end", { withTimezone: true }),
  estimatedDurationMinutes: integer("estimated_duration_minutes").notNull().default(60),
  locationId: uuid("location_id").references(() => location.id, { onDelete: "set null" }),
  /** Ordering within a technician's day, set by the dispatch board and route pass. */
  routeOrder: integer("route_order"),
  /**
   * Locked by the office: the rebalance and the route optimiser leave this
   * visit with whoever has it, in its place. For the customer who was
   * promised "Ray, first thing", which no arrival window can say.
   */
  dispatchLocked: boolean("dispatch_locked").notNull().default(false),
  /**
   * The days, in the company's calendar, the customer agreed this visit may
   * happen on: "any day the week of the fifth". Null at either end is no
   * agreement, and a visit with neither stays on its day unless its
   * customer named the days of the week that suit them. The multi day
   * rebalance moves a visit only inside these, and tells the customer.
   */
  movableFrom: date("movable_from"),
  movableUntil: date("movable_until"),

  /**
   * Exactly one of these is set, determined by the job type's capacity model.
   * technician_dispatch uses visit_assignment, the other three use these.
   */
  crewId: uuid("crew_id").references(() => crew.id, { onDelete: "set null" }),
  routeId: uuid("route_id").references(() => route.id, { onDelete: "set null" }),
  routeStopId: uuid("route_stop_id").references(() => routeStop.id, { onDelete: "set null" }),
  rentalId: uuid("rental_id").references(() => rental.id, { onDelete: "set null" }),
  /** delivery or pickup, for asset_rental work where the two are separate events. */
  rentalEvent: text("rental_event"),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  enRouteAt: timestamp("en_route_at", { withTimezone: true }),
  arrivedAt: timestamp("arrived_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  technicianNotes: text("technician_notes"),
  /**
   * What the customer reads about this visit, chosen by the office.
   *
   * A copy rather than a switch on `technician_notes`, because those notes
   * keep growing from the phone after the visit and a customer must read
   * the words somebody in the office approved, not whatever was appended at
   * the next sync. Null means nothing is shown. Set with
   * `servicereport:publish`, the same decision as publishing a report.
   */
  customerNotes: text("customer_notes"),
  customerNotesSharedAt: timestamp("customer_notes_shared_at", { withTimezone: true }),
  checklist: jsonb("checklist").$type<Array<{ id: string; label: string; required: boolean; doneAt: string | null }>>().notNull().default([]),
  signatureUrl: text("signature_url"),
  ...sourceRef,
  /**
   * The company's own fields, checked against the definitions in M29 by the
   * service that writes them. See `services/custom-fields.ts`.
   */
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => ({
  sourceRefIdx: sourceRefIndex("visit_source_ref_idx", t),
  jobIdx: index("visit_job_idx").on(t.jobId),
  /** The dispatch board's primary query: everything in a window, by org. */
  boardIdx: index("visit_board_idx").on(t.organizationId, t.windowStart, t.status),
}));

/** A visit can carry a crew, not just one technician. */
export const visitAssignment = pgTable("visit_assignment", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  visitId: uuid("visit_id").notNull().references(() => visit.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  isLead: boolean("is_lead").notNull().default(false),
  ...timestamps,
}, (t) => ({
  visitIdx: index("visit_assignment_visit_idx").on(t.visitId),
  techIdx: index("visit_assignment_tech_idx").on(t.technicianId),
}));

export const jobLineKind = pgEnum("job_line_kind", [
  "part", "labor", "equipment", "subcontractor", "disposal", "permit", "other",
]);

export const jobLineSource = pgEnum("job_line_source", ["field", "office", "import"]);

/**
 * WHAT WAS ACTUALLY DONE, AS OPPOSED TO WHAT WAS BILLED
 *
 * A job line and an invoice line are not the same thing, and collapsing them
 * is what makes job costing impossible.
 *
 * Warranty work has job lines and no invoice lines: the labour and the part
 * were real and the customer paid nothing. A flat rate job is the opposite,
 * one invoice line and a dozen job lines underneath it, because the customer
 * bought an outcome and the company needs to know what the outcome cost. A
 * callback has job lines that must never reach an invoice and must absolutely
 * reach the margin on the original job.
 *
 * So this table is the record of consumption, and invoice_line is the record
 * of billing. `invoiceLineId` connects them where they connect, and stays null
 * where they do not, which is how unbilled work becomes a query rather than a
 * discovery at the end of the month.
 */
export const jobLine = pgTable("job_line", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  /** Which visit consumed it. Null for something the office added centrally. */
  visitId: uuid("visit_id").references(() => visit.id, { onDelete: "set null" }),
  kind: jobLineKind("kind").notNull().default("part"),
  source: jobLineSource("source").notNull().default("office"),

  /** Frozen reference, never the live item. The same rule as invoice_line. */
  priceBookItemVersionId: uuid("price_book_item_version_id"),
  name: text("name").notNull(),
  description: text("description"),
  quantity: money("quantity").notNull().default("1"),
  /** What it would bill at. Zero on warranty and on our own rework. */
  unitPrice: money("unit_price").notNull().default("0"),
  /**
   * What it cost us. The reason this table exists.
   *
   * A zero dollar line under a warranty and a zero dollar line that is our own
   * callback look identical on a revenue report and mean opposite things about
   * the business. The cost is what tells them apart.
   */
  unitCost: money("unit_cost"),
  taxable: boolean("taxable").notNull().default(true),

  /** Who recorded it, which for anything from the field is the technician. */
  technicianId: uuid("technician_id").references(() => technician.id, { onDelete: "set null" }),
  /** Set once it has been billed. Null means unbilled, which is a query. */
  invoiceLineId: uuid("invoice_line_id"),
  /** Set when the line is deliberately not billable: warranty, goodwill, rework. */
  nonBillableReason: text("non_billable_reason"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  jobIdx: index("job_line_job_idx").on(t.jobId),
  visitIdx: index("job_line_visit_idx").on(t.visitId),
  /** Everything consumed and not yet billed. The month end query. */
  unbilledIdx: index("job_line_unbilled_idx").on(t.organizationId, t.invoiceLineId),
}));
