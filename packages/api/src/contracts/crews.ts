import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";

/**
 * THE OTHER THREE CAPACITY MODELS
 *
 * `schema/scheduling.ts` opens by naming four structurally different ways a
 * home services company sells capacity, and says that building all four as
 * first class is the structural differentiator: retrofitting a second model
 * into an engine that assumed the first is a rewrite rather than a feature.
 *
 * One of the four, technician dispatch, is published in `contracts/field.ts`
 * and works. This file publishes what a crew company and a route company
 * need, plus the rota that says who answers the phone at two in the morning.
 *
 *   crew_production  a crew with shared skills and shared equipment, which is
 *                    tree, landscape install, painting, roofing and fencing.
 *                    The question is whether this crew can take this job, and
 *                    the equipment is half of the answer: a tree crew without
 *                    the chipper cannot take the work no matter who is in the
 *                    truck.
 *
 *   route            a stop in a sequence, priced by density. Pool, pest,
 *                    lawn, cleaning, gutters and snow sell routes rather than
 *                    appointments, and the number that decides whether the
 *                    business works is how many stops fit between the first
 *                    and the last without overtime.
 *
 *   on call          who gets the two in the morning call, and the handover.
 *
 * ONE FILE RATHER THAN THREE, which is a judgement and is worth stating. They
 * are one module's surface, M09, and they are published together for the same
 * reason the schema puts the four models in one file: a reader deciding
 * whether this product fits their trade is choosing between the models, and
 * splitting them across files makes that comparison an exercise in grep.
 *
 * NOTHING HERE CHANGES TECHNICIAN DISPATCH. These are additional routes
 * beside the board, not a replacement for it, and a company that dispatches
 * individuals never calls any of them.
 */

/* ------------------------------------------------------------------ crews */

export const CrewMember = z.object({
  technicianId: Uuid,
  displayName: z.string(),
  isLead: z.boolean(),
  active: z.boolean(),
});

export const Crew = z.object({
  id: Uuid,
  name: z.string(),
  /** The branch the crew belongs to. A crew in none is seen only by people who see the whole company. */
  businessUnitId: Uuid.nullable(),
  /** The shop it is based at, where its day starts. */
  homeLocationId: Uuid.nullable(),
  /**
   * Units of production per crew-day, in the trade's own unit. It travels
   * with that unit and neither is accepted without the other: "eight hundred
   * a day" is square feet, or linear feet, or cubic yards, and the three are
   * different jobs.
   */
  productionRatePerDay: MoneyString.nullable(),
  productionUnit: z.string().nullable(),
  /**
   * The kit this crew carries, as requirement codes. Matched against what the
   * work needs, and resolved against the company asset register for the real
   * label and for whether the machine can go out today.
   */
  requiredAssetIds: z.array(z.string()),
  skills: z.array(z.string()),
  color: z.string().nullable(),
  active: z.boolean(),
  members: z.array(CrewMember),
});

export const listCrews = defineRoute({
  method: "get",
  path: "/v1/crews",
  summary: "Every crew, with who is on it",
  description:
    "Narrowed like the dispatch board: somebody limited to a branch sees that branch's crews (a crew's own branch, not its members'), somebody limited to a shop the crews based there, and somebody limited to their own or their crew's work the crews they are on.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({}),
  output: z.object({ crews: z.array(Crew) }),
});

export const createCrew = defineRoute({
  method: "post",
  path: "/v1/crews",
  summary: "Define a crew",
  description:
    "A production rate without its unit is refused, and so is a unit without a rate. Half a rate reads as capacity on every screen and means nothing, which is worse than no rate at all because a blank invites somebody to fill it in. Somebody limited to a branch makes crews in their own branch only.",
  module: "M09",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(200),
    businessUnitId: Uuid.nullable().optional(),
    homeLocationId: Uuid.nullable().optional(),
    productionRatePerDay: MoneyString.nullable().optional(),
    productionUnit: z.string().max(50).nullable().optional(),
    /**
     * Requirement codes, compared by equality against what a job type
     * requires and resolved against `company_asset.requirement_code` for the
     * label and for whether any unit can go out. A code the register does
     * not know still matches; it simply says nothing about availability.
     */
    requiredAssetIds: z.array(z.string().max(200)).max(100).optional(),
    skills: z.array(z.string().max(100)).max(100).optional(),
    color: z.string().max(20).nullable().optional(),
  }),
  output: z.object({ id: Uuid, name: z.string(), active: z.boolean() }),
});

