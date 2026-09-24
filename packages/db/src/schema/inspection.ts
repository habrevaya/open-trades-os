import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, timestamp, date } from "drizzle-orm/pg-core";
import { pk, timestamps, sourceRef, money } from "./_shared";
import { organization } from "./tenancy";
import { customer, property, equipment } from "./crm";
import { job, visit } from "./work";
import { serviceContract } from "./commercial";

/**
 * INSPECTION AND DEFICIENCY
 *
 * Research named this the highest value-to-effort gap in the whole spec, and
 * the reason is a loop that residential work does not have:
 *
 *   the inspection finds the deficiency
 *   the deficiency becomes the proposal
 *   the proposal becomes the work order
 *   the work order becomes the invoice
 *
 * The deficiency backlog is simultaneously a compliance record and the highest
 * converting sales pipeline a commercial contractor owns. Fire protection,
 * elevator, backflow, boiler, kitchen suppression, generator and pressure
 * vessel work all run on it.
 *
 * It also brings a shape the spec did not have: STATUTORY INSPECTION, where
 * the real audience of the report is an authority having jurisdiction rather
 * than the customer. The customer is not who has to be satisfied, and a
 * report format that pleases a homeowner will be rejected by a fire marshal.
 *
 * `service_recommendation` in the CRM module is the residential shadow of this
 * same idea. This is the commercial version, with a compliance obligation
 * attached.
 */

export const inspectionResult = pgEnum("inspection_result", [
  "pass", "pass_with_deficiencies", "fail", "not_tested", "not_accessible", "partial",
]);

/**
 * A recurring statutory or contractual inspection obligation on a property or
 * an asset. Shipped by a trade pack as a programme definition, which is what
 * makes this content rather than code for each new trade.
 */
export const inspectionProgram = pgTable("inspection_program", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** The standard or rule the inspection is performed under, as text. */
  standard: text("standard"),
  tradePackId: text("trade_pack_id"),
  /** Who receives the report, which is often not the customer. */
  reportAudience: text("report_audience").notNull().default("customer"),
  authorityName: text("authority_name"),
  frequencyMonths: integer("frequency_months"),
  /** Ordered checkpoints, shipped with the pack and versioned with it. */
  /**
   * Severity mirrors the deficiency_severity enum, advisory included. The
   * first version of this type omitted advisory and a trade pack using it
   * failed to compile, which is the type system doing its job: a checkpoint
   * that can only ever be critical, major or minor forces every "worth knowing
   * about, not a defect" finding to be overstated as minor, and a backlog
   * where everything is a defect is a backlog nobody works.
   *
   * Optionals allow undefined explicitly because the project runs with
   * exactOptionalPropertyTypes, and a pack author writing `{ key, label }` is
   * the normal case.
   */
  checkpoints: jsonb("checkpoints").$type<Array<{
    key: string;
    label: string;
    assetCategory?: string | undefined;
    requiresReading?: boolean | undefined;
    unit?: string | undefined;
  /**
   * A reading has to be judgeable against something.
   *
   * Core refuses a reading item with no range, because "records a reading
   * with no acceptable range" means no reading can ever be judged: the
   * number goes in the report and nothing decides whether it is a finding.
   * The checkpoint shape had `requiresReading` and a unit and NO RANGE, so
   * no trade pack could ever ship a judgeable reading, and the refusal was
   * unreachable because nothing called the validator.
   */
    range?: { min: number | null; max: number | null; borderlineWithin?: number | undefined } | undefined;
    /**
     * What this failure suggests selling, declared on the CHECKPOINT.
     *
     * Core has carried a `Remedy` type since it was written and the
     * checkpoint shape had nowhere to put one, so every finding came out of
     * the proposal builder as `unmapped`: real, shown, and with no work
     * behind it. A backlog where nothing can ever be quoted is a backlog
     * that turns into a list somebody stops reading.
     *
     * A key into the contractor's own price book and never a price. The
     * mapping from "the backflow preventer failed" to "which part number we
     * sell for that" is a decision each contractor makes differently and has
     * to be able to see and argue with.
     */
    remedies?: Array<{
      priceBookItemKey: string; label: string; quantity: number; rationale: string;
    }> | undefined;
    failIsDeficiency?: boolean | undefined;
    severityOnFail?: "critical" | "major" | "minor" | "advisory" | undefined;
  }>>().notNull().default([]),
  version: integer("version").notNull().default(1),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("inspection_program_org_idx").on(t.organizationId) }));

export const inspection = pgTable("inspection", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  programId: uuid("program_id").references(() => inspectionProgram.id, { onDelete: "set null" }),
  programVersion: integer("program_version"),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  contractId: uuid("contract_id").references(() => serviceContract.id, { onDelete: "set null" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  visitId: uuid("visit_id").references(() => visit.id, { onDelete: "set null" }),

  performedOn: date("performed_on"),
  result: inspectionResult("result"),
  /** Inspector identity and licence, which the authority will want named. */
  inspectorName: text("inspector_name"),
  inspectorLicense: text("inspector_license"),

  nextDueOn: date("next_due_on"),
  /** The submission half, which is where compliance products actually live. */
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  submissionReference: text("submission_reference"),
  submissionRejectedAt: timestamp("submission_rejected_at", { withTimezone: true }),
  submissionRejectionReason: text("submission_rejection_reason"),
  reportUrl: text("report_url"),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  dueIdx: index("inspection_due_idx").on(t.organizationId, t.nextDueOn),
  propertyIdx: index("inspection_property_idx").on(t.propertyId, t.performedOn),
  /** Submitted but not accepted, and overdue submissions. Both are liabilities. */
  submissionIdx: index("inspection_submission_idx").on(t.organizationId, t.submittedAt),
}));

