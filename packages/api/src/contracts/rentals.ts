import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * THE TRADE PACK SHIPPED AND THE CONTAINER DID NOT EXIST
 *
 * `packs/dumpster-rental.ts` declares six job types whose capacity model is
 * `asset_rental`, thirty eight price book items built around container days and
 * scale tickets, and eight KPI definitions precise enough to name how each one
 * is usually computed wrongly. `rentable_asset` and `rental` had no reader and
 * no writer, and neither did `visit.rental_id` or `visit.rental_event`. A roll
 * off company could apply the pack and record no containers.
 */

const Tons = z.string().regex(/^\d+(\.\d{1,4})?$/, "A tonnage is a positive decimal string");
const AssetStatus = z.enum(["available", "on_site", "out_of_service"]);

const AssetView = z.object({
  id: Uuid,
  assetType: z.string(),
  identifier: z.string(),
  size: z.string().nullable(),
  status: AssetStatus,
  homeLocationId: Uuid.nullable(),
  currentPropertyId: Uuid.nullable(),
  purchaseCost: MoneyString.nullable(),
  active: z.boolean(),
});

const RentalView = z.object({
  id: Uuid,
  assetId: Uuid,
  assetIdentifier: z.string().nullable(),
  assetSize: z.string().nullable(),
  propertyId: Uuid,
  /**
   * The street and city, not a second uuid. The asset list already answered
   * "where is it" this way; a hire list that did not would make every caller do
   * the join, this product's own board first.
   */
  propertyAddress: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  pickedUpAt: z.string().nullable(),
  open: z.boolean(),
  daysSoFar: z.number().int().nullable(),
  includedDays: z.number().int().nullable(),
  dailyRate: MoneyString.nullable(),
  overageRate: MoneyString.nullable(),
  includedTons: MoneyString.nullable(),
  perTonRate: MoneyString.nullable(),
  weightTons: MoneyString.nullable(),
  divertedTons: MoneyString.nullable(),
  disposalTicketNumber: z.string().nullable(),
  disposalFacility: z.string().nullable(),
  materialType: z.string().nullable(),
  disposalFee: MoneyString.nullable(),
  previousRentalId: Uuid.nullable(),
  /** The collection stop the scheduler booked for it, when it has one. */
  collectionVisitId: Uuid.nullable(),
  /** The invoice its period, meters and charges went on, once raised. */
  invoiceId: Uuid.nullable(),
});

/* ------------------------------------------------------------- the fleet */

export const addRentableAsset = defineRoute({
  method: "post",
  path: "/v1/rentable-assets",
  summary: "Put a container in the fleet",
  description:
    "The identifier is the number painted on the side, unique within the company, and it is the only thing tying a scale ticket back to a unit. A container starts available, which means in the yard earning nothing and IN the utilisation denominator: cans in the yard are exactly what that metric exists to expose.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    assetType: z.string().min(1).max(100),
    identifier: z.string().min(1).max(100),
    size: z.string().max(100).nullable().optional(),
    homeLocationId: Uuid.nullable().optional(),
    purchaseCost: MoneyString.nullable().optional(),
  }),
  output: AssetView,
});

