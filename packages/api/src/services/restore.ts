import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, automation, isSystem, portability, SYSTEM_USER_ID } from "@opentradesos/core";
import { audit, inTenant, guardedRead, NotFoundError, type ServiceContext } from "./context";
import { catalogue, CARRIED_COMPANY_COLUMNS, type Catalogued, type CatalogColumn, type Manifest } from "./export";
import { sha256 } from "./files";
import { remember, replayed } from "./once";
import { fileStorage } from "../storage";
import { openCopy, CopyError, type Copy } from "../portability/reader";

/**
 * PUTTING A COPY BACK
 *
 * The other half of "you own your data". A copy taken here, as the newline
 * delimited file or the zip of spreadsheets, is loaded into a fresh, empty
 * company: on another deployment when a company moves, or on this one beside
 * the original. All of it or none of it, in one transaction, and a dry run that
 * does everything a restore does and then rolls it back, so what it reports is
 * what would happen rather than a guess at it.
 *
 * ONLY INTO AN EMPTY COMPANY. A restore that merged a copy into a company with
 * its own customers would have to decide, record by record, which of two
 * versions of the truth to keep, and every one of those decisions would be
 * somebody's invoice. So it refuses, and says what is already there.
 *
 * IDS ARE KEPT WHEN THEY CAN BE, AND RENUMBERED WHEN THEY CANNOT. Keeping them
 * is what lets everything outside that remembered an id keep working after a
 * move: a connected app's mapping, a link in an email, a migration toolkit's
 * record of what it loaded. They cannot be kept when the company the copy came
 * from is still on this deployment, because the original holds every one of
 * them, and then every record gets a new one. Renumbering is by VALUE (see
 * core's `portability.remap`): any id anywhere in a row, in a uuid column, a
 * storage key or a jsonb blob, is replaced when it is the id of something in
 * the copy, which is what makes a renumbered company whole rather than a
 * company with references into the original.
 *
 * WHAT CANNOT COME BACK IS SAID, NOT SKIPPED. A copy carries no live secrets:
 * webhook tokens, signing keys and the hashes of links are held back when it is
 * taken. Each one becomes a thing to set up again on the report, with what to
 * do; one the database requires is filled with a fresh random value that
 * matches nothing, so the record comes back and the old link stays dead.
 *
 * NOTHING IS SENT. A restored company's connections are set to need checking
 * and its webhooks are switched off, unless the person restoring says
 * otherwise, because a company restored beside its original would otherwise
 * text the same customers through the same carrier account the moment the
 * worker noticed a queued message.
 */

export interface RestoreReport {
  dryRun: boolean;
  outcome: "checked" | "restored" | "refused";
  format: "ndjson" | "archive" | null;
  source: { organizationId: string | null; name: string | null; generatedAt: string | null };
  /** `kept` when the copy's ids are this company's ids now, `renumbered` when every record got a new one. */
  ids: "kept" | "renumbered" | null;
  tables: { table: string; inCopy: number; restored: number; notes: string[] }[];
  totalRows: number;
  restoredRows: number;
  files: { inCopy: number; restored: number; bytes: number };
  people: { email: string; name: string | null; outcome: string }[];
  /** Everything held back when the copy was taken, by table and column, with what to do about it. */
  setUpAgain: { table: string; column: string; rows: number; reason: string }[];
  /** Names of secrets this company's connections read, which this deployment's store needs under the same names. */
  secretNames: string[];
  held: { connections: number; webhooks: number };
  refusals: string[];
  notes: string[];
}

const emptyReport = (dryRun: boolean): RestoreReport => ({
  dryRun, outcome: "refused", format: null,
  source: { organizationId: null, name: null, generatedAt: null }, ids: null,
  tables: [], totalRows: 0, restoredRows: 0, files: { inCopy: 0, restored: 0, bytes: 0 },
  people: [], setUpAgain: [], secretNames: [], held: { connections: 0, webhooks: 0 },
  refusals: [], notes: [],
});

/** Stops the transaction and carries the report out. Thrown for a refusal, and to roll back a dry run. */
class Stop extends Error {
  constructor(readonly report: RestoreReport) {
    super("restore stopped");
  }
}

/**
 * Tables that say what happened TO this company rather than what it holds, so
 * they do not count against "empty": the audit trail, which records the very
 * attempts to restore, and the record of those attempts.
 */
const BOOKKEEPING = new Set(["audit_log", "restore_run"]);

const NIL = SYSTEM_USER_ID;

/* ----------------------------------------------------------- the entry */

export interface RestoreInput {
  /** A copy on this server's disk: an upload spooled to a temporary file, or an object fetched from a bucket. */
  path: string;
  source: "upload" | "bucket";
  /** What the person knows it as: the uploaded file's name, or the object's key. */
  sourceName: string;
  dryRun: boolean;
  /** Leave connections and webhooks as the copy had them. Off unless asked for. */
  keepSending?: boolean | undefined;
}

export interface RestoreResult {
  runId: string;
  report: RestoreReport;
}

