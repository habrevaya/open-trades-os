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

/** Where drive times came from, said on every figure built from them. */
export const DriveSource = {
  /** `road` from the connected routing service, `estimate` from the straight line, `mixed` when some of each. */
  driveSource: z.enum(["road", "estimate", "mixed"]),
  /** The same in a sentence for the screen, including why a connected service was not used. */
  driveNote: z.string(),
};

export const LivePosition = z.object({
  technicianId: Uuid,
  displayName: z.string(),
  color: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  accuracyMeters: z.number().int().nullable(),
  recordedAt: z.string().datetime(),
  /** Why it was taken: on the way to a visit, working one, or clocked in. */
  reason: z.enum(["on_the_way", "working", "on_the_clock"]),
  visitId: Uuid.nullable(),
  /** Within five minutes, within half an hour, or older. */
  freshness: z.enum(["live", "recent", "stale"]),
  /** "4 minutes ago". */
  lastSeen: z.string(),
  /**
   * The path they took today, oldest first: the positions kept since the
   * start of the company's day, a parked stretch as one point, thinned
   * evenly to at most 400 points.
   */
  trail: z.array(z.object({ lat: z.number(), lng: z.number(), at: z.string().datetime() })),
});

export const LivePositions = z.object({
  /** False when the company does not share locations; `positions` is then empty. */
  enabled: z.boolean(),
  positions: z.array(LivePosition),
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
    /** Crews with work on the day, each with its visits in order, drawn as a line like a technician's. */
    crews: z.array(z.object({
      id: Uuid,
      name: z.string(),
      color: z.string().nullable(),
      start: z.object({ locationId: Uuid, name: z.string(), position: Position.nullable() }).nullable(),
      memberIds: z.array(Uuid),
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
      /** The crew it was sent to, for crew work. */
      crewId: Uuid.nullable(),
      /** Locked by the office: the rebalance and the optimiser leave it where it is. */
      locked: z.boolean(),
      position: Position.nullable(),
    })),
    /** Visits whose address is not on the map yet, by id. Never silently dropped. */
    unplaced: z.array(Uuid),
    travel: Travel,
    /** The connected geocoder's key, or null when the company has not connected one. */
    geocoder: z.string().nullable(),
    /** The connected routing service's key, or null when drive times are straight line estimates. */
    routing: z.string().nullable(),
    /**
     * Where technicians are now, for a caller who dispatches (`visit:dispatch`)
     * on today's map. Null for anybody else and for any other day.
     */
    live: LivePositions.nullable(),
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
    "A suggestion, never a reorder. It keeps arrival windows first and drive time second, starts and ends where the technician's day does, leaves work already under way where it is, and names any window it still cannot meet. A driver's day with container drops, collections and swaps on it is ordered by what is on the truck, with the runs to the yard it needs, when the yard is on the map. Applying it is `POST /v1/dispatch/route` with `applyOrder`.",
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
    /** Locked by the office, so kept in their place while the rest is ordered around them. */
    pinned: z.array(Uuid),
    /** Not on the map yet, so not ordered. Last in `applyOrder`, in the order they had. */
    unplaced: z.array(Uuid),
    /** The whole day in the proposed order, ready for `POST /v1/dispatch/route`. */
    applyOrder: z.array(Uuid),
    /** How many legs used the drive time the company declared on a route rather than an estimate. */
    declaredLegs: z.number().int(),
    travel: Travel,
    /**
     * A driver's day with containers on it, ordered by what is on the truck:
     * a drop needs an empty on board, a collection needs room. Null for a day
     * with none.
     */
    truck: z.object({
      /** False when the yard (where the day starts) is not on the map, so the day was ordered as any other. */
      byTruck: z.boolean(),
      note: z.string(),
      containersPerTruck: z.number().int(),
      yardMinutes: z.number().int(),
      /** Runs to the yard in the middle of the day in the order it has now (not the one at the end). */
      currentYardRuns: z.number().int().nullable(),
      /** The runs to the yard the proposed order takes, in order: after which stop, before which, and what is done there. */
      yardRuns: z.array(z.object({
        /** Null when the run is the first thing the truck does. */
        afterVisitId: Uuid.nullable(),
        /** Null for the run at the end of the day. */
        beforeVisitId: Uuid.nullable(),
        tipped: z.number().int(),
        /** Empties loaded, or left at the yard when negative. */
        loaded: z.number().int(),
        arriveAt: z.string().datetime(),
      })),
      /** What the truck leaves with. */
      startLoad: z.object({ empties: z.number().int(), fulls: z.number().int() }).nullable(),
    }).nullable(),
    ...DriveSource,
  }),
});

