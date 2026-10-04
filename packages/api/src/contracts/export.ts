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
    format: z.literal("opentradesos-export"),
    version: z.literal(1),
    organizationId: Uuid,
    generatedAt: z.string(),
    tables: z.array(z.object({
      table: z.string(),
      rows: z.number().int(),
      key: z.array(z.string()),
      redacted: z.array(z.object({ column: z.string(), reason: z.string() })),
      /** Columns that leave beside the rows rather than in them: a stored file's bytes. */
      apart: z.array(z.object({ column: z.string(), reason: z.string() })),
      /** Every column in the rows, in order, with Postgres's name for its type. */
      columns: z.array(z.object({
        name: z.string(), type: z.string(), nullable: z.boolean(), references: z.string().nullable(),
      })),
    })),
    totalRows: z.number().int(),
    /** The company's own row: name, address, timezone, currency, settings. */
    company: z.record(z.unknown()),
    /** Everybody with a membership, by name and address. Never how they sign in. */
    people: z.array(z.object({ userId: Uuid, email: z.string(), name: z.string().nullable() })),
    files: z.object({ count: z.number().int(), bytes: z.number().int() }),
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

export const getExportFile = defineRoute({
  method: "get",
  path: "/v1/export-files/{id}",
  summary: "One stored file, with its bytes",
  description:
    "A stored file's bytes are held apart from `stored_file`'s rows, because a page of a thousand photographs inside one JSON answer is gigabytes. Walk `stored_file` with the pages above and fetch each file here by its id. The bytes are base64, with the `sha256` they were stored under, so a copy can be checked as it is taken. The one place this product hands bytes back inside JSON: an export is read by a program that wants the file and its checksum in one answer. Each call writes an audit line.",
  module: "M30",
  permissions: ["data:export"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    storageKey: z.string(),
    sha256: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    bytes: z.string(),
  }),
});

/* ------------------------------------------------------- copies on a clock */

const Frequency = z.enum(["daily", "weekly", "off"]);

/** An S3 compatible bucket, named the way every connection is: the secret key by the name it is kept under. */
const Bucket = z.object({
  endpoint: z.string().min(1).max(300),
  bucket: z.string().min(1).max(63),
  region: z.string().min(1).max(40),
  prefix: z.string().max(200).default(""),
  accessKeyId: z.string().min(1).max(128),
  /** The NAME of the secret holding the secret access key in the deployment's store. Never the key. */
  secretKeyRef: z.string().min(1).max(200),
  /** endpoint/bucket/key rather than bucket.endpoint/key. Most services other than Amazon want this. */
  pathStyle: z.boolean().optional(),
});

const Destination = z.object({
  id: Uuid,
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  prefix: z.string(),
  accessKeyId: z.string(),
  secretKeyRef: z.string(),
  pathStyle: z.boolean(),
  frequency: Frequency,
  hour: z.number().int(),
  weekday: z.number().int().nullable(),
  keep: z.number().int(),
  nextRunAt: z.date().nullable(),
  lastCheckedAt: z.date().nullable(),
  lastCheckError: z.string().nullable(),
});