/**
 * Check a copy, or load it.
 *
 * `data:import`, because loading a copy writes history: invoices issued years
 * ago, payments on their dates, the whole ledger. It is the owner's, as the
 * migration's power to back date is.
 */
export async function restore(ctx: ServiceContext, input: RestoreInput): Promise<RestoreResult> {
  assertCan(ctx.actor, "data:import");
  const report = emptyReport(input.dryRun);
  const fingerprint = await fingerprintOf(input.path);

  /**
   * A retry of a restore that went through answers with the same run, rather
   * than being refused because the company now has records, which is what a
   * phone on a bad connection pressing the button twice deserves.
   */
  if (!input.dryRun && ctx.idempotencyKey) {
    const seen = await inTenant(ctx, (tx) => replayed<RestoreResult>(tx, ctx, "data_restore"));
    if (seen) return seen;
  }

  let copy: Copy | null = null;
  try {
    copy = await openCopy(input.path);
  } catch (error) {
    if (!(error instanceof CopyError)) throw error;
    report.refusals.push(error.message);
  }

  let restoredRun: RestoreResult | null = null;
  if (copy) {
    report.format = copy.format;
    try {
      restoredRun = await inTenant(ctx, async (tx) => {
        await load(tx, ctx, copy!, input, report);
        if (report.refusals.length > 0) throw new Stop(report);
        if (input.dryRun) {
          report.outcome = "checked";
          throw new Stop(report);
        }
        report.outcome = "restored";
        const [run] = await tx.insert(schema.restoreRun).values({
          organizationId: ctx.actor.organizationId,
          requestedByUserId: isSystem(ctx.actor) ? null : ctx.actor.userId,
          source: input.source, sourceName: input.sourceName.slice(0, 500),
          sourceSha256: fingerprint.sha256, sourceBytes: fingerprint.size,
          format: copy!.format, dryRun: false, outcome: "restored",
          report: report as unknown as Record<string, unknown>,
        }).returning({ id: schema.restoreRun.id });
        await audit(tx, ctx, "data.restored", "organization", ctx.actor.organizationId, null, {
          runId: run!.id, source: input.source, sourceName: input.sourceName, rows: report.restoredRows,
          files: report.files.restored, ids: report.ids, from: report.source.organizationId,
        });
        const result = { runId: run!.id, report };
        await remember(tx, ctx, "data_restore", run!.id, result);
        return result;
      });
    } catch (error) {
      if (!(error instanceof Stop)) {
        /**
         * Anything the load did not foresee, said as a refusal rather than a
         * server error: the transaction has rolled back, the company is as it
         * was, and the person restoring needs the database's words to know why.
         */
        report.refusals.push(`The copy could not be loaded: ${describe(error)}`);
      }
    } finally {
      await copy.close().catch(() => undefined);
    }
  }
  if (restoredRun) return restoredRun;

  if (report.refusals.length > 0) report.outcome = "refused";
  /**
   * A dry run and a refusal leave their report behind, written after the
   * rollback in a transaction of their own: the attempt is worth remembering
   * even though nothing it tried was kept.
   */
  const runId = await inTenant(ctx, async (tx) => {
    const [run] = await tx.insert(schema.restoreRun).values({
      organizationId: ctx.actor.organizationId,
      requestedByUserId: isSystem(ctx.actor) ? null : ctx.actor.userId,
      source: input.source, sourceName: input.sourceName.slice(0, 500),
      sourceSha256: fingerprint.sha256, sourceBytes: fingerprint.size,
      format: report.format, dryRun: input.dryRun, outcome: report.outcome,
      report: report as unknown as Record<string, unknown>,
    }).returning({ id: schema.restoreRun.id });
    await audit(tx, ctx, report.outcome === "checked" ? "data.restore.checked" : "data.restore.refused",
      "organization", ctx.actor.organizationId, null, {
        runId: run!.id, source: input.source, sourceName: input.sourceName, refusals: report.refusals.slice(0, 10),
      });
    return run!.id;
  });
  return { runId, report };
}

async function fingerprintOf(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer);
  return { sha256: hash.digest("hex"), size: (await stat(path)).size };
}

/** The database's own words for what went wrong, with the table it was in when it has one. */
function describe(error: unknown): string {
  const e = error as { message?: string; detail?: string; table_name?: string; code?: string; cause?: unknown };
  const inner = (e.cause ?? e) as typeof e;
  const parts = [inner.message ?? String(error)];
  if (inner.detail) parts.push(inner.detail);
  return parts.join(" ");
}

/* --------------------------------------------------------- the loading */

/** Everything the load needs to know about one table, decided before its first row. */
interface Plan {
  entry: Catalogued;
  /** The columns written, in order. Generated ones and ones the copy does not hold are left to the database. */
  write: CatalogColumn[];
  /** Held back when the copy was taken: filled with nothing, or with a fresh value when the column must have one. */
  redacted: Map<string, string>;
  /** Points at a person. A person not in the copy is not on this deployment, so the reference is cleared. */
  userColumns: CatalogColumn[];
  /** Points at something outside the company that a copy does not carry, such as a franchise group. */
  outsideColumns: CatalogColumn[];
  /** Loaded empty and filled once every row of the table is in. */
  deferred: CatalogColumn[];
  /** Values that must be unique across the whole deployment, given new ones when renumbering. */
  unique: CatalogColumn[];
  /** Columns the copy holds that this version does not have. */
  unknown: string[];
  jsonColumns: Set<string>;
}

