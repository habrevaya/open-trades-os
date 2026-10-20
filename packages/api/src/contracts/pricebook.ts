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

/**
 * The item as a chemical a technician applies: the unit its cost is per
 * ("gal", "oz", "lb") and the EPA registration number from its label. Only a
 * material can be one. Chosen by name on the phone's application record, it
 * carries both onto the record, and the chemical cost per stop values its
 * quantity at the cost in force on the day it was applied.
 */
export const ChemicalMark = z.object({
  unit: z.string().trim().min(1).max(20),
  epaRegistrationNumber: z.string().trim().max(40).nullable(),
});

/**
 * Bought in one unit and used in another: a gallon drum applied by the ounce
 * is `{ buy: "gal", use: "oz", usePerBuy: "128" }`. The version's cost is
 * then what one buy unit costs, and its price, every line's quantity and an
 * application are in the use unit, costed at the cost over `usePerBuy`.
 */
export const ItemUnits = z.object({
  buy: z.string().trim().min(1).max(20),
  use: z.string().trim().min(1).max(20),
  usePerBuy: z.string().regex(/^\d+(\.\d{1,6})?$/, "How many use units are in one buy unit, like 128"),
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
  /** The quantity on a line of this item is crew hours (people times hours). Converting an approved estimate adds these lines up as the job's budgeted hours. */
  quantityIsCrewHours: z.boolean(),
  /** Set when the company marks it as a chemical its technicians apply; null for everything else. */
  chemical: ChemicalMark.nullable(),
  price: MoneyString,
  taxable: z.boolean(),
  taxClass: z.string().nullable(),
  laborMinutes: z.number().int().nullable(),
  warrantyMonths: z.number().int().nullable(),
  /** The maker wants a unit of this registered within this many days of the install; null when they do not ask. Raises a deadline when a serialised unit is installed on a job (M32). */
  warrantyRegistrationDays: z.number().int().nullable(),
  /** A kit's parts: other items included in it, each with how many. Empty for an item that is not a kit. */
  components: z.array(KitComponent),
  /** Bought in one unit and used in another; null for an item that is not, whose cost is per the one unit its lines count. */
  units: ItemUnits.nullable(),
  active: z.boolean(),
  /** Redacted unless the caller holds pricebook.cost:read. Per the buy unit when `units` says one. */
  cost: MoneyString.nullable().optional(),
  /** What one use unit costs, when `units` says one: the cost over `usePerBuy`. What a line is costed at and the margin is of. Redacted with cost. */
  costPerUse: MoneyString.optional(),
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
    /**
     * Whether a sales tax rate is charged on it. Left off, it is what its
     * shelf says (`categoryTaxable` on `/v1/item-tax`), and on a shelf that
     * says nothing, taxed unless it is labour.
     */
    taxable: z.boolean().optional(),
    taxClass: z.string().max(50).optional(),
    laborMinutes: z.number().int().min(0).max(10000).optional(),
    warrantyMonths: z.number().int().min(0).max(600).optional(),
    /** Days after the install the maker allows to register the unit. Left out, the maker does not ask. */
    warrantyRegistrationDays: z.number().int().min(1).max(365).optional(),
    /** Bought in one unit and used in another, with `cost` per the buy unit. Left out, it is not. */
    units: ItemUnits.optional(),
    feeRole: FeeRole.optional(),
    /** Whether a line of it counts its quantity in crew hours. Left off, it does not. */
    quantityIsCrewHours: z.boolean().optional(),
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
  description: "Creates a new version, from now or from `effectiveFrom`: the name, description, picture, price, cost, labour minutes, tax, warranty, commission rate, a kit's parts and the units it is bought and used in, each carried forward when left off. With `units`, the cost is per the buy unit and a line is costed per the use unit. A commission rate also needs `commission:configure`. Existing documents keep the version they were priced against.",
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
    /** Days after the install the maker allows to register the unit. Null takes it off; left out, the current one carries forward. */
    warrantyRegistrationDays: z.number().int().min(1).max(365).nullable().optional(),
    /** Bought in one unit and used in another, with `cost` per the buy unit. Null takes them off; left out, they carry forward. */
    units: ItemUnits.nullable().optional(),
    /**
     * The kit's parts, replacing the whole list, written into the new version
     * like any other field. An empty list makes it an item that is not a kit.
     * Left off, they carry forward. Each item once, never the kit itself or a
     * kit that contains it.
     */
    components: z.array(KitComponent).max(100).optional(),
    /**
     * The item's picture, as an https address, written into the new version like any other field. `null`
     * takes the picture off; left off, it carries forward. Only https, so a stored address can never be
     * a script or a file on somebody's phone if a screen ever draws it.
     */
    imageUrl: z.string().max(2000).regex(/^https:\/\/[^\s]+$/, "Use a web address that starts with https://").nullable().optional(),
    /**
     * What a seller is paid on this item, as a share of the line (0.08 is eight per cent, never above 1),
     * replacing the technician's plan for it. `null` goes back to the plan; left off, it carries forward.
     * Setting it is a pay term, so it needs `commission:configure` as well.
     */
    commissionRate: z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, "A share from 0 to 1, like 0.08 for eight per cent").nullable().optional(),
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
  summary: "Change an item's kind, code, category, fee, chemical mark or crew hours mark",
  description:
    "What the item IS rather than what it costs or is called, so it changes the item in place and writes no version: no document points at any of these. The name, description, price and cost are a revision. A code another item already has is refused. `chemical` marks a material as a product technicians apply, with the unit its cost is per and its EPA registration number, and null takes the mark off; anything but a material is refused, and so is changing a marked item to another kind. `quantityIsCrewHours` says a line of the item counts its quantity in crew hours, which an estimate line copies when it is written and a conversion adds up as the job's budgeted hours; it changes no price and no estimate already written.",
  module: "M06",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    kind: ItemKind.optional(),
    code: z.string().min(1).max(60).optional(),
    categoryId: Uuid.nullable().optional(),
    feeRole: FeeRole.nullable().optional(),
    chemical: ChemicalMark.nullable().optional(),
    quantityIsCrewHours: z.boolean().optional(),
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
