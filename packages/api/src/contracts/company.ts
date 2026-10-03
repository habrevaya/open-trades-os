import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * THE COMPANY'S OWN STRUCTURE, AND THE DAY SOMEBODY IS AWAY
 *
 * Four tables between them, every one of them in the schema since the first
 * migration, every one read by services that are built and tested, and not
 * one of them with a write path until this file. `services/company.ts` and
 * `services/time-off.ts` carry the reasoning at length; the short version is
 * that a gate reading a table nothing can fill is a feature that can never
 * fire, which is the same class of defect as a claim the code does not
 * support.
 *
 * ONE FILE for the four, because they are one screen: the thing an operator
 * fills in when they set the company up, plus the queue an approver works
 * every week. Splitting them would put the four halves of one setup flow in
 * four places.
 *
 * NO NEW PERMISSIONS. `settings:read`, `settings:write`, `timeclock:own`,
 * `timesheet:read`, `timesheet:approve` and `po:write` are all already in
 * `packages/core/src/access/permissions.ts`, which is the whole of the
 * authorization model: a string that is not in it cannot be granted to
 * anybody, so inventing one would be a permission no role could hold.
 */

/* --------------------------------------------------------- business units */

export const BusinessUnit = z.object({
  id: Uuid,
  name: z.string(),
  /** The short code that appears on a report and in an accounting export. */
  code: z.string().nullable(),
  active: z.boolean(),
});

export const listBusinessUnits = defineRoute({
  method: "get",
  path: "/v1/business-units",
  summary: "The divisions this company runs",
  module: "M01",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ units: z.array(BusinessUnit) }),
});

export const createBusinessUnit = defineRoute({
  method: "post",
  path: "/v1/business-units",
  summary: "Add a division",
  description:
    "A business unit scopes jobs, invoices, ledger entries, phone numbers and people to one part of the company. Nothing could create one before this, so the dispatch blocker that refuses a crew from a different unit was comparing two nulls on every job in every company.",
  module: "M01",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(200),
    code: z.string().max(50).nullable().optional(),
  }),
  output: BusinessUnit,
});

export const updateBusinessUnit = defineRoute({
  method: "patch",
  path: "/v1/business-units/{id}",
  summary: "Rename a division, or retire it",
  description:
    "Retiring sets active to false and never deletes. Every foreign key onto a business unit is ON DELETE SET NULL, so a delete would silently unscope twelve tables of history and last year's revenue by branch would change.",
  module: "M01",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    code: z.string().max(50).nullable().optional(),
    active: z.boolean().optional(),
  }),
  output: BusinessUnit,
});

/* -------------------------------------------------------------- locations */

export const Location = z.object({
  id: Uuid,
  name: z.string(),
  addressLine1: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string(),
  /** The branch's own zone. Null means the company's. */
  timezone: z.string().nullable(),
  /** Whether stock is counted here. Inventory only counts warehouses. */
  isWarehouse: z.boolean(),
  active: z.boolean(),
  /** Where it is, for the dispatch map and the route optimiser. See `POST /v1/locations/{id}/pin`. */
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  locationPrecision: z.enum(["rooftop", "interpolated", "street", "postal_code", "locality", "placed"]).nullable(),
  locationSource: z.string().nullable(),
});

export const listLocations = defineRoute({
  method: "get",
  path: "/v1/locations",
  summary: "Branches and warehouses",
  module: "M01",
  permissions: ["settings:read"],
  input: z.object({ warehousesOnly: z.boolean().optional() }),
  output: z.object({ locations: z.array(Location) }),
});

export const createLocation = defineRoute({
  method: "post",
  path: "/v1/locations",
  summary: "Add a branch or a warehouse",
  description:
    "purchase_order.default_location_id is NOT NULL, so until a location existed a company could not raise a purchase order at all.",
  module: "M01",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(200),
    addressLine1: z.string().max(200).nullable().optional(),
    addressLine2: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    state: z.string().max(50).nullable().optional(),
    postalCode: z.string().max(20).nullable().optional(),
    country: z.string().length(2).optional(),
    timezone: z.string().max(60).nullable().optional(),
    isWarehouse: z.boolean().optional(),
  }),
  output: Location,
});

