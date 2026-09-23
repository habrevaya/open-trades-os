import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * STOCK, AND WHY IT IS AN API RATHER THAN A SCREEN
 *
 * Inventory and purchasing were built with services and screens and no
 * contracts, which made them unreachable from the HTTP API and therefore
 * from the MCP server. That is the wrong shape for this product in
 * particular: a contractor running a warehouse already has a scanner, a
 * spreadsheet and a supplier feed, and the thing they want is to point all
 * three at their own data. A capability that exists only behind a form is a
 * capability an integration routes around, usually by writing to the
 * database directly, which is how the history stops explaining the numbers.
 *
 * QUANTITY IS A STRING HERE. It is stored as a scaled integer and rendered
 * as a decimal string, and it never becomes a JSON number on the way past: a
 * float cannot hold a third of a spool, and the rounding error turns up as a
 * count variance nobody can source months later.
 *
 * LEVELS ARE DERIVED, NEVER STORED, and there is no route that sets one.
 * Every write here appends a movement, and every level in a response is a
 * fold over those movements. A setLevel endpoint would be the one write in
 * this module that destroys evidence, so it does not exist: a physical count
 * goes through `POST /v1/stock/counts`, which records the DIFFERENCE as an
 * adjustment with a reason.
 */

/** A decimal string. Scale 4, so "0.25" and "1000.0001" are both exact. */
export const QuantityString = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "a decimal quantity");

/**
 * Every kind the database can hold, and the list is checked against the
 * `stock_movement_kind` enum by a sweep in vocabulary.test.ts.
 *
 * The first version of this published seven of the eleven, chosen from
 * memory, and the missing `adjustment_out` is what a physical count writes.
 * A client generated from that document would have had the count endpoint
 * return a value its own type said was impossible, and only on the days a
 * count came up short.
 */
export const MovementKind = z.enum([
  "receipt", "issue", "transfer_out", "transfer_in",
  "return_to_stock", "return_to_vendor",
  "adjustment_in", "adjustment_out", "scrap",
  "commit", "release",
]);

export const PurchaseOrderStatus = z.enum([
  "draft", "submitted", "acknowledged", "partially_received", "received", "cancelled",
]);

export const StockMovement = z.object({
  id: Uuid,
  itemId: Uuid,
  locationId: Uuid,
  kind: MovementKind,
  quantity: QuantityString,
  /** Set on anything that ADDS stock. Meaningless on anything that removes it: an issue is costed from the layers. */
  totalCost: MoneyString.nullable(),
  jobId: Uuid.nullable(),
  transferId: Uuid.nullable(),
  reasonCode: z.string().nullable(),
  /** The database's total order. A client reconciling a history sorts on this, never on a timestamp. */
  sequence: z.number().int(),
  occurredAt: z.string().datetime(),
});

export const StockLevel = z.object({
  itemId: Uuid,
  itemCode: z.string(),
  itemName: z.string(),
  locationId: Uuid,
  locationName: z.string(),
  onHand: QuantityString,
  /** Reserved for a job and still on the shelf. */
  committed: QuantityString,
  /** On hand minus committed. The only number a dispatcher should read. */
  available: QuantityString,
});

export const listStockLevels = defineRoute({
  method: "get",
  path: "/v1/stock/levels",
  summary: "Where everything is",
  description:
    "A row per item PER LOCATION, never one row per item. Once a van is a location, 'is it in stock' has no single answer, and flattening it is what produces the technician who was told yes and drives to a property without the part.",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({}),
  output: z.object({ levels: z.array(StockLevel) }),
});

export const listCommitments = defineRoute({
  method: "get",
  path: "/v1/stock/commitments",
  summary: "Who is holding what, and for which job",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({}),
  output: z.object({
    commitments: z.array(z.object({
      itemId: Uuid,
      itemName: z.string(),
      locationId: Uuid,
      locationName: z.string(),
      jobId: Uuid,
      jobNumber: z.number().int().nullable(),
      jobSummary: z.string().nullable(),
      quantity: QuantityString,
    })),
  }),
});

