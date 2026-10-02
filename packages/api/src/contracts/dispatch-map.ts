import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * THE DISPATCH MAP, THE ROUTE OPTIMISER, AND WHERE THINGS ARE
 *
 * Everything here is either a read or a suggestion, apart from placing a pin
 * and the profile and travel settings the suggestions are computed from.
 * Nothing in this file moves a visit: an accepted suggestion goes through
 * `POST /v1/dispatch/route` or `POST /v1/visits/{id}/assign`, the same calls
 * a drag on the board makes, so there is one path that changes a day and it
 * keeps its checks.
 */

export const Precision = z.enum(["rooftop", "interpolated", "street", "postal_code", "locality", "placed"]);

export const Position = z.object({
  lat: z.number(),
  lng: z.number(),
  precision: Precision.nullable(),
  /** `manual` when a person placed it, otherwise the geocoder's key. */
  source: z.string().nullable(),
});

const Travel = z.object({
  /** Average speed across a whole drive, kilometres an hour. */
  averageKmh: z.number(),
  /** How much longer the road is than the straight line. */
  roadFactor: z.number(),
  /** When a technician's day starts, local time, HH:MM. */
  dayStartsAt: z.string(),
});

/* ------------------------------------------------------------------ map */

export const getDispatchMap = defineRoute({
  method: "get",
  path: "/v1/dispatch/map",
  summary: "A day on the map: every visit as a pin, every technician's route as a line",
  description:
    "The same day the board draws, with where each visit is. A visit at an address that is not on the map yet is listed in `unplaced` rather than dropped, so the office can place a pin for it.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({ date: z.string().date() }),
  output: z.object({
    date: z.string().date(),
    timezone: z.string(),
    technicians: z.array(z.object({
      id: Uuid,
      displayName: z.string(),
      color: z.string().nullable(),
      timeOff: z.boolean(),
      /** Where the day starts and ends. Null when no location has an address on the map. */
      start: z.object({ locationId: Uuid, name: z.string(), position: Position.nullable() }).nullable(),
      /** True when this is the company's first location rather than one set for this person. */
      startIsCompanyDefault: z.boolean(),
      /** This technician's visits in the order they will drive them. */
      route: z.array(Uuid),
    })),
    visits: z.array(z.object({
      id: Uuid,
      jobId: Uuid,
      jobNumber: z.number().int(),
      summary: z.string(),
      customerName: z.string(),
      propertyId: Uuid,
      address: z.string(),
      status: z.string(),
      windowStart: z.string().datetime().nullable(),
      windowEnd: z.string().datetime().nullable(),
      estimatedDurationMinutes: z.number().int(),
      routeOrder: z.number().int().nullable(),
      isLate: z.boolean(),
      /** The lead, whose colour the pin takes. Null is unassigned. */
      technicianId: Uuid.nullable(),
      technicianIds: z.array(Uuid),
      position: Position.nullable(),
    })),
    /** Visits whose address is not on the map yet, by id. Never silently dropped. */
    unplaced: z.array(Uuid),
    travel: Travel,
    /** The connected geocoder's key, or null when the company has not connected one. */
    geocoder: z.string().nullable(),
  }),
});

/* ------------------------------------------------------------ optimiser */

const DaySummary = z.object({
  order: z.array(Uuid),
  driveMinutes: z.number().int(),
  waitMinutes: z.number().int(),
  lateCount: z.number().int(),
  lateMinutes: z.number().int(),
  /** Back where the day ends. */
  finishAt: z.string().datetime(),
});

export const getRouteProposal = defineRoute({
  method: "get",
  path: "/v1/dispatch/optimise",
  summary: "Propose a better order for one technician's day",
  description:
    "A suggestion, never a reorder. It keeps arrival windows first and drive time second, starts and ends where the technician's day does, leaves work already under way where it is, and names any window it still cannot meet. Applying it is `POST /v1/dispatch/route` with `applyOrder`.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({ date: z.string().date(), technicianId: Uuid }),
  output: z.object({
    technicianId: Uuid,
    date: z.string().date(),
    /** Whether the day's start is on the map. When it is not, drives to and from it are left out and the figures say so. */
    startKnown: z.boolean(),
    startLabel: z.string().nullable(),
    current: DaySummary,
    proposed: DaySummary,
    improved: z.boolean(),
    missed: z.array(z.object({
      visitId: Uuid,
      customerName: z.string(),
      lateByMinutes: z.number().int(),
      /** No order at all could have kept this window. */
      unreachable: z.boolean(),
    })),
    /** Already under way or finished, so not moved. First in `applyOrder`. */
    locked: z.array(Uuid),
    /** Not on the map yet, so not ordered. Last in `applyOrder`, in the order they had. */
    unplaced: z.array(Uuid),
    /** The whole day in the proposed order, ready for `POST /v1/dispatch/route`. */
    applyOrder: z.array(Uuid),
    /** How many legs used the drive time the company declared on a route rather than an estimate. */
    declaredLegs: z.number().int(),
    travel: Travel,
  }),
});