export const updateLocation = defineRoute({
  method: "patch",
  path: "/v1/locations/{id}",
  summary: "Change a branch, or close it",
  description:
    "A warehouse still holding stock is refused the change to not-a-warehouse. The parts would not move, they would stop being counted, and the reorder report would start asking for things that are on the shelf.",
  module: "M01",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    addressLine1: z.string().max(200).nullable().optional(),
    addressLine2: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    state: z.string().max(50).nullable().optional(),
    postalCode: z.string().max(20).nullable().optional(),
    country: z.string().length(2).optional(),
    timezone: z.string().max(60).nullable().optional(),
    isWarehouse: z.boolean().optional(),
    active: z.boolean().optional(),
  }),
  output: Location,
});

/* ------------------------------------------------------------ territories */

export const Territory = z.object({
  id: Uuid,
  name: z.string(),
  postalCodes: z.array(z.string()),
  homeLocationId: Uuid.nullable(),
  travelFee: MoneyString.nullable(),
  color: z.string().nullable(),
  active: z.boolean(),
});

export const listTerritories = defineRoute({
  method: "get",
  path: "/v1/territories",
  summary: "The areas this company covers",
  module: "M01",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ territories: z.array(Territory) }),
});

export const createTerritory = defineRoute({
  method: "post",
  path: "/v1/territories",
  summary: "Draw an area",
  description:
    "A property's territory is resolved from its postal code, and it decides the travel fee and which route a stop belongs to. With no territories every property in every company was outside every area. One postal code may belong to at most one territory, because two matches mean a property whose travel fee changes between two reads.",
  module: "M01",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(200),
    postalCodes: z.array(z.string().min(1).max(20)).optional(),
    homeLocationId: Uuid.nullable().optional(),
    travelFee: MoneyString.nullable().optional(),
    color: z.string().max(20).nullable().optional(),
  }),
  output: Territory,
});

export const updateTerritory = defineRoute({
  method: "patch",
  path: "/v1/territories/{id}",
  summary: "Change an area, or retire it",
  module: "M01",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    postalCodes: z.array(z.string().min(1).max(20)).optional(),
    homeLocationId: Uuid.nullable().optional(),
    travelFee: MoneyString.nullable().optional(),
    color: z.string().max(20).nullable().optional(),
    active: z.boolean().optional(),
  }),
  output: Territory,
});

/* --------------------------------------------------------------- time off */

export const TimeOff = z.object({
  id: Uuid,
  technicianId: Uuid,
  technicianName: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  reason: z.string().nullable(),
  approved: z.boolean(),
  /**
   * Requested, approved, or declined.
   *
   * `approved` is a boolean and cannot tell a request nobody has looked at
   * from one somebody turned down. Both are false, and the difference is
   * whether the technician should expect an answer.
   */
  standing: z.enum(["requested", "approved", "declined"]),
});

export const requestTimeOff = defineRoute({
  method: "post",
  path: "/v1/time-off",
  summary: "Ask for a day, or record somebody else's",
  description:
    "Requested, never approved. The dispatch board, the crew gate and the booking page all read approved leave only, and a request that granted itself would make them refuse work on a day nobody has agreed to. Asking for your own needs timeclock:own; recording somebody else's needs the authority that approves.",
  module: "M17",
  permissions: ["timeclock:own"],
  idempotent: true,
  input: z.object({
    technicianId: Uuid.optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    reason: z.string().max(500).nullable().optional(),
  }),
  output: TimeOff,
});

export const listTimeOff = defineRoute({
  method: "get",
  path: "/v1/time-off",
  summary: "One person's time off",
  description:
    "Overlap rather than containment: a fortnight that starts before the window and ends after it covers every day in it and is contained by nothing.",
  module: "M17",
  permissions: ["timeclock:own"],
  input: z.object({
    technicianId: Uuid.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    pendingOnly: z.boolean().optional(),
    includeDeclined: z.boolean().optional(),
  }),
  output: z.object({ timeOff: z.array(TimeOff) }),
});

