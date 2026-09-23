import { z } from "zod";

/**
 * TRADE PACKS
 *
 * The lever that makes one product serve twenty six trades without either a
 * generic form builder nobody configures, or twenty six forks.
 *
 * A pack is versioned data, not code. It seeds a real price book, the job
 * types that trade actually runs, the checklists a technician fills in, the
 * readings they capture, the inspection programmes they are obligated to
 * perform, the regulatory submissions those produce, the retention rules that
 * govern the records, and the KPIs an owner in that trade manages to.
 *
 * The scope is deliberately wider than it first looks. Research found that
 * several capabilities which appear to need bespoke engineering per trade
 * (regulated application logging, statutory inspection, submission formats)
 * become content the moment the pack schema can carry them. Extending this
 * file is far cheaper than extending the product.
 *
 * Anyone who has run a shop in a trade can contribute one. That is the point:
 * the contributions this project most needs are not pull requests full of
 * TypeScript.
 */

export const CapacityModel = z.enum(["technician_dispatch", "crew_production", "route", "asset_rental"]);

export const PriceBookSeedItem = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  kind: z.enum(["service", "material", "equipment", "labor", "fee", "discount"]).default("service"),
  category: z.string().max(100),
  /** Customer facing copy, shown verbatim on a good better best proposal. */
  description: z.string().max(2000).optional(),
  /**
   * National average, as a decimal string. An adjustable starting point, not
   * a recommendation: a pack ships pricing so hour one is useful, and the
   * setup wizard walks the owner through re-margining it for their market.
   */
  price: z.string().regex(/^\d+(\.\d{1,4})?$/),
  cost: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  laborMinutes: z.number().int().min(0).max(10000).optional(),
  taxable: z.boolean().default(true),
  /** Labour is not taxable in many jurisdictions and material usually is. */
  taxClass: z.enum(["labor", "material", "equipment", "service", "exempt"]).optional(),
  warrantyMonths: z.number().int().min(0).max(600).optional(),
});

export const JobTypeSeed = z.object({
  code: z.string().max(60),
  name: z.string().min(1).max(100),
  capacityModel: CapacityModel.default("technician_dispatch"),
  defaultDurationMinutes: z.number().int().min(5).max(1440).default(60),
  requiredSkills: z.array(z.string()).default([]),
  /** Units of production for crew work: square feet, linear feet, yards. */
  productionUnit: z.string().max(40).optional(),
  color: z.string().optional(),
});

export const ChecklistSeed = z.object({
  code: z.string().max(60),
  name: z.string().min(1).max(120),
  jobTypeCodes: z.array(z.string()).default([]),
  items: z.array(z.object({
    label: z.string().min(1).max(200),
    required: z.boolean().default(false),
    /** Safety items a technician must confirm before starting. */
    safety: z.boolean().default(false),
  })),
});

/**
 * A reading captured on a visit. Trends across visits, range checks, and in
 * regulated trades becomes the record an authority asks for.
 */
export const ReadingSeed = z.object({
  key: z.string().max(60),
  label: z.string().min(1).max(120),
  kind: z.enum(["numeric", "text", "boolean", "select", "photo", "chemical", "measurement"]),
  unit: z.string().max(20).optional(),
  options: z.array(z.string()).optional(),
  /** Show on the customer portal. Some readings are internal only. */
  customerVisible: z.boolean().default(true),
  trend: z.boolean().default(false),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Carries EPA registration, applicator licence and target, when applied. */
  regulated: z.boolean().default(false),
});

export const InspectionProgramSeed = z.object({
  code: z.string().max(60),
  name: z.string().min(1).max(160),
  /** The standard performed under, as text. Never interpreted as a rule. */
  standard: z.string().max(200).optional(),
  /** Who receives the report. Often an authority rather than the customer. */
  reportAudience: z.enum(["customer", "authority", "both"]).default("customer"),
  frequencyMonths: z.number().int().min(1).max(120).optional(),
  checkpoints: z.array(z.object({
    key: z.string().max(60),
    label: z.string().min(1).max(200),
    assetCategory: z.string().max(60).optional(),
    requiresReading: z.boolean().default(false),
    unit: z.string().max(20).optional(),
    failIsDeficiency: z.boolean().default(true),
    severityOnFail: z.enum(["critical", "major", "minor", "advisory"]).default("minor"),
  })),
});

/**
 * A recurring submission obligation. Describes what the software must produce
 * and to whom, never what the business is legally required to do.
 */
export const SubmissionSeed = z.object({
  kind: z.string().max(80),
  label: z.string().min(1).max(160),
  authorityName: z.string().max(160),
  jurisdiction: z.string().max(80).default("US"),
  cadence: z.enum(["per_event", "monthly", "quarterly", "annual", "on_threshold"]),
  route: z.enum(["portal", "api", "sftp", "email", "mail", "in_person"]).optional(),
  notes: z.string().max(1000).optional(),
});

