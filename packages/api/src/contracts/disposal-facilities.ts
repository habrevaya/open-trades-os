import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * DISPOSAL FACILITIES AS PLACES: where a full can is tipped, when it takes
 * loads and what it charges, so the route can run through it and the fee on
 * a weighed load can be worked out.
 */

const DayHours = z.object({
  /** 0 is Sunday. */
  day: z.number().int().min(0).max(6),
  /** "07:00", in the company's own clock. */
  opens: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  closes: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

const FeeBasis = z.enum(["per_ton", "per_load"]);

const Facility = z.object({
  id: Uuid,
  name: z.string(),
  /** The address in a line, for a list. */
  address: z.string(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  locationPrecision: z.string().nullable(),
  /** `manual` for a pin placed by hand, otherwise the geocoder that found it. */
  locationSource: z.string().nullable(),
  /** Whether the pin is on the map, which the route needs to run through it. */
  onTheMap: z.boolean(),
  /** The days it takes loads. A day not listed is a day it is closed; none listed means the hours are not recorded. */
  hours: z.array(DayHours),
  hoursText: z.string(),
  feeBasis: FeeBasis.nullable(),
  feeAmount: MoneyString.nullable(),
  minimumFee: MoneyString.nullable(),
  feeText: z.string(),
  /** Minutes for the queue, the scale and the tip. */
  tipMinutes: z.number().int(),
  /** The facility a day is planned around unless another is asked for. */
  isDefault: z.boolean(),
  active: z.boolean(),
  notes: z.string().nullable(),
});

const Figures = {
  name: z.string().min(1).max(200),
  addressLine1: z.string().max(200).nullable().optional(),
  addressLine2: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(50).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  hours: z.array(DayHours).max(7).optional(),
  feeBasis: FeeBasis.nullable().optional(),
  feeAmount: MoneyString.nullable().optional(),
  minimumFee: MoneyString.nullable().optional(),
  tipMinutes: z.number().int().min(0).max(180).optional(),
  isDefault: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional(),
};

export const listDisposalFacilities = defineRoute({
  method: "get",
  path: "/v1/disposal-facilities",
  summary: "The landfills and transfer stations the company uses",
  description:
    "Each with its address and pin, the hours it takes loads, its rate by the ton or by the load, and whether it is the facility a day is planned around. Closed ones are left out unless asked for.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({ includeClosed: z.boolean().optional() }),
  output: z.object({ facilities: z.array(Facility) }),
});

export const createDisposalFacility = defineRoute({
  method: "post",
  path: "/v1/disposal-facilities",
  summary: "Record a landfill or transfer station",
  description:
    "A name and, so the route can drive to it, an address the worker puts on the map (or a pin placed by hand with `PUT /v1/disposal-facilities/{id}/pin`). Hours are the days it takes loads, a day not listed being a day it is closed. A rate is what it charges by (a ton or a load) and how much, with a minimum when it has one. The first facility a company records is its default; saying `isDefault` makes this one it and the previous one stops being it.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object(Figures),
  output: Facility,
});

export const updateDisposalFacility = defineRoute({
  method: "patch",
  path: "/v1/disposal-facilities/{id}",
  summary: "Change a facility's address, hours or rate",
  description:
    "Any field left out keeps its value. A new address is put on the map again by the worker unless the pin was placed by hand. A rate changed here applies to loads weighed from then on: a fee already recorded on a haul is left as it was. `active: false` closes it (it leaves the lists and the plan, and the hauls that went there still name it).",
  module: "M22",
  permissions: ["asset:write"],
  input: z.object({ id: Uuid, ...Figures, active: z.boolean().optional() }).partial({ name: true }),
  output: Facility,
});

export const closeDisposalFacility = defineRoute({
  method: "delete",
  path: "/v1/disposal-facilities/{id}",
  summary: "Stop using a facility",
  description: "Closes it: it leaves the lists and the plan, and every haul that went there still names it. It is never deleted.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, closed: z.boolean() }),
});

export const getDisposalFacilityOpen = defineRoute({
  method: "get",
  path: "/v1/disposal-facilities/{id}/open",
  summary: "Whether a facility takes loads at a time",
  description:
    "In the company's own clock. When it is closed, `why` says so in words, with the day, the time and the hours it keeps. A facility with no hours recorded is reported open with `hoursKnown: false`, because unknown is never a reason to refuse a trip.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({ id: Uuid, at: z.string().datetime({ offset: true }) }),
  output: z.object({
    id: Uuid, name: z.string(), at: z.string().datetime(),
    open: z.boolean(), why: z.string().nullable(), hoursKnown: z.boolean(),
  }),
});

const Pinned = z.object({
  id: Uuid,
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  locationPrecision: z.string().nullable(),
  locationSource: z.string().nullable(),
});

export const pinDisposalFacility = defineRoute({
  method: "put",
  path: "/v1/disposal-facilities/{id}/pin",
  summary: "Place a facility's pin by hand",
  description: "For a gate the geocoder puts on the wrong road. It wins from then on: the worker never moves a pin placed by hand.",
  module: "M22",
  permissions: ["asset:write"],
  input: z.object({ id: Uuid, latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  output: Pinned,
});

export const unpinDisposalFacility = defineRoute({
  method: "delete",
  path: "/v1/disposal-facilities/{id}/pin",
  summary: "Take a placed pin off a facility",
  description: "Hands the facility back to the geocoder, which puts it on the map again on its next pass.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Pinned,
});

export const disposalFacilityRoutes = {
  listDisposalFacilities, createDisposalFacility, updateDisposalFacility, closeDisposalFacility,
  getDisposalFacilityOpen, pinDisposalFacility, unpinDisposalFacility,
} as const;
