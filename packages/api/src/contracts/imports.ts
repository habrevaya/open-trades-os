import { z } from "zod";
import { imports as rules } from "@opentradesos/core";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * M30. A SPREADSHEET, BROUGHT IN BY AN OWNER
 *
 * The migration toolkit loads a company's history through the creates in
 * these contracts with an app token. An owner with a spreadsheet and no
 * programmer has this instead: upload the file, say which column is which,
 * check it, and load it a batch at a time. Every row is loaded through the
 * same service the API's own create for that record calls, with the row's
 * provenance as its `externalRef`, so the history rules, the imported numbers
 * and the refusal of a second copy are the API's, not a second importer's.
 *
 * All of it needs `data:import`, because loading a spreadsheet of invoices is
 * recording history, and the screen does not split a customer list from an
 * invoice file to let a lesser grant load one of them.
 */

const Kind = z.enum(rules.IMPORT_KINDS);
const Status = z.enum(["mapping", "checking", "checked", "loading", "finished"]);

/** The name a record's provenance is kept under: the same rule as `ExternalRef.source`. */
const Source = z.string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,49}$/, "Use lower case letters, numbers and dashes, like old-system")
  .refine((v) => v !== "recurring_schedule", "That name is written by this product itself");

const Counts = z.object({
  waiting: z.number().int(),
  ready: z.number().int(),
  already: z.number().int(),
  refused: z.number().int(),
  loaded: z.number().int(),
});

const RunSummary = z.object({
  id: Uuid,
  kind: Kind,
  fileName: z.string(),
  source: z.string(),
  status: Status,
  rows: z.number().int(),
  counts: Counts,
  createdAt: z.string().datetime(),
  checkedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});

const RowLine = z.object({
  row: z.number().int(),
  reason: z.string().nullable(),
  recordId: Uuid.nullable(),
  recordLabel: z.string().nullable(),
});

const RunDetail = RunSummary.extend({
  dayFirst: z.boolean(),
  header: z.array(z.string()),
  /** Per column, in the header's order, the field it fills or null. */
  columns: z.array(z.string().nullable()),
  /** The first value under each column, so a person can see what a column holds. */
  samples: z.array(z.string()),
  /** The fields a row of this kind can fill. */
  fields: z.array(z.object({ key: z.string(), label: z.string(), required: z.boolean() })),
  /** Why the mapping cannot be checked yet, each a sentence. Empty when it can. */
  problems: z.array(z.string()),
  /** The saved mapping this file was mapped with, if any. */
  mappingName: z.string().nullable(),
  /** The first rows as they will land: each field's value as it will be stored. */
  preview: z.array(z.object({ row: z.number().int(), values: z.record(z.string()) })),
  /** Every refused row, up to five hundred, with the reason in words. The download has them all. */
  refused: z.array(RowLine),
  /** Rows skipped because what they describe was already brought in, up to five hundred. */
  skipped: z.array(RowLine),
});

const Progress = z.object({
  id: Uuid,
  status: Status,
  rows: z.number().int(),
  counts: Counts,
  /** How many rows this call tried. Zero once there is nothing left to do. */
  tried: z.number().int(),
  /** Whether another call has more to do. */
  more: z.boolean(),
});

export const listImports = defineRoute({
  method: "get",
  path: "/v1/imports",
  summary: "The spreadsheets brought in, newest first",
  module: "M30",
  permissions: ["data:import"],
  input: z.object({}),
  output: z.object({ imports: z.array(RunSummary) }),
});

export const startImport = defineRoute({
  method: "post",
  path: "/v1/imports",
  summary: "Upload a spreadsheet of customers, equipment, price book items, past jobs or past invoices",
  description:
    "A CSV, as text, of at most five megabytes and ten thousand rows; a larger file is refused in words, to be split. Nothing is loaded: the rows are kept as they are, each column is guessed from its header (or mapped by a mapping saved from a file with the same headers), and the answer is what `GET /v1/imports/{id}` returns. A cell is never evaluated: one that starts with `=` is stored as the characters it holds.",
  module: "M30",
  permissions: ["data:import"],
  idempotent: true,
  input: z.object({
    kind: Kind,
    fileName: z.string().min(1).max(300),
    /** Capped well above the five megabytes the service takes, so a file over that is refused in words rather than by the schema. */
    csv: z.string().max(20_000_000),
  }),
  output: RunDetail,
});

