import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/** A calendar date, the way every other contract here spells one. */
const IsoDate = z.string().date();

/**
 * THE EQUIPMENT REGISTER, ON THE API
 *
 * `services/equipment.ts` had a screen and no routes, which is the one place in
 * this product where that was true in that direction, and it breaks BUILD.md's
 * third ordering rule: the web app consumes the same surface a third party gets,
 * and every embed, agent and integration depends on that being true from the
 * start rather than retrofitted.
 *
 * What it cost specifically. A migration from another system can load customers,
 * properties, jobs, invoices and payments and cannot load the equipment at an
 * address, which for a service trade is the record the next ten years of work
 * hangs off. The MCP server offers no tool for "what is at this address", which
 * is the first question any agent would ask. And the warranty watch, which is the
 * one list in the module that is worth a daily look, could only be read by
 * opening a property at a time.
 *
 * WARRANTY IS DERIVED AND THE OUTPUT SAYS SO. Parts and labour are separate
 * answers because they expire separately, and a single "under warranty" is how
 * somebody quotes a free repair whose labour is not covered. `daysUntilSoonest`
 * goes negative once past, so one number sorts a worklist in both directions.
 */

export const MoveReason = z.enum([
  "relocated", "swapped_under_warranty", "replaced", "removed", "returned",
]);

export const EquipmentWarranty = z.object({
  partsExpiresOn: IsoDate.nullable(),
  labourExpiresOn: IsoDate.nullable(),
  partsCovered: z.boolean(),
  labourCovered: z.boolean(),
  soonestExpiry: IsoDate.nullable(),
  /** Negative once past, so one number sorts a worklist in both directions. */
  daysUntilSoonest: z.number().nullable(),
});

const EquipmentFields = {
  id: Uuid,
  propertyId: Uuid,
  parentEquipmentId: Uuid.nullable(),
  tag: z.string().nullable(),
  category: z.string(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  serialNumber: z.string().nullable(),
  installedOn: IsoDate.nullable(),
  installedByUs: z.boolean(),
  location: z.string().nullable(),
  attributes: z.record(z.unknown()),
  /** The company's own fields (M29), by key. Saved with `PUT .../custom-fields`. */
  customFields: z.record(z.unknown()).optional(),
  active: z.boolean(),
  retired: z.boolean(),
  /** Whole years, floor. Nobody says a furnace is eleven and a half. */
  ageYears: z.number().nullable(),
  warranty: EquipmentWarranty,
};

/**
 * The register at one address, FLAT, IN TREE ORDER, WITH A DEPTH.
 *
 * Units nest: a riser has valves and a rooftop unit has a compressor. The screen
 * gets that back as an actual tree from the service, and the API deliberately
 * does not.
 *
 * Two reasons, and the second is the one that decided it. A recursive Zod schema
 * is a `z.lazy`, and the OpenAPI generator cannot describe one, so publishing a
 * tree here means publishing a document that does not say what the response
 * looks like. And a flat list in pre-order with a depth is what a client wants
 * anyway: it renders the indentation straight off `depth` with no tree building,
 * and it can ignore the nesting entirely by ignoring one field.
 *
 * The work the tree does is already done by the time it is flattened. The server
 * caps the depth and surfaces a unit caught in a cycle at the top with its
 * parent link intact, so a client never has to discover a cycle: a unit nobody
 * can see is worse than one in the wrong place, and the link is what somebody
 * needs to fix it.
 */
export const EquipmentView = z.object({
  ...EquipmentFields,
  /** 0 for a unit at the top. The parent is the nearest earlier row below it. */
  depth: z.number().int().min(0),
});

export const EquipmentMove = z.object({
  id: Uuid,
  reason: MoveReason,
  movedOn: IsoDate,
  fromPropertyId: Uuid.nullable(),
  toPropertyId: Uuid.nullable(),
  notes: z.string().nullable(),
});

export const listEquipment = defineRoute({
  method: "get",
  path: "/v1/equipment",
  summary: "The equipment at one address",
  description:
    "Nested, because units nest: a riser has valves and a rooftop unit has a compressor. Retired units are left out. `on` asks the warranty question as of a day other than today, which is how a report run for a month end answers what was covered then rather than what is covered now.",
  module: "M04",
  permissions: ["equipment:read"],
  input: z.object({ propertyId: Uuid, on: IsoDate.optional() }),
  output: z.object({ equipment: z.array(EquipmentView) }),
});

export const getEquipment = defineRoute({
  method: "get",
  path: "/v1/equipment/{id}",
  summary: "One unit, with where it has been",
  description:
    "Includes a retired unit, because the jobs that named it still resolve to it and somebody reading one of those needs the row. The moves are newest first: a landlord moving a water heater between two rentals, or a warranty swap, is why the row survives rather than being replaced.",
  module: "M04",
  permissions: ["equipment:read"],
  input: z.object({ id: Uuid, on: IsoDate.optional() }),
  output: z.object({
    ...EquipmentFields,
    moves: z.array(EquipmentMove),
    /** Where it is now, in words. */
    address: z.string(),
    /** Who to ask about it: the customer linked to that address now. */
    customer: z.object({ id: Uuid, name: z.string() }).nullable(),
    /** What it is nested in, and what is nested in it, one level each way. */
    parent: z.object({ id: Uuid, tag: z.string().nullable(), category: z.string() }).nullable(),
    children: z.array(z.object({ id: Uuid, tag: z.string().nullable(), category: z.string() })),
  }),
});

export const getEquipmentHistory = defineRoute({
  method: "get",
  path: "/v1/equipment/{id}/history",
  summary: "What we have done to this unit",
  description:
    "From the jobs that named it, the visits that recorded an outcome against it and the deficiencies raised on it, rather than from a log nobody writes. A job about one rooftop unit can carry readings for eight, which is why the visit side is separate from the job side.",
  module: "M04",
  permissions: ["equipment:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    jobs: z.array(z.object({
      id: Uuid,
      number: z.number(),
      summary: z.string(),
      status: z.string(),
      completedAt: z.string().nullable(),
      createdAt: z.string(),
    })),
    inspected: z.array(z.object({
      visitId: Uuid,
      outcome: z.string().nullable(),
      notes: z.string().nullable(),
      completedAt: z.string().nullable(),
      jobId: Uuid,
    })),
    deficiencies: z.array(z.object({
      id: Uuid,
      status: z.string(),
      severity: z.string(),
      code: z.string().nullable(),
      createdAt: z.string(),
    })),
    /** Readings the service reports took on this unit, newest first. */
    readings: z.array(z.object({
      id: Uuid,
      key: z.string(),
      label: z.string(),
      valueNumeric: z.string().nullable(),
      valueText: z.string().nullable(),
      valueBoolean: z.boolean().nullable(),
      unit: z.string().nullable(),
      outOfRange: z.boolean(),
      recordedAt: z.string(),
      visitId: Uuid,
    })),
    /** Inspections with a checkpoint answered against this unit. */
    inspections: z.array(z.object({
      id: Uuid,
      performedOn: z.string().nullable(),
      result: z.string().nullable(),
      programme: z.string().nullable(),
      visitId: Uuid.nullable(),
      jobId: Uuid.nullable(),
    })),
    /** Photographs of it: from checkpoints about it, faults found on it, and files kept against it. */
    photos: z.array(z.object({
      storageKey: z.string(),
      contentType: z.string().nullable(),
      at: z.string(),
    })),
  }),
});