export const getAssignmentSuggestions = defineRoute({
  method: "get",
  path: "/v1/dispatch/suggestions",
  summary: "Suggest who should take each unassigned visit",
  description:
    "For each unassigned visit on the day, the technician it adds the least driving to without breaking a window, among those whose skills and time off allow it. Members whose plan promises priority dispatch are placed first, so the cheapest gap on the day goes to them. Every technician considered is listed with their figure or the reason they were ruled out. Accepting one is `POST /v1/visits/{id}/assign`.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({ date: z.string().date() }),
  output: z.object({
    date: z.string().date(),
    suggestions: z.array(z.object({
      visitId: Uuid,
      customerName: z.string(),
      /** The plan whose priority dispatch put this visit first, when one did. */
      member: z.string().nullable(),
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
    ...DriveSource,
  }),
});

/* ------------------------------------------------------------ rebalance */

export const Workday = z.object({
  /** When the working day ends, local time, HH:MM. */
  dayEndsAt: z.string(),
  /** Minutes of break; zero plans none. */
  lunchMinutes: z.number().int(),
  /** The earliest and latest a break may start, local time. */
  lunchEarliest: z.string(),
  lunchLatest: z.string(),
  /** Overtime the rebalance may plan past the end of the day. */
  maxOvertimeMinutes: z.number().int(),
});

export const RebalancedDay = z.object({
  order: z.array(Uuid),
  driveMinutes: z.number().int(),
  /** Back where the day ends. */
  finishAt: z.string().datetime(),
  overtimeMinutes: z.number().int(),
  /** Minutes past the end of the day plus the overtime allowed. */
  overLimitMinutes: z.number().int(),
  lunchAt: z.string().datetime().nullable(),
  lunchLateMinutes: z.number().int(),
  late: z.array(z.object({ visitId: Uuid, lateByMinutes: z.number().int() })),
  /** Visits on this day the person may not do, which could not be moved off it. */
  refused: z.array(Uuid),
});

export const getRebalance = defineRoute({
  method: "get",
  path: "/v1/dispatch/rebalance",
  summary: "Propose the whole day rebalanced across the technicians",
  description:
    "A proposal, never a change. Places the unassigned pile and moves assigned work between technicians where that keeps windows, the end of the working day, the overtime allowed, lunch and skills, and saves real driving; orders each day; leaves locked visits, crew visits, visits with several people and work under way where they are. Each technician's day is shown before and after, with the drive time saved. Applying it is `POST /v1/dispatch/rebalance/apply` with `basis`, `moveAssignments` and `apply`.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({ date: z.string().date() }),
  output: z.object({
    date: z.string().date(),
    /** The day this was proposed from. Applying is refused once the board no longer matches it. */
    basis: z.string(),
    changed: z.boolean(),
    technicians: z.array(z.object({
      technicianId: Uuid,
      displayName: z.string(),
      color: z.string().nullable(),
      timeOff: z.boolean(),
      before: RebalancedDay,
      after: RebalancedDay,
    })),
    moves: z.array(z.object({
      visitId: Uuid,
      customerName: z.string(),
      /** Null when the visit had nobody. */
      fromTechnicianId: Uuid.nullable(),
      fromName: z.string().nullable(),
      toTechnicianId: Uuid,
      toName: z.string(),
    })),
    /** Visits it could not place, each with why in a sentence. */
    unplaced: z.array(z.object({ visitId: Uuid, customerName: z.string(), reason: z.string() })),
    /** Technicians left out, with their work where it is, because their day cannot be measured. */
    leftOut: z.array(z.object({ technicianId: Uuid, displayName: z.string(), reason: z.string() })),
    /** Visits not planned at all (not on the map, a crew's, several people's), left where they are. */
    untouched: z.array(Uuid),
    driveBeforeMinutes: z.number().int(),
    driveAfterMinutes: z.number().int(),
    /** Negative when placing the unassigned pile adds more driving than the rest saves. */
    driveSavedMinutes: z.number().int(),
    overtimeBeforeMinutes: z.number().int(),
    overtimeAfterMinutes: z.number().int(),
    /** Visits that had nobody and would have somebody. */
    newlyAssigned: z.number().int(),
    /** Every visit the rebalance planned, so a screen can name the stops in each day. */
    visits: z.array(z.object({
      visitId: Uuid,
      customerName: z.string(),
      locked: z.boolean(),
      windowStart: z.string().datetime().nullable(),
      windowEnd: z.string().datetime().nullable(),
    })),
    /** Ready for the apply call. */
    moveAssignments: z.array(z.object({ visitId: Uuid, technicianId: Uuid })),
    apply: z.array(z.object({ technicianId: Uuid, visitIds: z.array(Uuid) })),
    workday: Workday,
    ...DriveSource,
  }),
});

export const applyRebalance = defineRoute({
  method: "post",
  path: "/v1/dispatch/rebalance/apply",
  summary: "Apply a rebalanced day somebody looked at",
  description:
    "Assigns each moved visit and sets each changed day's order through the same assignment and reorder a drag uses, in one transaction, so a skill refusal refuses the whole thing and leaves the day as it was. Refused when the board has changed since the proposal's `basis` was taken.",
  module: "M09",
  permissions: ["visit:dispatch", "visit:reschedule"],
  idempotent: true,
  input: z.object({
    date: z.string().date(),
    basis: z.string().min(1).max(100),
    moves: z.array(z.object({ visitId: Uuid, technicianId: Uuid })).max(200),
    orders: z.array(z.object({ technicianId: Uuid, visitIds: z.array(Uuid).max(60) })).max(100),
  }),
  output: z.object({ ok: z.literal(true), moved: z.number().int(), reordered: z.number().int() }),
});

export const lockVisit = defineRoute({
  method: "post",
  path: "/v1/visits/{id}/lock",
  summary: "Lock a visit to whoever has it, or unlock it",
  description:
    "A locked visit stays with its technician and in its place when the day is rebalanced or a route is optimised. For the customer who was promised a particular person first thing. Setting the same state twice changes nothing.",
  module: "M09",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: z.object({ id: Uuid, locked: z.boolean() }),
  output: z.object({ id: Uuid, locked: z.boolean() }),
});

export const getWorkdaySettings = defineRoute({
  method: "get",
  path: "/v1/dispatch/workday",
  summary: "The working day the rebalance plans inside",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({}),
  output: Workday,
});

export const setWorkdaySettings = defineRoute({
  method: "put",
  path: "/v1/dispatch/workday",
  summary: "Change the working day the rebalance plans inside",
  description:
    "When the day ends, the break and its window, and the overtime a plan may use. When the day starts is the travel settings' `dayStartsAt`. A technician with their own hours has those instead of the start and end.",
  module: "M09",
  permissions: ["settings:write"],
  input: z.object({
    dayEndsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time is HH:MM").optional(),
    lunchMinutes: z.number().int().min(0).max(120).optional(),
    lunchEarliest: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time is HH:MM").optional(),
    lunchLatest: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time is HH:MM").optional(),
    maxOvertimeMinutes: z.number().int().min(0).max(480).optional(),
  }),
  output: Workday,
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
  /** Their own working hours, local time, when they are not the company's. */
  workday: z.object({ startsAt: z.string(), endsAt: z.string() }).nullable(),
  /** Whether their phone shares where they are while they work, when the company shares at all. */
  shareLocation: z.boolean(),
  /** Whether a photograph is set for customers' tracking links. */
  hasPhoto: z.boolean(),
});

const HoursOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time is HH:MM");

export const listTechnicians = defineRoute({
  method: "get",
  path: "/v1/technicians",
  summary: "Technicians, with their skills and where their day starts",
  module: "M24",
  permissions: ["visit:read"],
  input: z.object({}),
  output: z.object({
    technicians: z.array(Technician),
    /** Where the day starts for somebody with no start of their own: the company's first location. */
    companyStart: z.object({ locationId: Uuid, name: z.string() }).nullable(),
  }),
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
    /** Their own hours. Null puts them back on the company's. */
    workday: z.object({ startsAt: HoursOfDay, endsAt: HoursOfDay }).nullable().optional(),
    /** Turning it off deletes the positions already kept for them. */
    shareLocation: z.boolean().optional(),
  }),
  output: Technician,
});

export const setTechnicianPhoto = defineRoute({
  method: "post",
  path: "/v1/technicians/{id}/photo",
  summary: "Set or clear the photo customers see on their tracking link",
  description:
    "The bytes base64, a JPEG, PNG or WebP of at most two megabytes, decided from the bytes rather than from what the upload claims. Null clears it. Customers see it beside the first name only, on the link an On my way text carries. Setting the same picture twice keeps one copy.",
  module: "M24",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ id: Uuid, bytes: z.string().max(4_000_000).nullable() }),
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
  getRebalance, applyRebalance, lockVisit, getWorkdaySettings, setWorkdaySettings,
  listTechnicians, updateTechnician, setTechnicianPhoto,
  pinProperty, unpinProperty, pinLocation, unpinLocation, getGeocodingStatus,
} as const;
