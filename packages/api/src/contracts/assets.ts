import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * FLEET, TOOLS AND COMPANY ASSETS
 *
 * The problem in the words a contractor uses, which is how
 * `packages/core/src/assets/index.ts` opens: a technician leaves and there is
 * thirty thousand dollars of tools in their truck that nobody has a list of.
 * A boom lift needs its 250 hour service and nobody knows what the meter
 * said. A thermal imager is eight months out of calibration and the moisture
 * reports it produced in that time are the ones an insurer is now disputing.
 *
 * THIS IS THE COMPANY'S OWN KIT AND NOT THE CUSTOMER'S. The furnace at 12 Oak
 * Street is `equipment`, in `contracts/jobs.ts` territory, and it belongs to
 * the homeowner. A dumpster out on hire is `rentable_asset`, which the
 * customer pays for by the day and whose question is utilization. Those three
 * are all "an asset" in English and nothing else about them is the same.
 *
 * THREE PERMISSIONS, AND THE SPLIT IS THE POINT. A technician holds
 * `asset:checkout` and not `asset:write`: they can take the core drill and
 * bring it back, and cannot add a van to the fleet or move an inspection
 * date. Reading is separate again, because a dispatcher deciding which crew
 * can take a job needs to see the register and should not be able to change
 * it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not depreciate anything.
 * Depreciation is an accounting policy with tax consequences, it belongs next
 * to the ledger, and a second module that thinks it knows the book value of a
 * van is a second answer that will drift from the first.
 */

const AssetKind = z.enum([
  "vehicle", "powered_tool", "hand_tool", "instrument", "trailer", "equipment",
]);
const MeterUnit = z.enum(["hours", "miles", "kilometres", "cycles"]);
const CustodianKind = z.enum(["technician", "location", "job"]);
const ComplianceKind = z.enum(["registration", "inspection", "insurance", "calibration"]);
const AssetCostKind = z.enum([
  "acquisition", "maintenance", "fuel", "repair", "insurance",
  "registration", "storage", "other",
]);
const ReadingSource = z.enum(["technician", "telematics", "invoice", "import"]);

/* ------------------------------------------------------------- the register */

export const RegisterEntry = z.object({
  id: Uuid,
  kind: AssetKind,
  kindLabel: z.string(),
  label: z.string(),
  /**
   * What a crew and a job type name when they say the work needs one of
   * these. Not unique and not this row's id: a job type saying tree removal
   * needs a chipper is talking about a class of machine, and pinning it to
   * one row would break the job type the day that machine is sold.
   */
  requirementCode: z.string().nullable(),
  identifier: z.string().nullable(),
  meterUnit: MeterUnit.nullable(),
  quantity: z.number().int(),
  acquiredOn: z.string().date().nullable(),
  retiredOn: z.string().date().nullable(),
  retired: z.boolean(),
  /**
   * Worked out from the custody history every time this is read. There is no
   * stored "current holder" column and there should never be one: some path
   * eventually writes an assignment without updating it, and from then on the
   * register confidently names the wrong person.
   */
  heldBy: z.object({
    custodianKind: CustodianKind,
    custodianId: Uuid,
    since: z.string().date(),
  }).nullable(),
  latestReading: z.object({
    value: z.number().int(),
    unit: MeterUnit,
    takenOn: z.string().date(),
  }).nullable(),
  /**
   * Obligations this KIND of asset should carry and this one has no record
   * of at all. A van with an expired inspection is loud; a van with no
   * inspection on file is silent, and it is the same van in the same yard.
   */
  missingObligations: z.array(ComplianceKind),
});

export const listAssets = defineRoute({
  method: "get",
  path: "/v1/assets",
  summary: "The register, with who has each thing",
  description:
    "Retired assets are left out unless asked for, because a sold van on a worklist trains people to ignore the worklist. Custody is derived from the history on every read rather than stored, and an asset whose history is incoherent reads as held by nobody here with the full refusal available on its own custody endpoint, so one broken record cannot blank the register.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({
    kind: AssetKind.optional(),
    includeRetired: z.boolean().optional(),
  }),
  output: z.object({ on: z.string().date(), assets: z.array(RegisterEntry) }),
});

