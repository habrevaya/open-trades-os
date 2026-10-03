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
  /** The serial number or lot this movement moved, for a tracked item. One serial to a movement. */
  lotId: Uuid.nullable(),
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

/**
 * WHICH UNITS, for an item tracked by serial or lot.
 *
 * Required on every receipt, transfer and issue of a tracked item and
 * refused on one that is not tracked, so nobody believes they recorded a
 * serial that went nowhere. A serial is one unit and leaves `quantity` out;
 * a lot says how much of it moved, or leaves it out when one lot covers the
 * whole movement.
 */
export const StockUnitInput = z.object({
  number: z.string().min(1).max(100),
  quantity: QuantityString.optional(),
  /** A lot's use by date, on a receipt. */
  expiresOn: z.string().date().optional(),
  /** On an issue: the customer's equipment record at the job's address this serial is, or went into. */
  equipmentId: Uuid.optional(),
  /** On an issue: record the serial as new equipment at the job's address. Needs `equipment:write`. */
  installAs: z.object({
    category: z.string().min(1).max(100),
    tag: z.string().max(100).optional(),
    manufacturer: z.string().max(100).optional(),
    model: z.string().max(100).optional(),
    location: z.string().max(200).optional(),
  }).optional(),
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
    "A job is required. Stock leaving the shelf for nobody is an ADJUSTMENT, not an issue, and the difference is whether anybody can be told later what the part was for. A tracked item names its serials or lots in `units`, each of which must be at this location, and a serial can say which of the customer's units it is (`equipmentId`) or be recorded as new equipment at the job's address (`installAs`), which is the trace from the shelf to the customer.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    locationId: Uuid,
    jobId: Uuid,
    quantity: QuantityString,
    units: z.array(StockUnitInput).max(500).optional(),
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
    /** The serial numbers or lots arriving, for a tracked item. The cost is allocated across them. */
    units: z.array(StockUnitInput).max(500).optional(),
  }),
  output: z.object({ movements: z.array(StockMovement) }),
});

