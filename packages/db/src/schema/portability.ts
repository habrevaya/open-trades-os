import { pgTable, uuid, text, boolean, jsonb, integer, bigint, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";
import { organization, user } from "./tenancy";

/**
 * TAKING A COPY ON A CLOCK, AND PUTTING ONE BACK
 *
 * The whole company export is a promise that a company can leave. These three
 * tables are the two halves that make it a promise a company can rely on
 * without remembering to keep it: a copy written to a bucket of the company's
 * own on a schedule, and a copy loaded back into an empty company.
 */

/**
 * Where a company's copies go, and when.
 *
 * One per company. An S3 compatible bucket, named the way every other
 * connection here is named: the access key id in the clear, because it is an
 * identifier, and the secret key as the NAME of a secret in the deployment's
 * own store, never the secret. A copy of the whole company sent somewhere is
 * the most valuable thing this product writes, so the place it goes is the
 * owner's decision under `data:export`, the same permission as downloading it.
 */
export const backupDestination = pgTable("backup_destination", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** The service's address, such as https://s3.us-east-1.amazonaws.com or a MinIO or R2 endpoint. */
  endpoint: text("endpoint").notNull(),
  bucket: text("bucket").notNull(),
  region: text("region").notNull().default("us-east-1"),
  /** Put in front of every object name, such as `opentradesos/`. Empty for the top of the bucket. */
  prefix: text("prefix").notNull().default(""),
  accessKeyId: text("access_key_id").notNull(),
  /** The NAME of the secret holding the secret access key. Resolved like every `credentialRef`. */
  secretKeyRef: text("secret_key_ref").notNull(),
  /**
   * Addressed as endpoint/bucket/key rather than bucket.endpoint/key. Most
   * S3 compatible services other than Amazon want this, and Amazon still
   * takes it, so it is the default.
   */
  pathStyle: boolean("path_style").notNull().default(true),
  /** `daily`, `weekly` or `off`. Off keeps the destination for copies taken by hand. */
  frequency: text("frequency").notNull().default("daily"),
  /** The hour of the company's own day a copy starts, 0 to 23. */
  hour: integer("hour").notNull().default(2),
  /** For a weekly copy, the day: 0 is Sunday. */
  weekday: integer("weekday"),
  /** How many finished copies to keep. Older ones this product wrote are deleted from the bucket. */
  keep: integer("keep").notNull().default(14),
  /** When the next copy is due. Null when nothing is due. */
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  /** What the last check of the bucket said, so a wrong key shows on the screen rather than at 2am. */
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastCheckError: text("last_check_error"),
  updatedByUserId: uuid("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  orgIdx: uniqueIndex("backup_destination_org_idx").on(t.organizationId),
  dueIdx: index("backup_destination_due_idx").on(t.nextRunAt),
}));

/**
 * One copy written to the bucket, or one attempt at it.
 *
 * Kept after the object it names is pruned, with `prunedAt` set, so the list
 * of copies says what happened to each rather than silently getting shorter.
 */
export const backupRun = pgTable("backup_run", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  destinationId: uuid("destination_id").references(() => backupDestination.id, { onDelete: "set null" }),
  /** `schedule` or `person`. */
  trigger: text("trigger").notNull(),
  requestedByUserId: uuid("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** `running`, `succeeded` or `failed`. */
  status: text("status").notNull().default("running"),
  /** Which bucket it went to, said again so a copy is findable after the destination changes. */
  bucket: text("bucket").notNull(),
  objectKey: text("object_key").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  rows: integer("rows"),
  files: integer("files"),
  /** Why it failed, in the bucket's own words where it gave any. */
  error: text("error"),
  /** When the object was deleted from the bucket because newer copies were kept instead. */
  prunedAt: timestamp("pruned_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("backup_run_org_idx").on(t.organizationId, t.startedAt),
}));

/**
 * One attempt to load a copy into this company, checked or done.
 *
 * Written whatever happened, and written OUTSIDE the transaction that tried the
 * restore, so a refusal and a dry run leave their report behind even though
 * everything they tried was rolled back. A restore that went through writes
 * its row inside the same transaction, so the row and the restored company
 * are never one without the other.
 */