export const registerAsset = defineRoute({
  method: "post",
  path: "/v1/assets",
  summary: "Put something on the register",
  description:
    "The kind decides what the thing is and what it can carry. A meter on a kind that has none is refused, because a reading against a trailer is a reading taken from some other machine. A quantity above one is refused on a kind tracked individually: twenty core drills are twenty records, because any one of them can be the one that does not come back and a count cannot say which.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    kind: AssetKind,
    label: z.string().min(1).max(200),
    requirementCode: z.string().max(200).nullable().optional(),
    /** Serial, VIN or asset tag. One per company: two rows split a history. */
    identifier: z.string().max(200).nullable().optional(),
    /** Defaults to the kind's own meter. Null for a thing with no meter. */
    meterUnit: MeterUnit.nullable().optional(),
    /**
     * Override the plausibility ceiling, in the asset's own unit. For the
     * machine that genuinely runs harder: a generator on a storm job really
     * does run 24 hours, and with no way to say so its honest readings are
     * refused every day until people stop entering them.
     */
    meterMaxPerDay: z.number().int().min(1).max(100_000).nullable().optional(),
    quantity: z.number().int().min(1).max(10_000).optional(),
    acquiredOn: z.string().date().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  }),
  output: z.object({
    id: Uuid, label: z.string(), kind: AssetKind, meterUnit: MeterUnit.nullable(),
  }),
});

export const updateAsset = defineRoute({
  method: "patch",
  path: "/v1/assets/{id}",
  summary: "Correct what the register says",
  description:
    "The kind and the meter unit are not editable. Changing either rewrites the meaning of every reading already recorded: a van moved from miles to hours turns 84,000 miles into 84,000 hours, and every later reading is then refused for the wrong reason on a history that has already been ruined. Something entered as the wrong kind is retired and entered again, so its readings stay with the row they were taken from.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    label: z.string().min(1).max(200).optional(),
    requirementCode: z.string().max(200).nullable().optional(),
    identifier: z.string().max(200).nullable().optional(),
    meterMaxPerDay: z.number().int().min(1).max(100_000).nullable().optional(),
    acquiredOn: z.string().date().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  }),
  output: z.object({ id: Uuid, label: z.string(), requirementCode: z.string().nullable() }),
});

export const retireAsset = defineRoute({
  method: "post",
  path: "/v1/assets/{id}/retire",
  summary: "Take something off the fleet",
  description:
    "The row survives, because a sold van's readings are what its cost per mile was built from and its custody record is what answers who had it last. Refused while somebody still has it open in custody: retiring an asset that is in a technician's truck takes it off every list while it is still in the truck, which is exactly how thirty thousand dollars of tools stops being anybody's problem.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    retiredOn: z.string().date().optional(),
    reason: z.string().max(500).optional(),
  }),
  output: z.object({ id: Uuid, label: z.string(), retiredOn: z.string().date().nullable() }),
});

/* ------------------------------------------------------------------ custody */

export const checkOutAsset = defineRoute({
  method: "post",
  path: "/v1/assets/{assetId}/check-out",
  summary: "Give it to somebody, or put it somewhere",
  description:
    "Custody is an append only history, not a field. Two open assignments of one asset is refused with both named, because that is the ordinary way this goes wrong: somebody hands the core drill on at a site and nobody closes the first assignment, and with a mutable holder column the second write silently wins and the first custodian is forgotten. The fix is two seconds today and an argument the week somebody resigns. A custodian can be a person, a place or a job, and which it is gets checked against that table.",
  module: "M22",
  permissions: ["asset:checkout"],
  idempotent: true,
  input: z.object({
    assetId: Uuid,
    custodianKind: CustodianKind,
    custodianId: Uuid,
    /** Defaults to today in the company's own timezone. */
    on: z.string().date().optional(),
    note: z.string().max(1000).optional(),
  }),
  output: z.object({
    id: Uuid, assetId: Uuid, custodianKind: CustodianKind,
    custodianId: Uuid, heldFrom: z.string().date(),
  }),
});