async function load(
  tx: Database, ctx: ServiceContext, copy: Copy, input: RestoreInput, report: RestoreReport,
): Promise<void> {
  const manifest = copy.manifest;
  report.source = {
    organizationId: manifest.organizationId,
    name: typeof manifest.company["name"] === "string" ? manifest.company["name"] : null,
    generatedAt: manifest.generatedAt || null,
  };
  report.totalRows = manifest.totalRows;
  report.files.inCopy = copy.files.size;

  /**
   * A copy without its last line or entry stopped part way, whatever the
   * browser said, and loading it would be loading part of a company.
   */
  if (!copy.complete) {
    report.refusals.push("The copy stops part way: it does not end with the line (or the complete.json) every finished copy ends with. Take the copy again.");
    return;
  }

  await tx.execute(sql`set local time zone 'UTC'`);
  const tables = await catalogue(tx);

  /* ---- 1. Empty, or nothing. */
  const held = await recordsHeld(tx, ctx, tables);
  if (held.length > 0) {
    report.refusals.push(`This company already has records, and a copy is only restored into an empty one: ${held.join(", ")}. Make a new company and restore into that.`);
    return;
  }

  /* ---- 2. The copy against this version. */
  for (const table of manifest.tables) {
    if (!tables.has(table.table) && table.rows > 0) {
      report.refusals.push(`The copy holds ${table.rows} rows of ${table.table}, which this version does not have. It was taken from a newer version; update this one first.`);
    }
    const counted = copy.counted(table.table);
    if (counted !== null && counted !== table.rows) {
      report.refusals.push(`The copy's manifest says ${table.table} has ${table.rows} rows and the file holds ${counted}. The copy has been changed since it was taken.`);
    }
  }
  for (const table of manifest.tables) {
    for (const column of table.redacted) {
      if (table.rows === 0) continue;
      report.setUpAgain.push({ table: table.table, column: column.column, rows: table.rows, reason: column.reason });
    }
  }
  if (report.refusals.length > 0) return;

  /* ---- 3. The people. */
  const people = await tx.execute<{ old_user_id: string | null; email: string; user_id: string | null; outcome: string }>(
    sql`select * from app.restore_people(${JSON.stringify(manifest.people)}::jsonb)`,
  );
  const lookup = new Map<string, string>();
  lookup.set(manifest.organizationId.toLowerCase(), ctx.actor.organizationId);
  lookup.set(NIL, NIL);
  const knownUsers = new Set<string>([ctx.actor.userId]);
  let me: string | null = null;
  for (const person of people) {
    const named = manifest.people.find((p) => p.userId === person.old_user_id);
    report.people.push({ email: person.email, name: named?.name ?? null, outcome: person.outcome });
    if (person.outcome === "elsewhere") {
      report.refusals.push(`${person.email} already has an account on this deployment with a company you do not run. A copy is not allowed to add somebody's existing account to a company; they need to give you another address, or whoever runs this deployment can move them.`);
      continue;
    }
    if (!person.user_id || !person.old_user_id) continue;
    lookup.set(person.old_user_id.toLowerCase(), person.user_id);
    knownUsers.add(person.user_id);
    if (person.outcome === "you") me = person.old_user_id.toLowerCase();
  }
  if (manifest.people.length === 0) {
    report.notes.push("The copy names nobody who worked in the company, so nobody but you is restored. A copy taken before people were carried in it restores without them.");
  }
  if (report.refusals.length > 0) return;

  /* ---- 4. Kept ids, or new ones. */
  const [present] = await tx.execute<{ present: boolean }>(
    sql`select app.restore_source_present(${manifest.organizationId}::uuid) as present`,
  );
  const renumber = Boolean(present?.present) && manifest.organizationId !== ctx.actor.organizationId;
  report.ids = renumber ? "renumbered" : "kept";
  if (renumber) {
    report.notes.push("The company this copy was taken from is still on this deployment and holds every id in it, so every record was given a new id. Links and integrations that remembered the old ids point at the original.");
  }

  /* ---- 5. How each table is written. */
  const order = portability.loadOrder(
    [...tables.keys()].sort(),
    [...tables.values()].flatMap((entry) => entry.columns
      .filter((column) => column.references && tables.has(column.references) && column.name !== "organization_id")
      .map((column) => ({ table: entry.table, column: column.name, references: column.references!, nullable: column.nullable }))),
  );
  const uniques = renumber ? await globallyUnique(tx) : new Map<string, Set<string>>();
  const plans = new Map<string, Plan>();
  for (const table of manifest.tables) {
    const entry = tables.get(table.table);
    if (!entry) continue;
    const copyColumns = await copy.columnsOf(table.table) ?? table.columns.map((c) => c.name);
    const redacted = new Map(table.redacted.map((r) => [r.column, r.reason]));
    const writable = entry.columns.filter((c) => !c.generated);
    plans.set(table.table, {
      entry,
      write: writable.filter((c) => copyColumns.includes(c.name) || redacted.has(c.name)
        || (table.table === "stored_file" && (c.name === "bytes" || c.name === "stored_in" || c.name === "object_key"))),
      redacted,
      userColumns: entry.columns.filter((c) => c.references === "user"),
      outsideColumns: entry.columns.filter((c) => c.references !== null && c.references !== "user"
        && c.references !== "organization" && !tables.has(c.references)),
      deferred: order.deferred.filter((k) => k.table === table.table)
        .map((k) => entry.columns.find((c) => c.name === k.column)!),
      unique: entry.columns.filter((c) => uniques.get(table.table)?.has(c.name)),
      unknown: copyColumns.filter((name) => !entry.columns.some((c) => c.name === name)),
      jsonColumns: new Set(entry.columns.filter((c) => c.type === "jsonb" || c.type === "json").map((c) => c.name)),
    });
  }

  /* ---- 6. The person restoring keeps their own membership. */
  const myMembership = await mergeMe(tx, ctx, copy, me, lookup);

  /* ---- 7. Every id that gets a new one, before any row that mentions it is written. */
  const ids = renumber ? await renumberAll(tx, copy, plans, lookup) : null;
  const find = async (values: Set<string>): Promise<(id: string) => string | undefined> => {
    if (!ids) return (id) => lookup.get(id);
    const wanted = [...values].filter((v) => !lookup.has(v));
    const found = new Map<string, string>();
    for (let i = 0; i < wanted.length; i += 5000) {
      const rows = await tx.execute<{ old: string; new: string }>(
        sql`select old::text as old, new::text as new from restore_id_map where old = any(${sql.param(wanted.slice(i, i + 5000))}::uuid[])`,
      );
      for (const row of rows) found.set(row.old, row.new);
    }
    return (id) => lookup.get(id) ?? found.get(id);
  };

  /* ---- 8. What a new company is born with, which the copy brings its own of. */
  await clearStarters(tx);

  /* ---- 9. The rows, table by table, in load order. */
  const storage = fileStorage();
  for (const table of order.order) {
    const plan = plans.get(table);
    const described = manifest.tables.find((t) => t.table === table);
    if (!plan || !described) continue;
    const line = { table, inCopy: 0, restored: 0, notes: [] as string[] };
    const dropped = new Map<string, number>();
    const cleared = new Map<string, number>();
    const pendingDeferred: Record<string, unknown>[] = [];

    for await (const batch of copy.rows(table)) {
      line.inCopy += batch.rows.length;
      const found = new Set<string>();
      for (const row of batch.rows) portability.uuidsIn(row, found);
      const map = await find(found);

      const out: Record<string, unknown>[] = [];
      for (const raw of batch.rows) {
        for (const name of plan.unknown) {
          if (raw[name] !== null && raw[name] !== undefined) {
            report.refusals.push(`The copy has values in ${table}.${name}, which this version does not have. It was taken from a newer version; update this one first.`);
            throw new Stop(report);
          }
        }
        const row: Record<string, unknown> = {};
        for (const column of plan.write) {
          let value = raw[column.name];
          if (value === undefined) value = null;
          if (batch.textual && value !== null && plan.jsonColumns.has(column.name)) value = JSON.parse(value as string);
          row[column.name] = value;
        }
        const originalKey = typeof raw["storage_key"] === "string" ? raw["storage_key"] : null;

        for (const [column, reason] of plan.redacted) {
          const target = plan.entry.columns.find((c) => c.name === column);
          if (!target) continue;
          if (target.nullable) row[column] = null;
          else if (target.type === "text") row[column] = randomBytes(32).toString("hex");
          else {
            report.refusals.push(`${table}.${column} was held back from the copy (${reason}) and this version requires a value for it that cannot be made up.`);
            throw new Stop(report);
          }
        }
        for (const column of plan.unique) {
          const value = row[column.name];
          if (typeof value === "string" && !plan.redacted.has(column.name)) row[column.name] = freshLike(value);
        }

        const mapped = portability.remap(row, map) as Record<string, unknown>;

        let drop: string | null = null;
        for (const column of plan.userColumns) {
          const value = mapped[column.name];
          if (typeof value !== "string" || knownUsers.has(value)) continue;
          if (column.nullable) {
            mapped[column.name] = null;
            cleared.set(column.name, (cleared.get(column.name) ?? 0) + 1);
          } else drop = `${column.name} names somebody who is not in the copy`;
        }
        for (const column of plan.outsideColumns) {
          const value = mapped[column.name];
          if (value === null || value === undefined) continue;
          if (column.nullable) {
            mapped[column.name] = null;
            cleared.set(column.name, (cleared.get(column.name) ?? 0) + 1);
          } else drop = `it belongs to a ${column.references!.replace(/_/g, " ")}, which a copy does not carry`;
        }
        if (drop) {
          dropped.set(drop, (dropped.get(drop) ?? 0) + 1);
          continue;
        }
        if (table === "membership" && myMembership && raw["id"] === myMembership.exported) continue;

        for (const column of plan.deferred) {
          if (mapped[column.name] !== null && mapped[column.name] !== undefined) {
            pendingDeferred.push({ id: mapped["id"], [column.name]: mapped[column.name] });
            mapped[column.name] = null;
          }
        }
        if (table === "stored_file") {
          await placeFile(copy, storage, input.dryRun, raw, originalKey, mapped, report);
        }
        out.push(mapped);
      }

      if (table === "stored_file") {
        // Bytes go a few at a time, so one statement never carries a gigabyte of photographs.
        let chunk: Record<string, unknown>[] = [];
        let size = 0;
        for (const row of out) {
          chunk.push(row);
          size += typeof row["bytes"] === "string" ? (row["bytes"] as string).length : 0;
          if (size > 32 * 1024 * 1024) {
            await insertRows(tx, plan, chunk);
            chunk = [];
            size = 0;
          }
        }
        if (chunk.length > 0) await insertRows(tx, plan, chunk);
      } else if (out.length > 0) {
        await insertRows(tx, plan, out);
      }
      line.restored += out.length;
    }

    if (myMembership && table === "membership") await myMembership.apply(tx, plan);
    for (let i = 0; i < pendingDeferred.length; i += 500) {
      await fillDeferred(tx, plan, pendingDeferred.slice(i, i + 500));
    }

    if (line.inCopy !== described.rows) {
      report.refusals.push(`The copy's manifest says ${table} has ${described.rows} rows and the file holds ${line.inCopy}. The copy has been changed since it was taken.`);
    }
    for (const [why, n] of dropped) line.notes.push(`${n} not restored: ${why}.`);
    for (const [column, n] of cleared) line.notes.push(`${column} cleared on ${n}, because it named somebody or something not in the copy.`);
    if (line.inCopy > 0 || line.notes.length > 0) report.tables.push(line);
    report.restoredRows += line.restored;
    if (report.refusals.length > 0) return;
  }
  for (const table of manifest.tables) {
    if (!plans.has(table.table) || order.order.includes(table.table)) continue;
    report.notes.push(`${table.table} was not loaded.`);
  }

  /* ---- 10. The company itself. */
  await restoreCompany(tx, ctx, manifest, lookup);

  /* ---- 11. Nothing sends until somebody has looked. */
  report.secretNames = await secretNames(tx);
  if (!input.keepSending) report.held = await holdSending(tx);

  /**
   * ---- 12. The deferred checks, now rather than at commit. The ledger's
   * balance check runs at the end of the transaction, which a dry run never
   * reaches; asking for it here means a dry run finds an unbalanced copy too.
   */
  await tx.execute(sql`set constraints all immediate`);
}