export const deficiencyStatus = pgEnum("deficiency_status", [
  "open", "quoted", "approved", "scheduled", "corrected", "declined", "deferred", "void",
]);

export const deficiencySeverity = pgEnum("deficiency_severity", ["critical", "major", "minor", "advisory"]);

/**
 * A finding that needs correcting. Both a compliance liability and a sales
 * opportunity, which is why it carries a status chain through quoting and
 * scheduling rather than sitting in a notes field.
 *
 * `declined` is deliberately a terminal state that keeps the record: a
 * customer refusing to correct a critical deficiency is precisely the thing a
 * contractor needs documented.
 */
export const deficiency = pgTable("deficiency", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  inspectionId: uuid("inspection_id").references(() => inspection.id, { onDelete: "set null" }),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  equipmentId: uuid("equipment_id").references(() => equipment.id, { onDelete: "set null" }),

  status: deficiencyStatus("status").notNull().default("open"),
  severity: deficiencySeverity("severity").notNull().default("minor"),
  checkpointKey: text("checkpoint_key"),
  code: text("code"),
  description: text("description").notNull(),
  recommendedAction: text("recommended_action"),
  /**
   * WHAT WAS ACTUALLY SEEN, kept with the finding.
   *
   * The proposal builder in core refuses to price a deficiency that carries
   * no observation, because a price with a story and no evidence is the one
   * artefact that module exists to make impossible. That refusal only means
   * anything if the evidence survives the visit: a finding whose photo and
   * reading live in a report and not on the row is a finding that becomes
   * unevidenced the moment somebody opens the backlog a week later.
   *
   * The whole `Observation`: who recorded it, when, the photo ids, and the
   * reading with its own range evaluation, so the number and the spec it was
   * judged against travel together.
   */
  observation: jsonb("observation").$type<{
    itemKey: string;
    prompt: string;
    recorded: string;
    at: string;
    by: string;
    photoIds: string[];
    reading?: unknown;
  } | null>(),
  /**
   * The remedies the checkpoint declared, frozen onto the finding.
   *
   * Copied rather than looked up through the programme, for the same reason
   * the inspection stamps its programme version: revising a checkpoint must
   * not silently change what a finding from last March proposed. A quote
   * that changes when somebody edits a template is a quote nobody can stand
   * behind.
   */
  remedies: jsonb("remedies").$type<Array<{
    priceBookItemKey: string; label: string; quantity: number; rationale: string;
  }>>().notNull().default([]),

  foundOn: date("found_on"),
  /** Statutory correction window, where the standard sets one. */
  correctByOn: date("correct_by_on"),
  correctedOn: date("corrected_on"),
  correctedByJobId: uuid("corrected_by_job_id").references(() => job.id, { onDelete: "set null" }),

  /** The pipeline half: what it was quoted at and what happened to the quote. */
  estimateId: uuid("estimate_id"),
  quotedAmount: money("quoted_amount"),
  declinedOn: date("declined_on"),
  declineReason: text("decline_reason"),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  /** The backlog. The single most valuable report a commercial contractor has. */
  backlogIdx: index("deficiency_backlog_idx").on(t.organizationId, t.status, t.severity),
  propertyIdx: index("deficiency_property_idx").on(t.propertyId, t.status),
  /** Overdue corrections, which is a compliance exposure report. */
  dueIdx: index("deficiency_due_idx").on(t.organizationId, t.correctByOn, t.status),
}));

/**
 * BILLING BASIS BEYOND THE JOB
 *
 * An invoice line does not always originate from a job. Two shapes the spec
 * could not express, each of which would otherwise become a separate product
 * rather than a trade pack:
 *
 *   delivered quantity   propane, heating oil, water, bulk materials. The
 *                        work is triggered by a consumption forecast and
 *                        billed on metered quantity at a price that moves.
 *   elapsed period       portable sanitation, dumpsters, temporary fence.
 *                        Billed on time held, not work done.
 */
export const delivery = pgTable("delivery", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  visitId: uuid("visit_id").references(() => visit.id, { onDelete: "set null" }),
  equipmentId: uuid("equipment_id").references(() => equipment.id, { onDelete: "set null" }),

  product: text("product").notNull(),
  quantity: money("quantity").notNull(),
  unit: text("unit").notNull(),
  /** Price at delivery time. Commodity pricing moves daily. */
  unitPrice: money("unit_price").notNull(),
  /** Meter start and stop, where the truck meters rather than counts. */
  meterStart: money("meter_start"),
  meterStop: money("meter_stop"),
  /** A partial fill has to update the consumption model, not just bill. */
  wasPartialFill: boolean("was_partial_fill").notNull().default(false),
  tankPercentBefore: money("tank_percent_before"),
  tankPercentAfter: money("tank_percent_after"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  customerIdx: index("delivery_customer_idx").on(t.organizationId, t.customerId, t.deliveredAt),
  /** Degree day forecasting reads this: who is due before they run out. */
  forecastIdx: index("delivery_forecast_idx").on(t.organizationId, t.equipmentId, t.deliveredAt),
}));