export const checkInAsset = defineRoute({
  method: "post",
  path: "/v1/assets/{assetId}/check-in",
  summary: "Bring it back",
  description:
    "Half open: closed on the fourth means the custodian had it up to but not including the fourth, so the next check out can start on the fourth and the asset is in exactly one place that day. Any other reading double counts the day of a handover or loses it. Checking in something nobody has is refused rather than writing a period nobody was in.",
  module: "M22",
  permissions: ["asset:checkout"],
  idempotent: true,
  input: z.object({
    assetId: Uuid,
    on: z.string().date().optional(),
    note: z.string().max(1000).optional(),
  }),
  output: z.object({
    id: Uuid, assetId: Uuid,
    heldFrom: z.string().date(), heldUntil: z.string().date().nullable(),
  }),
});

export const handOverAsset = defineRoute({
  method: "post",
  path: "/v1/assets/{assetId}/hand-over",
  summary: "Pass it straight on",
  description:
    "One call rather than a check in and a check out, because the gesture is one gesture and the two halves have to agree on the date. Done separately, a slip of a day leaves either a gap where the drill was nowhere or an overlap that is refused after the first write has already landed.",
  module: "M22",
  permissions: ["asset:checkout"],
  idempotent: true,
  input: z.object({
    assetId: Uuid,
    custodianKind: CustodianKind,
    custodianId: Uuid,
    on: z.string().date().optional(),
    note: z.string().max(1000).optional(),
  }),
  output: z.object({ closed: Uuid, opened: Uuid, on: z.string().date() }),
});

export const getAssetCustody = defineRoute({
  method: "get",
  path: "/v1/assets/{assetId}/custody",
  summary: "Who had this, and the history behind the answer",
  description:
    "Nobody holding it on that day is a real answer and comes back with a sentence saying where it was last seen, because a blank where a name should be reads as fine. An incoherent history is refused here in full, with both overlapping assignments and the fix, rather than being silently resolved in favour of whichever row sorted first.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({ assetId: Uuid, on: z.string().date().optional() }),
  output: z.object({
    assetId: Uuid,
    label: z.string(),
    on: z.string().date(),
    held: z.boolean(),
    heldBy: z.object({
      custodianKind: CustodianKind, custodianId: Uuid, since: z.string().date(),
    }).nullable(),
    explanation: z.string().nullable(),
    history: z.array(z.object({
      custodianKind: CustodianKind,
      custodianId: Uuid,
      from: z.string().date(),
      /** Null means open: they still have it. */
      until: z.string().date().nullable(),
      note: z.string().nullable(),
    })),
  }),
});

export const listAssetsHeldBy = defineRoute({
  method: "get",
  path: "/v1/assets/held-by",
  summary: "Everything one person or one place is holding",
  description:
    "The report this module exists for, run on the day a technician gives notice. Assets whose custody history is incoherent come back beside the list rather than instead of it: a broken record is exactly the one most likely to be missing, and swallowing it leaves the most important row off the page.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({
    custodianKind: CustodianKind,
    custodianId: Uuid,
    on: z.string().date().optional(),
  }),
  output: z.object({
    on: z.string().date(),
    custodianKind: CustodianKind,
    custodianId: Uuid,
    assets: z.array(z.object({
      id: Uuid, label: z.string(), kind: AssetKind,
      identifier: z.string().nullable(), since: z.string().date(),
    })),
    unreadable: z.array(z.object({ assetId: z.string(), explanation: z.string() })),
  }),
});

/* ----------------------------------------------------------------- readings */

export const recordAssetReading = defineRoute({
  method: "post",
  path: "/v1/assets/{assetId}/readings",
  summary: "Write down what the meter said",
  description:
    "Whole units as they appear on the face of the meter: a fraction here becomes float arithmetic that later divides money. A decrease is refused rather than treated as a meter replacement, because inferring a reset throws away every hour the machine has already run, and the way through is to declare what the old meter finally read so cumulative usage stays continuous across the swap. The plausibility ceiling is the guard that pays for itself: 48122 typed for 4812 pushes the next service out by a century, and from that point every honest reading looks like it goes backwards and is refused for the wrong reason.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    assetId: Uuid,
    value: z.number().int().min(0),
    /** Defaults to today. A reading dated after today is refused. */
    takenOn: z.string().date().optional(),
    source: ReadingSource.optional(),
    /**
     * A declared meter replacement. Both halves or neither: the final value
     * is what keeps usage continuous across the swap, and the reason is the
     * only record that the gauge on this machine is not the gauge the earlier
     * readings came from.
     */
    reset: z.object({
      previousFinalValue: z.number().int().min(0),
      reason: z.string().min(1).max(500),
    }).optional(),
  }),
  output: z.object({
    id: Uuid, assetId: Uuid, value: z.number().int(), unit: MeterUnit,
    takenOn: z.string().date(), unitsSincePrevious: z.number().int(),
  }),
});