export const listRentableAssets = defineRoute({
  method: "get",
  path: "/v1/rentable-assets",
  summary: "The fleet, and where each unit is",
  description:
    "Returns the address a unit is standing at, not only that it is on site. 'On site' is not an answer to the question a dispatcher asks twenty times a day, and a property id on its own is a uuid.",
  module: "M22",
  permissions: ["asset:read"],
  idempotent: true,
  input: z.object({
    status: AssetStatus.optional(),
    assetType: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  output: z.object({
    data: z.array(AssetView.extend({ currentAddress: z.string().nullable() })),
  }),
});

export const tagAssetOutOfService = defineRoute({
  method: "post",
  path: "/v1/rentable-assets/{id}/out-of-service",
  summary: "Tag a unit out for repair",
  description:
    "The only thing that changes the utilisation denominator, which is why it is its own operation with a required reason rather than a status field on an update. A unit tagged out with no reason is one nobody knows how to put back, and it sits outside the figure indefinitely. Allowed while the unit is still on a customer site, which is the ordinary case: the pickup checklist's last line is to record the condition and tag it out if it needs repair.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().min(1).max(500) }),
  output: AssetView,
});

export const returnAssetToService = defineRoute({
  method: "post",
  path: "/v1/rentable-assets/{id}/in-service",
  summary: "Put a repaired unit back in the fleet",
  description: "Back to available, which puts it back in the utilisation denominator.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: AssetView,
});

export const retireRentableAsset = defineRoute({
  method: "delete",
  path: "/v1/rentable-assets/{id}",
  summary: "Take a unit out of the fleet for good",
  description:
    "Soft, so every hire that unit ever ran still resolves to its number: a report saying 'container 2041' rather than a uuid is the difference between an answerable tonnage query and an unanswerable one. Refused while it is on a site, because a retired unit leaves the utilisation denominator and retiring one that is still out would put the rate above a hundred per cent with nothing explaining why.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, retired: z.boolean() }),
});

/* -------------------------------------------------------------- the hire */

export const deliverRental = defineRoute({
  method: "post",
  path: "/v1/rentals",
  summary: "Put a container on a site",
  description:
    "Opens a rental and moves the unit. `deliveredAt` comes from the caller rather than the clock, because a driver writing up a day's drops at five in the evening would otherwise have every rental start at five. A unit already on a site is refused: pick it up or swap it first. Where a job id is given, the job's first unassigned stop is pointed at this hire and marked as the delivery leg, which is what tells the board whether the driver is dropping or collecting.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    assetId: Uuid,
    propertyId: Uuid,
    jobId: Uuid.nullable().optional(),
    deliveredAt: z.string().datetime().optional(),
    includedDays: z.number().int().min(0).max(3650).nullable().optional(),
    dailyRate: MoneyString.nullable().optional(),
    overageRate: MoneyString.nullable().optional(),
    includedTons: Tons.nullable().optional(),
    perTonRate: MoneyString.nullable().optional(),
  }),
  output: RentalView,
});

export const pickUpRental = defineRoute({
  method: "post",
  path: "/v1/rentals/{id}/pickup",
  summary: "Collect it, and record the scale ticket",
  description:
    "Closes the rental and returns the unit to the fleet, or leaves it tagged out when `backInService` is false. The scale ticket is stored on the rental rather than only as a reading on the visit: it is the support behind the largest line on the invoice and the largest line in the cost of goods, the trade pack keeps it for three years from the haul, and a number living in a visit's readings blob cannot be totalled or reconciled against the facility's account. A pickup before the delivery is refused, because a negative period bills as a credit.",
  module: "M22",
  permissions: ["asset:write"],
  /**
   * A retried pickup is refused by the state check rather than duplicated, and
   * declaring this lets the dispatcher dedupe on the key as well, which is what
   * a driver's phone on one bar needs.
   */
  idempotent: true,
  input: z.object({
    id: Uuid,
    pickedUpAt: z.string().datetime().optional(),
    tons: Tons.nullable().optional(),
    divertedTons: Tons.nullable().optional(),
    ticketNumber: z.string().max(100).nullable().optional(),
    facility: z.string().max(200).nullable().optional(),
    materialType: z.string().max(100).nullable().optional(),
    disposalFee: MoneyString.nullable().optional(),
    backInService: z.boolean().optional(),
  }),
  output: RentalView,
});

export const swapRental = defineRoute({
  method: "post",
  path: "/v1/rentals/{id}/swap",
  summary: "Take the full one, leave an empty one",
  description:
    "TWO ROWS, LINKED, and the link is the point. `rental.asset_id` is a single column and the can physically changed, so a swap cannot be an update. Without the link a four week construction hire with three swaps reads as four unrelated week long rentals, and the trade pack's average duration KPI, which says a swap counts inside the parent rental, comes out at a quarter of the truth. The new period carries the old terms forward: a swap mid hire does not renegotiate the rate. Same property always, because a swap is defined by the address staying the same.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    replacementAssetId: Uuid,
    at: z.string().datetime().optional(),
    tons: Tons.nullable().optional(),
    ticketNumber: z.string().max(100).nullable().optional(),
    facility: z.string().max(200).nullable().optional(),
    materialType: z.string().max(100).nullable().optional(),
  }),
  output: z.object({ closed: RentalView, opened: RentalView }),
});