export const getWarrantyWatch = defineRoute({
  method: "get",
  /**
   * FLAT, AND NOT `/v1/equipment/warranty-watch`.
   *
   * That was the first spelling and `http.test.ts` refused it: a literal segment
   * at the same depth as `/v1/equipment/{id}` is ambiguous, because a request for
   * `/v1/equipment/warranty-watch` matches both and which one wins depends on
   * the order the registry happens to be iterated in. The guard is right to
   * refuse rather than pick, and the honest fix is a path that is not under the
   * unit read at all.
   */
  path: "/v1/equipment-warranties",
  summary: "Warranties running out, and ones that just have",
  description:
    "The window looks BACK as well as forward, because a warranty that lapsed last month is the call worth making and a list that only looks forward stops mentioning a unit at the exact moment it becomes interesting. Sorted by the soonest expiry, with the address on each row.",
  module: "M04",
  permissions: ["equipment:read"],
  input: z.object({
    withinDays: z.number().int().min(1).max(730).optional(),
    on: IsoDate.optional(),
    /** Any window, by its two dates, instead of `withinDays` either side of today. */
    from: IsoDate.optional(),
    to: IsoDate.optional(),
  }),
  output: z.object({
    units: z.array(z.object({
      ...EquipmentFields,
      address: z.string(),
      /**
       * Who to ring: the customer linked to the address now, primary first and
       * owners before tenants. Null for an address nobody is linked to.
       */
      customer: z.object({ id: Uuid, name: z.string() }).nullable(),
    })),
  }),
});

