import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * THE PROMISE THE COMPARISON PAGES MAKE
 *
 * `data:export` was in the permission catalogue and on the owner's role from the
 * first migration, checked by nothing, excused in the guard test with "export
 * exists per report; a whole-tenant export does not".
 *
 * It was the weakest excuse on that list. Portability is the central argument
 * this project makes against the incumbents, in detail, naming what their export
 * APIs leave behind. The answer here was "it is your Postgres instance", which
 * is true for somebody self hosting and false for a company on a hosted
 * deployment, and the operator API exists to make hosted deployments a thing.
 */

export const getExportManifest = defineRoute({
  method: "get",
  path: "/v1/export",
  summary: "Everything this company can take away, and what it cannot",
  description:
    "READ OFF THE DATABASE CATALOGUE, not off a list somebody maintains: every table carrying an organization is exportable, so a table added tomorrow is exportable tomorrow and nobody has to remember. The same mechanism the row level security sweep uses, because a hand maintained list is how a product ends up with one table missing from its export and nobody finding out for eighteen months. A row count per table is what makes an export CHECKABLE: somebody who pulls 14,812 customers and had 14,900 has a problem they can see. Every redacted column is named with the reason, and so is every table that sits outside the tenant, so the file's one hole is a statement rather than an omission a reader has to notice.",
  module: "M30",
  permissions: ["data:export"],
  idempotent: true,
  input: z.object({}),
  output: z.object({
    organizationId: Uuid,
    generatedAt: z.string(),
    tables: z.array(z.object({
      table: z.string(),
      rows: z.number().int(),
      key: z.array(z.string()),
      redacted: z.array(z.object({ column: z.string(), reason: z.string() })),
    })),
    totalRows: z.number().int(),
    outsideTheTenant: z.array(z.object({ table: z.string(), reason: z.string() })),
  }),
});

export const getExportPage = defineRoute({
  method: "get",
  path: "/v1/export/{table}",
  summary: "One page of one table",
  description:
    "KEYSET PAGINATION ON THE PRIMARY KEY, never an offset. An offset over a table somebody is still working in repeats and skips rows, and an export that silently does either is worse than no export: the company finds out when a customer is missing from the new system. The cursor is the previous page's last key, compared as a row with typed parameters, so a composite key works without this endpoint knowing which tables have one. Stop on `more: false` rather than on an empty page. Credentials do not leave: a live webhook token or a push token in an export is a breach in a file, and a hash of a short token is a cracking target. The columns held back are named on every page as well as in the manifest. Every page writes an audit line with the table and the row count, because 'when did somebody take a copy of our customer list' is the question an export has to be able to answer.",
  module: "M30",
  permissions: ["data:export"],
  idempotent: true,
  input: z.object({
    table: z.string().min(1).max(63),
    /** The previous page's cursor. One value per primary key column. */
    after: z.array(z.string().max(200)).max(8).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  output: z.object({
    table: z.string(),
    rows: z.array(z.record(z.unknown())),
    cursor: z.array(z.string()).nullable(),
    more: z.boolean(),
    redacted: z.array(z.string()),
  }),
});

export const exportRoutes = { getExportManifest, getExportPage } as const;