export const updateCrew = defineRoute({
  method: "patch",
  path: "/v1/crews/{id}",
  summary: "Change a crew's rate, kit or skills",
  description:
    "The rate and unit pair is checked against the result of the edit rather than against what was sent, so clearing the unit on a crew that has a rate is refused rather than leaving half a rate behind. Moving a crew to another branch is for somebody who sees the whole company. Another branch's crew reads as not found.",
  module: "M09",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    businessUnitId: Uuid.nullable().optional(),
    homeLocationId: Uuid.nullable().optional(),
    productionRatePerDay: MoneyString.nullable().optional(),
    productionUnit: z.string().max(50).nullable().optional(),
    requiredAssetIds: z.array(z.string().max(200)).max(100).optional(),
    skills: z.array(z.string().max(100)).max(100).optional(),
    color: z.string().max(20).nullable().optional(),
    active: z.boolean().optional(),
  }),
  output: z.object({ id: Uuid, name: z.string(), active: z.boolean() }),
});

export const setCrewMembers = defineRoute({
  method: "put",
  path: "/v1/crews/{id}/members",
  summary: "Who is on the crew",
  description:
    "The whole list in one call, because the gesture is 'these people, on this crew' and an add-only endpoint makes taking somebody off a second call that is easy to forget. At most one lead: two means nothing can say whether the person who answers for the job is on site. This write widens what those technicians can read, through the crew scope.",
  module: "M09",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    members: z.array(z.object({
      technicianId: Uuid,
      isLead: z.boolean().optional(),
    })).max(24),
  }),
  output: z.object({ id: Uuid, members: z.number().int(), leadSet: z.boolean() }),
});

export const CrewBlocker = z.enum([
  "crew_inactive", "no_members", "everybody_off", "lead_off",
  "missing_equipment", "equipment_unavailable", "missing_skills",
  "different_business_unit",
]);

export const CrewVerdict = z.object({
  crewId: Uuid,
  crewName: z.string(),
  jobId: Uuid,
  on: z.string().date(),
  canTake: z.boolean(),
  blockers: z.array(z.object({
    code: CrewBlocker,
    /** In words, for the person looking at the board. */
    explanation: z.string(),
  })),
  /** What the work needs and this crew does not carry. The actionable list. */
  missingEquipment: z.array(z.string()),
  /**
   * What the crew does carry and the asset register says cannot go out that
   * day. A separate list from the one above because they are different
   * conversations: missing kit is a question for whoever picks the crew, and
   * a chipper grounded by an expired inspection is a question for whoever
   * books the inspection.
   */
  unavailableEquipment: z.array(z.object({
    code: z.string(),
    assetId: Uuid,
    assetLabel: z.string(),
    reason: z.enum(["retired", "grounded"]),
    explanation: z.string(),
  })),
  missingSkills: z.array(z.string()),
  headcount: z.object({
    onCrew: z.number().int(),
    availableOn: z.number().int(),
    offOn: z.number().int(),
  }),
  leadDesignated: z.boolean(),
  /**
   * Where the equipment requirement came from. `none_declared` means the job
   * has no type, so an empty `missingEquipment` is a statement about an empty
   * list rather than a clearance for the crew.
   */
  equipmentBasis: z.enum(["job_type", "none_declared"]),
  /**
   * Which of the required codes the asset register has ever heard of. A code
   * with nothing behind it is still compared by equality against the crew's
   * kit, which is all that was possible before the register existed, but an
   * empty `unavailableEquipment` for it is a statement about an empty
   * register rather than about a working machine.
   */
  registeredEquipment: z.array(z.string()),
});

export const getCrewAvailability = defineRoute({
  method: "get",
  path: "/v1/crews/{id}/availability",
  summary: "Can this crew take this job, on this day",
  description:
    "Two questions and both must pass: the kit, which is a property of the crew and the work, and the people, which is a property of the day. Equipment is matched by requirement code against the company asset register, so a missing item is named with the label of the machine the company actually owns, and a crew carrying a code whose every unit is retired or grounded by an expired obligation is refused with the reason. A code the register does not know is compared by equality alone and makes no claim about availability.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({
    id: Uuid,
    jobId: Uuid,
    /** Defaults to today in the company's own timezone. */
    on: z.string().date().optional(),
  }),
  output: CrewVerdict,
});

export const listCrewsForJob = defineRoute({
  method: "get",
  path: "/v1/crews/for-job",
  summary: "Every crew, with its verdict, for one job",
  description:
    "The assignment screen. A crew that cannot take the job is listed with its reason rather than hidden, because 'the crew I wanted is not in the list' sends somebody hunting through settings for a crew that is sitting there missing a chipper.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({ jobId: Uuid, on: z.string().date().optional() }),
  output: z.object({
    jobId: Uuid,
    on: z.string().date(),
    crews: z.array(CrewVerdict),
  }),
});

