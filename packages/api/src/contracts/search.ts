import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * ONE BOX THAT FINDS THINGS
 *
 * A customer by their name, email or phone, a job by its number, and the
 * company's own records (a permit, a warranty registration) by their name or
 * any of their values. Each part is read through the same service, scope
 * and permission as its own list, so the box finds nothing its list would
 * not show: a part the caller may not read is left out, not refused.
 */
export const searchEverything = defineRoute({
  method: "get",
  path: "/v1/search",
  summary: "Find a customer, a job or one of the company's own records",
  description:
    "`q` is matched against a customer's name, email and phone (`customer:read`), a job's number (`job:read`) and each kind of record's names and values (`record:read` and the kind's own read permission). Every part is held to the caller's scope as its own list is, and a part the caller may not read is left out. At most five of each, and nothing for fewer than two characters.",
  module: "M29",
  permissions: [],
  input: z.object({ q: z.string().max(200) }),
  output: z.object({
    q: z.string(),
    groups: z.array(z.object({
      /** `customers`, `jobs`, or `record:<key>` for a kind of record. */
      key: z.string(),
      label: z.string(),
      hits: z.array(z.object({ id: Uuid, title: z.string(), detail: z.string().nullable(), href: z.string() })),
    })),
  }),
});

export const searchRoutes = { searchEverything } as const;