export const restoreRun = pgTable("restore_run", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  requestedByUserId: uuid("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** `upload` or `bucket`. */
  source: text("source").notNull(),
  /** The file's name as uploaded, or the object's key in the bucket. */
  sourceName: text("source_name").notNull(),
  /** A checksum of the whole file, so two attempts can be seen to be the same copy. */
  sourceSha256: text("source_sha256"),
  sourceBytes: bigint("source_bytes", { mode: "number" }),
  /** `ndjson` or `archive`, once the file was read far enough to tell. */
  format: text("format"),
  dryRun: boolean("dry_run").notNull(),
  /** `checked` (a dry run that would go through), `restored`, or `refused`. */
  outcome: text("outcome").notNull(),
  /** The whole report: counts per table, the people, what to set up again, and every refusal. */
  report: jsonb("report").$type<Record<string, unknown>>().notNull(),
  ...timestamps,
}, (t) => ({
  orgIdx: index("restore_run_org_idx").on(t.organizationId, t.createdAt),
}));

/* --------------------------------------------------------------- spreadsheets in */

/**
 * BRINGING IN A SPREADSHEET, FOR AN OWNER WITH NO PROGRAMMER
 *
 * The migration toolkit loads a company's history through the API, and a
 * company that has only a spreadsheet exported from wherever it was before had
 * nothing. These three tables are the screen's memory: the file as it came in,
 * row by row, what each row became, and the column mappings an owner saved so
 * the next file from the same place maps itself.
 *
 * The rows are loaded through the same services the API's creates are, so
 * nothing here is a second importer. What is kept is only what the screen
 * needs to show progress, to say why a row was refused, and to hand the
 * refused rows back as a file.
 */

/**
 * A mapping an owner saved: which column of a file from one place is which
 * field here, keyed on the file's headers so a second file with the same
 * headers maps itself.
 */
export const importMapping = pgTable("import_mapping", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** `customers`, `equipment`, `pricebook`, `jobs` or `invoices`. */
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  /** The file's headers, normalised and sorted, so the order of the columns does not matter. */
  headerKey: text("header_key").notNull(),
  /** A normalised header to the field it fills. A header that fills nothing is left out. */
  columns: jsonb("columns").$type<Record<string, string>>().notNull(),
  /** The name the rows' provenance is recorded under, so the next file finds what this one loaded. */
  source: text("source").notNull(),
  /** Whether the dates in files from this place are written day first. */
  dayFirst: boolean("day_first").notNull().default(false),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  nameIdx: uniqueIndex("import_mapping_name_idx").on(t.organizationId, t.kind, t.name),
  headerIdx: index("import_mapping_header_idx").on(t.organizationId, t.kind, t.headerKey),
}));

/**
 * One file, from upload to the last row loaded.
 *
 * `mapping`: the columns are being matched. `checking`: the rows are being
 * tried in a dry run, a batch at a time. `checked`: every row has an answer
 * and nothing is loaded yet. `loading`: batches are going in for real.
 * `finished`: every row that could go in has.
 */
export const importRun = pgTable("import_run", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  fileName: text("file_name").notNull(),
  /** What the rows' `externalRef` source is: the same name across files is how a job finds its customer. */
  source: text("source").notNull(),
  dayFirst: boolean("day_first").notNull().default(false),
  /** The header row, as written. */
  header: jsonb("header").$type<string[]>().notNull(),
  /** Per column, in the header's order, the field it fills or null for none. */
  columns: jsonb("columns").$type<Array<string | null>>().notNull(),
  mappingId: uuid("mapping_id").references(() => importMapping.id, { onDelete: "set null" }),
  status: text("status").notNull().default("mapping"),
  rowCount: integer("row_count").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("import_run_org_idx").on(t.organizationId, t.createdAt),
}));

/**
 * One row of the file, and what became of it.
 *
 * `waiting` until the dry run reaches it; then `ready` (it would load),
 * `already` (its provenance key is already here, so it is skipped rather than
 * loaded twice) or `refused` with the reason in words; and `loaded` once its
 * batch committed, with the record it became.
 */
export const importRow = pgTable("import_row", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => importRun.id, { onDelete: "cascade" }),
  /** Where it is in the file, counting the header as row one, so a person can find it. */
  rowNumber: integer("row_number").notNull(),
  /** The cells exactly as the file had them. Never evaluated, only read as text. */
  cells: jsonb("cells").$type<string[]>().notNull(),
  /** The id its record is given as `externalRef`, worked out when the columns are mapped. */
  sourceKey: text("source_key"),
  outcome: text("outcome").notNull().default("waiting"),
  reason: text("reason"),
  recordId: uuid("record_id"),
  /** What it became, in words: "Invoice 1042". */
  recordLabel: text("record_label"),
  ...timestamps,
}, (t) => ({
  rowIdx: uniqueIndex("import_row_number_idx").on(t.runId, t.rowNumber),
  outcomeIdx: index("import_row_outcome_idx").on(t.runId, t.outcome, t.rowNumber),
}));