export const assignCrewToVisit = defineRoute({
  method: "post",
  path: "/v1/visits/{id}/crew",
  summary: "Put a crew on a visit",
  description:
    "Refused when the crew cannot take the job on the day the visit is, which is the point: creating a visit with a crewId already works and checks nothing, so a tree job can be put on a crew with no chipper today. Separate from assigning technicians, which writes a different table and is untouched.",
  module: "M09",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: z.object({ id: Uuid, crewId: Uuid }),
  output: z.object({
    id: Uuid, crewId: Uuid, status: z.string(), on: z.string().date(),
  }),
});

/* ----------------------------------------------------------------- routes */

export const ServiceRoute = z.object({
  id: Uuid,
  name: z.string(),
  /** 0 is Sunday, matching JS getDay(). */
  dayOfWeek: z.number().int().nullable(),
  dayName: z.string().nullable(),
  technicianId: Uuid.nullable(),
  crewId: Uuid.nullable(),
  territoryId: Uuid.nullable(),
  targetStopCount: z.number().int().nullable(),
  startsAt: z.string().nullable(),
  /** The operator's declared drive time between consecutive stops. */
  travelMinutesBetweenStops: z.number().int().nullable(),
  stopCount: z.number().int(),
  active: z.boolean(),
});

export const listServiceRoutes = defineRoute({
  method: "get",
  path: "/v1/service-routes",
  summary: "Every route, by weekday",
  module: "M09",
  permissions: ["job:read"],
  input: z.object({}),
  output: z.object({ routes: z.array(ServiceRoute) }),
});

export const createServiceRoute = defineRoute({
  method: "post",
  path: "/v1/service-routes",
  summary: "Define a route",
  description:
    "Exactly one servicer, a technician or a crew. With neither, the visits it creates land on the board looking exactly like work nobody has got to yet; with both, every question about the day has two answers.",
  module: "M09",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(200),
    dayOfWeek: z.number().int().min(0).max(6),
    technicianId: Uuid.nullable().optional(),
    crewId: Uuid.nullable().optional(),
    territoryId: Uuid.nullable().optional(),
    targetStopCount: z.number().int().min(1).max(200).nullable().optional(),
    /** Local time the servicer starts, "HH:MM". */
    startsAt: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
    /**
     * Declared by the operator because there is no geocoding here. Left
     * unset, density reports a floor and says so rather than treating the
     * drive as zero.
     */
    travelMinutesBetweenStops: z.number().int().min(0).max(480).nullable().optional(),
    color: z.string().max(20).nullable().optional(),
  }),
  output: z.object({ id: Uuid, name: z.string(), dayOfWeek: z.number().int().nullable() }),
});

export const RouteStop = z.object({
  id: Uuid,
  propertyId: Uuid,
  addressLine1: z.string(),
  sequence: z.number().int(),
  estimatedMinutes: z.number().int(),
  /** Days between visits, counted from the last one ACTUALLY serviced. */
  intervalDays: z.number().int().nullable(),
  lastServicedOn: z.string().date().nullable(),
  nextDueOn: z.string().date().nullable(),
  /** Route margin is measured per stop, not per job. */
  pricePerStop: MoneyString.nullable(),
  active: z.boolean(),
});

export const listServiceRouteStops = defineRoute({
  method: "get",
  path: "/v1/service-routes/{id}/stops",
  summary: "The stops, in the order they are driven",
  module: "M09",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: z.object({ stops: z.array(RouteStop) }),
});

export const addServiceRouteStop = defineRoute({
  method: "post",
  path: "/v1/service-routes/{id}/stops",
  summary: "Add a stop to the end of a route",
  description:
    "One stop per property per route. The same address twice is a double booking written into the template: every materialisation forever produces the pair, and the customer sees two vans or gets billed twice at a price per stop. The sequence is allocated here rather than accepted, so there is no way to create two stops numbered four.",
  module: "M09",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    propertyId: Uuid,
    estimatedMinutes: z.number().int().min(1).max(1440).optional(),
    intervalDays: z.number().int().min(1).max(3650).nullable().optional(),
    pricePerStop: MoneyString.nullable().optional(),
    /** The first date this stop is due. Left unset it is due whenever the route runs. */
    firstDueOn: z.string().date().nullable().optional(),
  }),
  output: z.object({ id: Uuid, sequence: z.number().int(), estimatedMinutes: z.number().int() }),
});