export const getAssignmentSuggestions = defineRoute({
  method: "get",
  path: "/v1/dispatch/suggestions",
  summary: "Suggest who should take each unassigned visit",
  description:
    "For each unassigned visit on the day, the technician it adds the least driving to without breaking a window, among those whose skills and time off allow it. Every technician considered is listed with their figure or the reason they were ruled out. Accepting one is `POST /v1/visits/{id}/assign`.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({ date: z.string().date() }),
  output: z.object({
    date: z.string().date(),
    suggestions: z.array(z.object({
      visitId: Uuid,
      customerName: z.string(),
      technicianId: Uuid.nullable(),
      technicianName: z.string().nullable(),
      /** Where in their day, counted from one, as the board numbers it. */
      position: z.number().int().nullable(),
      addedDriveMinutes: z.number().int().nullable(),
      /** Windows this would break, this visit's included. Empty when it fits. */
      wouldBeLate: z.array(z.object({ visitId: Uuid, lateByMinutes: z.number().int() })),
      /** Skills nothing could check for the suggested technician, said rather than hidden. */
      unknownSkills: z.array(z.string()),
      considered: z.array(z.object({
        technicianId: Uuid,
        technicianName: z.string(),
        addedDriveMinutes: z.number().int().nullable(),
        makesLate: z.boolean(),
        refused: z.string().nullable(),
      })),
    })),
    /** Unassigned visits not on the map, which nothing can be suggested for. */
    unplaced: z.array(Uuid),
  }),
});

/* --------------------------------------------------------------- travel */

export const getTravelSettings = defineRoute({
  method: "get",
  path: "/v1/dispatch/travel",
  summary: "How drive time is estimated",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({}),
  output: Travel,
});

export const setTravelSettings = defineRoute({
  method: "put",
  path: "/v1/dispatch/travel",
  summary: "Change how drive time is estimated",
  description:
    "The average speed and road factor every estimated drive uses, and when a technician's day starts. A route's own declared drive time is used instead wherever two stops are on the same route.",
  module: "M09",
  permissions: ["settings:write"],
  input: z.object({
    averageKmh: z.number().min(5).max(130).optional(),
    roadFactor: z.number().min(1).max(3).optional(),
    dayStartsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time is HH:MM").optional(),
  }),
  output: Travel,
});

/* ---------------------------------------------------------- technicians */

const Technician = z.object({
  id: Uuid,
  displayName: z.string(),
  color: z.string().nullable(),
  active: z.boolean(),
  /** What this person is recorded as doing, beside any certification. */
  skills: z.array(z.string()),
  /** Where their day starts and ends. Null uses the company's first location. */
  homeLocationId: Uuid.nullable(),
});

export const listTechnicians = defineRoute({
  method: "get",
  path: "/v1/technicians",
  summary: "Technicians, with their skills and where their day starts",
  module: "M24",
  permissions: ["visit:read"],
  input: z.object({}),
  output: z.object({ technicians: z.array(Technician) }),
});

export const updateTechnician = defineRoute({
  method: "patch",
  path: "/v1/technicians/{id}",
  summary: "Record a technician's skills, colour and where their day starts",
  description:
    "Skills recorded here are what assignment checks a person against for any skill no certification type grants. A skill counts against somebody only once at least one person in the company is recorded with it, so recording the first person who does gas work is what starts refusing everybody else.",
  module: "M24",
  permissions: ["user:write"],
  input: z.object({
    id: Uuid,
    skills: z.array(z.string().min(1).max(60)).max(50).optional(),
    homeLocationId: Uuid.nullable().optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "A colour is #RRGGBB").nullable().optional(),
  }),
  output: Technician,
});

/* ----------------------------------------------------------------- pins */

const Pin = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const Located = z.object({
  id: Uuid,
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  locationPrecision: Precision.nullable(),
  locationSource: z.string().nullable(),
});

export const pinProperty = defineRoute({
  method: "post",
  path: "/v1/properties/{id}/pin",
  summary: "Place a property on the map by hand",
  description:
    "A pin placed by a person wins over the geocoder from then on: the worker never moves it. Setting the same pin twice leaves the same pin, so a retry is harmless.",
  module: "M03",
  permissions: ["property:write"],
  idempotent: true,
  input: Pin.extend({ id: Uuid }),
  output: Located,
});

export const unpinProperty = defineRoute({
  method: "delete",
  path: "/v1/properties/{id}/pin",
  summary: "Hand a property back to the geocoder",
  module: "M03",
  permissions: ["property:write"],
  input: z.object({ id: Uuid }),
  output: Located,
});

export const pinLocation = defineRoute({
  method: "post",
  path: "/v1/locations/{id}/pin",
  summary: "Place a branch or yard on the map by hand",
  description: "Where technicians' days start. The same rule as a property: a placed pin wins.",
  module: "M09",
  permissions: ["settings:write"],
  idempotent: true,
  input: Pin.extend({ id: Uuid }),
  output: Located,
});

export const unpinLocation = defineRoute({
  method: "delete",
  path: "/v1/locations/{id}/pin",
  summary: "Hand a branch or yard back to the geocoder",
  module: "M09",
  permissions: ["settings:write"],
  input: z.object({ id: Uuid }),
  output: Located,
});

export const getGeocodingStatus = defineRoute({
  method: "get",
  path: "/v1/geocoding",
  summary: "How many addresses are on the map, and which are not",
  description:
    "Counts by how precisely each address is placed, how many are waiting for the geocoder, and the addresses it could not find, which only a pin placed by hand will fix.",
  module: "M25",
  permissions: ["property:read"],
  input: z.object({}),
  output: z.object({
    geocoder: z.string().nullable(),
    total: z.number().int(),
    byPrecision: z.record(z.number().int()),
    waiting: z.number().int(),
    notFound: z.array(z.object({ propertyId: Uuid, address: z.string(), reason: z.string().nullable() })),
    failing: z.number().int(),
  }),
});

export const dispatchMapRoutes = {
  getDispatchMap, getRouteProposal, getAssignmentSuggestions,
  getTravelSettings, setTravelSettings,
  listTechnicians, updateTechnician,
  pinProperty, unpinProperty, pinLocation, unpinLocation, getGeocodingStatus,
} as const;
