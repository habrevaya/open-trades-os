import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { QuantityString, StockUnitInput } from "./inventory";

/**
 * SERIALS, LOTS AND TRUCK STOCK
 *
 * The moves themselves are the ordinary stock routes, which take `units` for
 * a tracked item. These are the routes around them: which items are tracked,
 * finding a serial and tracing it from the order it arrived on to the
 * customer's equipment it became, writing off a unit that has gone, and what
 * each truck should carry with what to fill it from.
 */

const Mode = z.enum(["serial", "lot"]);

export const setStockTracking = defineRoute({
  method: "put",
  path: "/v1/stock-tracking",
  summary: "Track an item by serial number or lot, or stop",
  description:
    "From then on every receipt, transfer and issue of the item names its units. Refused while units with no numbers are on hand, because every move of a tracked item has to say which units and those could never be used; start tracking before the next delivery. `mode: null` stops tracking, and the numbers already recorded stay on their movements as history.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({ itemId: Uuid, mode: Mode.nullable() }),
  output: z.object({
    itemId: Uuid,
    mode: Mode.nullable(),
    /** Units on hand with no number yet, per place. Give them numbers with `POST /v1/stock/numbering` before they can move. */
    unnumbered: z.array(z.object({ locationId: Uuid, locationName: z.string(), quantity: QuantityString })),
  }),
});

export const numberStockUnits = defineRoute({
  method: "post",
  path: "/v1/stock/numbering",
  summary: "Give numbers to units already on hand",
  description:
    "A count by number for one location: every label read off the shelf. Each new number takes one unit that had none (a lot takes the quantity said); a number already on this shelf is counted again and changes nothing. Nothing moves and nothing is bought, so the level and its value stay as they were. Refused: a number already in stock elsewhere, used on a job or gone, a number read twice, and more new numbers than units without one, because those extra units were never received.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    locationId: Uuid,
    units: z.array(StockUnitInput.pick({ number: true, quantity: true, expiresOn: true })).min(1).max(500),
  }),
  output: z.object({
    numbered: z.array(z.string()),
    alreadyHere: z.array(z.string()),
    /** Units at this place still without a number. */
    stillUnnumbered: QuantityString,
  }),
});

export const returnStockFromJob = defineRoute({
  method: "post",
  path: "/v1/stock/returns",
  summary: "Take a serialised unit back off a job",
  description:
    "By its serial number, onto the shelf named. It comes back at the cost it left at, late freight included, as the same receipt's part, and comes off the job's material cost. The ledger reverses what the use posted: using stock posts nothing in this product except late freight a bill put on it, and that comes off the job and back into stock. The customer's equipment record it became stays on their register, its link to the serial cleared, and the answer names it so the office can retire it if the unit came out.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    locationId: Uuid,
    numbers: z.array(z.string().min(1).max(100)).min(1).max(100),
    note: z.string().max(200).nullable().optional(),
  }),
  output: z.object({
    returned: z.array(z.object({ number: z.string(), jobId: Uuid.nullable(), jobNumber: z.number().int().nullable() })),
    equipmentStillOnRecord: z.array(z.object({ number: z.string(), equipmentId: Uuid })),
  }),
});

export const listTrackedItems = defineRoute({
  method: "get",
  path: "/v1/stock-tracking",
  summary: "Items tracked by serial or lot",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({}),
  output: z.object({
    items: z.array(z.object({ itemId: Uuid, itemCode: z.string(), itemName: z.string(), mode: Mode })),
  }),
});

const UnitView = z.object({
  id: Uuid,
  itemId: Uuid,
  itemCode: z.string(),
  itemName: z.string(),
  mode: Mode,
  number: z.string(),
  expiresOn: z.string().nullable(),
  /** Folded from the movements that name it, never stored. */
  state: z.enum(["in_stock", "used", "gone"]),
  where: z.array(z.object({ locationId: Uuid, locationName: z.string(), quantity: QuantityString })),
  jobId: Uuid.nullable(),
  jobNumber: z.number().int().nullable(),
  equipmentId: Uuid.nullable(),
});

const UnitTrace = z.object({
  unit: UnitView,
  steps: z.array(z.object({
    at: z.string().datetime(),
    kind: z.string(),
    label: z.string(),
    quantity: QuantityString,
    locationName: z.string(),
    jobId: Uuid.nullable(),
    jobNumber: z.number().int().nullable(),
    purchaseOrderId: Uuid.nullable(),
    purchaseOrderNumber: z.number().int().nullable(),
    vendorName: z.string().nullable(),
    cost: z.string().nullable(),
  })),
  equipment: z.object({
    id: Uuid,
    category: z.string(),
    tag: z.string().nullable(),
    manufacturer: z.string().nullable(),
    model: z.string().nullable(),
    serialNumber: z.string().nullable(),
    propertyId: Uuid,
    address: z.string(),
    customerId: Uuid.nullable(),
    customerName: z.string().nullable(),
  }).nullable(),
});