export const reserveStock = defineRoute({
  method: "post",
  path: "/v1/stock/reservations",
  summary: "Hold stock for a job",
  description:
    "A reservation belongs to a job, not to a counter. Two jobs reserving the last compressor is the case a per item counter gets wrong, and nobody finds out until a second technician arrives at a property.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    locationId: Uuid,
    jobId: Uuid,
    quantity: QuantityString,
  }),
  output: z.object({ movements: z.array(StockMovement) }),
});

export const releaseStock = defineRoute({
  method: "post",
  path: "/v1/stock/releases",
  summary: "Give back what a job no longer needs",
  description:
    "Never more than the job is holding. Without this a cancelled job holds its parts forever: the shelf shows them, available does not, and the reorder engine buys against a shortfall that only exists because of a job nobody is going to do.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    locationId: Uuid,
    jobId: Uuid,
    quantity: QuantityString,
  }),
  output: z.object({ movements: z.array(StockMovement) }),
});

export const issueStock = defineRoute({
  method: "post",
  path: "/v1/stock/issues",
  summary: "Stock onto a job",
  description:
    "A job is required. Stock leaving the shelf for nobody is an ADJUSTMENT, not an issue, and the difference is whether anybody can be told later what the part was for.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    locationId: Uuid,
    jobId: Uuid,
    quantity: QuantityString,
  }),
  output: z.object({ movements: z.array(StockMovement) }),
});

export const receiveStock = defineRoute({
  method: "post",
  path: "/v1/stock/receipts",
  summary: "Stock arriving outside a purchase order",
  description:
    "Refuses nothing, because stock that has physically arrived has arrived. The one rule is that it carries what it COST: a receipt is the only movement that establishes a cost layer, and one with no cost is stock that will be issued at nothing and quietly overstate every job's margin.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    locationId: Uuid,
    quantity: QuantityString,
    totalCost: MoneyString,
  }),
  output: z.object({ movements: z.array(StockMovement) }),
});

export const countStock = defineRoute({
  method: "post",
  path: "/v1/stock/counts",
  summary: "Record a physical count",
  description:
    "The counted number is not written anywhere. What is written is the DIFFERENCE, as an adjustment with a reason, so the history still explains every number it produces. foundAtCost is required when the count found MORE than the history expected: stock that appeared has no receipt behind it, and valuing it at nothing makes every later issue look free.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    locationId: Uuid,
    counted: QuantityString,
    reasonCode: z.string().max(50).optional(),
    foundAtCost: MoneyString.optional(),
  }),
  output: z.object({ movements: z.array(StockMovement) }),
});

export const transferStock = defineRoute({
  method: "post",
  path: "/v1/stock/transfers",
  summary: "Move stock between two locations",
  description:
    "Both legs or neither. One leg of a transfer is stock that left a van and arrived nowhere.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    fromLocationId: Uuid,
    toLocationId: Uuid,
    quantity: QuantityString,
  }),
  output: z.object({ movements: z.array(StockMovement) }),
});

export const listReorderSuggestions = defineRoute({
  method: "get",
  path: "/v1/stock/reorder-suggestions",
  summary: "What to buy",
  description:
    "Advice, never an order. The position compared against the reorder point is available PLUS what is already on order, and the on order half is derived from purchase order status rather than trusted from a column: that one detail is the whole of the bug where a system reorders the same part every night until twelve arrive.",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({}),
  output: z.object({
    suggestions: z.array(z.object({
      itemId: Uuid,
      itemName: z.string(),
      locationId: Uuid,
      locationName: z.string(),
      suggested: QuantityString,
      position: QuantityString,
      availableNow: QuantityString,
      onOrder: QuantityString,
      reorderPoint: QuantityString,
      preferredVendorId: Uuid.nullable().optional(),
    })),
  }),
});