export const listAssetReadings = defineRoute({
  method: "get",
  path: "/v1/assets/{assetId}/readings",
  summary: "The readings, and the usage between two dates",
  description:
    "Usage is bounded by the readings that exist inside the window rather than by the window. A month with one reading near the end did not cover the month, and pretending it did is how a cost per hour comes out four times too high. One reading is not usage and no readings is not zero usage, so both come back as a refusal with the sentence that says what to do about it.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({
    assetId: Uuid,
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  output: z.object({
    assetId: Uuid,
    label: z.string(),
    unit: MeterUnit.nullable(),
    readings: z.array(z.object({
      id: Uuid,
      value: z.number().int(),
      unit: MeterUnit,
      takenOn: z.string().date(),
      source: ReadingSource,
      reset: z.object({
        previousFinalValue: z.number().int(), reason: z.string(),
      }).nullable(),
    })),
    /** Null when no window was asked for. */
    usage: z.object({
      ok: z.boolean(),
      unit: MeterUnit.nullable(),
      units: z.number().int().nullable(),
      /** The span actually covered by readings, not the span asked for. */
      observedDays: z.number().int().nullable(),
      readingsUsed: z.number().int().nullable(),
      crossedAReset: z.boolean().nullable(),
      explanation: z.string().nullable(),
    }).nullable(),
  }),
});

/* -------------------------------------------------------------- maintenance */

/**
 * WHAT IS DUE, IN FIVE GENUINELY DIFFERENT SHAPES.
 *
 * A time interval produces a DATE. "Every 250 hours" cannot: the next service
 * depends on how hard the machine gets used next month, which has not
 * happened, so what comes out is either "the meter already says so", a
 * projection from the recent rate of use, or an honest refusal to guess.
 *
 * The five arms are published separately rather than flattened into a date
 * and a boolean, because "projected, weak confidence, from two readings nine
 * days apart" and "due now, the meter already says so" would otherwise come
 * out identical. The first is a guess somebody should argue with and the
 * second is a fact somebody should act on.
 */
export const MaintenanceStatus = z.discriminatedUnion("state", [
  z.object({
    basis: z.literal("time"), state: z.literal("scheduled"),
    dueOn: z.string().date(), daysUntilDue: z.number().int(), overdue: z.boolean(),
  }),
  z.object({
    basis: z.literal("time"), state: z.literal("no_further_service_due"),
    explanation: z.string(),
  }),
  z.object({
    basis: z.literal("meter"), state: z.literal("due_now"), unit: MeterUnit,
    usedSinceService: z.number(), unitsOverdue: z.number(), explanation: z.string(),
  }),
  z.object({
    basis: z.literal("meter"), state: z.literal("projected"), unit: MeterUnit,
    dueOn: z.string().date(),
    unitsRemaining: z.number(),
    /** A float, and the only float here. It is a rate, never money. */
    unitsPerDay: z.number(),
    observedDays: z.number().int(),
    readingsUsed: z.number().int(),
    confidence: z.enum(["weak", "fair", "good"]),
    /**
     * Reported rather than used to suppress anything. A weak projection is
     * still the best available answer, and hiding it leaves the screen blank,
     * which reads as nothing being due.
     */
    caveat: z.string(),
  }),
  z.object({
    basis: z.literal("meter"), state: z.literal("cannot_project"), unit: MeterUnit,
    reason: z.enum([
      "no_readings", "stale_readings", "not_enough_history",
      "no_reading_at_service", "no_use_observed", "projection_beyond_horizon",
    ]),
    unitsRemaining: z.number().nullable(),
    explanation: z.string(),
  }),
]);