export const getImport = defineRoute({
  method: "get",
  path: "/v1/imports/{id}",
  summary: "One spreadsheet: its columns, the first rows as they will land, and every row refused or skipped and why",
  module: "M30",
  permissions: ["data:import"],
  input: z.object({ id: Uuid }),
  output: RunDetail,
});

export const mapImport = defineRoute({
  method: "post",
  path: "/v1/imports/{id}/mapping",
  summary: "Say which column is which, and where the records came from",
  description:
    "Each column's field, in the header's order, or null for a column nothing reads. `source` is the name each row's provenance is recorded under: use the same name for every file from the same place, because that is how a job finds the customer a customers file brought in, and how a second upload of the same file finds what the first one loaded. With `saveAs`, the mapping is kept under that name, replacing one of the same name, and a later file with the same headers maps itself. Every row is read again and the check starts over. Refused once any row is loaded.",
  module: "M30",
  permissions: ["data:import"],
  /** Setting a state: the same mapping twice is the same mapping. */
  idempotent: true,
  input: z.object({
    id: Uuid,
    columns: z.array(z.string().max(40).nullable()).max(500),
    source: Source,
    dayFirst: z.boolean().default(false),
    saveAs: z.string().min(1).max(100).optional(),
  }),
  output: RunDetail,
});

export const checkImport = defineRoute({
  method: "post",
  path: "/v1/imports/{id}/check",
  summary: "Try the next batch of rows, and keep nothing",
  description:
    "The dry run every load starts with. The next hundred rows not yet tried go through the real loads in a transaction that is rolled back, each row on its own, and each is marked ready, already here (its provenance is, so it will be skipped rather than loaded twice) or refused with the reason in words. Call again while `more` is true. Nothing is written but the answers.",
  module: "M30",
  permissions: ["data:import"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Progress,
});

export const loadImport = defineRoute({
  method: "post",
  path: "/v1/imports/{id}/load",
  summary: "Load the next batch of checked rows",
  description:
    "Only once every row has been checked. The next hundred ready rows go in through the same creates as `POST /v1/customers`, `POST /v1/equipment`, `POST /v1/pricebook/items`, `POST /v1/jobs`, `POST /v1/invoices` and `POST /v1/payments`, in ONE transaction: all of the batch or none of it. A row refused now (something changed since the check) is marked refused with its reason and the rest of the batch is tried again without it, so a batch is never half loaded. Call again while `more` is true.",
  module: "M30",
  permissions: ["data:import"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Progress,
});

export const getImportRefusals = defineRoute({
  method: "get",
  path: "/v1/imports/{id}/refused",
  summary: "The refused rows as a file to fix and bring in again",
  description:
    "The file's own header and cells, with each row's place in the first file and why it was refused added at the end. A cell a spreadsheet would run as a formula is written as text.",
  module: "M30",
  permissions: ["data:import"],
  input: z.object({ id: Uuid }),
  output: z.object({ fileName: z.string(), rows: z.number().int(), csv: z.string() }),
});

export const listImportMappings = defineRoute({
  method: "get",
  path: "/v1/import-mappings",
  summary: "The column mappings saved by name",
  module: "M30",
  permissions: ["data:import"],
  input: z.object({}),
  output: z.object({
    mappings: z.array(z.object({
      id: Uuid,
      kind: Kind,
      name: z.string(),
      source: z.string(),
      dayFirst: z.boolean(),
      /** Normalised header to field. */
      columns: z.record(z.string()),
      updatedAt: z.string().datetime(),
    })),
  }),
});

export const deleteImportMapping = defineRoute({
  method: "delete",
  path: "/v1/import-mappings/{id}",
  summary: "Forget a saved mapping",
  description: "The files already mapped with it keep their columns.",
  module: "M30",
  permissions: ["data:import"],
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const importRoutes = {
  listImports, startImport, getImport, mapImport, checkImport, loadImport, getImportRefusals,
  listImportMappings, deleteImportMapping,
} as const;