export const countStock = defineRoute({
  method: "post",
  path: "/v1/stock/counts",
  summary: "Record a physical count",
  description:
    "The counted number is not written anywhere. What is written is the DIFFERENCE, as an adjustment with a reason, so the history still explains every number it produces. foundAtCost is required when the count found MORE than the history expected: stock that appeared has no receipt behind it, and valuing it at nothing makes every later issue look free. Refused for an item tracked by serial or lot, whose missing units are written off by number.",
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
    "Both legs or neither. One leg of a transfer is stock that left a van and arrived nowhere. A tracked item names the serials or lots that moved, each of which must be at the location it leaves.",
  module: "M16",
  permissions: ["inventory:adjust"],
  idempotent: true,
  input: z.object({
    itemId: Uuid,
    fromLocationId: Uuid,
    toLocationId: Uuid,
    quantity: QuantityString,
    units: z.array(StockUnitInput).max(500).optional(),
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

/**
 * THE DECLARED PERMISSION IS THE ENFORCED ONE
 *
 * These five routes declared inventory permissions and their services check
 * vendor and purchase order ones. The service is what refuses, so the
 * declaration was documentation of something that is not true: OpenAPI says
 * "Requires a session holding: ..." from this field, and the MCP server filters
 * its tool list by it. A role built from the published docs was refused, and an
 * agent holding `po:write` was not offered a tool it could have used.
 *
 * `permissions-enforced.test.ts` fixed the SERVICE side of the vendor case, when
 * `vendor:read` and `vendor:write` turned out to be declared on roles and
 * guarded by nothing, and nobody came back to the contract.
 * `permission-declarations.test.ts` now probes every session route with an actor
 * holding nothing and asserts the permission it demands is one the route
 * declares, so this cannot drift again in silence.
 */
export const listVendors = defineRoute({
  method: "get",
  path: "/v1/vendors",
  summary: "List vendors",
  module: "M16",
  permissions: ["vendor:read"],
  input: z.object({}),
  output: z.object({ vendors: z.array(Vendor) }),
});

export const createVendor = defineRoute({
  method: "post",
  path: "/v1/vendors",
  summary: "Add a vendor",
  module: "M16",
  permissions: ["vendor:write"],
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
  permissions: ["po:write"],
  idempotent: true,
  input: z.object({
    vendorId: Uuid,
    defaultLocationId: Uuid,
    expectedAt: z.string().datetime().optional(),
    notes: z.string().max(2000).optional(),
    lines: z.array(z.object({
      /** Our item. Either this or `partNumber`. */
      itemId: Uuid.optional(),
      /** The vendor's own part number, or our item code, looked up for this vendor. */
      partNumber: z.string().min(1).max(100).optional(),
      locationId: Uuid.optional(),
      quantity: QuantityString,
      /** What the vendor charges for one. Their price on record when left out; refused when there is none. */
      unitPrice: MoneyString.optional(),
    }).refine((line) => line.itemId !== undefined || line.partNumber !== undefined, {
      message: "Name the part: our item, or the vendor's part number",
    })).min(1),
  }),
  output: z.object({ id: Uuid, number: z.number().int(), status: PurchaseOrderStatus }),
});

/** Where an order stands against the company's approval steps. */
export const PurchaseOrderApprovalState = z.object({
  /** `not_needed` means no step applies to an order this size, and the sender's own `po:approve` is the approval. */
  state: z.enum(["not_needed", "waiting", "approved", "rejected"]),
  sentence: z.string(),
  steps: z.array(z.object({
    step: z.number().int(),
    minimumTotal: MoneyString,
    roleLabel: z.string(),
    state: z.enum(["approved", "rejected", "waiting", "later"]),
    decidedBy: z.string().nullable(),
    decidedAt: z.string().datetime().nullable(),
    note: z.string().nullable(),
  })),
});

export const PurchaseOrderSend = z.object({
  id: Uuid,
  destination: z.string().nullable(),
  /** `queued` is in the outbox, not delivered. */
  state: z.string(),
  explanation: z.string().nullable(),
  sentAt: z.string().datetime(),
  sentBy: z.string().nullable(),
  linkExpiresAt: z.string().datetime().nullable(),
});

export const getPurchaseOrder = defineRoute({
  method: "get",
  path: "/v1/purchase-orders/{id}",
  summary: "One purchase order, line by line",
  description: "Each line with the vendor's part number as it was when the order was written, our item, how many, at what, where it is going and how much has arrived.",
  module: "M16",
  permissions: ["po:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    number: z.number().int(),
    status: PurchaseOrderStatus,
    vendorId: Uuid,
    vendorName: z.string(),
    vendorAccount: z.string().nullable(),
    expectedAt: z.string().datetime().nullable(),
    submittedAt: z.string().datetime().nullable(),
    notes: z.string().nullable(),
    total: MoneyString,
    lines: z.array(z.object({
      id: Uuid,
      itemId: Uuid,
      itemCode: z.string(),
      itemName: z.string(),
      vendorPartNumber: z.string().nullable(),
      locationId: Uuid,
      locationName: z.string(),
      quantityOrdered: QuantityString,
      quantityReceived: QuantityString,
      unitPrice: MoneyString,
      /** How the item is tracked, when it is: a receipt of this line has to name its serials or lots. */
      tracking: z.enum(["serial", "lot"]).nullable(),
      /** Freight and fees spread onto this line across every delivery so far. */
      landedCost: MoneyString,
      /** The serials or lots received on this line. */
      units: z.array(z.object({ id: Uuid, number: z.string() })),
    })),
    /** Each delivery, with the charges that came on it. */
    receipts: z.array(z.object({
      id: Uuid,
      receivedAt: z.string().datetime(),
      basis: z.enum(["value", "quantity"]),
      chargesTotal: MoneyString,
      charges: z.array(z.object({ description: z.string(), amount: MoneyString })),
    })),
    approval: PurchaseOrderApprovalState,
    /** Every time it was emailed, whether it went or not, newest first. */
    sends: z.array(PurchaseOrderSend),
  }),
});

/* ------------------------------------------- vendor part numbers and catalogues */

export const VendorItem = z.object({
  id: Uuid,
  vendorId: Uuid,
  vendorName: z.string(),
  itemId: Uuid,
  itemCode: z.string(),
  itemName: z.string().nullable(),
  /** The vendor's own number for the part, as their catalogue prints it. */
  partNumber: z.string(),
  description: z.string().nullable(),
  /** What one costs from this vendor. Null when nobody has said. */
  cost: MoneyString.nullable(),
  costUpdatedAt: z.string().datetime().nullable(),
});

export const listVendorItems = defineRoute({
  method: "get",
  path: "/v1/vendor-items",
  summary: "Vendors' part numbers for our items",
  description: "For one item (`itemId`), every vendor's number and price for it; for one vendor (`vendorId`), their whole catalogue as linked to ours.",
  module: "M16",
  permissions: ["vendor:read"],
  input: z.object({ itemId: Uuid.optional(), vendorId: Uuid.optional() }),
  output: z.object({ links: z.array(VendorItem) }),
});

export const setVendorItem = defineRoute({
  method: "put",
  path: "/v1/vendor-items",
  summary: "Say what a vendor calls one of our items, and what they charge",
  description: "One number per item per vendor, so this replaces the item's existing link to that vendor. A number this vendor already uses for another of our items is refused. A blank cost keeps the one on record.",
  module: "M16",
  permissions: ["vendor:write"],
  idempotent: true,
  input: z.object({
    vendorId: Uuid,
    itemId: Uuid,
    partNumber: z.string().min(1).max(100),
    description: z.string().max(500).nullable().optional(),
    cost: z.string().max(20).nullable().optional(),
  }),
  output: VendorItem,
});

export const removeVendorItem = defineRoute({
  method: "post",
  path: "/v1/vendor-items/{id}/remove",
  summary: "Forget a vendor's number for an item",
  description: "Orders already written keep the number they were sent with, because each line copied it.",
  module: "M16",
  permissions: ["vendor:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.boolean() }),
});

const CatalogueOptions = {
  /** The file, as text: a header line naming sku, description, cost and vendor columns, then a row per part. */
  csv: z.string().min(1).max(2_000_000),
  /** The vendor for rows that name none, or for a file with no vendor column. */
  vendorId: Uuid.nullable().optional(),
  /** The margin a new item is priced at over its cost, as a fraction: 0.4 is forty per cent. Without one, new parts are skipped rather than sold at cost. */
  margin: z.string().max(12).nullable().optional(),
  /** Round new items' prices up to this ending of cents, like 95 or 99. */
  ending: z.string().regex(/^\d{2}$/).nullable().optional(),
  /** Whether each matched item's own cost (the one job costing reads) follows the vendor's, as a new version. */
  updateItemCost: z.boolean().default(false),
  /** The category new items are put in. */
  categoryId: Uuid.nullable().optional(),
};

const CatalogueRow = z.object({
  action: z.enum(["create", "link", "update", "unchanged", "skip"]),
  line: z.number().int(),
  sku: z.string(),
  vendorId: Uuid.optional(),
  vendorName: z.string().optional(),
  itemId: Uuid.optional(),
  itemCode: z.string().optional(),
  itemName: z.string().optional(),
  /** For a new item: its code, name and the price the margin gives it. */
  code: z.string().optional(),
  name: z.string().optional(),
  price: MoneyString.optional(),
  /** The vendor's cost from the file. */
  cost: MoneyString.optional(),
  /** What the link said before, for an update. */
  partNumberBefore: z.string().optional(),
  costBefore: MoneyString.nullable().optional(),
  /** The item's own cost before and after, when it follows the vendor's. Before is null for a reader who may not see cost. */
  itemCostBefore: MoneyString.nullable().optional(),
  itemCostAfter: MoneyString.nullable().optional(),
  /** The item's cost would have followed, and a scheduled price change is in the way. */
  costHeldBack: z.boolean().optional(),
  /** Why a skipped row was skipped. */
  reason: z.string().optional(),
});

const CatalogueResult = z.object({
  /** Lines the file could not be read at, with why. */
  problems: z.array(z.object({ line: z.number().int(), message: z.string() })),
  rows: z.array(CatalogueRow),
  counts: z.object({
    create: z.number().int(), link: z.number().int(), update: z.number().int(),
    unchanged: z.number().int(), skip: z.number().int(),
  }),
});

export const previewVendorCatalogue = defineRoute({
  method: "post",
  path: "/v1/vendor-catalogue/preview",
  summary: "What a supplier's catalogue file would do, with nothing written",
  description:
    "Each row matched by the vendor's part number to an existing link (an update), else by our item code (a new link to that item), else created as a new item priced at `margin` over its cost. A row that cannot be read or matched is skipped with the reason: an unknown vendor, a cost that is not an amount, a part number twice, a new part with no margin to price it. A POST because the file is too large for a query string; it writes nothing, so replaying it is harmless.",
  module: "M16",
  permissions: ["vendor:write", "pricebook:write"],
  idempotent: true,
  input: z.object(CatalogueOptions),
  output: CatalogueResult,
});

export const applyVendorCatalogue = defineRoute({
  method: "post",
  path: "/v1/vendor-catalogue/apply",
  summary: "Apply a supplier's catalogue file",
  description:
    "Recomputed from the file inside the write rather than trusted from a preview, and written exactly as the plan says, less any `skipLines`. New items are materials at the margin asked for. An item's own cost that follows the vendor's is a new version, so every document already priced keeps its cost; one with a price change already scheduled is left alone and said so.",
  module: "M16",
  permissions: ["vendor:write", "pricebook:write"],
  idempotent: true,
  dryRun: true,
  input: z.object({
    ...CatalogueOptions,
    /** Lines of the file to leave out, as the preview numbered them. */
    skipLines: z.array(z.number().int().min(1)).max(5000).optional(),
  }),
  output: CatalogueResult.extend({
    created: z.number().int(),
    linked: z.number().int(),
    updated: z.number().int(),
    itemCostsRevised: z.number().int(),
  }),
});

/**
 * `po:write` here, and SUBMITTING MAY ALSO NEED `po:approve`.
 *
 * Declared as the one it always needs rather than as both, because both would
 * tell a reader and an agent that moving an order to `draft` needs approval
 * authority, which it does not. Submitting an order none of the company's
 * approval steps applies to needs `po:approve` from the sender; an order the
 * steps apply to needs every step approved first, by the people the steps
 * name, and then the buyer may send it. A holder of `po:approve` without
 * `po:write` may still submit, which is how a finance role sends an order.
 */
export const setPurchaseOrderStatus = defineRoute({
  method: "post",
  path: "/v1/purchase-orders/{id}/status",
  summary: "Move an order along",
  description:
    "A received order cannot go back to draft and a cancelled one is finished. Both are absorbing states, and reopening one is how stock gets received twice against the same promise. Submitting (sending to the vendor) is where approval is checked: an order the company's approval steps apply to goes once every step has approved it and is refused while one is waiting or after one rejected it; an order no step applies to needs `po:approve` from whoever sends it.",
  module: "M16",
  permissions: ["po:write"],
  idempotent: true,
  input: z.object({ id: Uuid, status: PurchaseOrderStatus }),
  output: z.object({ id: Uuid, status: PurchaseOrderStatus }),
});

export const receivePurchaseOrder = defineRoute({
  method: "post",
  path: "/v1/purchase-orders/{id}/receipts",
  summary: "Receive against an order",
  description:
    "Partial receipts are the case that goes wrong: three of five arrive, two are still owed, and a system that closes the order on any receipt loses the other two forever. The received totals and the resulting status are computed, never accumulated by the caller. LANDED COST: freight and fees that came with this delivery (`charges`) are spread over the lines that arrived on it, by value or by quantity (`basis`), allocated to the cent and folded into each line's cost, so the parts are issued to jobs at what they really cost. A tracked line names its serials or lots in `units`.",
  module: "M16",
  permissions: ["po:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    lines: z.array(z.object({
      lineId: Uuid,
      quantity: QuantityString,
      units: z.array(StockUnitInput).max(500).optional(),
    })).min(1),
    charges: z.array(z.object({
      description: z.string().min(1).max(200),
      amount: MoneyString,
    })).max(20).optional(),
    basis: z.enum(["value", "quantity"]).optional(),
  }),
  output: z.object({ status: PurchaseOrderStatus, receiptId: Uuid, chargesTotal: MoneyString }),
});

export const inventoryRoutes = {
  listStockLevels, listCommitments,
  reserveStock, releaseStock, issueStock, receiveStock, countStock, transferStock,
  listReorderSuggestions, getJobMaterialCost,
  listVendors, createVendor,
  listPurchaseOrders, createPurchaseOrder, getPurchaseOrder, setPurchaseOrderStatus, receivePurchaseOrder,
  listVendorItems, setVendorItem, removeVendorItem, previewVendorCatalogue, applyVendorCatalogue,
} as const;
