import { z } from "zod";
import { defineRoute } from "../lib/define";
import { MoneyString, Uuid } from "./common";

/**
 * AFTER HOURS AND HOLIDAY RATES
 *
 * Which price book item is charged for work booked outside the company's
 * hours, and which on a holiday. Both are items marked as the after hours
 * rate, the mark a membership plan reads when it waives it, and choosing one
 * that is not marked marks it. The invoice screens offer the item for a job
 * whose visit was booked outside the hours kept that day or on a date in the
 * holiday list; nothing adds it by itself.
 */

const Item = z.object({
  id: Uuid,
  code: z.string(),
  name: z.string(),
  price: MoneyString,
  taxable: z.boolean(),
});

const Rates = z.object({
  afterHoursItem: Item.nullable(),
  holidayItem: Item.nullable(),
  /** Items already marked as the after hours rate. */
  marked: z.array(Item),
});

export const getAfterHoursRates = defineRoute({
  method: "get",
  path: "/v1/after-hours-rates",
  summary: "Which item is charged after hours, and which on a holiday",
  module: "M02",
  permissions: ["pricebook:read"],
  input: z.object({}),
  output: Rates,
});

export const setAfterHoursRates = defineRoute({
  method: "put",
  path: "/v1/after-hours-rates",
  summary: "Choose the after hours rate and the holiday rate",
  description:
    "Each is a price book item, or null for none. An item not yet marked as the after hours rate is marked by this, so a membership plan that waives the after hours rate waives it too; the diagnostic fee and a retired item are refused. The two may be the same item. Sent whole, so saving it twice leaves the same choice.",
  module: "M02",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    afterHoursItemId: Uuid.nullable(),
    holidayItemId: Uuid.nullable(),
  }),
  output: Rates,
});

export const getJobRateOffers = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}/rate-offers",
  summary: "The after hours or holiday rate to offer on this job's invoice",
  description:
    "One offer per item: the holiday rate for each visit booked on a date in the holiday list, and the after hours rate for each visit booked outside the hours kept that day, by the start of the window it was booked into. Cancelled visits are not counted, and an item already on another of the job's invoices that was not voided is not offered again (`exceptInvoiceId` is the draft being edited). Empty when no rates are chosen. Nothing is added to an invoice by this.",
  module: "M13",
  permissions: ["job:read"],
  input: z.object({ id: Uuid, exceptInvoiceId: Uuid.optional() }),
  output: z.object({
    offers: z.array(z.object({
      kind: z.enum(["after_hours", "holiday"]),
      item: Item,
      quantity: z.number().int(),
      /** One sentence per visit: "2026-10-06 at 19:00, after the 17:00 close". */
      because: z.array(z.string()),
    })),
  }),
});

export const afterHoursRoutes = { getAfterHoursRates, setAfterHoursRates, getJobRateOffers } as const;