export const RetentionSeed = z.object({
  entityType: z.string().max(60),
  entityKind: z.string().max(60).optional(),
  /**
   * Retention almost never runs from when the row was created. Getting this
   * wrong means a purge job destroys records a contractor still has to hold.
   */
  clockStart: z.enum([
    "record_created", "calendar_year_end", "work_completed", "report_prepared",
    "employment_ended", "next_activity_of_type", "contract_ended", "equipment_removed",
  ]),
  retainMonths: z.number().int().min(1).max(1200),
  basis: z.string().max(200).optional(),
});

export const KpiSeed = z.object({
  key: z.string().max(60),
  label: z.string().min(1).max(120),
  /** Precise enough to implement, including what to exclude. */
  definition: z.string().min(1).max(600),
  format: z.enum(["money", "percent", "number", "duration"]).default("number"),
  target: z.string().max(60).optional(),
});

export const EquipmentCategorySeed = z.object({
  code: z.string().max(60),
  name: z.string().min(1).max(100),
  /** Assets nest: a riser has valves, a rooftop unit has a compressor. */
  parentCode: z.string().max(60).optional(),
  tracksSerial: z.boolean().default(true),
  tracksWarranty: z.boolean().default(true),
  attributes: z.array(z.object({
    key: z.string().max(60),
    label: z.string().max(120),
    kind: z.enum(["text", "numeric", "select", "date", "boolean"]),
    options: z.array(z.string()).optional(),
  })).default([]),
});

export const PortalBlockSeed = z.object({
  kind: z.enum([
    "visit_timeline", "service_report", "readings_trend", "equipment_register",
    "checklist_results", "photo_gallery", "documents", "invoices", "payments",
    "plan_status", "next_visit", "recommended_work", "referral", "contact_card",
  ]),
  title: z.string().max(80).optional(),
  config: z.record(z.unknown()).default({}),
});

export const TradePack = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  version: z.number().int().min(1),
  /*
   * NO CAPACITY MODEL ON THE PACK.
   *
   * There was one, and it labelled each trade as dispatch, crew, route or
   * rental. It drove nothing: it was a chip on the setup screen, and the
   * only test on it checked the label matched a job type underneath.
   *
   * It is gone because the claim it made was false. A lawn company runs
   * routes AND sells installs. An electrician dispatches service AND runs
   * crews on a rough in. Stamping one word on a trade tells the owner their
   * business is a category, and the ones who do two things are being told
   * that one half of what they do is not what this product is for.
   *
   * The per JOB TYPE model stays, because that one decides real behaviour
   * and is set where the difference actually exists. A pack ships sensible
   * defaults for its job types and the owner changes them. That is the
   * setting, and it needs no summary above it.
   */
  summary: z.string().max(500),
  /**
   * What the pack does NOT cover yet, in the author's own words.
   *
   * Generously sized on purpose. The first cap here was 500 characters and a
   * pack failed validation for being thorough about its gaps, which is exactly
   * the behaviour this field exists to encourage. A contractor reading "no
   * per-authority submission formatter, no sewer takeoff, medical gas is out
   * of scope" knows where they stand. A cap that forces that down to one vague
   * sentence produces a worse product and a less honest one.
   */
  status: z.string().max(2000).optional(),

  priceBook: z.array(PriceBookSeedItem),
  jobTypes: z.array(JobTypeSeed),
  checklists: z.array(ChecklistSeed).default([]),
  readings: z.array(ReadingSeed).default([]),
  equipmentCategories: z.array(EquipmentCategorySeed).default([]),
  inspectionPrograms: z.array(InspectionProgramSeed).default([]),
  submissions: z.array(SubmissionSeed).default([]),
  retention: z.array(RetentionSeed).default([]),
  kpis: z.array(KpiSeed),
  portalBlocks: z.array(PortalBlockSeed).default([]),
});

/**
 * Two types, and the distinction matters for whoever writes a pack.
 *
 * `TradePackInput` is what an author writes: fields with a schema default are
 * optional, so nobody has to type `taxable: true` on forty price book rows.
 * `TradePack` is what the rest of the system consumes after parsing, where
 * those defaults have been filled in and are therefore guaranteed present.
 *
 * Getting this backwards makes authoring a pack miserable for exactly the
 * people we most want contributing one.
 */
export type TradePackInput = z.input<typeof TradePack>;
export type TradePack = z.output<typeof TradePack>;
export type PriceBookSeedItem = z.output<typeof PriceBookSeedItem>;
export type KpiSeed = z.output<typeof KpiSeed>;