export const getJobMaterialCost = defineRoute({
  method: "get",
  path: "/v1/jobs/{jobId}/material-cost",
  summary: "What a job consumed, at cost",
  description:
    "Costed from the layers by the configured method, never from a price on the movement.",
  module: "M15",
  permissions: ["inventory:read"],
  input: z.object({ jobId: Uuid }),
  output: z.object({ cost: MoneyString }),
});

/* -------------------------------------------------------------- vendors */

export const Vendor = z.object({
  id: Uuid,
  name: z.string(),
  accountNumber: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  active: z.boolean(),
});

export const listVendors = defineRoute({
  method: "get",
  path: "/v1/vendors",
  summary: "List vendors",
  module: "M16",
  permissions: ["inventory:read"],
  input: z.object({}),
  output: z.object({ vendors: z.array(Vendor) }),
});

export const createVendor = defineRoute({
  method: "post",
  path: "/v1/vendors",
  summary: "Add a vendor",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(200),
    accountNumber: z.string().max(100).optional(),
    email: z.string().max(320).optional(),
    phone: z.string().max(32).optional(),
  }),
  output: z.object({ id: Uuid, name: z.string() }),
});

/* ------------------------------------------------------- purchase orders */

export const PurchaseOrderSummary = z.object({
  id: Uuid,
  /** Per organization and sequential. A vendor asking "which PO was that" needs an answer shorter than a uuid. */
  number: z.number().int(),
  status: PurchaseOrderStatus,
  vendorName: z.string(),
  expectedAt: z.string().datetime().nullable(),
  lineCount: z.number().int(),
  total: MoneyString,
  /** True while any line is still owed. */
  outstanding: z.boolean(),
});

export const listPurchaseOrders = defineRoute({
  method: "get",
  path: "/v1/purchase-orders",
  summary: "List purchase orders",
  module: "M16",
  permissions: ["po:read"],
  input: z.object({}),
  output: z.object({ purchaseOrders: z.array(PurchaseOrderSummary) }),
});

export const createPurchaseOrder = defineRoute({
  method: "post",
  path: "/v1/purchase-orders",
  summary: "Raise a purchase order",
  description:
    "Lines are supplied rather than taken wholesale from the suggestions, because the suggestion is advice and the order is a commitment. A location per line, falling back to the order's: a vendor drops the condensers at the shop and the filters onto a van more often than it sounds.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    vendorId: Uuid,
    defaultLocationId: Uuid,
    expectedAt: z.string().datetime().optional(),
    notes: z.string().max(2000).optional(),
    lines: z.array(z.object({
      itemId: Uuid,
      locationId: Uuid.optional(),
      quantity: QuantityString,
      unitPrice: MoneyString,
    })).min(1),
  }),
  output: z.object({ id: Uuid, number: z.number().int(), status: PurchaseOrderStatus }),
});

export const setPurchaseOrderStatus = defineRoute({
  method: "post",
  path: "/v1/purchase-orders/{id}/status",
  summary: "Move an order along",
  description:
    "A received order cannot go back to draft and a cancelled one is finished. Both are absorbing states, and reopening one is how stock gets received twice against the same promise.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({ id: Uuid, status: PurchaseOrderStatus }),
  output: z.object({ id: Uuid, status: PurchaseOrderStatus }),
});

export const receivePurchaseOrder = defineRoute({
  method: "post",
  path: "/v1/purchase-orders/{id}/receipts",
  summary: "Receive against an order",
  description:
    "Partial receipts are the case that goes wrong: three of five arrive, two are still owed, and a system that closes the order on any receipt loses the other two forever. The received totals and the resulting status are computed, never accumulated by the caller.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    lines: z.array(z.object({
      lineId: Uuid,
      quantity: QuantityString,
    })).min(1),
  }),
  output: z.object({ status: PurchaseOrderStatus }),
});

export const inventoryRoutes = {
  listStockLevels, listCommitments,
  reserveStock, releaseStock, issueStock, receiveStock, countStock, transferStock,
  listReorderSuggestions, getJobMaterialCost,
  listVendors, createVendor,
  listPurchaseOrders, createPurchaseOrder, setPurchaseOrderStatus, receivePurchaseOrder,
} as const;