export const listStockUnits = defineRoute({
  method: "get",
  path: "/v1/stock/units",
  summary: "Find serials and lots",
  description: "By item, by where they are, or by number. A number matches anywhere in it, because a label read off a unit in a dark basement is often half a number.",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({
    itemId: Uuid.optional(),
    locationId: Uuid.optional(),
    number: z.string().max(100).optional(),
    inStockOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  }),
  output: z.object({ units: z.array(UnitView) }),
});

export const traceStockUnit = defineRoute({
  method: "get",
  path: "/v1/stock/units/{id}",
  summary: "Trace one serial or lot",
  description:
    "Everything that happened to it, oldest first: the order and vendor it arrived from, each move between the warehouse and a truck, the job it went to, and the customer's equipment record it became. Cost only to a holder of `pricebook.cost:read`; the equipment and the customer only to whoever may read those.",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({ id: Uuid }),
  output: UnitTrace,
});

export const traceEquipmentStock = defineRoute({
  method: "get",
  path: "/v1/equipment/{id}/stock-trace",
  summary: "Where a customer's unit came from, when it came from our stock",
  description: "Each serial of ours issued to a job as this equipment record, with its whole trace: the order and vendor it arrived from, each move between the warehouse and a truck, and the job. Empty for a unit that was not installed from stock. Cost only to a holder of `pricebook.cost:read`.",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({ id: Uuid }),
  output: z.object({ units: z.array(UnitTrace) }),
});

export const writeOffStockUnits = defineRoute({
  method: "post",
  path: "/v1/stock/write-offs",
  summary: "Write off serials or lots that have gone",
  description: "Damaged, lost, taken from a truck: an adjustment by number with the reason, which is the only way a tracked item's count comes down without a job.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    locationId: Uuid,
    reason: z.string().min(1).max(200),
    units: z.array(StockUnitInput.pick({ number: true, quantity: true })).min(1).max(500),
  }),
  output: z.object({ written: z.number().int() }),
});

export const listStockLocations = defineRoute({
  method: "get",
  path: "/v1/stock/locations",
  summary: "Where stock can be",
  description: "Warehouses and trucks, for a client that moves stock. Under `inventory:read` rather than the settings read, so a technician who may see their van may see where it can go.",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({}),
  output: z.object({ locations: z.array(z.object({ id: Uuid, name: z.string(), isWarehouse: z.boolean() })) }),
});

const TruckMinimum = z.object({
  id: Uuid, itemId: Uuid, itemName: z.string(), locationId: Uuid, locationName: z.string(),
  minimum: QuantityString, target: QuantityString,
});

export const listTruckMinimums = defineRoute({
  method: "get",
  path: "/v1/truck-minimums",
  summary: "What each truck should carry",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({}),
  output: z.object({ minimums: z.array(TruckMinimum) }),
});

export const setTruckMinimum = defineRoute({
  method: "put",
  path: "/v1/truck-minimums",
  summary: "Set a truck's minimum and fill level for an item",
  description: "At or under the minimum, the truck is filled from the warehouse up to the target. Refused at a warehouse, which is bought for with a reorder point instead.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({ itemId: Uuid, locationId: Uuid, minimum: QuantityString, target: QuantityString }),
  output: z.object({ id: Uuid, itemId: Uuid, locationId: Uuid, minimum: QuantityString, target: QuantityString }),
});

export const clearTruckMinimum = defineRoute({
  method: "post",
  path: "/v1/truck-minimums/{id}/clear",
  summary: "Stop keeping an item on a truck",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, cleared: z.boolean() }),
});

export const listRestockSuggestions = defineRoute({
  method: "get",
  path: "/v1/stock/restock-suggestions",
  summary: "Which trucks to fill, and from where",
  description:
    "Every truck at or under its minimum for an item, compared against what it can promise (on hand less reserved), with the warehouse holding the most to fill it from and how short the warehouse is when it cannot. A transfer, never a purchase: buying is the warehouse reorder point's decision.",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({}),
  output: z.object({
    suggestions: z.array(z.object({
      itemId: Uuid, itemName: z.string(), truckId: Uuid, truckName: z.string(),
      onTruck: QuantityString, minimum: QuantityString, target: QuantityString, wanted: QuantityString,
      fromLocationId: Uuid.nullable(), fromLocationName: z.string().nullable(),
      take: QuantityString, short: QuantityString,
      tracking: Mode.nullable(),
      why: z.string(),
    })),
  }),
});

export const restockTruck = defineRoute({
  method: "post",
  path: "/v1/stock/restocks",
  summary: "Fill a truck from a warehouse",
  description: "The transfer a suggestion proposes, through the one transfer path, so reservations on the shelf and a tracked item's units are checked exactly as for any transfer.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid, truckId: Uuid, fromLocationId: Uuid, quantity: QuantityString,
    units: z.array(StockUnitInput.pick({ number: true, quantity: true })).max(500).optional(),
  }),
  output: z.object({ moved: QuantityString, movements: z.number().int() }),
});

export const stockTrackingRoutes = {
  setStockTracking, numberStockUnits, returnStockFromJob, traceEquipmentStock,
  listTrackedItems, listStockUnits, traceStockUnit, writeOffStockUnits,
  listStockLocations, listTruckMinimums, setTruckMinimum, clearTruckMinimum,
  listRestockSuggestions, restockTruck,
} as const;