/* ------------------------------------------------------------- the pieces */

/**
 * What this company already holds that would make a restore a merge.
 *
 * Everything counts except the bookkeeping above, the restoring person's own
 * membership, and the starter automations every new company is given on the
 * day it signs up (until one of them has run), because the copy brings the
 * company's own.
 */
async function recordsHeld(tx: Database, ctx: ServiceContext, tables: Map<string, Catalogued>): Promise<string[]> {
  const names = [...tables.keys()].filter((name) => !BOOKKEEPING.has(name)).sort();
  const starters = automation.TEMPLATES.filter((t) => t.onForNewCompanies).map((t) => t.key);
  const parts = names.map((name) => {
    const id = sql.identifier(name);
    if (name === "membership") {
      return sql`select ${name} as t, count(*)::int as n from ${id} where user_id <> ${ctx.actor.userId}`;
    }
    if (name === "workflow") {
      return sql`select ${name} as t, count(*)::int as n from ${id} w
        where not (w.template_key = any(${sql.param(starters)}::text[]) and not exists (select 1 from workflow_run r where r.workflow_id = w.id))`;
    }
    if (name === "workflow_version" || name === "workflow_schedule") {
      return sql`select ${name} as t, count(*)::int as n from ${id} v
        where not exists (select 1 from workflow w where w.id = v.workflow_id
          and w.template_key = any(${sql.param(starters)}::text[]) and not exists (select 1 from workflow_run r where r.workflow_id = w.id))`;
    }
    return sql`select ${name} as t, count(*)::int as n from ${id}`;
  });
  const rows = await tx.execute<{ t: string; n: number }>(sql.join(parts, sql` union all `));
  return rows.filter((row) => row.n > 0).map((row) => `${row.n} ${row.t.replace(/_/g, " ")}`);
}