const BackupRun = z.object({
  id: Uuid,
  trigger: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  bucket: z.string(),
  objectKey: z.string(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
  sizeBytes: z.number().int().nullable(),
  rows: z.number().int().nullable(),
  files: z.number().int().nullable(),
  error: z.string().nullable(),
  prunedAt: z.date().nullable(),
});

export const getBackupDestination = defineRoute({
  method: "get",
  path: "/v1/backups/destination",
  summary: "Where this company's copies go, and when",
  description:
    "Null when copies are not being taken. The bucket is the company's own, so a copy survives the deployment going away, which for a company on somebody else's hosting is the thing worth protecting against.",
  module: "M30",
  permissions: ["data:export"],
  input: z.object({}),
  output: z.object({ destination: Destination.nullable() }),
});

export const putBackupDestination = defineRoute({
  method: "put",
  path: "/v1/backups/destination",
  summary: "Set where copies go and when",
  description:
    "The whole company, as the zip of spreadsheets, written to an S3 compatible bucket daily or weekly at an hour on the company's own clock, keeping the newest `keep` and deleting older ones this company wrote. The bucket is checked as it is saved, by writing a small object, reading it back and deleting it, and the answer says what the check found: a wrong key shows now rather than as a failed copy at two in the morning. Saved even when the check fails, with the failure kept on the destination until a check passes. The secret key is a NAME in the deployment's secret store, and a value that looks like the key itself is refused.",
  module: "M30",
  permissions: ["data:export"],
  idempotent: true,
  input: Bucket.extend({
    frequency: Frequency,
    hour: z.number().int().min(0).max(23),
    weekday: z.number().int().min(0).max(6).nullable().default(null),
    keep: z.number().int().min(1).max(365),
  }),
  output: z.object({
    destination: Destination,
    check: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  }),
});

export const deleteBackupDestination = defineRoute({
  method: "delete",
  path: "/v1/backups/destination",
  summary: "Stop taking copies",
  description: "Forgets the bucket. The copies already in it stay there; nothing here deletes them once the destination is gone.",
  module: "M30",
  permissions: ["data:export"],
  idempotent: true,
  input: z.object({}),
  output: z.object({ removed: z.boolean() }),
});

export const listBackups = defineRoute({
  method: "get",
  path: "/v1/backups",
  summary: "Every copy taken, and every attempt that failed",
  description:
    "Newest first, with the object each copy was written to, its size and row count, why a failed one failed, and when an old one was deleted to keep the newest. A record of what happened rather than a listing of the bucket.",
  module: "M30",
  permissions: ["data:export"],
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({ backups: z.array(BackupRun) }),
});

export const startBackup = defineRoute({
  method: "post",
  path: "/v1/backups",
  summary: "Take a copy now",
  description:
    "Queues a copy for the worker's next pass, seconds away, rather than holding the request open for as long as a company takes to write out. A retry with the same Idempotency-Key asks for one copy, not two.",
  module: "M30",
  permissions: ["data:export"],
  idempotent: true,
  input: z.object({}),
  output: z.object({ queued: z.boolean(), nextRunAt: z.string() }),
});

/* -------------------------------------------------------- putting it back */

const RestoreReport = z.object({
  dryRun: z.boolean(),
  outcome: z.enum(["checked", "restored", "refused"]),
  format: z.enum(["ndjson", "archive"]).nullable(),
  source: z.object({ organizationId: z.string().nullable(), name: z.string().nullable(), generatedAt: z.string().nullable() }),
  ids: z.enum(["kept", "renumbered"]).nullable(),
  tables: z.array(z.object({ table: z.string(), inCopy: z.number().int(), restored: z.number().int(), notes: z.array(z.string()) })),
  totalRows: z.number().int(),
  restoredRows: z.number().int(),
  files: z.object({ inCopy: z.number().int(), restored: z.number().int(), bytes: z.number().int() }),
  people: z.array(z.object({ email: z.string(), name: z.string().nullable(), outcome: z.string() })),
  setUpAgain: z.array(z.object({ table: z.string(), column: z.string(), rows: z.number().int(), reason: z.string() })),
  secretNames: z.array(z.string()),
  held: z.object({ connections: z.number().int(), webhooks: z.number().int() }),
  refusals: z.array(z.string()),
  notes: z.array(z.string()),
});

export const listRestorableCopies = defineRoute({
  method: "post",
  path: "/v1/restores/available",
  summary: "The copies in a bucket, for choosing one to restore",
  description:
    "Every .zip under the prefix, newest first. A POST because it carries the bucket's details in its body; it reads and changes nothing, so a retry is harmless. Needs `data:import`, the permission of the restore it is for.",
  module: "M30",
  permissions: ["data:import"],
  idempotent: true,
  input: Bucket,
  output: z.object({
    copies: z.array(z.object({ key: z.string(), sizeBytes: z.number().int(), lastModified: z.date().nullable() })),
  }),
});

export const restoreCopy = defineRoute({
  method: "post",
  path: "/v1/restores",
  summary: "Check a copy from a bucket, or restore it into this company",
  description:
    "Loads a whole company copy, the zip a scheduled copy writes or the newline delimited file, into THIS company, which has to be empty: a copy is never merged into a company with records of its own, because every merge decision would be somebody's invoice. All of it or none of it, in one transaction. With `dryRun: true` it does everything a restore does and rolls it back, so the counts and refusals it reports are what would happen. Ids are kept unless the company the copy came from is still on this deployment, in which case every record gets a new one, rewritten wherever it is referred to. The people in the copy come back as accounts with no password, sent a first-password link from Team; an address that already has an account with a company you do not run is refused. Whatever was held back when the copy was taken (webhook tokens, signing keys, link hashes) is listed to set up again, and nothing sends until somebody has looked: connections are set to need checking and webhooks are switched off, unless `keepSending` says otherwise. To restore a file on your own computer, upload it on the restore screen; to restore one too large to upload, put it in a bucket and restore it from there. A retry with the same Idempotency-Key answers with the restore that went through.",
  module: "M30",
  permissions: ["data:import"],
  idempotent: true,
  input: z.object({
    bucket: Bucket,
    key: z.string().min(1).max(1024),
    dryRun: z.boolean(),
    keepSending: z.boolean().optional(),
  }),
  output: z.object({ runId: Uuid, report: RestoreReport }),
});

export const listRestores = defineRoute({
  method: "get",
  path: "/v1/restores",
  summary: "Every attempt to restore a copy into this company",
  description:
    "Checked, restored or refused, newest first, each with its whole report: the counts per table, the people, what to set up again and every refusal. A dry run and a refusal are recorded although everything they tried was rolled back.",
  module: "M30",
  permissions: ["data:import"],
  input: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  output: z.object({
    restores: z.array(z.object({
      id: Uuid,
      source: z.string(),
      sourceName: z.string(),
      sourceSha256: z.string().nullable(),
      sourceBytes: z.number().int().nullable(),
      format: z.string().nullable(),
      dryRun: z.boolean(),
      outcome: z.string(),
      report: RestoreReport,
      requestedByUserId: z.string().nullable(),
      createdAt: z.date(),
    })),
  }),
});

export const exportRoutes = {
  getExportManifest, getExportPage, getExportFile,
  getBackupDestination, putBackupDestination, deleteBackupDestination, listBackups, startBackup,
  listRestorableCopies, restoreCopy, listRestores,
} as const;
