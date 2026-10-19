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
  summary: "Find customers, jobs, invoices, estimates, addresses, units, customer notes, price book items, people and the company's own records",
  description:
    "Every word of `q` has to be somewhere in what each group searches, and a number on its own (`1042` or `#1042`) is also a document's number. Customers by name, email and phone (`customer:read`); jobs by number, summary, description, the customer's words from intake, visit notes and customer name (`job:read`); invoices by number, memo, line names and descriptions and customer name (`invoice:read`); estimates by number, title, option and line names and descriptions and customer name (`estimate:read`); addresses by street (`property:read`); units by serial, make and model (`equipment:read`); customer notes by what they say (`customer:read`, through the customer's scope, and only the notes marked for the field at a technician's scope); price book items by name, code and description (`pricebook:read`); people by name, email and the name they go by on the board (`user:read`, through the people scope); and each kind of record by its name and values, word by word (`record:read` and the kind's own read permission). Every part is held to the caller's scope as its own list is: addresses and units by the work at the address, the way customers are. A part the caller may not read is left out. Each group is read as typed first; when that finds fewer than the group shows, it is read again with each word of four letters or more allowed to be one letter off a written word (two for a word of eight or more), and those hits come after every exact one with `close: true`. Numbers are never matched close. At most five of each with `more` (more exact matches) and a `seeAll` link to the list filtered by the same words, and nothing for fewer than two characters. `in` asks for one group alone, at up to fifty.",
  module: "M29",
  permissions: [],
  input: z.object({
    q: z.string().max(200),
    in: z.enum(["customers", "jobs", "invoices", "estimates", "addresses", "units", "notes", "pricebook", "people"]).optional(),
  }),
  output: z.object({
    q: z.string(),
    groups: z.array(z.object({
      /** `customers`, `jobs`, `invoices`, `estimates`, `addresses`, `units`, `notes`, `pricebook`, `people`, or `record:<key>` for a kind of record. */
      key: z.string(),
      label: z.string(),
      hits: z.array(z.object({
        id: Uuid, title: z.string(), detail: z.string().nullable(), href: z.string(),
        /** Found by a word a letter or two off one typed, not the word itself. Always after the exact hits. */
        close: z.boolean(),
      })),
      /** More exact matches than the hits shown. */
      more: z.boolean(),
      /** The list of every exact match, filtered by the same words; null when `in` already asked for the group alone. */
      seeAll: z.string().nullable(),
    })),
  }),
});

export const searchRoutes = { searchEverything } as const;
