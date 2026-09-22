import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString, PageRequest, pageOf, Timestamps } from "./common";

export const ItemKind = z.enum(["service", "material", "equipment", "labor", "fee", "discount"]);

/**
 * A price book item as the API returns it: the stable identity merged with its
 * CURRENT version. Documents reference `versionId`, never `id`, so raising a
 * price never rewrites what an old invoice said.
 */
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
  price: MoneyString,
  taxable: z.boolean(),
  taxClass: z.string().nullable(),
  laborMinutes: z.number().int().nullable(),
  warrantyMonths: z.number().int().nullable(),
  active: z.boolean(),
  /** Redacted unless the caller holds pricebook.cost:read. */
  cost: MoneyString.nullable().optional(),
  margin: RateString.nullable().optional(),
  commissionRate: RateString.nullable().optional(),
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
  description: "Creates a new version. Existing documents keep the version they were priced against.",
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
    laborMinutes: z.number().int().min(0).max(10000).optional(),
    effectiveFrom: z.string().datetime().optional(),
  }),
  output: PriceBookItem,
});

export const priceBookRoutes = { listPriceBook, createPriceBookItem, revisePriceBookItem } as const;
