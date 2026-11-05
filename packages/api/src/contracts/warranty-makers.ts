import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * MAKERS, AND THE DAYS EACH GIVES TO REGISTER A UNIT (M32)
 *
 * A maker is written down once with the days it allows, and a price book item
 * names its maker (`warrantyMakerId` on `PATCH /v1/pricebook/items/{id}`). An item
 * with no maker still uses its own days.
 */
const Maker = z.object({
  id: Uuid,
  name: z.string(),
  /** Days after the install to register a unit; null when the maker has not been given any, which leaves the item's own days as the word. */
  registrationDays: z.number().int().nullable(),
  notes: z.string().nullable(),
  /** Items still sold that name this maker. */
  items: z.number().int(),
});

export const listWarrantyMakers = defineRoute({
  method: "get",
  path: "/v1/warranty-makers",
  summary: "The makers a company writes down, with the days each gives to register a unit",
  description: "By name. Needs `pricebook:read`, the permission the item's own days are read with.",
  module: "M32",
  permissions: ["pricebook:read"],
  input: z.object({}),
  output: z.object({ makers: z.array(Maker) }),
});

export const createWarrantyMaker = defineRoute({
  method: "post",
  path: "/v1/warranty-makers",
  summary: "Add a maker",
  description:
    "A name another maker has (compared without case) is refused. `registrationDays` is a whole number from 1 to 365, or left out when the maker has not given any, in which case an item that names it uses its own days. A maker's days are used when a serialised unit of one of its items is installed on a job; a deadline that is already open does not move. Needs `pricebook:write`.",
  module: "M32",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(120),
    registrationDays: z.number().int().min(1).max(365).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  }),
  output: Maker,
});

export const updateWarrantyMaker = defineRoute({
  method: "patch",
  path: "/v1/warranty-makers/{id}",
  summary: "Rename a maker, or change its days or notes",
  description:
    "Left out means unchanged; `registrationDays: null` takes the days off. Applies to installs from now on: no deadline already open is moved. Audited. Needs `pricebook:write`.",
  module: "M32",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(120).optional(),
    registrationDays: z.number().int().min(1).max(365).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  }),
  output: Maker,
});

export const retireWarrantyMaker = defineRoute({
  method: "post",
  path: "/v1/warranty-makers/{id}/retire",
  summary: "Take a maker off the list",
  description: "Refused while an item still sold names it, with how many, so no item quietly goes back to its own days. Needs `pricebook:write`.",
  module: "M32",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, retired: z.literal(true) }),
});

export const warrantyMakerRoutes = {
  listWarrantyMakers, createWarrantyMaker, updateWarrantyMaker, retireWarrantyMaker,
} as const;