export const setAssetMaintenancePlan = defineRoute({
  method: "post",
  path: "/v1/assets/{assetId}/maintenance-plans",
  summary: "Declare a recurring service",
  description:
    "Two bases, and they are different problems. Every six months is a recurrence and goes through the same engine that already knows about counting from actual completion, seasonal anchoring and exceptions. Every 250 hours cannot go through it at all, because the date depends on use that has not happened yet. Both failure modes here are silent: a meter interval with no number counts down from nothing, and a time rule with neither an interval nor anchor months generates no occurrence at all and looks exactly like work that is not due yet.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    assetId: Uuid,
    label: z.string().min(1).max(200),
    basis: z.enum(["time", "meter"]),
    /** Meter basis: units of use between services. 250 hours, 5000 miles. */
    everyUnits: z.number().int().min(1).max(1_000_000).optional(),
    /** Time basis, the same shape a recurring schedule carries. */
    model: z.enum(["rule", "anchored_to_completion", "materialized", "manual"]).optional(),
    startsOn: z.string().date().optional(),
    endsOn: z.string().date().nullable().optional(),
    intervalDays: z.number().int().min(1).max(3650).nullable().optional(),
    anchorMonths: z.array(z.number().int().min(1).max(12)).max(12).optional(),
    lastServicedOn: z.string().date().nullable().optional(),
  }),
  output: z.object({
    id: Uuid, assetId: Uuid, label: z.string(), basis: z.enum(["time", "meter"]),
  }),
});

export const recordAssetService = defineRoute({
  method: "post",
  path: "/v1/asset-maintenance-plans/{planId}/serviced",
  summary: "It was done",
  description:
    "The load bearing write for both bases: the time branch asks for the next occurrence after this date and the meter branch measures usage from the reading taken nearest it. A backdated completion is refused, because it pulls a service that has already happened back into the future and discards the usage counted since. A date in the future is refused too: recording it early resets the interval before the work happens.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ planId: Uuid, servicedOn: z.string().date().optional() }),
  output: z.object({
    id: Uuid, label: z.string(), lastServicedOn: z.string().date().nullable(),
  }),
});

export const getAssetMaintenanceDue = defineRoute({
  method: "get",
  path: "/v1/assets/maintenance-due",
  summary: "What is due, across the fleet",
  description:
    "Retired assets are left out: nothing is going to happen to them and a worklist that keeps offering them trains people to ignore the worklist. An asset nobody has read for six weeks returns a refusal to project rather than a date, because a due date built from a stale number reads identically whether it came from telematics yesterday or from a technician in April, and only one of those is worth acting on.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({
    assetId: Uuid.optional(),
    /** Defaults to today. A parameter so a projection can be replayed. */
    now: z.string().date().optional(),
  }),
  output: z.object({
    now: z.string().date(),
    due: z.array(z.object({
      planId: Uuid,
      assetId: Uuid,
      assetLabel: z.string(),
      label: z.string(),
      lastServicedOn: z.string().date().nullable(),
      status: MaintenanceStatus,
    })),
  }),
});

/* --------------------------------------------------------------- compliance */

export const setAssetObligation = defineRoute({
  method: "put",
  path: "/v1/assets/{assetId}/obligations/{kind}",
  summary: "Set or renew a date that expires",
  description:
    "One row per kind per asset, so a renewal moves the date rather than leaving two rows where one says the van is legal and the other says it is not. The date it was last certified good is a calibration field and is refused on the other three: registration, inspection and insurance stop something happening tomorrow, and calibration reaches backwards into work already done and already invoiced.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    assetId: Uuid,
    kind: ComplianceKind,
    expiresOn: z.string().date(),
    /** Plate number, certificate number, policy number. */
    reference: z.string().max(200).nullable().optional(),
    /** Calibration only: the last date the instrument was certified good. */
    lastCertifiedOn: z.string().date().nullable().optional(),
  }),
  output: z.object({
    id: Uuid, assetId: Uuid, kind: ComplianceKind, expiresOn: z.string().date(),
  }),
});