/** The starter automations a new company was born with, gone before the copy's own arrive. */
async function clearStarters(tx: Database): Promise<void> {
  const starters = automation.TEMPLATES.filter((t) => t.onForNewCompanies).map((t) => t.key);
  if (starters.length === 0) return;
  await tx.execute(sql`
    delete from workflow w
    where w.template_key = any(${sql.param(starters)}::text[])
      and not exists (select 1 from workflow_run r where r.workflow_id = w.id)
  `);
}

/**
 * Columns whose values must be unique across the whole deployment rather than
 * within one company: a hosted form's public address, a mail piece's printed
 * code. Read off the catalogue (a unique index that names neither the company
 * nor any id) so the next one is found without a list.
 */
async function globallyUnique(tx: Database): Promise<Map<string, Set<string>>> {
  const rows = await tx.execute<{ table_name: string; column_name: string }>(sql`
    select c.relname as table_name, min(a.attname) as column_name
    from pg_index x
    join pg_class c on c.oid = x.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any(x.indkey)
    where n.nspname = 'public' and x.indisunique and not x.indisprimary
      and exists (select 1 from pg_attribute o where o.attrelid = c.oid and o.attname = 'organization_id')
    group by x.indexrelid, c.relname
    having count(*) = 1
       and bool_and(a.attname <> 'organization_id')
       and bool_and(format_type(a.atttypid, a.atttypmod) <> 'uuid')
  `);
  const out = new Map<string, Set<string>>();
  for (const row of rows) out.set(row.table_name, (out.get(row.table_name) ?? new Set()).add(row.column_name));
  return out;
}