export const pendingTimeOff = defineRoute({
  method: "get",
  path: "/v1/time-off/pending",
  summary: "Every request nobody has answered",
  module: "M17",
  permissions: ["timesheet:approve"],
  input: z.object({}),
  output: z.object({ timeOff: z.array(TimeOff) }),
});

export const approveTimeOff = defineRoute({
  method: "post",
  path: "/v1/time-off/{id}/approve",
  summary: "Grant it",
  description:
    "The write the board and the crew gate actually read. Overlap is checked again here, not only at request time: two people can request the same week before either is granted.",
  module: "M17",
  permissions: ["timesheet:approve"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: TimeOff,
});

export const declineTimeOff = defineRoute({
  method: "post",
  path: "/v1/time-off/{id}/decline",
  summary: "Turn it down, or take an approval back",
  description:
    "Soft deleted rather than removed, because 'did I put in for that week' is a question people ask months later and a deleted row answers it with silence. Taking back an approval needs a reason: somebody has arranged their week around it.",
  module: "M17",
  permissions: ["timesheet:approve"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().max(500).nullable().optional() }),
  output: TimeOff,
});

export const withdrawTimeOff = defineRoute({
  method: "post",
  path: "/v1/time-off/{id}/withdraw",
  summary: "Take your own request back",
  description:
    "Only your own, and only while it is still a request. Once it is approved the board has been drawn around it and a dispatcher may have moved work, so taking it back needs the authority that granted it.",
  module: "M17",
  permissions: ["timeclock:own"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: TimeOff,
});

/* -------------------------------------------------------- reorder policy */

export const ReorderPolicy = z.object({
  id: Uuid,
  itemId: Uuid,
  itemName: z.string().nullable(),
  locationId: Uuid,
  locationName: z.string().nullable(),
  reorderPoint: z.string(),
  reorderQuantity: z.string(),
  targetLevel: z.string().nullable(),
  preferredVendorId: Uuid.nullable(),
});

export const listReorderPolicies = defineRoute({
  method: "get",
  path: "/v1/reorder-policies",
  summary: "What this company keeps in stock, and when to buy more",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({}),
  output: z.object({ policies: z.array(ReorderPolicy) }),
});

export const setReorderPolicy = defineRoute({
  method: "put",
  path: "/v1/reorder-policies",
  summary: "Declare when to reorder a part",
  description:
    "The 'what to buy' report opens by returning an empty array when no policy exists, and nothing could write one, so it was empty for every company that ever opened it. One policy per item per location, upserted, because setting the reorder point is one intention whether or not a row is already there.",
  module: "M16",
  permissions: ["po:write"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    locationId: Uuid,
    reorderPoint: z.string().regex(/^-?\d+(\.\d{1,4})?$/),
    reorderQuantity: z.string().regex(/^-?\d+(\.\d{1,4})?$/),
    targetLevel: z.string().regex(/^-?\d+(\.\d{1,4})?$/).nullable().optional(),
    preferredVendorId: Uuid.nullable().optional(),
  }),
  output: ReorderPolicy.pick({
    id: true, itemId: true, locationId: true,
    reorderPoint: true, reorderQuantity: true, targetLevel: true, preferredVendorId: true,
  }),
});

export const clearReorderPolicy = defineRoute({
  method: "post",
  path: "/v1/reorder-policies/clear",
  summary: "Stop buying a part automatically",
  module: "M16",
  permissions: ["po:write"],
  idempotent: true,
  input: z.object({ itemId: Uuid, locationId: Uuid }),
  output: z.object({ itemId: Uuid, locationId: Uuid, cleared: z.boolean() }),
});

export const companyRoutes = {
  listBusinessUnits,
  createBusinessUnit,
  updateBusinessUnit,
  listLocations,
  createLocation,
  updateLocation,
  listTerritories,
  createTerritory,
  updateTerritory,
  requestTimeOff,
  listTimeOff,
  pendingTimeOff,
  approveTimeOff,
  declineTimeOff,
  withdrawTimeOff,
  listReorderPolicies,
  setReorderPolicy,
  clearReorderPolicy,
} as const;