export const getAssetComplianceOutlook = defineRoute({
  method: "get",
  path: "/v1/assets/compliance",
  summary: "What expires when, in the order to deal with it",
  description:
    "Ordered by when action is needed rather than by expiry, which is the whole value of the screen: a calibration needing six weeks of notice and expiring in fifty days is more urgent than a registration needing thirty and expiring in forty, and a list sorted by expiry puts them the other way round. Deadlines move backwards off a weekend and never forwards, because the counties and calibration labs that clear them are shut and rolling a renewal to Monday is renewing it after it expired. Obligations a kind of asset should have and has no record of are reported separately, because a van with no inspection on file is silent and it is the same van in the same yard.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({
    now: z.string().date().optional(),
    lookaheadDays: z.number().int().min(1).max(1095).optional(),
  }),
  output: z.object({
    now: z.string().date(),
    alerts: z.array(z.object({
      assetId: Uuid,
      assetLabel: z.string(),
      kind: ComplianceKind,
      status: z.enum(["expired", "act_now", "upcoming", "clear"]),
      expiresOn: z.string().date(),
      /** Negative once past, so one number sorts in both directions. */
      daysUntilExpiry: z.number().int(),
      /** The last working day somebody can still get this cleared. */
      actBy: z.string().date(),
      lastUsableDay: z.string().date(),
      movedOffAWeekend: z.boolean(),
      groundsTheAsset: z.boolean(),
      /**
       * Set only when a lapse reaches backwards, which is calibration alone:
       * the date from which every report this instrument produced is open to
       * challenge.
       */
      workAtRiskSince: z.string().date().nullable(),
      explanation: z.string(),
    })),
    missing: z.array(z.object({
      assetId: Uuid, assetLabel: z.string(), kind: ComplianceKind, explanation: z.string(),
    })),
  }),
});

/* --------------------------------------------------------------------- cost */

export const recordAssetCost = defineRoute({
  method: "post",
  path: "/v1/assets/{assetId}/costs",
  summary: "Money spent on one thing",
  description:
    "Acquisition is a kind rather than a column on the asset, so the summary can keep a purchase apart from running cost while still holding both. Folding them together makes the month a van was bought look like the most expensive month of its life and every month after it look free, and no comparison between two vans survives that. A negative amount is refused: a credit against a repair is its own entry.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    assetId: Uuid,
    kind: AssetCostKind,
    amount: MoneyString,
    incurredOn: z.string().date(),
    currency: z.string().length(3).optional(),
    note: z.string().max(1000).optional(),
  }),
  output: z.object({
    id: Uuid, assetId: Uuid, amount: MoneyString, incurredOn: z.string().date(),
  }),
});

export const getAssetCost = defineRoute({
  method: "get",
  path: "/v1/assets/{assetId}/cost",
  summary: "What it costs to keep, and what per hour or per mile",
  description:
    "An asset with no recorded use has no cost per hour, and the answer is a refusal rather than a zero or an infinity. Zero reads as this van is free, so the cheapest asset in the fleet becomes the one nobody is reading the odometer on, which is the opposite of the truth and the kind of wrong that gets acted on. Reliability is reported rather than enforced: three weeks of data on a van that has had one oil change and no tyres is a cost per mile of three weeks in which nothing broke.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({
    assetId: Uuid,
    from: z.string().date(),
    to: z.string().date(),
    includeAcquisition: z.boolean().optional(),
    currency: z.string().length(3).optional(),
  }),
  output: z.object({
    assetId: Uuid,
    label: z.string(),
    from: z.string().date(),
    to: z.string().date(),
    currency: z.string(),
    total: MoneyString,
    /** Everything except acquisition. A purchase is an event; this is a rate. */
    runningTotal: MoneyString,
    acquisition: MoneyString,
    byKind: z.record(AssetCostKind, MoneyString),
    perUnit: z.object({
      ok: z.boolean(),
      unit: MeterUnit.nullable(),
      units: z.number().int().nullable(),
      cost: MoneyString.nullable(),
      perUnit: MoneyString.nullable(),
      observedDays: z.number().int().nullable(),
      reliable: z.boolean().nullable(),
      caveat: z.string().nullable(),
      explanation: z.string().nullable(),
    }),
  }),
});

export const assetRoutes = {
  listAssets, registerAsset, updateAsset, retireAsset,
  checkOutAsset, checkInAsset, handOverAsset, getAssetCustody, listAssetsHeldBy,
  recordAssetReading, listAssetReadings,
  setAssetMaintenancePlan, recordAssetService, getAssetMaintenanceDue,
  setAssetObligation, getAssetComplianceOutlook,
  recordAssetCost, getAssetCost,
} as const;