export const reorderServiceRouteStops = defineRoute({
  method: "post",
  path: "/v1/service-routes/{id}/order",
  summary: "Set the order of the whole route",
  description:
    "Every active stop has to be in the list. A partial order renumbers the stops it names and leaves the rest, which produces two stops sharing a number and a driver going back across the territory for one of them.",
  module: "M09",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, stopIds: z.array(Uuid).max(200) }),
  output: z.object({ id: Uuid, ordered: z.number().int() }),
});

export const setServiceRouteStopActive = defineRoute({
  method: "post",
  path: "/v1/service-routes/stops/{id}/active",
  summary: "Take a stop off the route, or put it back",
  module: "M09",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, active: z.boolean() }),
  output: z.object({ id: Uuid, active: z.boolean() }),
});

export const recordServiceRouteStopServiced = defineRoute({
  method: "post",
  path: "/v1/service-routes/stops/{id}/serviced",
  summary: "The technician was really there",
  description:
    "The load bearing call for a cadence anchored to completion: a fortnightly stop is fourteen days from when it was actually serviced, so a rain day moves the series along instead of losing a visit out of the month. A backdated completion is refused, because it would pull every future visit backwards.",
  module: "M09",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, servicedOn: z.string().date() }),
  output: z.object({
    id: Uuid,
    lastServicedOn: z.string().date(),
    nextDueOn: z.string().date().nullable(),
  }),
});

export const materialiseServiceRoute = defineRoute({
  method: "post",
  path: "/v1/service-routes/{id}/materialise",
  summary: "Turn the route into a day's work",
  description:
    "Idempotent by construction, the same way recurring schedules are: each job carries its stop and date as its source reference, and a stop that already has one is counted rather than created again. A timer running twice in a minute would otherwise put two technicians on one pool. Refused on the wrong weekday, because materialising the Tuesday route onto a Thursday is a mistyped date and the only way back is deleting forty jobs by hand.",
  module: "M09",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, date: z.string().date() }),
  output: z.object({
    routeId: Uuid,
    date: z.string().date(),
    created: z.array(z.object({
      stopId: Uuid, jobId: Uuid, visitId: Uuid, propertyId: Uuid, sequence: z.number().int(),
    })),
    /** Stops that already had work for this date. Not an error on a timer. */
    alreadyThere: z.number().int(),
    /** Stops whose own cadence does not fall on this date. */
    notDue: z.array(z.object({ stopId: Uuid, dueOn: z.string().date() })),
  }),
});

export const getServiceRouteDensity = defineRoute({
  method: "get",
  path: "/v1/service-routes/{id}/density",
  summary: "Will this day fit",
  description:
    "Density is the whole economics of a route business: revenue is stops times price per stop and cost is the driver's day. The drive is the figure the operator declared between stops when there is one; otherwise, with a routing service connected, the drive by road between the stops in order and out from where the day starts and back, counting only legs the service answered; otherwise none. Whenever some of the drive is unknown the total is reported as a floor and says so (`travelComplete`), rather than claiming a fifteen stop day fits, and never with a straight line guess. The overtime threshold comes from the overtime policy's daily figure or from declared business hours, and with neither the answer is null rather than a guess.",
  module: "M09",
  permissions: ["job:read"],
  input: z.object({
    id: Uuid,
    /** Asks the question as it is really asked: what if I add this customer. */
    addingStopOfMinutes: z.number().int().min(0).max(1440).optional(),
  }),
  output: z.object({
    routeId: Uuid,
    routeName: z.string(),
    dayOfWeek: z.number().int().nullable(),
    stopCount: z.number().int(),
    targetStopCount: z.number().int().nullable(),
    overTarget: z.boolean().nullable(),
    serviceMinutes: z.number().int(),
    /** Null, never zero, when there is no drive time to give: none declared and no road network to ask. */
    travelMinutes: z.number().int().nullable(),
    totalMinutes: z.number().int(),
    /** True only when the route's own declared drive time was used. */
    travelDeclared: z.boolean(),
    /** `declared` from the route, `road` from the routing service, `none` when neither. */
    travelSource: z.enum(["declared", "road", "none"]),
    /** Whether every leg of the drive is in the total. When false, the total is a floor. */
    travelComplete: z.boolean(),
    /** Where the drive came from and what it leaves out, in a sentence. */
    travelNote: z.string(),
    overtimeAfterMinutes: z.number().int().nullable(),
    dayBasis: z.enum(["overtime_policy", "business_hours", "unknown"]),
    minutesOverThreshold: z.number().int().nullable(),
    /** Null is a real answer: it means nobody has declared enough to say. */
    runsIntoOvertime: z.boolean().nullable(),
    explanation: z.string(),
  }),
});