export const registerEquipment = defineRoute({
  method: "post",
  path: "/v1/equipment",
  summary: "Add a unit to the register",
  description:
    "The serial number is the identity when there is one: it is the only identifier that survives a customer moving out and the next owner calling, and matching on anything softer produces a second record for the same furnace and splits ten years of history down the middle. A unit with no serial is still recorded, because a technician in a crawl space often has a model number and nothing else.",
  module: "M04",
  permissions: ["equipment:write"],
  idempotent: true,
  input: z.object({
    propertyId: Uuid,
    category: z.string().min(1).max(60),
    tag: z.string().max(60).nullish(),
    manufacturer: z.string().max(120).nullish(),
    model: z.string().max(120).nullish(),
    serialNumber: z.string().max(120).nullish(),
    installedOn: IsoDate.nullish(),
    installedByUs: z.boolean().optional(),
    warrantyPartsExpiresOn: IsoDate.nullish(),
    warrantyLaborExpiresOn: IsoDate.nullish(),
    location: z.string().max(200).nullish(),
    parentEquipmentId: Uuid.nullish(),
    attributes: z.record(z.unknown()).optional(),
    /**
     * The caller has seen that the serial is on file elsewhere in the company
     * (`GET /v1/equipment-serial-matches`) and says this is a different unit.
     * Without it, a serial on file anywhere is refused, naming where.
     */
    serialElsewhereConfirmed: z.boolean().optional(),
  }),
  output: z.object({ id: Uuid }),
});

export const listEquipmentSerialMatches = defineRoute({
  method: "get",
  /** Flat, for the reason `/v1/equipment-warranties` is: a literal beside `/v1/equipment/{id}` is ambiguous. */
  path: "/v1/equipment-serial-matches",
  summary: "Units already on file with this serial",
  description:
    "Every unit in the company whose serial has the same letters and digits, ignoring case, spaces and dashes, at any address and including ones taken off a register, with the customer linked to each address. Asked before adding a unit, so a furnace that moved with a landlord or came back from a warranty swap is moved rather than added a second time with half its history.",
  module: "M04",
  permissions: ["equipment:read"],
  input: z.object({ serialNumber: z.string().min(1).max(120), excludeId: Uuid.optional() }),
  output: z.object({
    matches: z.array(z.object({
      id: Uuid,
      propertyId: Uuid,
      address: z.string(),
      category: z.string(),
      tag: z.string().nullable(),
      manufacturer: z.string().nullable(),
      model: z.string().nullable(),
      serialNumber: z.string(),
      retired: z.boolean(),
      customer: z.object({ id: Uuid, name: z.string() }).nullable(),
    })),
  }),
});

export const updateEquipment = defineRoute({
  method: "patch",
  path: "/v1/equipment/{id}",
  summary: "Correct a unit",
  description:
    "Not a way to move one. Changing the property is refused here and is its own call, because the move record is the only thing that says where work happened before today, and letting an edit change the address means an invoice from 2024 describes a job at an address the unit has never been to.",
  module: "M04",
  permissions: ["equipment:write"],
  input: z.object({
    id: Uuid,
    category: z.string().min(1).max(60).optional(),
    tag: z.string().max(60).nullish(),
    manufacturer: z.string().max(120).nullish(),
    model: z.string().max(120).nullish(),
    serialNumber: z.string().max(120).nullish(),
    installedOn: IsoDate.nullish(),
    installedByUs: z.boolean().optional(),
    warrantyPartsExpiresOn: IsoDate.nullish(),
    warrantyLaborExpiresOn: IsoDate.nullish(),
    location: z.string().max(200).nullish(),
    parentEquipmentId: Uuid.nullish(),
    attributes: z.record(z.unknown()).optional(),
  }),
  output: z.object({ id: Uuid }),
});

export const moveEquipment = defineRoute({
  method: "post",
  path: "/v1/equipment/{id}/move",
  summary: "Record that a unit went somewhere",
  description:
    "The unit keeps its row. Without this, a landlord moving a water heater between two rentals or a warranty swap produced either a new record with no history or an edit that silently rewrote where the old work happened. A reason that means it went somewhere (relocated, swapped under warranty, returned) is refused without a destination.",
  module: "M04",
  permissions: ["equipment:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    reason: MoveReason,
    toPropertyId: Uuid.nullish(),
    movedOn: IsoDate.optional(),
    jobId: Uuid.nullish(),
    notes: z.string().max(2000).nullish(),
  }),
  output: z.object({
    id: Uuid,
    reason: MoveReason,
    movedOn: IsoDate,
    /** Includes the children that went with it, so a caller can say how many. */
    unitsMoved: z.number().int(),
  }),
});

export const retireEquipment = defineRoute({
  method: "post",
  path: "/v1/equipment/{id}/retire",
  summary: "Take a unit out of service",
  description:
    "A soft delete, so every job that named it still resolves. The reason is required and is not bookkeeping: it is what the next technician reads when they find the unit still bolted to the wall.",
  module: "M04",
  permissions: ["equipment:write"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().min(1).max(500), on: IsoDate.optional() }),
  output: z.object({
    id: Uuid, retired: z.literal(true), on: IsoDate, reason: z.string(),
  }),
});

export const equipmentRoutes = {
  listEquipment, getEquipment, getEquipmentHistory, getWarrantyWatch, listEquipmentSerialMatches,
  registerEquipment, updateEquipment, moveEquipment, retireEquipment,
} as const;