export const getRental = defineRoute({
  method: "get",
  path: "/v1/rentals/{id}",
  summary: "One hire",
  description:
    "`daysSoFar` is container days as the trade counts them: one unit on a customer site for ANY PART of a calendar day, in the company's timezone. Not elapsed hours over twenty four. A can delivered at 4pm Monday and collected at 9am Tuesday is two container days, not 0.7, which is how every operator and every competitor's invoice counts it.",
  module: "M22",
  permissions: ["asset:read"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: RentalView,
});

export const listRentals = defineRoute({
  method: "get",
  path: "/v1/rentals",
  summary: "Hires, newest first",
  description: "Filterable to the open ones, which is the dispatcher's list: what is out and where.",
  module: "M22",
  permissions: ["asset:read"],
  idempotent: true,
  input: z.object({
    open: z.boolean().optional(),
    propertyId: Uuid.optional(),
    assetId: Uuid.optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  output: z.object({ data: z.array(RentalView) }),
});

export const getRentalOverage = defineRoute({
  method: "get",
  path: "/v1/rentals/{id}/overage",
  summary: "What the two meters read",
  description:
    "TWO METERS, NEITHER DERIVED FROM THE OTHER. One runs on elapsed calendar days against an included period, the other on scale ticket tonnage against an included tonnage. A can that sat three weeks holding four hundred pounds owes days and no tons; one collected on day two holding six tons owes tons and no days, and a single overage figure cannot express either case. A missing rate is a REFUSAL rather than a zero: a rental eleven days past its included week with no daily rate on it is eleven days of work nobody can invoice, and reporting nothing to charge would make that leak invisible. Refused while the container is still on site, because a figure that changes every midnight is not something to bill from.",
  module: "M22",
  permissions: ["asset:read"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({
    rentalId: Uuid,
    days: z.number().int(),
    lines: z.array(z.object({
      meter: z.enum(["rental_days", "disposal_tons"]),
      overBy: z.string(),
      rate: MoneyString,
      amount: MoneyString,
    })),
    total: MoneyString,
  }),
});

export const getFleetReport = defineRoute({
  method: "get",
  path: "/v1/fleet-report",
  summary: "Utilisation, duration, tonnage and billing leakage",
  description:
    "Four of the trade pack's eight KPIs, computed with every exclusion the pack names, because each exclusion is the way that metric is usually got wrong. The utilisation denominator INCLUDES units sitting in the yard and EXCLUDES only units tagged out of service: leaving the yard out makes a bloated fleet look fully booked, which is the one conclusion the metric exists to prevent. Average duration counts only hires that ENDED in the window, and folds a swap chain into the one placement it is. Average tonnage EXCLUDES hauls with no scale ticket rather than averaging them in at zero, and reports how many were excluded. Overage capture counts rentals that could be billed over rentals that exceeded, so a rental that went over with no rate on it reads as leakage rather than as success. The other four KPIs are absent rather than approximated: they need invoiced revenue per container, facility cost, truck days from the timeclock, and the moment a unit was emptied, none of which this module has.",
  module: "M22",
  permissions: ["asset:read"],
  idempotent: true,
  input: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  output: z.object({
    from: z.string(),
    to: z.string(),
    windowDays: z.number().int(),
    utilisationRate: z.string().nullable(),
    rentedDays: z.number().int(),
    availableDays: z.number().int(),
    outOfServiceUnits: z.number().int(),
    averageDurationDays: z.string().nullable(),
    rentalsEnded: z.number().int(),
    averageTonsPerHaul: z.string().nullable(),
    haulsWithTicket: z.number().int(),
    haulsWithoutTicket: z.number().int(),
    overageCaptureRate: z.string().nullable(),
    exceededRentals: z.number().int(),
    billableRentals: z.number().int(),
  }),
});

export const rentalRoutes = {
  addRentableAsset,
  listRentableAssets,
  tagAssetOutOfService,
  returnAssetToService,
  retireRentableAsset,
  deliverRental,
  pickUpRental,
  swapRental,
  getFleetReport,
  getRental,
  listRentals,
  getRentalOverage,
} as const;
