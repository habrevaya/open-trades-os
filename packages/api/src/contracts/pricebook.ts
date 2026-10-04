import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString, PageRequest, pageOf, Timestamps, ExternalRef, ExternalLookup } from "./common";

export const ItemKind = z.enum(["service", "material", "equipment", "labor", "fee", "discount"]);

/**
 * Which fee an item is, when it is one a membership plan can waive: the
 * diagnostic fee, or the after hours rate. A plan that waives it takes the
 * whole line off for its members, said on the line. Null for everything else.
 */
export const FeeRole = z.enum(["diagnostic", "after_hours"]);

/**
 * A price book item as the API returns it: the stable identity merged with its
 * CURRENT version. Documents reference `versionId`, never `id`, so raising a
 * price never rewrites what an old invoice said.
 */
/** One item inside a kit, by the item, never a version: the kit uses whatever that item is today. */
export const KitComponent = z.object({
  itemId: Uuid,
  quantity: z.number().positive().max(10000),
});

export const PriceBookItem = z.object({
  id: Uuid,
  versionId: Uuid,
  version: z.number().int(),
  kind: ItemKind,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  categoryId: Uuid.nullable(),
  feeRole: FeeRole.nullable(),
  price: MoneyString,
  taxable: z.boolean(),
  taxClass: z.string().nullable(),
  laborMinutes: z.number().int().nullable(),
  warrantyMonths: z.number().int().nullable(),
  /** A kit's parts: other items included in it, each with how many. Empty for an item that is not a kit. */
  components: z.array(KitComponent),
  active: z.boolean(),
  /** Redacted unless the caller holds pricebook.cost:read. */
  cost: MoneyString.nullable().optional(),
  margin: RateString.nullable().optional(),
  commissionRate: RateString.nullable().optional(),
  externalRef: ExternalRef.nullable(),
}).merge(Timestamps);

export const listPriceBook = defineRoute({
  method: "get",
  path: "/v1/pricebook/items",
  summary: "List price book items",
  module: "M06",
  permissions: ["pricebook:read"],
  input: PageRequest.extend({
    q: z.string().max(200).optional(),
    kind: ItemKind.optional(),
    categoryId: Uuid.optional(),
    includeInactive: z.boolean().default(false),
    /** Find by where it came from. See `ExternalRef`. */
    ...ExternalLookup,
  }),
  output: pageOf(PriceBookItem),
});

export const createPriceBookItem = defineRoute({
  method: "post",
  path: "/v1/pricebook/items",
  summary: "Create a price book item",
  module: "M06",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    kind: ItemKind.default("service"),
    code: z.string().min(1).max(60),
    name: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    categoryId: Uuid.optional(),
    price: MoneyString,
    cost: MoneyString.optional(),
    taxable: z.boolean().default(true),
    taxClass: z.string().max(50).optional(),
    laborMinutes: z.number().int().min(0).max(10000).optional(),
    warrantyMonths: z.number().int().min(0).max(600).optional(),
    feeRole: FeeRole.optional(),
    /** Where this came from in another system. See `ExternalRef`. */
    externalRef: ExternalRef.optional(),
  }),
  output: PriceBookItem,
});

/**
 * Editing an item creates a NEW VERSION rather than mutating the current one.
 * Existing documents keep pointing at the version they were priced against,
 * which is what stops a price rise silently rewriting three years of history.
 */
export const revisePriceBookItem = defineRoute({
  method: "post",
  path: "/v1/pricebook/items/{id}/revise",
  summary: "Revise a price book item",
  description: "Creates a new version, from now or from `effectiveFrom`: the name, description, price, cost, labour minutes, tax, warranty and a kit's parts, each carried forward when left off. Existing documents keep the version they were priced against.",
  module: "M06",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    price: MoneyString.optional(),
    cost: MoneyString.optional(),
    taxable: z.boolean().optional(),
    taxClass: z.string().max(50).nullable().optional(),
    laborMinutes: z.number().int().min(0).max(10000).optional(),
    warrantyMonths: z.number().int().min(0).max(600).nullable().optional(),
    /**
     * The kit's parts, replacing the whole list, written into the new version
     * like any other field. An empty list makes it an item that is not a kit.
     * Left off, they carry forward. Each item once, never the kit itself or a
     * kit that contains it.
     */
    components: z.array(KitComponent).max(100).optional(),
    effectiveFrom: z.string().datetime().optional(),
  }),
  output: PriceBookItem,
});

export const getPriceBookItem = defineRoute({
  method: "get",
  path: "/v1/pricebook/items/{id}",
  summary: "One price book item, with every price it has had",
  description:
    "The item as it stands and every version newest first, each with the window it was in force and whether it is in force now, scheduled, or past. A revision called off is left out, because nothing was ever priced from it. `inForce` is false for an item whose only version is dated ahead. Cost appears only for a reader holding pricebook.cost:read.",
  module: "M06",
  permissions: ["pricebook:read"],
  input: z.object({ id: Uuid }),
  output: PriceBookItem.extend({
    inForce: z.boolean(),
    versions: z.array(z.object({
      id: Uuid,
      version: z.number().int(),
      name: z.string(),
      price: MoneyString,
      cost: MoneyString.nullable().optional(),
      effectiveFrom: z.string().datetime(),
      effectiveTo: z.string().datetime().nullable(),
      state: z.enum(["in_force", "scheduled", "past"]),
    })),
  }),
});

export const updatePriceBookItem = defineRoute({
  method: "patch",
  path: "/v1/pricebook/items/{id}",
  summary: "Change an item's kind, code, category or fee",
  description:
    "What the item IS rather than what it costs or is called, so it changes the item in place and writes no version: no document points at any of these. The name, description, price and cost are a revision. A code another item already has is refused.",
  module: "M06",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    kind: ItemKind.optional(),
    code: z.string().min(1).max(60).optional(),
    categoryId: Uuid.nullable().optional(),
    feeRole: FeeRole.nullable().optional(),
  }),
  output: PriceBookItem.nullable(),
});

export const setPriceBookItemActive = defineRoute({
  method: "post",
  path: "/v1/pricebook/items/{id}/active",
  summary: "Retire an item, or bring it back",
  description:
    "`active` was filtered on by the list and published as includeInactive, and nothing could make it false: the filter's only possible answer was everything. Retired, not deleted, because every invoice line that used this item points at a version of it and those have to keep resolving. It stops being sold; nothing about what was sold changes.",
  module: "M06",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    active: z.boolean(),
    reason: z.string().max(500).optional(),
  }),
  output: z.object({ id: Uuid, code: z.string(), active: z.boolean() }),
});

export const priceBookRoutes = {
  setPriceBookItemActive, listPriceBook, createPriceBookItem, revisePriceBookItem,
  getPriceBookItem, updatePriceBookItem,
} as const;