/* ---------------------------------------------------------------- on call */

export const OnCallShift = z.object({
  id: Uuid,
  technicianId: Uuid,
  technicianName: z.string(),
  /** Null means the whole company. */
  businessUnitId: Uuid.nullable(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  rateMultiplier: RateString.nullable(),
});

export const getOnCallNow = defineRoute({
  method: "get",
  path: "/v1/on-call",
  summary: "Who is on call",
  description:
    "Half open, so a handover at six is one person until six and the next from six: any other reading makes that instant belong to both or to neither, and neither is the one that drops a call. Nobody on call comes back as null with a sentence saying so, because a blank where a name should be reads as fine.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({
    at: z.string().datetime().optional(),
    businessUnitId: Uuid.nullable().optional(),
  }),
  output: z.object({
    at: z.string().datetime(),
    onCall: OnCallShift.nullable(),
    explanation: z.string().nullable(),
  }),
});

export const listOnCallRotations = defineRoute({
  method: "get",
  path: "/v1/on-call/rotations",
  summary: "The rota",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
  output: z.object({ shifts: z.array(OnCallShift) }),
});

export const scheduleOnCall = defineRoute({
  method: "post",
  path: "/v1/on-call/rotations",
  summary: "Put somebody on call",
  description:
    "An overlapping window is refused rather than resolved by precedence, because two rows covering one instant means two people each believing the other has the phone, and it is discovered at two in the morning by a customer. A null business unit is company wide and so collides with everything in its window. Setting a rate multiplier additionally requires payroll:configure, because declaring what a night pays is a statement about what somebody is owed.",
  module: "M09",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: z.object({
    technicianId: Uuid,
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    businessUnitId: Uuid.nullable().optional(),
    rateMultiplier: RateString.nullable().optional(),
  }),
  output: z.object({
    id: Uuid,
    technicianId: Uuid,
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  }),
});

export const fillOnCallWeeks = defineRoute({
  method: "post",
  path: "/v1/on-call/weeks",
  summary: "Fill the on call rota a week at a time",
  description:
    "The people listed take a week each, in turn, from firstDay, the phone changing hands at handoverAt on the company's own clock every week, including the weeks the clocks change. Every week goes through the same overlap refusal a single shift does, all in one go, so a rota that collides with somebody already on adds nothing at all and the refusal names the week. A handover at a time the clocks skip is refused.",
  module: "M09",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: z.object({
    technicianIds: z.array(Uuid).min(1).max(20),
    /** The first handover day, YYYY-MM-DD, in the company's zone. */
    firstDay: z.string().date(),
    /** The time of day the phone changes hands, as HH:MM. */
    handoverAt: z.string().regex(/^\d{1,2}:\d{2}$/),
    weeks: z.number().int().min(1).max(52),
    businessUnitId: Uuid.nullable().optional(),
  }),
  output: z.object({
    shifts: z.array(z.object({
      id: Uuid, technicianId: Uuid, startsAt: z.string().datetime(), endsAt: z.string().datetime(),
    })),
  }),
});

export const handOverOnCall = defineRoute({
  method: "post",
  path: "/v1/on-call/handover",
  summary: "Hand the phone over",
  description:
    "Not an edit of who is on call. The shift already worked stays on the record ending when it really ended and a new one starts there, because an update in place would rewrite the night so the person who took the calls until midnight was never on: wrong on the rota, wrong on an overtime run, and wrong in the one conversation where it matters.",
  module: "M09",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: z.object({
    toTechnicianId: Uuid,
    /** Defaults to now. Refused on either boundary of the shift. */
    at: z.string().datetime().optional(),
    businessUnitId: Uuid.nullable().optional(),
  }),
  output: z.object({
    handedOverAt: z.string().datetime(),
    from: z.object({ id: Uuid, technicianId: Uuid, endsAt: z.string().datetime() }),
    to: z.object({ id: Uuid, technicianId: Uuid, endsAt: z.string().datetime() }),
  }),
});

export const crewRoutes = {
  listCrews, createCrew, updateCrew, setCrewMembers,
  getCrewAvailability, listCrewsForJob, assignCrewToVisit,
  listServiceRoutes, createServiceRoute, listServiceRouteStops,
  addServiceRouteStop, reorderServiceRouteStops, setServiceRouteStopActive,
  recordServiceRouteStopServiced, materialiseServiceRoute, getServiceRouteDensity,
  getOnCallNow, listOnCallRotations, scheduleOnCall, fillOnCallWeeks, handOverOnCall,
} as const;
