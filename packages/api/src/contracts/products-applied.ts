import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * PRODUCTS APPLIED ON A VISIT (M11, M06)
 *
 * The regulated application record, as the office reads and adds to it: the
 * product chosen from the price book's chemicals (an item the company marks as
 * a chemical, with the unit its cost is per and its EPA number), how much,
 * the licence and the target. The phone and the browser's "My day" record the
 * same thing through the field sync. Pest control's chemical cost per stop
 * values what was chosen from the book; a product typed by name is shown here
 * and never valued.
 */
export const AppliedProduct = z.object({
  id: Uuid,
  field: z.string(),
  productName: z.string().nullable(),
  epaRegistrationNumber: z.string().nullable(),
  quantity: z.string().nullable(),
  unit: z.string().nullable(),
  applicatorLicense: z.string().nullable(),
  targetPest: z.string().nullable(),
  /** Chosen from the price book, rather than typed by name. */
  fromBook: z.boolean(),
  recordedAt: z.string().datetime(),
});

export const ProductsOnVisit = z.object({
  visitId: Uuid,
  reportId: Uuid.nullable(),
  published: z.boolean(),
  /** The product questions the visit's report asks, from its template. */
  fields: z.array(z.object({ key: z.string(), label: z.string() })),
  /** The price book's chemicals, by name: never a cost. */
  chemicals: z.array(z.object({
    id: Uuid, name: z.string(), unit: z.string(), epaRegistrationNumber: z.string().nullable(),
    /** The units its version in force is bought and used in, when it has both: an application can be recorded in either. */
    units: z.object({ buy: z.string(), use: z.string() }).nullable(),
  })),
  /** The latest answer to each product question on the visit's reports. */
  applied: z.array(AppliedProduct),
});

export const getVisitProducts = defineRoute({
  method: "get",
  path: "/v1/visits/{id}/products-applied",
  summary: "What was applied on a visit, and the chemicals to choose from",
  description:
    "The product questions the visit's report asks, the latest answer to each (chosen from the price book, or typed by name on an older record), and the price book's chemicals by name, unit and EPA number. Scoped by the visit's job.",
  module: "M11",
  permissions: ["servicereport:read"],
  input: z.object({ id: Uuid }),
  output: ProductsOnVisit,
});

export const recordVisitProduct = defineRoute({
  method: "post",
  path: "/v1/visits/{id}/products-applied",
  summary: "Record a product applied on a visit, chosen from the price book",
  description:
    "For an application the technician did not record. Written to the visit's report (created as the phone would create it) as the latest answer to one of its product questions, with the item's name, EPA number and unit carried from the book: `unit` when it is the buy or the use unit of an item bought in one and used in another, otherwise the chemical's own. Refused for a published report, a report that asks about no product, an item that is not a chemical, and an amount that is not a positive number. On the audit log.",
  module: "M11",
  permissions: ["servicereport:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** The product question it answers, by its key: `product_applied`. */
    field: z.string().min(1).max(80),
    priceBookItemId: Uuid,
    quantity: z.string().min(1).max(20),
    applicatorLicense: z.string().max(120).optional(),
    targetPest: z.string().max(120).optional(),
    /** The buy or the use unit, for a chemical bought in one and used in another. Anything else is recorded in the chemical's own unit. */
    unit: z.string().max(20).optional(),
  }),
  output: ProductsOnVisit,
});

export const productsAppliedRoutes = { getVisitProducts, recordVisitProduct } as const;
