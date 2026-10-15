import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * ONE BOX THAT FINDS THINGS
 *
 * A customer by their name, email or phone, a job by its number, words in
 * its summary or its customer's name, an invoice or an estimate by its number
 * or its customer, an address by its street, a unit by its serial or its make
 * and model, and the company's own records (a permit, a warranty
 * registration) by their name or any of their values. Each part is read
 * through the same service, scope and permission as its own list, so the box
 * finds nothing its list would not show: a part the caller may not read is
 * left out, not refused.
 */
export const searchEverything = defineRoute({
  method: "get",
  path: "/v1/search",
  summary: "Find customers, jobs, invoices, estimates, addresses, units and the company's own records",
  description:
    "Every word of `q` has to be somewhere in what each group searches, and a number on its own (`1042` or `#1042`) is also a document's number. Customers by name, email and phone (`customer:read`); jobs by number, summary, description, the customer's words from intake, visit notes and customer name (`job:read`); invoices by number, memo, line names and descriptions and customer name (`invoice:read`); estimates by number, title, option and line names and descriptions and customer name (`estimate:read`); addresses by street (`property:read`); units by serial, make and model (`equipment:read`); and each kind of record by its name and values, word by word (`record:read` and the kind's own read permission). Every part is held to the caller's scope as its own list is: addresses and units by the work at the address, the way customers are. A part the caller may not read is left out. At most five of each with `more` and a `seeAll` link to the list filtered by the same words, and nothing for fewer than two characters. `in` asks for one of the first six groups alone, at up to fifty.",
  module: "M29",
  permissions: [],
  input: z.object({
    q: z.string().max(200),
    in: z.enum(["customers", "jobs", "invoices", "estimates", "addresses", "units"]).optional(),
  }),
  output: z.object({
    q: z.string(),
    groups: z.array(z.object({
      /** `customers`, `jobs`, `invoices`, `estimates`, `addresses`, `units`, or `record:<key>` for a kind of record. */
      key: z.string(),
      label: z.string(),
      hits: z.array(z.object({ id: Uuid, title: z.string(), detail: z.string().nullable(), href: z.string() })),
      /** More match than the hits shown. */
      more: z.boolean(),
      /** The list of every match, filtered by the same words; null when `in` already asked for the group alone. */
      seeAll: z.string().nullable(),
    })),
  }),
});

export const searchRoutes = { searchEverything } as const;