/** A new value in the same alphabet and length as the old, so a printed code still looks like one. */
function freshLike(value: string): string {
  const alphabet = /^[0-9a-f]+$/.test(value) ? "0123456789abcdef"
    : /^[A-Z0-9]+$/.test(value) ? "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
      : "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(Math.max(value.length, 8));
  let out = "";
  for (let i = 0; i < Math.max(value.length, 8); i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/**
 * The membership of the person restoring, which this company already has.
 *
 * The copy's row for them is not inserted (their membership exists, and two
 * would be one person twice); its id is mapped to the existing one so their
 * technician record and everything else that names it still find it; and its
 * settings are copied onto the existing row, except the role, which stays
 * owner, because a restore that demoted the person doing it would lock them out
 * of the company they just restored.
 */
async function mergeMe(
  tx: Database, ctx: ServiceContext, copy: Copy, me: string | null, lookup: Map<string, string>,
): Promise<{ exported: string; apply: (tx: Database, plan: Plan) => Promise<void> } | null> {
  if (!me) return null;
  let exported: Record<string, unknown> | null = null;
  for await (const batch of copy.rows("membership")) {
    exported = batch.rows.find((row) => typeof row["user_id"] === "string" && (row["user_id"] as string).toLowerCase() === me) ?? exported;
  }
  if (!exported || typeof exported["id"] !== "string") return null;
  const [mine] = await tx.select({ id: schema.membership.id }).from(schema.membership)
    .where(eq(schema.membership.userId, ctx.actor.userId)).limit(1);
  if (!mine) return null;
  lookup.set((exported["id"] as string).toLowerCase(), mine.id);
  const row = exported;
  return {
    exported: row["id"] as string,
    apply: async (inner, plan) => {
      const keep = new Set(["id", "organization_id", "user_id", "role", "role_id", "active", "deleted_at"]);
      const columns = plan.write.filter((c) => !keep.has(c.name) && row[c.name] !== undefined);
      if (columns.length === 0) return;
      const values: Record<string, unknown> = {};
      for (const column of columns) {
        const value = row[column.name];
        values[column.name] = typeof value === "string" && plan.jsonColumns.has(column.name) && copy.format === "archive"
          ? JSON.parse(value) : value;
      }
      const mapped = portability.remap(values, (id) => lookup.get(id)) as Record<string, unknown>;
      await inner.execute(sql`
        update membership m set ${sql.join(columns.map((c) => sql`${sql.identifier(c.name)} = s.${sql.identifier(c.name)}`), sql`, `)}
        from jsonb_populate_record(null::membership, ${JSON.stringify(mapped)}::jsonb) s
        where m.id = ${mine.id}
      `);
    },
  };
}

/**
 * Give every id in the copy a new one, before any row is written.
 *
 * Every value in a uuid column of every table, not only the primary keys,
 * because some ids name a group rather than a row (the two halves of a ledger
 * transaction share one) and the original holds those too. The people, the
 * company and the restoring person's membership were mapped already and keep
 * their mapping. Kept in a temporary table rather than in memory, because a
 * large company is millions of ids.
 */
async function renumberAll(
  tx: Database, copy: Copy, plans: Map<string, Plan>, lookup: Map<string, string>,
): Promise<true> {
  await tx.execute(sql`create temporary table restore_id_map (old uuid primary key, new uuid not null) on commit drop`);
  const fixed = [...lookup.entries()];
  for (let i = 0; i < fixed.length; i += 1000) {
    const part = fixed.slice(i, i + 1000);
    await tx.execute(sql`
      insert into restore_id_map (old, new)
      select * from unnest(${sql.param(part.map(([old]) => old))}::uuid[], ${sql.param(part.map(([, now]) => now))}::uuid[])
      on conflict do nothing
    `);
  }
  for (const [table, plan] of plans) {
    const columns = plan.entry.columns.filter((c) => (c.type === "uuid" || c.type === "uuid[]")
      && c.name !== "organization_id" && c.references !== "user"
      && !plan.outsideColumns.includes(c));
    if (columns.length === 0) continue;
    for await (const batch of copy.rows(table)) {
      const found = new Set<string>();
      for (const row of batch.rows) {
        for (const column of columns) {
          const value = row[column.name];
          if (typeof value === "string") portability.uuidsIn(value, found);
          else if (Array.isArray(value)) portability.uuidsIn(value, found);
        }
      }
      found.delete(NIL);
      const list = [...found];
      for (let i = 0; i < list.length; i += 5000) {
        await tx.execute(sql`
          insert into restore_id_map (old, new)
          select old, gen_random_uuid() from unnest(${sql.param(list.slice(i, i + 5000))}::uuid[]) as old
          on conflict do nothing
        `);
      }
    }
  }
  return true;
}

/**
 * Rows in through Postgres's own input functions.
 *
 * `jsonb_populate_recordset` reads each value as the column's type, from the
 * text a CSV holds or the JSON the other format holds, which is exactly how the
 * export wrote them. The columns named are the ones the copy carried; any other
 * column takes its default, which is what lets a copy from an older version
 * load into a newer one.
 */
async function insertRows(tx: Database, plan: Plan, rows: Record<string, unknown>[]): Promise<void> {
  const table = sql.identifier(plan.entry.table);
  const columns = sql.join(plan.write.map((c) => sql.identifier(c.name)), sql`, `);
  const payload = JSON.stringify(rows);
  await tx.execute(sql`
    insert into ${table} (${columns})
    select ${columns} from jsonb_populate_recordset(null::${table}, ${payload}::jsonb)
  `);
  /**
   * A trigger that runs before each insert may change what was written: a
   * job's branch is filled from whoever is signed in when it has none. A
   * restore is of what the copy says, so the copy's values are put back.
   */
  if (plan.entry.insertTrigger && plan.entry.key.length === 1) {
    const key = sql.identifier(plan.entry.key[0]!.column);
    const set = plan.write.filter((c) => c.name !== plan.entry.key[0]!.column && !plan.deferred.includes(c));
    if (set.length === 0) return;
    await tx.execute(sql`
      update ${table} t set ${sql.join(set.map((c) => sql`${sql.identifier(c.name)} = s.${sql.identifier(c.name)}`), sql`, `)}
      from jsonb_populate_recordset(null::${table}, ${payload}::jsonb) s
      where t.${key} = s.${key}
    `);
  }
}

/** A table's references to itself, filled in once every row of it is there. */
async function fillDeferred(tx: Database, plan: Plan, rows: Record<string, unknown>[]): Promise<void> {
  const table = sql.identifier(plan.entry.table);
  for (const column of plan.deferred) {
    const these = rows.filter((row) => row[column.name] !== undefined);
    if (these.length === 0) continue;
    const id = sql.identifier(column.name);
    await tx.execute(sql`
      update ${table} t set ${id} = s.${id}
      from jsonb_populate_recordset(null::${table}, ${JSON.stringify(these)}::jsonb) s
      where t.id = s.id
    `);
  }
}

/**
 * A stored file's bytes, from the copy into wherever this deployment keeps
 * files, checked against the checksum the row carries.
 *
 * A file whose bytes do not match is refused, because it is not the file the
 * company had. In a dry run nothing is written to a bucket: the bytes are read
 * and checked, which is the part that can fail, and the row is pointed at
 * where they would go.
 */
async function placeFile(
  copy: Copy, storage: ReturnType<typeof fileStorage>, dryRun: boolean,
  raw: Record<string, unknown>, originalKey: string | null, row: Record<string, unknown>, report: RestoreReport,
): Promise<void> {
  const deleted = raw["deleted_at"] !== null && raw["deleted_at"] !== undefined;
  if (deleted || !originalKey) {
    row["stored_in"] = "postgres";
    row["object_key"] = null;
    row["bytes"] = "\\x";
    return;
  }
  if (!copy.files.has(originalKey)) {
    report.refusals.push(`The copy names the file ${originalKey} and does not carry it.`);
    throw new Stop(report);
  }
  const bytes = await copy.bytes(originalKey);
  if (sha256(bytes) !== String(raw["sha256"] ?? "").toLowerCase()) {
    report.refusals.push(`The file ${originalKey} in the copy does not match its own checksum, so the copy is damaged.`);
    throw new Stop(report);
  }
  report.files.restored += 1;
  report.files.bytes += bytes.byteLength;
  const storageKey = row["storage_key"] as string;
  if (storage.writeTo === "object") {
    const bucket = storage.bucket!;
    const objectKey = `${bucket.prefix}${storageKey}`;
    if (!dryRun) await bucket.client.put(objectKey, bytes, String(raw["content_type"] ?? "application/octet-stream"));
    row["stored_in"] = "object";
    row["object_key"] = objectKey;
    row["bytes"] = null;
  } else {
    row["stored_in"] = "postgres";
    row["object_key"] = null;
    row["bytes"] = `\\x${bytes.toString("hex")}`;
  }
}

/** The company's own row: its name, address, settings and the rest, as the copy had them. */
async function restoreCompany(
  tx: Database, ctx: ServiceContext, manifest: Manifest, lookup: Map<string, string>,
): Promise<void> {
  const carried = CARRIED_COMPANY_COLUMNS.filter((c) => c !== "created_at" && c in manifest.company);
  if (carried.length === 0) return;
  const mapped = portability.remap(manifest.company, (id) => lookup.get(id)) as Record<string, unknown>;
  await tx.execute(sql`
    update organization o set ${sql.join(carried.map((c) => sql`${sql.identifier(c)} = s.${sql.identifier(c)}`), sql`, `)},
      updated_at = now()
    from jsonb_populate_record(null::organization, ${JSON.stringify(mapped)}::jsonb) s
    where o.id = ${ctx.actor.organizationId}
  `);
}

async function secretNames(tx: Database): Promise<string[]> {
  const rows = await tx.select({ ref: schema.integrationConnection.credentialRef, settings: schema.integrationConnection.settings })
    .from(schema.integrationConnection).where(isNull(schema.integrationConnection.deletedAt));
  const names = new Set<string>();
  for (const row of rows) {
    if (row.ref) names.add(row.ref);
    for (const [key, value] of Object.entries(row.settings ?? {})) {
      if (key.endsWith("Ref") && typeof value === "string") names.add(value);
    }
  }
  const [backup] = await tx.select({ ref: schema.backupDestination.secretKeyRef }).from(schema.backupDestination).limit(1);
  if (backup) names.add(backup.ref);
  return [...names].sort();
}

/**
 * Nothing leaves the restored company until somebody has looked at it: every
 * connected service needs checking, and every webhook is off. Said on the
 * report with how many, and undone from Settings, Integrations and Webhooks.
 */
async function holdSending(tx: Database): Promise<{ connections: number; webhooks: number }> {
  const connections = await tx.update(schema.integrationConnection).set({
    status: "needs_reauth",
    lastError: "Restored from a copy. Check this connection before it sends anything.",
    updatedAt: new Date(),
  }).where(eq(schema.integrationConnection.status, "connected")).returning({ id: schema.integrationConnection.id });
  const webhooks = await tx.update(schema.webhookEndpoint).set({ active: false, updatedAt: new Date() })
    .where(eq(schema.webhookEndpoint.active, true)).returning({ id: schema.webhookEndpoint.id });
  return { connections: connections.length, webhooks: webhooks.length };
}

/* ------------------------------------------------------------- the runs */

export interface RestoreRunView {
  id: string;
  source: string;
  sourceName: string;
  sourceSha256: string | null;
  sourceBytes: number | null;
  format: string | null;
  dryRun: boolean;
  outcome: string;
  report: RestoreReport;
  requestedByUserId: string | null;
  createdAt: Date;
}

const runView = (row: typeof schema.restoreRun.$inferSelect): RestoreRunView => ({
  id: row.id, source: row.source, sourceName: row.sourceName, sourceSha256: row.sourceSha256,
  sourceBytes: row.sourceBytes, format: row.format, dryRun: row.dryRun, outcome: row.outcome,
  report: row.report as unknown as RestoreReport, requestedByUserId: row.requestedByUserId, createdAt: row.createdAt,
});

/** Every attempt to load a copy into this company, newest first. */
export async function listRuns(ctx: ServiceContext, input: { limit?: number | undefined } = {}): Promise<RestoreRunView[]> {
  return guardedRead(ctx, "data:import", async (tx) => {
    const rows = await tx.select().from(schema.restoreRun)
      .orderBy(desc(schema.restoreRun.createdAt)).limit(Math.min(Math.max(input.limit ?? 20, 1), 100));
    return rows.map(runView);
  });
}

export async function getRun(ctx: ServiceContext, id: string): Promise<RestoreRunView> {
  return guardedRead(ctx, "data:import", async (tx) => {
    const [row] = await tx.select().from(schema.restoreRun).where(eq(schema.restoreRun.id, id)).limit(1);
    if (!row) throw new NotFoundError("Restore");
    return runView(row);
  });
}

/** Whether this company is empty enough to restore into, for the screen to say before anybody uploads anything. */
export async function readiness(ctx: ServiceContext): Promise<{ empty: boolean; held: string[] }> {
  return guardedRead(ctx, "data:import", async (tx) => {
    const held = await recordsHeld(tx, ctx, await catalogue(tx));
    return { empty: held.length === 0, held };
  });
}

export const handlers = {
  listRestores: async (ctx: ServiceContext, input: { limit?: number | undefined }) => ({ restores: await listRuns(ctx, input) }),
} as const;
